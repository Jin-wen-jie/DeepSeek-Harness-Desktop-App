# Agent Note: Desktop real-app integration (Phase 3)

Status: implemented

English | [中文](2026-08-18-desktop-real-app.zh.md)

## Problem

Phase 2 delivered the transport layer but the desktop window still showed only a protocol probe — the user could not "get into" the real application. Phase 3 must boot the real Harness in the supervised Host and mount the actual Harness client UI in the sandboxed renderer, over the IPC transport, with no HTTP server and no `file://` module fragility.

## Decision

**Host** (`apps/desktop/src/host/bin.ts`) boots the real `desktop` Cordis profile (dsh-base + dsh-desktop-app) via `boot()` from `@deepseek-ai/dsh-app-boot` under Electron-as-node: `healProfilesModuleFallback` + `loadProfile('desktop')` + the empty root `cordis.yml` + `provideCmdline([])`. The bridge adapts the line protocol to `ctx.desktopRuntime` (the composed `toFetchHandler` + mux/host streams). The desktop bundle omits the `modules` row (`ClientModuleRegistry` needs `webServer`), uses `directory-picker-native` instead of `-auto`, and mounts only the `dsh-client-ui-settings-general` Host half from the renderer roster so `ui-onboarding` is registered without duplicating base services or waiting for browser-only services.

**Renderer** mounts the real UI through the existing `AppWebEntry` shell with three seams:
- a `statics` option added to `BootSeams`/`AppWebEntry` in `@deepseek-ai/dsh-client-web`, letting the desktop boot register the transport-injected `createDesktopConnection(transport)` under `@deepseek-ai/dsh-client-connection` (the runtime's `inject: ['connection']` edges then resolve without fetching a bundle);
- a build-generated `window.__DSH_BOOT__` roster (`scripts/gen-renderer-roster.mjs`) containing the web-platform clients compatible with the desktop composition; the directly imported desktop carrier and the browse directory picker are excluded, while the native picker matches the Host backend;
- a read-only privileged `app://` protocol in Main (`protocol.handle`) serving the page, the esbuild renderer bundle, the emitted CSS/font assets, and plugin bundles (paths from a build-generated `bundle-locations.json` — pnpm does not link the 38 roster packages into apps/desktop, so Main cannot `require.resolve` them).

The renderer is one esbuild bundle (`scripts/build-renderer.mjs`) because plugin bundles `require` their seed words (react, cordis, web-react, ...) through the client module table, which must point at the same instances. Browser gaps the web build hides were made explicit: a minimal `process` shim (`versions.node: '0.0.0'` so the vendored loader's node-internal detection short-circuits like the web build's `"0.0.0"` define), an esbuild node-builtin stub, and `CSP script-src 'unsafe-eval'` (the web app ships with no CSP at all).

## Alternatives considered

**Serve the `apps/web` vite dist over `app://`.** The web dist uses absolute asset URLs and still needs the same roster/statics/loadBundle seams; rebuilding the shell in one desktop bundle is simpler and origin-clean.

**Extend `BootSeams` vs forking `boot.tsx`.** A small optional `statics` field is a clean upstream seam; forking the ~240-line kernel into apps/desktop would duplicate shell code.

**`require.resolve` plugin bundles from Main.** pnpm's strict node_modules omits roster packages from apps/desktop; a build-generated path map is deterministic and build-time-checked.

**Mount every renderer roster package in the Host.** Base already owns Typert and the Typert gateway, while several client entries wait for browser-only services. Mirroring the roster duplicates services or prevents Host readiness; the Host mounts only registrations it consumes.

**Load both directory-picker clients.** The browse and native clients occupy the same two single slots. The desktop composition selects native on both sides instead of assigning arbitrary priorities to competing implementations.

## Consequences

The desktop app boots the real Harness Host and renders the real client UI in a `sandbox:true`/`webSecurity:true` renderer served over `app://`. The welcome acknowledgement persists through `settings.mutate` on `ui-onboarding`, and a fresh Electron launch reaches the main task view without the save-confirmation error or duplicate directory-flow registrations. Verification covers 17 desktop tests, 4 carrier tests, a built Electron screenshot and renderer diagnostic, and unchanged Host/Client aggregate typecheck baselines of 10/27 with no desktop errors.

Boundary: the generic `ctx.connection.rpc` channel (cordis-client-runner / ui-cordis inspect inventory) is stubbed to an internal error; Host-side RPC dispatch remains required. The `unsafe-eval` CSP is a packaging-time decision, and reconnect cosmetics remain open.
