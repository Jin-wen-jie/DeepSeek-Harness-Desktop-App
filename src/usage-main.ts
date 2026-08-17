/**
 * Main-process wiring for usage statistics: observes the harness's `/api/*`
 * traffic, folds it into per-day HTTP counters (persisted forever), and
 * derives exact token + per-model accounting from the harness session logs
 * (exact numbers that only the logs carry; kept in memory and refreshed
 * every few seconds).
 *
 * The observation point is Electron's `webRequest` on the default session:
 * every `POST /api/<method>` the web GUI (or the shell itself) sends to the
 * local dsh server passes through it. Token accounting is scanned from the
 * durable session logs — webRequest cannot see provider token usage.
 *
 * Token totals are derived purely from the logs to stay exact across
 * restarts and appends: the scanner reports per-file aggregates for changed
 * files only, `fileAccounting` maps each log path to its last aggregate, and
 * every snapshot rebuilds the derived day totals and per-model figures from
 * those aggregates, so a re-read file replaces its contribution instead of
 * double-counting it.
 * @module usage-main
 */

import { session, shell } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildSnapshot,
  dateKey,
  isUserActivity,
  recordApiCall,
  type DayUsage,
  type UsageFile,
  type UsageRange,
  type UsageSnapshot,
} from './usage.js'
import { scanTokenLogs, type TokenDays, type TokenStats } from './token-usage.js'

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

/** A day with all counters at zero. */
function emptyDay(): DayUsage {
  return {
    requests: 0, messages: 0, sessions: 0, agentPrompts: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  }
}

/**
 * Load the store from disk, tolerating a missing or partially corrupt file.
 * Stored token fields are accepted for backward compatibility but derived
 * figures are always recomputed from the logs, so they are reset here.
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
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }
    }
    return days
  } catch {
    return {}
  }
}

/** Per-day token totals and per-day/model splits, derived from the logs. */
interface Derived {
  perDay: Map<string, DayUsage>
  perModel: Map<string, Record<string, TokenStats>>
}

/**
 * Rebuild the derived per-day token totals and per-day/model map from the
 * current per-file accounting.
 */
function rebuildDerived(fileAccounting: Map<string, TokenDays>): Derived {
  const perDay = new Map<string, DayUsage>()
  const perModel = new Map<string, Record<string, TokenStats>>()
  for (const fileDays of fileAccounting.values()) {
    for (const [key, tokens] of Object.entries(fileDays)) {
      const day = perDay.get(key) ?? emptyDay()
      day.inputTokens += tokens.inputTokens
      day.outputTokens += tokens.outputTokens
      day.cacheReadTokens += tokens.cacheReadTokens
      day.cacheWriteTokens += tokens.cacheWriteTokens
      perDay.set(key, day)
      let byModel = perModel.get(key)
      if (byModel === undefined) { byModel = {}; perModel.set(key, byModel) }
      for (const [model, stats] of Object.entries(tokens.models)) {
        const slot = byModel[model] ?? (byModel[model] = {
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messages: 0,
        })
        slot.inputTokens += stats.inputTokens
        slot.outputTokens += stats.outputTokens
        slot.cacheReadTokens += stats.cacheReadTokens
        slot.cacheWriteTokens += stats.cacheWriteTokens
        slot.messages += stats.messages
      }
    }
  }
  return { perDay, perModel }
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

  // Token + per-model accounting, derived from the session logs in memory.
  const fileAccounting = new Map<string, TokenDays>()
  const tokenKnown: Record<string, string> = {}
  let firstScanPending = true

  const persist = (): void => {
    // Token fields are derived from the logs, not stored — write the HTTP
    // counters only, so stale token figures never survive a restart.
    const cleanDays: Record<string, DayUsage> = {}
    for (const [key, day] of Object.entries(days)) {
      cleanDays[key] = { ...emptyDay(), requests: day.requests, messages: day.messages, sessions: day.sessions, agentPrompts: day.agentPrompts }
    }
    const payload: UsageFile = { version: 1, days: cleanDays }
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

  let scanning = false
  const scanTokens = (): void => {
    if (scanning) return
    scanning = true
    try {
      const outcome = scanTokenLogs(options.sessionsDir, tokenKnown)
      if (outcome.filesChanged > 0 || firstScanPending) {
        for (const entry of outcome.changedFiles) fileAccounting.set(entry.path, entry.days)
        firstScanPending = false
        scheduleWrite()
        notify()
      }
    } catch (error) {
      console.error('token scan failed:', error)
    } finally {
      scanning = false
    }
  }
  // The cold scan can take a few seconds, so it starts after the app's
  // startup path has settled; later scans are incremental.
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
    snapshot: (range: UsageRange): UsageSnapshot => {
      const { perDay, perModel } = rebuildDerived(fileAccounting)
      // Compose each day: persisted HTTP counters + derived token fields.
      const view: Record<string, DayUsage> = {}
      const addView = (key: string, base: DayUsage): void => {
        const merged: DayUsage = {
          ...base,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        }
        const tokens = perDay.get(key)
        if (tokens !== undefined) {
          merged.inputTokens = tokens.inputTokens
          merged.outputTokens = tokens.outputTokens
          merged.cacheReadTokens = tokens.cacheReadTokens
          merged.cacheWriteTokens = tokens.cacheWriteTokens
        }
        view[key] = merged
      }
      for (const [key, day] of Object.entries(days)) addView(key, day)
      for (const key of perDay.keys()) {
        if (view[key] === undefined) addView(key, emptyDay())
      }
      const modelDays: Record<string, Record<string, TokenStats>> = {}
      for (const [key, value] of perModel) modelDays[key] = value
      return buildSnapshot(view, range, new Date(), modelDays)
    },
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
