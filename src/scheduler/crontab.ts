// CrontabScheduler — Linux fallback for launchd.
// Manages user crontab entries tagged with # pi-cron-jobs:<jobId>
// One-shot jobs use `at` if available; they warn and skip if not.

import { execFileSync, execSync } from "node:child_process";
import path from "node:path";
import * as paths from "../core/paths";
import type { Job } from "../core/types";
import type { SchedulerEntry } from "./launchd";

const MARKER = "pi-cron-jobs";

// ---- crontab read/write ----

function readCrontab(): string {
	try {
		return execFileSync("crontab", ["-l"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch {
		return ""; // no crontab yet
	}
}

function writeCrontab(content: string): void {
	// crontab reads from stdin
	execSync(`echo ${JSON.stringify(content)} | crontab -`);
}

function tagFor(jobId: string): string {
	return `# ${MARKER}:${jobId}`;
}

function lineFor(job: Job, binPath: string, pathEnv: string): string {
	if (job.schedule.kind !== "cron") return "";
	const env = `PATH="${pathEnv}" PI_CRON_JOBS_DIR="${paths.root}"`;
	return `${job.schedule.expr} ${env} ${binPath} run ${job.id} ${tagFor(job.id)}`;
}

// ---- one-shot via `at` ----

function atAvailable(): boolean {
	try {
		execFileSync("which", ["at"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function scheduleAt(job: Job, binPath: string, pathEnv: string): void {
	if (job.schedule.kind !== "once") return;
	const d = new Date(job.schedule.at);
	// `at` time format: HH:MM YYYY-MM-DD
	const pad = (n: number) => String(n).padStart(2, "0");
	const atTime = `${pad(d.getHours())}:${pad(d.getMinutes())} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	const cmd = `PATH="${pathEnv}" PI_CRON_JOBS_DIR="${paths.root}" ${binPath} run ${job.id}`;
	execSync(`echo ${JSON.stringify(cmd)} | at ${atTime} 2>/dev/null`);
}

// ---- path resolution (same logic as launchd.ts) ----

function which(cmd: string): string | null {
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		const p = path.join(dir, cmd);
		try {
			execFileSync("test", ["-x", p], { stdio: "ignore" });
			return p;
		} catch {
			// file not executable or doesn't exist — continue
		}
	}
	return null;
}

export function resolveBinPath(): string {
	if (process.env.PI_CRON_JOBS_BIN) return process.env.PI_CRON_JOBS_BIN;
	const installed = path.join(paths.root, "bin", "pi-cron-jobs");
	try {
		execFileSync("test", ["-x", installed], { stdio: "ignore" });
		return installed;
	} catch {
		return process.execPath;
	}
}

export function resolvePathEnv(): string {
	const dirs = new Set<string>();
	for (const cmd of ["pi", "node", "bun"]) {
		const p = which(cmd);
		if (p) dirs.add(path.dirname(p));
	}
	for (const d of ["/usr/local/bin", "/usr/bin", "/bin"]) dirs.add(d);
	return [...dirs].join(":");
}

// ---- public API (mirrors launchd.ts) ----

export function install(job: Job): void {
	const binPath = resolveBinPath();
	const pathEnv = resolvePathEnv();

	if (job.schedule.kind === "once") {
		if (!atAvailable()) {
			console.warn(`pi-cron-jobs: 'at' not found — one-shot job "${job.id}" not scheduled. Install 'at' or run manually.`);
			return;
		}
		scheduleAt(job, binPath, pathEnv);
		return;
	}

	const line = lineFor(job, binPath, pathEnv);
	const tag = tagFor(job.id);
	let tab = readCrontab();

	// remove existing entry for this job (re-install = update)
	tab = tab.split("\n").filter((l) => !l.includes(tag)).join("\n");
	// append new entry
	tab = tab.trimEnd() + (tab.trim() ? "\n" : "") + line + "\n";
	writeCrontab(tab);
}

export function remove(jobId: string): void {
	const tag = tagFor(jobId);
	const tab = readCrontab();
	const filtered = tab.split("\n").filter((l) => !l.includes(tag)).join("\n");
	if (filtered !== tab) writeCrontab(filtered);
}

export function sync(jobs: Job[]): { installed: string[]; removed: string[] } {
	const tab = readCrontab();
	const installed: string[] = [];
	const removed: string[] = [];

	// find all managed job IDs currently in crontab
	// MARKER is a compile-time constant, safe to use in regex
	// biome-ignore lint/suspicious/noMisleadingCharacterClass: static marker constant
	const managedPattern = /# pi-cron-jobs:(\S+)/;
	const existing = new Set<string>();
	for (const line of tab.split("\n")) {
		const m = line.match(managedPattern);
		if (m) existing.add(m[1]!);
	}

	const wanted = new Set(jobs.filter((j) => j.enabled).map((j) => j.id));

	// remove jobs no longer wanted
	for (const id of existing) {
		if (!wanted.has(id)) {
			remove(id);
			removed.push(id);
		}
	}

	// install/update wanted jobs
	for (const job of jobs) {
		if (!job.enabled) continue;
		install(job);
		installed.push(job.id);
	}

	return { installed, removed };
}

export function status(jobs: Job[]): SchedulerEntry[] {
	const tab = readCrontab();
	return jobs.map((j) => {
		const tag = tagFor(j.id);
		const loaded = tab.includes(tag);
		return { jobId: j.id, loaded, plistExists: false }; // plistExists N/A on Linux
	});
}
