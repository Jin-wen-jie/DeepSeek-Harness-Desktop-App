/**
 * In-app update flow: checks the project's GitHub Releases for a newer
 * version, downloads the Windows NSIS installer, and hands it to the OS.
 *
 * The release workflow publishes installers under the `v*` tag convention
 * (`DeepSeek-Harness-Setup-<version>.exe` for Windows), so the latest
 * release's tag is the version oracle. All network calls carry a timeout and
 * every failure surfaces as a user-readable error — the app must keep
 * working when GitHub is unreachable.
 * @module updater
 */

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { app } from 'electron'

/** Repository whose releases this app publishes to. */
const REPO = 'Jin-wen-jie/DeepSeek-Harness-Desktop-App'

/** GitHub API timeout — slow or blocked networks must fail fast, not hang. */
const FETCH_TIMEOUT_MS = 15_000

/** Outcome of a version check. */
export interface UpdateCheckResult {
  status: 'ok' | 'error'
  /** The running app's version. */
  current: string
  /** The newest published version, or null when none was found. */
  latest: string | null
  /** Whether a newer version is available. */
  hasUpdate: boolean
  /** Installer asset file name (Windows). */
  assetName: string | null
  /** Installer asset download URL. */
  assetUrl: string | null
  /** Installer size in bytes, when the API reports it. */
  size: number | null
  /** Human-readable failure reason when `status` is `error`. */
  error?: string
}

/** Compare dotted versions `a` vs `b`; true when `a` is strictly newer. */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map(part => Number(part) || 0)
  const pb = b.split('.').map(part => Number(part) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da !== db) return da > db
  }
  return false
}

/**
 * Query the latest GitHub release and compare it with the running version.
 * @param repo - `owner/name`; defaults to this project's repository.
 */
export async function checkForUpdate(repo: string = REPO): Promise<UpdateCheckResult> {
  const current = app.getVersion()
  const base = { current, latest: null, hasUpdate: false, assetName: null, assetUrl: null, size: null }
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'user-agent': 'DeepSeek-Harness-Desktop', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`)
    const release = await response.json() as {
      tag_name?: unknown
      assets?: Array<{ name?: unknown; browser_download_url?: unknown; size?: unknown }>
    }
    const tag = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : ''
    if (tag === '') return { ...base, status: 'ok' }
    const asset = (release.assets ?? []).find(
      entry => typeof entry.name === 'string' && /^DeepSeek-Harness-Setup-.*\.exe$/.test(entry.name),
    )
    return {
      status: 'ok',
      current,
      latest: tag,
      hasUpdate: isNewerVersion(tag, current),
      assetName: typeof asset?.name === 'string' ? asset.name : null,
      assetUrl: typeof asset?.browser_download_url === 'string' ? asset.browser_download_url : null,
      size: typeof asset?.size === 'number' ? asset.size : null,
    }
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError'
      ? '连接 GitHub 超时，请检查网络后重试。'
      : `检查更新失败：${error instanceof Error ? error.message : String(error)}`
    return { ...base, status: 'error', error: reason }
  }
}

/**
 * Download the installer asset to the system temp directory, reporting
 * progress as a percentage when the server sends a content length.
 * @param assetUrl - installer download URL (redirects are followed).
 * @param onProgress - progress callback, 0..1.
 * @returns the local installer path.
 */
export async function downloadUpdate(assetUrl: string, onProgress?: (fraction: number) => void): Promise<string> {
  const fileName = assetUrl.split('/').pop() ?? `DeepSeek-Harness-Setup-${app.getVersion()}.exe`
  const target = join(tmpdir(), fileName)
  if (!/\.exe$/i.test(fileName)) throw new Error('下载地址不是可执行的安装包。')
  const response = await fetch(assetUrl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(10 * 60_000),
  })
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length')) || 0
  let received = 0
  const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
  body.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (total > 0) onProgress?.(received / total)
  })
  await pipeline(body, createWriteStream(target))
  if (!existsSync(target)) throw new Error('安装包下载不完整。')
  return target
}

/**
 * Launch the downloaded installer detached and quit the app so the
 * installer can replace the running files.
 * @param installerPath - local installer path from {@link downloadUpdate}.
 */
export function installUpdate(installerPath: string): void {
  spawn(installerPath, [], { detached: true, stdio: 'ignore' }).unref()
  setTimeout(() => app.quit(), 500)
}
