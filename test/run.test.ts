import { expect, test } from "bun:test";
import * as paths from "../src/core/paths";
import { buildPiArgs, deriveReview } from "../src/core/run";
import type { Job } from "../src/core/types";

const job: Job = {
	id: "example",
	name: "Example",
	prompt: "Do the thing",
	schedule: { kind: "cron", expr: "0 9 * * *" },
	cwd: "/tmp",
	threadMode: "per-execution",
	enabled: true,
	createdAt: "2026-01-01T00:00:00.000Z",
	timeoutMs: 600_000,
};

test("stores cron conversations outside pi's default session directory", () => {
	const args = buildPiArgs(job, "example__execution", new Date("2026-01-02T03:04:00Z"));

	expect(args.slice(0, 5)).toEqual([
		"--print",
		"--session-dir",
		paths.sessionsDir,
		"--session-id",
		"example__execution",
	]);
});

test("review / always jobs get the review instruction; failure jobs do not", () => {
	const count = (j: Job) => buildPiArgs(j, "s").filter((a) => a.includes("PI_JOB_REVIEW")).length;
	expect(count(job)).toBe(0);
	expect(count({ ...job, notify: "review" })).toBe(1);
	expect(count({ ...job, schedule: { kind: "once", at: "2026-11-11T12:00:00" } })).toBe(1); // one-shot default: always
});

test("deriveReview follows the notify setting", () => {
	const ok = { status: "success" as const, reason: null, warning: false };
	const out = "done\nPI_JOB_REVIEW: 3 emails to answer\nPI_JOB_ACTION: Open x in Plannotator\nPI_JOB_STATUS: success";
	expect(deriveReview(job, ok, out)).toEqual({ review: null, action: null }); // failure policy
	const review = { ...job, notify: "review" as const };
	expect(deriveReview(review, ok, out)).toEqual({ review: "3 emails to answer", action: "Open x in Plannotator" });
	expect(deriveReview(review, ok, "PI_JOB_STATUS: success")).toEqual({ review: null, action: null });
	expect(deriveReview(review, { ...ok, status: "failure" }, out)).toEqual({ review: null, action: null });
	const always = { ...job, notify: "always" as const };
	expect(deriveReview(always, ok, "PI_JOB_STATUS: success").review).toBe("ran — success");
});
