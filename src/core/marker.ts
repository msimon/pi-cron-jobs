// Closing-block convention: the soft-failure contract, plus (for notify =
// review | always) the review item the run raises.
// The runner appends an instruction telling the agent to end with a closing
// block; we parse the LAST status line from stdout as the authoritative status.

import type { NotifyPolicy } from "./types";

export const MARKER_PREFIX = "PI_JOB_STATUS:";
export const REVIEW_PREFIX = "PI_JOB_REVIEW:";
export const ACTION_PREFIX = "PI_JOB_ACTION:";

const STATUS_RULE =
	`- ${MARKER_PREFIX} mandatory on every run, and always the last line. Emit \`success\` only if the task's goal was actually achieved; \`failure\` if it was not, for ANY reason (missing info, nothing available, a check did not pass, an error, or you could only ask questions).`;

// One instruction, shaped by the job's notify setting (see README).
export function closingInstruction(policy: NotifyPolicy): string {
	const head = [
		"UNATTENDED SCHEDULED MODE: there is NO human to answer questions and there",
		"will be no follow-up turn. Do not ask clarifying questions — act on the",
		"information you have and complete the task as best you can.",
		"",
	];
	const status = `  ${MARKER_PREFIX} success   -- or --   ${MARKER_PREFIX} failure - <short reason>`;
	if (policy === "failure") {
		return [...head, "End your reply with this closing line, with nothing after it:", "", status, "", STATUS_RULE].join("\n");
	}
	const review =
		policy === "review"
			? `  ${REVIEW_PREFIX} <one short line for the user, e.g. "3 items to check">`
			: `  ${REVIEW_PREFIX} <one-line summary of the outcome for the user>`;
	const rules =
		policy === "review"
			? [
					`- ${REVIEW_PREFIX} only when this run produced something the user needs to review, answer or decide. Leave it out otherwise.`,
					`- ${ACTION_PREFIX} optional, and only together with PI_JOB_REVIEW.`,
				]
			: [
					`- ${REVIEW_PREFIX} mandatory when the run succeeded. On failure, leave it out: the failure itself is reported.`,
					`- ${ACTION_PREFIX} optional, only when there is a natural next step for the user.`,
				];
	return [
		...head,
		"End your reply with this closing block, with nothing after it:",
		"",
		review,
		`  ${ACTION_PREFIX} <the exact prompt to run later, in an interactive session, to act on it, on one line>`,
		status,
		"",
		...rules,
		STATUS_RULE,
	].join("\n");
}

export interface ParsedMarker {
	status: "success" | "failure";
	reason: string | null;
}

// Scan from the end for the last line beginning with the marker prefix.
export function parseMarker(stdout: string): ParsedMarker | null {
	const lines = stdout.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]?.trim();
		if (!line || !line.startsWith(MARKER_PREFIX)) continue;
		const rest = line.slice(MARKER_PREFIX.length).trim();
		const lower = rest.toLowerCase();
		if (lower.startsWith("success")) return { status: "success", reason: null };
		if (lower.startsWith("failure")) {
			// reason may follow after "failure", separated by - / : / em-dash / space
			const reason = rest
				.slice("failure".length)
				.replace(/^[\s:\-\u2013\u2014]+/, "")
				.trim();
			return { status: "failure", reason: reason || null };
		}
	}
	return null;
}

// ---- review / action lines ----
export interface ParsedReview {
	review: string | null;
	action: string | null;
}

// The last PI_JOB_REVIEW / PI_JOB_ACTION line of the output, if any.
export function parseReview(stdout: string): ParsedReview {
	const last = (prefix: string): string | null => {
		const lines = stdout.split(/\r?\n/);
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i]?.trim().replace(/^[`*]+|[`*]+$/g, "");
			if (!line?.startsWith(prefix)) continue;
			const value = line.slice(prefix.length).trim();
			return value || null;
		}
		return null;
	};
	const review = last(REVIEW_PREFIX);
	return { review, action: review ? last(ACTION_PREFIX) : null };
}
