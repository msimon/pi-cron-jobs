import { test, expect } from "bun:test";
import { expandCron, onceInterval } from "../src/scheduler/cron";

test("every minute -> single empty dict", () => {
	expect(expandCron("* * * * *").intervals).toEqual([{}]);
});

test("weekday 9am -> 5 dicts", () => {
	const { intervals } = expandCron("0 9 * * 1-5");
	expect(intervals).toHaveLength(5);
	expect(intervals[0]).toEqual({ Minute: 0, Hour: 9, Weekday: 1 });
	expect(intervals[4]).toEqual({ Minute: 0, Hour: 9, Weekday: 5 });
});

test("step minutes -> 12 dicts", () => {
	const { intervals } = expandCron("*/5 * * * *");
	expect(intervals).toHaveLength(12);
	expect(intervals[0]).toEqual({ Minute: 0 });
	expect(intervals[1]).toEqual({ Minute: 5 });
});

test("list of hours", () => {
	const { intervals } = expandCron("30 8,12,18 * * *");
	expect(intervals.map((i) => i.Hour)).toEqual([8, 12, 18]);
	expect(intervals.every((i) => i.Minute === 30)).toBe(true);
});

test("weekday 7 normalized to 0 (Sunday)", () => {
	expect(expandCron("0 0 * * 7").intervals).toEqual([{ Minute: 0, Hour: 0, Weekday: 0 }]);
});

test("dom + dow conflict flagged", () => {
	expect(expandCron("0 0 1 * 1").domDowConflict).toBe(true);
	expect(expandCron("0 0 1 * *").domDowConflict).toBe(false);
});

test("rejects wrong field count", () => {
	expect(() => expandCron("* * * *")).toThrow();
});

test("rejects out-of-range", () => {
	expect(() => expandCron("99 * * * *")).toThrow();
});

test("rejects explosive expansion", () => {
	// every minute of every hour with explicit lists would blow up; use a big product
	expect(() => expandCron("0-59 0-23 * * *")).toThrow();
});

test("onceInterval maps fields", () => {
	const i = onceInterval("2026-07-01T09:05:00");
	expect(i.Month).toBe(7);
	expect(i.Day).toBe(1);
	expect(i.Hour).toBe(9);
	expect(i.Minute).toBe(5);
});
