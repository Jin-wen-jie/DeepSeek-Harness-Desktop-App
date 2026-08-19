/** Versioned newline-delimited protocol shared by Electron Main and Host. */

export const DESKTOP_PROTOCOL_VERSION = 1 as const
export const DESKTOP_MAX_MESSAGE_BYTES = 4 * 1024 * 1024

/** Fatal code the Host emits when it receives a request whose protocol version it cannot speak. */
export const DESKTOP_PROTOCOL_VERSION_MISMATCH_CODE = 'version-mismatch' as const

export type DesktopStream = 'mux' | 'host'

export type DesktopHostRequest =
  | { version: typeof DESKTOP_PROTOCOL_VERSION; type: 'invoke'; id: string; method: string; payload: unknown }
  | { version: typeof DESKTOP_PROTOCOL_VERSION; type: 'respond'; id: string; result: unknown }
  | { version: typeof DESKTOP_PROTOCOL_VERSION; type: 'cancel'; id: string }
  | { version: typeof DESKTOP_PROTOCOL_VERSION; type: 'subscribe'; stream: DesktopStream }
  | { version: typeof DESKTOP_PROTOCOL_VERSION; type: 'unsubscribe'; stream: DesktopStream }
  | { version: typeof DESKTOP_PROTOCOL_VERSION; type: 'shutdown' }

export type DesktopHostMessage =
  | { version: typeof DESKTOP_PROTOCOL_VERSION; type: 'ready'; capabilities: readonly string[] }
  | { version: typeof DESKTOP_PROTOCOL_VERSION; type: 'result'; id: string; result: unknown }
  | { version: typeof DESKTOP_PROTOCOL_VERSION; type: 'error'; id?: string; code: string; message: string }
  | { version: typeof DESKTOP_PROTOCOL_VERSION; type: 'event'; stream: DesktopStream; sequence: number; rpcId: string; frame: unknown }
  | { version: typeof DESKTOP_PROTOCOL_VERSION; type: 'fatal'; code?: string; message: string }
  | { version: typeof DESKTOP_PROTOCOL_VERSION; type: 'stopped' }

export class DesktopProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DesktopProtocolError'
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DesktopProtocolError('desktop protocol message must be an object')
  }
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DesktopProtocolError(`desktop protocol ${field} must be a non-empty string`)
  }
  return value
}

function stream(value: unknown): DesktopStream {
  if (value !== 'mux' && value !== 'host') throw new DesktopProtocolError('desktop protocol stream is invalid')
  return value
}

/** Parse one untrusted JSON line from the Host process. */
export function parseDesktopHostMessage(line: string): DesktopHostMessage {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (error) {
    throw new DesktopProtocolError(`desktop protocol JSON parse failed: ${String(error)}`)
  }
  const body = record(value)
  if (body.version !== DESKTOP_PROTOCOL_VERSION) throw new DesktopProtocolError('desktop protocol version mismatch')
  const type = nonEmptyString(body.type, 'type')
  switch (type) {
    case 'ready':
      if (!Array.isArray(body.capabilities) || !body.capabilities.every(item => typeof item === 'string')) {
        throw new DesktopProtocolError('desktop protocol ready capabilities are invalid')
      }
      return { version: DESKTOP_PROTOCOL_VERSION, type, capabilities: body.capabilities }
    case 'result':
      return { version: DESKTOP_PROTOCOL_VERSION, type, id: nonEmptyString(body.id, 'id'), result: body.result }
    case 'error':
      return {
        version: DESKTOP_PROTOCOL_VERSION,
        type,
        ...(body.id === undefined ? {} : { id: nonEmptyString(body.id, 'id') }),
        code: nonEmptyString(body.code, 'code'),
        message: nonEmptyString(body.message, 'message'),
      }
    case 'event':
      if (typeof body.sequence !== 'number' || !Number.isSafeInteger(body.sequence) || body.sequence < 0) {
        throw new DesktopProtocolError('desktop protocol event sequence is invalid')
      }
      return {
        version: DESKTOP_PROTOCOL_VERSION,
        type,
        stream: stream(body.stream),
        sequence: body.sequence,
        rpcId: nonEmptyString(body.rpcId, 'rpcId'),
        frame: body.frame,
      }
    case 'fatal':
      return {
        version: DESKTOP_PROTOCOL_VERSION,
        type,
        ...(body.code === undefined ? {} : { code: nonEmptyString(body.code, 'code') }),
        message: nonEmptyString(body.message, 'message'),
      }
    case 'stopped':
      return { version: DESKTOP_PROTOCOL_VERSION, type }
    default:
      throw new DesktopProtocolError(`desktop protocol message type is unknown: ${type}`)
  }
}

/** Serialize one trusted request for the newline-delimited Host channel. */
export function encodeDesktopHostRequest(request: DesktopHostRequest): string {
  const line = `${JSON.stringify(request)}\n`
  if (Buffer.byteLength(line, 'utf8') > DESKTOP_MAX_MESSAGE_BYTES) {
    throw new DesktopProtocolError('desktop protocol request exceeds the message limit')
  }
  return line
}

/** Validate a request received from a renderer before it reaches the Host. */
export function validateDesktopHostRequest(value: unknown): DesktopHostRequest {
  const body = record(value)
  if (body.version !== DESKTOP_PROTOCOL_VERSION) throw new DesktopProtocolError('desktop protocol version mismatch')
  const type = nonEmptyString(body.type, 'type')
  switch (type) {
    case 'invoke':
      return { version: DESKTOP_PROTOCOL_VERSION, type, id: nonEmptyString(body.id, 'id'), method: nonEmptyString(body.method, 'method'), payload: body.payload }
    case 'respond':
      return { version: DESKTOP_PROTOCOL_VERSION, type, id: nonEmptyString(body.id, 'id'), result: body.result }
    case 'cancel':
      return { version: DESKTOP_PROTOCOL_VERSION, type, id: nonEmptyString(body.id, 'id') }
    case 'subscribe':
    case 'unsubscribe':
      return { version: DESKTOP_PROTOCOL_VERSION, type, stream: stream(body.stream) }
    case 'shutdown':
      return { version: DESKTOP_PROTOCOL_VERSION, type }
    default:
      throw new DesktopProtocolError(`desktop protocol request type is unknown: ${type}`)
  }
}
