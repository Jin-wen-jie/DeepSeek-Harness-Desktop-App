# `@deepseek-ai/dsh-client-connection-desktop`

English | [中文](README.zh.md)

The browser-safe desktop carrier for [`dsh-client-connection`](../connection/README.md). [`createDesktopConnection`](src/client/index.ts) binds an injected preload-backed IPC transport to the existing `ConnectionController` and provides the same `ctx.connection` shape used by the Web carrier. [`IpcApiClient`](src/client/ipc-api-client.ts) keeps unary requests on the shared `AbstractApiClient` protocol path and consumes the mux and Host event streams as structured IPC frames, so the renderer never imports Node or Electron.

The package is imported directly by the [`dsh-desktop` renderer boot](../../../apps/desktop/README.md), rather than discovered as a `dsh.client` roster plugin, because its transport instance comes from the sandboxed preload bridge at runtime. Its root source entry exists for repository-wide package classification; the public runtime entry remains the client carrier.

## Model Experience

None, as this browser-side IPC carrier registers no model-facing content.

#### KV Cache effect

None; the carrier only transports already-composed API and event payloads.

## Known Limitations and Deferred Work

- **Generic logical RPC is not routed yet** - `ctx.connection.rpc` returns an explicit internal error until the desktop Host bridge gains the shared Typert RPC dispatch path.
- **The transport is desktop-boot-owned** - the carrier cannot activate as an ordinary static client-roster row because only the preload bridge can supply its IPC transport.
