import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: {
		getAppPath: vi.fn(() => process.cwd()),
		getGPUFeatureStatus: vi.fn(() => ({
			video_decode: "enabled",
			video_encode: "enabled",
			webgl: "enabled",
			webgpu: "enabled",
		})),
		getGPUInfo: vi.fn(async () => ({ gpuDevice: [] })),
		getPath: vi.fn(() => process.env.TEMP ?? process.cwd()),
		isPackaged: false,
	},
}));

vi.mock("../ffmpeg/binary", () => ({
	getFfmpegBinaryPath: vi.fn(() => "ffmpeg"),
	getFfprobeBinaryPath: vi.fn(() => "ffprobe"),
}));

vi.mock("../state", () => ({
	cachedNativeVideoEncoder: null,
	setCachedNativeVideoEncoder: vi.fn(),
}));

const fsMocks = vi.hoisted(() => ({
	access: vi.fn(async () => {
		throw new Error("missing");
	}),
	writeFile: vi.fn(async () => undefined),
	readFile: vi.fn(),
	stat: vi.fn(async () => ({ size: 5_000_000_000 })),
	unlink: vi.fn(async () => undefined),
}));

vi.mock("node:fs/promises", () => ({
	default: fsMocks,
	...fsMocks,
}));

const execFileMock = vi.hoisted(() =>
	vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
		cb(null);
		return { stdout: "", stderr: "" } as unknown;
	}),
);

vi.mock("node:child_process", () => ({
	execFile: execFileMock,
	spawn: vi.fn(),
}));

import { app } from "electron";
import {
	buildNativeVideoAudioMuxArgs,
	canCopyAudioCodecIntoMp4,
	getExportHardwareInfo,
	muxExportedVideoAudioBuffer,
	parseFfmpegDurationSeconds,
	parseFfmpegFrameRate,
	parseFfmpegProgressLineSeconds,
	parseNativeVideoMetadataProbeOutput,
	parseNativeVideoStreamStatsProbeOutput,
	sanitizeExportGpuInfo,
	validateNativeVideoStreamStats,
} from "./native-video";

const electronAppMock = app as unknown as {
	getAppPath: ReturnType<typeof vi.fn>;
	getGPUFeatureStatus: ReturnType<typeof vi.fn>;
	getGPUInfo: ReturnType<typeof vi.fn>;
	isPackaged: boolean;
};

describe("export hardware diagnostics", () => {
	it("sanitizes machine and GPU details without exposing raw device identifiers", () => {
		const hardware = sanitizeExportGpuInfo({
			machineModelName: "MacBookPro",
			machineModelVersion: "18,2",
			gpuDevice: [
				{
					active: true,
					vendorId: "0x10de",
					deviceId: 9999,
					deviceString: "NVIDIA GeForce RTX 4070",
				},
			],
		});

		expect(hardware).toEqual({
			machineModel: "MacBookPro 18,2",
			gpus: [
				{
					name: "NVIDIA GeForce RTX 4070",
					vendor: "NVIDIA",
					active: true,
				},
			],
		});
		expect(JSON.stringify(hardware)).not.toContain("deviceId");
		expect(JSON.stringify(hardware)).not.toContain("vendorId");
	});

	it("returns system capacity and GPU acceleration status", async () => {
		electronAppMock.getGPUInfo.mockResolvedValueOnce({
			gpuDevice: [{ active: true, vendorId: 0x8086 }],
		});

		const hardware = await getExportHardwareInfo();

		expect(electronAppMock.getGPUInfo).toHaveBeenCalledWith("complete");
		expect(hardware).toMatchObject({
			platform: process.platform,
			arch: process.arch,
			gpus: [{ name: "Intel", vendor: "Intel", active: true }],
			gpuFeatures: {
				videoDecode: "enabled",
				videoEncode: "enabled",
				webgl: "enabled",
				webgpu: "enabled",
			},
		});
		expect(hardware.logicalProcessors).toBeGreaterThan(0);
		expect(hardware.totalMemoryGb).toBeGreaterThan(0);
	});
});

describe("muxExportedVideoAudioBuffer", () => {
	it("returns the muxed output path without reading the muxed file into memory", async () => {
		const videoData = new ArrayBuffer(64);
		const result = await muxExportedVideoAudioBuffer(videoData, { audioMode: "none" });

		expect(typeof result.outputPath).toBe("string");
		expect(result.outputPath.length).toBeGreaterThan(0);
		// The >2 GiB fix relies on stat-only metric collection; readFile must stay unused.
		expect(fsMocks.readFile).not.toHaveBeenCalled();
		expect(result.metrics.muxedVideoBytes).toBe(5_000_000_000);
	});

	it("preserves the input temp path when audioMode='none' (no re-mux)", async () => {
		const videoData = new ArrayBuffer(32);
		const result = await muxExportedVideoAudioBuffer(videoData, { audioMode: "none" });

		expect(result.outputPath).toMatch(/recordly-export-video-/);
	});
});

describe("buildNativeVideoAudioMuxArgs", () => {
	it("stream-copies source audio and preserves the requested video duration", () => {
		const args = buildNativeVideoAudioMuxArgs("video.mp4", "source.mp4", "out.mp4", {
			audioMode: "copy-source",
			audioSourceCodec: "aac (LC) (mp4a / 0x6134706D)",
			outputDurationSec: 60,
		});

		expect(args).toEqual(
			expect.arrayContaining([
				"-map",
				"0:v:0",
				"-map",
				"1:a:0",
				"-c:v",
				"copy",
				"-c:a",
				"copy",
				"-t",
				"60.000",
			]),
		);
		expect(args).not.toContain("-shortest");
	});

	it("does not shorten copy-source muxes when no explicit duration is available", () => {
		const args = buildNativeVideoAudioMuxArgs("video.mp4", "source.mp4", "out.mp4", {
			audioMode: "copy-source",
			audioSourceCodec: "aac",
		});

		expect(args).toEqual(expect.arrayContaining(["-c:a", "copy"]));
		expect(args).not.toContain("-shortest");
	});

	it("transcodes WebM/Opus source audio when muxing into MP4", () => {
		const args = buildNativeVideoAudioMuxArgs("video.mp4", "source.webm", "out.mp4", {
			audioMode: "copy-source",
			audioSourceCodec: "opus",
			outputDurationSec: 60,
		});

		expect(args).toEqual(expect.arrayContaining(["-c:a", "aac", "-b:a", "192k"]));
		expect(args.join(";")).not.toContain("-c:a;copy");
	});

	it("transcodes unknown source audio instead of copying unsafe codecs into MP4", () => {
		const args = buildNativeVideoAudioMuxArgs("video.mp4", "source.wav", "out.mp4", {
			audioMode: "copy-source",
			outputDurationSec: 60,
		});

		expect(args).toEqual(expect.arrayContaining(["-c:a", "aac", "-b:a", "192k"]));
		expect(args.join(";")).not.toContain("-c:a;copy");
	});

	it("keeps filtered audio on the AAC encode path", () => {
		const args = buildNativeVideoAudioMuxArgs("video.mp4", "source.mp4", "out.mp4", {
			audioMode: "trim-source",
			trimSegments: [{ startMs: 0, endMs: 1_000 }],
			outputDurationSec: 1,
		});

		expect(args).toEqual(expect.arrayContaining(["-filter_complex"]));
		expect(args).toEqual(expect.arrayContaining(["-c:a", "aac", "-b:a", "192k"]));
	});

	it("pads and trims edited-track filtergraph audio to the expected duration", () => {
		const args = buildNativeVideoAudioMuxArgs("video.mp4", "source.mp4", "out.mp4", {
			audioMode: "edited-track",
			editedTrackStrategy: "filtergraph-fast-path",
			audioSourceSampleRate: 48_000,
			editedTrackSegments: [{ startMs: 0, endMs: 4_000, speed: 0.5 }],
			outputDurationSec: 8,
		});

		expect(args).toEqual(expect.arrayContaining(["-map", "[aout_sync]"]));
		expect(args.join(";")).toContain(
			"[aout]apad,atrim=duration=8.000,asetpts=PTS-STARTPTS[aout_sync]",
		);
	});

	it("can enable machine-readable FFmpeg mux progress", () => {
		const args = buildNativeVideoAudioMuxArgs(
			"video.mp4",
			"source.mp4",
			"out.mp4",
			{ audioMode: "copy-source", audioSourceCodec: "aac", outputDurationSec: 60 },
			{ progressPipe: 2 },
		);

		expect(args).toEqual(
			expect.arrayContaining(["-stats_period", "0.5", "-progress", "pipe:2", "-nostats"]),
		);
	});
});

describe("canCopyAudioCodecIntoMp4", () => {
	it("allows common MP4-compatible audio codecs", () => {
		expect(canCopyAudioCodecIntoMp4("aac (LC) (mp4a / 0x6134706D)")).toBe(true);
		expect(canCopyAudioCodecIntoMp4("mp3")).toBe(true);
	});

	it("blocks Opus so native exports transcode it to AAC for MP4", () => {
		expect(canCopyAudioCodecIntoMp4("opus")).toBe(false);
	});

	it("blocks unknown codecs so sidecar WAV/PCM audio is encoded for MP4", () => {
		expect(canCopyAudioCodecIntoMp4(undefined)).toBe(false);
		expect(canCopyAudioCodecIntoMp4("")).toBe(false);
	});
});

describe("validateNativeVideoStreamStats", () => {
	it("accepts a complete video stream", () => {
		expect(
			validateNativeVideoStreamStats(
				{ durationSec: 45, frameCount: 1350, frameRate: 30 },
				{ durationSec: 45, targetFrames: 1350 },
			),
		).toEqual([]);
	});

	it("rejects files with container duration but too few video frames", () => {
		expect(
			validateNativeVideoStreamStats(
				{ durationSec: 0.067, frameCount: 2, frameRate: 30 },
				{ durationSec: 45, targetFrames: 1350 },
			),
		).toEqual([
			"video frames 2 below expected minimum 1282",
			"video stream duration 0.067s differs from expected 45.000s",
		]);
	});
});

describe("parseNativeVideoStreamStatsProbeOutput", () => {
	it("parses FFprobe count-frame JSON output", () => {
		expect(
			parseNativeVideoStreamStatsProbeOutput(
				JSON.stringify({
					streams: [
						{
							duration: "44.999000",
							nb_read_frames: "1349",
							avg_frame_rate: "30000/1001",
						},
					],
				}),
			),
		).toEqual({
			durationSec: 44.999,
			frameCount: 1349,
			frameRate: 30000 / 1001,
		});
	});
});

describe("parseFfmpegProgressLineSeconds", () => {
	it("parses FFmpeg progress timestamps into seconds", () => {
		expect(parseFfmpegProgressLineSeconds("out_time_us=1500000")).toBe(1.5);
		expect(parseFfmpegProgressLineSeconds("out_time_ms=2500000")).toBe(2.5);
		expect(parseFfmpegProgressLineSeconds("out_time=00:01:02.500000")).toBe(62.5);
		expect(parseFfmpegProgressLineSeconds("progress=continue")).toBeNull();
	});
});

describe("parseNativeVideoMetadataProbeOutput", () => {
	it("parses FFmpeg input metadata with video and audio streams", () => {
		const metadata = parseNativeVideoMetadataProbeOutput(`
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'recording.mp4':
  Metadata:
    major_brand     : isom
  Duration: 00:06:04.25, start: 0.000000, bitrate: 3938 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080, 3720 kb/s, 46.05 fps, 60 tbr, 90k tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 192 kb/s (default)
`);

		expect(metadata).toEqual({
			width: 1920,
			height: 1080,
			duration: 364.25,
			mediaStartTime: 0,
			streamStartTime: 0,
			streamDuration: 364.25,
			frameRate: 46.05,
			codec: "h264 (High) (avc1 / 0x31637661)",
			hasAudio: true,
			audioCodec: "aac (LC) (mp4a / 0x6134706D)",
			audioSampleRate: 48000,
		});
	});

	it("parses video-only metadata and falls back to tbr when fps is absent", () => {
		const metadata = parseNativeVideoMetadataProbeOutput(`
Input #0, matroska,webm, from 'recording.webm':
  Duration: 00:00:10.50, start: 0.023000, bitrate: 1000 kb/s
  Stream #0:0: Video: vp9, yuv420p, 1280x720, 30 tbr, 1k tbn
`);

		expect(metadata).toEqual({
			width: 1280,
			height: 720,
			duration: 10.5,
			mediaStartTime: 0.023,
			streamStartTime: 0.023,
			streamDuration: 10.5,
			frameRate: 30,
			codec: "vp9",
			hasAudio: false,
			audioCodec: undefined,
			audioSampleRate: undefined,
		});
	});

	it("rejects output without usable video metadata", () => {
		expect(parseNativeVideoMetadataProbeOutput("Duration: N/A")).toBeNull();
		expect(parseNativeVideoMetadataProbeOutput("not a media file")).toBeNull();
	});
});

describe("parseFfmpegDurationSeconds", () => {
	it("parses HH:MM:SS timestamps", () => {
		expect(parseFfmpegDurationSeconds("01:02:03.5")).toBe(3723.5);
		expect(parseFfmpegDurationSeconds("bad")).toBeNull();
	});
});

describe("parseFfmpegFrameRate", () => {
	it("prefers fps and falls back to tbr", () => {
		expect(parseFfmpegFrameRate("Video: h264, 1920x1080, 59.94 fps, 60 tbr")).toBe(59.94);
		expect(parseFfmpegFrameRate("Video: h264, 1920x1080, 30 tbr")).toBe(30);
		expect(parseFfmpegFrameRate("Video: h264")).toBeNull();
	});
});
