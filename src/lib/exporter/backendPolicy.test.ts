import { expect, it } from "vitest";
import {
	normalizeLightningRuntimePlatform,
	shouldPreferNativeAutoBackend,
	getDefaultLightningRenderBackend,
} from "./backendPolicy";
it("prefers native encoding on macOS and keeps the shared WebGL renderer", () => {
	expect(normalizeLightningRuntimePlatform("MacIntel")).toBe("darwin");
	expect(shouldPreferNativeAutoBackend()).toBe(true);
	expect(getDefaultLightningRenderBackend()).toBe("webgl");
});
