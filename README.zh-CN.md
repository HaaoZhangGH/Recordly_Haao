# Recordly — Apple Silicon 自用版

语言：[EN](README.md) | 简中

基于 [Recordly](https://github.com/webadderallorg/Recordly) 的个人 fork，仅面向搭载苹果芯片、运行 macOS 14 及以上版本的 Mac。

## 保留功能

- ScreenCaptureKit 原生屏幕和窗口录制
- 麦克风、系统音频、摄像头录制
- 光标追踪、点击效果、自动与手动缩放
- 时间线剪辑、速度调整、裁剪、标注、额外音轨
- 壁纸、背景、阴影、摄像头叠加
- 本地 `.recordly` 项目保存与重新打开
- MP4、GIF 导出，VideoToolbox 与 WebCodecs 编码
- 本地 Whisper 字幕、多语言、账号、分享与反馈功能

## 已精简的内容

Windows/Linux 捕获与兼容分支、Windows GPU/CUDA 合成器、Intel Mac 二进制与构建目标，以及已停用的扩展市场占位入口。

本轮继续使用 Electron/React 界面，没有引入 SwiftUI 或原生液态玻璃界面。

## 开发与构建

需要 arm64 版 Node.js 22+、Xcode Command Line Tools 和 CMake。安装时准备 Whisper，并且只构建 arm64 的 Swift 原生辅助程序。

```sh
npm ci
npm run dev
```

如果终端设置了 `ELECTRON_RUN_AS_NODE`，启动前应取消这个环境变量。录屏、麦克风、摄像头和辅助功能权限由 macOS 管理。

```sh
npm run typecheck
npm test
npm run i18n:check
npm run build:mac
npm run smoke:packaged-binaries
```

构建仅输出 arm64 的 DMG、ZIP，位于 `release/`。本地未签名构建可设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`。签名分发需要自己的 Apple 证书与公证凭据，见 [RELEASING.md](RELEASING.md)。

## 技术栈与许可

Electron、React、TypeScript、Vite、Tailwind CSS、PixiJS/WebGL、WebCodecs、FFmpeg，以及使用 ScreenCaptureKit/AVFoundation 的 Swift 辅助程序。字幕使用 whisper.cpp。在线功能保留现有 Supabase 和分享服务集成。

保留 Recordly 原作者与贡献者的署名，以及 [AGPL-3.0 许可](LICENSE.md)。这是个人适配版本，并非上游官方发布版。
