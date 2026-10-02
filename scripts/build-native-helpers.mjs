import { spawnSync } from "node:child_process";
import { chmod, mkdir, copyFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const projectRoot = process.cwd();
const nativeRoot = path.join(projectRoot, "electron", "native");
const moduleCacheRoot = path.join(os.tmpdir(), "recordly-swift-module-cache");

if (process.platform !== "darwin" || process.arch !== "arm64") {
	throw new Error("Recordly supports Apple Silicon Macs only. Use an arm64 Node.js runtime.");
}

function getTargetConfigs() {
	return [
		{
			archTag: "darwin-arm64",
			swiftTarget: "arm64-apple-macos14.0",
		},
	];
}

const helpers = [
	{
		source: "ScreenCaptureKitRecorder.swift",
		output: "recordly-screencapturekit-helper",
	},
	{
		source: "ScreenCaptureKitWindowList.swift",
		output: "recordly-window-list",
	},
	{
		source: "SystemCursorAssets.swift",
		output: "recordly-system-cursors",
	},
	{
		source: "NativeCursorMonitor.swift",
		output: "recordly-native-cursor-monitor",
	},
];

const swiftcCheck = spawnSync("swiftc", ["--version"], { encoding: "utf8" });
if (swiftcCheck.status !== 0) {
	const details = [swiftcCheck.stderr, swiftcCheck.stdout].filter(Boolean).join("\n").trim();
	throw new Error(details || "swiftc is unavailable; install Xcode Command Line Tools.");
}

for (const target of getTargetConfigs()) {
	const outputDir = path.join(nativeRoot, "bin", target.archTag);
	await mkdir(outputDir, { recursive: true });

	for (const helper of helpers) {
		const sourcePath = path.join(nativeRoot, helper.source);
		const outputPath = path.join(outputDir, helper.output);

		const result = spawnSync(
			"swiftc",
			["-O", "-target", target.swiftTarget, sourcePath, "-o", outputPath],
			{
				encoding: "utf8",
				env: {
					...process.env,
					CLANG_MODULE_CACHE_PATH: path.join(moduleCacheRoot, "clang"),
					SWIFT_MODULECACHE_PATH: path.join(moduleCacheRoot, "swift"),
				},
				timeout: 120000,
			},
		);

		if (result.status !== 0) {
			const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
			throw new Error(details || `Failed to compile ${helper.source} for ${target.archTag}`);
		}

		await chmod(outputPath, 0o755);
		console.log(
			`[build-native-helpers] Built ${helper.output} (${target.archTag}) -> ${outputPath}`,
		);
	}
}

// LaunchServices needs an application identity for the system sharing picker.
// A bare CLI inherits the host application's identity (for example Codex).
const pickerContents = path.join(
	nativeRoot,
	"bin",
	"darwin-arm64",
	"Recordly Picker.app",
	"Contents",
);
await mkdir(path.join(pickerContents, "MacOS"), { recursive: true });
await mkdir(path.join(pickerContents, "Resources"), { recursive: true });
await copyFile(
	path.join(nativeRoot, "bin", "darwin-arm64", "recordly-window-list"),
	path.join(pickerContents, "MacOS", "RecordlyPicker"),
);
await copyFile(
	path.join(projectRoot, "icons", "icons", "mac", "icon.icns"),
	path.join(pickerContents, "Resources", "icon.icns"),
);
await writeFile(
	path.join(pickerContents, "Info.plist"),
	`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.recordly.source-picker</string>
<key>CFBundleName</key><string>Recordly Picker</string>
<key>CFBundleDisplayName</key><string>Recordly</string>
<key>CFBundleExecutable</key><string>RecordlyPicker</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleIconFile</key><string>icon.icns</string>
<key>LSMinimumSystemVersion</key><string>15.2</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>`,
);
const signPicker = spawnSync("codesign", ["--force", "--sign", "-", path.dirname(pickerContents)], {
	encoding: "utf8",
});
if (signPicker.status !== 0)
	throw new Error(signPicker.stderr || "Failed to sign the source picker");
console.log("[build-native-helpers] Built Recordly Picker.app");
