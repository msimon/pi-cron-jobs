// Global storage layout. Everything lives under ~/.pi/cron-jobs/ (overridable
// via PI_CRON_JOBS_DIR for tests).

import os from "node:os";
import path from "node:path";

export const root: string =
	process.env.PI_CRON_JOBS_DIR ?? path.join(os.homedir(), ".pi", "cron-jobs");

export const jobsFile = path.join(root, "jobs.json");
export const executionsFile = path.join(root, "executions.jsonl");
export const stateFile = path.join(root, "state.json");
export const logsDir = path.join(root, "logs");
export const launchdDir = path.join(root, "launchd");

export function logFile(jobId: string, executionId: string): string {
	return path.join(logsDir, jobId, `${executionId}.log`);
}
