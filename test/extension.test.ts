import { test, expect, beforeAll } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Point the store at a temp dir BEFORE importing modules that read paths.root.
const dir = mkdtempSync(path.join(tmpdir(), "pcj-ext-"));
process.env.PI_CRON_JOBS_DIR = dir;

// dynamic imports so the env is set first
const store = await import("../src/core/store");
const extMod = await import("../extension/index");
const paths = await import("../src/core/paths");

type Captured = { notify: Array<[string, string]>; status: Array<string | undefined> };

function fakeCtx(cap: Captured) {
	return {
		hasUI: true,
		ui: {
			notify: (msg: string, level: string) => cap.notify.push([msg, level]),
			setStatus: (_key: string, val: string | undefined) => cap.status.push(val),
			select: async () => undefined,
			confirm: async () => false,
		},
	};
}

// ctx whose select() answers each prompt in order, and whose confirm() says yes.
function scriptedCtx(cap: Captured, picks: Array<(options: string[]) => string | undefined>) {
	let i = 0;
	return {
		hasUI: true,
		ui: {
			notify: (msg: string, level: string) => cap.notify.push([msg, level]),
			setStatus: (_key: string, val: string | undefined) => cap.status.push(val),
			select: async (_title: string, options: string[]) => picks[i++]?.(options),
			confirm: async () => true,
		},
	};
}

function wire() {
	const handlers: Record<string, (e: any, c: any) => any> = {};
	const commands: Record<string, any> = {};
	const pi = {
		on: (ev: string, fn: any) => {
			handlers[ev] = fn;
		},
		registerCommand: (name: string, opts: any) => {
			commands[name] = opts;
		},
	};
	(extMod.default as (pi: any) => void)(pi);
	return { handlers, commands };
}

// The job row ("Retry all" may sit above it).
const pickJob = (options: string[]) => options.find((o) => o.startsWith("Triage"));

beforeAll(() => {
	const job = {
		id: "triage",
		name: "Triage",
		prompt: "x",
		schedule: { kind: "cron", expr: "0 9 * * *" },
		cwd: dir,
		threadMode: "per-execution",
		enabled: true,
		createdAt: "2026-01-01T00:00:00Z",
		timeoutMs: 600000,
	};
	store.writeJobs([job as any]);
	store.appendExecution({
		jobId: "triage",
		executionId: "e1",
		sessionId: "triage__e1",
		startedAt: "2026-06-23T07:00:00Z",
		endedAt: "2026-06-23T07:00:30Z",
		exitCode: 0,
		status: "success",
		reason: null,
		warning: false,
		logPath: "x",
	});
	store.appendExecution({
		jobId: "triage",
		executionId: "e2",
		sessionId: "triage__e2",
		startedAt: "2026-06-23T08:00:00Z",
		endedAt: "2026-06-23T08:00:30Z",
		exitCode: 1,
		status: "failure",
		reason: "no room available",
		warning: false,
		logPath: "x",
	});
});

test("registers the /jobs command", () => {
	const { commands } = wire();
	expect(commands.jobs).toBeDefined();
	expect(typeof commands.jobs.handler).toBe("function");
});

test("session_start notifies about failures since last seen and sets status", async () => {
	store.writeState({ lastSeenTs: "2026-06-23T06:00:00Z" });
	const cap: Captured = { notify: [], status: [] };
	const { handlers } = wire();
	await handlers.session_start!({}, fakeCtx(cap));

	// one notice mentioning the failure
	expect(cap.notify.length).toBe(1);
	expect(cap.notify[0]![0]).toContain("failed");
	expect(cap.notify[0]![0]).toContain("triage");
	expect(cap.notify[0]![1]).toBe("warning");

	// status badge shows the failing job
	const status = cap.status.find((s) => typeof s === "string");
	expect(status).toContain("cron: 1");
	expect(status).toContain("failing");

	// lastSeen advanced past the newest execution
	expect(store.readState().lastSeenTs).toBe("2026-06-23T08:00:30Z");

	await handlers.session_shutdown!({}, fakeCtx(cap));
});

test("retry action spawns the wrapper for the job and stays in session", async () => {
	const marker = path.join(dir, "retry-args");
	const fakeBin = path.join(dir, "fake-pi-cron-jobs");
	writeFileSync(fakeBin, `#!/bin/sh\nprintf '%s' "$*" > ${JSON.stringify(marker)}\n`);
	chmodSync(fakeBin, 0o755);
	process.env.PI_CRON_JOBS_BIN = fakeBin;

	const cap: Captured = { notify: [], status: [] };
	const { commands } = wire();
	const ctx = scriptedCtx(cap, [
		pickJob, // the job
		(options) => options[0], // newest execution
		(options) => options.find((o) => o.includes("Retry")), // action menu
	]);
	await commands.jobs!.handler("", ctx);

	expect(cap.notify.some(([msg]) => msg.includes("Retrying"))).toBe(true);
	for (let i = 0; i < 50 && !existsSync(marker); i++)
		await new Promise((r) => setTimeout(r, 50));
	expect(existsSync(marker)).toBe(true);
	expect(readFileSync(marker, "utf8").trim()).toBe("run triage");
	delete process.env.PI_CRON_JOBS_BIN;
});

test("no double-notify when nothing new since last seen", async () => {
	store.writeState({ lastSeenTs: "2026-06-23T09:00:00Z" });
	const cap: Captured = { notify: [], status: [] };
	const { handlers } = wire();
	await handlers.session_start!({}, fakeCtx(cap));
	expect(cap.notify.length).toBe(0);
	await handlers.session_shutdown!({}, fakeCtx(cap));
});

test("ignoring a failed execution clears it from the badge and the notice", async () => {
	const cap: Captured = { notify: [], status: [] };
	const { commands } = wire();
	const ctx = scriptedCtx(cap, [
		pickJob, // the job
		(options) => options[0], // newest execution (e2, the failure)
		(options) => options.find((o) => o.includes("Ignore")), // action menu
	]);
	await commands.jobs!.handler("", ctx);

	expect(store.readState().ignoredExecutionIds).toEqual(["e2"]);
	expect(cap.notify.some(([msg]) => msg.includes("no longer counts as failing"))).toBe(true);

	// the failure no longer drives the badge or the session-start warning
	store.writeState({ ...store.readState(), lastSeenTs: "2026-06-23T06:00:00Z" });
	const after: Captured = { notify: [], status: [] };
	const { handlers } = wire();
	await handlers.session_start!({}, fakeCtx(after));

	expect(after.notify.some(([msg]) => msg.includes("failed"))).toBe(false);
	expect(after.status.find((s) => typeof s === "string")).not.toContain("failing");
	await handlers.session_shutdown!({}, fakeCtx(after));
});

test("un-ignoring a failed execution brings the warning back", async () => {
	const cap: Captured = { notify: [], status: [] };
	const { commands } = wire();
	const ctx = scriptedCtx(cap, [
		pickJob,
		(options) => options.find((o) => o.includes("ignored")), // labelled as ignored
		(options) => options.find((o) => o.includes("Stop ignoring")),
	]);
	await commands.jobs!.handler("", ctx);

	expect(store.readState().ignoredExecutionIds).toEqual([]);

	store.writeState({ ...store.readState(), lastSeenTs: "2026-06-23T06:00:00Z" });
	const after: Captured = { notify: [], status: [] };
	const { handlers } = wire();
	await handlers.session_start!({}, fakeCtx(after));
	expect(after.notify.some(([msg]) => msg.includes("failed"))).toBe(true);
	await handlers.session_shutdown!({}, fakeCtx(after));
});

test("session_start warns about dark-wake skips alongside failures", async () => {
	store.appendExecution({
		jobId: "triage",
		executionId: "e3",
		sessionId: "triage__e3",
		startedAt: "2026-06-24T07:00:00Z",
		endedAt: "2026-06-24T07:00:01Z",
		exitCode: null,
		status: "skipped",
		reason: "dark wake — last sleep: Maintenance Sleep",
		warning: false,
		logPath: "x",
	});
	store.writeState({ lastSeenTs: "2026-06-24T06:00:00Z" });

	const cap: Captured = { notify: [], status: [] };
	const { handlers } = wire();
	await handlers.session_start!({}, fakeCtx(cap));

	expect(cap.notify.length).toBe(1);
	const [msg, level] = cap.notify[0]!;
	expect(level).toBe("warning");
	expect(msg).toContain("skipped, Mac was asleep");
	expect(msg).toContain("triage");
	await handlers.session_shutdown!({}, fakeCtx(cap));
});

test("session_start warns about offline skips", async () => {
	store.appendExecution({
		jobId: "triage",
		executionId: "e3b",
		sessionId: "triage__e3b",
		startedAt: "2026-06-24T09:00:00Z",
		endedAt: "2026-06-24T09:01:30Z",
		exitCode: null,
		status: "skipped",
		reason: "offline — api.anthropic.com:443 unreachable for 90s",
		warning: false,
		logPath: "x",
	});
	store.writeState({ lastSeenTs: "2026-06-24T08:00:00Z" });

	const cap: Captured = { notify: [], status: [] };
	const { handlers } = wire();
	await handlers.session_start!({}, fakeCtx(cap));

	const [msg, level] = cap.notify[0]!;
	expect(level).toBe("warning");
	expect(msg).toContain("skipped, no network");
	await handlers.session_shutdown!({}, fakeCtx(cap));
});

test("an ordinary skip does not raise a warning", async () => {
	store.appendExecution({
		jobId: "triage",
		executionId: "e4",
		sessionId: "triage__e4",
		startedAt: "2026-06-25T07:00:00Z",
		endedAt: "2026-06-25T07:00:01Z",
		exitCode: null,
		status: "skipped",
		reason: "job disabled",
		warning: false,
		logPath: "x",
	});
	store.writeState({ lastSeenTs: "2026-06-25T06:00:00Z" });

	const cap: Captured = { notify: [], status: [] };
	const { handlers } = wire();
	await handlers.session_start!({}, fakeCtx(cap));

	expect(cap.notify[0]![1]).toBe("info");
	expect(cap.notify[0]![0]).toContain("all ok");
	await handlers.session_shutdown!({}, fakeCtx(cap));
});

// Menu options offered for one execution, picked by its label.
async function actionMenuFor(execMatch: (label: string) => boolean): Promise<string[]> {
	let seen: string[] = [];
	const cap: Captured = { notify: [], status: [] };
	const { commands } = wire();
	const ctx = scriptedCtx(cap, [
		pickJob, // the job
		(options) => options.find(execMatch),
		(options) => {
			seen = options;
			return undefined; // close the menu
		},
	]);
	await commands.jobs!.handler("", ctx);
	return seen;
}

test("a run with no saved conversation shows a note instead of Resume", async () => {
	// e4 ("job disabled" skip) is the newest execution and never wrote a session.
	const options = await actionMenuFor((label) => label.includes("skipped"));
	expect(options.some((o) => o.includes("No conversation to resume"))).toBe(true);
	expect(options.some((o) => o.includes("Resume conversation"))).toBe(false);
	expect(options.some((o) => o.includes("Retry"))).toBe(true);
});

test("a run with a saved conversation offers Resume", async () => {
	mkdirSync(paths.sessionsDir, { recursive: true });
	writeFileSync(path.join(paths.sessionsDir, "2026-06-23T07-00-00-000Z_triage__e1.jsonl"), "");
	const options = await actionMenuFor((label) => label.includes("success"));
	expect(options.some((o) => o.includes("Resume conversation"))).toBe(true);
	expect(options.some((o) => o.includes("No conversation"))).toBe(false);
});

// ---- Retry all ----

function addJobWithLast(id: string, last: Partial<Record<string, unknown>>) {
	store.upsertJob({
		id,
		name: id,
		prompt: "x",
		schedule: { kind: "cron", expr: "0 9 * * *" },
		cwd: dir,
		threadMode: "per-execution",
		enabled: true,
		createdAt: "2026-01-01T00:00:00Z",
		timeoutMs: 600000,
	} as any);
	store.appendExecution({
		jobId: id,
		executionId: `${id}-last`,
		sessionId: `${id}__last`,
		startedAt: "2026-06-26T07:00:00Z",
		endedAt: "2026-06-26T07:01:00Z",
		exitCode: 1,
		status: "failure",
		reason: "boom",
		warning: false,
		logPath: "x",
		...last,
	} as any);
}

test("Retry all runs every failed or interrupted job in one sequential batch", async () => {
	addJobWithLast("book", {});
	addJobWithLast("standup", { status: "skipped", reason: "offline — connection error (exited 1)" });
	addJobWithLast("mail", {});
	store.setExecutionIgnored("mail-last", true); // dismissed: left out
	addJobWithLast("busy", {});
	writeFileSync(path.join(paths.root, "busy.lock"), "1"); // run in flight: left out
	addJobWithLast("fine", { status: "success", reason: null }); // ok: left out

	const marker = path.join(dir, "retry-all-args");
	const fakeBin = path.join(dir, "fake-batch");
	writeFileSync(fakeBin, `#!/bin/sh\nprintf '%s' "$*" > ${JSON.stringify(marker)}\nsleep 2\n`);
	chmodSync(fakeBin, 0o755);
	process.env.PI_CRON_JOBS_BIN = fakeBin;

	let menu: string[] = [];
	const cap: Captured = { notify: [], status: [] };
	const { commands } = wire();
	await commands.jobs!.handler(
		"",
		scriptedCtx(cap, [
			(options) => {
				menu = options;
				return options.find((o) => o.includes("Retry all"));
			},
		]),
	);

	expect(menu[0]).toContain("Retry all failed (3)"); // book, standup, busy
	for (let i = 0; i < 50 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
	expect(readFileSync(marker, "utf8").trim()).toBe("run book standup");
	expect(cap.notify.some(([m]) => m.includes("one after the other"))).toBe(true);

	// A second click while the batch is still running does not start another.
	const again: Captured = { notify: [], status: [] };
	await commands.jobs!.handler(
		"",
		scriptedCtx(again, [(options) => options.find((o) => o.includes("Retry all"))]),
	);
	expect(again.notify.some(([m]) => m.includes("still running"))).toBe(true);

	delete process.env.PI_CRON_JOBS_BIN;
});

test("no Retry all entry when nothing needs it", async () => {
	for (const id of ["book", "standup", "busy"]) store.setExecutionIgnored(`${id}-last`, true);
	let menu: string[] = [];
	const { commands } = wire();
	await commands.jobs!.handler(
		"",
		scriptedCtx({ notify: [], status: [] }, [
			(options) => {
				menu = options;
				return undefined;
			},
		]),
	);
	expect(menu.some((o) => o.includes("Retry all"))).toBe(false);
});

// ---- tabbed /jobs picker ----

// ctx in TUI mode whose custom() drives the component with `keys`, then returns
// what it resolved to plus every screen it rendered.
function tuiCtx(cap: Captured, keys: string[], selects: string[]) {
	const KEYMAP: Record<string, string> = {
		"\r": "tui.select.confirm",
		"\x1b": "tui.select.cancel",
		"\x1b[A": "tui.select.up",
		"\x1b[B": "tui.select.down",
	};
	const screens: string[][] = [];
	const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
	const keybindings = { matches: (data: string, id: string) => KEYMAP[data] === id };
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			notify: (msg: string, level: string) => cap.notify.push([msg, level]),
			setStatus: (_key: string, val: string | undefined) => cap.status.push(val),
			select: async (title: string) => {
				selects.push(title);
				return undefined;
			},
			confirm: async () => false,
			custom: (factory: any) =>
				new Promise((resolve) => {
					let result: unknown;
					let finished = false;
					const comp = factory({ requestRender: () => {} }, theme, keybindings, (r: unknown) => {
						finished = true;
						result = r;
					});
					screens.push(comp.render(200));
					for (const k of keys) {
						if (finished) break;
						comp.handleInput(k);
						screens.push(comp.render(200));
					}
					resolve(result);
				}),
		},
	};
	return { ctx, screens };
}

test("/jobs opens on the Scheduled tab; One-time lists one-shots, done ones flagged; old ones pruned", async () => {
	const once = (id: string, completedAt: string | null) =>
		store.upsertJob({
			id,
			name: id,
			prompt: "x",
			schedule: { kind: "once", at: "2026-11-11T12:00:00" },
			cwd: dir,
			threadMode: "per-execution",
			enabled: true,
			createdAt: "2026-01-01T00:00:00Z",
			timeoutMs: 600000,
			completedAt,
		} as any);
	once("lunch", new Date().toISOString());
	once("ancient", "2020-01-01T00:00:00Z"); // past the 30-day window
	store.appendExecution({
		jobId: "lunch",
		executionId: "lunch-1",
		sessionId: "lunch__1",
		startedAt: "2026-11-11T12:00:00Z",
		endedAt: "2026-11-11T12:01:00Z",
		exitCode: 0,
		status: "success",
		reason: null,
		warning: false,
		logPath: "x",
	});

	const selects: string[] = [];
	const { ctx, screens } = tuiCtx({ notify: [], status: [] }, ["\x1b[C", "\r"], selects);
	const { commands } = wire();
	await commands.jobs!.handler("", ctx);

	// first screen: Scheduled tab, cron jobs only
	const first = screens[0]!.join("\n");
	expect(first).toContain("Scheduled (6)");
	expect(first).toContain("One-time (1)");
	expect(first).toContain("All (7)");
	expect(first).toContain("Triage [0 9 * * *]");
	expect(first).not.toContain("lunch");

	// → One-time: the finished one-shot, flagged done; the expired one is gone
	const second = screens[1]!.join("\n");
	expect(second).toMatch(/> lunch \[@ .*\] — success · done/);
	expect(second).not.toContain("Triage");
	expect(store.getJob("ancient")).toBeUndefined();

	// enter opens that job's runs
	expect(selects[0]).toContain('Executions of "lunch"');
});