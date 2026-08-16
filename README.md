# DeepSeek Harness Desktop 🐋

> 非官方桌面壳：把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的官方 Web GUI 装进原生窗口。软件图标使用 DeepSeek 官方鲸鱼标志。
>
> Unofficial desktop shell that hosts the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web GUI in a native window, with the DeepSeek whale logo as the app icon.

[English](#english) · [中文](#中文)

---

## English

A native desktop wrapper for DeepSeek Harness, built with Electron.

**How it works** — this app adds nothing on top of the official stack: it starts the published [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh) CLI with `web --port 0`, waits for its readiness line, and loads the resulting local URL in an Electron window. The Electron binary doubles as the Node.js runtime (`ELECTRON_RUN_AS_NODE`), so the packaged app needs no system Node.js.

**Features**

- Native window with the official DeepSeek whale icon (taskbar, window, installer)
- Same web GUI as `dsh web` — every feature, plugin, and session works identically
- Single-instance lock; launching again focuses the existing window
- Remembers window size/position across restarts
- External links open in your system browser, never inside the app
- Loading screen while the local server boots; restart dialog if it ever dies
- Quitting the app stops the local server (sessions persist per event)
- Standard application menu (Edit/View/Window roles, project links, About)

**Usage**

1. Grab an installer from [Releases](../../releases) (or build it yourself, below).
2. On first run, follow the same onboarding as the web version: add a DeepSeek API key or another OpenAI-compatible provider in Settings.

**Development**

Requires Node.js ≥ 24 and npm.

```sh
npm install
npm run icons   # regenerate icons from assets/icon-src/appstore-512.jpg
npm start       # build + run from source
npm run smoke   # headless end-to-end check (server, boot manifest, UI paint)
```

**Packaging**

```sh
npm run dist:win     # NSIS installer + portable exe
npm run dist:linux   # AppImage
npm run dist:mac     # DMG + zip
```

Output lands in `release/`.

## 中文

DeepSeek Harness 的原生桌面端，基于 Electron 构建。

**工作原理** — 本应用不重写任何官方逻辑：它启动 npm 上发布的官方 [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh) CLI（`web --port 0`），等待其就绪输出行，再把本地 URL 加载进 Electron 窗口。Electron 二进制同时充当 Node.js 运行时（`ELECTRON_RUN_AS_NODE`），因此打包后的应用不依赖系统 Node.js。

**特性**

- 原生窗口，图标为 DeepSeek 官方鲸鱼标志（任务栏、窗口、安装包）
- 与 `dsh web` 完全相同的 Web GUI —— 所有功能、插件与会话行为一致
- 单实例锁：重复启动会聚焦已有窗口
- 记住窗口大小与位置
- 外部链接在系统浏览器打开，不会劫持应用窗口
- 本地服务启动期间显示加载页；服务意外退出时提供重启对话框
- 退出应用即停止本地服务（会话按事件持久化，不丢失）
- 标准应用菜单（编辑/视图/窗口角色、项目链接、关于）

**使用**

1. 从 [Releases](../../releases) 下载安装包（或按下方说明自行构建）。
2. 首次启动时按网页版相同的引导流程，在设置中添加 DeepSeek API Key 或其他 OpenAI 兼容服务商。

**开发**

需要 Node.js ≥ 24 与 npm。

```sh
npm install
npm run icons   # 从 assets/icon-src/appstore-512.jpg 重新生成图标
npm start       # 构建并从源码运行
npm run smoke   # 无头端到端检查（服务、启动清单、UI 渲染）
```

**打包**

```sh
npm run dist:win     # NSIS 安装包 + 便携版 exe
npm run dist:linux   # AppImage
npm run dist:mac     # DMG + zip
```

产物输出到 `release/` 目录。

## Known limitations / 已知限制

- Quitting stops the local server with a forced kill (Windows has no catchable SIGTERM for a child process). The harness writes sessions per event, so this is safe in practice. / 退出时以强杀方式停止本地服务（Windows 无法向子进程投递可捕获的 SIGTERM）。Harness 按事件写入会话，实际使用中安全。
- macOS and Linux builds are untested by the maintainer; Windows is the primary platform. / macOS 与 Linux 构建未经维护者实测，Windows 为主要平台。
- No auto-update yet. / 暂无自动更新。

## Roadmap / 路线图

- [ ] Tray icon with quick actions / 托盘图标与快捷操作
- [ ] Auto-update (electron-updater) / 自动更新
- [ ] macOS/Linux verification pass / macOS/Linux 验证

## License / 开源协议

[MIT](LICENSE) © 2026 Jin-wen-jie and contributors.

The whale logo is a trademark of DeepSeek; this is an unofficial community project, not affiliated with or endorsed by DeepSeek. DeepSeek Harness itself is MIT-licensed by DeepSeek AI.
鲸鱼标志是 DeepSeek 的商标；本项目为非官方社区项目，与 DeepSeek 无隶属关系，亦未获其背书。DeepSeek Harness 本身由 DeepSeek AI 以 MIT 协议开源。

## Thanks / 致谢

- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — the harness this app wraps
