# Agent Note: 桌面真实应用接入（阶段 3）

Status: implemented

[English](2026-08-18-desktop-real-app.md) | 中文

## Problem

阶段 2 交付了传输层，但桌面窗口仍然只显示协议探针——用户还是"进不去"。阶段 3 必须在受监管的 Host 里引导真实 Harness，并在沙箱渲染器中挂载真实 Harness 客户端 UI，走 IPC 传输，没有 HTTP 服务，也没有 `file://` 模块脆弱性。

## Decision

**Host**（`apps/desktop/src/host/bin.ts`）通过 `@deepseek-ai/dsh-app-boot` 的 `boot()` 在 Electron-as-node 下引导真实 `desktop` Cordis profile（dsh-base + dsh-desktop-app）：`healProfilesModuleFallback` + `loadProfile('desktop')` + 空根 `cordis.yml` + `provideCmdline([])`。bridge 把行协议适配到 `ctx.desktopRuntime`（组合后的 `toFetchHandler` + mux/host 流）。桌面 bundle 省略 `modules` 行（`ClientModuleRegistry` 需要 `webServer`），使用 `directory-picker-native` 而非 `-auto`，并且只从 renderer roster 挂载 `dsh-client-ui-settings-general` 的 Host 半边，使 `ui-onboarding` 完成注册，同时避免重复基础服务或等待仅浏览器存在的服务。

**Renderer** 通过既有 `AppWebEntry` 壳挂载真实 UI，用三个接缝：
- 给 `@deepseek-ai/dsh-client-web` 的 `BootSeams`/`AppWebEntry` 增加 `statics` 选项，让桌面 boot 把 transport 注入的 `createDesktopConnection(transport)` 注册在 `@deepseek-ai/dsh-client-connection` 名下（运行时的 `inject: ['connection']` 边就能解析，且不拉 bundle）；
- 构建期生成的 `window.__DSH_BOOT__` roster（`scripts/gen-renderer-roster.mjs`），其中包含与桌面组合兼容的 web 平台客户端；直接导入的桌面 carrier 与浏览式目录选择器被排除，原生选择器则与 Host 后端一致；
- Main 里只读特权 `app://` 协议（`protocol.handle`）服务页面、esbuild renderer bundle、产出的 CSS／字体资产和插件 bundle（路径来自构建期生成的 `bundle-locations.json`——pnpm 不会把 38 个 roster 包链接进 apps/desktop，Main 无法 `require.resolve` 它们）。

渲染器是单个 esbuild bundle（`scripts/build-renderer.mjs`），因为插件 bundle 通过客户端模块表 `require` 它们的 seed 词（react、cordis、web-react……），必须指向同一实例。web 构建掩盖的浏览器缺口被显式补齐：最小 `process` shim（`versions.node: '0.0.0'`，让 vendored loader 的 node 内部检测像 web 构建的 `"0.0.0"` define 一样短路）、esbuild node 内建 stub、以及 `CSP script-src 'unsafe-eval'`（web 应用根本不带 CSP）。

## Alternatives considered

**通过 `app://` 服务 `apps/web` 的 vite dist。** web dist 用绝对资源路径，而且仍需要同样的 roster/statics/loadBundle 接缝；把壳在单个桌面 bundle 里重建更简单、origin 也更干净。

**扩展 `BootSeams` 还是 fork `boot.tsx`。** 一个小的可选 `statics` 字段是干净的上游接缝；把约 240 行的内核 fork 进 apps/desktop 会重复壳代码。

**从 Main `require.resolve` 插件 bundle。** pnpm 严格 node_modules 不会把 roster 包放进 apps/desktop；构建期生成的路径映射确定且可被构建期校验。

**在 Host 中挂载 renderer roster 的每个包。** 基础层已经拥有 Typert 和 Typert 网关，部分客户端配置项还会等待仅浏览器存在的服务。照搬 roster 会重复注册服务或使 Host 无法就绪；Host 只挂载其实际消费的注册项。

**同时加载两种目录选择器客户端。** 浏览式和原生客户端占用相同的两个 `single` slot。桌面组合在两侧都选择原生实现，而不是给相互竞争的实现分配任意优先级。

## Consequences

桌面应用引导真实 Harness Host，并在 `sandbox:true`／`webSecurity:true`、由 `app://` 服务的 renderer 中渲染真实客户端 UI。欢迎确认通过 `ui-onboarding` 上的 `settings.mutate` 完成持久化，全新 Electron 启动会进入任务主视图，且不再出现保存确认错误或目录流程重复注册。验证覆盖 17 项桌面测试、4 项 carrier 测试、已构建 Electron 的截图与 renderer 诊断，以及保持 10／27 不变且不含桌面错误的 Host／Client aggregate 类型检查基线。

边界：通用 `ctx.connection.rpc` 通道（cordis-client-runner／ui-cordis 的 inspect 清单）被 stub 成内部错误；仍需 Host 侧 RPC 分发。`unsafe-eval` CSP 是打包期决策，重连视觉细节仍未收尾。
