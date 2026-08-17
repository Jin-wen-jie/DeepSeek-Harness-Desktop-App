/**
 * In-app update flow, powered by electron-updater against the GitHub
 * release feed.
 *
 * With the NSIS oneClick installer, updates are fully silent: the app
 * checks GitHub for a newer version (automatically on startup, or on
 * demand), downloads the new installer in the background, and installs it
 * without any wizard — on quit when a download finished, or immediately
 * through the 立即安装 button. The app relaunches itself after install.
 *
 * In development (unpackaged) electron-updater has no feed, so the check
 * surfaces a friendly error instead of failing hard.
 * @module updater
 */

import { app } from 'electron'
// electron-updater exports `autoUpdater` via a lazy defineProperty getter,
// which ESM named-import analysis cannot see — default-import and destructure.
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

/** Outcome of a version check. */
export interface UpdateCheckResult {
  status: 'ok' | 'error'
  /** The running app's version. */
  current: string
  /** The newest published version, or null when none was found. */
  latest: string | null
  /** Whether a newer version is available. */
  hasUpdate: boolean
  /** Human-readable failure reason when `status` is `error`. */
  error?: string
}

let initialized = false
let progressListener: ((fraction: number) => void) | null = null

/** Wire electron-updater once; later calls only refresh the progress hook. */
function ensureUpdater(onProgress?: (fraction: number) => void): void {
  progressListener = onProgress ?? null
  if (initialized) return
  initialized = true
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('download-progress', (progress) => {
    if (progressListener !== null) progressListener(progress.percent / 100)
  })
  autoUpdater.on('error', (error) => {
    // Errors surface through the check/download promises too; log for the
    // server log rather than crashing.
    console.error('auto-update error:', error)
  })
}

/** Whether the running app can reach an update feed. */
function updatable(): boolean {
  return app.isPackaged
}

/**
 * Check for a newer release and (with `autoDownload`) start fetching it.
 * @param onProgress - optional download-progress hook (0..1).
 * @returns the check outcome; `status: 'error'` with a readable reason
 *   when the feed is unavailable (dev mode, no network, …).
 */
export async function checkForUpdate(onProgress?: (fraction: number) => void): Promise<UpdateCheckResult> {
  const current = app.getVersion()
  if (!updatable()) {
    return { status: 'error', current, latest: null, hasUpdate: false, error: '开发模式下无法检查更新，请安装正式版后使用。' }
  }
  try {
    ensureUpdater(onProgress)
    const result = await autoUpdater.checkForUpdates()
    const latest = result?.updateInfo?.version ?? null
    return { status: 'ok', current, latest, hasUpdate: latest !== null && latest !== current }
  } catch (error) {
    const reason = error instanceof Error
      ? (error.message.includes('net::') || error.message.includes('ECONN') || error.message.includes('fetch')
        ? '无法连接更新服务器，请检查网络后重试。'
        : error.message)
      : String(error)
    return { status: 'error', current, latest: null, hasUpdate: false, error: reason }
  }
}

/**
 * Download the pending update (started by {@link checkForUpdate}) and
 * resolve once it is ready on disk.
 * @param onProgress - optional download-progress hook (0..1).
 * @returns a short confirmation message once the update is ready.
 */
export async function downloadUpdate(onProgress?: (fraction: number) => void): Promise<string> {
  ensureUpdater(onProgress)
  // Idempotent: resolves immediately when the update is already downloaded.
  await autoUpdater.downloadUpdate()
  return '更新已就绪'
}

/**
 * Install the downloaded update: quit the app, run the oneClick installer
 * silently, and relaunch the new version.
 */
export function installUpdate(): void {
  ensureUpdater()
  autoUpdater.quitAndInstall()
}

/** Check for updates quietly at startup (packaged app only). */
export function startAutoCheck(): void {
  if (!updatable()) return
  void checkForUpdate().then((result) => {
    console.log(`auto-update check: ${result.status}${result.hasUpdate ? `, newer ${result.latest} available` : ''}`)
  }).catch(() => undefined)
}
