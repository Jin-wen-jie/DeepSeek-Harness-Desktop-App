# Agent Note: 桌面传输层与桌面 profile

[English](2026-08-18-desktop-transport-and-profile.md) | 中文

Status: implemented

## Problem

阶段 1 交付了基于生命周期夹具 Host 的 Electron 进程边界。阶段 2 必须用真实的 Host API bridge 替换该夹具，补齐夹具协议缺失的可应答帧路径，并端到端证明客户端传输约定——现有 `ctx.connection` 消费者不能感知 Electron。

## Decision

`apps/desktop/src/host/desktop-bridge.ts` 把带版本号的换行分隔 stdio 协议适配到现有 fetch 形状的 Host API 和两条事件流上，复用 `toFetchHandler(api).fetch` 作为唯一权威分发点。bridge 只负责每次 invoke 的 `AbortController` 取消、单调递增的事件 `sequence` 编号、可应答帧的 `respond` 路径、版本不匹配检测和有界关闭。夹具方法已删除；`bin.ts` 现在在 stub ApiProxy 之上启动 bridge（由 Cordis 引导的 `ctx.apiProxy` 是阶段 3 的替换对象）。

协议增加了三样东西：`respond` 请求类型（按 rpcId 应答 Host 发出的 `approval/requested` / `question/requested` 帧）、每条 `event` 消息上的 `rpcId`（可应答帧所需的关联字段，也是基类 `RpcRequest` 类型要求的字段），以及明确的 `version-mismatch` fatal code。

`packages/client/connection-desktop` 是客户端载体：`IpcApiClient` 继承 `AbstractApiClient`，通过只重写传输方面（`doFetch`）把 unary 和 `/api/respond` 路由到注入的 `DesktopIpcTransport`，并重写 `openMux`/`openHost` 直接消费 IPC 事件帧（通过 `onClose` 信号表示流丢失）。复用基类协议路径保留了 rpcId 回显校验和二层 value schema 解析。现有 `ConnectionController`（现在从 `@deepseek-ai/dsh-client-connection/client` 导出）被原样复用，因此 generation/重连/退避语义与 Web 载体完全一致。`createDesktopConnection(transport)` 提供 `ctx.connection`；由于 transport 来自渲染器的 preload bridge，而非这个浏览器安全的包，所以采用工厂形式。

`packages/bundle/desktop-app` 是桌面 Host 组合：它叠在 `dsh-base` 之上，挂载 Host API gateway（`@deepseek-ai/dsh-host-apiproxy`）、它所依赖的 Host 行，以及从 `ctx.apiProxy` 物化 bridge 的 fetch handler 和事件流的 `desktop-runtime` 胶水。它刻意不挂载 Web server 或静态前端。`desktop` 已在 `PROFILE_TEMPLATES` 注册为 `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-desktop-app']`。

## Alternatives considered

**保留夹具并增加应答方法。** 在桌面协议上增加业务专用 RPC 方法会分裂权威分发；bridge 复用 `toFetchHandler`，保持路由、schema 校验和业务错误语义只有一处实现。

**在 IPC 上重放 SSE 字节流。** 载体可以端到端骑行 fetch 形状的传输，但 IPC 已经交付结构化帧；把它们序列化成 SSE 字节再解析回来是浪费。载体复用基类 unary 协议路径，只有流打开器是 IPC 原生。

**把载体放进 `apps/desktop`。** 渲染器载体是浏览器代码；把它编译进 Host face 会把 cordis Context 两侧合并进同一个程序。单独的 Client-face 包（`packages/client/connection-desktop`）保持 face 分离，也把 Electron 排除在普通 Web bundle 之外。

## Consequences

桌面传输现在是真实的：supervisor 测试通过真实 bridge 驱动 ready、unary `RpcResult`、事件订阅、取消、respond 和关闭；carrier 测试通过复用的 `ConnectionController` 驱动握手和重连。客户端上层保持消费 `ctx.connection` 不变。

边界：`bin.ts` 仍然引导 stub ApiProxy，而不是 Cordis 组合；浏览器 roster 的 `connection-desktop` 行是 transport 注入的，因此由阶段 3 的渲染器引导挂载，而不是静态 `dsh.client` 行。阶段 3 在 Electron-as-node 上引导 `desktop` profile，增加渲染器引导，并落地完整 UI。
