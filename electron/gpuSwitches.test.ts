import { expect, it } from "vitest";
import { getGpuSwitches } from "./gpuSwitches";
it("uses Metal while keeping native system audio capture available", () => {
	expect(getGpuSwitches()).toEqual({
		useAngle: "metal",
		disableFeatures: ["MacCatapLoopbackAudioForScreenShare"],
	});
});
