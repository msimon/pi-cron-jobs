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

// When a run should get your attention:
//   failure — only when it fails (or is skipped by sleep / no network)
//   always  — every run that actually ran
//   review  — only when the agent asks for it with a PI_JOB_REVIEW line
// Default: "failure" for cron jobs, "always" for one-shots (see notifyPolicy).
export type NotifyPolicy = "failure" | "always" | "review";

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
	flags?: string[] | null;       // extra CLI flags passed verbatim to the pi invocation (e.g. ["--loadout", "withBrowser"])
	enabled: boolean;
	createdAt: string;
	maxRuns?: number | null; // optional cap on total executions
	timeoutMs: number; // wall-clock per execution
	completedAt?: string | null; // one-shot jobs: when it fired; unscheduled, kept for /jobs, pruned after 30 days
	notify?: NotifyPolicy | null; // unset = default for the schedule kind
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
	// Set when the run wants your attention (PI_JOB_REVIEW, or every run of an
	// "always" job). Listed under /jobs → To review until marked done.
	review?: string | null;
	action?: string | null; // PI_JOB_ACTION: prompt sent by "Run action"
}

export interface AppState {
	lastSeenTs?: string; // ISO of the most recent execution the extension has shown
	ignoredExecutionIds?: string[]; // executions acknowledged by hand; excluded from failure counts
	reviewDoneIds?: string[]; // review items marked done (by hand or cron_review_done)
}
