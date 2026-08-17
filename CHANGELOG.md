# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-08-17

### Added

- **Full-screen usage overlay** (click the bottom-left 使用统计 pill): the panel now fills the window with a wider layout
- **Bar chart hover details**: moving the cursor over a day's bar shows that day's date, total tokens, input / cache read–write / output, and message count
- **Per-model donut**: the ring is split by model (from the session logs' per-message model attribution) with a legend listing every model's name and percentage; hovering a sector shows the model's exact usage and share
- A 使用模型 summary card counts the distinct models used in the selected range
- Token/year model accounting now derives from per-file log aggregates (rebuilt in memory each scan), so a re-read session log replaces its contribution instead of double counting across incremental scans

### Changed

- The separate “Token 用量” composition donut was replaced by the per-model breakdown the stats page needs

## [0.4.0] - 2026-08-17

### Added

- **Chart-based token usage inside the harness GUI**: a “使用统计” pill is injected at the bottom-left of the harness window, docked to the harness's own 设置 trigger, and opens a dark panel with a per-day token **bar chart**, an input/output/cache **donut chart**, range switching (最近7天/最近30天/全部), and summary cards — the update check lives here too
- The injected overlay is delivered by a sandboxed preload on the main window; all styling goes through CSSOM/SVG attributes so the harness page's CSP never blocks it

### Changed

- Removed the separate settings window and its top-level “设置” menu (the app now surfaces usage and updates inside the harness GUI's bottom-left settings area, as requested)
- Token donut composition is mutually exclusive (uncached input / cache reads / cache writes / output), so segment percentages sum to 100%

## [0.3.0] - 2026-08-17

### Added

- **Token usage statistics** in the app's own settings page (菜单 设置 → 使用统计, `Ctrl+,`):
  - Exact provider token accounting (input / output / cache-read / cache-write) extracted from the harness's durable session logs (`~/.dsh/sessions`, concatenated-frame zstd archives decoded with the harness's own frame layout) and attributed to local calendar days
  - Incremental scanning: unchanged session logs are skipped by mtime/size, so background refreshes every 20 seconds stay near-free after the first pass
  - Simplified settings page focused on tokens: range toggle (最近7天/最近30天/全部), summary cards (Token 用量 / 输入 / 输出 / 活跃天数), per-day breakdown table with activity bars; the previous scaffolded sidebar and "coming soon" placeholders were removed
- **In-app update check** (设置菜单与统计页的“检查更新”按钮): compares against the latest GitHub release, downloads the NSIS installer with progress, and hands off to the installer after quitting
- Daily counters now persist the merged token fields alongside the HTTP-derived request/message/session counters

### Changed

- The statistics page no longer scaffolds future settings sections; it shows only what works today

## [0.2.0] - 2026-08-16

### Added

- Per-day usage recording with no retention limit: every `POST /api/*` call the GUI makes is folded into daily counters (requests, messages, sessions, sub-agent prompts) and persisted forever in `usage.json` under the app data directory
- App-owned settings window (菜单 设置 → 使用统计, `Ctrl+,`) with a ZCode-style dark layout and a per-day 每日用量 table that live-updates while the window is open
- The harness's own boot-time `workspace.*` calls are excluded as internal plumbing
- Headless smoke test now also opens the settings window and asserts it paints over the usage IPC bridge

## [0.1.0] - 2026-08-14

Initial release.

### Added

- Electron shell that hosts the official DeepSeek Harness web GUI (`@deepseek-ai/dsh` 0.1.0-rc.6) in a native window
- DeepSeek whale app icon (window, taskbar, NSIS installer) generated from the official App Store artwork
- Single-instance lock, window bounds persistence, external-link handoff to the system browser
- Loading screen during server boot and a restart dialog on unexpected server exit
- Controlled server lifecycle: quitting the app stops the local server
- Skills & Plugins menu: open skill directories, edit the web profile's `cordis.patch.yml`, open the plugin directory, and restart the server
- Headless smoke test (`npm run smoke`) covering server start, boot-manifest injection, and UI paint
- GitHub Actions release workflow (Windows NSIS/portable zip, Linux AppImage, macOS DMG/zip)

