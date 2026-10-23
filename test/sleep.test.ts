import { expect, test } from "bun:test";
import { AwakeClock, fmtDuration } from "../src/core/sleep";
import { deriveOutcome } from "../src/core/run";

// ---- AwakeClock ----

test("regular ticks count as awake time", () => {
	const c = new AwakeClock(0, 5_000, 30_000);
	for (let t = 5_000; t <= 60_000; t += 5_000) expect(c.tick(t)).toBe(0);
	expect(c.slept).toBe(0);
	expect(c.awakeMs(60_000)).toBe(60_000);
});

test("a long gap between ticks is subtracted as sleep", () => {
	// Mirrors 2026-10-19 standup-extract-pm: alive at +79s, next tick at +1234s.
	const c = new AwakeClock(0, 5_000, 30_000);
	for (let t = 5_000; t <= 75_000; t += 5_000) c.tick(t);
	const nap = c.tick(1_234_000);
	expect(nap).toBe(1_234_000 - 75_000 - 5_000);
	expect(c.napCount).toBe(1);
	expect(c.awakeMs(1_234_000)).toBe(80_000);
});

test("a slow but awake tick is not sleep", () => {
	const c = new AwakeClock(0, 5_000, 30_000);
	expect(c.tick(25_000)).toBe(0);
});

test("fmtDuration", () => {
	expect(fmtDuration(42_000)).toBe("42s");
	expect(fmtDuration(15 * 60_000)).toBe("15m");
	expect(fmtDuration(125 * 60_000)).toBe("2h05");
});

// ---- deriveOutcome precedence ----

const base = { exitCode: 1, timedOut: false, stdout: "", stderr: "", sleptMs: 0 };

test("timeout without sleep is a timeout", () => {
	expect(deriveOutcome({ ...base, timedOut: true, exitCode: 143 }, 1000).status).toBe("timeout");
});

test("timeout after sleeping is a slept skip", () => {
	const o = deriveOutcome({ ...base, timedOut: true, exitCode: 143, sleptMs: 900_000 }, 1000);
	expect(o.status).toBe("skipped");
	expect(o.reason).toStartWith("slept during run");
	expect(o.reason).toContain("15m");
});

test("crash after sleeping with a connection error is a slept skip", () => {
	const o = deriveOutcome({ ...base, sleptMs: 341_000, stderr: "Connection error.\n" }, 1000);
	expect(o.status).toBe("skipped");
	expect(o.reason).toStartWith("slept during run");
	expect(o.reason).toContain("connection error");
});

test("invalid_grant stays a failure even if the Mac slept", () => {
	const o = deriveOutcome({ ...base, sleptMs: 60_000, stderr: 'body={"error": "invalid_grant"}' }, 1000);
	expect(o.status).toBe("failure");
	expect(o.reason).toContain("invalid_grant");
});

test("a marker wins over sleep", () => {
	const o = deriveOutcome(
		{ ...base, exitCode: 0, sleptMs: 60_000, stdout: "done\nPI_JOB_STATUS: failure - no room\n" },
		1000,
	);
	expect(o.status).toBe("failure");
	expect(o.reason).toBe("no room");
});

test("offline without sleep is an offline skip", () => {
	const o = deriveOutcome({ ...base, stderr: "getaddrinfo ENOTFOUND platform.claude.com" }, 1000);
	expect(o.status).toBe("skipped");
	expect(o.reason).toStartWith("offline");
});
