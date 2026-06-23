import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Point the store at a temp dir BEFORE importing modules that read paths.root.
const dir = mkdtempSync(path.join(tmpdir(), "pcj-ext-"));
process.env.PI_CRON_JOBS_DIR = dir;

// dynamic imports so the env is set first
const store = await import("../src/core/store");
const extMod = await import("../extension/index");

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

beforeAll(() => {
	const job = {
		id: "triage",
		name: "Triage",
		prompt: "x",
		schedule: { kind: "cron", expr: "0 9 * * *" },
		cwd: "/x",
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
	expect(status).toContain("⏰ jobs: 1");
	expect(status).toContain("failing");

	// lastSeen advanced past the newest execution
	expect(store.readState().lastSeenTs).toBe("2026-06-23T08:00:30Z");

	await handlers.session_shutdown!({}, fakeCtx(cap));
});

test("no double-notify when nothing new since last seen", async () => {
	store.writeState({ lastSeenTs: "2026-06-23T09:00:00Z" });
	const cap: Captured = { notify: [], status: [] };
	const { handlers } = wire();
	await handlers.session_start!({}, fakeCtx(cap));
	expect(cap.notify.length).toBe(0);
	await handlers.session_shutdown!({}, fakeCtx(cap));
});
