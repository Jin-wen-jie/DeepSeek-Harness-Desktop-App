# Agent Note: Electron desktop IPC process boundary

Status: implemented

English | [中文](2026-08-18-electron-desktop-ipc-spike.zh.md)

## Problem

The desktop application needs to isolate the Electron window from the Node-based Harness runtime while keeping the client protocol transport-independent. A renderer must not receive Node.js or arbitrary IPC access, and a Host failure must not terminate the window process.

## Decision

`apps/desktop` contains an Electron Main entry, a sandboxed Preload bridge, a local Renderer entry, and a supervised Host child process. Main loads the Renderer from a local file, starts the Host with a versioned newline-delimited JSON protocol, forwards only event frames to the Renderer, and owns bounded Host shutdown. Preload exposes only `invoke`, `cancel`, `subscribe`, and `getState`; it does not expose `ipcRenderer` or filesystem access.

`HostSupervisor` owns pending request settlement, readiness, event forwarding, cancellation, unexpected-exit failure, message-size limits, and a bounded stop timeout. Host process messages are parsed at the process boundary and reject unknown versions, discriminants, streams, ids, and sequences.

The current Host entry is a lifecycle fixture with `desktop.spike.echo` and `desktop.spike.wait`. It is deliberately not the Harness runtime. The production integration must replace the fixture behind the same process boundary with a Desktop profile and the existing API Proxy contract; the Electron shell and renderer must not grow business-specific RPC methods.

## Alternatives considered

**Run the Harness inside Electron Main.** This couples Agent, PTY, and native-module failures to the window process and prevents independent Host restart.

**Expose Node integration to the Renderer.** This gives UI code unrestricted filesystem and process access, so it violates the desktop security boundary.

**Use a fixed local HTTP server as the desktop carrier.** The repository's GUI layering keeps physical carriers replaceable and reserves Electron for a local file entry plus IPC; a fixed port would also expose an unnecessary local network surface.

## Consequences

The desktop package now has an independently testable process boundary and a real Electron-as-node smoke path. The renderer is still only a protocol probe, and the Host fixture has no Harness capabilities until the next integration phase adds the Desktop profile, API bridge, client carrier, production icon, and installer.
