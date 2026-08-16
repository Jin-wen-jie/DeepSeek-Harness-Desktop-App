/**
 * Electron entry: boots the DeepSeek Harness web server as a child process
 * and hosts the official web GUI in a native window. The whale icon, single
 * instance lock, window-state memory, an application menu, and a controlled
 * server lifecycle are the only additions over `dsh web` in a browser.
 * @module main
 */

import { app, BrowserWindow, dialog, Menu, shell } from 'electron'
import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from 'electron'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { startHarnessServer, resolveDshBinPath, type HarnessExitInfo, type HarnessServer } from './harness.js'

const APP_ID = 'io.github.jin-wen-jie.deepseek-harness-desktop'
const HARNESS_PROJECT_URL = 'https://github.com/deepseek-ai/deepseek-harness'
const DESKTOP_PROJECT_URL = 'https://github.com/Jin-wen-jie/DeepSeek-Harness-Desktop-App'
const STARTUP_TIMEOUT_MS = 120_000
const HTTP_READY_TIMEOUT_MS = 30_000
const SMOKE = process.env.DSH_DESKTOP_SMOKE === '1'

let mainWindow: BrowserWindow | null = null
let server: HarnessServer | null = null
let pendingServer: Promise<HarnessServer> | null = null
let quitting = false

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** App data directory for this install. */
function dataDir(): string {
  const dir = join(app.getPath('userData'))
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Append one timestamped line to the session's server log. */
function log(line: string): void {
  const text = `[${new Date().toISOString()}] ${line}`
  console.log(text)
  try {
    appendFileSync(join(dataDir(), 'server.log'), text + '\n')
  } catch {
    // Logging must never take the app down.
  }
}

/** Inline first paint: whale, app name, and a spinner while the server boots. */
function loadingPage(): string {
  const html = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>DeepSeek Harness</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center;
         gap: 18px; background: #0d1117; color: #e6edf3; font-family: system-ui, "Segoe UI", sans-serif; }
  .whale { font-size: 88px; line-height: 1; filter: drop-shadow(0 8px 24px rgba(77, 166, 255, .35)); }
  h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: .3px; }
  p { margin: 0; color: #8b949e; font-size: 14px; }
  .spinner { width: 28px; height: 28px; border-radius: 50%; border: 3px solid #30363d; border-top-color: #4da6ff;
             animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style></head>
<body>
  <div class="whale">🐋</div>
  <h1>DeepSeek Harness</h1>
  <p>正在启动本地服务…</p>
  <div class="spinner"></div>
</body></html>`
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

/** Inline error paint shown behind the failure dialog. */
function errorPage(message: string): string {
  const safe = message.replace(/[<>&]/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[char] ?? char)
  const html = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>DeepSeek Harness</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center;
         gap: 16px; background: #0d1117; color: #e6edf3; font-family: system-ui, "Segoe UI", sans-serif; padding: 32px; }
  h1 { margin: 0; font-size: 20px; }
  pre { margin: 0; max-width: 640px; color: #f85149; white-space: pre-wrap; font-size: 12px; }
</style></head>
<body>
  <h1>本地服务启动失败</h1>
  <pre>${safe}</pre>
</body></html>`
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

/** The window icon file for this platform. */
function iconPath(): string {
  const name = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  return join(app.getAppPath(), 'assets', name)
}

interface WindowState { x?: number; y?: number; width: number; height: number; maximized: boolean }

function windowStatePath(): string {
  return join(dataDir(), 'window-state.json')
}

/** Read the saved window bounds, falling back to a sensible default. */
function readWindowState(): WindowState {
  const fallback: WindowState = { width: 1360, height: 860, maximized: false }
  try {
    const raw = JSON.parse(readFileSync(windowStatePath(), 'utf8')) as Partial<WindowState>
    if (typeof raw.width !== 'number' || typeof raw.height !== 'number') return fallback
    const state: WindowState = {
      width: Math.max(720, Math.round(raw.width)),
      height: Math.max(480, Math.round(raw.height)),
      maximized: raw.maximized === true,
    }
    if (typeof raw.x === 'number' && typeof raw.y === 'number') {
      state.x = Math.round(raw.x)
      state.y = Math.round(raw.y)
    }
    return state
  } catch {
    return fallback
  }
}

/** Persist the window bounds on close. */
function writeWindowState(window: BrowserWindow): void {
  try {
    const state: WindowState = { ...window.getNormalBounds(), maximized: window.isMaximized() }
    writeFileSync(windowStatePath(), JSON.stringify(state, null, 2))
  } catch {
    // Best-effort only.
  }
}

/** True for URLs this window may host: inline pages or the harness origin. */
function isInternalUrl(url: string): boolean {
  return url.startsWith('data:') || url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')
}

/** Create the main window showing the given inline page, then hand off to the server URL. */
function createWindow(initialPage: string): BrowserWindow {
  const state = readWindowState()
  const options: BrowserWindowConstructorOptions = {
    width: state.width,
    height: state.height,
    minWidth: 720,
    minHeight: 480,
    show: false,
    icon: iconPath(),
    backgroundColor: '#0d1117',
    title: 'DeepSeek Harness',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  }
  if (state.x !== undefined && state.y !== undefined) {
    options.x = state.x
    options.y = state.y
  }
  mainWindow = new BrowserWindow(options)
  if (state.maximized) mainWindow.maximize()
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', () => { if (mainWindow !== null) writeWindowState(mainWindow) })
  mainWindow.on('closed', () => { mainWindow = null })

  // New windows are denied; external links open in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isInternalUrl(url)) {
      event.preventDefault()
      if (/^https?:/.test(url)) void shell.openExternal(url)
    }
  })

  void mainWindow.loadURL(initialPage)
  return mainWindow
}

/** Poll the harness origin until it answers HTTP. */
async function waitForHttp(url: string, timeoutMs = HTTP_READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = undefined
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(4_000) })
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await sleep(500)
  }
  throw new Error(`Server did not answer HTTP at ${url}: ${String(lastError)}`)
}

/** Offer a restart after a failed start or an unexpected server exit. */
function offerRecovery(kind: 'startup' | 'crash', detail: string): void {
  const message = kind === 'startup' ? 'DeepSeek Harness 本地服务启动失败' : 'DeepSeek Harness 本地服务已退出'
  void dialog.showMessageBox({
    type: 'error',
    title: 'DeepSeek Harness',
    message,
    detail,
    buttons: ['重新启动', '退出'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) void launch()
    else app.quit()
  })
}

/** Boot (or reuse) the server and point the window at it. */
async function launch(): Promise<void> {
  if (quitting) return
  if (server === null) {
    if (mainWindow === null) createWindow(loadingPage())
    else void mainWindow.loadURL(loadingPage())
    const started = startHarnessServer({
      execPath: process.execPath,
      binPath: resolveDshBinPath(),
      onLine: log,
      onExit: (info: HarnessExitInfo) => {
        if (!quitting) {
          server = null
          if (mainWindow !== null) void mainWindow.loadURL(errorPage(`后端进程已退出（code ${String(info.code)}）。`))
          offerRecovery('crash', `后端进程已退出（code ${String(info.code)}）。请查看日志：${join(dataDir(), 'server.log')}`)
        }
      },
      timeoutMs: STARTUP_TIMEOUT_MS,
    })
    pendingServer = started
    try {
      const running = await started
      server = running
      log(`server ready: ${running.url}`)
      await waitForHttp(running.url)
      await mainWindow?.loadURL(running.url)
    } catch (error) {
      server = null
      const detail = error instanceof Error ? error.message : String(error)
      log(`startup failed: ${detail}`)
      if (mainWindow !== null) void mainWindow.loadURL(errorPage(detail))
      offerRecovery('startup', detail + `\n\n日志：${join(dataDir(), 'server.log')}`)
    } finally {
      pendingServer = null
    }
  } else if (mainWindow !== null) {
    void mainWindow.loadURL(server.url)
  }
}

/** Version line for the About dialog. */
function harnessVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    const manifest = require('@deepseek-ai/dsh/package.json') as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Application menu: standard roles plus project links. */
function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'DeepSeek Harness 项目主页', click: () => void shell.openExternal(HARNESS_PROJECT_URL) },
        { label: '桌面端项目主页（GitHub）', click: () => void shell.openExternal(DESKTOP_PROJECT_URL) },
        { type: 'separator' },
        { label: '关于 DeepSeek Harness', click: () => void showAbout() },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function showAbout(): void {
  void dialog.showMessageBox({
    type: 'info',
    title: '关于 DeepSeek Harness',
    message: 'DeepSeek Harness 桌面端',
    detail: [
      `桌面端版本：${app.getVersion()}`,
      `Harness CLI：${harnessVersion()}`,
      `Electron：${process.versions.electron}  ·  Node：${process.versions.node}  ·  Chromium：${process.versions.chrome}`,
      '',
      '非官方社区外壳。鲸鱼标志归 DeepSeek 所有。',
    ].join('\n'),
  })
}

/** Headless end-to-end smoke: server up, boot manifest injected, UI painted. */
async function runSmoke(): Promise<void> {
  const timeout = setTimeout(() => { console.error('DSH_DESKTOP_SMOKE_FAIL timeout'); app.exit(1) }, 180_000)
  try {
    server = await startHarnessServer({
      execPath: process.execPath,
      binPath: resolveDshBinPath(),
      onLine: line => console.log('[dsh]', line),
      timeoutMs: STARTUP_TIMEOUT_MS,
    })
    const probe = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
    try {
      await probe.loadURL(server.url)
      const hasBoot: boolean = await probe.webContents.executeJavaScript('Boolean(window.__DSH_BOOT__)')
      if (!hasBoot) throw new Error('window.__DSH_BOOT__ missing after page load')
      await sleep(15_000)
      const textLength: number = await probe.webContents.executeJavaScript('document.body ? document.body.innerText.length : 0')
      if (textLength < 50) throw new Error(`UI did not render (body text length ${textLength})`)
    } finally {
      probe.destroy()
    }
    console.log(`DSH_DESKTOP_SMOKE_OK url=${server.url}`)
    clearTimeout(timeout)
    await server.stop()
    app.exit(0)
  } catch (error) {
    console.error('DSH_DESKTOP_SMOKE_FAIL', error)
    clearTimeout(timeout)
    if (server !== null) await server.stop().catch(() => undefined)
    app.exit(1)
  }
}

// ── lifecycle ────────────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID)

  void app.whenReady().then(() => {
    buildMenu()
    if (SMOKE) void runSmoke()
    else void launch()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && !SMOKE && !quitting) void launch()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => { quitting = true })

  let serverStopped = false
  app.on('will-quit', (event) => {
    if (serverStopped) return
    event.preventDefault()
    serverStopped = true
    const forceTimer = setTimeout(() => app.exit(0), 8_000)
    forceTimer.unref()
    void (async () => {
      let target = server
      if (target === null && pendingServer !== null) target = await pendingServer.catch(() => null)
      await target?.stop()
      app.quit()
    })()
  })
}
