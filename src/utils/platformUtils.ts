export const isMac = async (): Promise<boolean> => true;
export const getModifierKey = async (): Promise<string> => "⌘";
export const getShiftKey = async (): Promise<string> => "⇧";
export const formatShortcut = async (keys: string[]): Promise<string> =>
	keys
		.map((key) => {
			if (key.toLowerCase() === "mod") return "⌘";
			if (key.toLowerCase() === "shift") return "⇧";
			return key;
		})
		.join(" + ");
