import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import {
  DESKTOP_MAX_MESSAGE_BYTES,
  type DesktopHostMessage,
  type DesktopHostRequest,
  type DesktopStream,
  encodeDesktopHostRequest,
  parseDesktopHostMessage,
} from '../shared/protocol.ts'

export type HostSupervisorState = 'idle' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'crashed'

export interface HostSupervisorOptions {
  command: string
  args: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  startupTimeoutMs?: number
  shutdownTimeoutMs?: number
}

export interface HostSupervisorEvents {
  ready: [readonly string[]]
  message: [DesktopHostMessage]
  state: [HostSupervisorState]
  error: [Error]
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

/** Owns one Host process and keeps request/event state generation-scoped. */
export class HostSupervisor extends EventEmitter<HostSupervisorEvents> {
  private child: ChildProcessWithoutNullStreams | undefined
  private stateValue: HostSupervisorState = 'idle'
  private buffer = ''
  private readyPromise: Promise<readonly string[]> | undefined
  private readyResolve: ((capabilities: readonly string[]) => void) | undefined
  private readyReject: ((error: Error) => void) | undefined
  private readonly pending = new Map<string, PendingRequest>()
  private readonly subscriptions = new Set<DesktopStream>()
  private readonly startupTimeoutMs: number
  private readonly shutdownTimeoutMs: number

  constructor(private readonly options: HostSupervisorOptions) {
    super()
    // EventEmitter treats an unhandled `error` event as a process failure. The
    // supervisor also exposes the event for diagnostics, so keep a no-op sink
    // until the desktop shell attaches its logger.
    this.on('error', () => undefined)
    this.startupTimeoutMs = options.startupTimeoutMs ?? 10_000
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000
  }

  get state(): HostSupervisorState { return this.stateValue }

  /** Spawn the Host and await its readiness handshake. */
  async start(): Promise<readonly string[]> {
    if (this.stateValue !== 'idle' && this.stateValue !== 'stopped' && this.stateValue !== 'crashed') {
      throw new Error(`desktop host cannot start from state ${this.stateValue}`)
    }
    this.setState('starting')
    this.buffer = ''
    this.readyPromise = new Promise<readonly string[]>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.child = spawn(this.options.command, [...this.options.args], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => { this.receive(chunk) })
    this.child.stderr.on('data', (chunk: string) => {
      const message = chunk.trim()
      if (message !== '') this.emit('error', new Error(`desktop host stderr: ${message}`))
    })
    this.child.on('error', (error) => { this.fail(error) })
    this.child.on('exit', (code, signal) => { this.onExit(code, signal) })
    const ready = this.readyPromise
    const timeout = delay(this.startupTimeoutMs).then(() => {
      throw new Error(`desktop host readiness timed out after ${this.startupTimeoutMs}ms`)
    })
    try {
      return await Promise.race([ready, timeout])
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      await this.stop()
      throw failure
    }
  }

  /** Send one method call and resolve its business result. */
  async invoke(id: string, method: string, payload: unknown): Promise<unknown> {
    return this.dispatch(id, { version: 1, type: 'invoke', id, method, payload })
  }

  /** Answer a host-originated server-request (approval/question) by its rpcId. */
  async respond(id: string, result: unknown): Promise<unknown> {
    return this.dispatch(id, { version: 1, type: 'respond', id, result })
  }

  /** Shared pending-registration + send-after-ready leg for invoke and respond. */
  private dispatch(id: string, request: DesktopHostRequest): Promise<unknown> {
    if (this.pending.has(id)) throw new Error(`desktop host request id already exists: ${id}`)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      void this.ready().then(() => {
        if (!this.pending.has(id)) return
        try {
          this.send(request)
        } catch (error) {
          this.pending.delete(id)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      }, (error) => {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  /** Cancel a pending request; a missing id is intentionally a no-op. */
  cancel(id: string): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    if (this.child !== undefined && this.stateValue === 'ready') this.send({ version: 1, type: 'cancel', id })
    this.pending.delete(id)
    pending.reject(new Error('desktop host request cancelled'))
  }

  /** Subscribe the process channel to one event stream. */
  subscribe(stream: DesktopStream): void {
    if (this.subscriptions.has(stream)) return
    this.subscriptions.add(stream)
    if (this.stateValue === 'ready') this.send({ version: 1, type: 'subscribe', stream })
  }

  unsubscribe(stream: DesktopStream): void {
    if (!this.subscriptions.delete(stream)) return
    if (this.stateValue === 'ready') this.send({ version: 1, type: 'unsubscribe', stream })
  }

  /** Ask the Host to stop, then force-kill only after the bounded timeout. */
  async stop(): Promise<void> {
    const child = this.child
    if (child === undefined || child.killed) {
      this.setState('stopped')
      return
    }
    this.setState('stopping')
    try { this.send({ version: 1, type: 'shutdown' }) } catch { /* child is already closing */ }
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    await Promise.race([exited, delay(this.shutdownTimeoutMs)])
    if (!child.killed && this.child === child) child.kill()
    if (this.child === child) this.child = undefined
    this.rejectPending(new Error('desktop host stopped'))
    this.setState('stopped')
  }

  private async ready(): Promise<readonly string[]> {
    if (this.stateValue === 'ready') return []
    if (this.readyPromise === undefined) throw new Error('desktop host is not started')
    return this.readyPromise
  }

  private send(request: DesktopHostRequest): void {
    if (this.child === undefined || this.child.stdin.destroyed) throw new Error('desktop host is not running')
    const line = encodeDesktopHostRequest(request)
    if (Buffer.byteLength(line) > DESKTOP_MAX_MESSAGE_BYTES) throw new Error('desktop host request exceeds message limit')
    this.child.stdin.write(line)
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer, 'utf8') > DESKTOP_MAX_MESSAGE_BYTES * 2) {
      this.fail(new Error('desktop host output buffer exceeds the message limit'))
      return
    }
    let boundary: number
    while ((boundary = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, boundary).trim()
      this.buffer = this.buffer.slice(boundary + 1)
      if (line === '') continue
      try {
        this.handle(parseDesktopHostMessage(line))
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  private handle(message: DesktopHostMessage): void {
    this.emit('message', message)
    switch (message.type) {
      case 'ready':
        this.setState('ready')
        this.readyResolve?.(message.capabilities)
        this.readyResolve = undefined
        this.readyReject = undefined
        for (const stream of this.subscriptions) this.send({ version: 1, type: 'subscribe', stream })
        this.emit('ready', message.capabilities)
        return
      case 'result': {
        const pending = this.pending.get(message.id)
        if (pending === undefined) return
        this.pending.delete(message.id)
        pending.resolve(message.result)
        return
      }
      case 'error': {
        if (message.id === undefined) return
        const pending = this.pending.get(message.id)
        if (pending === undefined) return
        this.pending.delete(message.id)
        pending.reject(new Error(`${message.code}: ${message.message}`))
        return
      }
      case 'fatal':
        this.fail(new Error(message.message))
        return
      case 'event':
      case 'stopped':
        return
      default:
        message satisfies never
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const expected = this.stateValue === 'stopping' || this.stateValue === 'stopped'
    this.child = undefined
    if (expected) return
    this.fail(new Error(`desktop host exited unexpectedly (code=${String(code)}, signal=${String(signal)})`))
  }

  private fail(error: Error): void {
    this.emit('error', error)
    this.readyReject?.(error)
    this.readyResolve = undefined
    this.readyReject = undefined
    this.rejectPending(error)
    if (this.stateValue !== 'stopping' && this.stateValue !== 'stopped') this.setState('crashed')
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.reject(error)
    }
  }

  private setState(next: HostSupervisorState): void {
    if (this.stateValue === next) return
    this.stateValue = next
    this.emit('state', next)
  }
}
