# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-14

Initial release.

### Added

- Electron shell that hosts the official DeepSeek Harness web GUI (`@deepseek-ai/dsh` 0.1.0-rc.6) in a native window
- DeepSeek whale app icon (window, taskbar, NSIS installer) generated from the official App Store artwork
- Single-instance lock, window bounds persistence, external-link handoff to the system browser
- Loading screen during server boot and a restart dialog on unexpected server exit
- Controlled server lifecycle: quitting the app stops the local server
- Headless smoke test (`npm run smoke`) covering server start, boot-manifest injection, and UI paint
- GitHub Actions release workflow (Windows NSIS/portable, Linux AppImage, macOS DMG/zip)

