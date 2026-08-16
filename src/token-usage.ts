/**
 * Token-usage extraction from the harness's durable session logs.
 *
 * The harness persists every session as an append-only log under
 * `<dshHome>/sessions/<projectKey>/<sessionId>/session.jsonl.zstd` (or
 * `session.jsonl` when compression is off). Each model step appends an
 * `assistant/message` event whose `data.usage` carries the provider's token
 * accounting — the only exact token source available to the desktop shell.
 *
 * The `.zstd` artifacts are a concatenation of independently decodable zstd
 * frames (one per append batch); Node's one-shot zstd APIs decode a single
 * frame, so this module ports the harness's own frame walker
 * (`scanZstdFrames` in dsh-session-persistence-jsonl) to find complete frame
 * ranges and decodes each frame separately. A torn trailing frame (a batch
 * being appended right now) is tolerated and picked up on the next scan.
 *
 * Scans are incremental: callers keep a `known` map of
 * `path → "mtimeMs:size"` and only re-read changed files. A full cold scan
 * of a heavy history takes a few seconds, so callers run it off the hot
 * path.
 * @module token-usage
 */

import { zstdDecompressSync } from 'node:zlib'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dateKey } from './usage.js'

/** Token accounting extracted for one local calendar day. */
export interface TokenDayUsage {
  /** Un-cached model input tokens. */
  inputTokens: number
  /** Model output tokens. */
  outputTokens: number
  /** Prefix-cache reads (billed input). */
  cacheReadTokens: number
  /** Prefix-cache writes (billed input). */
  cacheWriteTokens: number
  /** Model steps whose accounting was folded into these totals. */
  messages: number
}

/** Aggregated token usage keyed by local `YYYY-MM-DD`. */
export type TokenDays = Record<string, TokenDayUsage>

/** Outcome of one scan pass. */
export interface TokenScanOutcome {
  /** Token totals for every day seen in the scanned logs. */
  days: TokenDays
  /** Session log files inspected. */
  filesScanned: number
  /** Files that were re-read (changed since the previous scan). */
  filesChanged: number
}

/** Session-log artifact names, compressed first. */
const LOG_NAMES = ['session.jsonl.zstd', 'session.jsonl'] as const

/** Zstandard frame magic (`\x28\xb5\x2f\xfd` little-endian). */
const ZSTD_MAGIC = 0xfd2fb528

/**
 * Locate complete zstd frame ranges in a concatenated-frame artifact.
 * Ported from `scanZstdFrames` in dsh-session-persistence-jsonl: walks the
 * frame header and block descriptors without decompressing, so a torn final
 * frame (an in-flight append) simply ends the list.
 * @param buffer - the raw artifact bytes.
 * @returns complete frame byte ranges; the trailing torn frame is excluded.
 */
export function scanZstdFrames(buffer: Buffer): Array<{ start: number; end: number }> {
  const frames: Array<{ start: number; end: number }> = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return frames
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return frames
    offset += 4
    if (offset === buffer.length) return frames
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) return frames
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return frames
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) return frames
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/**
 * Decode a session-log artifact to plaintext. Multi-frame zstd files are
 * decoded frame by frame; a frame failing its checksum is skipped rather
 * than failing the whole file.
 * @param path - the log file path (`.zstd` or plain `.jsonl`).
 * @returns the decoded text, or an empty string when unreadable.
 */
export function readSessionLog(path: string): string {
  try {
    const buffer = readFileSync(path)
    if (path.endsWith('.zstd')) {
      const parts: Buffer[] = []
      for (const frame of scanZstdFrames(buffer)) {
        try {
          parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
        } catch {
          // A corrupt frame withholds only its own batch.
        }
      }
      return Buffer.concat(parts).toString('utf8')
    }
    return buffer.toString('utf8')
  } catch {
    return ''
  }
}

/**
 * Fold the `assistant/message` usage records of one log's plaintext into a
 * day map, attributing tokens to the event's local calendar day.
 * @param text - decoded JSONL text.
 * @param days - accumulator, mutated in place.
 */
export function aggregateSessionText(text: string, days: TokenDays): void {
  for (const line of text.split('\n')) {
    if (!line.includes('assistant/message') || !line.includes('"usage"')) continue
    let record: { type?: unknown; time?: unknown; data?: { usage?: Record<string, unknown> } }
    try {
      record = JSON.parse(line) as typeof record
    } catch {
      continue
    }
    if (record.type !== 'assistant/message' || typeof record.time !== 'number') continue
    const usage = record.data?.usage
    if (usage === undefined) continue
    const key = dateKey(new Date(record.time))
    const day = days[key] ?? (days[key] = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      messages: 0,
    })
    day.inputTokens += num(usage.inputTokens)
    day.outputTokens += num(usage.outputTokens)
    day.cacheReadTokens += num(usage.cacheReadTokens)
    day.cacheWriteTokens += num(usage.cacheWriteTokens)
    day.messages += 1
  }
}

/** Coerce an unknown JSON number to a non-negative integer. */
function num(value: unknown): number {
  return Math.max(0, Number(value) || 0)
}

/**
 * Scan every session log under the sessions directory, re-reading only the
 * files whose mtime or size changed since the caller's last pass.
 * @param sessionsDir - `<dshHome>/sessions` (absent dirs scan as empty).
 * @param known - caller-held `path → "mtimeMs:size"` cache, replaced in
 *   place with the new state as files are successfully re-read.
 * @returns the aggregated token days plus scan bookkeeping.
 */
export function scanTokenLogs(sessionsDir: string, known: Record<string, string>): TokenScanOutcome {
  const days: TokenDays = {}
  const knownNext: Record<string, string> = {}
  let filesScanned = 0
  let filesChanged = 0
  try {
    for (const project of readdirSync(sessionsDir)) {
      const projectDir = join(sessionsDir, project)
      if (!statSync(projectDir).isDirectory()) continue
      let sessionDirs: string[]
      try {
        sessionDirs = readdirSync(projectDir)
      } catch {
        continue
      }
      for (const sessionId of sessionDirs) {
        for (const name of LOG_NAMES) {
          const path = join(projectDir, sessionId, name)
          let stat: ReturnType<typeof statSync>
          try {
            stat = statSync(path)
          } catch {
            continue
          }
          filesScanned += 1
          const stamp = `${stat.mtimeMs}:${stat.size}`
          if (known[path] === stamp) {
            knownNext[path] = stamp
            continue
          }
          const text = readSessionLog(path)
          if (text.length === 0) continue
          aggregateSessionText(text, days)
          knownNext[path] = stamp
          filesChanged += 1
        }
      }
    }
  } catch {
    // sessionsDir missing or unreadable — scan as empty.
  }
  // Sync the caller's cache with the new state (drop entries for files
  // that disappeared, add stamps for files successfully re-read).
  for (const key of Object.keys(known)) {
    if (!(key in knownNext)) delete known[key]
  }
  Object.assign(known, knownNext)
  return { days, filesScanned, filesChanged }
}
