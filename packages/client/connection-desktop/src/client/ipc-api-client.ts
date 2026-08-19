/**
 * Desktop IPC carrier. Routes the payload-direct `IApiClient` surface over the
 * Electron preload bridge (`window.dshDesktop`) instead of HTTP/WebSocket. The
 * upper runtime and every UI layer keep consuming `ctx.connection` — they never
 * learn about Electron. The carrier is browser-safe: it holds no Node/Electron
 * imports, only the injected `DesktopIpcTransport` (the preload satisfies it).
 *
 * Unary calls and `/api/respond` reuse the base `AbstractApiClient` protocol
 * path verbatim (rpcId minting, envelope parse, rpcId echo check, second-level
 * value schema parse, timeout merge) by routing only the transport aspect
 * (`doFetch`) through IPC. Event streams override `openMux`/`openHost` because
 * IPC delivers structured frames directly — SSE byte framing would be wasted
 * round-tripping. The desktop `result` field carries the `RpcResult` verbatim;
 * transport/protocol failures surface as thrown rejections (folded by callers
 * via `transportError`), mirroring the HTTP carrier's status-vs-body split.
 */

// The connection package's `./client` export is a CJS plugin bundle (registered
// via __ModuleLoader__), not a library API; the carrier takes its runtime
// values from the browser-safe apiproxy `./client` leaf (the host root would
// drag the Host implementation graph in). Types below are import-type (erased).
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.ts'
import type {
  ApiProxy,
  HostFrame,
  IApiClient,
  MuxFrame,
  RpcRequest,
} from '@deepseek-ai/dsh-client-connection/client'

/** The two logical event streams the desktop protocol multiplexes. */
export type DesktopStream = 'mux' | 'host'

/** Per-stream sink the transport pushes frames into and signals loss through. */
export interface DesktopStreamSinks {
  onEvent(event: { rpcId: string; frame: unknown }): void
  /** Signal that the stream's underlying transport was lost; the carrier ends the iterable so the controller reconnects. */
  onClose(): void
}

/**
 * Transport the carrier rides. Implemented by the desktop renderer from
 * `window.dshDesktop` (preload); the carrier never references the global itself,
 * keeping Electron out of this browser-safe package.
 */
export interface DesktopIpcTransport {
  /** Invoke one unary method; resolves with the business `RpcResult` (value | error). */
  invoke(rpcId: string, method: string, payload: unknown, signal: AbortSignal | undefined): Promise<unknown>
  /** Answer a host-originated server-request; resolves with the `RpcReceipt`. */
  respond(rpcId: string, result: unknown, signal: AbortSignal | undefined): Promise<unknown>
  /** Subscribe one stream; returns an unsubscribe. The transport owns loss detection (`onClose`). */
  subscribe(stream: DesktopStream, sinks: DesktopStreamSinks): () => void
}

/** Mirror fetch's abort rejection so the base timeout/cancel merge behaves identically. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  if (typeof reason === 'string') return new Error(reason)
  return new Error('This operation was aborted')
}

/** Fake authority the base `resolveBase` produces in non-browser contexts; matched here for symmetry. */
const INTERNAL_BASE = 'http://dsh.internal'

/**
 * IPC-backed `IApiClient`. Extends `AbstractApiClient` so every protocol
 * invariant stays in the base; only the transport aspect and the stream
 * openers are desktop-specific.
 */
export class IpcApiClient extends AbstractApiClient implements IApiClient {
  constructor(private readonly transport: DesktopIpcTransport, timeoutMs?: number) {
    super(timeoutMs)
  }

  /** Transport aspect for POST routes (unary + respond). GET stream routes are unreachable (openMux/openHost are overridden). */
  protected async doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const signal = init?.signal ?? undefined
    const routed = this.route(input, init)
    if (signal === undefined) return routed
    if (signal.aborted) return Promise.reject(abortError(signal))
    return new Promise<Response>((resolve, reject) => {
      const onAbort = (): void => { reject(abortError(signal)) }
      signal.addEventListener('abort', onAbort, { once: true })
      routed.then(resolve, reject).finally(() => { signal.removeEventListener('abort', onAbort) })
    })
  }

  private async route(input: URL, init?: RequestInit): Promise<Response> {
    const path = input.pathname
    if (init?.method !== 'POST' || !path.startsWith('/api/')) {
      return new Response('not found', { status: 404 })
    }
    const rawBody = init.body
    const body = typeof rawBody === 'string'
      ? JSON.parse(rawBody) as { rpcId?: unknown; payload?: unknown; result?: unknown }
      : { rpcId: undefined, payload: undefined, result: undefined }
    const signal = init.signal ?? undefined
    const rpcId = typeof body.rpcId === 'string' ? body.rpcId : ''
    if (path === '/api/respond') {
      const receipt = await this.transport.respond(rpcId, body.result, signal)
      return Response.json(receipt)
    }
    const method = path.slice('/api/'.length)
    const result = await this.transport.invoke(rpcId, method, body.payload, signal)
    return Response.json({ type: 'server-response', rpcId: body.rpcId, result })
  }

  protected override openMux(_payload: Parameters<ApiProxy['events']['mux']>[0]['payload'], signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.openStream<MuxFrame>('mux', signal, onOpen)
  }

  protected override openHost(_payload: Parameters<ApiProxy['events']['host']>[0]['payload'], signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<HostFrame>> {
    return this.openStream<HostFrame>('host', signal, onOpen)
  }

  private async *openStream<F extends MuxFrame | HostFrame>(
    stream: DesktopStream,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const queue: RpcRequest<F>[] = []
    let resolveNext: (() => void) | undefined
    let closed = false
    const wake = (): void => { const resolve = resolveNext; resolveNext = undefined; resolve?.() }
    const unsubscribe = this.transport.subscribe(stream, {
      onEvent: ({ rpcId, frame }) => {
        queue.push({ rpcId: RpcId(rpcId), payload: frame as F })
        wake()
      },
      onClose: () => { closed = true; wake() },
    })
    const onAbort = (): void => { closed = true; wake() }
    signal.addEventListener('abort', onAbort, { once: true })
    onOpen?.()
    try {
      while (!closed) {
        const next = queue.shift()
        if (next !== undefined) {
          yield next
        } else {
          await new Promise<void>((resolve) => { resolveNext = resolve })
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      unsubscribe()
    }
  }

  // `respond` inherits the base implementation: it POSTs /api/respond through
  // doFetch, which routes to transport.respond. No override needed.

  // Resolve against the internal base so the URL pathname carries the method;
  // the desktop transport never opens a real connection to this authority.
  protected override resolveBase(): string {
    return INTERNAL_BASE
  }
}
