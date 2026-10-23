import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyStderr, interruptKind } from "../src/core/outcome";
import { waitForNetwork } from "../src/core/network";
import type { Execution } from "../src/core/types";

// ---- stderr classification, against stderr captured from real failed runs ----

const INVALID_GRANT = `Warning: No project session found with id 'x'; creating a new session with that id.
OAuth refresh failed for anthropic: Anthropic token refresh request failed. url=https://platform.claude.com/v1/oauth/token; details=Error: HTTP request failed. status=400; url=https://platform.claude.com/v1/oauth/token; body={"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}`;

const DNS_DOWN = `OAuth refresh failed for anthropic: Anthropic token refresh request failed. url=https://platform.claude.com/v1/oauth/token; details=TypeError: fetch failed; cause=Error: getaddrinfo ENOTFOUND platform.claude.com; code=ENOTFOUND; errno=-3008`;

const CONNECTION_ERROR = `Warning: No project session found with id 'x'; creating a new session with that id.\nConnection error.\n`;

test("invalid_grant is an auth failure naming the provider", () => {
	const c = classifyStderr(INVALID_GRANT);
	expect(c?.kind).toBe("auth");
	expect(c?.detail).toContain("anthropic");
	expect(c?.detail).toContain("invalid_grant");
});

test("DNS failure during OAuth refresh is offline, not auth", () => {
	expect(classifyStderr(DNS_DOWN)?.kind).toBe("offline");
});

test("SDK 'Connection error.' is offline", () => {
	expect(classifyStderr(CONNECTION_ERROR)?.kind).toBe("offline");
});

test("unrelated crash is left unclassified", () => {
	expect(classifyStderr("Error: This extension ctx is stale after session replacement")).toBeNull();
	expect(classifyStderr("")).toBeNull();
});

// ---- interruptKind ----

function skip(reason: string): Execution {
	return { jobId: "j", executionId: "e", sessionId: "s", startedAt: "", status: "skipped", reason, logPath: "" };
}

test("interruptKind maps reason prefixes", () => {
	expect(interruptKind(skip("dark wake — capabilities 0x9"))).toBe("asleep");
	expect(interruptKind(skip("slept during run — ~15m asleep"))).toBe("asleep");
	expect(interruptKind(skip("offline — connection error"))).toBe("offline");
	expect(interruptKind(skip("job disabled"))).toBeNull();
	expect(interruptKind({ ...skip("offline"), status: "failure" })).toBeNull();
});

// ---- network preflight ----

test("waitForNetwork succeeds once the probe connects", async () => {
	let calls = 0;
	const s = await waitForNetwork({
		host: "h",
		intervalMs: 1,
		maxWaitMs: 1000,
		probe: async () => (++calls < 3 ? "ENOTFOUND" : null),
	});
	expect(s.online).toBe(true);
	expect(calls).toBe(3);
});

test("waitForNetwork gives up after maxWaitMs and reports the last error", async () => {
	const s = await waitForNetwork({ host: "h", intervalMs: 5, maxWaitMs: 20, probe: async () => "ENOTFOUND" });
	expect(s.online).toBe(false);
	expect(s.detail).toContain("ENOTFOUND");
});

test("PI_CRON_JOBS_NET_HOST=off disables the check", async () => {
	const s = await waitForNetwork({ host: "off", probe: async () => "never called" });
	expect(s.online).toBe(true);
});

// ---- runJob end to end, in a subprocess with its own store ----

const DRIVER = path.join(import.meta.dir, "fixtures", "run-driver.ts");

function fakePi(dir: string, body: string): string {
	const bin = path.join(dir, "fake-pi");
	writeFileSync(bin, `#!/bin/sh\n${body}\n`);
	chmodSync(bin, 0o755);
	return bin;
}

function drive(env: Record<string, string>): Execution {
	const dir = mkdtempSync(path.join(tmpdir(), "pcj-run-"));
	const piBody = env.PI_BODY ?? "exit 0";
	const res = spawnSync(process.execPath, [DRIVER], {
		encoding: "utf8",
		env: { ...process.env, ...env, PI_CRON_JOBS_DIR: dir, DRIVER_PI_BIN: fakePi(dir, piBody) },
	});
	if (res.status !== 0) throw new Error(`driver failed: ${res.stderr}`);
	return JSON.parse(res.stdout.trim().split("\n").pop()!);
}

test("no network at launch: skipped as offline, pi never spawned", () => {
	const e = drive({ DRIVER_NET: "offline", PI_BODY: "echo SPAWNED >&2; exit 1" });
	expect(e.status).toBe("skipped");
	expect(e.reason).toStartWith("offline");
});

test("network lost mid-run: skipped as offline", () => {
	const e = drive({ PI_BODY: "echo 'Connection error.' >&2; exit 1" });
	expect(e.status).toBe("skipped");
	expect(e.reason).toStartWith("offline");
	expect(e.reason).toContain("exited 1");
});

test("invalid_grant: recorded as a failure with the auth reason", () => {
	const e = drive({
		PI_BODY: `echo 'OAuth refresh failed for anthropic: ... body={"error": "invalid_grant"}' >&2; exit 1`,
	});
	expect(e.status).toBe("failure");
	expect(e.reason).toContain("invalid_grant");
	expect(e.reason).toContain("/login");
});

test("unclassified crash stays a plain failure", () => {
	const e = drive({ PI_BODY: "echo boom >&2; exit 1" });
	expect(e.status).toBe("failure");
	expect(e.reason).toBe("exited 1 with no status marker");
});

test("marker still wins over stderr noise", () => {
	const e = drive({ PI_BODY: "echo 'Connection error.' >&2; echo 'PI_JOB_STATUS: success'; exit 0" });
	expect(e.status).toBe("success");
});

test("a hung run is still killed by the (awake-time) timeout", () => {
	const e = drive({ DRIVER_TIMEOUT_MS: "300", PI_BODY: "exec sleep 10" });
	expect(e.status).toBe("timeout");
	expect(e.reason).toContain("300ms");
});
