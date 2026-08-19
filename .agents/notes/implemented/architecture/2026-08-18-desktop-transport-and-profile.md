# Agent Note: Desktop transport layer and desktop profile

Status: implemented

English | [中文](2026-08-18-desktop-transport-and-profile.zh.md)

## Problem

Phase 1 delivered the Electron process boundary with a lifecycle-fixture Host. Phase 2 must replace that fixture with the real Host API bridge, add the answerable-frame path the fixture protocol lacked, and prove the client transport contract end-to-end — the existing `ctx.connection` consumers must not learn about Electron.

## Decision

`apps/desktop/src/host/desktop-bridge.ts` adapts the versioned stdio line protocol to the existing fetch-shaped Host API and the two event streams, reusing `toFetchHandler(api).fetch` as the single authoritative dispatch. The bridge owns only per-invoke `AbortController` cancellation, monotonic event `sequence` numbering, the `respond` path for answerable frames, version-mismatch detection, and bounded shutdown. The fixture methods are gone; `bin.ts` now boots the bridge over a stub ApiProxy (a Cordis-booted `ctx.apiProxy` is the Phase 3 replacement).

The protocol grows three things: a `respond` request type (answers host-originated `approval/requested` / `question/requested` frames by rpcId), an `rpcId` on every `event` message (the correlation the answerable frames require and the base `RpcRequest` type needs), and an explicit `version-mismatch` fatal code.

`packages/client/connection-desktop` is the client-side carrier: `IpcApiClient` extends `AbstractApiClient`, routes unary and `/api/respond` through an injected `DesktopIpcTransport` by overriding only the transport aspect (`doFetch`), and overrides `openMux`/`openHost` to consume IPC event frames directly (with an `onClose` signal for stream loss). Reusing the base protocol path preserves rpcId echo checking and the second-level value schema parse. The existing `ConnectionController` (now exported from `@deepseek-ai/dsh-client-connection/client`) is reused unchanged, so generation/reconnect/backoff semantics are identical to the Web carrier. `createDesktopConnection(transport)` provides `ctx.connection`; it is a factory because the transport comes from the renderer's preload bridge, never from this browser-safe package.

`packages/bundle/desktop-app` is the desktop host composition: it overlays `dsh-base`, mounts the Host API gateway (`@deepseek-ai/dsh-host-apiproxy`), the host rows it consumes, and the `desktop-runtime` glue that materializes the bridge's fetch handler and streams off `ctx.apiProxy`. It deliberately mounts no web server and no static frontend. `desktop` is registered in `PROFILE_TEMPLATES` as `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-desktop-app']`.

## Alternatives considered

**Keep the fixture and add answer methods.** Growing business-specific RPC methods on the desktop protocol would fork the authoritative dispatch; the bridge reuses `toFetchHandler`, keeping one implementation of routing, schema validation, and business-error semantics.

**Replay the SSE byte stream over IPC.** The carrier could ride a fetch-shaped transport end-to-end, but IPC already delivers structured frames; serializing them to SSE bytes and parsing them back wastes work. The carrier reuses the base unary protocol path and only the stream openers are IPC-native.

**Put the carrier in `apps/desktop`.** The renderer carrier is browser code; compiling it under the Host face would merge both cordis Context sides into one program. A separate Client-face package (`packages/client/connection-desktop`) keeps the face split and keeps Electron out of ordinary Web bundles.

## Consequences

The desktop transport is now real: the supervisor test drives ready, unary `RpcResult`, event subscription, cancellation, respond, and shutdown through the actual bridge, and the carrier test drives the handshake and reconnect through the reused `ConnectionController`. The client upper layers consume `ctx.connection` unchanged.

Boundary: `bin.ts` still boots a stub ApiProxy, not a Cordis composition; the browser roster's `connection-desktop` row is transport-injected and therefore mounted by the Phase 3 renderer boot, not by a static `dsh.client` row. Phase 3 boots the `desktop` profile over Electron-as-node, adds the renderer boot, and lands the full UI.
