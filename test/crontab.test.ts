/**
 * Tests for src/scheduler/crontab.ts
 *
 * Strategy: mock node:child_process before importing crontab so the module
 * picks up the mocks. State (simulated crontab content) is maintained in a
 * closure that both sides share.
 */
import { test, expect, beforeEach, mock, spyOn } from "bun:test";
import type { Job } from "../src/core/types";

// ---- shared mutable state ----
let crontabContent = "";
let atExists = true;

// ---- child_process mocks ----
//
// execFileSync is called for:
//   crontab -l       → return crontabContent (or throw if "")
//   which at         → return "/usr/bin/at" (or throw)
//   test -x <path>   → always throw (no real executables in tests)
//
// execSync is called for:
//   echo <JSON> | crontab -  → capture content
//   echo <JSON> | at <time>  → capture at invocation
const execSyncCalls: string[] = [];

const execFileSyncMock = mock(
	(cmd: string, args: string[] | readonly string[]) => {
		if (cmd === "crontab" && args[0] === "-l") {
			if (!crontabContent) throw new Error("no crontab for user");
			return crontabContent;
		}
		if (cmd === "which" && args[0] === "at") {
			if (!atExists) throw new Error("at not found");
			return "/usr/bin/at\n";
		}
		// "test -x <path>" — always fail (nothing is executable in tests)
		throw new Error(`execFileSync: ${cmd} ${args.join(" ")}`);
	},
);

const execSyncMock = mock((cmd: string) => {
	execSyncCalls.push(cmd);
	if (cmd.includes("| crontab -")) {
		// Format: echo <JSON.stringify(content)> | crontab -
		const jsonPart = cmd.replace(/^echo /, "").replace(/ \| crontab -$/, "");
		crontabContent = JSON.parse(jsonPart);
	}
	return Buffer.from("");
});

mock.module("node:child_process", () => ({
	execFileSync: execFileSyncMock,
	execSync: execSyncMock,
}));

// Import crontab AFTER mock.module so it picks up the mocks.
const crontab = await import("../src/scheduler/crontab");

// ---- helpers ----

function makeCronJob(id: string, expr = "*/5 * * * *"): Job {
	return {
		id,
		name: id,
		prompt: "test prompt",
		cwd: "/tmp",
		enabled: true,
		schedule: { kind: "cron", expr },
		threadMode: "per-execution",
		timeoutMs: 600_000,
		createdAt: new Date().toISOString(),
	};
}

function makeOnceJob(id: string, at = "2030-01-01T09:00:00"): Job {
	return {
		id,
		name: id,
		prompt: "test prompt",
		cwd: "/tmp",
		enabled: true,
		schedule: { kind: "once", at },
		threadMode: "per-execution",
		timeoutMs: 600_000,
		createdAt: new Date().toISOString(),
	};
}

// ---- reset between tests ----

beforeEach(() => {
	crontabContent = "";
	atExists = true;
	execSyncCalls.length = 0;
	execFileSyncMock.mockClear();
	execSyncMock.mockClear();
});

// ---- tests ----

test("readCrontab: returns empty string when no crontab exists", () => {
	crontabContent = ""; // triggers throw inside mock
	// install on an empty crontab should not crash — it starts fresh
	crontab.install(makeCronJob("newjob"));
	expect(crontabContent).toContain("# pi-cron-jobs:newjob");
});

test("install: adds tagged entry to empty crontab", () => {
	crontab.install(makeCronJob("myjob", "0 9 * * 1-5"));
	expect(crontabContent).toContain("0 9 * * 1-5");
	expect(crontabContent).toContain("# pi-cron-jobs:myjob");
	expect(crontabContent).toContain("myjob");
});

test("install: replaces existing entry on re-install", () => {
	crontab.install(makeCronJob("myjob", "0 9 * * *"));

	// re-install with a different schedule
	crontab.install(makeCronJob("myjob", "0 10 * * *"));

	// only one entry for myjob
	const lines = crontabContent.split("\n").filter((l) => l.includes("pi-cron-jobs:myjob"));
	expect(lines).toHaveLength(1);
	expect(crontabContent).toContain("0 10 * * *");
	expect(crontabContent).not.toContain("0 9 * * *");
});

test("install: multiple jobs coexist in crontab", () => {
	crontab.install(makeCronJob("job-a", "*/5 * * * *"));
	crontab.install(makeCronJob("job-b", "0 8 * * *"));

	expect(crontabContent).toContain("# pi-cron-jobs:job-a");
	expect(crontabContent).toContain("# pi-cron-jobs:job-b");
	expect(crontabContent.split("\n").filter((l) => l.trim()).length).toBeGreaterThanOrEqual(2);
});

test("install: once job — uses `at` when available", () => {
	atExists = true;
	crontab.install(makeOnceJob("once-job", "2030-06-15T14:30:00"));

	// execSync should have been called with an `at` command
	const atCall = execSyncCalls.find((c) => c.includes("| at "));
	expect(atCall).toBeDefined();
	expect(atCall).toContain("14:30");
	expect(atCall).toContain("2030-06-15");
	// crontab should NOT be touched for a once job
	expect(execSyncCalls.filter((c) => c.includes("| crontab -"))).toHaveLength(0);
});

test("install: once job — warns and skips when `at` unavailable", () => {
	atExists = false;
	const warn = spyOn(console, "warn");

	crontab.install(makeOnceJob("once-job"));

	expect(warn).toHaveBeenCalledWith(expect.stringContaining("'at' not found"));
	expect(execSyncCalls).toHaveLength(0); // nothing written
	warn.mockRestore();
});

test("remove: removes tagged line from crontab", () => {
	crontab.install(makeCronJob("removeme"));
	expect(crontabContent).toContain("# pi-cron-jobs:removeme");

	crontab.remove("removeme");
	expect(crontabContent).not.toContain("# pi-cron-jobs:removeme");
});

test("remove: preserves other jobs when removing one", () => {
	crontab.install(makeCronJob("keep-me"));
	crontab.install(makeCronJob("remove-me"));

	crontab.remove("remove-me");

	expect(crontabContent).toContain("# pi-cron-jobs:keep-me");
	expect(crontabContent).not.toContain("# pi-cron-jobs:remove-me");
});

test("remove: is a no-op when job is not in crontab", () => {
	execSyncMock.mockClear();
	crontab.remove("nonexistent");
	// writeCrontab should not have been called
	expect(execSyncCalls.filter((c) => c.includes("| crontab -"))).toHaveLength(0);
});

test("sync: installs enabled jobs and removes stale ones", () => {
	// Pre-populate crontab with a stale job
	crontab.install(makeCronJob("stale-job"));
	expect(crontabContent).toContain("# pi-cron-jobs:stale-job");

	const result = crontab.sync([makeCronJob("new-job")]);

	expect(result.installed).toContain("new-job");
	expect(result.removed).toContain("stale-job");
	expect(crontabContent).toContain("# pi-cron-jobs:new-job");
	expect(crontabContent).not.toContain("# pi-cron-jobs:stale-job");
});

test("sync: skips disabled jobs", () => {
	const disabled = { ...makeCronJob("disabled-job"), enabled: false };
	const result = crontab.sync([disabled]);

	expect(result.installed).not.toContain("disabled-job");
	expect(crontabContent).not.toContain("# pi-cron-jobs:disabled-job");
});

test("sync: returns empty arrays when nothing to do", () => {
	crontab.install(makeCronJob("my-job"));
	const result = crontab.sync([makeCronJob("my-job")]);

	// reinstall is fine, but nothing is in removed
	expect(result.removed).toHaveLength(0);
	expect(result.installed).toContain("my-job");
});

test("status: loaded=true for job present in crontab", () => {
	const job = makeCronJob("tracked");
	crontab.install(job);

	const entries = crontab.status([job]);
	expect(entries).toHaveLength(1);
	expect(entries[0]!.loaded).toBe(true);
	expect(entries[0]!.plistExists).toBe(false); // N/A on Linux
});

test("status: loaded=false for job absent from crontab", () => {
	const entries = crontab.status([makeCronJob("missing")]);
	expect(entries[0]!.loaded).toBe(false);
});

test("status: mixed present and absent jobs", () => {
	crontab.install(makeCronJob("present"));

	const entries = crontab.status([makeCronJob("present"), makeCronJob("absent")]);
	expect(entries.find((e) => e.jobId === "present")!.loaded).toBe(true);
	expect(entries.find((e) => e.jobId === "absent")!.loaded).toBe(false);
});
