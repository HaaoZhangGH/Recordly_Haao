import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../ffmpeg/binary", () => ({
	getFfmpegBinaryPath: () => path.join(process.cwd(), "node_modules/ffmpeg-static/ffmpeg"),
}));
import {
	getMicrophoneLevelGain,
	normalizeRecordedMicrophone,
	parseMicrophoneLevel,
} from "./microphoneLevel";
const run = promisify(execFile);
const ffmpeg = path.join(process.cwd(), "node_modules/ffmpeg-static/ffmpeg");
const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("microphone level", () => {
	it("raises quiet speech without exceeding true peak headroom or gain cap", () => {
		expect(getMicrophoneLevelGain(-40, -16.8)).toBeCloseTo(15.3);
		expect(getMicrophoneLevelGain(-50, -35)).toBe(18);
		expect(getMicrophoneLevelGain(-25, -2)).toBe(0.5);
	});
	it("leaves normal, loud, silent and invalid inputs unchanged", () => {
		for (const pair of [
			[-17, -4],
			[-40, 0],
			[-Infinity, -Infinity],
			[-65, -55],
			[NaN, -20],
		])
			expect(getMicrophoneLevelGain(pair[0], pair[1])).toBe(0);
	});
	it("parses measured input levels, not output levels", () => {
		expect(
			parseMicrophoneLevel('log\n{"input_i":"-39.9","input_tp":"-16.8","output_i":"-18"}'),
		).toEqual({ loudness: -39.9, truePeak: -16.8 });
	});
	it("preserves the original and does not apply gain twice", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-mic-test-"));
		dirs.push(dir);
		const mic = path.join(dir, "test.mic.m4a");
		await run(ffmpeg, [
			"-y",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=500:duration=1",
			"-af",
			"volume=0.1",
			"-c:a",
			"aac",
			"-output_ts_offset",
			"0.044",
			mic,
		]);
		const probe = path.join(
			process.cwd(),
			"node_modules/ffprobe-static/bin/darwin/arm64/ffprobe",
		);
		const duration = async () =>
			Number(
				JSON.parse(
					(
						await run(probe, [
							"-v",
							"error",
							"-show_entries",
							"format=duration",
							"-of",
							"json",
							mic,
						])
					).stdout,
				).format.duration,
			);
		const originalDuration = await duration();
		const original = await fs.readFile(mic);
		await normalizeRecordedMicrophone(mic);
		expect(await fs.readFile(`${mic}.original`)).toEqual(original);
		// AAC container durations can differ by one packet plus rounded metadata.
		expect(Math.abs((await duration()) - originalDuration)).toBeLessThan(0.03);
		const adjusted = await fs.readFile(mic);
		expect(adjusted).not.toEqual(original);
		await normalizeRecordedMicrophone(mic);
		expect(await fs.readFile(mic)).toEqual(adjusted);
		const { stderr } = await run(ffmpeg, [
			"-i",
			mic,
			"-af",
			"loudnorm=print_format=json",
			"-f",
			"null",
			"-",
		]);
		const measured = parseMicrophoneLevel(stderr);
		expect(measured.loudness).toBeGreaterThan(-25);
		expect(measured.truePeak).toBeLessThan(-1);
	}, 15000);
});
