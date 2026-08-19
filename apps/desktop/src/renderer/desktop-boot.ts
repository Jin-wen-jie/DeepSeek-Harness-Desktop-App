/**
 * Desktop renderer boot: mounts the real Harness client UI over the Electron
 * IPC transport, exactly like the web entry but with `createDesktopConnection`
 * injected as a shell static in place of the HTTP carrier. `window.__DSH_BOOT__`
 * is the build-generated roster (same `dsh.client platform web` set the web
 * profile mounts); the `@deepseek-ai/dsh-client-connection` row stays in the
 * graph so the runtime's `inject: ['connection']` edges resolve, while its
 * shell static shadows the (never-fetched) bundle.
 */

import { AppWebEntry } from '@deepseek-ai/dsh-client-web'

// Plugin bundles and shell libraries read Node process globals (NODE_ENV,
// versions.node, version, nextTick...); the web build injects them, the
// desktop renderer has no Node — provide a minimal, feature-gate-safe shim.
// `versions.node` must resolve below 22 so the vendored loader's node-internal
// detection (ModuleLoader.fromInternal) short-circuits, exactly like the web
// build's "0.0.0" define, instead of reaching createRequire at construction.
const processShim = {
  env: { NODE_ENV: 'production' },
  version: 'v0.0.0',
  versions: { node: '0.0.0' },
  platform: 'browser',
  browser: true,
  nextTick: (callback: () => void): void => { Promise.resolve().then(callback) },
}
;(globalThis as { process?: unknown }).process ??= new Proxy(processShim as object, {
  get(target, property) {
    return property in target ? (target as Record<string | symbol, unknown>)[property] : undefined
  },
})
import { createDesktopConnection } from '@deepseek-ai/dsh-client-connection-desktop'
import type { DesktopIpcTransport } from '@deepseek-ai/dsh-client-connection-desktop'
import type { DesktopRendererApi } from '../preload/contract.ts'
import roster from './roster.generated.json'

const desktop: DesktopRendererApi = window.dshDesktop

/** Adapt the preload bridge (invoke/respond/cancel/subscribe) to the carrier transport contract. */
function desktopTransport(api: DesktopRendererApi): DesktopIpcTransport {
  return {
    invoke(rpcId, method, payload, signal) {
      const promise = api.invoke(rpcId, method, payload)
      if (signal !== undefined && !signal.aborted) {
        const onAbort = (): void => { api.cancel(rpcId) }
        signal.addEventListener('abort', onAbort, { once: true })
        void promise.catch(() => undefined).finally(() => { signal.removeEventListener('abort', onAbort) })
      }
      return promise
    },
    respond(rpcId, result) {
      return api.respond(rpcId, result)
    },
    subscribe(stream, sinks) {
      const unsubscribe = api.subscribe(stream, (message) => {
        if (message.type === 'event') sinks.onEvent({ rpcId: message.rpcId, frame: message.frame })
      })
      // A supervised Host crash surfaces as a connection-loss signal: end the
      // stream so the reused ConnectionController reconnects on the next boot.
      const stopLoss = api.onConnectionLost(() => { sinks.onClose() })
      return () => { stopLoss(); unsubscribe() }
    },
  }
}

;(globalThis as { __DSH_BOOT__?: unknown }).__DSH_BOOT__ = roster
const root = document.getElementById('root')
if (root === null) throw new Error('desktop renderer: missing #root')

void new AppWebEntry(root, {
  statics: {
    '@deepseek-ai/dsh-client-connection': createDesktopConnection(desktopTransport(desktop)),
  },
}).run()
