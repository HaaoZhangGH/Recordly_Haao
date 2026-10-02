import { normalizeRecordedMicrophone } from "../recording/microphoneLevel";
import {
	app,
	BrowserWindow,
	desktopCapturer,
	dialog,
	ipcMain,
	shell,
	systemPreferences,
} from "electron";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getHudCaptureExcludedProcessIds } from "../../../src/lib/hudCaptureProtection";
import { beginHudCaptureProtection, getHudOverlayCaptureProtectionEnabled } from "../../windows";
import { ALLOW_RECORDLY_WINDOW_CAPTURE } from "../constants";
import { startWindowBoundsCapture, stopWindowBoundsCapture } from "../cursor/bounds";
import { startNativeCursorMonitor, stopNativeCursorMonitor } from "../cursor/monitor";
import {
	normalizeCursorTelemetrySamples,
	pauseCursorCaptureAtBoundary,
	resetCursorCaptureClock,
	resumeCursorCapture,
	sampleCursorPoint,
	snapshotCursorTelemetryForPersistence,
	startCursorSampling,
	stopCursorCapture,
	writeCursorTelemetry,
} from "../cursor/telemetry";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";
import {
	ensureNativeCaptureHelperBinary,
	ensureSwiftHelperBinary,
	getNativeCaptureHelperBinaryPath,
	getSystemCursorHelperBinaryPath,
	getSystemCursorHelperSourcePath,
} from "../paths/binaries";
import { rememberApprovedLocalReadPath } from "../project/manager";
import {
	getBrowserMicSidecarFilters,
	shouldKeepRecordingAudioSidecars,
} from "../recording/audioFilters";
import {
	getCompanionAudioFallbackInfo,
	getFileSizeIfPresent,
	type MicrophoneChunkTimingEvent,
	type MicrophonePauseInterval,
	recordNativeCaptureDiagnostics,
	summarizeMicrophoneChunkTiming,
	validateRecordedVideo,
	writeRecordingDiagnosticsSnapshot,
} from "../recording/diagnostics";
import {
	attachNativeCaptureLifecycle,
	finalizeStoredVideo,
	muxNativeMacRecordingWithAudio,
	recoverNativeMacCaptureOutput,
	waitForNativeCaptureCommand,
	waitForNativeCaptureStart,
	waitForNativeCaptureStop,
} from "../recording/mac";
import { resolveRecordedVideoStoragePath } from "../recording/storagePath";
import {
	cachedSystemCursorAssets,
	cachedSystemCursorAssetsSourceMtimeMs,
	currentVideoPath,
	lastNativeCaptureDiagnostics,
	nativeCaptureMicrophonePath,
	nativeCaptureOutputBuffer,
	nativeCapturePaused,
	nativeCaptureProcess,
	nativeCaptureSystemAudioPath,
	nativeCaptureTargetPath,
	nativeScreenRecordingActive,
	selectedSource,
	setActiveCursorSamples,
	setCachedSystemCursorAssets,
	setCachedSystemCursorAssetsSourceMtimeMs,
	setCursorCaptureStartTimeMs,
	setIsCursorCaptureActive,
	setLastLeftClick,
	setNativeCaptureMicrophonePath,
	setNativeCaptureOutputBuffer,
	setNativeCapturePaused,
	setNativeCaptureProcess,
	setNativeCaptureStopRequested,
	setNativeCaptureSystemAudioPath,
	setNativeCaptureTargetPath,
	setNativeScreenRecordingActive,
	setPendingCursorSamples,
} from "../state";
import type { CursorTelemetryPoint, NativeMacRecordingOptions, SelectedSource } from "../types";
import {
	getMacPrivacySettingsUrl,
	getRecordingsDir,
	getScreen,
	getTelemetryPathForVideo,
	moveFileWithOverwrite,
	normalizeVideoSourcePath,
	parseJsonWithByteOrderMark,
	parseWindowId,
} from "../utils";
import { bringSelectedWindowForward } from "./sources";

const execFileAsync = promisify(execFile);

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function pickPrimitiveRecord(value: unknown) {
	if (!isRecord(value)) {
		return null;
	}

	const entries = Object.entries(value).filter(
		(entry): entry is [string, boolean | number | string] => {
			const primitive = entry[1];
			return (
				typeof primitive === "boolean" ||
				typeof primitive === "number" ||
				typeof primitive === "string"
			);
		},
	);

	return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function normalizeRendererTimestampMs(value: unknown) {
	const nowMs = Date.now();
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return nowMs;
	}

	return Math.min(Math.max(0, Math.round(value)), nowMs);
}

function pickMicrophoneChunkEvents(value: unknown): MicrophoneChunkTimingEvent[] | null {
	if (!Array.isArray(value)) {
		return null;
	}

	const events = value
		.map((event) => {
			if (!isRecord(event)) {
				return null;
			}

			const { index, size, elapsedMs, deltaMs, recordedElapsedMs, recordedDeltaMs } = event;
			if (
				typeof index !== "number" ||
				!Number.isFinite(index) ||
				index < 0 ||
				typeof size !== "number" ||
				!Number.isFinite(size) ||
				size < 0 ||
				typeof elapsedMs !== "number" ||
				!Number.isFinite(elapsedMs) ||
				elapsedMs < 0
			) {
				return null;
			}

			return {
				index: Math.round(index),
				size: Math.round(size),
				elapsedMs: Math.round(elapsedMs),
				deltaMs:
					typeof deltaMs === "number" && Number.isFinite(deltaMs)
						? Math.max(0, Math.round(deltaMs))
						: null,
				...(typeof recordedElapsedMs === "number" &&
				Number.isFinite(recordedElapsedMs) &&
				recordedElapsedMs >= 0
					? { recordedElapsedMs: Math.round(recordedElapsedMs) }
					: {}),
				recordedDeltaMs:
					typeof recordedDeltaMs === "number" && Number.isFinite(recordedDeltaMs)
						? Math.max(0, Math.round(recordedDeltaMs))
						: null,
			};
		})
		.filter((event): event is NonNullable<typeof event> => event !== null);

	return events.length > 0 ? events : null;
}

function pickMicrophonePauseIntervals(value: unknown): MicrophonePauseInterval[] | null {
	if (!Array.isArray(value)) {
		return null;
	}

	const intervals = value
		.map((interval) => {
			if (
				!isRecord(interval) ||
				typeof interval.startElapsedMs !== "number" ||
				!Number.isFinite(interval.startElapsedMs) ||
				interval.startElapsedMs < 0
			) {
				return null;
			}

			const startElapsedMs = Math.max(0, Math.round(interval.startElapsedMs));
			return {
				startElapsedMs,
				...(typeof interval.endElapsedMs === "number" &&
				Number.isFinite(interval.endElapsedMs) &&
				interval.endElapsedMs >= startElapsedMs
					? { endElapsedMs: Math.round(interval.endElapsedMs) }
					: {}),
				...(typeof interval.durationMs === "number" &&
				Number.isFinite(interval.durationMs) &&
				interval.durationMs >= 0
					? { durationMs: Math.round(interval.durationMs) }
					: {}),
			};
		})
		.filter((interval): interval is NonNullable<typeof interval> => interval !== null);

	return intervals.length > 0 ? intervals : null;
}

function pickAudioInputDevices(value: unknown) {
	if (!Array.isArray(value)) {
		return null;
	}

	const devices = value
		.map((device) => {
			if (!isRecord(device) || typeof device.deviceId !== "string") {
				return null;
			}

			return {
				deviceId: device.deviceId,
				...(typeof device.groupId === "string" ? { groupId: device.groupId } : {}),
				label: typeof device.label === "string" ? device.label : "",
			};
		})
		.filter((device): device is NonNullable<typeof device> => device !== null);

	return devices.length > 0 ? devices : null;
}

async function getSystemCursorAssets() {
	const sourcePath = getSystemCursorHelperSourcePath();
	const sourceStat = await fs.stat(sourcePath);
	if (cachedSystemCursorAssets && cachedSystemCursorAssetsSourceMtimeMs === sourceStat.mtimeMs) {
		return cachedSystemCursorAssets;
	}
	const binaryPath = await ensureSwiftHelperBinary(
		sourcePath,
		getSystemCursorHelperBinaryPath(),
		"system cursor helper",
		"recordly-system-cursors",
	);
	const { stdout } = await execFileAsync(binaryPath, [], {
		timeout: 15000,
		maxBuffer: 20 * 1024 * 1024,
	});
	const parsed = JSON.parse(stdout) as Record<
		string,
		Partial<import("../types").SystemCursorAsset>
	>;
	const result = Object.fromEntries(
		Object.entries(parsed).filter(
			([, asset]) =>
				typeof asset?.dataUrl === "string" &&
				typeof asset?.hotspotX === "number" &&
				typeof asset?.hotspotY === "number" &&
				typeof asset?.width === "number" &&
				typeof asset?.height === "number",
		),
	) as Record<string, import("../types").SystemCursorAsset>;
	setCachedSystemCursorAssets(result);
	setCachedSystemCursorAssetsSourceMtimeMs(sourceStat.mtimeMs);
	return result;
}

function normalizeDesktopSourceName(value: string) {
	return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function registerRecordingHandlers(
	onRecordingStateChange?: (recording: boolean, sourceName: string) => void,
) {
	ipcMain.handle(
		"start-native-screen-recording",
		async (_, source: SelectedSource, options?: NativeMacRecordingOptions) => {
			// Protect the HUD at the capture boundary, before the renderer publishes recording state.
			beginHudCaptureProtection();
			const visibleWindowBounds = source.id?.startsWith("window:")
				? await bringSelectedWindowForward(source)
				: null;

			if (nativeCaptureProcess && !nativeScreenRecordingActive) {
				try {
					nativeCaptureProcess.kill();
				} catch {
					// ignore stale helper cleanup failures
				}
				setNativeCaptureProcess(null);
				setNativeCaptureTargetPath(null);
				setNativeCaptureStopRequested(false);
			}

			if (nativeCaptureProcess) {
				return { success: false, message: "A native screen recording is already active." };
			}

			let captProc: ChildProcessWithoutNullStreams | null = null;
			try {
				const recordingsDir = await getRecordingsDir();

				// Warm up TCC: trigger an Electron-level screen capture API call so macOS
				// activates the screen-recording grant for this process tree before the
				// native helper binary spawns and calls SCStream.startCapture().
				try {
					await desktopCapturer.getSources({
						types: ["screen"],
						thumbnailSize: { width: 1, height: 1 },
					});
				} catch {
					// non-fatal – the helper will report its own TCC status
				}

				// Ensure microphone TCC is granted for this process tree when mic capture
				// is requested, so the child helper inherits the grant.
				if (options?.capturesMicrophone) {
					const micStatus = systemPreferences.getMediaAccessStatus("microphone");
					if (micStatus !== "granted") {
						await systemPreferences.askForMediaAccess("microphone");
					}
				}

				const appName = normalizeDesktopSourceName(String(source?.appName ?? ""));
				const ownAppName = normalizeDesktopSourceName(app.getName());
				if (
					!ALLOW_RECORDLY_WINDOW_CAPTURE &&
					source?.id?.startsWith("window:") &&
					appName &&
					(appName === ownAppName || appName === "recordly")
				) {
					return {
						success: false,
						message:
							"Cannot record Recordly windows. Please select another app window.",
					};
				}

				const helperPath = await ensureNativeCaptureHelperBinary();
				const timestamp = Date.now();
				const outputPath = path.join(recordingsDir, `recording-${timestamp}.mp4`);
				const capturesSystemAudio = Boolean(options?.capturesSystemAudio);
				const capturesMicrophone = Boolean(options?.capturesMicrophone);
				const systemAudioOutputPath = capturesSystemAudio
					? path.join(recordingsDir, `recording-${timestamp}.system.m4a`)
					: null;
				const microphoneOutputPath = capturesMicrophone
					? path.join(recordingsDir, `recording-${timestamp}.mic.m4a`)
					: null;
				const config: Record<string, unknown> = {
					fps: 60,
					outputPath,
					capturesSystemAudio,
					capturesMicrophone,
				};

				const excludedProcessIds = getHudCaptureExcludedProcessIds(
					"darwin",
					getHudOverlayCaptureProtectionEnabled(),
					process.pid,
				);
				if (excludedProcessIds.length > 0) {
					config.excludedProcessIds = excludedProcessIds;
				}

				if (options?.microphoneDeviceId) {
					config.microphoneDeviceId = options.microphoneDeviceId;
				}

				if (options?.microphoneLabel) {
					config.microphoneLabel = options.microphoneLabel;
				}

				if (systemAudioOutputPath) {
					config.systemAudioOutputPath = systemAudioOutputPath;
				}

				if (microphoneOutputPath) {
					config.microphoneOutputPath = microphoneOutputPath;
				}

				const windowId = parseWindowId(source?.id);
				const screenId = Number(source?.display_id);

				if (Number.isFinite(windowId) && windowId && source?.id?.startsWith("window:")) {
					config.windowId = windowId;
					if (visibleWindowBounds) {
						config.windowX = visibleWindowBounds.x;
						config.windowY = visibleWindowBounds.y;
						config.windowWidth = visibleWindowBounds.width;
						config.windowHeight = visibleWindowBounds.height;
					}
				} else if (Number.isFinite(screenId) && screenId > 0) {
					config.displayId = screenId;
				} else {
					config.displayId = Number(getScreen().getPrimaryDisplay().id);
				}

				setNativeCaptureOutputBuffer("");
				setNativeCaptureTargetPath(outputPath);
				setNativeCaptureSystemAudioPath(systemAudioOutputPath);
				setNativeCaptureMicrophonePath(microphoneOutputPath);
				setNativeCaptureStopRequested(false);
				setNativeCapturePaused(false);
				captProc = spawn(helperPath, [JSON.stringify(config)], {
					cwd: recordingsDir,
					stdio: ["pipe", "pipe", "pipe"],
				});
				setNativeCaptureProcess(captProc);
				attachNativeCaptureLifecycle(captProc);

				captProc.stdout.on("data", (chunk: Buffer) => {
					setNativeCaptureOutputBuffer(nativeCaptureOutputBuffer + chunk.toString());
				});
				captProc.stderr.on("data", (chunk: Buffer) => {
					setNativeCaptureOutputBuffer(nativeCaptureOutputBuffer + chunk.toString());
				});

				await waitForNativeCaptureStart(captProc);
				setNativeScreenRecordingActive(true);

				// If the native helper reported MICROPHONE_CAPTURE_UNAVAILABLE, it started
				// capture without microphone.  Clear the mic path so the renderer can fall
				// back to a browser-side sidecar recording for the microphone track.
				const micUnavailableNatively = nativeCaptureOutputBuffer.includes(
					"MICROPHONE_CAPTURE_UNAVAILABLE",
				);
				if (micUnavailableNatively) {
					setNativeCaptureMicrophonePath(null);
				}

				recordNativeCaptureDiagnostics({
					backend: "mac-screencapturekit",
					phase: "start",
					sourceId: source?.id ?? null,
					sourceType: source?.sourceType ?? "unknown",
					displayId: typeof config.displayId === "number" ? config.displayId : null,
					helperPath,
					outputPath,
					systemAudioPath: systemAudioOutputPath,
					microphonePath: nativeCaptureMicrophonePath,
					processOutput: nativeCaptureOutputBuffer.trim() || undefined,
				});
				return {
					success: true,
					microphoneFallbackRequired: micUnavailableNatively,
				};
			} catch (error) {
				console.error("Failed to start native ScreenCaptureKit recording:", error);
				const errorStr = String(error);

				// Detect TCC (screen recording permission) errors and show a helpful dialog
				if (
					errorStr.includes("declined TCC") ||
					errorStr.includes("declined TCCs") ||
					errorStr.includes("SCREEN_RECORDING_PERMISSION_DENIED")
				) {
					const { response } = await dialog.showMessageBox({
						type: "warning",
						title: "Screen Recording Permission Required",
						message:
							"Recordly needs screen recording permission to capture your screen.",
						detail: "Please open System Settings > Privacy & Security > Screen Recording, make sure Recordly is toggled ON, then try recording again.",
						buttons: ["Open System Settings", "Cancel"],
						defaultId: 0,
						cancelId: 1,
					});
					if (response === 0) {
						await shell.openExternal(getMacPrivacySettingsUrl("screen"));
					}
					try {
						if (captProc) captProc.kill();
					} catch {
						/* ignore */
					}
					setNativeScreenRecordingActive(false);
					setNativeCaptureProcess(null);
					setNativeCaptureTargetPath(null);
					setNativeCaptureSystemAudioPath(null);
					setNativeCaptureMicrophonePath(null);
					setNativeCaptureStopRequested(false);
					setNativeCapturePaused(false);
					return {
						success: false,
						message:
							"Screen recording permission not granted. Please allow access in System Settings and restart the app.",
						userNotified: true,
					};
				}

				if (errorStr.includes("MICROPHONE_PERMISSION_DENIED")) {
					const { response } = await dialog.showMessageBox({
						type: "warning",
						title: "Microphone Permission Required",
						message: "Recordly needs microphone permission to record audio.",
						detail: "Please open System Settings > Privacy & Security > Microphone, make sure Recordly is toggled ON, then try recording again.",
						buttons: ["Open System Settings", "Cancel"],
						defaultId: 0,
						cancelId: 1,
					});
					if (response === 0) {
						await shell.openExternal(getMacPrivacySettingsUrl("microphone"));
					}
					try {
						if (captProc) captProc.kill();
					} catch {
						/* ignore */
					}
					setNativeScreenRecordingActive(false);
					setNativeCaptureProcess(null);
					setNativeCaptureTargetPath(null);
					setNativeCaptureSystemAudioPath(null);
					setNativeCaptureMicrophonePath(null);
					setNativeCaptureStopRequested(false);
					setNativeCapturePaused(false);
					return {
						success: false,
						message:
							"Microphone permission not granted. Please allow access in System Settings.",
						userNotified: true,
					};
				}

				recordNativeCaptureDiagnostics({
					backend: "mac-screencapturekit",
					phase: "start",
					sourceId: source?.id ?? null,
					sourceType: source?.sourceType ?? "unknown",
					helperPath: getNativeCaptureHelperBinaryPath(),
					outputPath: nativeCaptureTargetPath,
					systemAudioPath: nativeCaptureSystemAudioPath,
					microphonePath: nativeCaptureMicrophonePath,
					processOutput: nativeCaptureOutputBuffer.trim() || undefined,
					fileSizeBytes: await getFileSizeIfPresent(nativeCaptureTargetPath),
					error: String(error),
				});
				try {
					if (captProc) captProc.kill();
				} catch {
					// ignore cleanup failures
				}
				setNativeScreenRecordingActive(false);
				setNativeCaptureProcess(null);
				setNativeCaptureTargetPath(null);
				setNativeCaptureSystemAudioPath(null);
				setNativeCaptureMicrophonePath(null);
				setNativeCaptureStopRequested(false);
				setNativeCapturePaused(false);
				return {
					success: false,
					message: "Failed to start native ScreenCaptureKit recording",
					error: String(error),
				};
			}
		},
	);

	ipcMain.handle("stop-native-screen-recording", async () => {
		const start = Date.now();
		console.log("[PERF:MAIN] Handler: stop-native-screen-recording: STARTED");
		try {
			if (!nativeScreenRecordingActive) {
				const recovered = await recoverNativeMacCaptureOutput();
				if (recovered) {
					return recovered;
				}

				return { success: false, message: "No native screen recording is active." };
			}

			try {
				if (!nativeCaptureProcess) {
					throw new Error("Native capture helper process is not running");
				}

				const process = nativeCaptureProcess;
				const preferredVideoPath = nativeCaptureTargetPath;
				const preferredSystemAudioPath = nativeCaptureSystemAudioPath;
				const preferredMicrophonePath = nativeCaptureMicrophonePath;
				console.log(
					"[stop-native] Audio paths — system:",
					preferredSystemAudioPath,
					"mic:",
					preferredMicrophonePath,
				);
				setNativeCaptureStopRequested(true);
				process.stdin.write("stop\n");
				const tempVideoPath = await waitForNativeCaptureStop(process);
				console.log("[stop-native] Helper stopped, tempVideoPath:", tempVideoPath);
				setNativeCaptureProcess(null);
				setNativeScreenRecordingActive(false);
				setNativeCaptureTargetPath(null);
				setNativeCaptureSystemAudioPath(null);
				setNativeCaptureMicrophonePath(null);
				setNativeCaptureStopRequested(false);
				setNativeCapturePaused(false);

				const finalVideoPath = preferredVideoPath ?? tempVideoPath;
				if (tempVideoPath !== finalVideoPath) {
					await moveFileWithOverwrite(tempVideoPath, finalVideoPath);
				}

				if (preferredSystemAudioPath || preferredMicrophonePath) {
					console.log(
						"[stop-native] Attempting audio mux (merging separate tracks) into:",
						finalVideoPath,
					);
					try {
						await muxNativeMacRecordingWithAudio(
							finalVideoPath,
							preferredSystemAudioPath,
							preferredMicrophonePath,
						);
						console.log("[stop-native] Audio mux completed successfully");
					} catch (error) {
						console.warn(
							"[stop-native] Audio mux failed (video still has inline audio):",
							error,
						);
					}
				} else {
					console.log("[stop-native] No separate audio tracks to mux");
				}

				return await finalizeStoredVideo(finalVideoPath);
			} catch (error) {
				console.error("Failed to stop native ScreenCaptureKit recording:", error);
				const fallbackPath = nativeCaptureTargetPath;
				const fallbackSystemAudioPath = nativeCaptureSystemAudioPath;
				const fallbackMicrophonePath = nativeCaptureMicrophonePath;
				const fallbackFileSizeBytes = await getFileSizeIfPresent(fallbackPath);
				setNativeScreenRecordingActive(false);
				setNativeCaptureProcess(null);
				setNativeCaptureTargetPath(null);
				setNativeCaptureSystemAudioPath(null);
				setNativeCaptureMicrophonePath(null);
				setNativeCaptureStopRequested(false);
				setNativeCapturePaused(false);

				recordNativeCaptureDiagnostics({
					backend: "mac-screencapturekit",
					phase: "stop",
					sourceId: lastNativeCaptureDiagnostics?.sourceId ?? null,
					sourceType: lastNativeCaptureDiagnostics?.sourceType ?? "unknown",
					displayId: lastNativeCaptureDiagnostics?.displayId ?? null,
					displayBounds: lastNativeCaptureDiagnostics?.displayBounds ?? null,
					windowHandle: lastNativeCaptureDiagnostics?.windowHandle ?? null,
					helperPath: lastNativeCaptureDiagnostics?.helperPath ?? null,
					outputPath: fallbackPath,
					systemAudioPath: fallbackSystemAudioPath,
					microphonePath: fallbackMicrophonePath,
					osRelease: lastNativeCaptureDiagnostics?.osRelease,
					supported: lastNativeCaptureDiagnostics?.supported,
					helperExists: lastNativeCaptureDiagnostics?.helperExists,
					processOutput: nativeCaptureOutputBuffer.trim() || undefined,
					fileSizeBytes: fallbackFileSizeBytes,
					error: String(error),
				});

				// Try to recover: if the target file exists on disk, finalize with it
				if (fallbackPath) {
					try {
						await fs.access(fallbackPath);
						console.log(
							"[stop-native-screen-recording] Recovering with fallback path:",
							fallbackPath,
						);
						if (fallbackSystemAudioPath || fallbackMicrophonePath) {
							try {
								await muxNativeMacRecordingWithAudio(
									fallbackPath,
									fallbackSystemAudioPath,
									fallbackMicrophonePath,
								);
							} catch (muxError) {
								console.warn(
									"Failed to mux recovered native macOS audio into capture:",
									muxError,
								);
							}
						}
						return await finalizeStoredVideo(fallbackPath);
					} catch {
						// File doesn't exist or isn't accessible
					}
				}

				const recovered = await recoverNativeMacCaptureOutput();
				if (recovered) {
					return recovered;
				}

				return {
					success: false,
					message: "Failed to stop native ScreenCaptureKit recording",
					error: String(error),
				};
			}
		} finally {
			console.log(
				`[PERF:MAIN] Handler: stop-native-screen-recording: COMPLETED in ${Date.now() - start}ms`,
			);
		}
	});

	ipcMain.handle("recover-native-screen-recording", async () => {
		const recovered = await recoverNativeMacCaptureOutput();
		if (recovered) {
			return recovered;
		}

		return {
			success: false,
			message: "No recoverable native macOS recording output was found.",
		};
	});

	ipcMain.handle("pause-native-screen-recording", async () => {
		if (!nativeScreenRecordingActive || !nativeCaptureProcess) {
			return { success: false, message: "No native screen recording is active." };
		}

		if (nativeCapturePaused) {
			return { success: true };
		}

		try {
			const commandApplied = waitForNativeCaptureCommand(
				nativeCaptureProcess,
				"Recording paused",
			);
			nativeCaptureProcess.stdin.write("pause\n");
			await commandApplied;
			setNativeCapturePaused(true);
			return { success: true };
		} catch (error) {
			return {
				success: false,
				message: "Failed to pause native screen recording",
				error: String(error),
			};
		}
	});

	ipcMain.handle("resume-native-screen-recording", async () => {
		if (!nativeScreenRecordingActive || !nativeCaptureProcess) {
			return { success: false, message: "No native screen recording is active." };
		}

		if (!nativeCapturePaused) {
			return { success: true };
		}

		try {
			const commandApplied = waitForNativeCaptureCommand(
				nativeCaptureProcess,
				"Recording resumed",
			);
			nativeCaptureProcess.stdin.write("resume\n");
			await commandApplied;
			setNativeCapturePaused(false);
			return { success: true };
		} catch (error) {
			return {
				success: false,
				message: "Failed to resume native screen recording",
				error: String(error),
			};
		}
	});

	ipcMain.handle("get-system-cursor-assets", async () => {
		try {
			return { success: true, cursors: await getSystemCursorAssets() };
		} catch (error) {
			console.error("Failed to load system cursor assets:", error);
			return { success: false, cursors: {}, error: String(error) };
		}
	});

	ipcMain.handle("get-last-native-capture-diagnostics", async () => {
		return { success: true, diagnostics: lastNativeCaptureDiagnostics };
	});

	ipcMain.handle("get-video-audio-fallback-paths", async (_event, videoPath: string) => {
		if (!videoPath) {
			return { success: true, paths: [], startDelayMsByPath: {} };
		}

		try {
			const { paths, startDelayMsByPath } = await getCompanionAudioFallbackInfo(videoPath);
			await Promise.all([
				rememberApprovedLocalReadPath(videoPath),
				...paths.map((fallbackPath) => rememberApprovedLocalReadPath(fallbackPath)),
			]);
			return { success: true, paths, startDelayMsByPath };
		} catch (error) {
			console.error("Failed to resolve companion audio fallback paths:", error);
			return { success: false, paths: [], startDelayMsByPath: {}, error: String(error) };
		}
	});

	ipcMain.handle(
		"store-microphone-sidecar",
		async (
			_,
			audioData: ArrayBuffer,
			videoPath: string,
			options?: {
				startDelayMs?: number;
				browserMicrophoneProfile?: string;
				requestedBrowserMicrophoneProfile?: string | null;
				requestedConstraints?: unknown;
				mediaTrackSettings?: Record<string, boolean | number | string>;
				audioInputDevices?: unknown;
				mediaRecorder?: unknown;
				chunkEvents?: unknown;
				pauseIntervals?: unknown;
			},
		) => {
			const baseName = videoPath.replace(/\.[^.]+$/, "");
			const sidecarPath = `${baseName}.mic.wav`;
			const sourceWebmPath = `${baseName}.mic.source.webm`;
			const tempWebmPath = `${sourceWebmPath}.tmp`;

			try {
				await fs.writeFile(tempWebmPath, Buffer.from(audioData));
				await execFileAsync(
					getFfmpegBinaryPath(),
					[
						"-y",
						"-hide_banner",
						"-nostdin",
						"-nostats",
						"-i",
						tempWebmPath,
						"-vn",
						"-ac",
						"1",
						"-ar",
						"48000",
						"-af",
						[
							...getBrowserMicSidecarFilters(options?.browserMicrophoneProfile),
							"aresample=async=1:first_pts=0",
						].join(","),
						"-c:a",
						"pcm_s16le",
						sidecarPath,
					],
					{ timeout: 120000, maxBuffer: 10 * 1024 * 1024 },
				);
				await normalizeRecordedMicrophone(sidecarPath).catch((error) => {
					console.warn("Microphone leveling failed; retaining recorded audio", error);
				});
				if (shouldKeepRecordingAudioSidecars()) {
					await fs.rename(tempWebmPath, sourceWebmPath).catch(async () => {
						await fs.copyFile(tempWebmPath, sourceWebmPath);
						await fs.rm(tempWebmPath, { force: true });
					});
				} else {
					await fs.rm(tempWebmPath, { force: true });
				}
				const startDelayMs = options?.startDelayMs;
				const mediaTrackSettings = pickPrimitiveRecord(options?.mediaTrackSettings);
				const audioInputDevices = pickAudioInputDevices(options?.audioInputDevices);
				const mediaRecorder = isRecord(options?.mediaRecorder)
					? {
							...(typeof options.mediaRecorder.mimeType === "string"
								? { mimeType: options.mediaRecorder.mimeType }
								: {}),
							...(typeof options.mediaRecorder.audioBitsPerSecond === "number"
								? {
										audioBitsPerSecond: Math.round(
											options.mediaRecorder.audioBitsPerSecond,
										),
									}
								: {}),
							...(typeof options.mediaRecorder.timesliceMs === "number"
								? { timesliceMs: Math.round(options.mediaRecorder.timesliceMs) }
								: {}),
						}
					: null;
				const chunkEvents = pickMicrophoneChunkEvents(options?.chunkEvents);
				const pauseIntervals = pickMicrophonePauseIntervals(options?.pauseIntervals);
				const chunkTiming =
					chunkEvents || pauseIntervals
						? summarizeMicrophoneChunkTiming(
								chunkEvents,
								pauseIntervals,
								mediaRecorder?.timesliceMs,
							)
						: null;
				const metadata = {
					...(Number.isFinite(startDelayMs) && (startDelayMs ?? 0) >= 0
						? { startDelayMs: Math.round(startDelayMs ?? 0) }
						: {}),
					...(typeof options?.browserMicrophoneProfile === "string"
						? { browserMicrophoneProfile: options.browserMicrophoneProfile }
						: {}),
					...(typeof options?.requestedBrowserMicrophoneProfile === "string"
						? {
								requestedBrowserMicrophoneProfile:
									options.requestedBrowserMicrophoneProfile,
							}
						: {}),
					...(isRecord(options?.requestedConstraints)
						? { requestedConstraints: options.requestedConstraints }
						: {}),
					...(mediaTrackSettings ? { mediaTrackSettings } : {}),
					...(audioInputDevices ? { audioInputDevices } : {}),
					...(mediaRecorder && Object.keys(mediaRecorder).length > 0
						? { mediaRecorder }
						: {}),
					...(chunkEvents ? { chunkEvents } : {}),
					...(pauseIntervals ? { pauseIntervals } : {}),
					...(chunkTiming ? { chunkTiming } : {}),
				};
				if (Object.keys(metadata).length > 0) {
					try {
						await fs.writeFile(`${sidecarPath}.json`, JSON.stringify(metadata));
					} catch (metadataError) {
						console.warn(
							"Failed to store microphone sidecar timing metadata:",
							metadataError,
						);
					}
				}
				await writeRecordingDiagnosticsSnapshot(videoPath, {
					backend: "browser-store",
					phase: "mic-sidecar",
					outputPath: videoPath,
					microphonePath: sidecarPath,
					details: {
						sourceBytes: audioData.byteLength,
						sourceWebmPath: shouldKeepRecordingAudioSidecars() ? sourceWebmPath : null,
						metadata,
					},
				}).catch((diagnosticsError) => {
					console.warn(
						"Failed to write microphone sidecar diagnostics:",
						diagnosticsError,
					);
				});
				return { success: true, path: sidecarPath };
			} catch (error) {
				await Promise.all([
					fs.rm(tempWebmPath, { force: true }).catch(() => undefined),
					fs.rm(sidecarPath, { force: true }).catch(() => undefined),
				]);
				console.error("Failed to store microphone sidecar:", error);
				return { success: false, error: String(error) };
			}
		},
	);

	ipcMain.handle("store-recorded-video", async (_, videoData: ArrayBuffer, fileName: unknown) => {
		try {
			const recordingsDir = await getRecordingsDir();
			const videoPath = resolveRecordedVideoStoragePath(recordingsDir, fileName);
			await fs.writeFile(videoPath, Buffer.from(videoData));
			return await finalizeStoredVideo(videoPath);
		} catch (error) {
			console.error("Failed to store video:", error);
			return {
				success: false,
				message: "Failed to store video",
				error: String(error),
			};
		}
	});

	ipcMain.handle("get-recorded-video-path", async () => {
		try {
			const recordingsDir = await getRecordingsDir();
			const entries = await fs.readdir(recordingsDir, { withFileTypes: true });
			const candidates = await Promise.all(
				entries
					.filter(
						(entry) =>
							entry.isFile() && /^recording-\d+\.(webm|mov|mp4)$/i.test(entry.name),
					)
					.map(async (entry) => {
						const fullPath = path.join(recordingsDir, entry.name);
						const stat = await fs.stat(fullPath).catch(() => null);
						return stat ? { path: fullPath, mtimeMs: stat.mtimeMs } : null;
					}),
			);
			const sortedCandidates = candidates
				.filter(
					(candidate): candidate is { path: string; mtimeMs: number } =>
						candidate !== null,
				)
				.sort((left, right) => right.mtimeMs - left.mtimeMs);

			for (const candidate of sortedCandidates) {
				try {
					await validateRecordedVideo(candidate.path);
					return { success: true, path: candidate.path };
				} catch (error) {
					console.warn(
						"Skipping unusable recovered recording candidate:",
						candidate.path,
						error,
					);
				}
			}

			if (sortedCandidates.length === 0) {
				return { success: false, message: "No recorded video found" };
			}

			return { success: false, message: "No usable recorded video found" };
		} catch (error) {
			console.error("Failed to get video path:", error);
			return { success: false, message: "Failed to get video path", error: String(error) };
		}
	});

	ipcMain.handle("set-recording-state", (_, recording: boolean) => {
		if (recording) {
			stopCursorCapture();

			startWindowBoundsCapture();
			void startNativeCursorMonitor();
			setIsCursorCaptureActive(true);
			setActiveCursorSamples([]);
			setPendingCursorSamples([]);
			setCursorCaptureStartTimeMs(Date.now());
			resetCursorCaptureClock();
			setLastLeftClick(null);
			sampleCursorPoint();
			startCursorSampling();
		} else {
			setIsCursorCaptureActive(false);
			stopCursorCapture();

			stopWindowBoundsCapture();
			stopNativeCursorMonitor();

			resetCursorCaptureClock();
			snapshotCursorTelemetryForPersistence();
			setActiveCursorSamples([]);
		}

		const source = selectedSource || { name: "Screen" };
		BrowserWindow.getAllWindows().forEach((window) => {
			if (!window.isDestroyed()) {
				window.webContents.send("recording-state-changed", {
					recording,
					sourceName: source.name,
				});
			}
		});

		if (onRecordingStateChange) {
			onRecordingStateChange(recording, source.name);
		}
	});

	ipcMain.handle("pause-cursor-capture", (_, pausedAtMs?: unknown) => {
		pauseCursorCaptureAtBoundary(normalizeRendererTimestampMs(pausedAtMs));
		return { success: true };
	});

	ipcMain.handle("resume-cursor-capture", (_, resumedAtMs?: unknown) => {
		resumeCursorCapture(normalizeRendererTimestampMs(resumedAtMs));
		sampleCursorPoint();
		return { success: true };
	});

	ipcMain.handle("get-cursor-telemetry", async (_, videoPath?: string) => {
		const targetVideoPath = normalizeVideoSourcePath(videoPath ?? currentVideoPath);
		if (!targetVideoPath) {
			return { success: true, samples: [] };
		}

		const telemetryPath = getTelemetryPathForVideo(targetVideoPath);
		try {
			const content = await fs.readFile(telemetryPath, "utf-8");
			const parsed = parseJsonWithByteOrderMark<unknown>(content);
			const samples = normalizeCursorTelemetrySamples(parsed);

			return { success: true, samples };
		} catch (error) {
			const nodeError = error as NodeJS.ErrnoException;
			if (nodeError.code === "ENOENT") {
				return { success: true, samples: [] };
			}
			console.error("Failed to load cursor telemetry:", error);
			return {
				success: false,
				message: "Failed to load cursor telemetry",
				error: String(error),
				samples: [],
			};
		}
	});

	ipcMain.handle(
		"set-cursor-telemetry",
		async (_, videoPath: string | undefined, samples: CursorTelemetryPoint[]) => {
			const targetVideoPath = normalizeVideoSourcePath(videoPath ?? currentVideoPath);
			if (!targetVideoPath) {
				return {
					success: false,
					samples: [],
					message: "No video path available for cursor telemetry",
					error: "Missing video path",
				};
			}

			try {
				const normalizedSamples = await writeCursorTelemetry(targetVideoPath, samples);
				return { success: true, samples: normalizedSamples };
			} catch (error) {
				console.error("Failed to save cursor telemetry:", error);
				return {
					success: false,
					samples: [],
					message: "Failed to save cursor telemetry",
					error: String(error),
				};
			}
		},
	);
}
