import { app, BrowserWindow, type WebContents } from "electron";
import { execFile, type ChildProcess } from "node:child_process";
import { getPrebundledNativeHelperPath } from "./paths/binaries";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { getHudOverlayWindow } from "../windows";
import type { SelectedSource } from "./types";

export type NativeSourcePickerResult =
	| { success: true; source: SelectedSource }
	| { success: false; cancelled?: boolean; error?: string };

export function parsePickerResult(
	stdout: string,
	mode: "screen" | "window",
): NativeSourcePickerResult {
	const result = JSON.parse(stdout);
	if (result.cancelled === true) return { success: false, cancelled: true };
	if (typeof result.error === "string") return { success: false, error: result.error };
	const source = result.source;
	const validId = mode === "window" ? /^window:\d+:0$/ : /^screen:fallback:\d+$/;
	if (
		!source ||
		typeof source.name !== "string" ||
		!source.name.trim() ||
		typeof source.id !== "string" ||
		!validId.test(source.id) ||
		source.sourceType !== mode ||
		(mode === "screen" && !/^\d+$/.test(source.display_id))
	)
		throw new Error("Invalid system capture selection");
	return { success: true, source };
}

let pending = false;
let activeChild: ChildProcess | null = null;
let quitting = false;
app.on("before-quit", () => {
	quitting = true;
	activeChild?.kill();
});

export async function pickNativeSource(
	mode: "screen" | "window",
	sender: WebContents,
): Promise<NativeSourcePickerResult> {
	if (pending) return { success: false, cancelled: true };
	pending = true;
	let result: NativeSourcePickerResult = { success: false, cancelled: true };
	let hiddenWindows: BrowserWindow[] = [];
	let requestDirectory: string | null = null;
	const cancel = () => {
		activeChild?.kill();
	};
	sender.once("destroyed", cancel);
	sender.once("render-process-gone", cancel);
	sender.once("did-start-loading", cancel);
	try {
		const bundle = getPrebundledNativeHelperPath("Recordly Picker.app");
		await fs.access(path.join(bundle, "Contents", "MacOS", "RecordlyPicker"));
		requestDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-picker-"));
		const resultPath = path.join(requestDirectory, "result.json");
		if (sender.isDestroyed() || quitting) return result;
		hiddenWindows = BrowserWindow.getAllWindows().filter(
			(win) => !win.isDestroyed() && win.isVisible(),
		);
		const excludedIds = hiddenWindows.map((win) => win.getMediaSourceId().split(":")[1]);
		for (const win of hiddenWindows) win.hide();
		await new Promise<void>((resolve, reject) => {
			activeChild = execFile(
				"/usr/bin/open",
				[
					"-n",
					"-W",
					"-a",
					bundle,
					"--args",
					"--pick",
					mode,
					resultPath,
					String(process.pid),
					...excludedIds,
				],
				{
					timeout: 300_000,
					maxBuffer: 1024 * 1024,
				},
				(error, _stdout, stderr) => {
					if (error)
						reject(
							new Error([error.message, stderr.trim()].filter(Boolean).join("\n")),
						);
					else resolve();
				},
			);
			activeChild.stderr?.on("data", (chunk: Buffer) => {
				console.info("[source-picker]", chunk.toString().trim());
			});
		});
		const stdout = await fs.readFile(resultPath, "utf8");
		result = parsePickerResult(stdout, mode);
		return result;
	} catch (error) {
		console.warn("System source picker failed:", error);
		return { success: false, error: error instanceof Error ? error.message : String(error) };
	} finally {
		activeChild = null;
		pending = false;
		sender.removeListener("destroyed", cancel);
		sender.removeListener("render-process-gone", cancel);
		sender.removeListener("did-start-loading", cancel);
		// The native component also watches this directory and exits if it is gone.
		if (requestDirectory)
			await fs.rm(requestDirectory, { recursive: true, force: true }).catch(console.warn);
		if (!quitting && !sender.isDestroyed()) {
			// Keep the dashboard out of the capture. On cancel/failure, restore it.
			for (const win of hiddenWindows) {
				if (!win.isDestroyed() && (!result.success || win === getHudOverlayWindow()))
					win.showInactive();
			}
		}
	}
}
