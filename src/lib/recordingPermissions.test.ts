import { describe, expect, it, vi } from "vitest";
import { checkRecordingPermissions } from "./recordingPermissions";

function mockAPI() {
	return {
		getScreenRecordingPermissionStatus: vi
			.fn()
			.mockResolvedValue({ success: true, status: "granted" }),
		getAccessibilityPermissionStatus: vi
			.fn()
			.mockResolvedValue({ success: true, trusted: false }),
		requestAccessibilityPermission: vi.fn(),
		openAccessibilityPreferences: vi.fn(),
		openScreenRecordingPreferences: vi.fn(),
	};
}

describe("recording permission checks", () => {
	it("repeated denied checks never prompt or open Settings", async () => {
		const api = mockAPI();
		for (let i = 0; i < 3; i++)
			expect(await checkRecordingPermissions(api)).toBe("accessibility");
		expect(api.requestAccessibilityPermission).not.toHaveBeenCalled();
		expect(api.openAccessibilityPreferences).not.toHaveBeenCalled();
		expect(api.openScreenRecordingPreferences).not.toHaveBeenCalled();
	});
	it("recovers when the OS grant changes without caching the denial", async () => {
		const api = mockAPI();
		expect(await checkRecordingPermissions(api)).toBe("accessibility");
		api.getAccessibilityPermissionStatus.mockResolvedValue({ success: true, trusted: true });
		expect(await checkRecordingPermissions(api)).toBeNull();
	});
	it("distinguishes screen access from accessibility", async () => {
		const api = mockAPI();
		api.getScreenRecordingPermissionStatus.mockResolvedValue({
			success: true,
			status: "denied",
		});
		expect(await checkRecordingPermissions(api)).toBe("screen");
		expect(api.getAccessibilityPermissionStatus).not.toHaveBeenCalled();
		expect(api.openScreenRecordingPreferences).not.toHaveBeenCalled();
	});
	it("reports query failure without requesting more privileges", async () => {
		const api = mockAPI();
		api.getScreenRecordingPermissionStatus.mockRejectedValue(new Error("IPC unavailable"));
		expect(await checkRecordingPermissions(api)).toBe("unavailable");
		expect(api.requestAccessibilityPermission).not.toHaveBeenCalled();
	});
});
