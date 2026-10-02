import {
	type Dispatch,
	type MutableRefObject,
	type SetStateAction,
	useCallback,
	useEffect,
} from "react";
import type { CursorTelemetryPoint, ZoomRegion } from "../types";

interface UseFreshRecordingAutoZoomParams {
	videoPath: string | null;
	loading: boolean;
	isPreviewReady: boolean;
	duration: number;
	cursorTelemetryCount: number;
	normalizedCursorTelemetry: CursorTelemetryPoint[];
	zoomRegions: ZoomRegion[];
	setAutoSuggestZoomsTrigger: Dispatch<SetStateAction<number>>;
	autoSuggestedVideoPathRef: MutableRefObject<string | null>;
	pendingFreshRecordingAutoZoomPathRef: MutableRefObject<string | null>;
	pendingFreshRecordingAutoSuggestTimeoutRef: MutableRefObject<number | null>;
	pendingFreshRecordingAutoSuggestTelemetryCountRef: MutableRefObject<number>;
}

export function useFreshRecordingAutoZoom({
	videoPath,
	loading,
	isPreviewReady,
	duration,
	cursorTelemetryCount,
	normalizedCursorTelemetry,
	zoomRegions,
	setAutoSuggestZoomsTrigger,
	autoSuggestedVideoPathRef,
	pendingFreshRecordingAutoZoomPathRef,
	pendingFreshRecordingAutoSuggestTimeoutRef,
	pendingFreshRecordingAutoSuggestTelemetryCountRef,
}: UseFreshRecordingAutoZoomParams) {
	const handleAutoSuggestZoomsConsumed = useCallback(() => {
		setAutoSuggestZoomsTrigger(0);
	}, [setAutoSuggestZoomsTrigger]);

	useEffect(() => {
		if (
			!videoPath ||
			loading ||
			!isPreviewReady ||
			duration <= 0 ||
			zoomRegions.length > 0 ||
			normalizedCursorTelemetry.length < 2
		) {
			if (pendingFreshRecordingAutoSuggestTimeoutRef.current !== null) {
				window.clearTimeout(pendingFreshRecordingAutoSuggestTimeoutRef.current);
				pendingFreshRecordingAutoSuggestTimeoutRef.current = null;
			}
			return;
		}

		if (pendingFreshRecordingAutoZoomPathRef.current !== videoPath) return;
		if (autoSuggestedVideoPathRef.current === videoPath) {
			pendingFreshRecordingAutoZoomPathRef.current = null;
			return;
		}
		if (pendingFreshRecordingAutoSuggestTelemetryCountRef.current === cursorTelemetryCount) {
			return;
		}

		pendingFreshRecordingAutoSuggestTelemetryCountRef.current = cursorTelemetryCount;
		if (pendingFreshRecordingAutoSuggestTimeoutRef.current !== null) {
			window.clearTimeout(pendingFreshRecordingAutoSuggestTimeoutRef.current);
		}

		pendingFreshRecordingAutoSuggestTimeoutRef.current = window.setTimeout(() => {
			pendingFreshRecordingAutoSuggestTimeoutRef.current = null;
			if (
				pendingFreshRecordingAutoZoomPathRef.current !== videoPath ||
				autoSuggestedVideoPathRef.current === videoPath ||
				zoomRegions.length > 0
			) {
				return;
			}
			setAutoSuggestZoomsTrigger((value) => value + 1);
		}, 500);
	}, [
		videoPath,
		loading,
		isPreviewReady,
		duration,
		cursorTelemetryCount,
		normalizedCursorTelemetry,
		zoomRegions,
		autoSuggestedVideoPathRef,
		pendingFreshRecordingAutoSuggestTelemetryCountRef,
		pendingFreshRecordingAutoSuggestTimeoutRef,
		pendingFreshRecordingAutoZoomPathRef,
		setAutoSuggestZoomsTrigger,
	]);

	return { handleAutoSuggestZoomsConsumed };
}
