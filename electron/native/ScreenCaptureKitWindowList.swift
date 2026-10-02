import Foundation
import AppKit
import CoreGraphics
import ScreenCaptureKit

struct WindowListEntry: Codable {
	let id: String
	let name: String
	let display_id: String
	let appName: String?
	let windowTitle: String?
	let bundleId: String?
	let x: Double
	let y: Double
	let width: Double
	let height: Double
}

func normalize(_ value: String?) -> String? {
	guard let rawValue = value?.trimmingCharacters(in: .whitespacesAndNewlines), !rawValue.isEmpty else {
		return nil
	}

	return rawValue
}

let excludedBundleIds: Set<String> = [
	"com.apple.controlcenter",
	"com.apple.dock",
	"com.apple.WindowManager",
	"com.apple.wallpaper.agent",
]

let excludedWindowTitles: Set<String> = [
	"Display 1 Backstop",
	"Event Shield Window",
	"Menubar",
	"Offscreen Wallpaper Window",
	"Wallpaper-",
]

// Force CoreGraphics Services initialization before asking ScreenCaptureKit for
// shareable content. Without this, the helper can stall sporadically when run
// as a standalone CLI process from Electron.
let _ = CGMainDisplayID()

// The picker only selects a target. Recording remains in the existing capture
// helper, with the parent's screen-recording permission and capture settings.
@available(macOS 15.2, *)
final class SourcePicker: NSObject, NSApplicationDelegate, SCContentSharingPickerObserver {
	private let mode: String
	private var finished = false
	private var lifetimeTimer: Timer?
	private var resultURL: URL { URL(fileURLWithPath: CommandLine.arguments[3]) }

	init(mode: String) { self.mode = mode }

	func applicationDidFinishLaunching(_ notification: Notification) {
		fputs("PICKER_LAUNCHED\n", stderr)
		fflush(stderr)
		let picker = SCContentSharingPicker.shared
		var configuration = SCContentSharingPickerConfiguration()
		configuration.allowedPickerModes = mode == "window" ? [.singleWindow] : [.singleDisplay]
		configuration.allowsChangingSelectedContent = false
		// Electron's windows are hidden while selecting. Exclude their IDs as well.
		configuration.excludedWindowIDs = CommandLine.arguments.dropFirst(5).compactMap {
			Int($0)
		}
		picker.defaultConfiguration = configuration
		picker.add(self)
		picker.maximumStreamCount = 1
		picker.isActive = true
		NSApp.activate(ignoringOtherApps: true)
		picker.present(using: mode == "window" ? .window : .display)
		lifetimeTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
			guard let self else { return }
			let parentPID = Int32(CommandLine.arguments[4]) ?? 0
			let directory = self.resultURL.deletingLastPathComponent().path
			if !FileManager.default.fileExists(atPath: directory) ||
				FileManager.default.fileExists(atPath: directory + "/cancel") ||
				parentPID <= 0 || kill(parentPID, 0) != 0 {
				self.finish(["cancelled": true])
			}
		}
		fputs("PICKER_PRESENTED\n", stderr)
		fflush(stderr)
	}

	private func finish(_ result: [String: Any]) {
		guard !finished else { return }
		finished = true
		lifetimeTimer?.invalidate()
		let picker = SCContentSharingPicker.shared
		picker.isActive = false
		picker.remove(self)
		if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) {
			try? data.write(to: resultURL, options: .atomic)
		}
		fflush(stdout)
		NSApp.terminate(nil)
	}

	func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
		DispatchQueue.main.async { self.finish(["cancelled": true]) }
	}

	func contentSharingPickerStartDidFailWithError(_ error: Error) {
		DispatchQueue.main.async { self.finish(["error": error.localizedDescription]) }
	}

	func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
		DispatchQueue.main.async {
			if self.mode == "window", let window = filter.includedWindows.first {
				let appName = window.owningApplication?.applicationName ?? ""
				let title = normalize(window.title) ?? appName
				self.finish(["source": [
					"id": "window:\(window.windowID):0", "name": title,
					"appName": appName, "windowTitle": title,
					"sourceType": "window", "display_id": "",
					"thumbnail": NSNull(), "appIcon": NSNull()
				]])
			} else if self.mode == "screen", let display = filter.includedDisplays.first {
				self.finish(["source": [
					"id": "screen:fallback:\(display.displayID)",
					"name": "\(NSLocalizedString("Screen", comment: "Display capture target")) \(display.displayID)",
					"sourceType": "screen", "display_id": String(display.displayID),
					"thumbnail": NSNull(), "appIcon": NSNull()
				]])
			} else {
				self.finish(["error": "The selected capture target is unavailable."])
			}
		}
	}
}

if CommandLine.arguments.count >= 5, CommandLine.arguments[1] == "--pick" {
	if #available(macOS 15.2, *) {
		let application = NSApplication.shared
		// The system picker requires a regular application while it is presented.
		application.setActivationPolicy(.regular)
		let picker = SourcePicker(mode: CommandLine.arguments[2])
		application.delegate = picker
		withExtendedLifetime(picker) { application.run() }
	} else {
		print("{\"error\":\"System target selection requires macOS 15.2 or later.\"}")
	}
	exit(0)
}

let group = DispatchGroup()
group.enter()

Task {
	do {
		let shareableContent = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)

		struct RawWindowEntry {
			let entry: WindowListEntry
			let hasRawTitle: Bool
			let bundleId: String?
		}

		let rawEntries = shareableContent.windows.compactMap { window -> RawWindowEntry? in
			let appName = normalize(window.owningApplication?.applicationName)
			let windowTitle = normalize(window.title)
			let bundleId = normalize(window.owningApplication?.bundleIdentifier)
			let frame = window.frame

			guard window.windowLayer == 0 else {
				return nil
			}

			guard frame.width >= 50, frame.height >= 50 else {
				return nil
			}

			guard appName != nil || windowTitle != nil else {
				return nil
			}

			if let bundleId, excludedBundleIds.contains(bundleId) {
				return nil
			}

			if let windowTitle, excludedWindowTitles.contains(windowTitle) {
				return nil
			}

			let matchedDisplay = shareableContent.displays.first(where: { display in
				display.frame.intersects(frame) || display.frame.contains(CGPoint(x: frame.midX, y: frame.midY))
			})

			let resolvedWindowTitle = windowTitle ?? appName ?? "Window"
			let resolvedName: String
			if let appName, let windowTitle {
				resolvedName = "\(appName) — \(windowTitle)"
			} else {
				resolvedName = resolvedWindowTitle
			}

			let entry = WindowListEntry(
				id: "window:\(window.windowID):0",
				name: resolvedName,
				display_id: matchedDisplay.map { String($0.displayID) } ?? "",
				appName: appName,
				windowTitle: resolvedWindowTitle,
				bundleId: bundleId,
				x: Double(frame.origin.x),
				y: Double(frame.origin.y),
				width: Double(frame.width),
				height: Double(frame.height)
			)

			return RawWindowEntry(entry: entry, hasRawTitle: windowTitle != nil, bundleId: bundleId)
		}

		// For apps with multiple windows, drop auxiliary windows that lack a
		// distinct title (e.g. Arc's sidebar/tab-bar chrome). If ALL windows
		// from an app lack titles, keep them all.
		var titledCountByBundle: [String: Int] = [:]
		for raw in rawEntries {
			if let bid = raw.bundleId, raw.hasRawTitle {
				titledCountByBundle[bid, default: 0] += 1
			}
		}

		let entries = rawEntries
			.filter { raw in
				guard let bid = raw.bundleId else { return true }
				if let titled = titledCountByBundle[bid], titled > 0 {
					return raw.hasRawTitle
				}
				return true
			}
			.map { $0.entry }
		.sorted { lhs, rhs in
			let lhsApp = lhs.appName ?? lhs.name
			let rhsApp = rhs.appName ?? rhs.name
			if lhsApp != rhsApp {
				return lhsApp.localizedCaseInsensitiveCompare(rhsApp) == .orderedAscending
			}

			return (lhs.windowTitle ?? lhs.name).localizedCaseInsensitiveCompare(rhs.windowTitle ?? rhs.name) == .orderedAscending
		}

		let encoder = JSONEncoder()
		encoder.outputFormatting = [.sortedKeys]
		let data = try encoder.encode(entries)
		FileHandle.standardOutput.write(data)
	} catch {
		fputs("Error listing windows: \(error.localizedDescription)\n", stderr)
		fflush(stderr)
		exit(1)
	}

	group.leave()
}

group.wait()
