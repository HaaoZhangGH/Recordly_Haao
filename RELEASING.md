# Apple Silicon builds and releases

This fork builds macOS arm64 only. Local testing does not require publishing a GitHub release or configuring a Homebrew tap.

## Local build

Use an Apple Silicon Mac, arm64 Node.js 22+, Xcode Command Line Tools, and CMake.

```sh
npm ci
npm run typecheck
npm test
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:mac
npm run smoke:packaged-binaries
```

Artifacts are created in `release/`. Installation and native helper builds reject unsupported hosts. Existing recording/project files remain compatible.

## Signed distribution

The manual build workflow produces arm64 artifacts. The release workflow builds an existing release tag, validates it against `package.json`, and publishes arm64 DMG/ZIP artifacts and macOS update metadata. It requires your own Apple signing certificate/password, Apple ID, app-specific password, and team ID secrets.

The release-candidate workflow validates the current `main` commit before signing/notarization. Distribution verification accepts only `--arch arm64`. Windows, Linux, Intel Mac, Winget, and upstream Homebrew publishing jobs have been removed.

Before publishing, configure this fork's repository and update feed in `package.json` and `electron-builder.json5`. Keep the original project's attribution and license. Editing files locally does not create or publish a release.
