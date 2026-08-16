/**
 * Manages the bundled DeepSeek Harness web server as a child process.
 *
 * The desktop shell does not reimplement the harness: it spawns the official
 * `@deepseek-ai/dsh` CLI (published on npm) with `web --port 0` and waits
 * for the readiness line the CLI prints once its Loader tree has settled
 * (`dsh web: http://127.0.0.1:<port>`). The Electron binary doubles as the
 * Node.js runtime through ELECTRON_RUN_AS_NODE, so the packaged app needs no
 * system Node and satisfies the CLI's `engines` requirement (Electron 43
 * ships Node 24.18).
 * @module harness
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'

/** A running harness server plus its stop control. */
export interface HarnessServer {
  /** Canonical loopback URL of the serving web GUI. */
  url: string
  /** Terminate the server process. */
  stop(): Promise<void>
}

/** Exit facts for the caller's crash handling. */
export interface HarnessExitInfo {
  code: number | null
  signal: string | null
}

/** Options for {@link startHarnessServer}. */
export interface StartOptions {
  /** Node-capable executable: the Electron binary (ELECTRON_RUN_AS_NODE) or a node binary. */
  execPath: string
  /** Absolute path of `@deepseek-ai/dsh/lib/bin.js`. */
  binPath: string
  /** Receives every stdout/stderr line from the child, for logs and diagnostics. */
  onLine?: (line: string) => void
  /** Fires when the child exits after readiness (a crash), not after {@link HarnessServer.stop}. */
  onExit?: (info: HarnessExitInfo) => void
  /** Readiness timeout in milliseconds. */
  timeoutMs?: number
}

/** Matches the CLI's readiness line: `dsh web: http://127.0.0.1:<port>`. */
const URL_LINE = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/

/** Tail length kept for the startup-failure message. */
const TAIL_LINES = 24

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Resolve the bundled dsh CLI entry, preferring real files over an asar copy.
 * The app ships with `asar: false`, but the fallback keeps source checkouts
 * and future packaging choices working.
 * @returns the absolute path of the dsh bin entry.
 */
export function resolveDshBinPath(): string {
  const require = createRequire(import.meta.url)
  const resolved = require.resolve('@deepseek-ai/dsh/lib/bin.js')
  const unpacked = resolved.replace('app.asar', 'app.asar.unpacked')
  return resolved.includes('app.asar') && existsSync(unpacked) ? unpacked : resolved
}

/**
 * Spawn the harness web server and resolve when its URL line appears.
 * @param options - executable, bin path, and observation hooks.
 * @returns the running server, or a rejected promise with the output tail.
 */
export function startHarnessServer(options: StartOptions): Promise<HarnessServer> {
  const tail: string[] = []
  const timeoutMs = options.timeoutMs ?? 120_000
  let resolveReady!: (url: string) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<string>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })

  // settled: the startup promise has an outcome; ready: the URL line arrived.
  let settled = false
  let readyFlag = false
  const fail = (message: string): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    rejectReady(new Error(`${message}\nLast output:\n${tail.join('\n') || '(no output)'}`))
  }

  const timer = setTimeout(() => {
    fail(`Timed out after ${timeoutMs} ms waiting for the DeepSeek Harness readiness line.`)
  }, timeoutMs)

  const emit = (line: string): void => {
    tail.push(line)
    if (tail.length > TAIL_LINES) tail.shift()
    options.onLine?.(line)
    const match = URL_LINE.exec(line)
    if (match !== null && !settled) {
      settled = true
      readyFlag = true
      clearTimeout(timer)
      resolveReady(match[1])
    }
  }

  // --expose-internals: the harness's HMR service reads Node's internal ESM
  // loader. Its native-addon fallback (node-addon-require-builtin) cannot run
  // inside Electron, and the flag passes through to the embedded Node, so the
  // direct require branch works. ELECTRON_RUN_AS_NODE: the Electron binary
  // behaves as a plain Node runtime (Node 24.18 in Electron 43).
  const child: ChildProcess = spawn(options.execPath, ['--expose-internals', options.binPath, 'web', '--port', '0'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const pump = (stream: NodeJS.ReadableStream | null): void => {
    if (stream !== null) createInterface({ input: stream }).on('line', emit)
  }
  pump(child.stdout)
  pump(child.stderr)

  child.on('error', (error) => {
    fail(`Failed to spawn the dsh CLI: ${String(error)}`)
  })

  let stopped = false
  child.on('exit', (code, signal) => {
    if (!settled) {
      fail(`DeepSeek Harness exited before reporting a URL (code ${String(code)}, signal ${String(signal)}).`)
    } else if (readyFlag && !stopped) {
      options.onExit?.({ code, signal })
    }
  })

  return ready.then((url) => ({
    url,
    stop: async (): Promise<void> => {
      if (stopped) return
      stopped = true
      if (child.exitCode === null && child.signalCode === null) {
        // Windows has no catchable SIGTERM for a foreign process: this is a
        // forced stop, which the harness tolerates (sessions write per event).
        child.kill()
        await Promise.race([once(child, 'exit'), sleep(10_000)])
      }
    },
  }))
}
