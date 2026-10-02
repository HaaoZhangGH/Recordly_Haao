import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureNativeWindowListBinary } from "../paths/binaries";
import {
	cachedNativeMacWindowSources,
	cachedNativeMacWindowSourcesAtMs,
	selectedSource,
	setCachedNativeMacWindowSources,
	setCachedNativeMacWindowSourcesAtMs,
	setSelectedWindowBounds,
	setWindowBoundsCaptureInterval,
	windowBoundsCaptureInterval,
} from "../state";
import type { NativeMacWindowSource, SelectedSource, WindowBounds } from "../types";
import { parseWindowId } from "../utils";

const execFileAsync = promisify(execFile);

export async function getNativeMacWindowSources(options?: { maxAgeMs?: number }) {
	const maxAgeMs = options?.maxAgeMs ?? 5000;
	const now = Date.now();
	if (cachedNativeMacWindowSources && now - cachedNativeMacWindowSourcesAtMs < maxAgeMs) {
		return cachedNativeMacWindowSources;
	}

	try {
		const binaryPath = await ensureNativeWindowListBinary();
		const { stdout } = await execFileAsync(binaryPath, [], {
			timeout: 30000,
			maxBuffer: 10 * 1024 * 1024,
		});

		const parsed = JSON.parse(stdout);
		if (!Array.isArray(parsed)) {
			return [] as NativeMacWindowSource[];
		}

		const entries = parsed.filter((entry: unknown): entry is NativeMacWindowSource => {
			if (!entry || typeof entry !== "object") {
				return false;
			}

			const candidate = entry as Partial<NativeMacWindowSource>;
			return typeof candidate.id === "string" && typeof candidate.name === "string";
		});

		setCachedNativeMacWindowSources(entries);
		setCachedNativeMacWindowSourcesAtMs(now);
		return entries;
	} catch {
		return cachedNativeMacWindowSources ?? ([] as NativeMacWindowSource[]);
	}
}

export function getWindowBoundsFromNativeSource(
	source?: NativeMacWindowSource | null,
): WindowBounds | null {
	if (!source) {
		return null;
	}

	const { x, y, width, height } = source;
	if (
		typeof x !== "number" ||
		!Number.isFinite(x) ||
		typeof y !== "number" ||
		!Number.isFinite(y) ||
		typeof width !== "number" ||
		!Number.isFinite(width) ||
		typeof height !== "number" ||
		!Number.isFinite(height)
	) {
		return null;
	}

	if (width <= 0 || height <= 0) {
		return null;
	}

	return { x, y, width, height };
}

export async function resolveMacWindowBounds(source: SelectedSource): Promise<WindowBounds | null> {
	const windowId = parseWindowId(source.id);
	if (!windowId) {
		return null;
	}

	try {
		const nativeSources = await getNativeMacWindowSources({ maxAgeMs: 250 });
		const matchedSource = nativeSources.find((entry) => parseWindowId(entry.id) === windowId);
		return getWindowBoundsFromNativeSource(matchedSource);
	} catch {
		return null;
	}
}

export function stopWindowBoundsCapture() {
	if (windowBoundsCaptureInterval) {
		clearInterval(windowBoundsCaptureInterval);
		setWindowBoundsCaptureInterval(null);
	}
	setSelectedWindowBounds(null);
}

async function refreshSelectedWindowBounds() {
	if (!selectedSource?.id?.startsWith("window:")) {
		setSelectedWindowBounds(null);
		return;
	}

	let bounds: WindowBounds | null = null;

	{
		bounds = await resolveMacWindowBounds(selectedSource);
	}

	setSelectedWindowBounds(bounds);
}

export function startWindowBoundsCapture() {
	stopWindowBoundsCapture();

	if (
		!["darwin", "win32", "linux"].includes("darwin") ||
		!selectedSource?.id?.startsWith("window:")
	) {
		return;
	}

	void refreshSelectedWindowBounds();
	setWindowBoundsCaptureInterval(
		setInterval(() => {
			void refreshSelectedWindowBounds();
		}, 250),
	);
}
