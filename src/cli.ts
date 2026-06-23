#!/usr/bin/env bun
// pi-cron-jobs — wrapper CLI. Runs on Bun.
// Commands: add | list | show | executions | run | rm | resume | sync | status
//           | install-bin | help

import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import * as store from "./core/store";
import * as paths from "./core/paths";
import { runJob } from "./core/run";
import { slugify } from "./core/ids";
import { getScheduler } from "./scheduler/index";
import { expandCron } from "./scheduler/cron";
import type { Job, Schedule, ThreadMode } from "./core/types";

type Flags = { _: string[]; bools: Set<string>; vals: Map<string, string> };

const BOOL_FLAGS = new Set(["isolate", "json"]);

function parseArgs(argv: string[]): Flags {
	const f: Flags = { _: [], bools: new Set(), vals: new Map() };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a.startsWith("--")) {
			const key = a.slice(2);
			if (BOOL_FLAGS.has(key)) f.bools.add(key);
			else f.vals.set(key, argv[++i] ?? "");
		} else {
			f._.push(a);
		}
	}
	return f;
}

function parseDuration(s: string | undefined, fallbackMs: number): number {
	if (!s) return fallbackMs;
	const m = s.match(/^(\d+)\s*(ms|s|m|h)?$/);
	if (!m) return fallbackMs;
	const n = Number(m[1]);
	switch (m[2]) {
		case "ms":
			return n;
		case "s":
			return n * 1000;
		case "h":
			return n * 3600_000;
		default:
			return n * 60_000; // minutes default
	}
}

function die(msg: string): never {
	console.error(`error: ${msg}`);
	process.exit(1);
}

// ---- commands ----

async function cmdAdd(f: Flags): Promise<void> {
	const name = f.vals.get("name") ?? die("--name required");
	const prompt = f.vals.get("prompt") ?? die("--prompt required");
	const cron = f.vals.get("cron");
	const at = f.vals.get("at");
	if (!cron && !at) die("provide --cron <expr> or --at <iso>");
	if (cron && at) die("use only one of --cron / --at");

	const schedule: Schedule = cron
		? { kind: "cron", expr: cron, tz: f.vals.get("tz") }
		: { kind: "once", at: at! };

	// validate the schedule early so we fail before persisting
	if (schedule.kind === "cron") {
		const { domDowConflict } = expandCron(schedule.expr);
		if (domDowConflict)
			console.warn(
				"warning: both day-of-month and day-of-week are set; launchd uses AND (cron uses OR).",
			);
	}

	const id = f.vals.get("id") ?? slugify(name);
	if (store.getJob(id)) die(`job id "${id}" already exists (use --id to override)`);

	const threadMode = (f.vals.get("thread") as ThreadMode) ?? "per-execution";
	const tools = f.vals.get("tools")?.split(",").map((s) => s.trim()).filter(Boolean);
	const excludeTools = f.vals
		.get("exclude-tools")
		?.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const maxRunsRaw = f.vals.get("max-runs");

	const job: Job = {
		id,
		name,
		prompt,
		schedule,
		cwd: f.vals.get("cwd") ?? process.cwd(),
		model: f.vals.get("model") ?? null,
		threadMode,
		isolate: f.bools.has("isolate"),
		tools: tools && tools.length ? tools : null,
		excludeTools: excludeTools && excludeTools.length ? excludeTools : null,
		enabled: true,
		createdAt: new Date().toISOString(),
		maxRuns: maxRunsRaw ? Number(maxRunsRaw) : null,
		timeoutMs: parseDuration(f.vals.get("timeout"), 600_000),
	};
	store.upsertJob(job);
	const scheduler = await getScheduler();
	scheduler.install(job);
	console.log(`added + scheduled "${id}" (${describeSchedule(schedule)}) cwd=${job.cwd}`);
}

function describeSchedule(s: Schedule): string {
	return s.kind === "cron" ? `cron ${s.expr}${s.tz ? ` ${s.tz}` : ""}` : `once ${s.at}`;
}

function cmdList(f: Flags): void {
	const jobs = store.readJobs();
	if (f.bools.has("json")) {
		console.log(JSON.stringify(jobs, null, 2));
		return;
	}
	if (!jobs.length) {
		console.log("no jobs. add one with: pi-cron-jobs add --name ... --prompt ... --cron ...");
		return;
	}
	const execs = store.readExecutions();
	for (const j of jobs) {
		const mine = execs.filter((e) => e.jobId === j.id);
		const last = mine[mine.length - 1];
		const status = last ? last.status : "—";
		const enabled = j.enabled ? "" : " (disabled)";
		console.log(
			`${j.id}${enabled}\n  ${j.name}\n  ${describeSchedule(j.schedule)} · runs=${mine.length} · last=${status}`,
		);
	}
}

function cmdShow(f: Flags): void {
	const id = f._[0] ?? die("usage: show <jobId>");
	const job = store.getJob(id) ?? die(`no such job: ${id}`);
	console.log(JSON.stringify(job, null, 2));
	const execs = store.executionsForJob(id).slice(-10);
	console.log(`\nrecent executions (${execs.length}):`);
	for (const e of execs) printExecLine(e);
}

function cmdExecutions(f: Flags): void {
	const id = f._[0] ?? die("usage: executions <jobId>");
	store.getJob(id) ?? die(`no such job: ${id}`);
	const execs = store.executionsForJob(id);
	if (f.bools.has("json")) {
		console.log(JSON.stringify(execs, null, 2));
		return;
	}
	for (const e of execs) printExecLine(e);
}

function printExecLine(e: { startedAt: string; status: string; reason?: string | null; warning?: boolean; executionId: string }): void {
	const warn = e.warning ? " ⚠" : "";
	const reason = e.reason ? ` — ${e.reason}` : "";
	console.log(`  ${e.startedAt}  ${e.status}${warn}${reason}  [${e.executionId}]`);
}

async function cmdRun(f: Flags): Promise<void> {
	const id = f._[0] ?? die("usage: run <jobId>");
	store.getJob(id) ?? die(`no such job: ${id}`);
	const exec = await runJob(id);
	// one-shot cleanup: after a "once" job fires (not skipped), unschedule + delete
	// the job, but keep the log and the conversation as the trace.
	const job = store.getJob(id);
	if (job && job.schedule.kind === "once" && exec.status !== "skipped") {
		const scheduler = await getScheduler();
		scheduler.remove(id);
		store.removeJob(id);
	}
	if (f.bools.has("json")) {
		console.log(JSON.stringify(exec, null, 2));
		return;
	}
	const warn = exec.warning ? " (warning)" : "";
	console.log(`${exec.status}${warn}${exec.reason ? ` — ${exec.reason}` : ""}`);
	console.log(`log: ${exec.logPath}`);
	console.log(`resume: pi-cron-jobs resume ${exec.executionId}`);
}

async function cmdRm(f: Flags): Promise<void> {
	const id = f._[0] ?? die("usage: rm <jobId>");
	const scheduler = await getScheduler();
	scheduler.remove(id);
	if (store.removeJob(id)) console.log(`removed + unscheduled job "${id}"`);
	else die(`no such job: ${id}`);
}

async function cmdSync(f: Flags): Promise<void> {
	const scheduler = await getScheduler();
	const { installed, removed } = scheduler.sync(store.readJobs());
	if (f.bools.has("json")) {
		console.log(JSON.stringify({ installed, removed }, null, 2));
		return;
	}
	console.log(`synced: ${installed.length} installed, ${removed.length} removed`);
	if (installed.length) console.log(`  installed: ${installed.join(", ")}`);
	if (removed.length) console.log(`  removed:   ${removed.join(", ")}`);
}

async function cmdStatus(f: Flags): Promise<void> {
	const scheduler = await getScheduler();
	const entries = scheduler.status(store.readJobs());
	if (f.bools.has("json")) {
		console.log(JSON.stringify(entries, null, 2));
		return;
	}
	for (const e of entries)
		console.log(`${e.jobId}  loaded=${e.loaded}  plist=${e.plistExists}`);
}

// Copy the currently-running compiled binary to a stable path so launchd plists
// reference something that survives `dist/` rebuilds. Run from the binary.
function cmdInstallBin(): void {
	const src = process.execPath;
	if (/\/(bun|node)$/.test(src))
		die("run this from the compiled binary (bun run build first), not via bun/node");
	const destDir = path.join(paths.root, "bin");
	mkdirSync(destDir, { recursive: true });
	const dest = path.join(destDir, "pi-cron-jobs");
	copyFileSync(src, dest);
	chmodSync(dest, 0o755);
	console.log(`installed binary at ${dest}`);
	console.log("run `pi-cron-jobs sync` to re-point existing jobs at it.");
}

function cmdResume(f: Flags): void {
	const execId = f._[0] ?? die("usage: resume <executionId>");
	const exec = store.readExecutions().find((e) => e.executionId === execId);
	if (!exec) die(`no such execution: ${execId}`);
	const job = store.getJob(exec.jobId);
	const cwd = job?.cwd ?? process.cwd();
	console.log(`cd ${cwd} && pi --session ${exec.sessionId}`);
}

function usage(): void {
	console.log(
		[
			"pi-cron-jobs — schedule headless pi runs",
			"",
			"  add --name N --prompt P (--cron EXPR [--tz TZ] | --at ISO)",
			"      [--cwd DIR] [--model M] [--isolate] [--tools a,b] [--exclude-tools a,b]",
			"      [--thread per-execution|continuous] [--timeout 10m] [--max-runs N] [--id SLUG]",
			"  list [--json]",
			"  show <jobId>",
			"  executions <jobId> [--json]",
			"  run <jobId> [--json]",
			"  rm <jobId>",
			"  resume <executionId>      # prints the command to resume that conversation",
			"  sync [--json]             # reconcile launchd with jobs.json",
			"  status [--json]           # show launchd load state per job",
			"  install-bin               # copy the compiled binary to a stable path",
		].join("\n"),
	);
}

async function main(): Promise<void> {
	const [, , cmd, ...rest] = process.argv;
	const f = parseArgs(rest);
	switch (cmd) {
		case "add":
			return cmdAdd(f);
		case "list":
			return cmdList(f);
		case "show":
			return cmdShow(f);
		case "executions":
			return cmdExecutions(f);
		case "run":
			return cmdRun(f);
		case "rm":
			return cmdRm(f);
		case "resume":
			return cmdResume(f);
		case "sync":
			return cmdSync(f);
		case "status":
			return cmdStatus(f);
		case "install-bin":
			return cmdInstallBin();
		case "help":
		case undefined:
			return usage();
		default:
			die(`unknown command: ${cmd}`);
	}
}

main().catch((err) => die(String(err?.stack ?? err)));
