/**
 * Desktop connection plugin. Builds `ctx.connection` from an injected
 * `DesktopIpcTransport` so the existing runtime and UI layers consume the same
 * `ConnectionHandle` shape they do over HTTP — only the transport differs. The
 * `ConnectionController` (generation/reconnect/handshake) is reused unchanged;
 * the carrier supplies the IPC streams it pumps.
 */

import type { Context } from '@deepseek-ai/cordis'
// ConnectionController is a runtime value; the connection package's `./client`
// export is a CJS plugin bundle with no named exports, so import it from source.
// (esbuild aliases this specifier to the source file; the rest are erased types.)
import { ConnectionController } from '@deepseek-ai/dsh-client-connection/src/client/connection.ts'
import type {
  ClientConnectionRpc,
  ConnectionConfig,
  ConnectionHandle,
  ConnectionSinks,
  HostDescription,
} from '@deepseek-ai/dsh-client-connection/client'
import { IpcApiClient, type DesktopIpcTransport } from './ipc-api-client.ts'

export { IpcApiClient } from './ipc-api-client.ts'
export type { DesktopIpcTransport, DesktopStream, DesktopStreamSinks } from './ipc-api-client.ts'
export type { ConnectionConfig, ConnectionHandle, ConnectionSinks }

/** Services required (none — the desktop carrier is the wire root, like the web one). */
export const inject: string[] = []

/**
 * Build the desktop connection plugin bound to one transport. A factory (not a
 * static plugin) because the transport is constructed at renderer boot from
 * `window.dshDesktop`; the carrier itself never touches that global.
 * @param transport - preload-backed IPC operations used by the desktop carrier.
 * @returns a Cordis client plugin that provides the shared connection handle.
 */
export function createDesktopConnection(transport: DesktopIpcTransport): {
  inject: string[]
  apply(ctx: Context): void
} {
  return {
    inject,
    apply(ctx: Context): void {
      const api = new IpcApiClient(transport)
      // Generic logical RPC channels (api-remotes/typert) are not yet routed
      // over the desktop transport; Phase 3 adds Host-side rpc dispatch. Until
      // then a call fails as an internal error rather than hanging the caller.
      const rpc: ClientConnectionRpc = {
        call: async () => ({ ok: false, error: { code: 'internal', message: 'desktop rpc channel not yet supported', details: {} } }),
      }
      let started = false
      let description: HostDescription | undefined
      const descriptionListeners = new Set<() => void>()
      const publish = (next: HostDescription | undefined): void => {
        if (Object.is(description, next)) return
        description = next
        for (const listener of [...descriptionListeners]) {
          try {
            listener()
          } catch (error) {
            console.error('[desktop-connection] host-description listener threw:', error)
          }
        }
      }
      const handle: ConnectionHandle = {
        api,
        // A desktop app is always loopback: the host is a supervised local process.
        isLoopback: true,
        hostDescription: {
          getSnapshot: () => description,
          subscribe: (listener) => {
            descriptionListeners.add(listener)
            return () => { descriptionListeners.delete(listener) }
          },
        },
        rpc,
        start(sinks: ConnectionSinks, config?: ConnectionConfig) {
          if (started) throw new Error('connection: the stream loop is already owned by another consumer')
          started = true
          const controller = new ConnectionController(api, {
            ...sinks,
            onConnected: (next) => {
              publish(next)
              // A description subscriber may synchronously stop the loop; in that
              // case publish(undefined) has already retracted this generation.
              if (!Object.is(description, next)) return
              sinks.onConnected?.(next)
            },
            onStateChange: (state) => {
              if (state === 'reconnecting') publish(undefined)
              sinks.onStateChange?.(state)
            },
          }, config ?? {})
          controller.start()
          return {
            stop: () => {
              controller.stop()
              publish(undefined)
            },
          }
        },
      }
      ctx.provide('connection', handle)
    },
  }
}
