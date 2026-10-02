export type RecordingPermissionIssue = "screen" | "accessibility" | "unavailable";

type PermissionAPI = Pick<
	Window["electronAPI"],
	"getScreenRecordingPermissionStatus" | "getAccessibilityPermissionStatus"
>;

// A permission check must never request access or launch System Settings.
// Always read current OS state so returning from Settings can recover without a loop.
export async function checkRecordingPermissions(
	api: PermissionAPI,
): Promise<RecordingPermissionIssue | null> {
	try {
		const screen = await api.getScreenRecordingPermissionStatus();
		if (!screen.success) return "unavailable";
		if (screen.status !== "granted") return "screen";
		const accessibility = await api.getAccessibilityPermissionStatus();
		if (!accessibility.success) return "unavailable";
		return accessibility.trusted ? null : "accessibility";
	} catch {
		return "unavailable";
	}
}
