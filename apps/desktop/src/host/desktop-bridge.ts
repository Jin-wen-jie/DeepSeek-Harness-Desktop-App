/**
 * Host-side desktop bridge: maps the versioned newline-delimited desktop protocol
 * onto the existing fetch-shaped Host API and event streams — the single
 * authoritative dispatch (`toFetchHandler(api).fetch`) is reused verbatim, so
 * method routing, two-level schema validation, and business-error semantics stay
 * in one place. The bridge owns only per-request cancellation, event sequence
 * numbering, and the readiness/shutdown handshake.
 */

import type { HostFrame, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import {
  DESKTOP_PROTOCOL_VERSION,
  DESKTOP_PROTOCOL_VERSION_MISMATCH_CODE,
  type DesktopHostMessage,
  type DesktopHostRequest,
  type DesktopStream,
  validateDesktopHostRequest,
} from '../shared/protocol.ts'

/** Transport the bridge writes framed messages to (stdout in production, a sink in tests). */
export interface DesktopBridgeTransport {
  send(message: DesktopHostMessage): void
}

/**
 * Host-side dependencies the bridge adapts onto the stdio line protocol.
 * `fetch` is `toFetchHandler(api).fetch` — the single authoritative dispatch for
 * unary methods and `/api/respond`. `events` opens the two logical streams
 * directly off `api.events` (no SSE/HTTP layer is needed over IPC).
 */
export interface DesktopBridgeDeps {
  fetch: typeof fetch
  events: {
    mux(signal: AbortSignal): AsyncIterable<RpcRequest<MuxFrame>>
    host(signal: AbortSignal): AsyncIterable<RpcRequest<HostFrame>>
  }
}

/** Fake authority the fetch handler resolves against (matches the client carrier's internal base). */
const INTERNAL_BASE = 'http://dsh.internal'

/** Maps the versioned newline-delimited desktop protocol onto the existing fetch-shaped Host API. */
export class DesktopBridge {
  private readonly pending = new Map<string, AbortController>()
  private readonly streams = new Map<DesktopStream, AbortController>()
  private sequence = 0
  private stopped = false

  constructor(
    private readonly deps: DesktopBridgeDeps,
    private readonly transport: DesktopBridgeTransport,
    private readonly capabilities: readonly string[] = [],
  ) {}

  /** Emit the readiness handshake. */
  start(): void {
    this.send({ version: DESKTOP_PROTOCOL_VERSION, type: 'ready', capabilities: this.capabilities })
  }

  /** Parse and dispatch one untrusted line from Main. */
  handleLine(line: string): void {
    if (this.stopped || line.trim() === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      this.send({ version: DESKTOP_PROTOCOL_VERSION, type: 'fatal', message: `desktop protocol JSON parse failed: ${String(error)}` })
      return
    }
    if (typeof parsed === 'object' && parsed !== null && (parsed as { version?: unknown }).version !== DESKTOP_PROTOCOL_VERSION) {
      this.send({ version: DESKTOP_PROTOCOL_VERSION, type: 'fatal', code: DESKTOP_PROTOCOL_VERSION_MISMATCH_CODE, message: 'desktop protocol version mismatch' })
      return
    }
    let request: DesktopHostRequest
    try {
      request = validateDesktopHostRequest(parsed)
    } catch (error) {
      this.send({ version: DESKTOP_PROTOCOL_VERSION, type: 'fatal', message: error instanceof Error ? error.message : String(error) })
      return
    }
    void this.handle(request)
  }

  /** Stop all streams and pending work, then emit the stopped handshake. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    for (const ac of this.streams.values()) ac.abort()
    for (const ac of this.pending.values()) ac.abort()
    this.streams.clear()
    this.pending.clear()
    this.send({ version: DESKTOP_PROTOCOL_VERSION, type: 'stopped' })
  }

  private async handle(request: DesktopHostRequest): Promise<void> {
    switch (request.type) {
      case 'invoke':
        await this.invoke(request.id, request.method, request.payload)
        return
      case 'respond':
        await this.respond(request.id, request.result)
        return
      case 'cancel':
        this.cancel(request.id)
        return
      case 'subscribe':
        this.subscribe(request.stream)
        return
      case 'unsubscribe':
        this.unsubscribe(request.stream)
        return
      case 'shutdown':
        this.stop()
        return
      default:
        request satisfies never
    }
  }

  private async invoke(id: string, method: string, payload: unknown): Promise<void> {
    const ac = new AbortController()
    this.pending.set(id, ac)
    try {
      const response = await this.deps.fetch(new Request(`${INTERNAL_BASE}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: RpcId(id), method, payload }),
        signal: ac.signal,
      }))
      if (!response.ok) {
        this.send({ version: DESKTOP_PROTOCOL_VERSION, type: 'error', id, code: 'transport', message: `host returned HTTP ${response.status}` })
        return
      }
      const body = await response.json() as { result?: unknown }
      this.send({ version: DESKTOP_PROTOCOL_VERSION, type: 'result', id, result: body.result })
    } catch (error) {
      // A cancel aborts the controller and removes the entry first; a stop does
      // the same. Either way, do not report a transport error for a request the
      // caller no longer wants.
      if (this.pending.has(id)) {
        this.send({ version: DESKTOP_PROTOCOL_VERSION, type: 'error', id, code: 'transport', message: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      this.pending.delete(id)
    }
  }

  private async respond(id: string, result: unknown): Promise<void> {
    const ac = new AbortController()
    this.pending.set(id, ac)
    try {
      const response = await this.deps.fetch(new Request(`${INTERNAL_BASE}/api/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-response', rpcId: RpcId(id), result }),
        signal: ac.signal,
      }))
      if (!response.ok) {
        this.send({ version: DESKTOP_PROTOCOL_VERSION, type: 'error', id, code: 'transport', message: `host returned HTTP ${response.status}` })
        return
      }
      const body = await response.json()
      this.send({ version: DESKTOP_PROTOCOL_VERSION, type: 'result', id, result: body })
    } catch (error) {
      if (this.pending.has(id)) {
        this.send({ version: DESKTOP_PROTOCOL_VERSION, type: 'error', id, code: 'transport', message: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      this.pending.delete(id)
    }
  }

  private cancel(id: string): void {
    const ac = this.pending.get(id)
    if (ac === undefined) return
    this.pending.delete(id)
    ac.abort()
  }

  private subscribe(streamName: DesktopStream): void {
    if (this.stopped || this.streams.has(streamName)) return
    const ac = new AbortController()
    this.streams.set(streamName, ac)
    void this.pump(streamName, ac.signal)
  }

  private unsubscribe(streamName: DesktopStream): void {
    const ac = this.streams.get(streamName)
    if (ac === undefined) return
    this.streams.delete(streamName)
    ac.abort()
  }

  private async pump(streamName: DesktopStream, signal: AbortSignal): Promise<void> {
    try {
      const iterable = streamName === 'mux' ? this.deps.events.mux(signal) : this.deps.events.host(signal)
      for await (const narrow of iterable) {
        if (this.stopped || signal.aborted) return
        this.send({ version: DESKTOP_PROTOCOL_VERSION, type: 'event', stream: streamName, sequence: this.sequence++, rpcId: narrow.rpcId as string, frame: narrow.payload })
      }
    } catch {
      // Stream loss is not fatal: the client carrier treats a closed stream as
      // a generation failure and reconnects by reopening the subscription.
    } finally {
      this.streams.delete(streamName)
    }
  }

  private send(message: DesktopHostMessage): void {
    this.transport.send(message)
  }
}
