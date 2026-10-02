export interface GpuSwitches {
	useAngle?: string;
	useGl?: string;
	disableFeatures?: string[];
}
export function getGpuSwitches(_platform?: NodeJS.Platform, _env?: NodeJS.ProcessEnv): GpuSwitches {
	return { useAngle: "metal", disableFeatures: ["MacCatapLoopbackAudioForScreenShare"] };
}
