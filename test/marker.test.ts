import { test, expect } from "bun:test";
import { parseMarker } from "../src/core/marker";

test("parses success", () => {
	expect(parseMarker("did stuff\nPI_JOB_STATUS: success")).toEqual({
		status: "success",
		reason: null,
	});
});

test("parses failure with dash reason", () => {
	expect(parseMarker("PI_JOB_STATUS: failure - no room available")).toEqual({
		status: "failure",
		reason: "no room available",
	});
});

test("parses failure with em-dash reason", () => {
	expect(parseMarker("PI_JOB_STATUS: failure \u2014 nothing to do")).toEqual({
		status: "failure",
		reason: "nothing to do",
	});
});

test("uses the LAST marker line", () => {
	const out = "PI_JOB_STATUS: success\ntrailing\nPI_JOB_STATUS: failure - oops";
	expect(parseMarker(out)).toEqual({ status: "failure", reason: "oops" });
});

test("returns null when no marker", () => {
	expect(parseMarker("just some output")).toBeNull();
});

test("ignores surrounding whitespace", () => {
	expect(parseMarker("  PI_JOB_STATUS: success  ")).toEqual({
		status: "success",
		reason: null,
	});
});
