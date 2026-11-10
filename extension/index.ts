// pi-cron-jobs — pi extension (surface 3, in-pi UX).
// Reads the same files the wrapper writes: lists jobs + executions, notifies at
// session_start and live (every POLL_MS) about runs that failed or asked for a
// review, keeps the status-line badge and review inbox segment, resumes the
// conversation an execution produced, and gives the agent cron_review_done.
//
// ctx/pi are typed loosely (any) like other pi extensions to avoid depending on
// the globally-installed @earendil-works types at our project's tsc time.

import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import * as paths from "../src/core/paths";
import * as store from "../src/core/store";
import * as launchd from "../src/scheduler/launchd";
import type { Execution, Job } from "../src/core/types";
import { interruptKind } from "../src/core/outcome";
import { filterJobs, isCompleted, isScheduled, JOB_TABS } from "../src/core/jobs";
import { canUseTabs, tabbedSelect, type TabRow } from "./tabbed-select";

const STATUS_KEY = "pi-cron-jobs";
const REVIEW_STATUS_KEY = "pi-cron-jobs-review";
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

// A run that did not happen because of the machine, not the job: a DarkWake,
// sleeping mid-run, or no network. Not a failure, but worth surfacing (and
// retrying), since the job did not do its work.
function isInterruptedSkip(e: Execution | undefined): boolean {
	return interruptKind(e) !== null;
}

function lastExecutionByJob(execs: Execution[]): Map<string, Execution> {
	const m = new Map<string, Execution>();
	for (const e of execs) m.set(e.jobId, e); // ledger is append-order; last wins
	return m;
}

function jobName(jobId: string): string {
	return store.getJob(jobId)?.name ?? jobId;
}

function clip(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// The inbox segment: the item's own text when there is one, a count otherwise.
function reviewStatusText(open: Execution[]): string | undefined {
	if (!open.length) return undefined;
	if (open.length === 1) return `📥 ${clip(open[0]!.review ?? "", 40)}`;
	return `📥 ${open.length} to review`;
}

function renderStatus(ctx: any): void {
	if (!ctx?.hasUI) return;
	const jobs = store.readJobs();
	if (!jobs.length) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setStatus(REVIEW_STATUS_KEY, undefined);
		return;
	}
	const last = lastExecutionByJob(store.readExecutions());
	const ignored = store.readIgnoredExecutions();
	const active = jobs.filter(isScheduled).length;
	const failing = jobs.filter((j) => isFailed(last.get(j.id), ignored)).length;
	const warn = failing > 0 ? ` · ${failing} failing ⚠️` : "";
	ctx.ui.setStatus(STATUS_KEY, `cron: ${active}${warn}`);
	ctx.ui.setStatus(REVIEW_STATUS_KEY, reviewStatusText(store.openReviews()));
}

function latestTs(execs: Execution[]): string {
	return execs.reduce((acc, e) => {
		const t = e.endedAt ?? e.startedAt;
		return t > acc ? t : acc;
	}, "");
}

// Advance the shared "last seen" marker so the next session start does not
// repeat what an open window already announced.
function advanceLastSeen(ts: string): void {
	const state = store.readState();
	if (ts && (!state.lastSeenTs || ts > state.lastSeenTs)) store.writeState({ ...state, lastSeenTs: ts });
}

// Session start: what went wrong while you were away, and what is waiting for
// you. Quiet runs (notify = failure, all ok) say nothing.
function notifySinceLastSeen(ctx: any): void {
	if (!ctx?.hasUI) return;
	const execs = store.readExecutions();
	if (!execs.length) return;
	const state = store.readState();
	const since = state.lastSeenTs;

	if (since) {
		const ignored = store.readIgnoredExecutions();
		const fresh = execs.filter((e) => (e.endedAt ?? e.startedAt) > since);
		const jobNames = (list: Execution[]) => [...new Set(list.map((e) => e.jobId))].join(", ");
		const fails = fresh.filter((e) => isFailed(e, ignored));
		const unseen = fresh.filter((e) => !ignored.has(e.executionId));
		const asleep = unseen.filter((e) => interruptKind(e) === "asleep");
		const offline = unseen.filter((e) => interruptKind(e) === "offline");

		const parts: string[] = [];
		if (fails.length) parts.push(`${fails.length} failed (${jobNames(fails)})`);
		if (asleep.length) parts.push(`${asleep.length} skipped, Mac was asleep (${jobNames(asleep)})`);
		if (offline.length) parts.push(`${offline.length} skipped, no network (${jobNames(offline)})`);
		if (parts.length) {
			ctx.ui.notify(
				`⏰ ${fresh.length} scheduled run(s) since last visit — ${parts.join("; ")}. /jobs`,
				"warning",
			);
		}
	}

	// Re-announced every session until done, like a review file left open.
	const open = store.openReviews();
	if (open.length) {
		const items = open.map((e) => `${jobName(e.jobId)} — ${e.review}`).join("; ");
		ctx.ui.notify(`📥 ${open.length} to review: ${items}. /jobs`, "info");
	}

	// advance the marker (silently on first ever run)
	advanceLastSeen(latestTs(execs) || new Date().toISOString());
}

// While a window is open: announce runs that finished since `since`, according
// to their job's notify setting (failures always; review items when raised).
// Returns the new high-water mark for this window.
export function announceNewRuns(ctx: any, since: string): string {
	const execs = store.readExecutions();
	const fresh = execs.filter((e) => (e.endedAt ?? e.startedAt) > since);
	if (!fresh.length) return since;
	if (ctx?.hasUI) {
		const ignored = store.readIgnoredExecutions();
		const done = store.readReviewDone();
		for (const e of fresh) {
			const name = jobName(e.jobId);
			if (needsRetry(e, ignored)) {
				const reason = e.reason ? `: ${e.reason}` : "";
				ctx.ui.notify(`⏰ ${name} — ${e.status}${reason}. /jobs`, "warning");
			} else if (e.review && !done.has(e.executionId)) {
				ctx.ui.notify(`📥 ${name} — ${e.review}. /jobs`, "info");
			}
		}
	}
	const ts = latestTs(fresh);
	advanceLastSeen(ts);
	return ts > since ? ts : since;
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

// Latest run failed, timed out, or never happened because the Mac was asleep
// or offline -- and you have not dismissed it.
function needsRetry(e: Execution | undefined, ignored: Set<string>): boolean {
	if (!e || ignored.has(e.executionId)) return false;
	return isFailed(e, ignored) || isInterruptedSkip(e);
}

function jobLabel(job: Job, last: Execution | undefined, ignored: Set<string>): string {
	const status = last ? last.status : "never run";
	const flag = needsRetry(last, ignored) ? " ⚠" : "";
	const sched =
		job.schedule.kind === "cron" ? job.schedule.expr : `@ ${fmtLocal(job.schedule.at)}`;
	const done = isCompleted(job) ? " · done" : "";
	return `${job.name} [${sched}] — ${status}${flag}${done}`;
}

function execLabel(e: Execution, ignored?: Set<string>, reviewDone?: Set<string>): string {
	const reason = e.reason ? ` — ${e.reason}` : "";
	const warn = e.warning ? " ⚠" : "";
	const muted = ignored?.has(e.executionId) ? " · ignored" : "";
	const review = e.review ? ` · 📥 ${e.review}${reviewDone?.has(e.executionId) ? " (done)" : ""}` : "";
	return `${fmtLocal(e.startedAt)}  ${e.status}${warn}${reason}${muted}${review}`;
}

function reviewLabel(e: Execution): string {
	const act = e.action ? "  ▶" : "";
	return `${jobName(e.jobId)} · ${fmtLocal(e.endedAt ?? e.startedAt)} — ${e.review}${act}`;
}

type JobPick =
	| { kind: "job"; job: Job }
	| { kind: "retryAll"; jobs: Job[] }
	| { kind: "review"; exec: Execution };

function reviewRows(open: Execution[]): TabRow<JobPick>[] {
	return open.map((e) => ({ label: reviewLabel(e), value: { kind: "review", exec: e } }));
}

// Rows for one set of jobs: an optional "Retry all failed" row, then one per job.
function jobRows(jobs: Job[], last: Map<string, Execution>, ignored: Set<string>): TabRow<JobPick>[] {
	const toRetry = jobs.filter((j) => j.enabled && needsRetry(last.get(j.id), ignored));
	const rows: TabRow<JobPick>[] = toRetry.length
		? [
				{
					label: `⟳  Retry all failed (${toRetry.length}), one after the other`,
					value: { kind: "retryAll", jobs: toRetry },
				},
			]
		: [];
	for (const j of jobs) rows.push({ label: jobLabel(j, last.get(j.id), ignored), value: { kind: "job", job: j } });
	return rows;
}

async function openJobsMenu(ctx: any): Promise<void> {
	store.pruneCompletedJobs();
	const jobs = store.readJobs();
	if (!jobs.length) {
		ctx.ui.notify("No scheduled jobs. Create one with the pi-cron-jobs CLI.", "info");
		return;
	}
	const last = lastExecutionByJob(store.readExecutions());
	const ignored = store.readIgnoredExecutions();
	const open = store.openReviews();

	let pick: JobPick | undefined;
	if (canUseTabs(ctx)) {
		// To review / Scheduled / One-time / All. Opens on To review when something
		// is waiting, on Scheduled otherwise.
		const tabs = [
			{ title: "To review", count: open.length, rows: reviewRows(open) },
			...JOB_TABS.map((t) => {
				const list = filterJobs(jobs, t.id);
				return { title: t.title, count: list.length, rows: jobRows(list, last, ignored) };
			}),
		];
		pick = await tabbedSelect(ctx, "Jobs", tabs, open.length ? 0 : 1);
	} else {
		// No interactive TUI (RPC, tests): plain select, review items first.
		const rows = [...reviewRows(open), ...jobRows(jobs, last, ignored)];
		const labels = rows.map((r) => r.label);
		const choice = await ctx.ui.select("Scheduled jobs:", labels);
		pick = choice ? rows[labels.indexOf(choice)]?.value : undefined;
	}
	if (!pick) return;
	if (pick.kind === "retryAll") return retryAllFailed(ctx, pick.jobs);
	if (pick.kind === "review") {
		const job = store.getJob(pick.exec.jobId);
		if (job) await openExecutionActions(ctx, job, pick.exec);
		return;
	}
	await openExecutionsMenu(ctx, pick.job);
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
	const reviewDone = store.readReviewDone();
	const labels = page.map((e) => execLabel(e, ignored, reviewDone));
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
const ACTION_RUN = "▶ Run action in this session";
const ACTION_REVIEW_DONE = "✓ Mark review done";

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
	// Interrupted skips are dismissible too: the job did not run, and the notice
	// will keep mentioning it until it is acknowledged.
	const failed =
		exec.status === "failure" || exec.status === "timeout" || isInterruptedSkip(exec);
	const hasConversation = findSessionFile(exec.sessionId) !== null;
	const reviewOpen = !!exec.review && !store.readReviewDone().has(exec.executionId);
	const menu = [
		...(reviewOpen && exec.action ? [ACTION_RUN] : []),
		hasConversation ? ACTION_RESUME : NO_CONVERSATION,
		...(reviewOpen ? [ACTION_REVIEW_DONE] : []),
		ACTION_RETRY,
	];
	if (isIgnored) menu.push(ACTION_UNIGNORE);
	else if (failed) menu.push(ACTION_IGNORE);

	const suffix = isIgnored ? " · ignored" : "";
	const review = reviewOpen ? ` · 📥 ${exec.review}` : "";
	const title = `${job.name} · ${fmtLocal(exec.startedAt)} · ${exec.status}${suffix}${review}:`;
	const choice = await ctx.ui.select(title, menu);
	if (!choice) return;
	if (choice === NO_CONVERSATION) return openExecutionActions(ctx, job, exec, offset);
	if (choice === ACTION_RETRY) return retryJob(ctx, job);
	if (choice === ACTION_RUN) return runReviewAction(ctx, job, exec);
	if (choice === ACTION_REVIEW_DONE) {
		store.setReviewDone(exec.executionId, true);
		ctx.ui.notify(`Marked done: ${job.name} — ${exec.review}`, "info");
		renderStatus(ctx);
		return;
	}
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

// pid of the detached "Retry all" wrapper, so a second click does not start a
// duplicate batch while the first is still working through its list.
const retryBatchPidFile = () => path.join(paths.root, "retry-all.pid");

function runningRetryBatch(): number | null {
	try {
		const pid = Number(readFileSync(retryBatchPidFile(), "utf8").trim());
		if (!pid) return null;
		process.kill(pid, 0); // throws if the process is gone
		return pid;
	} catch {
		return null;
	}
}

// Re-run every job whose latest run needs it, in ONE detached wrapper that runs
// them one after the other (`pi-cron-jobs run a b c`): jobs that drive the
// browser must not overlap.
async function retryAllFailed(ctx: any, jobs: Job[]): Promise<void> {
	const bin = resolveRunnerBin();
	if (!bin) {
		const ids = jobs.map((j) => j.id).join(" ");
		ctx.ui.notify(`Wrapper binary not found — retry manually: pi-cron-jobs run ${ids}`, "warning");
		return;
	}
	const busy = runningRetryBatch();
	if (busy) {
		ctx.ui.notify(`A "Retry all" batch is still running (pid ${busy}) — check /jobs when it is done.`, "warning");
		return;
	}
	// A job with a run in flight (scheduled or single retry) would just be
	// skipped as overlapping; leave it out instead.
	const running = jobs.filter((j) => existsSync(path.join(paths.root, `${j.id}.lock`)));
	const batch = jobs.filter((j) => !running.includes(j) && existsSync(j.cwd));
	const missingCwd = jobs.filter((j) => !running.includes(j) && !existsSync(j.cwd));
	if (!batch.length) {
		ctx.ui.notify("Nothing to retry: every failed job is already running or has a missing cwd.", "info");
		return;
	}
	const notes = [
		running.length ? `Already running, left out: ${running.map((j) => j.name).join(", ")}.` : "",
		missingCwd.length ? `Missing cwd, left out: ${missingCwd.map((j) => j.name).join(", ")}.` : "",
	].filter(Boolean);
	const ok = await ctx.ui.confirm(
		`Retry ${batch.length} job(s) now?`,
		[
			`Run in the background, one after the other: ${batch.map((j) => j.name).join(" → ")}.`,
			...notes,
			"You stay in this session.",
		].join(" "),
	);
	if (!ok) return;
	try {
		const child = spawn(bin, ["run", ...batch.map((j) => j.id)], {
			cwd: paths.root,
			detached: true,
			stdio: "ignore",
			env: { ...process.env, PI_CRON_JOBS_DIR: paths.root },
		});
		child.on("error", (err: Error) =>
			ctx.ui.notify(`Retry all failed to start: ${err.message}`, "warning"),
		);
		if (child.pid) writeFileSync(retryBatchPidFile(), String(child.pid));
		child.unref();
		ctx.ui.notify(
			`Retrying ${batch.length} job(s) one after the other — check /jobs for the results.`,
			"info",
		);
	} catch (err: unknown) {
		ctx.ui.notify(`Retry all failed to start: ${String(err)}`, "warning");
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
	const reviewOpen = !!exec.review && !store.readReviewDone().has(exec.executionId);
	const hint = reviewOpen
		? " — when the review is done, ask the agent to mark it done (cron_review_done) or use /jobs"
		: "";
	await ctx.switchSession(file, {
		withSession: async (c: any) => c.ui.notify(`Resumed ${job.name}${hint}`, "info"),
	});
}

// Send the run's PI_JOB_ACTION prompt into this session, with the id the agent
// needs to close the item when the work is finished.
function runReviewAction(ctx: any, job: Job, exec: Execution): void {
	if (!piRef || !exec.action) return;
	const message = [
		exec.action,
		"",
		`(pi-cron-jobs review item ${exec.executionId} from "${job.name}": ${exec.review}. ` +
			`When this is finished -- applied, pushed, sent, or skipped -- call cron_review_done with id "${exec.executionId}".)`,
	].join("\n");
	piRef.sendUserMessage(message, ctx.isIdle?.() === false ? { deliverAs: "followUp" } : undefined);
}

let piRef: any;

function registerReviewDoneTool(pi: any): void {
	pi.registerTool?.({
		name: "cron_review_done",
		label: "Cron review done",
		description:
			"Mark a pi-cron-jobs review item (a scheduled run waiting for the user) as done, so it leaves the /jobs To review tab and the status bar.",
		promptSnippet: "Mark a pi-cron-jobs review item done once its work is finished",
		promptGuidelines: [
			"Call cron_review_done only once the work a pi-cron-jobs review item asked for is finished (applied, pushed, sent, or skipped by the user): with the id a message gave you, or with no id inside the scheduled run's own conversation.",
		],
		parameters: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "Execution id of the review item. Omit inside the scheduled run's own conversation.",
				},
			},
			additionalProperties: false,
		},
		async execute(_toolCallId: string, params: { id?: string }, _signal: unknown, _onUpdate: unknown, ctx: any) {
			const open = store.openReviews();
			const sessionId = ctx?.sessionManager?.getSessionId?.();
			const item = params?.id
				? open.find((e) => e.executionId === params.id)
				: open.find((e) => e.sessionId === sessionId);
			if (!item) {
				throw new Error(
					params?.id
						? `No open review item with id "${params.id}".`
						: "This conversation is not an open pi-cron-jobs review item; pass its id.",
				);
			}
			store.setReviewDone(item.executionId, true);
			renderStatus(ctx);
			const text = `Marked done: ${jobName(item.jobId)} — ${item.review}`;
			return { content: [{ type: "text", text }], details: { executionId: item.executionId } };
		},
	});
}

export default function (pi: any) {
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let current: any;
	let seenTs = ""; // newest run this window has announced
	piRef = pi;
	registerReviewDoneTool(pi);

	pi.on("session_start", async (_event: any, ctx: any) => {
		if (!ctx?.hasUI) return;
		current = ctx;
		store.pruneCompletedJobs();
		notifySinceLastSeen(ctx);
		seenTs = store.readState().lastSeenTs ?? "";
		renderStatus(ctx);
		pollTimer ??= setInterval(() => {
			try {
				seenTs = announceNewRuns(current, seenTs);
				renderStatus(current);
			} catch {
				// a stale ctx after a session switch; the next session_start resets it
			}
		}, POLL_MS);
		pollTimer.unref?.();
	});

	pi.on("session_shutdown", async (_event: any, ctx: any) => {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
		if (ctx?.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setStatus(REVIEW_STATUS_KEY, undefined);
		}
		current = undefined;
	});

	pi.registerCommand("jobs", {
		description: "Review inbox and scheduled pi jobs: view runs, run a review action, resume a conversation or retry",
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
