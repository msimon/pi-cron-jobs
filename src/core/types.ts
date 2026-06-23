// Core data types for pi-cron-jobs.
// Written as "erasable" TypeScript (string unions, no enums) so Node can run it
// directly via type-stripping with no build step.

export type ScheduleCron = {
	kind: "cron";
	expr: string; // 5-field POSIX cron, e.g. "0 9 * * 1-5"
	tz?: string; // IANA tz, e.g. "Europe/Paris"
};

export type ScheduleOnce = {
	kind: "once";
	at: string; // ISO-8601 timestamp
};

export type Schedule = ScheduleCron | ScheduleOnce;

export type ThreadMode = "per-execution" | "continuous";

export type ExecutionStatus =
	| "running"
	| "success"
	| "failure"
	| "timeout"
	| "skipped";

export interface Job {
	id: string; // stable slug; also seeds the session id
	name: string;
	prompt: string;
	schedule: Schedule;
	cwd: string; // where the headless run fires (drives AGENTS.md/context)
	model?: string | null; // optional model override
	threadMode: ThreadMode; // per-execution (default) | continuous
	isolate?: boolean; // true => --no-extensions
	tools?: string[] | null; // optional --tools allowlist
	excludeTools?: string[] | null; // optional --exclude-tools denylist
	enabled: boolean;
	createdAt: string;
	maxRuns?: number | null; // optional cap on total executions
	timeoutMs: number; // wall-clock per execution
}

export interface Execution {
	jobId: string;
	executionId: string;
	sessionId: string; // this execution's own conversation
	startedAt: string;
	endedAt?: string | null;
	exitCode?: number | null;
	status: ExecutionStatus;
	reason?: string | null; // marker reason on failure ("no room available")
	warning?: boolean; // marker=success but process exited non-zero
	logPath: string;
}

export interface AppState {
	lastSeenTs?: string; // ISO of the most recent execution the extension has shown
}
