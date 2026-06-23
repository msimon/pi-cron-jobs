// Scheduler dispatcher — launchd on macOS, crontab on Linux.

import type { Job } from "../core/types";
import type { SchedulerEntry } from "./launchd";

export type Scheduler = {
	install: (job: Job) => void;
	remove: (jobId: string) => void;
	sync: (jobs: Job[]) => { installed: string[]; removed: string[] };
	status: (jobs: Job[]) => SchedulerEntry[];
	resolveBinPath: () => string;
};

// Eagerly resolved so callers can await once at startup.
export async function getScheduler(): Promise<Scheduler> {
	if (process.platform === "darwin") {
		return await import("./launchd");
	}
	return await import("./crontab");
}
