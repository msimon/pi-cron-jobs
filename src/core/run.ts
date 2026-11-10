// The execution core: fire one headless `pi --print` for a job, capture output,
// enforce a timeout, derive status from the marker (fallback: exit code), and
// append a record to the ledger. Used by the wrapper CLI (`run <jobId>`).

import { spawn } from "node:child_process";
import { mkdirSync, createWriteStream } from "node:fs";
import path from "node:path";
import * as store from "./store";
import * as paths from "./paths";
import { newExecutionId, sessionIdFor } from "./ids";
import { closingInstruction, parseMarker, parseReview } from "./marker";
import { notifyPolicy } from "./jobs";
import type { Execution, ExecutionStatus, Job } from "./types";
import { DARK_WAKE_REASON_PREFIX, detectWakeState, type WakeState } from "./darkwake";
import { waitForNetwork, type NetState } from "./network";
import { OFFLINE_REASON_PREFIX, SLEPT_REASON_PREFIX, classifyStderr } from "./outcome";
import { AwakeClock, TICK_MS, fmtDuration } from "./sleep";

export interface RunOptions {
	piBin?: string; // path to the pi executable (default: env PI_BIN or "pi")
	now?: Date;
	// Injectable for tests; default to the real macOS / network probes.
	wakeCheck?: () => WakeState;
	networkCheck?: () => Promise<NetState>;
}

interface SpawnResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	stdout: string;
	stderr: string; // tail only, see STDERR_KEEP
	sleptMs: number; // time the Mac spent asleep during the run
}

// Enough to classify the failure (network/auth errors print early and short).
const STDERR_KEEP = 64 * 1024;

function fmtLocal(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function buildPiArgs(job: Job, sessionId: string, now = new Date()): string[] {
	const args = [
		"--print",
		"--session-dir",
		paths.sessionsDir,
		"--session-id",
		sessionId,
		"--name",
		`${job.name} · ${fmtLocal(now)}`,
		"--append-system-prompt",
		closingInstruction(notifyPolicy(job)),
	];
	if (job.model) args.push("--model", job.model);
	if (job.isolate) args.push("--no-extensions");
	if (job.tools && job.tools.length) args.push("--tools", job.tools.join(","));
	if (job.excludeTools && job.excludeTools.length)
		args.push("--exclude-tools", job.excludeTools.join(","));
	if (job.flags && job.flags.length) args.push(...job.flags);
	args.push(job.prompt);
	return args;
}

// `pi --print` only flushes stdout when the turn completes, so a run that wedges
// mid-turn is killed having written nothing but the header -- 33 of 34 timeouts
// in the ledger are blank. These heartbeat lines are cheap and make the
// difference between "never started", "started and went quiet", and "still
// talking when we killed it" readable after the fact.
const HEARTBEAT_MS = 60_000;

function spawnPi(
	piBin: string,
	args: string[],
	cwd: string,
	logPath: string,
	timeoutMs: number,
	notes: Array<[string, string]>,
): Promise<SpawnResult> {
	return new Promise((resolve) => {
		const log = createWriteStream(logPath, { flags: "a" });
		const startedAt = Date.now();
		const stamp = () => `+${Math.round((Date.now() - startedAt) / 1000)}s`;
		const idleSecs = () => Math.round((Date.now() - lastOutputAt) / 1000);

		log.write(`# pi-cron-jobs execution\n# ${new Date().toISOString()}\n`);
		const noteLines = notes.map(([k, v]) => `# ${k}: ${v}\n`).join("");
		log.write(`# cwd: ${cwd}\n${noteLines}# cmd: ${piBin} ${args.map(shellQuote).join(" ")}\n\n`);

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let lastOutputAt = Date.now();

		const child = spawn(piBin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

		// One short ticker drives the heartbeat, sleep detection and the timeout.
		// The timeout counts awake time only: a run the Mac slept through is not
		// killed the instant it wakes up (see sleep.ts).
		const clock = new AwakeClock(startedAt);
		let lastHeartbeat = startedAt;
		const ticker = setInterval(() => {
			const now = Date.now();
			const nap = clock.tick(now);
			if (nap > 0) {
				log.write(
					`# ${stamp()} woke up after ~${fmtDuration(nap)} asleep ` +
						`(awake ${fmtDuration(clock.awakeMs(now))} of ${fmtDuration(timeoutMs)})\n`,
				);
			}
			if (now - lastHeartbeat >= HEARTBEAT_MS) {
				lastHeartbeat = now;
				log.write(
					`# ${stamp()} alive pid=${child.pid ?? "?"} stdout=${stdoutBytes}B ` +
						`stderr=${stderrBytes}B idle=${idleSecs()}s\n`,
				);
			}
			if (!timedOut && clock.awakeMs(now) >= timeoutMs) {
				timedOut = true;
				log.write(
					`\n# ${stamp()} TIMEOUT after ${timeoutMs}ms awake — sending SIGTERM ` +
						`(stdout=${stdoutBytes}B stderr=${stderrBytes}B, last output ${idleSecs()}s ago)\n`,
				);
				child.kill("SIGTERM");
				setTimeout(() => child.kill("SIGKILL"), 5000).unref();
			}
		}, Math.min(TICK_MS, timeoutMs));
		ticker.unref?.();

		const stopTimers = () => clearInterval(ticker);

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			stdoutBytes += chunk.length;
			lastOutputAt = Date.now();
			log.write(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
			if (stderr.length > STDERR_KEEP) stderr = stderr.slice(-STDERR_KEEP);
			stderrBytes += chunk.length;
			lastOutputAt = Date.now();
			log.write(chunk);
		});

		child.on("error", (err) => {
			stopTimers();
			log.write(`\n# ${stamp()} spawn error: ${String(err)}\n`);
			log.end();
			resolve({ exitCode: 127, signal: null, timedOut, stdout, stderr, sleptMs: clock.slept });
		});

		child.on("close", (code, signal) => {
			stopTimers();
			log.write(
				`\n# ${stamp()} exit code: ${code} signal: ${signal ?? "none"} ` +
					`stdout=${stdoutBytes}B stderr=${stderrBytes}B\n`,
			);
			log.end();
			resolve({ exitCode: code, signal, timedOut, stdout, stderr, sleptMs: clock.slept });
		});
	});
}

function shellQuote(s: string): string {
	return /[^\w@%+=:,./-]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s;
}

function finalize(
	job: Job,
	executionId: string,
	sessionId: string,
	logPath: string,
	startedAt: Date,
	fields: {
		status: ExecutionStatus;
		reason?: string | null;
		exitCode?: number | null;
		warning?: boolean;
		review?: string | null;
		action?: string | null;
	},
): Execution {
	const exec: Execution = {
		jobId: job.id,
		executionId,
		sessionId,
		startedAt: startedAt.toISOString(),
		endedAt: new Date().toISOString(),
		exitCode: fields.exitCode ?? null,
		status: fields.status,
		reason: fields.reason ?? null,
		warning: fields.warning ?? false,
		logPath,
		...(fields.review ? { review: fields.review, action: fields.action ?? null } : {}),
	};
	store.appendExecution(exec);
	return exec;
}

export async function runJob(
	jobId: string,
	opts: RunOptions = {},
): Promise<Execution> {
	const job = store.getJob(jobId);
	if (!job) throw new Error(`No such job: ${jobId}`);

	const now = opts.now ?? new Date();
	const executionId = newExecutionId(now);
	const sessionId = sessionIdFor(job, executionId);
	const logPath = paths.logFile(job.id, executionId);

	if (!job.enabled) {
		return finalize(job, executionId, sessionId, logPath, now, {
			status: "skipped",
			reason: "job disabled",
		});
	}
	if (job.maxRuns != null && store.countExecutions(job.id) >= job.maxRuns) {
		return finalize(job, executionId, sessionId, logPath, now, {
			status: "skipped",
			reason: `maxRuns (${job.maxRuns}) reached`,
		});
	}

	// A job launched inside a DarkWake maintenance window cannot finish: macOS
	// returns to sleep ~45s later and the wall-clock timeout kills it. Record it
	// as skipped rather than burning the slot and reporting a false failure.
	const wake = (opts.wakeCheck ?? detectWakeState)();
	if (wake.darkWake) {
		return finalize(job, executionId, sessionId, logPath, now, {
			status: "skipped",
			reason: `${DARK_WAKE_REASON_PREFIX} — ${wake.detail}`,
		});
	}

	// Right after a wake the network is often not back yet; pi would die on its
	// first request. Wait for it, and skip (not fail) if it never comes.
	const netState = await (opts.networkCheck ?? (() => waitForNetwork()))();
	if (!netState.online) {
		return finalize(job, executionId, sessionId, logPath, now, {
			status: "skipped",
			reason: `${OFFLINE_REASON_PREFIX} — ${netState.detail}`,
		});
	}

	// overlap policy = drop
	const release = store.acquireLock(job.id);
	if (!release) {
		return finalize(job, executionId, sessionId, logPath, now, {
			status: "skipped",
			reason: "overlapping execution still running",
		});
	}

	try {
		mkdirSync(path.dirname(logPath), { recursive: true });
		const piBin = opts.piBin ?? process.env.PI_BIN ?? "pi";
		const args = buildPiArgs(job, sessionId, now);
		const result = await spawnPi(piBin, args, job.cwd, logPath, job.timeoutMs, [
			["wake", wake.detail],
			["network", netState.detail],
		]);
		const outcome = deriveOutcome(result, job.timeoutMs);
		return finalize(job, executionId, sessionId, logPath, now, {
			...outcome,
			...deriveReview(job, outcome, result.stdout),
			exitCode: result.exitCode,
		});
	} finally {
		release();
	}
}

export interface Outcome {
	status: ExecutionStatus;
	reason: string | null;
	warning: boolean;
}

// Whether a finished run goes to the review inbox, per the job's notify setting.
// Failures are not review items: they already flag the job as failing.
export function deriveReview(
	job: Job,
	outcome: Outcome,
	stdout: string,
): { review: string | null; action: string | null } {
	const policy = notifyPolicy(job);
	if (policy === "failure" || outcome.status !== "success") return { review: null, action: null };
	const parsed = parseReview(stdout);
	if (parsed.review) return parsed;
	if (policy === "always") return { review: "ran — success", action: null };
	return { review: null, action: null };
}

// Status of a finished pi process. Pure, so the precedence is testable:
// marker > broken login > slept mid-run > lost network > plain failure.
export function deriveOutcome(
	result: Pick<SpawnResult, "exitCode" | "timedOut" | "stdout" | "stderr" | "sleptMs">,
	timeoutMs: number,
): Outcome {
	const marker = parseMarker(result.stdout);
	const slept = result.sleptMs > 0 ? `${SLEPT_REASON_PREFIX} — ~${fmtDuration(result.sleptMs)} asleep` : null;

	if (result.timedOut) {
		// A run that slept and then sat silent for the whole awake budget almost
		// always lost its connection while asleep.
		if (slept) return { status: "skipped", reason: `${slept}, then timed out`, warning: false };
		return { status: "timeout", reason: `exceeded timeout of ${timeoutMs}ms`, warning: false };
	}
	if (marker) {
		return {
			status: marker.status === "success" ? "success" : "failure",
			reason: marker.reason,
			warning: marker.status === "success" && result.exitCode !== 0,
		};
	}
	if (result.exitCode === 0) {
		// clean exit but agent never emitted a marker
		return { status: "success", reason: "no status marker emitted", warning: true };
	}

	// No marker: pi died before the agent finished. A broken login is a real
	// failure; losing the machine or the network is not the job's fault.
	const cls = classifyStderr(result.stderr);
	if (cls?.kind === "auth") return { status: "failure", reason: cls.detail, warning: false };
	const exited = `exited ${result.exitCode}`;
	if (slept) {
		const why = cls ? `; ${cls.detail}` : "";
		return { status: "skipped", reason: `${slept}${why} (${exited})`, warning: false };
	}
	if (cls?.kind === "offline") {
		return { status: "skipped", reason: `${OFFLINE_REASON_PREFIX} — ${cls.detail} (${exited})`, warning: false };
	}
	return { status: "failure", reason: `${exited} with no status marker`, warning: false };
}
