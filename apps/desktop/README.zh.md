# @deepseek-ai/dsh-desktop

[English](README.md) | 中文

这是 Deepseek Harness 的 Electron 桌面入口。Electron Main 管理窗口和受监管的 Host 子进程，Preload 暴露固定的 renderer API（`invoke`／`respond`／`cancel`／`subscribe`／`onConnectionLost`／`getState`），renderer 通过 IPC 挂载 Harness 客户端 UI，不启动 HTTP 服务。

## 架构

- **Host**（`src/host/bin.ts`）通过 `@deepseek-ai/dsh-app-boot` 在 Electron-as-node 下引导 `desktop` Cordis profile（`dsh-base` + `dsh-desktop-app`），再由 `src/host/desktop-bridge.ts` 把带版本号的 stdio 行协议（`src/shared/protocol.ts`）适配到 `ctx.desktopRuntime`。桌面组合包挂载 `dsh-client-ui-settings-general` 的 Host 半边，注册欢迎确认使用的持久化 `ui-onboarding` 命名空间。`AppMain` 与 `HostSupervisor` 负责 spawn、就绪、取消和有界关闭。
- **Renderer**（`src/renderer/desktop-boot.ts`）从 `scripts/gen-renderer-roster.mjs` 构建生成的 roster 设置 `window.__DSH_BOOT__`，把 `createDesktopConnection(transport)` 作为 `@deepseek-ai/dsh-client-connection` 的 shell static 注入，再运行 `AppWebEntry`。roster 发现 web 平台客户端包，但排除直接导入的桌面 carrier 和浏览式目录选择器；桌面组合使用原生选择器，同时加载两种选择器客户端会重复注册同一组 `single` slot。Main 通过只读特权 `app://` 协议服务页面和插件 bundle，renderer 保持 `sandbox` 与 `webSecurity` 启用。
- **Renderer 构建**（`scripts/build-renderer.mjs`）把 shell 内核、seed 模块和 carrier 源码打进单个 ESM `lib/renderer/bundle.js`；插件 bundle 由 `lib/renderer/bundle-locations.json` 记录的已构建 `lib/client.js` 路径提供。renderer 的最小 `process` shim 把 `versions.node` 固定为 `0.0.0`，node 内建 esbuild stub 阻止 vendored loader 进入 Node 内部路径。

Preload 源文件是 `src/preload/index.cts`，编译为 `lib/preload/index.cjs`。Electron 沙箱 renderer 要求 CommonJS preload；改为 ESM 会导致 `window.dshDesktop` 不可用。

## 构建与运行

```sh
pnpm run build:lib
pnpm --filter @deepseek-ai/dsh-desktop run build
pnpm --filter @deepseek-ai/dsh-desktop run start
pnpm --filter @deepseek-ai/dsh-desktop run test
```

干净检出中必须先运行 `build:lib`：桌面 renderer roster 和插件位置依赖工作区包生成的 Host remote、客户端 bundle 与主题样式。

`apps/desktop/scripts/create-desktop-shortcut.ps1` 创建的桌面快捷方式指向已构建的 Electron shell。Host 会在 `$DSH_HOME/profiles/desktop` 下自动初始化 `desktop` profile；模型提供方和持久化设置使用常规 `$DSH_HOME` 配置。

## 已知限制与延期工作

- `cordis-client-runner` 与 `ui-cordis` 使用的通用 `ctx.connection.rpc` 通道会返回内部错误；Cordis 清单面板需要 Host 侧 RPC 分发。
- `CSP script-src` 为受信任的本地 bundle 包含 `'unsafe-eval'`，打包前必须复核。
- Host 崩溃与重连在传输层可用，但视觉处理仍较简略。
- 桌面应用尚无安装器、签名、自动更新或正式图标资源。
