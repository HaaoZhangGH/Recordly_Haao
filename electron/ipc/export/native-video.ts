import type { WebContents } from "electron";
import { app } from "electron";
import type { ChildProcessByStdio } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";
import type {
	NativeExportEncodingMode,
	NativeVideoAudioMuxMetrics,
	NativeVideoExportFinishOptions,
} from "../nativeVideoExport";
import {
	buildEditedTrackSourceAudioFilter,
	buildNativeVideoExportArgs,
	buildTrimmedSourceAudioFilter,
	getEditedAudioExtension,
	getNativeVideoInputByteSize,
	getPreferredNativeVideoEncoders,
	parseAvailableFfmpegEncoders,
} from "../nativeVideoExport";
import { cachedNativeVideoEncoder, setCachedNativeVideoEncoder } from "../state";
export {
	parseFfmpegDurationSeconds,
	parseFfmpegFrameRate,
	parseNativeVideoMetadataProbeOutput,
	probeNativeVideoMetadata,
	type NativeVideoMetadataProbe,
} from "../ffmpeg/metadata";

const execFileAsync = promisify(execFile);
const getNowMs = () => performance.now();
const formatFfmpegSeconds = (milliseconds: number) => (milliseconds / 1000).toFixed(3);

type ElectronGpuDeviceLike = {
	active?: boolean;
	vendorId?: number | string;
	vendorString?: string;
	deviceString?: string;
};

type ElectronGpuInfoLike = {
	gpuDevice?: ElectronGpuDeviceLike[];
	machineModelName?: string;
	machineModelVersion?: string;
};

export interface ExportHardwareInfo {
	platform: NodeJS.Platform;
	release: string;
	arch: string;
	cpuModel: string | null;
	logicalProcessors: number;
	totalMemoryGb: number;
	machineModel: string | null;
	gpus: Array<{
		name: string;
		vendor: string | null;
		active: boolean | null;
	}>;
	gpuFeatures: {
		videoDecode: string | null;
		videoEncode: string | null;
		webgl: string | null;
		webgpu: string | null;
	};
}

export type NativeVideoExportSession = {
	ffmpegProcess: ChildProcessByStdio<Writable, null, Readable>;
	outputPath: string;
	inputByteSize: number;
	inputMode: "rawvideo" | "h264-stream";
	maxQueuedWriteBytes: number;
	stderrOutput: string;
	encoderName: string;
	processError: Error | null;
	stdinError: Error | null;
	terminating: boolean;
	writeSequence: Promise<void>;
	completionPromise: Promise<void>;
	sender: WebContents | null;
	pendingWriteRequestIds: Set<number>;
};

export const nativeVideoExportSessions = new Map<string, NativeVideoExportSession>();

type NativeVideoAudioMuxProgress = {
	ratio: number;
	processedSec?: number;
	totalSec?: number;
};

type NativeVideoAudioMuxArgsOptions = {
	progressPipe?: 1 | 2;
};

export interface NativeVideoStreamStatsProbe {
	durationSec: number | null;
	frameCount: number | null;
	frameRate: number | null;
}

export function cleanupNativeVideoExportSessions() {
	for (const [sessionId, session] of nativeVideoExportSessions) {
		session.terminating = true;
		try {
			if (!session.ffmpegProcess.stdin.destroyed) {
				session.ffmpegProcess.stdin.destroy();
			}
		} catch {
			/* stream may already be closed */
		}
		try {
			session.ffmpegProcess.kill("SIGKILL");
		} catch {
			/* process may already be exited */
		}
		nativeVideoExportSessions.delete(sessionId);
	}
}

function parseRationalFrameRate(value: unknown) {
	if (typeof value !== "string") {
		return null;
	}
	const [numeratorRaw, denominatorRaw] = value.split("/");
	const numerator = Number(numeratorRaw);
	const denominator = Number(denominatorRaw);
	if (
		!Number.isFinite(numerator) ||
		!Number.isFinite(denominator) ||
		numerator <= 0 ||
		denominator <= 0
	) {
		return null;
	}

	return numerator / denominator;
}

function parseOptionalPositiveNumber(value: unknown) {
	const parsed =
		typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseOptionalPositiveInteger(value: unknown) {
	const parsed = parseOptionalPositiveNumber(value);
	return parsed === null ? null : Math.max(0, Math.round(parsed));
}

export function parseNativeVideoStreamStatsProbeOutput(
	output: string,
): NativeVideoStreamStatsProbe | null {
	const parsed = JSON.parse(output) as {
		streams?: Array<{
			duration?: unknown;
			nb_frames?: unknown;
			nb_read_frames?: unknown;
			avg_frame_rate?: unknown;
			r_frame_rate?: unknown;
		}>;
	};
	const stream = parsed.streams?.[0];
	if (!stream) {
		return null;
	}

	return {
		durationSec: parseOptionalPositiveNumber(stream.duration),
		frameCount:
			parseOptionalPositiveInteger(stream.nb_read_frames) ??
			parseOptionalPositiveInteger(stream.nb_frames),
		frameRate:
			parseRationalFrameRate(stream.avg_frame_rate) ??
			parseRationalFrameRate(stream.r_frame_rate),
	};
}

export function validateNativeVideoStreamStats(
	stats: NativeVideoStreamStatsProbe,
	expected: {
		durationSec: number;
		targetFrames: number;
	},
) {
	const issues: string[] = [];
	const expectedFrames = Math.max(1, Math.round(expected.targetFrames));
	const minimumFrames = Math.max(1, Math.floor(expectedFrames * 0.95));
	const expectedDurationSec = Math.max(0, expected.durationSec);
	const durationToleranceSec = Math.min(2, Math.max(0.5, expectedDurationSec * 0.02));

	if (stats.frameCount === null) {
		issues.push("missing video frame count");
	} else if (stats.frameCount < minimumFrames) {
		issues.push(`video frames ${stats.frameCount} below expected minimum ${minimumFrames}`);
	}

	if (stats.durationSec === null) {
		issues.push("missing video stream duration");
	} else if (Math.abs(stats.durationSec - expectedDurationSec) > durationToleranceSec) {
		issues.push(
			`video stream duration ${stats.durationSec.toFixed(
				3,
			)}s differs from expected ${expectedDurationSec.toFixed(3)}s`,
		);
	}

	return issues;
}

export async function probeNativeVideoStreamStats(
	ffprobePath: string,
	inputPath: string,
): Promise<NativeVideoStreamStatsProbe> {
	const result = await execFileAsync(
		ffprobePath,
		[
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-count_frames",
			"-show_entries",
			"stream=duration,nb_frames,nb_read_frames,avg_frame_rate,r_frame_rate",
			"-of",
			"json",
			inputPath,
		],
		{ timeout: 120_000, maxBuffer: 2 * 1024 * 1024 },
	);
	const stats = parseNativeVideoStreamStatsProbeOutput(result.stdout);
	if (!stats) {
		throw new Error("Unable to parse native video stream stats from FFprobe output");
	}

	return stats;
}

export function getNativeVideoExportMaxQueuedWriteBytes(inputByteSize: number) {
	if (inputByteSize === 0) return 8 * 1024 * 1024;
	return Math.min(64 * 1024 * 1024, Math.max(16 * 1024 * 1024, inputByteSize * 4));
}

function parseFfmpegProgressClockSeconds(value: string) {
	const match = value.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
	if (!match) {
		return null;
	}

	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	const seconds = Number(match[3]);
	if (![hours, minutes, seconds].every(Number.isFinite)) {
		return null;
	}

	return hours * 3600 + minutes * 60 + seconds;
}

export function parseFfmpegProgressLineSeconds(line: string) {
	const separatorIndex = line.indexOf("=");
	if (separatorIndex <= 0) {
		return null;
	}

	const key = line.slice(0, separatorIndex).trim();
	const value = line.slice(separatorIndex + 1).trim();
	if (key === "out_time_us" || key === "out_time_ms") {
		const microseconds = Number(value);
		return Number.isFinite(microseconds) && microseconds >= 0 ? microseconds / 1_000_000 : null;
	}
	if (key === "out_time") {
		return parseFfmpegProgressClockSeconds(value);
	}

	return null;
}

function createFfmpegMuxProgressHandler(
	totalSec: number | undefined,
	onProgress?: (progress: NativeVideoAudioMuxProgress) => void,
) {
	if (!onProgress || !Number.isFinite(totalSec) || !totalSec || totalSec <= 0) {
		return () => undefined;
	}

	let lineBuffer = "";
	let lastRatio = 0;
	return (chunk: Buffer | string) => {
		lineBuffer += chunk.toString();
		const lines = lineBuffer.split(/\r?\n/);
		lineBuffer = lines.pop() ?? "";
		for (const line of lines) {
			const processedSec = parseFfmpegProgressLineSeconds(line);
			if (processedSec === null) {
				continue;
			}
			const ratio = Math.max(0, Math.min(1, processedSec / totalSec));
			if (ratio < lastRatio + 0.0025 && ratio < 1) {
				continue;
			}
			lastRatio = Math.max(lastRatio, ratio);
			onProgress({
				ratio: lastRatio,
				processedSec,
				totalSec,
			});
		}
	};
}

async function runFfmpegAudioMux(
	ffmpegPath: string,
	args: string[],
	timeoutMs: number,
	options: NativeVideoExportFinishOptions,
	onProgress?: (progress: NativeVideoAudioMuxProgress) => void,
	session?: FfmpegProcessSession,
) {
	if (!onProgress && !session) {
		await execFileAsync(ffmpegPath, args, {
			timeout: timeoutMs,
			maxBuffer: 20 * 1024 * 1024,
		});
		return;
	}

	const handleProgressChunk = createFfmpegMuxProgressHandler(
		options.outputDurationSec,
		onProgress,
	);
	await new Promise<void>((resolve, reject) => {
		const child = spawn(ffmpegPath, args, {
			stdio: ["ignore", "ignore", "pipe"],
		});
		if (session) {
			session.currentProcess = child;
			if (session.terminating) {
				child.kill("SIGKILL");
			}
		}

		let stderr = "";
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			child.kill("SIGKILL");
		}, timeoutMs);

		child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stderr += text;
			handleProgressChunk(text);
		});
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			if (session?.currentProcess === child) {
				session.currentProcess = null;
			}
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code, signal) => {
			if (settled) return;
			settled = true;
			if (session?.currentProcess === child) {
				session.currentProcess = null;
			}
			clearTimeout(timeout);
			if (session?.terminating) {
				reject(new Error("Native static layout export was cancelled"));
				return;
			}
			if (code !== 0) {
				const suffix = signal ? ` (signal ${signal})` : "";
				reject(
					new Error(
						`FFmpeg audio mux exited with code ${code ?? "unknown"}${suffix}` +
							(stderr.trim() ? `\nSTDERR:\n${stderr.trim()}` : ""),
					),
				);
				return;
			}
			if (onProgress) {
				const completeProgress: NativeVideoAudioMuxProgress = { ratio: 1 };
				if (
					typeof options.outputDurationSec === "number" &&
					Number.isFinite(options.outputDurationSec)
				) {
					completeProgress.processedSec = options.outputDurationSec;
					completeProgress.totalSec = options.outputDurationSec;
				}
				onProgress(completeProgress);
			}
			resolve();
		});
	});
}

export function isHardwareAcceleratedVideoEncoder(encoderName: string) {
	return /(videotoolbox|nvenc|qsv|amf|mf)/i.test(encoderName);
}

export async function removeTemporaryExportFile(filePath: string | null | undefined) {
	if (!filePath) {
		return;
	}

	try {
		await fs.rm(filePath, { force: true });
	} catch {
		// Ignore cleanup failures for temp export artifacts.
	}
}

export function getNativeVideoExportSessionError(
	session: NativeVideoExportSession,
	fallback: string,
) {
	return (
		session.stdinError?.message ||
		session.processError?.message ||
		session.stderrOutput.trim() ||
		fallback
	);
}

export function sendNativeVideoExportWriteFrameResult(
	sender: WebContents | null | undefined,
	sessionId: string,
	requestId: number,
	result: { success: boolean; error?: string },
) {
	if (!sender || sender.isDestroyed()) {
		return;
	}

	sender.send("native-video-export-write-frame-result", {
		sessionId,
		requestId,
		...result,
	});
}

export function settleNativeVideoExportWriteFrameRequest(
	sessionId: string,
	session: NativeVideoExportSession,
	requestId: number,
	result: { success: boolean; error?: string },
) {
	session.pendingWriteRequestIds.delete(requestId);
	sendNativeVideoExportWriteFrameResult(session.sender, sessionId, requestId, result);
}

export function flushNativeVideoExportPendingWriteRequests(
	sessionId: string,
	session: NativeVideoExportSession,
	error: string,
) {
	for (const requestId of session.pendingWriteRequestIds) {
		sendNativeVideoExportWriteFrameResult(session.sender, sessionId, requestId, {
			success: false,
			error,
		});
	}

	session.pendingWriteRequestIds.clear();
}

export function isIgnorableNativeVideoExportStreamError(error: Error | null | undefined): boolean {
	if (!error) {
		return false;
	}

	const errno = error as NodeJS.ErrnoException;
	return (
		errno.code === "EPIPE" ||
		errno.code === "ERR_STREAM_DESTROYED" ||
		/broken pipe|stream destroyed|eof/i.test(error.message)
	);
}

export async function waitForNativeVideoExportDrain(session: NativeVideoExportSession) {
	if (
		session.stdinError ||
		session.processError ||
		session.ffmpegProcess.stdin.destroyed ||
		session.ffmpegProcess.stdin.writableEnded ||
		!session.ffmpegProcess.stdin.writable ||
		session.ffmpegProcess.stdin.writableLength <= 0
	) {
		return;
	}

	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			reject(
				new Error("Timed out while waiting for native export writer backpressure to clear"),
			);
		}, 15000);

		const cleanup = () => {
			clearTimeout(timeout);
			session.ffmpegProcess.stdin.off("drain", handleDrain);
			session.ffmpegProcess.stdin.off("error", handleError);
			session.ffmpegProcess.off("close", handleClose);
		};

		const handleDrain = () => {
			cleanup();
			resolve();
		};

		const handleError = (error: Error) => {
			cleanup();
			reject(error);
		};

		const handleClose = () => {
			cleanup();
			reject(
				new Error(
					getNativeVideoExportSessionError(
						session,
						"Native video export writer closed before draining",
					),
				),
			);
		};

		session.ffmpegProcess.stdin.once("drain", handleDrain);
		session.ffmpegProcess.stdin.once("error", handleError);
		session.ffmpegProcess.once("close", handleClose);
	});
}

export function getNativeVideoExportFrameLength(frameData: Uint8Array | ArrayBuffer) {
	return frameData.byteLength;
}

export async function writeNativeVideoExportFrame(
	session: NativeVideoExportSession,
	frameData: Uint8Array | ArrayBuffer,
) {
	if (
		session.inputMode !== "h264-stream" &&
		getNativeVideoExportFrameLength(frameData) !== session.inputByteSize
	) {
		throw new Error(
			`Native video export expected ${session.inputByteSize} bytes per frame but received ${getNativeVideoExportFrameLength(frameData)}`,
		);
	}

	if (
		session.stdinError ||
		session.processError ||
		session.ffmpegProcess.stdin.destroyed ||
		session.ffmpegProcess.stdin.writableEnded ||
		!session.ffmpegProcess.stdin.writable
	) {
		throw new Error(
			getNativeVideoExportSessionError(
				session,
				"Native video export encoder is not accepting frames",
			),
		);
	}

	const frameBuffer =
		frameData instanceof ArrayBuffer
			? Buffer.from(frameData)
			: Buffer.from(frameData.buffer, frameData.byteOffset, frameData.byteLength);

	try {
		session.ffmpegProcess.stdin.write(frameBuffer);
	} catch (error) {
		session.stdinError = error instanceof Error ? error : new Error(String(error));
		throw session.stdinError;
	}

	if (session.ffmpegProcess.stdin.writableLength >= session.maxQueuedWriteBytes) {
		try {
			await waitForNativeVideoExportDrain(session);
		} catch (error) {
			session.stdinError = error instanceof Error ? error : new Error(String(error));
			throw session.stdinError;
		}
	}
}

function getGpuVendorLabel(device: ElectronGpuDeviceLike): string | null {
	if (device.vendorString?.trim()) {
		return device.vendorString.trim();
	}

	const rawVendorId = device.vendorId;
	const vendorId =
		typeof rawVendorId === "number"
			? rawVendorId
			: typeof rawVendorId === "string"
				? rawVendorId.toLowerCase().startsWith("0x")
					? Number.parseInt(rawVendorId.slice(2), 16)
					: Number.parseInt(rawVendorId, 10)
				: Number.NaN;
	return (
		{
			[0x1002]: "AMD",
			[0x106b]: "Apple",
			[0x10de]: "NVIDIA",
			[0x8086]: "Intel",
		}[vendorId] ?? null
	);
}

/** Reduces Electron's GPU response to support-safe hardware fields. */
export function sanitizeExportGpuInfo(
	gpuInfo: unknown,
): Pick<ExportHardwareInfo, "machineModel" | "gpus"> {
	if (!gpuInfo || typeof gpuInfo !== "object") {
		return { machineModel: null, gpus: [] };
	}

	const info = gpuInfo as ElectronGpuInfoLike;
	const machineModel =
		[info.machineModelName, info.machineModelVersion]
			.filter((value): value is string => Boolean(value?.trim()))
			.join(" ") || null;
	const gpus = Array.isArray(info.gpuDevice)
		? info.gpuDevice.map((device) => {
				const vendor = getGpuVendorLabel(device);
				return {
					name: device.deviceString?.trim() || vendor || "Unknown GPU",
					vendor,
					active: typeof device.active === "boolean" ? device.active : null,
				};
			})
		: [];

	return { machineModel, gpus };
}

/** Captures sanitized hardware and GPU acceleration details for export support reports. */
export async function getExportHardwareInfo(): Promise<ExportHardwareInfo> {
	let sanitizedGpuInfo: Pick<ExportHardwareInfo, "machineModel" | "gpus"> = {
		machineModel: null,
		gpus: [],
	};
	try {
		sanitizedGpuInfo = sanitizeExportGpuInfo(await app.getGPUInfo("complete"));
	} catch {
		// Hardware diagnostics are best effort and must not affect exporting.
	}

	let gpuFeatureStatus: Record<string, string> = {};
	try {
		gpuFeatureStatus = app.getGPUFeatureStatus() as unknown as Record<string, string>;
	} catch {
		// GPU feature status can be unavailable before Chromium finishes GPU initialization.
	}

	const cpuModel = os.cpus()[0]?.model?.replace(/\s+/g, " ").trim() || null;
	return {
		platform: "darwin",
		release: os.release(),
		arch: "arm64",
		cpuModel,
		logicalProcessors: os.cpus().length,
		totalMemoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
		machineModel: sanitizedGpuInfo.machineModel,
		gpus: sanitizedGpuInfo.gpus,
		gpuFeatures: {
			videoDecode: gpuFeatureStatus.video_decode ?? null,
			videoEncode: gpuFeatureStatus.video_encode ?? null,
			webgl: gpuFeatureStatus.webgl ?? null,
			webgpu: gpuFeatureStatus.webgpu ?? null,
		},
	};
}

export async function enqueueNativeVideoExportFrameWrite(
	session: NativeVideoExportSession,
	frameData: Uint8Array | ArrayBuffer,
) {
	const writePromise = session.writeSequence.then(async () => {
		if (session.terminating) {
			throw new Error("Native video export session was cancelled");
		}

		await writeNativeVideoExportFrame(session, frameData);
	});

	session.writeSequence = writePromise.catch(() => undefined);
	await writePromise;
}

export async function enqueueNativeVideoExportFrameWrites(
	session: NativeVideoExportSession,
	frameDataList: Array<Uint8Array | ArrayBuffer>,
) {
	const writePromise = session.writeSequence.then(async () => {
		if (session.terminating) {
			throw new Error("Native video export session was cancelled");
		}

		for (const frameData of frameDataList) {
			await writeNativeVideoExportFrame(session, frameData);
		}
	});

	session.writeSequence = writePromise.catch(() => undefined);
	await writePromise;
}

export async function getAvailableNativeVideoEncoders(ffmpegPath: string) {
	const { stdout } = await execFileAsync(ffmpegPath, ["-hide_banner", "-encoders"], {
		timeout: 15000,
		maxBuffer: 20 * 1024 * 1024,
	});

	return parseAvailableFfmpegEncoders(stdout);
}

export async function probeNativeVideoEncoder(
	ffmpegPath: string,
	encoderName: string,
	encodingMode: NativeExportEncodingMode,
) {
	const outputPath = path.join(
		app.getPath("temp"),
		`recordly-export-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`,
	);
	const args = buildNativeVideoExportArgs(
		encoderName,
		{
			width: 64,
			height: 64,
			frameRate: 1,
			bitrate: 1_500_000,
			encodingMode,
		},
		outputPath,
	);

	return new Promise<boolean>((resolve) => {
		const process = spawn(ffmpegPath, args, {
			stdio: ["pipe", "ignore", "pipe"],
		});
		let stderrOutput = "";
		const timeout = setTimeout(() => {
			try {
				process.kill("SIGKILL");
			} catch {
				// ignore
			}
			resolve(false);
		}, 15000);

		process.stderr.on("data", (chunk: Buffer) => {
			stderrOutput += chunk.toString();
		});

		process.on("close", (code) => {
			clearTimeout(timeout);
			void removeTemporaryExportFile(outputPath);
			if (code !== 0 && stderrOutput.trim().length > 0) {
				console.warn(
					`[native-export] Encoder probe failed for ${encoderName}:`,
					stderrOutput.trim(),
				);
			}
			resolve(code === 0);
		});

		process.stdin.end(Buffer.alloc(getNativeVideoInputByteSize(64, 64), 0));
	});
}

export async function resolveNativeVideoEncoder(
	ffmpegPath: string,
	encodingMode: NativeExportEncodingMode,
) {
	if (
		cachedNativeVideoEncoder?.ffmpegPath === ffmpegPath &&
		cachedNativeVideoEncoder?.encodingMode === encodingMode
	) {
		return cachedNativeVideoEncoder.encoderName;
	}

	const availableEncoders = await getAvailableNativeVideoEncoders(ffmpegPath);
	const candidates = [...new Set([...getPreferredNativeVideoEncoders("darwin"), "libx264"])];

	for (const encoderName of candidates) {
		if (!availableEncoders.has(encoderName)) {
			continue;
		}

		if (await probeNativeVideoEncoder(ffmpegPath, encoderName, encodingMode)) {
			setCachedNativeVideoEncoder({ ffmpegPath, encodingMode, encoderName });
			return encoderName;
		}
	}

	throw new Error("No usable FFmpeg encoder was available for native export");
}

export function canCopyAudioCodecIntoMp4(codec?: string | null) {
	const normalized = (codec ?? "").trim().toLowerCase();
	if (!normalized) {
		return false;
	}

	return (
		normalized.includes("aac") ||
		normalized.includes("mp4a") ||
		normalized.includes("mpeg-4 audio") ||
		normalized.includes("mp3") ||
		normalized.includes("alac")
	);
}

export function buildNativeVideoAudioMuxArgs(
	videoPath: string,
	audioInputPath: string,
	outputPath: string,
	options: NativeVideoExportFinishOptions,
	argsOptions: NativeVideoAudioMuxArgsOptions = {},
) {
	const audioMode = options.audioMode ?? "none";
	const useEditedTrackFiltergraph =
		audioMode === "edited-track" && options.editedTrackStrategy === "filtergraph-fast-path";
	const args = ["-y", "-hide_banner", "-loglevel", "error"];
	if (argsOptions.progressPipe) {
		args.push(
			"-stats_period",
			"0.5",
			"-progress",
			`pipe:${argsOptions.progressPipe}`,
			"-nostats",
		);
	}
	args.push("-i", videoPath, "-i", audioInputPath);

	if (audioMode === "trim-source") {
		const filter = buildTrimmedSourceAudioFilter(options.trimSegments ?? []);
		if (filter) {
			args.push("-filter_complex", filter, "-map", "0:v:0", "-map", "[aout]");
		} else {
			args.push("-map", "0:v:0", "-map", "1:a:0");
		}
	} else if (useEditedTrackFiltergraph) {
		const filter = buildEditedTrackSourceAudioFilter(
			options.editedTrackSegments ?? [],
			options.audioSourceSampleRate ?? 0,
		);
		if (!filter) {
			throw new Error("Edited-track filtergraph inputs are incomplete for native export");
		}
		if (
			typeof options.outputDurationSec === "number" &&
			Number.isFinite(options.outputDurationSec) &&
			options.outputDurationSec > 0
		) {
			const duration = formatFfmpegSeconds(options.outputDurationSec * 1000);
			args.push(
				"-filter_complex",
				`${filter};[aout]apad,atrim=duration=${duration},asetpts=PTS-STARTPTS[aout_sync]`,
				"-map",
				"0:v:0",
				"-map",
				"[aout_sync]",
			);
		} else {
			args.push("-filter_complex", filter, "-map", "0:v:0", "-map", "[aout]");
		}
	} else {
		args.push("-map", "0:v:0", "-map", "1:a:0");
	}

	args.push("-c:v", "copy");
	if (audioMode === "copy-source" && canCopyAudioCodecIntoMp4(options.audioSourceCodec)) {
		args.push("-c:a", "copy");
	} else {
		args.push("-c:a", "aac", "-b:a", "192k");
	}
	if (
		typeof options.outputDurationSec === "number" &&
		Number.isFinite(options.outputDurationSec) &&
		options.outputDurationSec > 0
	) {
		args.push("-t", formatFfmpegSeconds(options.outputDurationSec * 1000));
	} else if (audioMode !== "copy-source") {
		args.push("-shortest");
	}
	args.push("-movflags", "+faststart", outputPath);

	return args;
}

export async function muxNativeVideoExportAudio(
	videoPath: string,
	options: NativeVideoExportFinishOptions,
	onProgress?: (progress: NativeVideoAudioMuxProgress) => void,
	session?: FfmpegProcessSession,
) {
	const audioMode = options.audioMode ?? "none";
	if (audioMode === "none") {
		return {
			outputPath: videoPath,
			metrics: {} as NativeVideoAudioMuxMetrics,
		};
	}

	const ffmpegPath = getFfmpegBinaryPath();
	const metrics: NativeVideoAudioMuxMetrics = {};
	const tempArtifacts: string[] = [];
	let audioInputPath = options.audioSourcePath ?? null;
	const useEditedTrackFiltergraph =
		audioMode === "edited-track" && options.editedTrackStrategy === "filtergraph-fast-path";

	if (audioMode === "edited-track" && !useEditedTrackFiltergraph) {
		if (!options.editedAudioData) {
			throw new Error("Edited audio data is missing for native export");
		}

		const extension = getEditedAudioExtension(options.editedAudioMimeType);
		audioInputPath = path.join(
			app.getPath("temp"),
			`recordly-export-audio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`,
		);
		const tempAudioWriteStartedAt = getNowMs();
		await fs.writeFile(audioInputPath, Buffer.from(options.editedAudioData));
		metrics.tempEditedAudioWriteMs = getNowMs() - tempAudioWriteStartedAt;
		metrics.tempEditedAudioBytes = options.editedAudioData.byteLength;
		tempArtifacts.push(audioInputPath);
	}

	if (!audioInputPath) {
		return {
			outputPath: videoPath,
			metrics,
		};
	}

	const outputPath = path.join(
		path.dirname(videoPath),
		`${path.basename(videoPath, path.extname(videoPath))}-final.mp4`,
	);

	const args = buildNativeVideoAudioMuxArgs(
		videoPath,
		audioInputPath,
		outputPath,
		options,
		onProgress ? { progressPipe: 2 } : {},
	);

	try {
		const ffmpegExecStartedAt = getNowMs();
		await runFfmpegAudioMux(ffmpegPath, args, 15 * 60 * 1000, options, onProgress, session);
		metrics.ffmpegExecMs = getNowMs() - ffmpegExecStartedAt;
		console.info("[native-video-export] Audio mux completed", {
			ffmpegExecMs: metrics.ffmpegExecMs,
			audioMode: options.audioMode,
			tempVideoBytes: metrics.tempVideoBytes,
			muxedVideoBytes: metrics.muxedVideoBytes,
		});
		await removeTemporaryExportFile(videoPath);
		return {
			outputPath,
			metrics,
		};
	} finally {
		await Promise.allSettled(
			tempArtifacts.map((artifactPath) => removeTemporaryExportFile(artifactPath)),
		);
	}
}

export async function muxExportedVideoAudioBuffer(
	videoData: ArrayBuffer,
	options: NativeVideoExportFinishOptions,
) {
	const tempVideoPath = path.join(
		app.getPath("temp"),
		`recordly-export-video-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`,
	);
	const metrics: NativeVideoAudioMuxMetrics = {};
	let succeeded = false;
	let outputPath = tempVideoPath;

	try {
		const tempVideoWriteStartedAt = getNowMs();
		await fs.writeFile(tempVideoPath, Buffer.from(videoData));
		metrics.tempVideoWriteMs = getNowMs() - tempVideoWriteStartedAt;
		metrics.tempVideoBytes = videoData.byteLength;
		const finalized = await muxNativeVideoExportAudio(tempVideoPath, options);
		Object.assign(metrics, finalized.metrics);
		outputPath = finalized.outputPath;
		// Record byte size via stat instead of reading the whole file into a
		// Buffer — fs.readFile throws ERR_FS_FILE_TOO_LARGE on >2 GiB outputs.
		try {
			const stat = await fs.stat(outputPath);
			metrics.muxedVideoBytes = stat.size;
		} catch {
			// Stat failures are non-fatal; size is purely metric data.
		}
		succeeded = true;
		return {
			outputPath,
			metrics,
		};
	} finally {
		// Always remove the unmuxed intermediate when the muxer wrote a separate
		// file. Only remove the muxed output on failure — on success the caller
		// owns it and is responsible for moving/deleting it.
		const cleanupTargets: string[] = [];
		if (outputPath !== tempVideoPath) {
			cleanupTargets.push(tempVideoPath);
		}
		if (!succeeded) {
			cleanupTargets.push(outputPath);
		}
		if (cleanupTargets.length > 0) {
			await Promise.allSettled(
				cleanupTargets.map((target) => removeTemporaryExportFile(target)),
			);
		}
	}
}

interface FfmpegProcessSession {
	terminating: boolean;
	currentProcess: ChildProcessByStdio<null, null, Readable> | null;
}
