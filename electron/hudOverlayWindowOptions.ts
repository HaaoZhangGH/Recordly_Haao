export interface HudOverlayTaskbarOptions {
	skipTaskbar: boolean;
	focusable: boolean;
}
export function getHudOverlayTaskbarOptions(_platform?: NodeJS.Platform): HudOverlayTaskbarOptions {
	return { skipTaskbar: true, focusable: false };
}
