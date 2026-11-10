// On-disk store: jobs.json (source of truth) + executions.jsonl (append-only
// ledger) + state.json. Shared by the wrapper CLI and the pi extension.

import {
	mkdirSync,
	readFileSync,
	writeFileSync,
	renameSync,
	existsSync,
	appendFileSync,
	openSync,
	closeSync,
	unlinkSync,
} from "node:fs";
import path from "node:path";
import * as paths from "./paths";
import type { AppState, Execution, Job } from "./types";
import { expiredCompletedJobs } from "./jobs";

function ensureRoot(): void {
	mkdirSync(paths.root, { recursive: true });
}

function atomicWrite(file: string, data: string): void {
	mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, data);
	renameSync(tmp, file);
}

// ---- jobs ----

export function readJobs(): Job[] {
	if (!existsSync(paths.jobsFile)) return [];
	try {
		const parsed = JSON.parse(readFileSync(paths.jobsFile, "utf8"));
		return Array.isArray(parsed) ? (parsed as Job[]) : [];
	} catch {
		return [];
	}
}

export function writeJobs(jobs: Job[]): void {
	ensureRoot();
	atomicWrite(paths.jobsFile, `${JSON.stringify(jobs, null, 2)}\n`);
}

export function getJob(id: string): Job | undefined {
	return readJobs().find((j) => j.id === id);
}

export function upsertJob(job: Job): void {
	const jobs = readJobs();
	const i = jobs.findIndex((j) => j.id === job.id);
	if (i >= 0) jobs[i] = job;
	else jobs.push(job);
	writeJobs(jobs);
}

export function removeJob(id: string): boolean {
	const jobs = readJobs();
	const next = jobs.filter((j) => j.id !== id);
	if (next.length === jobs.length) return false;
	writeJobs(next);
	return true;
}

// Drop finished one-shots past the retention window. Their schedule was already
// removed when they fired; their ledger entries, logs and conversations stay.
export function pruneCompletedJobs(now: Date = new Date()): string[] {
	const jobs = readJobs();
	const expired = new Set(expiredCompletedJobs(jobs, now).map((j) => j.id));
	if (!expired.size) return [];
	writeJobs(jobs.filter((j) => !expired.has(j.id)));
	return [...expired];
}

// ---- executions ledger ----

export function appendExecution(exec: Execution): void {
	ensureRoot();
	appendFileSync(paths.executionsFile, `${JSON.stringify(exec)}\n`);
}

export function readExecutions(): Execution[] {
	if (!existsSync(paths.executionsFile)) return [];
	const out: Execution[] = [];
	for (const line of readFileSync(paths.executionsFile, "utf8").split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			out.push(JSON.parse(t) as Execution);
		} catch {
			// skip corrupt line
		}
	}
	return out;
}

export function executionsForJob(jobId: string): Execution[] {
	return readExecutions().filter((e) => e.jobId === jobId);
}

export function countExecutions(jobId: string): number {
	return executionsForJob(jobId).length;
}

// ---- state ----

export function readState(): AppState {
	if (!existsSync(paths.stateFile)) return {};
	try {
		return JSON.parse(readFileSync(paths.stateFile, "utf8")) as AppState;
	} catch {
		return {};
	}
}

export function writeState(state: AppState): void {
	ensureRoot();
	atomicWrite(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

// ---- ignored executions ----
// A failed run stays the "last execution" of its job forever, so it keeps the
// job flagged as failing until the next scheduled run. Ignoring one clears it
// from the status badge and the session-start notice without touching the
// append-only ledger.

export function readIgnoredExecutions(): Set<string> {
	return new Set(readState().ignoredExecutionIds ?? []);
}

export function isExecutionIgnored(executionId: string): boolean {
	return readIgnoredExecutions().has(executionId);
}

export function setExecutionIgnored(executionId: string, ignored: boolean): void {
	const state = readState();
	const next = new Set(state.ignoredExecutionIds ?? []);
	if (ignored) next.add(executionId);
	else next.delete(executionId);
	// Drop ids whose execution is no longer in the ledger, so this list cannot
	// grow without bound as old runs age out.
	const live = new Set(readExecutions().map((e) => e.executionId));
	const pruned = [...next].filter((id) => live.has(id));
	writeState({ ...state, ignoredExecutionIds: pruned });
}

// ---- review inbox ----
// A run with a `review` line is an open item until marked done (from /jobs or by
// the agent through cron_review_done). Done ids live in state.json, like ignored
// ones, so the ledger stays append-only.

export function readReviewDone(): Set<string> {
	return new Set(readState().reviewDoneIds ?? []);
}

export function setReviewDone(executionId: string, done: boolean): void {
	const state = readState();
	const next = new Set(state.reviewDoneIds ?? []);
	if (done) next.add(executionId);
	else next.delete(executionId);
	const live = new Set(readExecutions().map((e) => e.executionId));
	writeState({ ...state, reviewDoneIds: [...next].filter((id) => live.has(id)) });
}

// Open review items, newest first. Items whose job is gone (a pruned one-shot)
// are dropped: there is nothing left to act on from /jobs.
export function openReviews(): Execution[] {
	const done = readReviewDone();
	const jobIds = new Set(readJobs().map((j) => j.id));
	return readExecutions()
		.filter((e) => e.review && !done.has(e.executionId) && jobIds.has(e.jobId))
		.reverse();
}

// ---- per-job lock (overlap policy = drop) ----
// Best-effort exclusive lock via O_EXCL lockfile. Returns a release fn, or null
// if a run for this job is already in progress.

export function acquireLock(jobId: string): (() => void) | null {
	ensureRoot();
	const lockPath = path.join(paths.root, `${jobId}.lock`);
	try {
		const fd = openSync(lockPath, "wx"); // fails if exists
		writeFileSync(fd, String(process.pid));
		closeSync(fd);
	} catch {
		return null;
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		try {
			unlinkSync(lockPath);
		} catch {
			// already gone
		}
	};
}
