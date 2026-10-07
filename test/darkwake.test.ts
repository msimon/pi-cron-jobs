import { test, expect } from "bun:test";
import { parseWakeState, DARK_WAKE_REASON_PREFIX } from "../src/core/darkwake";

// Real `ioreg -n IOPMrootDomain -r -d 1` output, 2026-10-07 11:19, Mac fully
// awake and in use. IOPMUserTriggeredFullWake reads "No" here, which made the
// old check skip manual runs as dark wake.
const FULL_WAKE = `
      "Wake Type" = "UserActivity Assertion"
      "IOPMUserTriggeredFullWake" = No
      "System Capabilities" = 15
      "Last Sleep Reason" = "Maintenance Sleep"
`;

// DarkWake: CPU + Network only, no Graphics. IOPMUserTriggeredFullWake is a
// stale "Yes" left over from the last user wake, which made the old check run
// jobs that then died when the Mac went back to sleep.
const DARK_WAKE = `
      "Wake Type" = "Maintenance"
      "IOPMUserTriggeredFullWake" = Yes
      "System Capabilities" = 9
      "Last Sleep Reason" = "Maintenance Sleep"
`;

test("fully awake Mac is not dark wake, even when IOPMUserTriggeredFullWake is No", () => {
	const s = parseWakeState(FULL_WAKE);
	expect(s.darkWake).toBe(false);
	expect(s.detail).toContain("0xf");
});

test("dark wake is detected from missing graphics, ignoring a stale user-wake flag", () => {
	const s = parseWakeState(DARK_WAKE);
	expect(s.darkWake).toBe(true);
	expect(s.detail).toContain("0x9");
	expect(s.detail).toContain("Maintenance Sleep");
});

test("fails open when System Capabilities is absent", () => {
	const s = parseWakeState(`"Wake Type" = "Maintenance"\n"IOPMUserTriggeredFullWake" = No`);
	expect(s.darkWake).toBe(false);
	expect(s.detail).toContain("not reported");
});

test("fails open on empty output", () => {
	expect(parseWakeState("").darkWake).toBe(false);
});

test("skip reason carries the prefix the extension matches on", () => {
	const s = parseWakeState(DARK_WAKE);
	const reason = `${DARK_WAKE_REASON_PREFIX} — ${s.detail}`;
	expect(reason.startsWith(DARK_WAKE_REASON_PREFIX)).toBe(true);
});
