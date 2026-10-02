import type { RecordingPermissionIssue } from "@/lib/recordingPermissions";
import { useCallback, useEffect, useMemo, type ReactElement, useState } from "react";
import { SourceSelectorContent } from "../SourceSelector";
import { useLaunchPopoverCoordinator } from "./LaunchPopoverCoordinator";
import {
	mapRawSource,
	isScreenSource,
	isWindowSource,
	type DesktopSource,
} from "./launchPopoverTypes";
import { AppWindowIcon, MonitorIcon } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { useScopedT } from "@/contexts/I18nContext";
import { DropdownItem, HudPopover } from "./PopoverScaffold";

const POPOVER_ID = "sources";

export function SourcePopover({
	trigger,
	selectedSource,
	onSourceSelect,
	onPickMode,
	onOpen,
	error,
	permissionIssue,
}: {
	trigger: ReactElement;
	selectedSource: string;
	onSourceSelect: (source: DesktopSource) => Promise<void> | void;
	onPickMode: (mode: "screen" | "window") => void;
	onOpen?: () => void;
	error?: string | null;
	permissionIssue?: RecordingPermissionIssue | null;
}) {
	const t = useScopedT("launch");
	const { isOpen, requestOpen, requestClose } = useLaunchPopoverCoordinator();
	const [sources, setSources] = useState<DesktopSource[]>([]);
	const [loading, setLoading] = useState(false);
	const [showList, setShowList] = useState(false);
	const open = isOpen(POPOVER_ID);
	const fetchSources = useCallback(async () => {
		setLoading(true);
		try {
			const raw = await window.electronAPI.getSources({
				types: ["screen", "window"],
				thumbnailSize: { width: 160, height: 90 },
				fetchWindowIcons: true,
			});
			setSources(raw.map((source) => mapRawSource(source as DesktopSource)));
		} catch (error) {
			console.error("Failed to fetch sources:", error);
		} finally {
			setLoading(false);
		}
	}, []);
	useEffect(() => {
		if (open && !permissionIssue && (showList || error)) void fetchSources();
	}, [open, showList, error, permissionIssue, fetchSources]);
	const screenSources = useMemo(() => sources.filter(isScreenSource), [sources]);
	const windowSources = useMemo(() => sources.filter(isWindowSource), [sources]);
	return (
		<HudPopover
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) {
					requestClose(POPOVER_ID);
					return;
				}
				onOpen?.();
				requestOpen(POPOVER_ID);
			}}
			trigger={trigger}
			align="start"
		>
			<DropdownItem
				icon={<AppWindowIcon size={18} />}
				onClick={() => {
					requestClose(POPOVER_ID);
					onPickMode("window");
				}}
			>
				{t("recording.pickWindow")}
			</DropdownItem>
			<DropdownItem
				icon={<MonitorIcon size={18} />}
				onClick={() => {
					requestClose(POPOVER_ID);
					onPickMode("screen");
				}}
			>
				{t("recording.pickScreen")}
			</DropdownItem>
			<p className="px-3 py-2 text-xs text-muted-foreground max-w-[280px]">
				{t("recording.pickerHint")}
			</p>
			{permissionIssue && (
				<div className="px-3 py-2 max-w-[280px]">
					<p role="status" className="text-xs text-muted-foreground">
						{t(`recording.permission_${permissionIssue}`)}
					</p>
					{permissionIssue !== "unavailable" && (
						<Button
							variant="ghost"
							className="mt-2 text-xs"
							onClick={() => {
								if (permissionIssue === "screen")
									void window.electronAPI.openScreenRecordingPreferences();
								else void window.electronAPI.openAccessibilityPreferences();
							}}
						>
							{t("recording.openPermissionSettings")}
						</Button>
					)}
				</div>
			)}
			{error && (
				<p role="alert" className="px-3 py-2 text-xs text-destructive max-w-[280px]">
					{t("recording.pickerFailed")}
				</p>
			)}
			<Button
				variant="ghost"
				className="w-full justify-start text-xs"
				onClick={() => setShowList(!showList)}
			>
				{t("recording.chooseFromList")}
			</Button>
			{!permissionIssue && (showList || error) && (
				<div className="max-h-[300px] overflow-y-auto">
					<SourceSelectorContent
						screenSources={screenSources}
						windowSources={windowSources}
						selectedSource={selectedSource}
						loading={loading}
						onSourceSelect={async (source) => {
							requestClose(POPOVER_ID);
							await onSourceSelect(source);
						}}
					/>
				</div>
			)}
		</HudPopover>
	);
}
