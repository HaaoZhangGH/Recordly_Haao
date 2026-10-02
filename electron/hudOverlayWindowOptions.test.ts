import { expect, it } from "vitest";
import { getHudOverlayTaskbarOptions } from "./hudOverlayWindowOptions";
it("keeps the macOS HUD non-focusable and out of the taskbar", () => {
	expect(getHudOverlayTaskbarOptions()).toEqual({ skipTaskbar: true, focusable: false });
});
