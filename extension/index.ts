// pi-cron-jobs — pi extension (surface 3, in-pi UX).
// Reads the same files the wrapper writes: lists jobs + executions, notifies at
// session_start about runs that happened while you were away, keeps an always-on
// status-line widget, and resumes the conversation an execution produced.
//
// ctx/pi are typed loosely (any) like other pi extensions to avoid depending on
// the globally-installed @earendil-works types at our project's tsc time.

import { readdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as store from "../src/core/store";
import * as launchd from "../src/scheduler/launchd";
import type { Execution, Job } from "../src/core/types";

const STATUS_KEY = "pi-cron-jobs";
const POLL_MS = 5000;

function fmtLocal(iso: string): string {
	const d = new Date(iso);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function isFailed(e: Execution | undefined): boolean {
	return !!e && (e.status === "failure" || e.status === "timeout");
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
	const active = jobs.filter((j) => j.enabled).length;
	const failing = jobs.filter((j) => isFailed(last.get(j.id))).length;
	const warn = failing > 0 ? ` · ${failing} failing ⚠` : "";
	ctx.ui.setStatus(STATUS_KEY, `⏰ jobs: ${active}${warn}`);
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
		const fresh = execs.filter((e) => (e.endedAt ?? e.startedAt) > since);
		if (fresh.length) {
			const fails = fresh.filter(isFailed);
			if (fails.length) {
				const names = [...new Set(fails.map((e) => e.jobId))].join(", ");
				ctx.ui.notify(
					`⏰ ${fresh.length} scheduled run(s) since last visit — ${fails.length} failed (${names}). /jobs`,
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

// Resolve the session file for a sessionId by scanning pi's sessions dir.
function findSessionFile(sessionId: string): string | null {
	const root = path.join(os.homedir(), ".pi", "agent", "sessions");
	if (!existsSync(root)) return null;
	const suffix = `_${sessionId}.jsonl`;
	try {
		for (const slug of readdirSync(root)) {
			const dir = path.join(root, slug);
			let entries: string[];
			try {
				entries = readdirSync(dir);
			} catch {
				continue;
			}
			const hit = entries.find((f) => f.endsWith(suffix));
			if (hit) return path.join(dir, hit);
		}
	} catch {
		// ignore
	}
	return null;
}

function jobLabel(job: Job, last: Execution | undefined): string {
	const status = last ? last.status : "never run";
	const flag = isFailed(last) ? " ⚠" : "";
	const sched =
		job.schedule.kind === "cron" ? job.schedule.expr : `@ ${fmtLocal(job.schedule.at)}`;
	return `${job.name} [${sched}] — ${status}${flag}`;
}

function execLabel(e: Execution): string {
	const reason = e.reason ? ` — ${e.reason}` : "";
	const warn = e.warning ? " ⚠" : "";
	return `${fmtLocal(e.startedAt)}  ${e.status}${warn}${reason}`;
}

async function openJobsMenu(ctx: any): Promise<void> {
	const jobs = store.readJobs();
	if (!jobs.length) {
		ctx.ui.notify("No scheduled jobs. Create one with the pi-cron-jobs CLI.", "info");
		return;
	}
	const last = lastExecutionByJob(store.readExecutions());
	const labels = jobs.map((j) => jobLabel(j, last.get(j.id)));
	const choice = await ctx.ui.select("Scheduled jobs:", labels);
	if (!choice) return;
	const job = jobs[labels.indexOf(choice)];
	if (!job) return;
	await openExecutionsMenu(ctx, job);
}

async function openExecutionsMenu(ctx: any, job: Job): Promise<void> {
	const execs = store.executionsForJob(job.id).slice().reverse(); // newest first
	if (!execs.length) {
		ctx.ui.notify(`"${job.name}" has not run yet.`, "info");
		return;
	}
	const labels = execs.map(execLabel);
	const choice = await ctx.ui.select(`Executions of "${job.name}" (enter = resume):`, labels);
	if (!choice) return;
	const exec = execs[labels.indexOf(choice)];
	if (!exec) return;
	await resumeExecution(ctx, job, exec);
}

async function resumeExecution(ctx: any, job: Job, exec: Execution): Promise<void> {
	const file = findSessionFile(exec.sessionId);
	if (!file) {
		ctx.ui.notify(`Resume manually: cd ${job.cwd} && pi --session ${exec.sessionId}`, "info");
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
		description: "List scheduled pi jobs, view runs, resume a conversation",
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
