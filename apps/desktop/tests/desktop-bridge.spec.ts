import { describe, expect, it } from 'vitest'
import { RpcId, type HostFrame, type MuxFrame, type RpcRequest } from '@deepseek-ai/dsh-host-apiproxy'
import { DesktopBridge, type DesktopBridgeDeps } from '../src/host/desktop-bridge.ts'
import type { DesktopHostMessage } from '../src/shared/protocol.ts'

function stubDeps(): DesktopBridgeDeps {
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init)
    const url = new URL(req.url)
    const body = req.method === 'POST' ? await req.json() as { rpcId?: unknown; result?: unknown } : {}
    if (url.pathname === '/api/host.describe') {
      return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { version: 'stub', cwd: '/', attachedSessions: [], canOpenPath: false } } })
    }
    if (url.pathname === '/api/respond') {
      return Response.json({ accepted: true })
    }
    return new Response('not found', { status: 404 })
  }
  const idle = (signal: AbortSignal): Promise<void> => new Promise((resolve) => {
    if (signal.aborted) return resolve()
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
  const events: DesktopBridgeDeps['events'] = {
    async *mux(signal: AbortSignal): AsyncIterable<RpcRequest<MuxFrame>> {
      yield { rpcId: RpcId('mux-1'), payload: { type: 'session/subscribed', sessionId: 's1' } as unknown as MuxFrame }
      await idle(signal)
    },
    async *host(signal: AbortSignal): AsyncIterable<RpcRequest<HostFrame>> {
      await idle(signal)
    },
  }
  return { fetch, events }
}

describe('DesktopBridge', () => {
  it('relays readiness, unary RpcResult, sequenced events with rpcId, respond, and shutdown', async () => {
    const messages: DesktopHostMessage[] = []
    const bridge = new DesktopBridge(stubDeps(), { send: m => messages.push(m) })
    bridge.start()

    bridge.handleLine(JSON.stringify({ version: 1, type: 'invoke', id: 'd1', method: 'host.describe', payload: {} }))
    await new Promise(resolve => setTimeout(resolve, 5))
    bridge.handleLine(JSON.stringify({ version: 1, type: 'subscribe', stream: 'mux' }))
    await new Promise(resolve => setTimeout(resolve, 5))
    bridge.handleLine(JSON.stringify({ version: 1, type: 'respond', id: 'r1', result: { ok: true, value: true } }))
    await new Promise(resolve => setTimeout(resolve, 5))
    bridge.handleLine(JSON.stringify({ version: 1, type: 'shutdown' }))
    await new Promise(resolve => setTimeout(resolve, 5))

    expect(messages.find(m => m.type === 'ready')).toBeDefined()
    const result = messages.find(m => m.type === 'result' && m.id === 'd1')
    expect(result).toBeDefined()
    expect((result as { result: { ok: boolean; value: { version: string } } }).result).toEqual({ ok: true, value: expect.objectContaining({ version: 'stub' }) })
    const event = messages.find(m => m.type === 'event')
    expect(event).toBeDefined()
    expect((event as { sequence: number; rpcId: string }).rpcId).toBe('mux-1')
    expect((event as { sequence: number }).sequence).toBe(0)
    const respondResult = messages.find(m => m.type === 'result' && m.id === 'r1')
    expect((respondResult as { result: unknown }).result).toEqual({ accepted: true })
    expect(messages.find(m => m.type === 'stopped')).toBeDefined()
  })

  it('reports a version mismatch as a coded fatal and drops the request', () => {
    const messages: DesktopHostMessage[] = []
    const bridge = new DesktopBridge(stubDeps(), { send: m => messages.push(m) })
    bridge.start()
    bridge.handleLine(JSON.stringify({ version: 99, type: 'invoke', id: 'x', method: 'host.describe', payload: {} }))
    const fatal = messages.find(m => m.type === 'fatal')
    expect(fatal).toBeDefined()
    expect((fatal as { code?: string }).code).toBe('version-mismatch')
    // No result is emitted for the mismatched request.
    expect(messages.find(m => m.type === 'result')).toBeUndefined()
  })

  it('cancels an in-flight invoke without emitting a transport error', async () => {
    const messages: DesktopHostMessage[] = []
    // A fetch that never resolves on its own so cancel is the only way out.
    const deps: DesktopBridgeDeps = {
      fetch: (_input, _init) => new Promise<Response>(() => {}),
      events: stubDeps().events,
    }
    const bridge = new DesktopBridge(deps, { send: m => messages.push(m) })
    bridge.start()
    bridge.handleLine(JSON.stringify({ version: 1, type: 'invoke', id: 'c1', method: 'host.describe', payload: {} }))
    await new Promise(resolve => setTimeout(resolve, 5))
    bridge.handleLine(JSON.stringify({ version: 1, type: 'cancel', id: 'c1' }))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(messages.find(m => m.type === 'error' && m.id === 'c1')).toBeUndefined()
    expect(messages.find(m => m.type === 'result' && m.id === 'c1')).toBeUndefined()
  })
})
