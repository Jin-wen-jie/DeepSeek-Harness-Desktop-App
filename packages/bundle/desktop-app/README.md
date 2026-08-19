# `@deepseek-ai/dsh-desktop-app`

English | [中文](README.zh.md)

The desktop Host composition bundle. Its [`cordis.patch.yml`](cordis.patch.yml) overlays [`dsh-base`](../base/README.md), mounts the transport-agnostic Host API and its supporting services, selects the native directory picker, and adds this package's [`desktopRuntime`](src/index.ts) glue. That service exposes the composed `apiProxy` fetch handler and mux/Host event streams to the supervised process bridge without opening an HTTP listener or serving browser assets.

The desktop renderer owns its build-generated client roster. The Host composition mounts only the client package half required to register the `ui-onboarding` settings namespace; loading the full browser roster in the Host would leave browser-only injections pending or duplicate shared providers. The [`dsh-desktop` shell](../../../apps/desktop/README.md) injects the preload transport directly and serves the built renderer through its local `app://` protocol.

## Model Experience

Indirectly, through the base coding persona and mounted runtime packages, which own each model-facing registration.

#### KV Cache effect

The desktop bridge glue adds nothing, while mounted packages retain their own cache behavior.

## Known Limitations and Deferred Work

- **Desktop IPC is local-process-only** - `desktopRuntime` assumes a supervised trusted Host process and deliberately provides no network listener or remote authentication.
- **The renderer roster is a build artifact** - adding or removing client packages requires rebuilding the desktop application before the shell can serve the updated bundles.
