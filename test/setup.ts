// Preloaded before every test file (bunfig.toml).
//
// bun shares one module registry across test files, so `paths.root` is fixed
// by whichever file imports it first. A test that imports src/ statically
// before extension.test.ts set PI_CRON_JOBS_DIR once pointed the store at the
// real ~/.pi/cron-jobs and overwrote jobs.json (2026-10-23). Point it at a
// temp dir before anything can load.

import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const real = path.join(homedir(), ".pi", "cron-jobs");
if (!process.env.PI_CRON_JOBS_DIR || path.resolve(process.env.PI_CRON_JOBS_DIR) === real) {
	process.env.PI_CRON_JOBS_DIR = mkdtempSync(path.join(tmpdir(), "pcj-test-"));
}
