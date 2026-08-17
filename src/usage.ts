/**
 * Usage-statistics domain for the desktop shell: pure, Electron-free daily
 * counters aggregated from the harness's HTTP API surface.
 *
 * The web GUI speaks `POST /api/<method>` to the local dsh server (the same
 * envelope the shell itself uses in `workspaceRpc`; unary RPCs travel as
 * HTTP POSTs while the event stream uses a WebSocket mux). The main process
 * observes those calls and folds each one into a per-calendar-day counter
 * record. Records are kept forever — there is no retention window — and the
 * JSON file stores one small object per day, so years of history stay tiny.
 *
 * Token-level accounting (the provider-reported `usage` on assistant
 * messages) lives inside zstd-compressed session logs and is deliberately
 * out of scope here; this module counts observable API activity instead.
 * @module usage
 */

/** One calendar day of counters. All counts are strictly cumulative events. */
export interface DayUsage {
  /** Total `POST /api/*` calls observed (includes the buckets below). */
  requests: number
  /** User prompts sent through the main conversation (`session.prompt`). */
  messages: number
  /** Sessions created (`session.create` / `session.fork`). */
  sessions: number
  /** Sub-agent prompts (`subagent.prompt`). */
  agentPrompts: number
  /** Un-cached model input tokens (from session-log accounting). */
  inputTokens: number
  /** Model output tokens. */
  outputTokens: number
  /** Prefix-cache read tokens (billed input). */
  cacheReadTokens: number
  /** Prefix-cache write tokens (billed input). */
  cacheWriteTokens: number
}

/** Persisted shape of the usage store. */
export interface UsageFile {
  version: 1
  days: Record<string, DayUsage>
}

/** The four user-facing counter buckets, plus uncategorized requests. */
export type UsageBucket = 'messages' | 'sessions' | 'agentPrompts' | 'other'

/** Time-range choices offered by the statistics page. */
export type UsageRange = 7 | 30 | 'all'

import type { TokenStats } from './token-usage.js'

const emptyDay = (): DayUsage => ({
  requests: 0,
  messages: 0,
  sessions: 0,
  agentPrompts: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

/**
 * Local-time calendar key for a date, `YYYY-MM-DD`. Deliberately not
 * `toISOString()` (UTC would roll days over at 08:00 in UTC+8).
 * @param date - the instant to key; defaults to now.
 */
export function dateKey(date: Date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Parse a `YYYY-MM-DD` key as a local-time date (never UTC). */
export function parseDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

/**
 * Whether an observed RPC method counts as user activity. Wire method names
 * carry no `api.` prefix (`session.prompt`, `settings.describe`, … — the
 * browser client's `api.*` namespace maps onto them). The shell's own
 * boot-time `workspace.*` calls (pinning the 任务 workspace) are internal
 * plumbing, not usage, so they are excluded.
 * @param method - method name decoded from the `/api/<method>` path.
 */
export function isUserActivity(method: string): boolean {
  return !method.startsWith('workspace.')
}

/**
 * Which bucket a method lands in; everything else counts as `other`.
 * @param method - method name decoded from the `/api/<method>` path.
 */
export function bucketOf(method: string): UsageBucket {
  switch (method) {
    case 'session.prompt': return 'messages'
    case 'session.create':
    case 'session.fork': return 'sessions'
    case 'subagent.prompt': return 'agentPrompts'
    default: return 'other'
  }
}

/**
 * Fold one observed API call into the store, immutably.
 * @param days - the store's day map.
 * @param key - the local calendar key the call happened on.
 * @param method - the RPC method name.
 * @returns a new day map with the call counted.
 */
export function recordApiCall(days: Record<string, DayUsage>, key: string, method: string): Record<string, DayUsage> {
  const day = { ...(days[key] ?? emptyDay()) }
  day.requests += 1
  const bucket = bucketOf(method)
  if (bucket === 'messages') day.messages += 1
  else if (bucket === 'sessions') day.sessions += 1
  else if (bucket === 'agentPrompts') day.agentPrompts += 1
  return { ...days, [key]: day }
}

/** A day's counters plus the derived `other` bucket. */
export interface UsageTotals extends DayUsage {
  other: number
}

/** One row of the per-day table. */
export interface DailyRow {
  /** `YYYY-MM-DD` key. */
  date: string
  /** Short display label: 今天 / 昨天 / M月D日 (year prefixed when not current). */
  label: string
  /** The day's counters. */
  day: DayUsage
}

/** One model's token share over a time range (for the donut chart). */
export interface ModelUsage {
  /** Model id (e.g. `deepseek-v4-flash`). */
  model: string
  /** Total tokens (input + output + cache) billed to this model. */
  tokens: number
  /** Share of the range's total tokens, 0..1. */
  share: number
}

/** Aggregated view handed to the statistics page for one time range. */
export interface UsageSnapshot {
  range: UsageRange
  /** Days in the range, newest first (including today when active or touched). */
  rows: DailyRow[]
  /** Sum over the range's rows. */
  totals: UsageTotals
  /** Distinct days in the range with at least one request. */
  activeDays: number
  /** Consecutive active days ending today (or yesterday when today is still quiet). */
  streak: number
  /** Today's counters (live-updating). */
  today: DayUsage
  /** Distinct recorded days since the store started. */
  daysTotal: number
  /** First recorded date, or null when the store is empty. */
  firstDate: string | null
  /** Per-model token totals over the range, largest first. */
  models: ModelUsage[]
}

/**
 * Build the aggregated snapshot for one time range.
 * @param days - the full day map.
 * @param range - 7 / 30 / all.
 * @param now - the "current" instant (injectable for tests).
 * @param modelDays - optional per-day, per-model accounting (supplied by
 *   the session-log scan) used to compute the per-model donut.
 */
export function buildSnapshot(
  days: Record<string, DayUsage>,
  range: UsageRange,
  now: Date = new Date(),
  modelDays: Record<string, Record<string, TokenStats>> = {},
): UsageSnapshot {
  const todayKey = dateKey(now)
  const rows: DailyRow[] = []
  if (range === 'all') {
    // All history: one row per recorded day, newest first.
    for (const key of Object.keys(days).sort().reverse()) {
      rows.push({ date: key, label: rowLabel(key, todayKey), day: days[key] })
    }
    if (rows.length === 0) rows.push({ date: todayKey, label: '今天', day: emptyDay() })
  } else {
    // Finite range: exactly N calendar days ending today, padded with zero
    // rows so "最近7天" always shows 7 days.
    const cursor = parseDateKey(todayKey)
    for (let i = 0; i < range; i++) {
      const key = dateKey(cursor)
      rows.push({ date: key, label: rowLabel(key, todayKey), day: days[key] ?? emptyDay() })
      cursor.setDate(cursor.getDate() - 1)
    }
  }

  const totals: UsageTotals = { requests: 0, messages: 0, sessions: 0, agentPrompts: 0, other: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  let activeDays = 0
  for (const { day } of rows) {
    totals.requests += day.requests
    totals.messages += day.messages
    totals.sessions += day.sessions
    totals.agentPrompts += day.agentPrompts
    totals.inputTokens += day.inputTokens
    totals.outputTokens += day.outputTokens
    totals.cacheReadTokens += day.cacheReadTokens
    totals.cacheWriteTokens += day.cacheWriteTokens
    if (day.requests > 0) activeDays += 1
  }
  totals.other = totals.requests - totals.messages - totals.sessions - totals.agentPrompts

  const today = days[todayKey] ?? emptyDay()
  const keys = Object.keys(days)
  const models = computeModelUsage(rows, modelDays, totals)
  return {
    range,
    rows,
    totals,
    activeDays,
    streak: computeStreak(days, todayKey),
    today,
    daysTotal: keys.length,
    firstDate: keys.length > 0 ? keys.sort()[0] : null,
    models,
  }
}

/** Sum per-model token totals over the snapshot's rows and rank them. */
export function computeModelUsage(
  rows: DailyRow[],
  modelDays: Record<string, Record<string, TokenStats>>,
  totals: UsageTotals,
): ModelUsage[] {
  const agg: Record<string, number> = {}
  for (const { date } of rows) {
    const byModel = modelDays[date]
    if (byModel === undefined) continue
    for (const [model, stats] of Object.entries(byModel)) {
      agg[model] = (agg[model] ?? 0) + stats.inputTokens + stats.outputTokens + stats.cacheReadTokens + stats.cacheWriteTokens
    }
  }
  const totalTokens = totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
  return Object.entries(agg)
    .map(([model, tokens]) => ({ model, tokens, share: totalTokens > 0 ? tokens / totalTokens : 0 }))
    .sort((a, b) => b.tokens - a.tokens)
}

/** Human label for a row date relative to today. */
function rowLabel(key: string, todayKey: string): string {
  if (key === todayKey) return '今天'
  const yesterday = dateKey(new Date(parseDateKey(todayKey).getTime() - 86_400_000))
  if (key === yesterday) return '昨天'
  const d = parseDateKey(key)
  const now = parseDateKey(todayKey)
  const monthDay = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === now.getFullYear() ? monthDay : `${d.getFullYear()}年${monthDay}`
}

/** Trailing consecutive active days; a quiet today keeps yesterday's streak. */
function computeStreak(days: Record<string, DayUsage>, todayKey: string): number {
  let cursor = parseDateKey(todayKey)
  if ((days[todayKey]?.requests ?? 0) === 0) cursor.setDate(cursor.getDate() - 1)
  let streak = 0
  while ((days[dateKey(cursor)]?.requests ?? 0) > 0) {
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}
