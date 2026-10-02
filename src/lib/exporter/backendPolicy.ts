import type { ExportRenderBackend } from "./types";
export type LightningRuntimePlatform = "darwin";
export function normalizeLightningRuntimePlatform(_hint?: string | null): LightningRuntimePlatform {
	return "darwin";
}
export function shouldPreferNativeAutoBackend(_platform?: LightningRuntimePlatform): boolean {
	return true;
}
export function getDefaultLightningRenderBackend(): ExportRenderBackend {
	return "webgl";
}
