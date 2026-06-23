// Id + slug helpers.

import { randomBytes } from "node:crypto";
import type { Job } from "./types";

export function slugify(input: string): string {
	return input
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48) || "job";
}

// Sortable, filesystem-safe, unique-per-firing id: ISO timestamp + short random.
export function newExecutionId(now: Date = new Date()): string {
	const ts = now.toISOString().replace(/[:.]/g, "-");
	const rand = randomBytes(3).toString("hex");
	return `${ts}-${rand}`;
}

// per-execution => fresh thread each run; continuous => one growing thread.
export function sessionIdFor(job: Job, executionId: string): string {
	return job.threadMode === "continuous" ? job.id : `${job.id}__${executionId}`;
}
