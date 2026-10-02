import { describe, expect, it } from "vitest";

import { getScreenSourceIdForDisplay } from "./sourceMapping";

describe("getScreenSourceIdForDisplay", () => {
	it("keeps the live Electron screen source when one is available", () => {
		expect(
			getScreenSourceIdForDisplay({
				displayId: "42",
				matchedSourceId: "screen:42:0",
				platform: "linux",
			}),
		).toBe("screen:42:0");
	});
});
