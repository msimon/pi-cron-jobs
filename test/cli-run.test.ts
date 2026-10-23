import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dir, "..", "src", "cli.ts");

test("`run a b` runs the jobs one after the other, never overlapping", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pcj-cli-"));
	const trace = path.join(dir, "trace");
	const job = (id: string) => ({
		id,
		name: id,
		prompt: `job ${id}`,
		schedule: { kind: "cron", expr: "0 9 * * *" },
		cwd: dir,
		threadMode: "per-execution",
		enabled: true,
		createdAt: "2026-01-01T00:00:00Z",
		timeoutMs: 30_000,
	});
	writeFileSync(path.join(dir, "jobs.json"), JSON.stringify([job("a"), job("b")]));

	// fake pi: the prompt is the last arg; log start/end around a short sleep
	const fakePi = path.join(dir, "fake-pi");
	writeFileSync(
		fakePi,
		`#!/bin/sh\nfor last; do :; done\necho "start $last" >> ${JSON.stringify(trace)}\nsleep 0.3\necho "end $last" >> ${JSON.stringify(trace)}\necho 'PI_JOB_STATUS: success'\n`,
	);
	chmodSync(fakePi, 0o755);

	const res = spawnSync(process.execPath, [CLI, "run", "a", "b", "--json"], {
		encoding: "utf8",
		env: { ...process.env, PI_CRON_JOBS_DIR: dir, PI_BIN: fakePi, PI_CRON_JOBS_NET_HOST: "off" },
	});
	expect(res.status).toBe(0);
	const execs = JSON.parse(res.stdout);
	expect(execs.map((e: any) => [e.jobId, e.status])).toEqual([
		["a", "success"],
		["b", "success"],
	]);
	expect(readFileSync(trace, "utf8").trim().split("\n")).toEqual([
		"start job a",
		"end job a",
		"start job b",
		"end job b",
	]);
});

test("`run` with an unknown id fails before running anything", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pcj-cli-"));
	writeFileSync(path.join(dir, "jobs.json"), "[]");
	const res = spawnSync(process.execPath, [CLI, "run", "nope"], {
		encoding: "utf8",
		env: { ...process.env, PI_CRON_JOBS_DIR: dir },
	});
	expect(res.status).toBe(1);
	expect(res.stderr).toContain("no such job: nope");
});
