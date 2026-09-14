import { expect, test } from "bun:test";
import * as paths from "../src/core/paths";
import { buildPiArgs } from "../src/core/run";
import type { Job } from "../src/core/types";

const job: Job = {
	id: "example",
	name: "Example",
	prompt: "Do the thing",
	schedule: { kind: "cron", expr: "0 9 * * *" },
	cwd: "/tmp",
	threadMode: "per-execution",
	enabled: true,
	createdAt: "2026-01-01T00:00:00.000Z",
	timeoutMs: 600_000,
};

test("stores cron conversations outside pi's default session directory", () => {
	const args = buildPiArgs(job, "example__execution", new Date("2026-01-02T03:04:00Z"));

	expect(args.slice(0, 5)).toEqual([
		"--print",
		"--session-dir",
		paths.sessionsDir,
		"--session-id",
		"example__execution",
	]);
});
