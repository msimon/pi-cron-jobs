// DarkWake detection.
//
// macOS fires missed `StartCalendarInterval` jobs during a DarkWake (Power Nap)
// maintenance window, which lasts ~45 seconds before the machine returns to
// 'Maintenance Sleep'. A job launched there gets a couple of minutes of CPU
// dribbled across 15-minute DarkWakes while the wrapper's wall-clock timeout
// keeps running, so it is killed having done almost nothing. Those runs are not
// failures -- the machine was asleep -- so we record them as `skipped`.
//
// `IOPMUserTriggeredFullWake` on IOPMrootDomain is the signal: "Yes" on a real
// user wake, "No" in DarkWake. `ioreg` returns in milliseconds, unlike
// `pmset -g log` which has to parse days of history.
//
// Every failure path here fails OPEN (treat as a normal wake and run the job):
// wrongly skipping a run is worse than wrongly running one.

import { execFileSync } from "node:child_process";

export const DARK_WAKE_REASON_PREFIX = "dark wake";

export interface WakeState {
	darkWake: boolean;
	detail: string;
}

// Pure so it can be tested against captured ioreg output.
export function parseWakeState(ioregOutput: string): WakeState {
	const full = /"IOPMUserTriggeredFullWake"\s*=\s*(Yes|No)/.exec(ioregOutput);
	if (!full) {
		// Key missing (older/newer macOS, or not a laptop): assume a real wake.
		return { darkWake: false, detail: "IOPMUserTriggeredFullWake not reported" };
	}
	if (full[1] === "Yes") {
		const type = /"Wake Type"\s*=\s*"([^"]*)"/.exec(ioregOutput)?.[1];
		return { darkWake: false, detail: type ? `full wake (${type})` : "full wake" };
	}
	const lastSleep = /"Last Sleep Reason"\s*=\s*"([^"]*)"/.exec(ioregOutput)?.[1];
	return {
		darkWake: true,
		detail: lastSleep ? `last sleep: ${lastSleep}` : "no user-triggered full wake",
	};
}

export function detectWakeState(): WakeState {
	if (process.platform !== "darwin") {
		return { darkWake: false, detail: "not macOS" };
	}
	try {
		const out = execFileSync("ioreg", ["-n", "IOPMrootDomain", "-r", "-d", "1"], {
			encoding: "utf8",
			timeout: 5000,
		});
		return parseWakeState(out);
	} catch (err: unknown) {
		return { darkWake: false, detail: `ioreg probe failed: ${String(err)}` };
	}
}
