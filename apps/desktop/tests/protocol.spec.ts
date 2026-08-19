import { describe, expect, it } from 'vitest'
import {
  DesktopProtocolError,
  parseDesktopHostMessage,
  validateDesktopHostRequest,
} from '../src/shared/protocol.ts'

describe('desktop process protocol', () => {
  it('parses a ready handshake and rejects unknown messages', () => {
    expect(parseDesktopHostMessage('{"version":1,"type":"ready","capabilities":["desktop.spike.echo"]}')).toEqual({
      version: 1, type: 'ready', capabilities: ['desktop.spike.echo'],
    })
    expect(() => parseDesktopHostMessage('{"version":1,"type":"unknown"}')).toThrow(DesktopProtocolError)
  })

  it('validates request discriminants and stream names', () => {
    expect(validateDesktopHostRequest({ version: 1, type: 'subscribe', stream: 'mux' })).toEqual({
      version: 1, type: 'subscribe', stream: 'mux',
    })
    expect(() => validateDesktopHostRequest({ version: 1, type: 'subscribe', stream: 'bad' })).toThrow('stream')
  })

  it('validates a respond request carrying a backfilled rpcId and result', () => {
    expect(validateDesktopHostRequest({ version: 1, type: 'respond', id: 'r1', result: { ok: true, value: true } })).toEqual({
      version: 1, type: 'respond', id: 'r1', result: { ok: true, value: true },
    })
    expect(() => validateDesktopHostRequest({ version: 1, type: 'respond', result: {} })).toThrow('id')
  })

  it('parses event frames with a monotonic sequence and a correlation rpcId', () => {
    expect(parseDesktopHostMessage('{"version":1,"type":"event","stream":"mux","sequence":0,"rpcId":"e1","frame":{"type":"session/subscribed"}}')).toEqual({
      version: 1, type: 'event', stream: 'mux', sequence: 0, rpcId: 'e1', frame: { type: 'session/subscribed' },
    })
    expect(() => parseDesktopHostMessage('{"version":1,"type":"event","stream":"mux","sequence":0,"frame":{}}')).toThrow('rpcId')
  })

  it('rejects a version mismatch before dispatch', () => {
    expect(() => parseDesktopHostMessage('{"version":2,"type":"ready","capabilities":[]}')).toThrow('version mismatch')
  })
})
