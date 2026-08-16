/**
 * Main-process wiring for usage statistics: observes the harness's `/api/*`
 * traffic, folds it into per-day counters, persists them forever, and serves
 * snapshots to the statistics window.
 *
 * The observation point is Electron's `webRequest` on the default session:
 * every `POST /api/<method>` the web GUI (or the shell itself) sends to the
 * local dsh server passes through it. Counting is real-time and needs no
 * cooperation from the harness, which is what keeps it robust across dsh
 * releases.
 * @module usage-main
 */

import { session, shell } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildSnapshot,
  dateKey,
  isUserActivity,
  mergeTokenUsage,
  recordApiCall,
  type DayUsage,
  type UsageFile,
  type UsageRange,
  type UsageSnapshot,
} from './usage.js'
import { scanTokenLogs } from './token-usage.js'

/** Filename of the durable per-day store. */
const STORE_FILENAME = 'usage.json'

/** Delay before persisting after the last recorded call (batching). */
const WRITE_DEBOUNCE_MS = 1_500

/** Cadence of the session-log token scan while the app runs. */
const TOKEN_SCAN_INTERVAL_MS = 20_000

/** A tracked usage store plus its lifecycle controls. */
export interface UsageController {
  /** The durable JSON file path (may not exist until the first write). */
  readonly filePath: string
  /** Aggregated view for one time range. */
  snapshot(range: UsageRange): UsageSnapshot
  /** Persist any pending counters now (call on quit). */
  flush(): void
  /** Reveal the store's directory in the system file manager. */
  openDataDir(): Promise<string>
  /** Subscribe to counter changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void
}

/**
 * Load the store from disk, tolerating a missing or partially corrupt file.
 * @param filePath - the durable JSON path.
 * @returns the loaded day map.
 */
function loadStore(filePath: string): Record<string, DayUsage> {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<UsageFile>
    if (raw.version !== 1 || typeof raw.days !== 'object' || raw.days === null) return {}
    const days: Record<string, DayUsage> = {}
    for (const [key, day] of Object.entries(raw.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue
      const value = day as Partial<DayUsage>
      days[key] = {
        requests: Math.max(0, Number(value.requests) || 0),
        messages: Math.max(0, Number(value.messages) || 0),
        sessions: Math.max(0, Number(value.sessions) || 0),
        agentPrompts: Math.max(0, Number(value.agentPrompts) || 0),
        inputTokens: Math.max(0, Number(value.inputTokens) || 0),
        outputTokens: Math.max(0, Number(value.outputTokens) || 0),
        cacheReadTokens: Math.max(0, Number(value.cacheReadTokens) || 0),
        cacheWriteTokens: Math.max(0, Number(value.cacheWriteTokens) || 0),
      }
    }
    return days
  } catch {
    return {}
  }
}

/**
 * Start usage tracking for the application lifetime.
 * @param options - the app data directory, the harness sessions directory
 *   (`<dshHome>/sessions`) whose logs supply token accounting, and whether
 *   to attach the webRequest observer (disabled in headless smoke mode so
 *   probe traffic never pollutes the real store).
 */
export function startUsageTracking(options: { dataDir: string; sessionsDir: string; observe: boolean }): UsageController {
  const filePath = join(options.dataDir, STORE_FILENAME)
  mkdirSync(options.dataDir, { recursive: true })

  let days = loadStore(filePath)
  const listeners = new Set<() => void>()
  let writeTimer: NodeJS.Timeout | null = null
  const tokenKnown: Record<string, string> = {}

  const persist = (): void => {
    const payload: UsageFile = { version: 1, days }
    const tmpPath = filePath + '.tmp'
    writeFileSync(tmpPath, JSON.stringify(payload))
    renameSync(tmpPath, filePath)
  }

  const scheduleWrite = (): void => {
    if (writeTimer !== null) clearTimeout(writeTimer)
    writeTimer = setTimeout(() => {
      writeTimer = null
      try {
        persist()
      } catch (error) {
        // Usage recording must never take the app down.
        console.error('usage store write failed:', error)
      }
    }, WRITE_DEBOUNCE_MS)
  }

  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // A failing subscriber must not break recording.
      }
    }
  }

  // Token accounting comes from the durable session logs: scan them in the
  // background (incrementally — unchanged files are skipped by mtime/size)
  // and merge the per-day totals into the store. The cold scan can take a
  // few seconds, so it starts after the app's startup path has settled.
  let scanning = false
  const scanTokens = (): void => {
    if (scanning) return
    scanning = true
    try {
      const outcome = scanTokenLogs(options.sessionsDir, tokenKnown)
      if (outcome.filesChanged > 0) {
        mergeTokenUsage(days, outcome.days)
        scheduleWrite()
        notify()
      }
    } catch (error) {
      console.error('token scan failed:', error)
    } finally {
      scanning = false
    }
  }
  const firstScan = setTimeout(scanTokens, 2_000)
  firstScan.unref()
  const tokenTimer = setInterval(scanTokens, TOKEN_SCAN_INTERVAL_MS)
  tokenTimer.unref()

  if (options.observe) {
    session.defaultSession.webRequest.onCompleted((details) => {
      if (details.method !== 'POST') return
      let url: URL
      try {
        url = new URL(details.url)
      } catch {
        return
      }
      if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return
      if (!url.pathname.startsWith('/api/')) return
      const method = decodeURIComponent(url.pathname.slice('/api/'.length))
      if (!isUserActivity(method)) return
      days = recordApiCall(days, dateKey(), method)
      scheduleWrite()
      notify()
    })
  }

  return {
    filePath,
    snapshot: (range: UsageRange): UsageSnapshot => buildSnapshot(days, range),
    flush: () => {
      if (writeTimer !== null) {
        clearTimeout(writeTimer)
        writeTimer = null
      }
      try {
        persist()
      } catch {
        // Best-effort only.
      }
    },
    openDataDir: async () => {
      await shell.openPath(options.dataDir)
      return options.dataDir
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
