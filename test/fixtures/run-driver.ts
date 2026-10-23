// Runs one runJob() in a separate process so the test gets its own
// PI_CRON_JOBS_DIR (bun shares one module registry across test files, so
// paths.root is fixed by whichever file imports it first).
//
// env: PI_CRON_JOBS_DIR (required), DRIVER_PI_BIN, DRIVER_NET=online|offline,
//      DRIVER_TIMEOUT_MS. Prints the resulting Execution as JSON.

import * as store from "../../src/core/store";
import { runJob } from "../../src/core/run";

store.writeJobs([
	{
		id: "drv",
		name: "Driver",
		prompt: "x",
		schedule: { kind: "cron", expr: "0 9 * * *" },
		cwd: process.env.PI_CRON_JOBS_DIR!,
		threadMode: "per-execution",
		enabled: true,
		createdAt: "2026-01-01T00:00:00Z",
		timeoutMs: Number(process.env.DRIVER_TIMEOUT_MS ?? 30_000),
	},
]);

const online = (process.env.DRIVER_NET ?? "online") === "online";
const exec = await runJob("drv", {
	piBin: process.env.DRIVER_PI_BIN,
	wakeCheck: () => ({ darkWake: false, detail: "test wake" }),
	networkCheck: async () => ({
		online,
		detail: online ? "test reachable" : "api.example:443 unreachable for 90s",
	}),
});
console.log(JSON.stringify(exec));
