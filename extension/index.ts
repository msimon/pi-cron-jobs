// pi-cron-jobs — pi extension (surface 3, in-pi UX).
// Reads the same files the wrapper writes: lists jobs + executions, notifies at
// session_start about runs that happened while you were away, keeps an always-on
// status-line widget, and resumes the conversation an execution produced.
//
// ctx/pi are typed loosely (any) like other pi extensions to avoid depending on
// the globally-installed @earendil-works types at our project's tsc time.

import { readdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import * as paths from "../src/core/paths";
import * as store from "../src/core/store";
import * as launchd from "../src/scheduler/launchd";
import type { Execution, Job } from "../src/core/types";
import { DARK_WAKE_REASON_PREFIX } from "../src/core/darkwake";

const STATUS_KEY = "pi-cron-jobs";
const POLL_MS = 5000;

function fmtLocal(iso: string): string {
	const d = new Date(iso);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// An ignored execution is one you acknowledged by hand: it stays in the ledger
// and keeps its real status, but stops counting as a failure for the badge and
// the session-start notice.
function isFailed(e: Execution | undefined, ignored?: Set<string>): boolean {
	if (!e) return false;
	if (e.status !== "failure" && e.status !== "timeout") return false;
	return !ignored?.has(e.executionId);
}

// A run the wrapper declined to start because macOS was in a DarkWake
// maintenance window. Not a failure -- the machine was asleep -- but worth
// surfacing, since the job did not run at all.
function isDarkWakeSkip(e: Execution | undefined): boolean {
	return (
		!!e && e.status === "skipped" && (e.reason ?? "").startsWith(DARK_WAKE_REASON_PREFIX)
	);
}

function lastExecutionByJob(execs: Execution[]): Map<string, Execution> {
	const m = new Map<string, Execution>();
	for (const e of execs) m.set(e.jobId, e); // ledger is append-order; last wins
	return m;
}

function renderStatus(ctx: any): void {
	if (!ctx?.hasUI) return;
	const jobs = store.readJobs();
	if (!jobs.length) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const last = lastExecutionByJob(store.readExecutions());
	const ignored = store.readIgnoredExecutions();
	const active = jobs.filter((j) => j.enabled).length;
	const failing = jobs.filter((j) => isFailed(last.get(j.id), ignored)).length;
	const warn = failing > 0 ? ` · ${failing} failing ⚠️` : "";
	ctx.ui.setStatus(STATUS_KEY, `jobs: ${active}${warn}`);
}

// One-line "what happened while you were away" notice at session_start.
function notifySinceLastSeen(ctx: any): void {
	if (!ctx?.hasUI) return;
	const execs = store.readExecutions();
	if (!execs.length) return;
	const state = store.readState();
	const since = state.lastSeenTs;
	const latestTs = execs.reduce(
		(acc, e) => {
			const t = e.endedAt ?? e.startedAt;
			return t > acc ? t : acc;
		},
		"",
	);

	if (since) {
		const ignored = store.readIgnoredExecutions();
		const fresh = execs.filter((e) => (e.endedAt ?? e.startedAt) > since);
		if (fresh.length) {
			const jobNames = (list: Execution[]) => [...new Set(list.map((e) => e.jobId))].join(", ");
			const fails = fresh.filter((e) => isFailed(e, ignored));
			const darkSkips = fresh.filter(
				(e) => isDarkWakeSkip(e) && !ignored.has(e.executionId),
			);

			const parts: string[] = [];
			if (fails.length) parts.push(`${fails.length} failed (${jobNames(fails)})`);
			if (darkSkips.length)
				parts.push(`${darkSkips.length} skipped, Mac was asleep (${jobNames(darkSkips)})`);

			if (parts.length) {
				ctx.ui.notify(
					`⏰ ${fresh.length} scheduled run(s) since last visit — ${parts.join("; ")}. /jobs`,
					"warning",
				);
			} else {
				ctx.ui.notify(`⏰ ${fresh.length} scheduled run(s) since last visit — all ok. /jobs`, "info");
			}
		}
	}
	// advance the marker (silently on first ever run)
	store.writeState({ ...state, lastSeenTs: latestTs || new Date().toISOString() });
}

// Resolve the session file for a sessionId from the cron session store.
function findSessionFile(sessionId: string): string | null {
	if (!existsSync(paths.sessionsDir)) return null;
	const suffix = `_${sessionId}.jsonl`;
	try {
		const hit = readdirSync(paths.sessionsDir).find((file) => file.endsWith(suffix));
		return hit ? path.join(paths.sessionsDir, hit) : null;
	} catch {
		return null;
	}
}

function jobLabel(job: Job, last: Execution | undefined, ignored?: Set<string>): string {
	const status = last ? last.status : "never run";
	const flag = isFailed(last, ignored) ? " ⚠" : "";
	const sched =
		job.schedule.kind === "cron" ? job.schedule.expr : `@ ${fmtLocal(job.schedule.at)}`;
	return `${job.name} [${sched}] — ${status}${flag}`;
}

function execLabel(e: Execution, ignored?: Set<string>): string {
	const reason = e.reason ? ` — ${e.reason}` : "";
	const warn = e.warning ? " ⚠" : "";
	const muted = ignored?.has(e.executionId) ? " · ignored" : "";
	return `${fmtLocal(e.startedAt)}  ${e.status}${warn}${reason}${muted}`;
}

async function openJobsMenu(ctx: any): Promise<void> {
	const jobs = store.readJobs();
	if (!jobs.length) {
		ctx.ui.notify("No scheduled jobs. Create one with the pi-cron-jobs CLI.", "info");
		return;
	}
	const last = lastExecutionByJob(store.readExecutions());
	const ignored = store.readIgnoredExecutions();
	const labels = jobs.map((j) => jobLabel(j, last.get(j.id), ignored));
	const choice = await ctx.ui.select("Scheduled jobs:", labels);
	if (!choice) return;
	const job = jobs[labels.indexOf(choice)];
	if (!job) return;
	await openExecutionsMenu(ctx, job);
}

const EXEC_PAGE_SIZE = 15;

async function openExecutionsMenu(ctx: any, job: Job, offset = 0): Promise<void> {
	const all = store.executionsForJob(job.id).slice().reverse(); // newest first
	if (!all.length) {
		ctx.ui.notify(`"${job.name}" has not run yet.`, "info");
		return;
	}
	const pageCount = Math.ceil(all.length / EXEC_PAGE_SIZE);
	const start = Math.min(Math.max(0, offset), (pageCount - 1) * EXEC_PAGE_SIZE);
	const page = all.slice(start, start + EXEC_PAGE_SIZE);
	const ignored = store.readIgnoredExecutions();
	const labels = page.map((e) => execLabel(e, ignored));
	const PREV = "↑ previous page (newer)";
	const NEXT = "↓ next page (older)";
	const menu = [
		...(start > 0 ? [PREV] : []),
		...labels,
		...(start + EXEC_PAGE_SIZE < all.length ? [NEXT] : []),
	];
	const pageNum = Math.floor(start / EXEC_PAGE_SIZE) + 1;
	const title = `Executions of "${job.name}" — page ${pageNum}/${pageCount}:`;
	const choice = await ctx.ui.select(title, menu);
	if (!choice) return;
	if (choice === PREV) return openExecutionsMenu(ctx, job, start - EXEC_PAGE_SIZE);
	if (choice === NEXT) return openExecutionsMenu(ctx, job, start + EXEC_PAGE_SIZE);
	const exec = page[labels.indexOf(choice)];
	if (!exec) return;
	await openExecutionActions(ctx, job, exec, start);
}

const ACTION_RESUME = "↩ Resume conversation";
const ACTION_RETRY = "⟳  Retry now";
// Shown instead of ACTION_RESUME when the run saved no conversation (skipped
// runs: dark wake, disabled, overlap, maxRuns). Inert: picking it re-shows the menu.
const NO_CONVERSATION = "∅ No conversation to resume";
const ACTION_IGNORE = "⊘ Ignore this failure";
const ACTION_UNIGNORE = "⊙ Stop ignoring this failure";

// Actions per execution: open its conversation, fire the job again now, or --
// for a failed run -- acknowledge it so it stops counting against the job.
async function openExecutionActions(
	ctx: any,
	job: Job,
	exec: Execution,
	offset = 0,
): Promise<void> {
	const ignored = store.readIgnoredExecutions();
	const isIgnored = ignored.has(exec.executionId);
	// Dark-wake skips are dismissible too: the job did not run, and the notice
	// will keep mentioning it until it is acknowledged.
	const failed =
		exec.status === "failure" || exec.status === "timeout" || isDarkWakeSkip(exec);
	const hasConversation = findSessionFile(exec.sessionId) !== null;
	const menu = [hasConversation ? ACTION_RESUME : NO_CONVERSATION, ACTION_RETRY];
	if (isIgnored) menu.push(ACTION_UNIGNORE);
	else if (failed) menu.push(ACTION_IGNORE);

	const suffix = isIgnored ? " · ignored" : "";
	const title = `${job.name} · ${fmtLocal(exec.startedAt)} · ${exec.status}${suffix}:`;
	const choice = await ctx.ui.select(title, menu);
	if (!choice) return;
	if (choice === NO_CONVERSATION) return openExecutionActions(ctx, job, exec, offset);
	if (choice === ACTION_RETRY) return retryJob(ctx, job);
	if (choice === ACTION_IGNORE || choice === ACTION_UNIGNORE) {
		store.setExecutionIgnored(exec.executionId, choice === ACTION_IGNORE);
		ctx.ui.notify(
			choice === ACTION_IGNORE
				? `Ignored ${job.name} · ${fmtLocal(exec.startedAt)} — it no longer counts as failing.`
				: `${job.name} · ${fmtLocal(exec.startedAt)} counts as failing again.`,
			"info",
		);
		renderStatus(ctx);
		// Back to the list so several stale failures can be cleared in one pass.
		return openExecutionsMenu(ctx, job, offset);
	}
	await resumeExecution(ctx, job, exec);
}

// Absolute path of the wrapper binary that can run a job headlessly, or null.
function resolveRunnerBin(): string | null {
	const explicit = process.env.PI_CRON_JOBS_BIN;
	if (explicit && existsSync(explicit)) return explicit;
	const installed = path.join(paths.root, "bin", "pi-cron-jobs");
	if (existsSync(installed)) return installed;
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		const candidate = path.join(dir, "pi-cron-jobs");
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

// Re-run the job in a detached wrapper process; this pi session stays put.
async function retryJob(ctx: any, job: Job): Promise<void> {
	const bin = resolveRunnerBin();
	if (!bin) {
		ctx.ui.notify(`Wrapper binary not found — retry manually: pi-cron-jobs run ${job.id}`, "warning");
		return;
	}
	if (!existsSync(job.cwd)) {
		ctx.ui.notify(`Cannot retry "${job.name}": cwd ${job.cwd} does not exist.`, "warning");
		return;
	}
	const note = job.enabled ? "" : " (job is disabled — the run will be skipped)";
	const ok = await ctx.ui.confirm(
		"Retry job now?",
		`Run "${job.name}" again in the background${note}. You stay in this session.`,
	);
	if (!ok) return;
	try {
		const child = spawn(bin, ["run", job.id], {
			cwd: job.cwd,
			detached: true,
			stdio: "ignore",
			env: { ...process.env, PI_CRON_JOBS_DIR: paths.root },
		});
		child.on("error", (err: Error) =>
			ctx.ui.notify(`Retry of "${job.name}" failed to start: ${err.message}`, "warning"),
		);
		child.unref();
		ctx.ui.notify(`Retrying "${job.name}" in the background — check /jobs for the result.`, "info");
	} catch (err: unknown) {
		ctx.ui.notify(`Retry of "${job.name}" failed to start: ${String(err)}`, "warning");
	}
}

async function resumeExecution(ctx: any, job: Job, exec: Execution): Promise<void> {
	const file = findSessionFile(exec.sessionId);
	if (!file) {
		ctx.ui.notify("No conversation was saved for this run.", "info");
		return;
	}
	const ok = await ctx.ui.confirm(
		"Resume conversation?",
		`Switch this pi session to "${job.name}" (${exec.executionId})?`,
	);
	if (!ok) return;
	await ctx.switchSession(file, {
		withSession: async (c: any) => c.ui.notify(`Resumed ${job.name}`, "info"),
	});
}

export default function (pi: any) {
	let pollTimer: ReturnType<typeof setInterval> | undefined;

	pi.on("session_start", async (_event: any, ctx: any) => {
		if (!ctx?.hasUI) return;
		notifySinceLastSeen(ctx);
		renderStatus(ctx);
		pollTimer ??= setInterval(() => renderStatus(ctx), POLL_MS);
		pollTimer.unref?.();
	});

	pi.on("session_shutdown", async (_event: any, ctx: any) => {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
		if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("jobs", {
		description: "List scheduled pi jobs, view runs, resume a conversation or retry",
		handler: async (args: string, ctx: any) => {
			const sub = (args || "").trim();
			if (sub === "sync") {
				const { installed, removed } = launchd.sync(store.readJobs());
				ctx.ui.notify(`synced: ${installed.length} installed, ${removed.length} removed`, "info");
				renderStatus(ctx);
				return;
			}
			await openJobsMenu(ctx);
			renderStatus(ctx);
		},
	});
}
