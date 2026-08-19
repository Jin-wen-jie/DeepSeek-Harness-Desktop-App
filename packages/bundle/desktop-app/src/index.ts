/**
 * @deepseek-ai/dsh-desktop-app — the desktop host bundle's runtime glue plugin
 * plus the bundle patch (`cordis.patch.yml`, declared by the `dsh.bundle.patch`
 * manifest field). The plugin owns the Host-side glue: it resolves the
 * fetch-shaped handler and the mux/host event streams off the composed
 * `apiProxy` and provides them as `desktopRuntime`, the surface the desktop
 * Host process entry (`apps/desktop/src/host/bin.ts`) adapts onto the stdio
 * line protocol. No web server, no frontend-static, no TLS: the desktop makes
 * the same ApiProxy reachable to its own process without a TCP listener.
 * @module @deepseek-ai/dsh-desktop-app
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { RpcId, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import type { HostFrame, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy'

/** Stable Cordis plugin name. */
export const name = 'desktop-app'

/** Services required before the desktop runtime can mount. */
export const inject = ['apiProxy']

/** The Host-side surfaces the desktop bridge adapts: one fetch handler + two event streams. */
export interface DesktopRuntimeValues {
  fetch: typeof fetch
  events: {
    mux(signal: AbortSignal): AsyncIterable<RpcRequest<MuxFrame>>
    host(signal: AbortSignal): AsyncIterable<RpcRequest<HostFrame>>
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { desktopRuntime: DesktopRuntimeValues }
}

/**
 * Resolve the desktop bridge's Host surfaces off the composed apiProxy. The
 * Host process entry consumes `ctx.desktopRuntime` and adapts it to the
 * versioned stdio line protocol; the desktop bridge never opens an HTTP server
 * and reuses the single authoritative `toFetchHandler` dispatch.
 * @param ctx - plugin context carrying the composed apiProxy service.
 */
export function apply(ctx: Context): void {
  ctx.provide('desktopRuntime', {
    fetch: toFetchHandler(ctx.apiProxy).fetch,
    events: {
      mux: signal => ctx.apiProxy.events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, signal),
      host: signal => ctx.apiProxy.events.host({ rpcId: RpcId(randomUUID()), payload: {} }, signal),
    },
  })
}
