// Classifying runs that did not finish for reasons outside the job itself.
//
// Some failures are the machine's fault, not the job's: the Mac was in a
// DarkWake, had no network yet after waking, or went to sleep mid-run. Those
// are recorded as `skipped` with a reason prefix the extension matches on, so
// they show up as "did not run" (retryable, dismissible) instead of failures.
//
// An expired or revoked login is the opposite: it will keep failing until you
// log in again, so it stays a failure with a reason that says what to do.

import { DARK_WAKE_REASON_PREFIX } from "./darkwake";
import type { Execution } from "./types";

export const OFFLINE_REASON_PREFIX = "offline";
export const SLEPT_REASON_PREFIX = "slept during run";

export type InterruptKind = "asleep" | "offline";

// Why a skipped run did not happen, or null for an ordinary skip (disabled,
// overlap, maxRuns) or any non-skipped run.
export function interruptKind(e: Execution | undefined): InterruptKind | null {
	if (!e || e.status !== "skipped") return null;
	const r = e.reason ?? "";
	if (r.startsWith(DARK_WAKE_REASON_PREFIX) || r.startsWith(SLEPT_REASON_PREFIX)) return "asleep";
	if (r.startsWith(OFFLINE_REASON_PREFIX)) return "offline";
	return null;
}

export type StderrClass = { kind: "auth" | "offline"; detail: string };

// Network errors as pi and Node print them. "Connection error." is the
// Anthropic SDK's message when the request never got a response.
const OFFLINE_PATTERNS: Array<[RegExp, string]> = [
	[/\bENOTFOUND\b/, "DNS lookup failed (ENOTFOUND)"],
	[/\bEAI_AGAIN\b/, "DNS lookup failed (EAI_AGAIN)"],
	[/\bENETUNREACH\b/, "network unreachable"],
	[/\bEHOSTUNREACH\b/, "host unreachable"],
	[/\bENETDOWN\b/, "network down"],
	[/^Connection error\.?\s*$/m, "connection error"],
	[/\bfetch failed\b/, "fetch failed"],
];

// Inspect a run's stderr after it exited non-zero without a status marker.
// Auth wins over offline: an `invalid_grant` is a real, persistent failure.
export function classifyStderr(stderr: string): StderrClass | null {
	if (/\binvalid_grant\b/.test(stderr)) {
		const provider = /OAuth refresh failed for (\w+)/.exec(stderr)?.[1] ?? "provider";
		return {
			kind: "auth",
			detail: `auth failed — ${provider} OAuth invalid_grant; log in again in pi (/login)`,
		};
	}
	for (const [re, detail] of OFFLINE_PATTERNS) {
		if (re.test(stderr)) return { kind: "offline", detail };
	}
	return null;
}
