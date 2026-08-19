import { describe, expect, it } from 'vitest'
import {
  ConnectionController,
  RpcId,
  type ConnectionState,
  type HostDescription,
} from '@deepseek-ai/dsh-client-connection/client'
import {
  IpcApiClient,
  type DesktopIpcTransport,
  type DesktopStream,
  type DesktopStreamSinks,
} from '../src/client/ipc-api-client.ts'

interface StubHandle {
  transport: DesktopIpcTransport
  sinks: Map<DesktopStream, DesktopStreamSinks>
}

function stubTransport(): StubHandle {
  const sinks = new Map<DesktopStream, DesktopStreamSinks>()
  const transport: DesktopIpcTransport = {
    invoke: async (_rpcId, method) => {
      if (method === 'host.describe') {
        return { ok: true, value: { version: 'stub', cwd: '/', attachedSessions: 0, canOpenPath: false } }
      }
      return { ok: false, error: { code: 'internal', message: `unknown method ${method}`, details: {} } }
    },
    respond: async () => ({ accepted: true }),
    subscribe: (stream, s) => {
      sinks.set(stream, s)
      return () => { sinks.delete(stream) }
    },
  }
  return { transport, sinks }
}

const fastConfig = { backoffBaseMs: 5, backoffFactor: 2, backoffMaxMs: 20, streamOpenTimeoutMs: 500 }
const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('IpcApiClient + ConnectionController', () => {
  it('completes the connection handshake and publishes the host description over IPC', async () => {
    const { transport } = stubTransport()
    const api = new IpcApiClient(transport)
    let connected: HostDescription | undefined
    let state: ConnectionState | undefined
    const controller = new ConnectionController(api, {
      onConnected: (description) => { connected = description },
      onStateChange: (next) => { state = next },
    }, fastConfig)
    controller.start()
    await tick(50)
    expect(connected?.version).toBe('stub')
    expect(state).toBe('connected')
    controller.stop()
  })

  it('reconnects after a stream loss', async () => {
    const { transport, sinks } = stubTransport()
    const api = new IpcApiClient(transport)
    const states: ConnectionState[] = []
    let connectedCount = 0
    const controller = new ConnectionController(api, {
      onConnected: () => { connectedCount += 1 },
      onStateChange: (next) => { states.push(next) },
    }, fastConfig)
    controller.start()
    await tick(50)
    expect(connectedCount).toBe(1)
    sinks.get('mux')?.onClose()
    await tick(100)
    expect(states).toContain('reconnecting')
    expect(connectedCount).toBeGreaterThanOrEqual(2)
    controller.stop()
  })

  it('routes a unary call through the IPC transport and returns the parsed RpcResult', async () => {
    const { transport } = stubTransport()
    const api = new IpcApiClient(transport)
    const response = await api.host.describe({})
    expect(response.result.ok).toBe(true)
    if (response.result.ok) {
      expect(response.result.value.version).toBe('stub')
      expect(response.result.value.attachedSessions).toBe(0)
    }
  })

  it('routes respond through the IPC transport and returns the receipt', async () => {
    const { transport } = stubTransport()
    const api = new IpcApiClient(transport)
    const receipt = await api.respond({ type: 'client-response', rpcId: RpcId('r1'), result: { ok: true, value: true } })
    expect(receipt).toEqual({ accepted: true })
  })
})
