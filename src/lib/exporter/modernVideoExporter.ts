import type {
	AnnotationRegion,
	AudioRegion,
	AutoCaptionSettings,
	CaptionCue,
	ClipRegion,
	CropRegion,
	CursorClickEffectStyle,
	CursorStyle,
	CursorTelemetryPoint,
	Padding,
	SourceAudioTrackSettings,
	SpeedRegion,
	TrimRegion,
	WebcamOverlaySettings,
	ZoomMotionBlurTuning,
	ZoomRegion,
	ZoomTransitionEasing,
} from "@/components/video-editor/types";
import { getEffectiveVideoStreamDurationSeconds } from "@/lib/mediaTiming";
import { AudioProcessor, isAacAudioEncodingSupported } from "./audioEncoder";
import { shouldPreferNativeAutoBackend } from "./backendPolicy";
import { requiresClipTimelineRendering } from "./clipTimeline";
import { buildEditedTrackSourceSegments, classifyEditedTrackStrategy } from "./editedTrackStrategy";
import {
	type ExportBackpressureProfile,
	getExportBackpressureProfile,
	getPreferredWebCodecsLatencyModes,
	getWebCodecsEncodeQueueLimit,
	getWebCodecsKeyFrameInterval,
} from "./exportTuning";
import {
	advanceFinalizationProgress,
	type FinalizationProgressWatchdog,
	type FinalizationTimeoutWorkload,
	INITIAL_FINALIZATION_PROGRESS_STATE,
	withFinalizationTimeout,
} from "./finalizationTimeout";
import { getLocalFilePath } from "./localMediaSource";
import { FrameRenderer as ModernFrameRenderer } from "./modernFrameRenderer";
import {
	getOrderedSupportedMp4EncoderCandidates,
	type SupportedMp4EncoderPath,
} from "./mp4Support";
import { VideoMuxer } from "./muxer";
import { resolveSourceAudioFallbackPaths } from "./sourceAudioFallback";
import { type DecodedVideoInfo, StreamingVideoDecoder } from "./streamingDecoder";
import type {
	ExportConfig,
	ExportEncodeBackend,
	ExportFinalizationStageMetrics,
	ExportMetrics,
	ExportProgress,
	ExportRenderBackend,
	ExportResult,
} from "./types";
import { ENCODED_H264_COLOR_SPACE_FALLBACK, EXPORT_CANVAS_COLOR_SPACE } from "./videoColorSpace";

interface VideoExporterConfig extends ExportConfig {
	videoUrl: string;
	wallpaper: string;
	zoomRegions: ZoomRegion[];
	trimRegions?: TrimRegion[];
	speedRegions?: SpeedRegion[];
	showShadow: boolean;
	shadowIntensity: number;
	backgroundBlur: number;
	zoomMotionBlur?: number;
	zoomMotionBlurTuning?: ZoomMotionBlurTuning;
	connectZooms?: boolean;
	zoomInDurationMs?: number;
	zoomInOverlapMs?: number;
	zoomOutDurationMs?: number;
	connectedZoomGapMs?: number;
	connectedZoomDurationMs?: number;
	zoomInEasing?: ZoomTransitionEasing;
	zoomOutEasing?: ZoomTransitionEasing;
	connectedZoomEasing?: ZoomTransitionEasing;
	borderRadius?: number;
	padding?: Padding | number;
	videoPadding?: Padding | number;
	cropRegion: CropRegion;
	webcam?: WebcamOverlaySettings;
	webcamUrl?: string | null;
	annotationRegions?: AnnotationRegion[];
	autoCaptions?: CaptionCue[];
	autoCaptionSettings?: AutoCaptionSettings;
	cursorTelemetry?: CursorTelemetryPoint[];
	showCursor?: boolean;
	cursorStyle?: CursorStyle;
	cursorSize?: number;
	cursorSmoothing?: number;
	cursorSpringStiffnessMultiplier?: number;
	cursorSpringDampingMultiplier?: number;
	cursorSpringMassMultiplier?: number;
	cameraSpringStiffnessMultiplier?: number;
	cameraSpringDampingMultiplier?: number;
	cameraSpringMassMultiplier?: number;
	cursorMotionBlur?: number;
	cursorClickEffect?: CursorClickEffectStyle;
	cursorClickEffectColor?: string;
	cursorClickEffectScale?: number;
	cursorClickEffectOpacity?: number;
	cursorClickEffectDurationMs?: number;
	cursorClickBounce?: number;
	cursorClickBounceDuration?: number;
	cursorSway?: number;
	zoomSmoothness?: number;
	zoomClassicMode?: boolean;
	audioRegions?: AudioRegion[];
	clipRegions?: ClipRegion[];
	sourceAudioFallbackPaths?: string[];
	sourceAudioFallbackStartDelayMsByPath?: Record<string, number>;
	sourceAudioTrackSettings?: SourceAudioTrackSettings;
	previewWidth?: number;
	previewHeight?: number;
	onProgress?: (progress: ExportProgress) => void;
	preferredEncoderPath?: SupportedMp4EncoderPath | null;
}

interface ExportRuntimeDiagnostics {
	appVersion?: string;
	userAgent?: string;
	logicalProcessors?: number;
	deviceMemoryGb?: number;
	hardware?: RendererExportHardwareInfo;
}

type NativeAudioPlan =
	| {
			audioMode: "none";
	  }
	| {
			audioMode: "copy-source" | "trim-source";
			audioSourcePath: string;
			audioSourceCodec?: string;
			trimSegments?: Array<{ startMs: number; endMs: number }>;
	  }
	| {
			audioMode: "edited-track";
			strategy: "offline-render-fallback";
			sourceAudioFallbackPaths?: string[];
	  }
	| {
			audioMode: "edited-track";
			strategy: "filtergraph-fast-path";
			audioSourcePath: string;
			audioSourceCodec?: string;
			audioSourceSampleRate: number;
			editedTrackSegments: Array<{
				startMs: number;
				endMs: number;
				speed: number;
			}>;
	  };

const FILTERGRAPH_FALLBACK_AUDIO_SAMPLE_RATE = 48_000;

function hasNonDefaultSourceTrackSettings(sourceAudioTrackSettings?: SourceAudioTrackSettings) {
	if (!sourceAudioTrackSettings) {
		return false;
	}
	return Object.values(sourceAudioTrackSettings).some(
		(settings) =>
			Math.abs((settings?.volume ?? 1) - 1) > 0.0005 || Boolean(settings?.normalize),
	);
}

const NATIVE_EXPORT_ENGINE_NAME = "Breeze";
const MEDIA_SOURCE_RETRY_ERROR_TOKENS = [
	"readavpacket",
	"get_media_info",
	"avfoundation",
	"failed after 3 attempts",
	"pipeline failed",
];
const LIGHTNING_PIPELINE_NAME = "Lightning (Beta)";

export class ModernVideoExporter {
	private static readonly NATIVE_ENCODER_QUEUE_LIMIT = 64;
	private static readonly NATIVE_WRITE_BATCH_MAX_CHUNKS = 12;
	private static readonly NATIVE_WRITE_BATCH_MAX_BYTES = 2 * 1024 * 1024;

	private config: VideoExporterConfig;
	private streamingDecoder: StreamingVideoDecoder | null = null;
	private renderer: ModernFrameRenderer | null = null;
	private encoder: VideoEncoder | null = null;
	private muxer: VideoMuxer | null = null;
	private audioProcessor: AudioProcessor | null = null;
	private cancelled = false;
	private encodeQueue = 0;
	private webCodecsEncodeQueueLimit = 0;
	private keyFrameInterval = 0;
	private videoDescription: Uint8Array | undefined;
	private videoColorSpace: VideoColorSpaceInit | undefined;
	private pendingMuxing: Promise<void> = Promise.resolve();
	private chunkCount = 0;
	private exportStartTimeMs = 0;
	private lastThroughputLogTimeMs = 0;
	private renderBackend: ExportRenderBackend | null = null;
	private encodeBackend: ExportEncodeBackend | null = null;
	private encoderName: string | null = null;
	private backpressureProfile: ExportBackpressureProfile | null = null;
	private nativeExportSessionId: string | null = null;
	private nativeWritePromises = new Set<Promise<void>>();
	private nativeWriteError: Error | null = null;
	private pendingNativeWriteChunks: Uint8Array[] = [];
	private pendingNativeWriteBytes = 0;
	private maxNativeWriteInFlight = 1;
	private lastNativeExportError: string | null = null;
	private nativeH264Encoder: VideoEncoder | null = null;
	private nativeEncoderError: Error | null = null;
	private effectiveDurationSec = 0;
	private totalExportStartTimeMs = 0;
	private metadataLoadTimeMs = 0;
	private rendererInitTimeMs = 0;
	private nativeSessionStartTimeMs = 0;
	private decodeLoopTimeMs = 0;
	private frameCallbackTimeMs = 0;
	private renderFrameTimeMs = 0;
	private encodeWaitTimeMs = 0;
	private encodeWaitEvents = 0;
	private encoderError: Error | null = null;
	private peakEncodeQueueSize = 0;
	private peakNativeWriteInFlight = 0;
	private nativeCaptureTimeMs = 0;
	private nativeWriteTimeMs = 0;
	private finalizationTimeMs = 0;
	private finalizationStageMs: ExportFinalizationStageMetrics = {};
	private processedFrameCount = 0;
	private encodeCapacityWaiters = new Set<() => void>();
	private activeFinalizationProgressWatchdog: FinalizationProgressWatchdog | null = null;
	private lastFinalizationRenderProgress = INITIAL_FINALIZATION_PROGRESS_STATE.lastRenderProgress;
	private lastFinalizationAudioProgress = INITIAL_FINALIZATION_PROGRESS_STATE.lastAudioProgress;
	private lastProgressSampleTimeMs = 0;
	private lastProgressSampleFrame = 0;
	private displayedRenderFps = 0;
	private sourceVideoInfo: DecodedVideoInfo | null = null;
	private mediaSourceRetryAttempted = false;
	private runtimeDiagnostics: ExportRuntimeDiagnostics = {};

	constructor(config: VideoExporterConfig) {
		this.config = config;
	}

	async export(): Promise<ExportResult> {
		let useFallbackMediaSource = false;
		let retriedWithFallbackMediaSource = false;
		let nativeFailure: string | null = null;
		this.mediaSourceRetryAttempted = false;
		this.runtimeDiagnostics = await this.collectRuntimeDiagnostics();

		while (true) {
			let retryExport = false;
			let inNativeStage = false;
			try {
				this.cleanup();
				this.cancelled = false;
				this.encoderError = null;
				this.nativeEncoderError = null;
				this.sourceVideoInfo = null;
				this.totalExportStartTimeMs = this.getNowMs();
				const backendPreference = nativeFailure
					? "webcodecs"
					: (this.config.backendPreference ?? "auto");
				const runtimePlatform = this.getRuntimePlatform();
				let useNativeEncoder = false;
				let shouldDeferNativeEncoderStart = backendPreference === "breeze";
				this.lastNativeExportError = nativeFailure;

				let stageStartedAt = this.getNowMs();
				if (shouldDeferNativeEncoderStart) {
					// Defer the streaming native encoder until after metadata is known so
					// static-layout exports can use the fastest compatible compositor first.
				} else if (
					backendPreference === "auto" &&
					shouldPreferNativeAutoBackend(runtimePlatform)
				) {
					stageStartedAt = this.getNowMs();
					useNativeEncoder = await this.tryStartNativeVideoExport();
					this.nativeSessionStartTimeMs = this.getNowMs() - stageStartedAt;

					if (!useNativeEncoder) {
						console.warn(
							`[VideoExporter] ${NATIVE_EXPORT_ENGINE_NAME} auto-preferred native export was unavailable; falling back to WebCodecs.`,
							this.lastNativeExportError,
						);
						stageStartedAt = this.getNowMs();
						await this.initializeEncoder();
					}
				} else {
					try {
						const configuredWebCodecsPath = await this.initializeEncoder();
						if (
							backendPreference === "auto" &&
							configuredWebCodecsPath.hardwareAcceleration === "prefer-software"
						) {
							console.warn(
								"[VideoExporter] Auto backend resolved to a software WebCodecs encoder; trying Breeze native export instead.",
							);
							stageStartedAt = this.getNowMs();
							useNativeEncoder = await this.tryStartNativeVideoExport();
							this.nativeSessionStartTimeMs = this.getNowMs() - stageStartedAt;
							if (useNativeEncoder) {
								this.disposeEncoder();
							}
						}
					} catch (error) {
						const webCodecsError =
							error instanceof Error ? error : new Error(String(error));
						if (backendPreference === "webcodecs") {
							throw webCodecsError;
						}

						console.warn(
							`[VideoExporter] WebCodecs encoder unavailable, trying ${NATIVE_EXPORT_ENGINE_NAME} native export fallback`,
							webCodecsError,
						);
						this.disposeEncoder();

						stageStartedAt = this.getNowMs();
						useNativeEncoder = await this.tryStartNativeVideoExport();
						this.nativeSessionStartTimeMs = this.getNowMs() - stageStartedAt;

						if (!useNativeEncoder) {
							throw webCodecsError;
						}
					}
				}

				this.backpressureProfile = getExportBackpressureProfile({
					encodeBackend:
						shouldDeferNativeEncoderStart || useNativeEncoder ? "ffmpeg" : "webcodecs",
					width: this.config.width,
					height: this.config.height,
					frameRate: this.config.frameRate,
					encodingMode: this.config.encodingMode,
				});
				this.maxNativeWriteInFlight = useNativeEncoder
					? Math.max(
							1,
							Math.floor(
								this.config.maxInFlightNativeWrites ??
									this.backpressureProfile.maxInFlightNativeWrites,
							),
						)
					: 1;

				console.log("[VideoExporter] Backpressure profile", {
					profile: this.backpressureProfile.name,
					encodeBackend:
						shouldDeferNativeEncoderStart || useNativeEncoder ? "ffmpeg" : "webcodecs",
					maxEncodeQueue:
						this.config.maxEncodeQueue ?? this.backpressureProfile.maxEncodeQueue,
					maxDecodeQueue:
						this.config.maxDecodeQueue ?? this.backpressureProfile.maxDecodeQueue,
					maxPendingFrames:
						this.config.maxPendingFrames ?? this.backpressureProfile.maxPendingFrames,
					maxInFlightNativeWrites: this.maxNativeWriteInFlight,
				});

				this.streamingDecoder = new StreamingVideoDecoder({
					maxDecodeQueue:
						this.config.maxDecodeQueue ?? this.backpressureProfile.maxDecodeQueue,
					maxPendingFrames:
						this.config.maxPendingFrames ?? this.backpressureProfile.maxPendingFrames,
				});
				stageStartedAt = this.getNowMs();
				const videoInfo = await this.streamingDecoder.loadMetadata(this.config.videoUrl, {
					useFallbackMediaSource,
				});
				this.sourceVideoInfo = videoInfo;
				this.metadataLoadTimeMs = this.getNowMs() - stageStartedAt;
				const nativeAudioPlan = this.buildNativeAudioPlan(videoInfo);
				const shouldUsePitchPreservingFfmpegAudio =
					nativeAudioPlan.audioMode === "edited-track" &&
					nativeAudioPlan.strategy === "filtergraph-fast-path";
				const shouldUseFfmpegAudioFallback =
					!useNativeEncoder &&
					nativeAudioPlan.audioMode !== "none" &&
					// The PCM/FFmpeg path preserves AAC priming; WebCodecs AAC can shift clip cuts.
					(requiresClipTimelineRendering(this.config.clipRegions) ||
						shouldUsePitchPreservingFfmpegAudio ||
						!(await isAacAudioEncodingSupported()));
				const effectiveDuration = this.streamingDecoder.getEffectiveDuration(
					this.config.trimRegions,
					this.config.speedRegions,
					this.config.clipRegions,
				);
				this.effectiveDurationSec = effectiveDuration;
				const totalFrames = Math.ceil(effectiveDuration * this.config.frameRate);

				if (shouldDeferNativeEncoderStart && !useNativeEncoder) {
					stageStartedAt = this.getNowMs();
					useNativeEncoder = await this.tryStartNativeVideoExport();
					this.nativeSessionStartTimeMs = this.getNowMs() - stageStartedAt;
					if (!useNativeEncoder) {
						const nativeFailure =
							this.lastNativeExportError ??
							`${NATIVE_EXPORT_ENGINE_NAME} export is unavailable for this output profile on this system.`;
						console.warn(
							`[VideoExporter] ${NATIVE_EXPORT_ENGINE_NAME} native export unavailable after static-layout fallback; falling back to WebCodecs.`,
							nativeFailure,
						);
						shouldDeferNativeEncoderStart = false;
						this.backpressureProfile = getExportBackpressureProfile({
							encodeBackend: "webcodecs",
							width: this.config.width,
							height: this.config.height,
							frameRate: this.config.frameRate,
							encodingMode: this.config.encodingMode,
						});
						this.maxNativeWriteInFlight = 1;
						await this.initializeEncoder();
					}
				}

				stageStartedAt = this.getNowMs();
				this.renderer = new ModernFrameRenderer({
					timelineEffects: this.config.clipRegions !== undefined,
					width: this.config.width,
					height: this.config.height,
					preferredRenderBackend: undefined,
					wallpaper: this.config.wallpaper,
					zoomRegions: this.config.zoomRegions,
					showShadow: this.config.showShadow,
					shadowIntensity: this.config.shadowIntensity,
					backgroundBlur: this.config.backgroundBlur,
					zoomMotionBlur: this.config.zoomMotionBlur,
					zoomMotionBlurTuning: this.config.zoomMotionBlurTuning,
					connectZooms: this.config.connectZooms,
					zoomInDurationMs: this.config.zoomInDurationMs,
					zoomInOverlapMs: this.config.zoomInOverlapMs,
					zoomOutDurationMs: this.config.zoomOutDurationMs,
					connectedZoomGapMs: this.config.connectedZoomGapMs,
					connectedZoomDurationMs: this.config.connectedZoomDurationMs,
					zoomInEasing: this.config.zoomInEasing,
					zoomOutEasing: this.config.zoomOutEasing,
					connectedZoomEasing: this.config.connectedZoomEasing,
					borderRadius: this.config.borderRadius,
					padding: this.config.padding,
					cropRegion: this.config.cropRegion,
					webcam: this.config.webcam,
					webcamUrl: this.config.webcamUrl,
					videoWidth: videoInfo.width,
					videoHeight: videoInfo.height,
					annotationRegions: this.config.annotationRegions,
					autoCaptions: this.config.autoCaptions,
					autoCaptionSettings: this.config.autoCaptionSettings,
					speedRegions: this.config.speedRegions,
					previewWidth: this.config.previewWidth,
					previewHeight: this.config.previewHeight,
					cursorTelemetry: this.config.cursorTelemetry,
					showCursor: this.config.showCursor,
					cursorStyle: this.config.cursorStyle,
					cursorSize: this.config.cursorSize,
					cursorSmoothing: this.config.cursorSmoothing,
					cursorSpringStiffnessMultiplier: this.config.cursorSpringStiffnessMultiplier,
					cursorSpringDampingMultiplier: this.config.cursorSpringDampingMultiplier,
					cursorSpringMassMultiplier: this.config.cursorSpringMassMultiplier,
					cameraSpringStiffnessMultiplier: this.config.cameraSpringStiffnessMultiplier,
					cameraSpringDampingMultiplier: this.config.cameraSpringDampingMultiplier,
					cameraSpringMassMultiplier: this.config.cameraSpringMassMultiplier,
					cursorMotionBlur: this.config.cursorMotionBlur,
					cursorClickEffect: this.config.cursorClickEffect,
					cursorClickEffectColor: this.config.cursorClickEffectColor,
					cursorClickEffectScale: this.config.cursorClickEffectScale,
					cursorClickEffectOpacity: this.config.cursorClickEffectOpacity,
					cursorClickEffectDurationMs: this.config.cursorClickEffectDurationMs,
					cursorClickBounce: this.config.cursorClickBounce,
					cursorClickBounceDuration: this.config.cursorClickBounceDuration,
					cursorSway: this.config.cursorSway,
					zoomSmoothness: this.config.zoomSmoothness,
					zoomClassicMode: this.config.zoomClassicMode,
				});
				await this.renderer.initialize();
				this.rendererInitTimeMs = this.getNowMs() - stageStartedAt;
				this.renderBackend = this.renderer.getRendererBackend();
				console.log(`[VideoExporter] Using ${this.renderBackend} render backend`);

				if (!useNativeEncoder) {
					const hasAudio = nativeAudioPlan.audioMode !== "none";
					this.muxer = new VideoMuxer(
						this.config,
						hasAudio && !shouldUseFfmpegAudioFallback,
					);
					await this.muxer.initialize();
				}

				console.log("[VideoExporter] Original duration:", videoInfo.duration, "s");
				console.log("[VideoExporter] Effective duration:", effectiveDuration, "s");
				console.log("[VideoExporter] Total frames to export:", totalFrames);
				console.log(
					`[VideoExporter] Using ${useNativeEncoder ? `${NATIVE_EXPORT_ENGINE_NAME} native` : "WebCodecs"} encode path`,
				);

				const frameDuration = 1_000_000 / this.config.frameRate; // in microseconds
				let frameIndex = 0;
				this.exportStartTimeMs = this.getNowMs();
				this.lastThroughputLogTimeMs = this.exportStartTimeMs;
				this.lastProgressSampleTimeMs = this.exportStartTimeMs;
				this.lastProgressSampleFrame = 0;
				this.displayedRenderFps = 0;
				const decodeLoopStartedAt = this.getNowMs();

				await this.streamingDecoder.decodeAll(
					this.config.frameRate,
					this.config.trimRegions,
					this.config.speedRegions,
					async (
						videoFrame,
						_exportTimestampUs,
						sourceTimestampMs,
						cursorTimestampMs,
					) => {
						const callbackStartedAt = this.getNowMs();
						if (this.cancelled) {
							return;
						}

						const timestamp = frameIndex * frameDuration;
						const sourceTimestampUs = sourceTimestampMs * 1000;
						const cursorTimestampUs = cursorTimestampMs * 1000;
						const renderStartedAt = this.getNowMs();
						await this.renderer!.renderFrame(
							videoFrame,
							sourceTimestampUs,
							cursorTimestampUs,
							frameDuration,
							timestamp,
						);
						this.renderFrameTimeMs += this.getNowMs() - renderStartedAt;

						if (this.cancelled) {
							return;
						}

						if (useNativeEncoder) {
							inNativeStage = true;
							await this.encodeRenderedFrameNative(
								timestamp,
								frameDuration,
								frameIndex,
							);
							inNativeStage = false;
						} else {
							await this.encodeRenderedFrame(timestamp, frameDuration, frameIndex);
						}
						this.frameCallbackTimeMs += this.getNowMs() - callbackStartedAt;
						frameIndex++;
						this.processedFrameCount = frameIndex;
						this.reportProgress(frameIndex, totalFrames, "extracting");
					},
					this.config.clipRegions,
				);
				this.decodeLoopTimeMs = this.getNowMs() - decodeLoopStartedAt;

				if (this.cancelled) {
					if (this.encoderError) {
						return {
							success: false,
							error: this.buildLightningExportError(this.encoderError),
							metrics: this.buildExportMetrics(),
						};
					}

					return {
						success: false,
						error: "Export cancelled",
						metrics: this.buildExportMetrics(),
					};
				}

				this.reportFinalizingProgress(totalFrames, 96);

				if (useNativeEncoder) {
					inNativeStage = true;
					stageStartedAt = this.getNowMs();
					this.reportFinalizingProgress(totalFrames, 99);
					if (this.nativeH264Encoder) {
						await this.measureFinalizationStage("nativeEncoderFlushMs", async () => {
							await this.nativeH264Encoder!.flush();
						});
					}
					const finishResult = await this.finishNativeVideoExport(nativeAudioPlan);
					this.finalizationTimeMs = this.getNowMs() - stageStartedAt;
					if (
						!finishResult.success ||
						(!finishResult.tempFilePath && !finishResult.blob)
					) {
						throw new Error(
							finishResult.error || `${NATIVE_EXPORT_ENGINE_NAME} export failed`,
						);
					}

					return {
						success: true,
						tempFilePath: finishResult.tempFilePath,
						blob: finishResult.blob,
						metrics: this.buildExportMetrics(),
					};
				}

				stageStartedAt = this.getNowMs();
				if (this.encoder && this.encoder.state === "configured") {
					this.reportFinalizingProgress(totalFrames, 97);
					await this.measureFinalizationStage("encoderFlushMs", async () => {
						await this.awaitWithFinalizationTimeout(
							this.encoder!.flush(),
							"encoder flush",
						);
					});
				}

				this.reportFinalizingProgress(totalFrames, 98);
				await this.measureFinalizationStage("queuedMuxingMs", async () => {
					await this.awaitWithFinalizationTimeout(
						this.pendingMuxing,
						"muxing queued video chunks",
					);
				});

				// Surface muxing errors before proceeding with finalization
				if (this.encoderError) {
					throw this.encoderError;
				}

				if (
					nativeAudioPlan.audioMode !== "none" &&
					!shouldUseFfmpegAudioFallback &&
					!this.cancelled
				) {
					const demuxer = this.streamingDecoder.getDemuxer();
					if (
						demuxer ||
						(this.config.audioRegions ?? []).length > 0 ||
						(this.config.sourceAudioFallbackPaths ?? []).length > 0
					) {
						this.audioProcessor = new AudioProcessor();
						this.audioProcessor.setOnProgress((progress) => {
							this.reportFinalizingProgress(totalFrames, 99, progress);
						});
						this.reportFinalizingProgress(totalFrames, 99);
						await this.measureFinalizationStage("audioProcessingMs", async () => {
							await this.awaitWithFinalizationTimeout(
								this.audioProcessor!.process(
									demuxer,
									this.muxer!,
									this.config.videoUrl,
									this.config.trimRegions,
									this.config.speedRegions,
									undefined,
									this.config.audioRegions,
									this.config.sourceAudioFallbackPaths,
									this.config.sourceAudioFallbackStartDelayMsByPath,
									this.config.sourceAudioTrackSettings,
									this.config.clipRegions,
								),
								"audio processing",
								"audio",
								true,
							);
						});
					}
				}

				this.reportFinalizingProgress(totalFrames, 99);
				const muxerResult = await this.measureFinalizationStage(
					"muxerFinalizeMs",
					async () =>
						this.awaitWithFinalizationTimeout(
							this.muxer!.finalize(),
							"muxer finalization",
							nativeAudioPlan.audioMode !== "none" && !shouldUseFfmpegAudioFallback
								? "audio"
								: "default",
						),
				);

				if (shouldUseFfmpegAudioFallback) {
					console.warn(
						shouldUsePitchPreservingFfmpegAudio
							? "[VideoExporter] Using FFmpeg audio muxing for pitch-preserving speed edits."
							: "[VideoExporter] Browser AAC encoding is unavailable; falling back to FFmpeg audio muxing.",
					);
					const muxedResult = await this.finalizeExportWithFfmpegAudio(
						muxerResult,
						nativeAudioPlan,
					);
					this.finalizationTimeMs = this.getNowMs() - stageStartedAt;
					if (!muxedResult.success || (!muxedResult.blob && !muxedResult.tempFilePath)) {
						return {
							success: false,
							error: muxedResult.error || "Failed to mux audio with FFmpeg",
							metrics: this.buildExportMetrics(),
						};
					}

					return {
						success: true,
						blob: muxedResult.blob,
						tempFilePath: muxedResult.tempFilePath,
						metrics: muxedResult.metrics ?? this.buildExportMetrics(),
					};
				}

				this.finalizationTimeMs = this.getNowMs() - stageStartedAt;
				if (muxerResult.mode === "stream") {
					return {
						success: true,
						tempFilePath: muxerResult.tempFilePath,
						metrics: this.buildExportMetrics(),
					};
				}
				return {
					success: true,
					blob: muxerResult.blob,
					metrics: this.buildExportMetrics(),
				};
			} catch (error) {
				if (
					!this.cancelled &&
					!nativeFailure &&
					(inNativeStage || this.nativeEncoderError)
				) {
					nativeFailure = this.buildLightningExportError(
						this.nativeEncoderError ?? error,
					);
					console.error(
						"[VideoExporter] Native export failed; restarting once with WebCodecs.\n" +
							nativeFailure,
					);
					retryExport = true;
				} else if (
					!this.cancelled &&
					!useFallbackMediaSource &&
					!retriedWithFallbackMediaSource &&
					this.shouldRetryWithFallbackMediaSource(error)
				) {
					retriedWithFallbackMediaSource = true;
					this.mediaSourceRetryAttempted = true;
					useFallbackMediaSource = true;
					retryExport = true;
					console.warn(
						"[VideoExporter] Primary decode path failed; retrying export once with a fresh media source.",
						error,
					);
				} else {
					if (this.cancelled && !this.encoderError) {
						return {
							success: false,
							error: "Export cancelled",
							metrics: this.buildExportMetrics(),
						};
					}

					const resolvedError = this.encoderError ?? error;
					console.error("Export error:", error);
					return {
						success: false,
						error: this.buildLightningExportError(resolvedError),
						metrics: this.buildExportMetrics(),
					};
				}
			} finally {
				if (!retryExport && this.totalExportStartTimeMs > 0) {
					console.log(
						`[VideoExporter] Final metrics ${JSON.stringify(this.buildExportMetrics())}`,
					);
				}
				this.cleanup();
			}

			if (retryExport) {
				continue;
			}
		}
	}

	private shouldRetryWithFallbackMediaSource(error: unknown): boolean {
		const resolvedError = this.encoderError ?? error;
		const message =
			resolvedError instanceof Error ? resolvedError.message : String(resolvedError);
		const normalizedMessage = message.toLowerCase();
		return MEDIA_SOURCE_RETRY_ERROR_TOKENS.some((token) => normalizedMessage.includes(token));
	}

	private getPlatformLabel(): string {
		return "macOS";
	}

	private getRuntimePlatform() {
		return "darwin" as const;
	}

	private async collectRuntimeDiagnostics(): Promise<ExportRuntimeDiagnostics> {
		const diagnostics: ExportRuntimeDiagnostics = {};
		if (typeof navigator !== "undefined") {
			const navigatorWithMemory = navigator as Navigator & { deviceMemory?: number };
			if (navigator.userAgent) diagnostics.userAgent = navigator.userAgent;
			if (navigator.hardwareConcurrency > 0) {
				diagnostics.logicalProcessors = navigator.hardwareConcurrency;
			}
			if (
				typeof navigatorWithMemory.deviceMemory === "number" &&
				navigatorWithMemory.deviceMemory > 0
			) {
				diagnostics.deviceMemoryGb = navigatorWithMemory.deviceMemory;
			}
		}

		try {
			if (
				typeof window !== "undefined" &&
				typeof window.electronAPI?.getAppVersion === "function"
			) {
				diagnostics.appVersion = await window.electronAPI.getAppVersion();
			}
		} catch {
			// Environment diagnostics must never prevent an export attempt.
		}

		try {
			if (
				typeof window !== "undefined" &&
				typeof window.electronAPI?.getExportHardwareInfo === "function"
			) {
				const result = await window.electronAPI.getExportHardwareInfo();
				if (result.success && result.hardware) {
					diagnostics.hardware = result.hardware;
				}
			}
		} catch {
			// Environment diagnostics must never prevent an export attempt.
		}

		return diagnostics;
	}

	private getLightningErrorGuidance(message: string): string[] {
		const guidance = new Set<string>();
		const platform = this.getPlatformLabel();
		const isVideoDecodeFailure = /VideoDecoder failure|VIDEO_DECODE|VIDEO_CODEC/i.test(message);

		if (isVideoDecodeFailure) {
			guidance.add(
				"The input video decoder failed before Recordly could finish rendering the source frames.",
			);
			guidance.add(
				"If only this recording fails, remux or convert it to a standard H.264 MP4; the source may contain a damaged or unsupported frame.",
			);
			guidance.add(
				"If every recording fails, update the GPU/media driver and retry at 30 FPS to reduce decoder pressure.",
			);
		} else {
			guidance.add(
				"The available encoder path depends on WebCodecs support and the bundled FFmpeg encoders.",
			);
		}

		if (/even output dimensions/i.test(message)) {
			guidance.add(
				"Use an export size with even width and height. Switching quality presets usually fixes this automatically.",
			);
		}

		if (
			/not supported on this system|H\.264 encoding|encoder path .* is not supported|Video encoding/i.test(
				message,
			)
		) {
			guidance.add("Try Good or Medium quality to reduce output resolution and bitrate.");
			guidance.add(
				"Update GPU and media drivers so system H.264 encoding paths are available.",
			);
		}

		if (this.lastNativeExportError) {
			guidance.add(
				`Check that the packaged FFmpeg build includes a compatible ${NATIVE_EXPORT_ENGINE_NAME} encoder path for ${platform}, plus libx264 as a software fallback.`,
			);
		}

		return [...guidance];
	}

	private buildLightningExportError(error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		const failureCode = message.match(/\[([A-Z][A-Z0-9_]+)\]/)?.[1];
		const isVideoDecodeFailure = /VideoDecoder failure|VIDEO_DECODE|VIDEO_CODEC/i.test(message);
		const resolvedEncodePath =
			this.encodeBackend === "ffmpeg"
				? `${NATIVE_EXPORT_ENGINE_NAME} native`
				: this.encodeBackend === "webcodecs"
					? "WebCodecs"
					: null;
		const lines = [
			`${LIGHTNING_PIPELINE_NAME} export failed.`,
			...(failureCode ? [`Failure code: ${failureCode}`] : []),
			...(isVideoDecodeFailure ? ["Failure stage: Input video decoding"] : []),
			`Reason: ${message}`,
			`Platform: ${this.getPlatformLabel()}`,
			`Requested backend mode: ${this.config.backendPreference ?? "auto"}`,
			`Output: ${this.config.width}x${this.config.height} @ ${this.config.frameRate} FPS; ${(this.config.bitrate / 1_000_000).toFixed(2)} Mbps; mode=${this.config.encodingMode ?? "default"}`,
		];

		if (this.runtimeDiagnostics.appVersion) {
			lines.push(`Recordly version: ${this.runtimeDiagnostics.appVersion}`);
		}
		if (this.runtimeDiagnostics.userAgent) {
			lines.push(`Runtime: ${this.runtimeDiagnostics.userAgent}`);
		}
		const hardware = this.runtimeDiagnostics.hardware;
		if (hardware) {
			lines.push(
				`System: ${hardware.platform} ${hardware.release} (${hardware.arch})${hardware.machineModel ? `; model=${hardware.machineModel}` : ""}`,
			);
			lines.push(
				`CPU: ${hardware.cpuModel ?? "Unknown"}; ${hardware.logicalProcessors} logical processors`,
			);
			lines.push(`Memory: ${hardware.totalMemoryGb} GB`);
			for (const [index, gpu] of hardware.gpus.entries()) {
				const details = [
					gpu.vendor && !gpu.name.toLowerCase().includes(gpu.vendor.toLowerCase())
						? `vendor=${gpu.vendor}`
						: null,
					gpu.active === true ? "active" : gpu.active === false ? "inactive" : null,
				].filter((value): value is string => Boolean(value));
				lines.push(
					`GPU ${index + 1}: ${gpu.name}${details.length ? `; ${details.join("; ")}` : ""}`,
				);
			}
			const gpuFeatures = [
				hardware.gpuFeatures.videoDecode
					? `video decode=${hardware.gpuFeatures.videoDecode}`
					: null,
				hardware.gpuFeatures.videoEncode
					? `video encode=${hardware.gpuFeatures.videoEncode}`
					: null,
				hardware.gpuFeatures.webgl ? `WebGL=${hardware.gpuFeatures.webgl}` : null,
				hardware.gpuFeatures.webgpu ? `WebGPU=${hardware.gpuFeatures.webgpu}` : null,
			].filter((value): value is string => Boolean(value));
			if (gpuFeatures.length > 0) {
				lines.push(`GPU acceleration: ${gpuFeatures.join("; ")}`);
			}
		} else {
			const hardwareParts = [
				this.runtimeDiagnostics.logicalProcessors
					? `${this.runtimeDiagnostics.logicalProcessors} logical processors`
					: null,
				this.runtimeDiagnostics.deviceMemoryGb
					? `${this.runtimeDiagnostics.deviceMemoryGb} GB device memory`
					: null,
			].filter((value): value is string => Boolean(value));
			if (hardwareParts.length > 0) {
				lines.push(`Hardware capacity: ${hardwareParts.join("; ")}`);
			}
		}

		if (this.sourceVideoInfo) {
			lines.push(
				`Source: ${this.sourceVideoInfo.codec} ${this.sourceVideoInfo.width}x${this.sourceVideoInfo.height} @ ${this.sourceVideoInfo.frameRate.toFixed(3)} FPS; ${this.sourceVideoInfo.duration.toFixed(3)}s`,
			);
			lines.push(
				this.sourceVideoInfo.hasAudio
					? `Source audio: ${this.sourceVideoInfo.audioCodec ?? "unknown codec"}${this.sourceVideoInfo.audioSampleRate ? ` @ ${this.sourceVideoInfo.audioSampleRate} Hz` : ""}`
					: "Source audio: none",
			);
		}

		if (this.totalExportStartTimeMs > 0) {
			const elapsedSeconds = Math.max(
				0,
				(this.getNowMs() - this.totalExportStartTimeMs) / 1000,
			);
			const expectedFrames = Math.ceil(this.effectiveDurationSec * this.config.frameRate);
			const progressSuffix =
				expectedFrames > 0
					? `/${expectedFrames} (${Math.min(100, (this.processedFrameCount / expectedFrames) * 100).toFixed(1)}%)`
					: "";
			lines.push(
				`Progress at failure: ${this.processedFrameCount}${progressSuffix} rendered frames after ${elapsedSeconds.toFixed(2)}s`,
			);
		}

		if (this.mediaSourceRetryAttempted) {
			lines.push("Media source retry: attempted with a fresh source");
		}

		if (this.renderBackend) {
			lines.push(`Renderer: ${this.renderBackend}`);
		}

		if (resolvedEncodePath) {
			lines.push(
				`Encoder path: ${resolvedEncodePath}${this.encoderName ? ` (${this.encoderName})` : ""}`,
			);
		}

		if (this.backpressureProfile) {
			lines.push(
				`Pipeline tuning: ${this.backpressureProfile.name}; decode queue=${this.config.maxDecodeQueue ?? this.backpressureProfile.maxDecodeQueue}; pending frames=${this.config.maxPendingFrames ?? this.backpressureProfile.maxPendingFrames}; encode queue=${this.config.maxEncodeQueue ?? this.backpressureProfile.maxEncodeQueue}`,
			);
		}

		if (this.lastNativeExportError && !message.includes(this.lastNativeExportError)) {
			lines.push(`${NATIVE_EXPORT_ENGINE_NAME} fallback: ${this.lastNativeExportError}`);
		}

		const guidance = this.getLightningErrorGuidance(message);
		if (guidance.length > 0) {
			lines.push("Suggested actions:");
			for (const item of guidance) {
				lines.push(`- ${item}`);
			}
		}

		return lines.join("\n");
	}

	private async awaitWithFinalizationTimeout<T>(
		promise: Promise<T>,
		stage: string,
		workload: FinalizationTimeoutWorkload = "default",
		progressAware = false,
	): Promise<T> {
		return withFinalizationTimeout({
			promise,
			stage,
			effectiveDurationSec: this.effectiveDurationSec,
			workload,
			progressAware,
			onWatchdogChanged: (watchdog) => {
				this.activeFinalizationProgressWatchdog = watchdog;
			},
		});
	}

	private getNativeVideoSourcePath(): string | null {
		return this.config.videoUrl ? getLocalFilePath(this.config.videoUrl) : null;
	}

	private buildNativeTrimSegments(durationMs: number): Array<{ startMs: number; endMs: number }> {
		const trimRegions = [...(this.config.trimRegions ?? [])].sort(
			(a, b) => a.startMs - b.startMs,
		);
		if (trimRegions.length === 0) {
			return [{ startMs: 0, endMs: Math.max(0, durationMs) }];
		}

		const segments: Array<{ startMs: number; endMs: number }> = [];
		let cursorMs = 0;

		for (const region of trimRegions) {
			const startMs = Math.max(0, Math.min(region.startMs, durationMs));
			const endMs = Math.max(startMs, Math.min(region.endMs, durationMs));
			if (startMs > cursorMs) {
				segments.push({ startMs: cursorMs, endMs: startMs });
			}
			cursorMs = Math.max(cursorMs, endMs);
		}

		if (cursorMs < durationMs) {
			segments.push({ startMs: cursorMs, endMs: durationMs });
		}

		return segments.filter((segment) => segment.endMs - segment.startMs > 0.5);
	}

	private getNativeAudioFallbackPaths(videoInfo: DecodedVideoInfo): string[] {
		const sourceAudioFallbackPaths = (this.config.sourceAudioFallbackPaths ?? []).filter(
			(audioPath) => typeof audioPath === "string" && audioPath.trim().length > 0,
		);
		const localVideoSourcePath = this.getNativeVideoSourcePath();
		if (!videoInfo.hasAudio || !localVideoSourcePath) {
			return sourceAudioFallbackPaths;
		}

		const { externalAudioPaths } = resolveSourceAudioFallbackPaths(
			localVideoSourcePath,
			sourceAudioFallbackPaths,
		);
		if (externalAudioPaths.length === 0) {
			return sourceAudioFallbackPaths;
		}

		return [localVideoSourcePath, ...externalAudioPaths];
	}

	private buildNativeAudioPlan(videoInfo: DecodedVideoInfo): NativeAudioPlan {
		const speedRegions = this.config.speedRegions ?? [];
		const audioRegions = this.config.audioRegions ?? [];
		const sourceAudioFallbackPaths = this.getNativeAudioFallbackPaths(videoInfo);
		const hasTimedSourceAudioFallback = sourceAudioFallbackPaths.some(
			(audioPath) =>
				(this.config.sourceAudioFallbackStartDelayMsByPath?.[audioPath] ?? 0) > 0,
		);
		const localVideoSourcePath = this.getNativeVideoSourcePath();
		const primaryAudioSourcePath =
			(videoInfo.hasAudio ? localVideoSourcePath : null) ??
			sourceAudioFallbackPaths[0] ??
			null;
		const usesEmbeddedPrimaryAudio =
			Boolean(videoInfo.hasAudio) && primaryAudioSourcePath === localVideoSourcePath;
		const primaryAudioSourceSampleRate = usesEmbeddedPrimaryAudio
			? videoInfo.audioSampleRate
			: FILTERGRAPH_FALLBACK_AUDIO_SAMPLE_RATE;
		const primaryAudioSourceCodec = usesEmbeddedPrimaryAudio ? videoInfo.audioCodec : undefined;

		if (
			!videoInfo.hasAudio &&
			sourceAudioFallbackPaths.length === 0 &&
			audioRegions.length === 0
		) {
			return { audioMode: "none" };
		}

		if (
			requiresClipTimelineRendering(this.config.clipRegions) ||
			speedRegions.length > 0 ||
			audioRegions.length > 0 ||
			sourceAudioFallbackPaths.length > 1 ||
			hasTimedSourceAudioFallback ||
			hasNonDefaultSourceTrackSettings(this.config.sourceAudioTrackSettings) ||
			(this.config.clipRegions ?? []).some((clip) => Boolean(clip.muted))
		) {
			const sourceDurationMs = Math.max(
				0,
				Math.round(
					getEffectiveVideoStreamDurationSeconds({
						duration: videoInfo.duration,
						streamDuration: videoInfo.streamDuration,
					}) * 1000,
				),
			);
			const trimRegions = this.config.trimRegions ?? [];
			const canUsePrimaryAudioFiltergraph =
				Boolean(primaryAudioSourcePath) &&
				!hasTimedSourceAudioFallback &&
				(usesEmbeddedPrimaryAudio ||
					sourceAudioFallbackPaths.includes(primaryAudioSourcePath ?? "")) &&
				typeof primaryAudioSourceSampleRate === "number" &&
				Number.isFinite(primaryAudioSourceSampleRate) &&
				primaryAudioSourceSampleRate > 0;
			const requiresRenderedEditedTrack =
				requiresClipTimelineRendering(this.config.clipRegions) ||
				hasNonDefaultSourceTrackSettings(this.config.sourceAudioTrackSettings) ||
				(this.config.clipRegions ?? []).some((clip) => Boolean(clip.muted));
			const strategy =
				canUsePrimaryAudioFiltergraph && !requiresRenderedEditedTrack
					? classifyEditedTrackStrategy({
							primaryAudioSourcePath,
							sourceDurationMs,
							trimRegions,
							speedRegions,
							audioRegions,
							sourceAudioFallbackPaths,
						})
					: "offline-render-fallback";

			if (strategy === "filtergraph-fast-path") {
				const audioSourcePath = primaryAudioSourcePath;
				const audioSourceSampleRate = primaryAudioSourceSampleRate;
				const editedTrackSegments = buildEditedTrackSourceSegments(
					sourceDurationMs,
					trimRegions,
					speedRegions,
				);
				if (
					audioSourcePath &&
					typeof audioSourceSampleRate === "number" &&
					editedTrackSegments.length > 0
				) {
					return {
						audioMode: "edited-track",
						strategy,
						audioSourcePath,
						audioSourceCodec: primaryAudioSourceCodec,
						audioSourceSampleRate,
						editedTrackSegments,
					};
				}
			}

			return {
				audioMode: "edited-track",
				strategy: "offline-render-fallback",
				sourceAudioFallbackPaths,
			};
		}

		if (!primaryAudioSourcePath) {
			return {
				audioMode: "edited-track",
				strategy: "offline-render-fallback",
				sourceAudioFallbackPaths,
			};
		}

		if ((this.config.trimRegions ?? []).length > 0) {
			const sourceDurationMs = Math.max(
				0,
				Math.round(
					getEffectiveVideoStreamDurationSeconds({
						duration: videoInfo.duration,
						streamDuration: videoInfo.streamDuration,
					}) * 1000,
				),
			);
			const trimSegments = this.buildNativeTrimSegments(sourceDurationMs);
			if (trimSegments.length === 0) {
				return { audioMode: "none" };
			}

			return {
				audioMode: "trim-source",
				audioSourcePath: primaryAudioSourcePath,
				audioSourceCodec: primaryAudioSourceCodec,
				trimSegments,
			};
		}

		return {
			audioMode: "copy-source",
			audioSourcePath: primaryAudioSourcePath,
			audioSourceCodec: primaryAudioSourceCodec,
		};
	}

	private async renderEditedAudioForNativeMux(
		description: string,
		onProgress: (progress: number) => void,
		sourceAudioFallbackPaths = this.config.sourceAudioFallbackPaths,
	) {
		this.audioProcessor = new AudioProcessor();
		this.audioProcessor.setOnProgress(onProgress);
		const audioBlob = await this.measureFinalizationStage("editedAudioRenderMs", async () =>
			this.awaitWithFinalizationTimeout(
				this.audioProcessor!.renderEditedAudioTrack(
					this.config.videoUrl,
					this.config.trimRegions,
					this.config.speedRegions,
					this.config.audioRegions,
					sourceAudioFallbackPaths,
					this.config.sourceAudioFallbackStartDelayMsByPath,
					this.config.sourceAudioTrackSettings,
					this.config.clipRegions,
				),
				description,
				"audio",
				true,
			),
		);

		this.throwIfCancelled();
		const editedAudioData = await audioBlob.arrayBuffer();
		this.throwIfCancelled();
		return {
			editedAudioData,
			editedAudioMimeType: audioBlob.type || null,
		};
	}

	private throwIfCancelled(): void {
		if (this.cancelled) throw new Error("Export cancelled");
	}

	private async tryStartNativeVideoExport(): Promise<boolean> {
		this.lastNativeExportError = null;

		if (typeof window === "undefined" || !window.electronAPI?.nativeVideoExportStart) {
			this.lastNativeExportError = `${NATIVE_EXPORT_ENGINE_NAME} export is not available in this build.`;
			return false;
		}

		if (this.config.width % 2 !== 0 || this.config.height % 2 !== 0) {
			this.lastNativeExportError = `${NATIVE_EXPORT_ENGINE_NAME} export requires even output dimensions (${this.config.width}x${this.config.height}).`;
			console.warn(
				`[VideoExporter] ${NATIVE_EXPORT_ENGINE_NAME} export requires even output dimensions, falling back to WebCodecs (${this.config.width}x${this.config.height})`,
			);
			return false;
		}

		if (
			typeof VideoEncoder === "undefined" ||
			typeof VideoEncoder.isConfigSupported !== "function"
		) {
			this.lastNativeExportError = `${NATIVE_EXPORT_ENGINE_NAME} export requires WebCodecs VideoEncoder support.`;
			return false;
		}

		const encoderConfig: VideoEncoderConfig = {
			codec: "avc1.640034",
			width: this.config.width,
			height: this.config.height,
			bitrate: this.config.bitrate,
			framerate: this.config.frameRate,
			hardwareAcceleration: "prefer-hardware",
			avc: { format: "annexb" },
		};

		try {
			const support = await VideoEncoder.isConfigSupported(encoderConfig);
			if (!support.supported) {
				this.lastNativeExportError = `H.264 Annex B encoding is not supported at ${this.config.width}x${this.config.height}.`;
				return false;
			}
		} catch (error) {
			this.lastNativeExportError = error instanceof Error ? error.message : String(error);
			console.warn(
				`[VideoExporter] ${NATIVE_EXPORT_ENGINE_NAME} encoder support check failed`,
				error,
			);
			return false;
		}

		const result = await window.electronAPI.nativeVideoExportStart({
			width: this.config.width,
			height: this.config.height,
			frameRate: this.config.frameRate,
			bitrate: this.config.bitrate,
			encodingMode: this.config.encodingMode ?? "balanced",
			inputMode: "h264-stream",
		});

		if (!result.success || !result.sessionId) {
			this.lastNativeExportError =
				result.error ||
				`${NATIVE_EXPORT_ENGINE_NAME} export could not be started on this system.`;
			console.warn(
				`[VideoExporter] ${NATIVE_EXPORT_ENGINE_NAME} export unavailable`,
				result.error,
			);
			return false;
		}

		this.nativeExportSessionId = result.sessionId;
		this.lastNativeExportError = null;
		this.encodeBackend = "ffmpeg";
		this.encoderName = "h264-stream-copy";
		this.pendingNativeWriteChunks = [];
		this.pendingNativeWriteBytes = 0;

		const sessionId = result.sessionId;
		const encoder = new VideoEncoder({
			output: (chunk) => {
				if (this.cancelled || !this.nativeExportSessionId) {
					return;
				}

				const buffer = new ArrayBuffer(chunk.byteLength);
				chunk.copyTo(buffer);
				this.queueNativeWriteChunk(sessionId, new Uint8Array(buffer));
			},
			error: (error) => {
				if (this.nativeExportSessionId !== sessionId) return;
				this.nativeEncoderError = error;
				this.notifyEncodeCapacityAvailable();
			},
		});

		try {
			encoder.configure(encoderConfig);
		} catch (error) {
			this.lastNativeExportError = error instanceof Error ? error.message : String(error);
			try {
				encoder.close();
			} catch (closeError) {
				console.debug(
					"[VideoExporter] Ignoring error closing native H.264 encoder after startup failure:",
					closeError,
				);
			}
			this.nativeExportSessionId = null;
			await window.electronAPI.nativeVideoExportCancel?.(sessionId);
			console.warn(
				`[VideoExporter] ${NATIVE_EXPORT_ENGINE_NAME} encoder configure failed`,
				error,
			);
			return false;
		}

		this.nativeH264Encoder = encoder;

		console.log(`[VideoExporter] ${NATIVE_EXPORT_ENGINE_NAME} session ready (H264-stream)`, {
			sessionId: result.sessionId,
		});
		return true;
	}

	private async encodeRenderedFrameNative(
		timestamp: number,
		frameDuration: number,
		frameIndex: number,
	): Promise<void> {
		if (!this.nativeH264Encoder || !this.nativeExportSessionId) {
			if (this.cancelled) return;
			throw new Error(`${NATIVE_EXPORT_ENGINE_NAME} export session is not active`);
		}
		if (this.nativeEncoderError) throw this.nativeEncoderError;
		while (this.nativeWritePromises.size >= this.maxNativeWriteInFlight) {
			await this.awaitOldestNativeWrite();
			if (this.cancelled) return;
			if (this.nativeEncoderError) throw this.nativeEncoderError;
		}
		while (
			this.nativeH264Encoder.encodeQueueSize >= ModernVideoExporter.NATIVE_ENCODER_QUEUE_LIMIT
		) {
			await this.waitForEncodeCapacity();
			if (this.cancelled) return;
			if (this.nativeEncoderError) throw this.nativeEncoderError;
		}
		const canvas = this.renderer!.getCanvas();
		// @ts-expect-error - colorSpace is supported at runtime but missing from this DOM typing.
		const frame = new VideoFrame(canvas, {
			timestamp,
			duration: frameDuration,
			colorSpace: EXPORT_CANVAS_COLOR_SPACE,
		});
		try {
			this.nativeH264Encoder.encode(frame, { keyFrame: frameIndex % 300 === 0 });
		} finally {
			frame.close();
		}
	}

	private async finishNativeVideoExport(audioPlan: NativeAudioPlan): Promise<ExportResult> {
		if (!this.nativeExportSessionId) {
			return {
				success: false,
				error: `${NATIVE_EXPORT_ENGINE_NAME} export session is not active`,
			};
		}

		let editedAudioBuffer: ArrayBuffer | undefined;
		let editedAudioMimeType: string | null = null;

		if (
			audioPlan.audioMode === "edited-track" &&
			audioPlan.strategy === "offline-render-fallback"
		) {
			const renderedAudio = await this.renderEditedAudioForNativeMux(
				`${NATIVE_EXPORT_ENGINE_NAME} edited audio rendering`,
				(progress) => this.reportFinalizingProgress(this.processedFrameCount, 99, progress),
				audioPlan.sourceAudioFallbackPaths,
			);
			editedAudioBuffer = renderedAudio.editedAudioData;
			editedAudioMimeType = renderedAudio.editedAudioMimeType;
		}

		const sessionId = this.nativeExportSessionId;
		console.log(`[VideoExporter] Finalizing ${NATIVE_EXPORT_ENGINE_NAME} export`, {
			sessionId,
			audioMode: audioPlan.audioMode,
			editedTrackStrategy:
				audioPlan.audioMode === "edited-track" ? audioPlan.strategy : undefined,
			encoderName: this.encoderName ?? "unknown",
		});

		this.flushPendingNativeWriteBatch(sessionId);
		await this.awaitPendingNativeWrites();
		this.throwIfCancelled();

		const result = await this.measureFinalizationStage("nativeExportFinalizeMs", async () =>
			this.awaitWithFinalizationTimeout(
				window.electronAPI.nativeVideoExportFinish(sessionId, {
					audioMode: audioPlan.audioMode,
					audioSourcePath:
						audioPlan.audioMode === "copy-source" ||
						audioPlan.audioMode === "trim-source" ||
						(audioPlan.audioMode === "edited-track" &&
							audioPlan.strategy === "filtergraph-fast-path")
							? audioPlan.audioSourcePath
							: null,
					trimSegments:
						audioPlan.audioMode === "trim-source" ? audioPlan.trimSegments : undefined,
					editedTrackStrategy:
						audioPlan.audioMode === "edited-track" ? audioPlan.strategy : undefined,
					editedTrackSegments:
						audioPlan.audioMode === "edited-track" &&
						audioPlan.strategy === "filtergraph-fast-path"
							? audioPlan.editedTrackSegments
							: undefined,
					outputDurationSec: this.effectiveDurationSec,
					audioSourceSampleRate:
						audioPlan.audioMode === "edited-track" &&
						audioPlan.strategy === "filtergraph-fast-path"
							? audioPlan.audioSourceSampleRate
							: undefined,
					editedAudioData: editedAudioBuffer,
					editedAudioMimeType,
				}),
				`${NATIVE_EXPORT_ENGINE_NAME} export finalization`,
				audioPlan.audioMode === "none" ? "default" : "audio",
			),
		);
		if (result.metrics) {
			this.finalizationStageMs.ffmpegAudioMuxBreakdown = result.metrics;
		}
		this.nativeExportSessionId = null;

		if (!result.success) {
			return {
				success: false,
				error: result.error || `Failed to finalize ${NATIVE_EXPORT_ENGINE_NAME} export`,
			};
		}

		this.encoderName = result.encoderName ?? this.encoderName;
		if (!result.tempPath) {
			return {
				success: false,
				error: `${NATIVE_EXPORT_ENGINE_NAME} export did not return a temp path`,
			};
		}

		return {
			success: true,
			tempFilePath: result.tempPath,
		};
	}

	private async finalizeExportWithFfmpegAudio(
		videoSource: import("./muxer").MuxerFinalizeResult,
		audioPlan: NativeAudioPlan,
	): Promise<ExportResult> {
		if (typeof window === "undefined") {
			return {
				success: false,
				error: "FFmpeg audio fallback is unavailable in this environment.",
			};
		}

		let editedAudioBuffer: ArrayBuffer | undefined;
		let editedAudioMimeType: string | null = null;

		if (
			audioPlan.audioMode === "edited-track" &&
			audioPlan.strategy === "offline-render-fallback"
		) {
			const renderedAudio = await this.renderEditedAudioForNativeMux(
				"FFmpeg edited audio rendering",
				(progress) => this.reportFinalizingProgress(this.processedFrameCount, 99, progress),
				audioPlan.sourceAudioFallbackPaths,
			);
			editedAudioBuffer = renderedAudio.editedAudioData;
			editedAudioMimeType = renderedAudio.editedAudioMimeType;
		}

		this.throwIfCancelled();
		const muxOptions = {
			audioMode: audioPlan.audioMode,
			audioSourcePath:
				audioPlan.audioMode === "copy-source" ||
				audioPlan.audioMode === "trim-source" ||
				(audioPlan.audioMode === "edited-track" &&
					audioPlan.strategy === "filtergraph-fast-path")
					? audioPlan.audioSourcePath
					: null,
			trimSegments:
				audioPlan.audioMode === "trim-source" ? audioPlan.trimSegments : undefined,
			editedTrackStrategy:
				audioPlan.audioMode === "edited-track" ? audioPlan.strategy : undefined,
			editedTrackSegments:
				audioPlan.audioMode === "edited-track" &&
				audioPlan.strategy === "filtergraph-fast-path"
					? audioPlan.editedTrackSegments
					: undefined,
			audioSourceSampleRate:
				audioPlan.audioMode === "edited-track" &&
				audioPlan.strategy === "filtergraph-fast-path"
					? audioPlan.audioSourceSampleRate
					: undefined,
			outputDurationSec: this.effectiveDurationSec,
			editedAudioData: editedAudioBuffer,
			editedAudioMimeType,
		};

		if (videoSource.mode === "stream") {
			if (!window.electronAPI?.muxExportedVideoAudioFromPath) {
				return {
					success: false,
					error: "FFmpeg audio fallback via temp path is unavailable in this environment.",
				};
			}
			const result = await this.measureFinalizationStage("ffmpegAudioMuxMs", async () =>
				this.awaitWithFinalizationTimeout(
					window.electronAPI.muxExportedVideoAudioFromPath(
						videoSource.tempFilePath,
						muxOptions,
					),
					"FFmpeg audio muxing",
					"audio",
				),
			);
			if (result.metrics) {
				this.finalizationStageMs.ffmpegAudioMuxBreakdown = result.metrics;
			}
			if (!result.success || !result.tempPath) {
				return {
					success: false,
					error: result.error || "Failed to mux exported audio with FFmpeg",
				};
			}
			return { success: true, tempFilePath: result.tempPath };
		}

		if (!window.electronAPI?.muxExportedVideoAudio) {
			return {
				success: false,
				error: "FFmpeg audio fallback is unavailable in this environment.",
			};
		}
		const videoBuffer = await videoSource.blob.arrayBuffer();
		this.throwIfCancelled();
		const result = await this.measureFinalizationStage("ffmpegAudioMuxMs", async () =>
			this.awaitWithFinalizationTimeout(
				window.electronAPI.muxExportedVideoAudio(videoBuffer, muxOptions),
				"FFmpeg audio muxing",
				"audio",
			),
		);
		if (result.metrics) {
			this.finalizationStageMs.ffmpegAudioMuxBreakdown = result.metrics;
		}

		if (!result.success || !result.tempPath) {
			return {
				success: false,
				error: result.error || "Failed to mux exported audio with FFmpeg",
			};
		}

		// Returning a temp path (instead of buffering the muxed bytes back into
		// the renderer) is what keeps >2 GiB exports off Node's fs.readFile cap.
		return {
			success: true,
			tempFilePath: result.tempPath,
		};
	}

	private async encodeRenderedFrame(
		timestamp: number,
		frameDuration: number,
		frameIndex: number,
	) {
		const canvas = this.renderer!.getCanvas();

		// @ts-expect-error - colorSpace not in TypeScript definitions but works at runtime
		const exportFrame = new VideoFrame(canvas, {
			timestamp,
			duration: frameDuration,
			colorSpace: EXPORT_CANVAS_COLOR_SPACE,
		});

		while (
			this.encoder &&
			this.getCurrentEncodeBacklog() >= this.webCodecsEncodeQueueLimit &&
			!this.cancelled
		) {
			const encodeWaitStartedAt = this.getNowMs();
			this.encodeWaitEvents++;
			await this.waitForEncodeCapacity();
			this.encodeWaitTimeMs += this.getNowMs() - encodeWaitStartedAt;
		}

		try {
			if (this.encoder && this.encoder.state === "configured") {
				this.peakEncodeQueueSize = Math.max(
					this.peakEncodeQueueSize,
					this.encoder.encodeQueueSize,
					this.encodeQueue,
				);
				this.encodeQueue++;
				this.encoder.encode(exportFrame, {
					keyFrame: frameIndex % Math.max(this.keyFrameInterval, 1) === 0,
				});
				this.peakEncodeQueueSize = Math.max(
					this.peakEncodeQueueSize,
					this.encoder.encodeQueueSize,
					this.encodeQueue,
				);
			} else {
				console.warn(
					`[Frame ${frameIndex}] Encoder not ready! State: ${this.encoder?.state}`,
				);
			}
		} finally {
			exportFrame.close();
		}
	}

	private reportFinalizingProgress(
		totalFrames: number,
		renderProgress: number,
		audioProgress?: number,
	) {
		const nextProgress = advanceFinalizationProgress({
			renderProgress,
			audioProgress,
			state: {
				lastRenderProgress: this.lastFinalizationRenderProgress,
				lastAudioProgress: this.lastFinalizationAudioProgress,
			},
		});
		if (nextProgress.progressed) {
			this.activeFinalizationProgressWatchdog?.refreshProgress();
		}
		this.lastFinalizationRenderProgress = nextProgress.lastRenderProgress;
		this.lastFinalizationAudioProgress = nextProgress.lastAudioProgress;
		this.reportProgress(
			totalFrames,
			totalFrames,
			"finalizing",
			nextProgress.lastRenderProgress,
			typeof audioProgress === "number" && Number.isFinite(audioProgress)
				? nextProgress.lastAudioProgress
				: undefined,
		);
	}

	private queueNativeWriteChunk(sessionId: string, chunk: Uint8Array): void {
		this.pendingNativeWriteChunks.push(chunk);
		this.pendingNativeWriteBytes += chunk.byteLength;

		if (
			this.pendingNativeWriteChunks.length >=
				ModernVideoExporter.NATIVE_WRITE_BATCH_MAX_CHUNKS ||
			this.pendingNativeWriteBytes >= ModernVideoExporter.NATIVE_WRITE_BATCH_MAX_BYTES
		) {
			this.flushPendingNativeWriteBatch(sessionId);
		}
	}

	private flushPendingNativeWriteBatch(sessionId: string): void {
		if (this.pendingNativeWriteChunks.length === 0) {
			return;
		}

		const chunks = this.pendingNativeWriteChunks;
		this.pendingNativeWriteChunks = [];
		this.pendingNativeWriteBytes = 0;
		const writePromise = window.electronAPI
			.nativeVideoExportWriteFrames(sessionId, chunks)
			.then((writeResult) => {
				if (!writeResult.success && !this.cancelled) {
					throw new Error(
						writeResult.error || "Failed to write H.264 chunks to native encoder",
					);
				}
			})
			.catch((error) => {
				if (!this.cancelled && this.nativeExportSessionId === sessionId) {
					const resolvedError = error instanceof Error ? error : new Error(String(error));
					if (!this.nativeEncoderError) {
						this.nativeEncoderError = resolvedError;
					}
					if (!this.nativeWriteError) {
						this.nativeWriteError = resolvedError;
					}
				}
				throw error;
			});

		this.trackNativeWritePromise(writePromise);
		this.notifyEncodeCapacityAvailable();
	}

	private waitForEncodeCapacity(): Promise<void> {
		return new Promise((resolve) => {
			this.encodeCapacityWaiters.add(resolve);
		});
	}

	private notifyEncodeCapacityAvailable(): void {
		if (this.encodeCapacityWaiters.size === 0) {
			return;
		}

		const waiters = [...this.encodeCapacityWaiters];
		this.encodeCapacityWaiters.clear();
		for (const resolve of waiters) {
			resolve();
		}
	}

	private reportProgress(
		currentFrame: number,
		totalFrames: number,
		phase: ExportProgress["phase"] = "extracting",
		renderProgress?: number,
		audioProgress?: number,
	) {
		const nowMs = this.getNowMs();
		const elapsedSeconds = Math.max((nowMs - this.exportStartTimeMs) / 1000, 0.001);
		const averageRenderFps = currentFrame / elapsedSeconds;
		const sampleElapsedMs = Math.max(nowMs - this.lastProgressSampleTimeMs, 1);
		const sampleFrameDelta = Math.max(currentFrame - this.lastProgressSampleFrame, 0);
		const sampleRenderFps = (sampleFrameDelta * 1000) / sampleElapsedMs;
		if (sampleElapsedMs >= 500 || currentFrame === totalFrames) {
			this.displayedRenderFps =
				this.displayedRenderFps > 0
					? this.displayedRenderFps * 0.35 + sampleRenderFps * 0.65
					: sampleRenderFps;
		} else if (this.displayedRenderFps <= 0) {
			this.displayedRenderFps = averageRenderFps;
		}
		const displayedRenderFps =
			this.displayedRenderFps > 0 ? this.displayedRenderFps : sampleRenderFps;
		const remainingFrames = Math.max(totalFrames - currentFrame, 0);
		const estimatedTimeRemaining =
			averageRenderFps > 0 ? remainingFrames / averageRenderFps : 0;
		const safeRenderProgress =
			phase === "finalizing" ? Math.max(0, Math.min(renderProgress ?? 100, 100)) : undefined;
		const percentage =
			phase === "preparing"
				? 0
				: phase === "finalizing"
					? (safeRenderProgress ?? 100)
					: totalFrames > 0
						? (currentFrame / totalFrames) * 100
						: 100;

		if (nowMs - this.lastThroughputLogTimeMs >= 1000 || currentFrame === totalFrames) {
			const safeFrameCount = Math.max(this.processedFrameCount, 1);
			this.peakEncodeQueueSize = Math.max(
				this.peakEncodeQueueSize,
				this.getCurrentEncodeBacklog(),
			);
			console.log(
				`[VideoExporter] Progress ${JSON.stringify({
					phase,
					currentFrame,
					totalFrames,
					elapsedSec: Number(elapsedSeconds.toFixed(2)),
					averageRenderFps: Number(averageRenderFps.toFixed(1)),
					sampleRenderFps: Number(sampleRenderFps.toFixed(1)),
					displayedRenderFps: Number(displayedRenderFps.toFixed(1)),
					renderBackend: this.renderBackend ?? undefined,
					encodeBackend: this.encodeBackend ?? undefined,
					encoderName: this.encoderName ?? undefined,
					encoderQueueSize: this.encoder?.encodeQueueSize ?? 0,
					pendingEncodeQueue: this.encodeQueue,
					encodeBacklog: this.getCurrentEncodeBacklog(),
					peakEncodeQueueSize: this.peakEncodeQueueSize,
					nativeWriteInFlight: this.nativeWritePromises.size,
					peakNativeWriteInFlight: this.peakNativeWriteInFlight,
					averageFrameCallbackMs: Number(
						(this.frameCallbackTimeMs / safeFrameCount).toFixed(3),
					),
					averageRenderFrameMs: Number(
						(this.renderFrameTimeMs / safeFrameCount).toFixed(3),
					),
					averageEncodeWaitMs: Number(
						(this.encodeWaitTimeMs / safeFrameCount).toFixed(3),
					),
					averageNativeCaptureMs:
						this.nativeCaptureTimeMs > 0
							? Number((this.nativeCaptureTimeMs / safeFrameCount).toFixed(3))
							: undefined,
					averageNativeWriteMs:
						this.nativeWriteTimeMs > 0
							? Number((this.nativeWriteTimeMs / safeFrameCount).toFixed(3))
							: undefined,
				})}`,
			);
			this.lastThroughputLogTimeMs = nowMs;
			this.lastProgressSampleTimeMs = nowMs;
			this.lastProgressSampleFrame = currentFrame;
		}

		if (this.config.onProgress) {
			this.config.onProgress({
				currentFrame,
				totalFrames,
				percentage,
				estimatedTimeRemaining,
				renderFps: displayedRenderFps,
				renderBackend: this.renderBackend ?? undefined,
				encodeBackend: this.encodeBackend ?? undefined,
				encoderName: this.encoderName ?? undefined,
				phase,
				renderProgress: safeRenderProgress,
				audioProgress,
			});
		}
	}

	private buildExportMetrics(): ExportMetrics {
		const totalElapsedMs =
			this.totalExportStartTimeMs > 0 ? this.getNowMs() - this.totalExportStartTimeMs : 0;
		const safeFrameCount = Math.max(this.processedFrameCount, 1);
		const hasFinalizationStageMetrics = Object.keys(this.finalizationStageMs).length > 0;

		return {
			totalElapsedMs,
			metadataLoadMs: this.metadataLoadTimeMs,
			rendererInitMs: this.rendererInitTimeMs,
			nativeSessionStartMs: this.nativeSessionStartTimeMs,
			decodeLoopMs: this.decodeLoopTimeMs,
			frameCallbackMs: this.frameCallbackTimeMs,
			renderFrameMs: this.renderFrameTimeMs,
			encodeWaitMs: this.encodeWaitTimeMs,
			encodeWaitEvents: this.encodeWaitEvents,
			peakEncodeQueueSize: this.peakEncodeQueueSize,
			peakNativeWriteInFlight: this.peakNativeWriteInFlight,
			nativeCaptureMs: this.nativeCaptureTimeMs,
			nativeWriteMs: this.nativeWriteTimeMs,
			finalizationMs: this.finalizationTimeMs,
			frameCount: this.processedFrameCount,
			renderBackend: this.renderBackend ?? undefined,
			encodeBackend: this.encodeBackend ?? undefined,
			encoderName: this.encoderName ?? undefined,
			backpressureProfile: this.backpressureProfile?.name,
			effectiveDurationSec: this.effectiveDurationSec || undefined,
			finalizationStageMs: hasFinalizationStageMetrics ? this.finalizationStageMs : undefined,
			averageFrameCallbackMs:
				this.processedFrameCount > 0
					? this.frameCallbackTimeMs / safeFrameCount
					: undefined,
			averageRenderFrameMs:
				this.processedFrameCount > 0 ? this.renderFrameTimeMs / safeFrameCount : undefined,
			averageEncodeWaitMs:
				this.processedFrameCount > 0 ? this.encodeWaitTimeMs / safeFrameCount : undefined,
			averageNativeCaptureMs:
				this.processedFrameCount > 0
					? this.nativeCaptureTimeMs / safeFrameCount
					: undefined,
			averageNativeWriteMs:
				this.processedFrameCount > 0 ? this.nativeWriteTimeMs / safeFrameCount : undefined,
		};
	}

	private getCurrentEncodeBacklog(): number {
		return Math.max(this.encoder?.encodeQueueSize ?? 0, this.encodeQueue);
	}

	private trackNativeWritePromise(writePromise: Promise<void>): void {
		this.nativeWritePromises.add(writePromise);
		this.peakNativeWriteInFlight = Math.max(
			this.peakNativeWriteInFlight,
			this.nativeWritePromises.size,
		);

		const removeWrite = () => {
			this.nativeWritePromises.delete(writePromise);
		};
		void writePromise.then(removeWrite, removeWrite);
	}

	private async awaitOldestNativeWrite(): Promise<void> {
		const oldestWritePromise = this.nativeWritePromises.values().next().value;
		if (!oldestWritePromise) {
			return;
		}

		await oldestWritePromise;

		if (this.nativeWriteError) {
			throw this.nativeWriteError;
		}
	}

	private async awaitPendingNativeWrites(): Promise<void> {
		while (this.nativeWritePromises.size > 0) {
			await this.awaitOldestNativeWrite();
		}

		if (this.nativeWriteError) {
			throw this.nativeWriteError;
		}
	}

	private disposeNativeH264Encoder(): void {
		if (!this.nativeH264Encoder) {
			return;
		}

		try {
			this.nativeH264Encoder.close();
		} catch (error) {
			console.debug("[VideoExporter] Ignoring error closing native H.264 encoder:", error);
		}

		this.nativeH264Encoder = null;
	}

	private getNowMs(): number {
		if (typeof performance !== "undefined" && typeof performance.now === "function") {
			return performance.now();
		}

		return Date.now();
	}

	private async measureFinalizationStage<T>(
		stage: keyof ExportFinalizationStageMetrics,
		task: () => Promise<T>,
	): Promise<T> {
		const startedAt = this.getNowMs();
		try {
			return await task();
		} finally {
			this.finalizationStageMs[stage] = this.getNowMs() - startedAt;
		}
	}

	private async initializeEncoder(): Promise<SupportedMp4EncoderPath> {
		this.encodeQueue = 0;
		this.webCodecsEncodeQueueLimit =
			this.config.maxEncodeQueue ??
			this.backpressureProfile?.maxEncodeQueue ??
			getWebCodecsEncodeQueueLimit(this.config.frameRate, this.config.encodingMode);
		this.keyFrameInterval = getWebCodecsKeyFrameInterval(
			this.config.frameRate,
			this.config.encodingMode,
		);
		this.pendingMuxing = Promise.resolve();
		this.chunkCount = 0;
		let videoDescription: Uint8Array | undefined;

		const encoderCandidates = this.getEncoderCandidates();
		const latencyModePreferences = getPreferredWebCodecsLatencyModes(this.config.encodingMode);

		let resolvedCodec: string | null = null;

		console.log("[VideoExporter] WebCodecs tuning", {
			encodingMode: this.config.encodingMode ?? "balanced",
			keyFrameInterval: this.keyFrameInterval,
			latencyModes: latencyModePreferences,
			queueLimit: this.webCodecsEncodeQueueLimit,
		});

		this.encoder = new VideoEncoder({
			output: (chunk, meta) => {
				// Capture decoder config metadata from encoder output
				if (meta?.decoderConfig?.description && !videoDescription) {
					const desc = meta.decoderConfig.description;
					videoDescription = ArrayBuffer.isView(desc)
						? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength)
						: new Uint8Array(desc);
					this.videoDescription = videoDescription;
				}
				// Capture colorSpace from encoder metadata if provided
				if (meta?.decoderConfig?.colorSpace && !this.videoColorSpace) {
					this.videoColorSpace = meta.decoderConfig.colorSpace;
				}

				// Stream chunks to muxer in order without retaining an ever-growing promise array
				const isFirstChunk = this.chunkCount === 0;
				this.chunkCount++;

				this.pendingMuxing = this.pendingMuxing.then(async () => {
					try {
						if (isFirstChunk && this.videoDescription) {
							// Add decoder config for the first chunk
							const colorSpace =
								this.videoColorSpace || ENCODED_H264_COLOR_SPACE_FALLBACK;

							const metadata: EncodedVideoChunkMetadata = {
								decoderConfig: {
									codec: resolvedCodec ?? (this.config.codec || "avc1.640033"),
									codedWidth: this.config.width,
									codedHeight: this.config.height,
									description: this.videoDescription,
									colorSpace,
								},
							};

							await this.muxer!.addVideoChunk(chunk, metadata);
						} else {
							await this.muxer!.addVideoChunk(chunk, meta);
						}
					} catch (error) {
						console.error("Muxing error:", error);
						const muxingError =
							error instanceof Error ? error : new Error(String(error));
						if (!this.encoderError) {
							this.encoderError = muxingError;
						}
						this.cancelled = true;
					}
				});
				this.encodeQueue--;
				this.notifyEncodeCapacityAvailable();
			},
			error: (error) => {
				console.error(
					`[VideoExporter] Encoder error (codec: ${resolvedCodec}, ${this.config.width}x${this.config.height}):`,
					error,
				);
				this.encoderError = error instanceof Error ? error : new Error(String(error));
				this.cancelled = true;
				this.notifyEncodeCapacityAvailable();
			},
		});

		const baseConfig: Omit<
			VideoEncoderConfig,
			"codec" | "hardwareAcceleration" | "latencyMode"
		> = {
			width: this.config.width,
			height: this.config.height,
			bitrate: this.config.bitrate,
			framerate: this.config.frameRate,
			bitrateMode: "variable",
		};

		for (const candidate of encoderCandidates) {
			for (const latencyMode of latencyModePreferences) {
				const config: VideoEncoderConfig = {
					...baseConfig,
					codec: candidate.codec,
					hardwareAcceleration: candidate.hardwareAcceleration,
					latencyMode,
				};
				const support = await VideoEncoder.isConfigSupported(config);
				if (support.supported) {
					resolvedCodec = candidate.codec;
					this.encodeBackend = "webcodecs";
					this.encoderName = `${candidate.codec}/${candidate.hardwareAcceleration}/${latencyMode}`;
					console.log(
						`[VideoExporter] Using ${candidate.hardwareAcceleration} ${latencyMode} encoder path with codec ${candidate.codec}`,
					);
					this.encoder.configure(config);
					return candidate;
				}

				console.warn(
					`[VideoExporter] Encoder path ${candidate.codec}/${candidate.hardwareAcceleration}/${latencyMode} is not supported (${this.config.width}x${this.config.height}), trying next...`,
				);
			}
		}

		throw new Error(
			`Video encoding not supported on this system. ` +
				`Tried encoder paths: ${encoderCandidates
					.map((candidate) => `${candidate.codec}/${candidate.hardwareAcceleration}`)
					.join(", ")} at ${this.config.width}x${this.config.height}. ` +
				`Your browser or hardware may not support H.264 encoding at this resolution. ` +
				`Try exporting at a lower quality setting.`,
		);
	}

	private getEncoderCandidates(): SupportedMp4EncoderPath[] {
		return getOrderedSupportedMp4EncoderCandidates({
			codec: this.config.codec,
			preferredEncoderPath: this.config.preferredEncoderPath,
		});
	}

	private disposeEncoder(): void {
		if (!this.encoder) {
			return;
		}

		try {
			if (this.encoder.state !== "closed") {
				this.encoder.close();
			}
		} catch (error) {
			console.warn("Error closing encoder:", error);
		}

		this.encoder = null;
		this.encodeQueue = 0;
		this.pendingMuxing = Promise.resolve();
		this.chunkCount = 0;
		this.videoDescription = undefined;
		this.videoColorSpace = undefined;
		this.webCodecsEncodeQueueLimit = 0;
		this.keyFrameInterval = 0;
		this.encodeBackend = null;
		this.encoderName = null;
	}

	cancel(): void {
		this.cancelled = true;
		if (this.streamingDecoder) {
			this.streamingDecoder.cancel();
		}
		if (this.audioProcessor) {
			this.audioProcessor.cancel();
		}
		this.disposeNativeH264Encoder();

		const nativeExportSessionId = this.nativeExportSessionId;
		this.nativeExportSessionId = null;
		if (nativeExportSessionId && typeof window !== "undefined") {
			void window.electronAPI?.nativeVideoExportCancel?.(nativeExportSessionId);
		}
	}

	private cleanup(): void {
		this.disposeEncoder();

		if (this.streamingDecoder) {
			try {
				this.streamingDecoder.destroy();
			} catch (e) {
				console.warn("Error destroying streaming decoder:", e);
			}
			this.streamingDecoder = null;
		}

		if (this.renderer) {
			try {
				this.renderer.destroy();
			} catch (e) {
				console.warn("Error destroying renderer:", e);
			}
			this.renderer = null;
		}

		if (this.muxer) {
			try {
				this.muxer.destroy();
			} catch (e) {
				console.warn("Error destroying muxer:", e);
			}
		}

		this.muxer = null;
		this.audioProcessor?.cancel();
		this.audioProcessor = null;
		this.disposeNativeH264Encoder();
		const nativeExportSessionId = this.nativeExportSessionId;
		this.nativeExportSessionId = null;
		if (nativeExportSessionId && typeof window !== "undefined") {
			void window.electronAPI?.nativeVideoExportCancel?.(nativeExportSessionId);
		}
		this.encodeQueue = 0;
		this.pendingMuxing = Promise.resolve();
		this.chunkCount = 0;
		this.exportStartTimeMs = 0;
		this.lastThroughputLogTimeMs = 0;
		this.totalExportStartTimeMs = 0;
		this.metadataLoadTimeMs = 0;
		this.rendererInitTimeMs = 0;
		this.nativeSessionStartTimeMs = 0;
		this.decodeLoopTimeMs = 0;
		this.frameCallbackTimeMs = 0;
		this.renderFrameTimeMs = 0;
		this.encodeWaitTimeMs = 0;
		this.encodeWaitEvents = 0;
		this.encoderError = null;
		this.peakEncodeQueueSize = 0;
		this.peakNativeWriteInFlight = 0;
		this.nativeCaptureTimeMs = 0;
		this.nativeWriteTimeMs = 0;
		this.finalizationTimeMs = 0;
		this.finalizationStageMs = {};
		this.effectiveDurationSec = 0;
		this.processedFrameCount = 0;
		this.activeFinalizationProgressWatchdog = null;
		this.lastFinalizationRenderProgress =
			INITIAL_FINALIZATION_PROGRESS_STATE.lastRenderProgress;
		this.lastFinalizationAudioProgress = INITIAL_FINALIZATION_PROGRESS_STATE.lastAudioProgress;
		this.lastProgressSampleTimeMs = 0;
		this.lastProgressSampleFrame = 0;
		this.displayedRenderFps = 0;
		this.nativeWritePromises = new Set();
		this.nativeWriteError = null;
		this.pendingNativeWriteChunks = [];
		this.pendingNativeWriteBytes = 0;
		this.maxNativeWriteInFlight = 1;
		this.notifyEncodeCapacityAvailable();
		this.encodeCapacityWaiters.clear();
		this.videoDescription = undefined;
		this.videoColorSpace = undefined;
		this.renderBackend = null;
		this.encodeBackend = null;
		this.encoderName = null;
		this.backpressureProfile = null;
		this.lastNativeExportError = null;
	}
}
