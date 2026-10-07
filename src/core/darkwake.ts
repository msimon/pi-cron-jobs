// DarkWake detection.
//
// macOS fires missed `StartCalendarInterval` jobs during a DarkWake (Power Nap)
// maintenance window, which lasts ~45 seconds before the machine returns to
// 'Maintenance Sleep'. A job launched there gets a couple of minutes of CPU
// dribbled across 15-minute DarkWakes while the wrapper's wall-clock timeout
// keeps running, so it is killed having done almost nothing. Those runs are not
// failures -- the machine was asleep -- so we record them as `skipped`.
//
// The signal is IOPMrootDomain's "System Capabilities", the live capability
// mask: CPU 0x1, Graphics 0x2, Audio 0x4, Network 0x8. A full wake has
// Graphics, a DarkWake does not (pmset logs them as [CDNVA] vs [CDNP]).
// `ioreg` returns in milliseconds, unlike `pmset -g log` which has to parse
// days of history.
//
// `IOPMUserTriggeredFullWake` is deliberately NOT used: it describes how the
// last full wake started and is sticky across later DarkWakes. It let DarkWake
// launches through (stale "Yes") and blocked runs while the Mac was fully awake
// and in use ("No", 2026-10-07).
//
// Every failure path here fails OPEN (treat as a normal wake and run the job):
// wrongly skipping a run is worse than wrongly running one.

import { execFileSync } from "node:child_process";

export const DARK_WAKE_REASON_PREFIX = "dark wake";

export interface WakeState {
	darkWake: boolean;
	detail: string;
}

const CAP_GRAPHICS = 0x2;

// Pure so it can be tested against captured ioreg output.
export function parseWakeState(ioregOutput: string): WakeState {
	const m = /"System Capabilities"\s*=\s*(\d+)/.exec(ioregOutput);
	if (!m) {
		// Key missing (older/newer macOS): assume a real wake.
		return { darkWake: false, detail: "System Capabilities not reported" };
	}
	const caps = Number(m[1]);
	const hex = `0x${caps.toString(16)}`;
	if (caps & CAP_GRAPHICS) {
		return { darkWake: false, detail: `full wake (capabilities ${hex})` };
	}
	const lastSleep = /"Last Sleep Reason"\s*=\s*"([^"]*)"/.exec(ioregOutput)?.[1];
	return {
		darkWake: true,
		detail: `capabilities ${hex}, no graphics${lastSleep ? `; last sleep: ${lastSleep}` : ""}`,
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
