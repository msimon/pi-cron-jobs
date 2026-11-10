#!/usr/bin/env bun
// pi-cron-jobs — wrapper CLI. Runs on Bun.
// Commands: add | list | show | executions | run | rm | resume | sync | status
//           | install-bin | help

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import * as store from "./core/store";
import * as paths from "./core/paths";
import { runJob } from "./core/run";
import { slugify } from "./core/ids";
import { getScheduler } from "./scheduler/index";
import { expandCron } from "./scheduler/cron";
import { isCompleted, isScheduled, NOTIFY_POLICIES, notifyPolicy } from "./core/jobs";
import type { Execution, Job, NotifyPolicy, Schedule, ThreadMode } from "./core/types";

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

	const schedule = parseSchedule(cron, at, f.vals.get("tz"));

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
	const notify = parseNotify(f.vals.get("notify"));

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
		...(notify ? { notify } : {}),
	};
	store.upsertJob(job);
	const scheduler = await getScheduler();
	scheduler.install(job);
	console.log(
		`added + scheduled "${id}" (${describeSchedule(schedule)}, notify=${notifyPolicy(job)}) cwd=${job.cwd}`,
	);
}

function parseSchedule(cron: string | undefined, at: string | undefined, tz: string | undefined): Schedule {
	const schedule: Schedule = cron ? { kind: "cron", expr: cron, tz } : { kind: "once", at: at! };
	// validate the schedule early so we fail before persisting
	if (schedule.kind === "cron") {
		const { domDowConflict } = expandCron(schedule.expr);
		if (domDowConflict)
			console.warn(
				"warning: both day-of-month and day-of-week are set; launchd uses AND (cron uses OR).",
			);
	} else if (Number.isNaN(new Date(schedule.at).getTime())) {
		die(`invalid --at timestamp: "${schedule.at}"`);
	}
	return schedule;
}

function parseNotify(raw: string | undefined): NotifyPolicy | undefined {
	if (raw === undefined) return undefined;
	if (!(NOTIFY_POLICIES as readonly string[]).includes(raw))
		die(`--notify must be one of: ${NOTIFY_POLICIES.join(", ")}`);
	return raw as NotifyPolicy;
}

// Change an existing job in jobs.json, then bring the OS scheduler in line.
async function cmdSet(f: Flags): Promise<void> {
	const id = f._[0] ?? die("usage: set <jobId> [--notify P] [--name N] [--prompt P] [--cron EXPR [--tz TZ] | --at ISO] [--cwd DIR] [--model M] [--timeout 10m] [--max-runs N]");
	const job = store.getJob(id) ?? die(`no such job: ${id}`);
	const cron = f.vals.get("cron");
	const at = f.vals.get("at");
	if (cron && at) die("use only one of --cron / --at");

	const next: Job = { ...job };
	const notify = parseNotify(f.vals.get("notify"));
	if (notify) next.notify = notify;
	if (f.vals.has("name")) next.name = f.vals.get("name")!;
	if (f.vals.has("prompt")) next.prompt = f.vals.get("prompt")!;
	if (f.vals.has("cwd")) next.cwd = f.vals.get("cwd")!;
	if (f.vals.has("model")) next.model = f.vals.get("model") || null;
	if (f.vals.has("timeout")) next.timeoutMs = parseDuration(f.vals.get("timeout"), job.timeoutMs);
	if (f.vals.has("max-runs")) next.maxRuns = f.vals.get("max-runs") ? Number(f.vals.get("max-runs")) : null;
	if (cron || at) {
		next.schedule = parseSchedule(cron, at, f.vals.get("tz"));
		next.completedAt = null; // a new time re-arms a finished one-shot
	} else if (f.vals.has("tz") && next.schedule.kind === "cron") {
		next.schedule = { ...next.schedule, tz: f.vals.get("tz") };
	}
	if (JSON.stringify(next) === JSON.stringify(job)) die("nothing to change");

	store.upsertJob(next);
	const scheduler = await getScheduler();
	if (isScheduled(next)) scheduler.install(next);
	else scheduler.remove(next.id);
	console.log(
		`updated "${id}" (${describeSchedule(next.schedule)}, notify=${notifyPolicy(next)})${isScheduled(next) ? "" : " — not scheduled"}`,
	);
}

function describeSchedule(s: Schedule): string {
	return s.kind === "cron" ? `cron ${s.expr}${s.tz ? ` ${s.tz}` : ""}` : `once ${s.at}`;
}

function cmdList(f: Flags): void {
	store.pruneCompletedJobs();
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
	const reviewDone = store.readReviewDone();
	for (const j of jobs) {
		const mine = execs.filter((e) => e.jobId === j.id);
		const last = mine[mine.length - 1];
		const status = last ? last.status : "—";
		const flag = isCompleted(j) ? " (done)" : j.enabled ? "" : " (disabled)";
		const open = mine.filter((e) => e.review && !reviewDone.has(e.executionId)).length;
		const inbox = open ? ` · ${open} to review` : "";
		console.log(
			`${j.id}${flag}\n  ${j.name}\n  ${describeSchedule(j.schedule)} · notify=${notifyPolicy(j)} · runs=${mine.length} · last=${status}${inbox}`,
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

function printExecLine(e: Execution): void {
	const warn = e.warning ? " ⚠" : "";
	const reason = e.reason ? ` — ${e.reason}` : "";
	const review = e.review ? `  📥 ${e.review}` : "";
	console.log(`  ${e.startedAt}  ${e.status}${warn}${reason}${review}  [${e.executionId}]`);
}

// `run a b c` runs the jobs one after the other (used by /jobs "Retry all"),
// so browser-driving jobs never overlap.
async function cmdRun(f: Flags): Promise<void> {
	const ids = f._;
	if (!ids.length) die("usage: run <jobId> [jobId...]");
	for (const id of ids) store.getJob(id) ?? die(`no such job: ${id}`);
	const results: Execution[] = [];
	for (const id of ids) {
		const exec = await runJob(id);
		results.push(exec);
		// one-shot cleanup: after a "once" job fires (not skipped), unschedule it and
		// mark it completed. It stays in jobs.json (so /jobs can still reach its runs
		// and conversations) until pruneCompletedJobs drops it after 30 days.
		const job = store.getJob(id);
		if (job && job.schedule.kind === "once" && exec.status !== "skipped") {
			const scheduler = await getScheduler();
			scheduler.remove(id);
			store.upsertJob({ ...job, completedAt: exec.endedAt ?? new Date().toISOString() });
		}
		if (f.bools.has("json")) continue;
		const warn = exec.warning ? " (warning)" : "";
		const prefix = ids.length > 1 ? `${id}: ` : "";
		console.log(`${prefix}${exec.status}${warn}${exec.reason ? ` — ${exec.reason}` : ""}`);
		if (exec.status !== "skipped") {
			console.log(`log: ${exec.logPath}`);
			console.log(`resume: pi-cron-jobs resume ${exec.executionId}`);
		}
	}
	store.pruneCompletedJobs();
	if (f.bools.has("json")) {
		console.log(JSON.stringify(ids.length === 1 ? results[0] : results, null, 2));
	}
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
	const execId = f._[0];
	if (!execId) {
		const piBin = process.env.PI_BIN ?? "pi";
		const result = spawnSync(piBin, ["--session-dir", paths.sessionsDir, "--resume"], {
			stdio: "inherit",
		});
		if (result.error) die(`could not launch pi: ${result.error.message}`);
		if (result.signal) die(`pi terminated by ${result.signal}`);
		if (result.status && result.status !== 0) process.exit(result.status);
		return;
	}

	const exec = store.readExecutions().find((e) => e.executionId === execId);
	if (!exec) die(`no such execution: ${execId}`);
	const job = store.getJob(exec.jobId);
	const cwd = job?.cwd ?? process.cwd();
	console.log(
		`cd ${JSON.stringify(cwd)} && pi --session-dir ${JSON.stringify(paths.sessionsDir)} --session ${JSON.stringify(exec.sessionId)}`,
	);
}

function usage(): void {
	console.log(
		[
			"pi-cron-jobs — schedule headless pi runs",
			"",
			"  add --name N --prompt P (--cron EXPR [--tz TZ] | --at ISO)",
			"      [--cwd DIR] [--model M] [--isolate] [--tools a,b] [--exclude-tools a,b]",
			"      [--thread per-execution|continuous] [--timeout 10m] [--max-runs N] [--id SLUG]",
			"      [--notify failure|always|review]  # default: failure (cron), always (--at)",
			"  set <jobId> [--notify P] [--name N] [--prompt P] [--cron EXPR [--tz TZ] | --at ISO]",
			"      [--cwd DIR] [--model M] [--timeout 10m] [--max-runs N]  # edit + reschedule",
			"  list [--json]",
			"  show <jobId>",
			"  executions <jobId> [--json]",
			"  run <jobId> [jobId...] [--json]  # several ids run one after the other",
			"  rm <jobId>",
			"  resume [executionId]       # open cron session picker, or print command for one execution",
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
		case "set":
			return cmdSet(f);
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
