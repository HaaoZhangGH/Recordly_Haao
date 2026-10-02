import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	trusted: vi.fn(),
}));
vi.mock("electron", () => ({
	ipcMain: {
		handle: (name: string, handler: (...args: unknown[]) => unknown) =>
			mocks.handlers.set(name, handler),
	},
	shell: { openExternal: vi.fn() },
	systemPreferences: { isTrustedAccessibilityClient: mocks.trusted },
}));
vi.mock("../utils", () => ({ getMacPrivacySettingsUrl: vi.fn() }));
import { registerPermissionHandlers } from "./permissions";

describe("accessibility permission requests", () => {
	beforeEach(() => {
		mocks.handlers.clear();
		mocks.trusted.mockReset().mockReturnValue(false);
		registerPermissionHandlers();
	});
	it("registration and status checks never prompt", () => {
		expect(mocks.trusted).not.toHaveBeenCalled();
		mocks.handlers.get("get-accessibility-permission-status")!();
		expect(mocks.trusted).toHaveBeenCalledWith(false);
		expect(mocks.trusted).not.toHaveBeenCalledWith(true);
	});
	it("prompts only once and rechecks permission after the user grants access", () => {
		const request = mocks.handlers.get("request-accessibility-permission")!;
		expect(request()).toEqual({ success: true, trusted: false, prompted: true });
		expect(request()).toEqual({ success: true, trusted: false, prompted: false });
		expect(mocks.trusted.mock.calls.filter(([prompt]) => prompt)).toHaveLength(1);
		mocks.trusted.mockReturnValue(true);
		expect(request()).toEqual({ success: true, trusted: true, prompted: false });
	});
	it("does not request permission when it is already granted", () => {
		mocks.trusted.mockReturnValue(true);
		expect(mocks.handlers.get("request-accessibility-permission")!()).toEqual({
			success: true,
			trusted: true,
			prompted: false,
		});
		expect(mocks.trusted).not.toHaveBeenCalledWith(true);
	});
});
