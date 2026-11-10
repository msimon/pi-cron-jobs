import { expect, test } from "bun:test";
import { expiredCompletedJobs, filterJobs, isScheduled } from "../src/core/jobs";
import type { Job } from "../src/core/types";

const job = (id: string, extra: Partial<Job> = {}): Job => ({
	id,
	name: id,
	prompt: "x",
	schedule: { kind: "cron", expr: "0 9 * * *" },
	cwd: "/tmp",
	threadMode: "per-execution",
	enabled: true,
	createdAt: "2026-01-01T00:00:00Z",
	timeoutMs: 600_000,
	...extra,
});
const once = (id: string, extra: Partial<Job> = {}) =>
	job(id, { schedule: { kind: "once", at: "2026-11-11T12:00:00" }, ...extra });

test("isScheduled: enabled and not completed", () => {
	expect(isScheduled(job("a"))).toBe(true);
	expect(isScheduled(job("a", { enabled: false }))).toBe(false);
	expect(isScheduled(once("b"))).toBe(true);
	expect(isScheduled(once("b", { completedAt: "2026-11-11T12:01:00Z" }))).toBe(false);
});

test("filterJobs: scheduled = cron, one-time = every once job, all = everything", () => {
	const jobs = [job("cron"), once("upcoming"), once("done", { completedAt: "2026-11-11T12:01:00Z" })];
	expect(filterJobs(jobs, "scheduled").map((j) => j.id)).toEqual(["cron"]);
	expect(filterJobs(jobs, "one-time").map((j) => j.id)).toEqual(["upcoming", "done"]);
	expect(filterJobs(jobs, "all").map((j) => j.id)).toEqual(["cron", "upcoming", "done"]);
});

test("expiredCompletedJobs: only completed jobs older than 30 days", () => {
	const now = new Date("2026-12-31T00:00:00Z");
	const jobs = [
		job("cron"),
		once("upcoming"),
		once("recent", { completedAt: "2026-12-15T00:00:00Z" }),
		once("old", { completedAt: "2026-11-01T00:00:00Z" }),
	];
	expect(expiredCompletedJobs(jobs, now).map((j) => j.id)).toEqual(["old"]);
});
