// The execution core: fire one headless `pi --print` for a job, capture output,
// enforce a timeout, derive status from the marker (fallback: exit code), and
// append a record to the ledger. Used by the wrapper CLI (`run <jobId>`).

import { spawn } from "node:child_process";
import { mkdirSync, createWriteStream } from "node:fs";
import path from "node:path";
import * as store from "./store";
import * as paths from "./paths";
import { newExecutionId, sessionIdFor } from "./ids";
import { markerInstruction, parseMarker } from "./marker";
import type { Execution, ExecutionStatus, Job } from "./types";
import { DARK_WAKE_REASON_PREFIX, detectWakeState } from "./darkwake";

export interface RunOptions {
	piBin?: string; // path to the pi executable (default: env PI_BIN or "pi")
	now?: Date;
}

interface SpawnResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	stdout: string;
}

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
		markerInstruction(),
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
): Promise<SpawnResult> {
	return new Promise((resolve) => {
		const log = createWriteStream(logPath, { flags: "a" });
		const startedAt = Date.now();
		const stamp = () => `+${Math.round((Date.now() - startedAt) / 1000)}s`;
		const idleSecs = () => Math.round((Date.now() - lastOutputAt) / 1000);

		log.write(`# pi-cron-jobs execution\n# ${new Date().toISOString()}\n`);
		log.write(`# cwd: ${cwd}\n# cmd: ${piBin} ${args.map(shellQuote).join(" ")}\n\n`);

		let stdout = "";
		let timedOut = false;
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let lastOutputAt = Date.now();

		const child = spawn(piBin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

		const heartbeat = setInterval(() => {
			log.write(
				`# ${stamp()} alive pid=${child.pid ?? "?"} stdout=${stdoutBytes}B ` +
					`stderr=${stderrBytes}B idle=${idleSecs()}s\n`,
			);
		}, HEARTBEAT_MS);
		heartbeat.unref?.();

		const timer = setTimeout(() => {
			timedOut = true;
			log.write(
				`\n# ${stamp()} TIMEOUT after ${timeoutMs}ms — sending SIGTERM ` +
					`(stdout=${stdoutBytes}B stderr=${stderrBytes}B, last output ${idleSecs()}s ago)\n`,
			);
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 5000).unref();
		}, timeoutMs);

		const stopTimers = () => {
			clearTimeout(timer);
			clearInterval(heartbeat);
		};

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			stdoutBytes += chunk.length;
			lastOutputAt = Date.now();
			log.write(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.length;
			lastOutputAt = Date.now();
			log.write(chunk);
		});

		child.on("error", (err) => {
			stopTimers();
			log.write(`\n# ${stamp()} spawn error: ${String(err)}\n`);
			log.end();
			resolve({ exitCode: 127, signal: null, timedOut, stdout });
		});

		child.on("close", (code, signal) => {
			stopTimers();
			log.write(
				`\n# ${stamp()} exit code: ${code} signal: ${signal ?? "none"} ` +
					`stdout=${stdoutBytes}B stderr=${stderrBytes}B\n`,
			);
			log.end();
			resolve({ exitCode: code, signal, timedOut, stdout });
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
	const wake = detectWakeState();
	if (wake.darkWake) {
		return finalize(job, executionId, sessionId, logPath, now, {
			status: "skipped",
			reason: `${DARK_WAKE_REASON_PREFIX} — ${wake.detail}`,
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
		const result = await spawnPi(piBin, args, job.cwd, logPath, job.timeoutMs);
		const marker = parseMarker(result.stdout);

		let status: ExecutionStatus;
		let reason: string | null = null;
		let warning = false;

		if (result.timedOut) {
			status = "timeout";
			reason = `exceeded timeout of ${job.timeoutMs}ms`;
		} else if (marker) {
			status = marker.status === "success" ? "success" : "failure";
			reason = marker.reason;
			if (marker.status === "success" && result.exitCode !== 0) warning = true;
		} else if (result.exitCode !== 0) {
			status = "failure";
			reason = `exited ${result.exitCode} with no status marker`;
		} else {
			// clean exit but agent never emitted a marker
			status = "success";
			warning = true;
			reason = "no status marker emitted";
		}

		return finalize(job, executionId, sessionId, logPath, now, {
			status,
			reason,
			exitCode: result.exitCode,
			warning,
		});
	} finally {
		release();
	}
}
