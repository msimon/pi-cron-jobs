import { test, expect } from "bun:test";
import { parseWakeState, DARK_WAKE_REASON_PREFIX } from "../src/core/darkwake";

// Trimmed from real `ioreg -n IOPMrootDomain -r -d 1` output on a MacBook.
const FULL_WAKE = `
      "Wake Type" = "UserActivity Assertion"
      "IOPMUserTriggeredFullWake" = Yes
      "AppleClamshellState" = No
      "Last Sleep Reason" = "Maintenance Sleep"
`;

const DARK_WAKE = `
      "Wake Type" = "Maintenance"
      "IOPMUserTriggeredFullWake" = No
      "AppleClamshellState" = Yes
      "Last Sleep Reason" = "Maintenance Sleep"
`;

test("full wake is not dark wake", () => {
	const s = parseWakeState(FULL_WAKE);
	expect(s.darkWake).toBe(false);
	expect(s.detail).toContain("UserActivity Assertion");
});

test("dark wake is detected and reports the last sleep reason", () => {
	const s = parseWakeState(DARK_WAKE);
	expect(s.darkWake).toBe(true);
	expect(s.detail).toContain("Maintenance Sleep");
});

test("fails open when the key is absent", () => {
	const s = parseWakeState(`"Wake Type" = "Maintenance"\n"SleepDisabled" = No`);
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
