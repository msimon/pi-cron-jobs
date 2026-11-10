// Status-marker convention: the soft-failure contract.
// The runner appends an instruction telling the agent to end with a marker line;
// we parse the LAST such line from the run's stdout as the authoritative status.

export const MARKER_PREFIX = "PI_JOB_STATUS:";

export function markerInstruction(): string {
	return [
		"UNATTENDED SCHEDULED MODE: there is NO human to answer questions and there",
		"will be no follow-up turn. Do not ask clarifying questions — act on the",
		"information you have and complete the task as best you can.",
		"",
		"You MUST end your reply with EXACTLY one final line, with nothing after it:",
		`  ${MARKER_PREFIX} success`,
		"  -- or --",
		`  ${MARKER_PREFIX} failure - <short reason>`,
		"",
		"Emit `success` only if the task's goal was actually achieved. Emit `failure`",
		"if it was not achieved for ANY reason (missing info, nothing available, a",
		"check did not pass, an error, or you could only ask questions). This final",
		"status line is mandatory on every run.",
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

// ---- review / action markers (jobs with notify = review | always) ----

export const REVIEW_PREFIX = "PI_JOB_REVIEW:";
export const ACTION_PREFIX = "PI_JOB_ACTION:";

export function reviewInstruction(policy: "review" | "always"): string {
	const when =
		policy === "review"
			? "If this run produced something the user needs to review, answer or decide,"
			: "Summarise the outcome for the user:";
	return [
		`${when} put these lines just BEFORE the final status line:`,
		`  ${REVIEW_PREFIX} <one short line, e.g. "3 emails to answer">`,
		`  ${ACTION_PREFIX} <optional: the exact prompt to run later, in an interactive`,
		"    session, to act on it, e.g. \"Open ~/x/review.md in Plannotator, following",
		"    the email-review skill step 5.\" -- on one line>",
		policy === "review"
			? `Omit both lines when nothing needs the user. ${ACTION_PREFIX} without ${REVIEW_PREFIX} is ignored.`
			: `${ACTION_PREFIX} is optional.`,
	].join("\n");
}

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
