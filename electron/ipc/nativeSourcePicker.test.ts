import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execFile: vi.fn(),
	access: vi.fn(),
	readFile: vi.fn(),
	rm: vi.fn(),
	windows: [] as unknown[],
	hud: null as unknown,
	appOn: vi.fn(),
}));
vi.mock("electron", () => ({
	app: { on: mocks.appOn },
	BrowserWindow: { getAllWindows: () => mocks.windows },
}));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("./paths/binaries", () => ({
	getPrebundledNativeHelperPath: () => "/Recordly Picker.app",
}));
vi.mock("node:fs/promises", () => ({
	default: {
		access: mocks.access,
		mkdtemp: vi.fn(async () => "/tmp/picker-request"),
		readFile: mocks.readFile,
		rm: mocks.rm,
	},
}));
vi.mock("../windows", () => ({ getHudOverlayWindow: () => mocks.hud }));
import { parsePickerResult, pickNativeSource } from "./nativeSourcePicker";

const source = { id: "window:42:0", sourceType: "window", name: "Example", display_id: "" };
const makeWindow = () => ({
	isDestroyed: () => false,
	isVisible: () => true,
	getMediaSourceId: () => "window:9:0",
	hide: vi.fn(),
	showInactive: vi.fn(),
});
const makeSender = () => Object.assign(new EventEmitter(), { isDestroyed: () => false });

beforeEach(() => {
	vi.clearAllMocks();
	mocks.access.mockResolvedValue(undefined);
	mocks.rm.mockResolvedValue(undefined);
	mocks.readFile.mockResolvedValue(JSON.stringify({ source }));
	mocks.windows = [makeWindow(), makeWindow()];
	mocks.hud = mocks.windows[0];
});

describe("system capture picker", () => {
	it("accepts only a target matching the requested mode", () => {
		expect(parsePickerResult(JSON.stringify({ source }), "window")).toEqual({
			success: true,
			source,
		});
		expect(() => parsePickerResult(JSON.stringify({ source }), "screen")).toThrow();
		expect(() =>
			parsePickerResult(
				'{"source":{"name":"x","id":"window:NaN:0","sourceType":"window"}}',
				"window",
			),
		).toThrow();
		expect(parsePickerResult('{"cancelled":true}', "window")).toEqual({
			success: false,
			cancelled: true,
		});
		const display = {
			id: "screen:fallback:7",
			name: "Screen",
			sourceType: "screen",
			display_id: "7",
		};
		expect(parsePickerResult(JSON.stringify({ source: display }), "screen")).toEqual({
			success: true,
			source: display,
		});
	});

	it("hides app windows and only restores the HUD after selection", async () => {
		mocks.execFile.mockImplementation((_path, _args, _opts, callback) => {
			queueMicrotask(() => callback(null, JSON.stringify({ source }), ""));
			return { kill: vi.fn() };
		});
		const sender = makeSender();
		const result = await pickNativeSource("window", sender as never);
		expect(result.success).toBe(true);
		expect(mocks.execFile.mock.calls[0][0]).toBe("/usr/bin/open");
		expect(mocks.execFile.mock.calls[0][1]).toEqual(
			expect.arrayContaining([
				"-n",
				"-W",
				"-a",
				"/Recordly Picker.app",
				"--args",
				"--pick",
				"window",
			]),
		);
		expect(mocks.rm).toHaveBeenCalledWith("/tmp/picker-request", {
			recursive: true,
			force: true,
		});
		const [hud, dashboard] = mocks.windows as ReturnType<typeof makeWindow>[];
		expect(hud.hide).toHaveBeenCalledOnce();
		expect(dashboard.hide).toHaveBeenCalledOnce();
		expect(hud.showInactive).toHaveBeenCalledOnce();
		expect(dashboard.showInactive).not.toHaveBeenCalled();
		expect(sender.listenerCount("destroyed")).toBe(0);
	});

	it.each([
		"cancel",
		"error",
		"invalid",
	])("restores all windows after %s and permits another attempt", async (kind) => {
		mocks.readFile.mockResolvedValue(
			kind === "invalid" ? "invalid-json" : '{"cancelled":true}',
		);
		mocks.execFile.mockImplementation((_path, _args, _opts, callback) => {
			queueMicrotask(() =>
				callback(
					kind === "error" ? new Error("Unavailable") : null,
					kind === "invalid" ? "invalid-json" : '{"cancelled":true}',
					"",
				),
			);
			return { kill: vi.fn() };
		});
		const sender = makeSender();
		expect((await pickNativeSource("window", sender as never)).success).toBe(false);
		for (const win of mocks.windows as ReturnType<typeof makeWindow>[])
			expect(win.showInactive).toHaveBeenCalledOnce();
		await pickNativeSource("window", sender as never);
		expect(mocks.execFile).toHaveBeenCalledTimes(2);
	});

	it("prevents concurrent pickers and kills the helper when its renderer closes", async () => {
		let finish!: () => void;
		const kill = vi.fn(() => finish());
		mocks.execFile.mockImplementation((_path, _args, _opts, callback) => {
			finish = () => callback(new Error("killed"), "", "");
			return { kill };
		});
		const sender = makeSender();
		const first = pickNativeSource("window", sender as never);
		await vi.waitFor(() => expect(mocks.execFile).toHaveBeenCalledOnce());
		expect(await pickNativeSource("screen", sender as never)).toEqual({
			success: false,
			cancelled: true,
		});
		sender.emit("destroyed");
		await first;
		expect(kill).toHaveBeenCalledOnce();
	});
});
