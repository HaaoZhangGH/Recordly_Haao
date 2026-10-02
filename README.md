# Recordly — Apple Silicon fork

Language: EN | [简中](README.zh-CN.md)

A personal fork of [Recordly](https://github.com/webadderallorg/Recordly), focused on Apple Silicon Macs running macOS 14 or later. The original project is an open-source screen recorder and editor.

## Features

- Display/window recording through native ScreenCaptureKit helpers
- Microphone, system audio, and webcam recording
- Cursor tracking, click effects, automatic/manual zoom
- Timeline trimming, speed changes, crop, annotations, extra audio tracks
- Wallpapers, backgrounds, shadows, webcam overlays
- Local `.recordly` project saving and reopening
- MP4/GIF export, VideoToolbox and WebCodecs encoding
- Local Whisper captions, languages, accounts, sharing, feedback

## Scope

Only macOS `arm64` is supported. Windows/Linux capture and compatibility branches, Windows GPU/CUDA compositors, Intel Mac binaries/build targets, and the disabled extensions marketplace placeholder have been removed. The Electron/React interface is retained; native SwiftUI or Liquid Glass UI is not part of this change.

## Development

Use arm64 Node.js 22+, Xcode Command Line Tools, and CMake. Installation stages Whisper and builds Swift helpers for arm64 only.

```sh
npm ci
npm run dev
```

If your terminal sets `ELECTRON_RUN_AS_NODE`, unset it before starting. Recording, microphone, camera, and accessibility permissions are managed by macOS.

```sh
npm run typecheck
npm test
npm run i18n:check
npm run build:mac
npm run smoke:packaged-binaries
```

`build:mac` creates arm64 DMG/ZIP artifacts in `release/`. Local unsigned builds can set `CSC_IDENTITY_AUTO_DISCOVERY=false`. Signed distribution requires your own credentials; see [RELEASING.md](RELEASING.md).

## Technology

Electron, React, TypeScript, Vite, Tailwind CSS, PixiJS/WebGL, WebCodecs, FFmpeg, and Swift helpers using ScreenCaptureKit/AVFoundation. Captions use whisper.cpp. Online features retain the existing Supabase and sharing integrations.

## Attribution and license

Based on Recordly by its original authors and contributors. Their notices and the [AGPL-3.0 license](LICENSE.md) are retained. This personal adaptation is not an official upstream release.
