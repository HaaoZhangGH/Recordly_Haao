import { describe, expect, it } from "vitest";

import {
	getHudCaptureExcludedProcessIds,
	shouldProtectHudCapture,
	supportsHudCaptureProtection,
} from "../src/lib/hudCaptureProtection";

describe("HUD capture protection lifecycle", () => {
	it("uses window protection on macOS", () => {
		expect(supportsHudCaptureProtection("darwin")).toBe(true);
	});

	it("only builds a macOS process exclusion when protection is enabled", () => {
		expect(getHudCaptureExcludedProcessIds("darwin", true, 734)).toEqual([734]);
		expect(getHudCaptureExcludedProcessIds("darwin", false, 734)).toEqual([]);
	});
});

it("protects initial capture frames while keeping idle and failed starts visible", () => {
	expect(shouldProtectHudCapture(true, false, false)).toBe(false);
	expect(shouldProtectHudCapture(true, false, true)).toBe(true);
	expect(shouldProtectHudCapture(true, true, false)).toBe(true);
	expect(shouldProtectHudCapture(true, false, false)).toBe(false);
	expect(shouldProtectHudCapture(false, true, true)).toBe(false);
});
