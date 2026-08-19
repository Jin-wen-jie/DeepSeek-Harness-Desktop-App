# `@deepseek-ai/dsh-client-connection-desktop`

[English](README.md) | 中文

这是 [`dsh-client-connection`](../connection/README.md) 的浏览器安全桌面载体。[`createDesktopConnection`](src/client/index.ts) 将注入的 preload 支持 IPC transport 绑定到现有 `ConnectionController`，并提供与 Web 载体相同的 `ctx.connection` 形状。[`IpcApiClient`](src/client/ipc-api-client.ts) 让 unary 请求继续走共享的 `AbstractApiClient` 协议路径，并以结构化 IPC 帧消费 mux 与 Host 事件流，因此 renderer 无需导入 Node 或 Electron。

该包由 [`dsh-desktop` renderer boot](../../../apps/desktop/README.md) 直接导入，而不是作为 `dsh.client` roster 插件发现，因为它的 transport 实例在运行时来自沙箱化的 preload bridge。根源码入口用于全仓包分类；公开运行时入口仍是客户端载体。

## 模型体验

无，因为这个浏览器侧 IPC 载体不注册任何面向模型的内容。

#### KV Cache 影响

无；该载体只传输已经组装好的 API 和事件载荷。

## 已知限制与延期工作

- **通用逻辑 RPC 尚未接通**：在桌面 Host bridge 获得共享 Typert RPC 分发路径前，`ctx.connection.rpc` 会返回明确的内部错误。
- **transport 由桌面 boot 持有**：该载体不能作为普通静态 client-roster 行激活，因为只有 preload bridge 能提供它的 IPC transport。
