// Job lifecycle helpers shared by the CLI, the schedulers and the extension.
//
// A one-shot (`--at`) job is not deleted after it fires: it is unscheduled and
// stamped with `completedAt`, so it stays visible in /jobs (with its runs and
// conversations) until it is pruned COMPLETED_RETENTION_MS later.

import type { Job } from "./types";

export const COMPLETED_RETENTION_MS = 30 * 24 * 3600_000;

// A job the OS scheduler should fire: enabled and not a finished one-shot.
export function isScheduled(job: Job): boolean {
	return job.enabled && !job.completedAt;
}

export function isCompleted(job: Job): boolean {
	return !!job.completedAt;
}

// Finished one-shots older than the retention window.
export function expiredCompletedJobs(
	jobs: Job[],
	now: Date = new Date(),
	maxAgeMs: number = COMPLETED_RETENTION_MS,
): Job[] {
	return jobs.filter((j) => {
		if (!j.completedAt) return false;
		const t = Date.parse(j.completedAt);
		return !Number.isNaN(t) && now.getTime() - t > maxAgeMs;
	});
}

// /jobs filter tabs. "scheduled" = recurring cron jobs, "one-time" = every
// `--at` job (upcoming and done), "all" = everything.
export type JobTab = "scheduled" | "one-time" | "all";

export const JOB_TABS: ReadonlyArray<{ id: JobTab; title: string }> = [
	{ id: "scheduled", title: "Scheduled" },
	{ id: "one-time", title: "One-time" },
	{ id: "all", title: "All" },
];

export function filterJobs(jobs: Job[], tab: JobTab): Job[] {
	if (tab === "scheduled") return jobs.filter((j) => j.schedule.kind === "cron");
	if (tab === "one-time") return jobs.filter((j) => j.schedule.kind === "once");
	return jobs;
}
