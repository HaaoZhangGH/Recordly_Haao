export function supportsHudCaptureProtection(_platform: string): boolean {
	return true;
}

export function getHudCaptureExcludedProcessIds(
	_platform: string,
	enabled: boolean,
	processId: number,
): number[] {
	if (!enabled || !Number.isSafeInteger(processId) || processId <= 0) {
		return [];
	}

	return [processId];
}

export function shouldProtectHudCapture(
	enabled: boolean,
	recording: boolean,
	starting: boolean,
): boolean {
	return enabled && (recording || starting);
}
