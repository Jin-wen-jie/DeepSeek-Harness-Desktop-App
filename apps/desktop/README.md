# @deepseek-ai/dsh-desktop

English | [中文](README.zh.md)

The Electron desktop entry for Deepseek Harness. Electron Main owns the window and a supervised Host child process, Preload exposes a fixed renderer API (`invoke`/`respond`/`cancel`/`subscribe`/`onConnectionLost`/`getState`), and the renderer mounts the Harness client UI over IPC without an HTTP server.

## Architecture

- **Host** (`src/host/bin.ts`) boots the `desktop` Cordis profile (`dsh-base` + `dsh-desktop-app`) under Electron-as-node through `@deepseek-ai/dsh-app-boot`, then adapts the versioned stdio line protocol (`src/shared/protocol.ts`) to `ctx.desktopRuntime` through `src/host/desktop-bridge.ts`. The desktop bundle mounts the Host half of `dsh-client-ui-settings-general`, which registers the durable `ui-onboarding` namespace used by the welcome acknowledgement. `AppMain` and `HostSupervisor` own spawning, readiness, cancellation, and bounded shutdown.
- **Renderer** (`src/renderer/desktop-boot.ts`) sets `window.__DSH_BOOT__` from the build-generated roster in `scripts/gen-renderer-roster.mjs`, injects `createDesktopConnection(transport)` as the `@deepseek-ai/dsh-client-connection` shell static, and runs `AppWebEntry`. The roster discovers web-platform client packages but excludes the directly imported desktop carrier and the browse directory picker; the desktop composition uses the native picker, and loading both picker clients would register the same single slots. Main serves the page and plugin bundles through a read-only privileged `app://` protocol under `sandbox` and `webSecurity`.
- **Renderer build** (`scripts/build-renderer.mjs`) bundles the shell kernel, its seed modules, and the carrier source into one ESM `lib/renderer/bundle.js`; plugin bundles are served from their built `lib/client.js` paths recorded in `lib/renderer/bundle-locations.json`. The renderer's minimal `process` shim pins `versions.node` to `0.0.0`, and the node-builtin esbuild stub keeps the vendored loader's Node-internal path from evaluating.

The preload is `src/preload/index.cts`, compiled to `lib/preload/index.cjs`. A sandboxed Electron renderer requires a CommonJS preload; changing it to ESM leaves `window.dshDesktop` unavailable.

## Build and run

```sh
pnpm run build:lib
pnpm --filter @deepseek-ai/dsh-desktop run build
pnpm --filter @deepseek-ai/dsh-desktop run start
pnpm --filter @deepseek-ai/dsh-desktop run test
```

Run `build:lib` first in a clean checkout: the desktop renderer roster and plugin locations consume the workspace packages' generated Host remotes, client bundles, and theme styles.

The desktop shortcut created by `apps/desktop/scripts/create-desktop-shortcut.ps1` points at the built Electron shell. The Host auto-initializes the `desktop` profile under `$DSH_HOME/profiles/desktop`; model providers and persisted settings use the normal `$DSH_HOME` configuration.

## Known Limitations and Deferred Work

- The generic `ctx.connection.rpc` channel used by `cordis-client-runner` and `ui-cordis` returns an internal error; Host-side RPC dispatch is required for the Cordis inventory panel.
- `CSP script-src` includes `'unsafe-eval'` for trusted local bundles and must be reviewed before packaging.
- Host crash and reconnect behavior works at the transport level, but its visual treatment remains minimal.
- The desktop app has no installer, signing, automatic updates, or production icon resources.
