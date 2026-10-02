import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";

const execFileAsync = promisify(execFile);
const TARGET_LOUDNESS_LUFS = -18;
const MAX_GAIN_DB = 18;
const PEAK_HEADROOM_DB = -1.5;

export function getMicrophoneLevelGain(loudness: number, truePeak: number): number {
	// Silence or an invalid measurement must not turn into amplified background noise.
	if (
		!Number.isFinite(loudness) ||
		!Number.isFinite(truePeak) ||
		loudness < -60 ||
		truePeak < -50
	)
		return 0;
	return Math.max(
		0,
		Math.min(TARGET_LOUDNESS_LUFS - loudness, MAX_GAIN_DB, PEAK_HEADROOM_DB - truePeak),
	);
}

export function parseMicrophoneLevel(stderr: string) {
	const match = stderr.match(/\{\s*"input_i"[\s\S]*?\}/);
	if (!match) throw new Error("Microphone loudness measurement missing");
	const value = JSON.parse(match[0]);
	return { loudness: Number(value.input_i), truePeak: Number(value.input_tp) };
}

// Apply one constant, measured gain: retain the voice's dynamics and timing.
// The original remains recoverable; a marker prevents recovery from applying gain twice.
export async function normalizeRecordedMicrophone(microphonePath: string) {
	const markerPath = `${microphonePath}.level.json`;
	try {
		const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
		const stat = await fs.stat(microphonePath);
		if (marker.size === stat.size && marker.mtimeMs === stat.mtimeMs) return;
	} catch {
		/* no completed normalization */
	}
	const ffmpeg = getFfmpegBinaryPath();
	const { stderr } = await execFileAsync(
		ffmpeg,
		[
			"-hide_banner",
			"-nostdin",
			"-nostats",
			"-i",
			microphonePath,
			"-map",
			"0:a:0",
			"-af",
			"loudnorm=I=-18:TP=-1.5:print_format=json",
			"-f",
			"null",
			"-",
		],
		{ timeout: 120000, maxBuffer: 1024 * 1024 },
	);
	const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
	if (!durationMatch) throw new Error("Microphone duration measurement missing");
	const duration =
		Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
	if (!Number.isFinite(duration) || duration <= 0) return;
	const level = parseMicrophoneLevel(stderr);
	const gainDb = getMicrophoneLevelGain(level.loudness, level.truePeak);
	if (gainDb < 0.5) return;
	const extension = path.extname(microphonePath);
	const outputPath = `${microphonePath}.${randomUUID()}.level${extension}`;
	const originalPath = `${microphonePath}.original`;
	try {
		await execFileAsync(
			ffmpeg,
			[
				"-y",
				"-hide_banner",
				"-nostdin",
				"-nostats",
				"-copyts",
				"-i",
				microphonePath,
				"-map",
				"0:a:0",
				"-af",
				// Preserve initial capture offset as silence rather than shifting speech earlier.
				`volume=${gainDb.toFixed(3)}dB,aresample=async=1:first_pts=0,apad`,
				"-t",
				String(duration),
				"-ar",
				"48000",
				"-c:a",
				extension === ".wav" ? "pcm_s16le" : "aac",
				...(extension === ".wav" ? [] : ["-b:a", "192k"]),
				outputPath,
			],
			{ timeout: 120000, maxBuffer: 1024 * 1024 },
		);
		const outputStat = await fs.stat(outputPath);
		if (!outputStat.size) throw new Error("Microphone leveling produced an empty file");
		await fs.copyFile(microphonePath, originalPath, fs.constants.COPYFILE_EXCL);
		await fs.rename(outputPath, microphonePath);
		const stat = await fs.stat(microphonePath);
		await fs.writeFile(
			markerPath,
			JSON.stringify({ ...level, gainDb, size: stat.size, mtimeMs: stat.mtimeMs }),
		);
		console.info(
			`[microphone-level] Applied ${gainDb.toFixed(1)} dB to ${path.basename(microphonePath)}`,
		);
	} finally {
		await fs.rm(outputPath, { force: true });
	}
}
