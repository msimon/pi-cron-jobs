// LaunchdScheduler — surface 1 mechanics, owned by the wrapper.
// Generates ~/Library/LaunchAgents/com.pi-cron-jobs.<id>.plist and (un)loads it
// via launchctl. jobs.json is the source of truth; sync() reconciles.

import {
	existsSync,
	mkdirSync,
	writeFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import * as paths from "../core/paths";
import { expandCron, onceInterval, type CalendarInterval } from "./cron";
import type { Job } from "../core/types";

const LABEL_PREFIX = "com.pi-cron-jobs";

export function labelFor(jobId: string): string {
	return `${LABEL_PREFIX}.${jobId}`;
}

function launchAgentsDir(): string {
	return path.join(os.homedir(), "Library", "LaunchAgents");
}

export function plistPath(jobId: string): string {
	return path.join(launchAgentsDir(), `${labelFor(jobId)}.plist`);
}

function domainTarget(): string {
	return `gui/${process.getuid?.() ?? 501}`;
}

// ---- path resolution (the install-time PATH fix for the spawned `pi`) ----

function which(cmd: string): string | null {
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		const p = path.join(dir, cmd);
		if (existsSync(p)) return p;
	}
	return null;
}

// The absolute path of the compiled wrapper binary launchd should invoke.
export function resolveBinPath(): string {
	if (process.env.PI_CRON_JOBS_BIN) return process.env.PI_CRON_JOBS_BIN;
	const installed = path.join(paths.root, "bin", "pi-cron-jobs");
	if (existsSync(installed)) return installed;
	// running as the compiled binary: execPath is ourselves
	return process.execPath;
}

// PATH the spawned `pi` (nvm `#!/usr/bin/env node` shim) needs to find node.
export function resolvePathEnv(): string {
	const dirs = new Set<string>();
	for (const cmd of ["pi", "node", "bun"]) {
		const p = which(cmd);
		if (p) dirs.add(path.dirname(p));
	}
	for (const d of ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"])
		dirs.add(d);
	return [...dirs].join(":");
}

// ---- plist generation (pure) ----

function intervalXml(i: CalendarInterval, indent: string): string {
	const inner = Object.entries(i)
		.map(([k, v]) => `${indent}\t<key>${k}</key>\n${indent}\t<integer>${v}</integer>`)
		.join("\n");
	return `${indent}<dict>\n${inner}\n${indent}</dict>`;
}

function calendarXml(intervals: CalendarInterval[]): string {
	if (intervals.length === 1)
		return `\t<key>StartCalendarInterval</key>\n${intervalXml(intervals[0]!, "\t")}`;
	const items = intervals.map((i) => intervalXml(i, "\t\t")).join("\n");
	return `\t<key>StartCalendarInterval</key>\n\t<array>\n${items}\n\t</array>`;
}

export interface PlistOptions {
	binPath: string;
	pathEnv: string;
}

export function generatePlist(job: Job, opts: PlistOptions): string {
	const intervals =
		job.schedule.kind === "cron"
			? expandCron(job.schedule.expr).intervals
			: [onceInterval(job.schedule.at)];

	const outLog = path.join(paths.logsDir, job.id, "launchd.out.log");
	const errLog = path.join(paths.logsDir, job.id, "launchd.err.log");

	const args = [opts.binPath, "run", job.id]
		.map((a) => `\t\t<string>${escapeXml(a)}</string>`)
		.join("\n");

	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${labelFor(job.id)}</string>
	<key>ProgramArguments</key>
	<array>
${args}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${escapeXml(opts.pathEnv)}</string>
		<key>PI_CRON_JOBS_DIR</key>
		<string>${escapeXml(paths.root)}</string>
	</dict>
${calendarXml(intervals)}
	<key>RunAtLoad</key>
	<false/>
	<key>StandardOutPath</key>
	<string>${escapeXml(outLog)}</string>
	<key>StandardErrorPath</key>
	<string>${escapeXml(errLog)}</string>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

// ---- launchctl side effects ----

function launchctl(args: string[]): { ok: boolean; out: string } {
	try {
		const out = execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { ok: true, out };
	} catch (err: unknown) {
		const e = err as { stdout?: string; stderr?: string };
		return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
	}
}

export function install(job: Job): void {
	mkdirSync(launchAgentsDir(), { recursive: true });
	mkdirSync(path.join(paths.logsDir, job.id), { recursive: true });
	const file = plistPath(job.id);
	writeFileSync(
		file,
		generatePlist(job, { binPath: resolveBinPath(), pathEnv: resolvePathEnv() }),
	);
	// reload: bootout (ignore errors) then bootstrap; fall back to load -w
	launchctl(["bootout", `${domainTarget()}/${labelFor(job.id)}`]);
	const boot = launchctl(["bootstrap", domainTarget(), file]);
	if (!boot.ok) launchctl(["load", "-w", file]);
}

export function remove(jobId: string): void {
	const file = plistPath(jobId);
	launchctl(["bootout", `${domainTarget()}/${labelFor(jobId)}`]);
	if (existsSync(file)) {
		launchctl(["unload", "-w", file]); // best-effort legacy path
		rmSync(file, { force: true });
	}
}

// Reconcile OS state with jobs.json: install enabled jobs, remove stale/disabled.
export function sync(jobs: Job[]): { installed: string[]; removed: string[] } {
	const wanted = new Set(jobs.filter((j) => j.enabled).map((j) => j.id));
	const installed: string[] = [];
	const removed: string[] = [];

	// remove plists that no longer correspond to an enabled job
	const dir = launchAgentsDir();
	if (existsSync(dir)) {
		for (const f of readdirSync(dir)) {
			if (!f.startsWith(`${LABEL_PREFIX}.`) || !f.endsWith(".plist")) continue;
			const id = f.slice(LABEL_PREFIX.length + 1, -".plist".length);
			if (!wanted.has(id)) {
				remove(id);
				removed.push(id);
			}
		}
	}
	for (const job of jobs) {
		if (!job.enabled) continue;
		install(job);
		installed.push(job.id);
	}
	return { installed, removed };
}

export interface SchedulerEntry {
	jobId: string;
	loaded: boolean;
	plistExists: boolean;
}

export function status(jobs: Job[]): SchedulerEntry[] {
	return jobs.map((j) => {
		const loaded = launchctl(["list", labelFor(j.id)]).ok;
		return { jobId: j.id, loaded, plistExists: existsSync(plistPath(j.id)) };
	});
}
