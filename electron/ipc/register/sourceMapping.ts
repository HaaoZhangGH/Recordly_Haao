export function getScreenSourceIdForDisplay({
	displayId,
	matchedSourceId,
}: {
	displayId: string;
	env?: NodeJS.ProcessEnv;
	matchedSourceId?: string | null;
	platform: NodeJS.Platform | string;
}) {
	if (matchedSourceId) {
		return matchedSourceId;
	}

	return `screen:fallback:${displayId}`;
}
