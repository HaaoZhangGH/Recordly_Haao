import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	active: true,
	paused: false,
	timeMs: 100,
	point: { cx: 0.5, cy: 0.5 },
	lastClick: null as { timeMs: number; cx: number; cy: number } | null,
	push: vi.fn(),
}));

vi.mock("../state", () => ({
	get isCursorCaptureActive() {
		return state.active;
	},
	get lastLeftClick() {
		return state.lastClick;
	},
	setLastLeftClick: (click: typeof state.lastClick) => {
		state.lastClick = click;
	},
}));
vi.mock("./telemetry", () => ({
	getCursorCaptureElapsedMs: () => state.timeMs,
	getNormalizedCursorPoint: () => state.point,
	isCursorCapturePaused: () => state.paused,
	pushCursorSample: state.push,
}));

import { recordCursorMouseDown, recordCursorMouseUp } from "./interaction";

beforeEach(() => {
	state.active = true;
	state.paused = false;
	state.timeMs = 100;
	state.point = { cx: 0.5, cy: 0.5 };
	state.lastClick = null;
	state.push.mockClear();
});

it("preserves double-click telemetry delivered by the native Mac monitor", () => {
	recordCursorMouseDown(1);
	state.timeMs = 250;
	recordCursorMouseDown(1);
	expect(state.push.mock.calls.map((call) => call[3])).toEqual(["click", "double-click"]);
	state.point = { cx: 0.7, cy: 0.5 };
	state.timeMs = 300;
	recordCursorMouseDown(1);
	expect(state.push).toHaveBeenLastCalledWith(0.7, 0.5, 300, "click");
});

it("ignores events while capture is paused or inactive", () => {
	state.paused = true;
	recordCursorMouseDown(1);
	recordCursorMouseUp();
	state.paused = false;
	state.active = false;
	recordCursorMouseDown(2);
	expect(state.push).not.toHaveBeenCalled();
});

it("preserves right-click, middle-click and release events", () => {
	recordCursorMouseDown(2);
	recordCursorMouseDown(3);
	recordCursorMouseUp();
	expect(state.push.mock.calls.map((call) => call[3])).toEqual([
		"right-click",
		"middle-click",
		"mouseup",
	]);
});
