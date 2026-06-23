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
