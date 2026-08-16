/**
 * Electron entry: boots the DeepSeek Harness web server as a child process
 * and hosts the official web GUI in a native window. The whale icon, single
 * instance lock, window-state memory, an application menu with skills/plugins shortcuts, and a controlled
 * server lifecycle are the only additions over `dsh web` in a browser.
 * @module main
 */

import { app, BrowserWindow, dialog, Menu, shell } from 'electron'
import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { startHarnessServer, resolveDshBinPath, type HarnessExitInfo, type HarnessServer } from './harness.js'
import {
  resolveAgentsSkillsDir,
  resolveHomePatchFile,
  resolveDshHome,
  resolveProfileDir,
  resolveProfilePatchFile,
  resolveUserSkillsDir,
} from './dsh-paths.js'
import { startUsageTracking, type UsageController } from './usage-main.js'
import { registerSettingsIpc } from './settings-ipc.js'

const APP_ID = 'io.github.jin-wen-jie.deepseek-harness-desktop'
const HARNESS_PROJECT_URL = 'https://github.com/deepseek-ai/deepseek-harness'
const DESKTOP_PROJECT_URL = 'https://github.com/Jin-wen-jie/DeepSeek-Harness-Desktop-App'
const STARTUP_TIMEOUT_MS = 120_000
const HTTP_READY_TIMEOUT_MS = 30_000
const SMOKE = process.env.DSH_DESKTOP_SMOKE === '1'
const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`
const HOME_PATCH_TEMPLATE = `# Your home-level patch layer, applied after every profile patch layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

let mainWindow: BrowserWindow | null = null
let server: HarnessServer | null = null
let pendingServer: Promise<HarnessServer> | null = null
let usageController: UsageController | null = null
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
      // Injects the 使用统计 overlay into the harness GUI (bottom-left,
      // docked to its settings trigger). Sandboxed preload — CommonJS only.
      preload: join(app.getAppPath(), 'dist', 'gui-usage-preload.cjs'),
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

/**
 * Load the harness GUI with a timeout and retry. The dsh GUI boot can stall
 * once while the shared profile dependency set (~/.dsh/profiles/node_modules)
 * initializes — without this watchdog the window would sit on the loading
 * page forever with no recovery.
 * @param window - the main window (no-op when closed).
 * @param url - the ready harness origin.
 */
async function loadGui(window: BrowserWindow | null, url: string): Promise<void> {
  if (window === null) return
  const LOAD_TIMEOUT_MS = 20_000
  const MAX_ATTEMPTS = 3
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await withTimeout(window.loadURL(url), LOAD_TIMEOUT_MS, 'GUI load attempt ' + attempt + ' timed out after ' + LOAD_TIMEOUT_MS + ' ms')
      return
    } catch (error) {
      log('GUI load attempt ' + attempt + '/' + MAX_ATTEMPTS + ' failed: ' + String(error))
      if (attempt < MAX_ATTEMPTS) await sleep(1_500)
    }
  }
  throw new Error('GUI failed to load after ' + MAX_ATTEMPTS + ' attempts')
}

/** Settle a promise or reject with a timeout — a hung load must not pin the window. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * One unary workspace RPC against the harness origin, using the same
 * envelope the web client speaks (POST /api/<method>).
 * @param base - the ready harness origin.
 * @param method - the wire method name (workspace.*).
 * @param payload - the business request payload.
 * @returns the ok value of the response.
 */
async function workspaceRpc(base: string, method: string, payload: Record<string, unknown>): Promise<unknown> {
  const rpcId = `desktop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const response = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`)
  const envelope = await response.json() as { result?: { ok?: boolean; value?: unknown; error?: unknown } }
  const result = envelope.result
  if (result?.ok !== true) {
    throw new Error(`${method} rejected: ${JSON.stringify(result?.error ?? envelope)}`)
  }
  return result.value
}

/**
 * Ensure the pinned “任务” (Tasks) workspace exists at the bottom of the
 * sidebar: a real workspace over an app-owned directory, so sessions started
 * under it auto-account. Idempotent — workspace.create resolves the existing
 * record for the same canonical path.
 * @param url - the ready harness origin.
 */
async function ensureTasksWorkspace(url: string): Promise<void> {
  const tasksDir = join(dataDir(), 'tasks')
  mkdirSync(tasksDir, { recursive: true })
  const created = await workspaceRpc(url, 'workspace.create', { path: tasksDir }) as { workspace?: { workspaceId?: string } }
  const workspaceId = created?.workspace?.workspaceId
  if (workspaceId === undefined) throw new Error('workspace.create returned no workspace id')
  await workspaceRpc(url, 'workspace.rename', { workspaceId, title: '任务' })
  // Append to the end of the durable order (omitted anchor = append).
  await workspaceRpc(url, 'workspace.insertBefore', { workspaceId })
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
      // Best-effort: the pinned Tasks workspace is cosmetic, so a failure
      // must never block the GUI from loading.
      try {
        await ensureTasksWorkspace(running.url)
      } catch (error) {
        log('tasks workspace setup failed: ' + String(error))
      }
      await loadGui(mainWindow, running.url)
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

/**
 * Prepare and open a filesystem path, then surface any shell error.
 * @param path - absolute file or directory path to reveal.
 * @param prepare - synchronous step that creates missing directories/files.
 * @param title - user-facing name shown in error dialogs.
 */
async function revealPath(path: string, prepare: () => void, title: string): Promise<void> {
  try {
    prepare()
    const error = await shell.openPath(path)
    if (error !== '') {
      await dialog.showMessageBox({ type: 'error', title, message: `无法打开：${title}`, detail: error })
    }
  } catch (error) {
    await dialog.showMessageBox({ type: 'error', title, message: `无法打开：${title}`, detail: String(error) })
  }
}

/** Open the user-level dsh skills directory, creating it when absent. */
async function openUserSkillsDir(): Promise<void> {
  const path = resolveUserSkillsDir()
  await revealPath(path, () => mkdirSync(path, { recursive: true }), '用户技能目录')
}

/** Open the user-level AGENTS skills directory, creating it when absent. */
async function openAgentsSkillsDir(): Promise<void> {
  const path = resolveAgentsSkillsDir()
  await revealPath(path, () => mkdirSync(path, { recursive: true }), 'AGENTS 技能目录')
}

/** Open the booted web profile directory, creating it when absent. */
async function openProfileDir(): Promise<void> {
  const path = resolveProfileDir()
  await revealPath(path, () => mkdirSync(path, { recursive: true }), '插件目录')
}

/** Open the web profile's cordis.patch.yml in the default editor, creating it when absent. */
async function openProfilePatchFile(): Promise<void> {
  const path = resolveProfilePatchFile()
  await revealPath(path, () => {
    mkdirSync(dirname(path), { recursive: true })
    if (!existsSync(path)) writeFileSync(path, PROFILE_PATCH_TEMPLATE)
  }, '插件配置文件')
}

/** Open the home-level cordis.patch.yml applied to every profile. */
async function openHomePatchFile(): Promise<void> {
  const path = resolveHomePatchFile()
  await revealPath(path, () => {
    mkdirSync(dirname(path), { recursive: true })
    if (!existsSync(path)) writeFileSync(path, HOME_PATCH_TEMPLATE)
  }, '全局插件配置文件')
}

/** Explain where skills and plugins live, then offer the two most common actions. */
async function showSkillsPluginsHelp(): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: '技能与插件',
    message: 'DeepSeek Harness 通过目录和补丁文件加载技能与插件',
    detail: [
      '技能（Skills）',
      `  用户级（dsh）：${resolveUserSkillsDir()}`,
      `  用户级（AGENTS）：${resolveAgentsSkillsDir()}`,
      '  项目级：<项目根>/.dsh/skills 或 <项目根>/.agents/skills',
      '  形式：目录 <name>/SKILL.md，或单文件 <name>.md',
      '',
      '插件（Plugins）',
      `  数据根目录：${resolveDshHome()}`,
      `  补丁文件：${resolveProfilePatchFile()}`,
        `  全局补丁文件：${resolveHomePatchFile()}`,
      `  插件目录：${resolveProfileDir()}`,
      '  本机安装 npm 插件包：dsh plugin --profile web add <package>',
      '',
      '修改后请使用“重启服务”菜单加载新配置。',
    ].join('\n'),
    buttons: ['打开用户技能目录', '编辑插件配置', '关闭'],
    defaultId: 0,
    cancelId: 2,
  })
  if (response === 0) await openUserSkillsDir()
  if (response === 1) await openProfilePatchFile()
}

/** Restart the running harness after skill or plugin configuration changed. */
async function restartHarness(): Promise<void> {
  if (quitting) return
  if (pendingServer !== null) {
    await dialog.showMessageBox({ type: 'warning', title: '重启服务', message: '本地服务正在启动中，请稍候再试。' })
    return
  }
  if (server === null) {
    const detail = pendingServer === null
      ? '请等待本地服务启动完成后再试。'
      : '本地服务正在启动中，请稍候再试。'
    await dialog.showMessageBox({ type: 'warning', title: '重启服务', message: '服务尚未启动，无法重启。', detail })
    return
  }
  const running = server
  server = null
  await running.stop()
  await launch()
}

/** Application menu: standard roles, skills/plugins shortcuts, and project links. */
function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
      {
        label: '技能与插件',
        submenu: [
          { label: '技能与插件说明', click: () => void showSkillsPluginsHelp() },
          { type: 'separator' },
          { label: '打开用户技能目录', click: () => void openUserSkillsDir() },
          { label: '打开 AGENTS 技能目录', click: () => void openAgentsSkillsDir() },
          { type: 'separator' },
          { label: '编辑插件配置', click: () => void openProfilePatchFile() },
            { label: '编辑全局插件配置', click: () => void openHomePatchFile() },
          { label: '打开插件目录', click: () => void openProfileDir() },
          { type: 'separator' },
          { label: '重启服务以加载技能/插件', click: () => void restartHarness() },
        ],
      },
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
    const probe = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, preload: join(app.getAppPath(), 'dist', 'gui-usage-preload.cjs') } })
    try {
      await probe.loadURL(server.url)
      const hasBoot: boolean = await probe.webContents.executeJavaScript('Boolean(window.__DSH_BOOT__)')
      if (!hasBoot) throw new Error('window.__DSH_BOOT__ missing after page load')
      await sleep(15_000)
      const textLength: number = await probe.webContents.executeJavaScript('document.body ? document.body.innerText.length : 0')
      if (textLength < 50) throw new Error(`UI did not render (body text length ${textLength})`)
      // The preload must inject the usage overlay and its charts render.
      const overlay = await probe.webContents.executeJavaScript(`
        (function () {
          var root = document.getElementById('dsh-desktop-usage-root')
          if (!root) return 'NO_ROOT'
          var entry = root.querySelector('button')
          if (!entry) return 'NO_ENTRY'
          entry.click()
          return new Promise(function (resolve) {
            setTimeout(function () {
              resolve({
                barBars: root.querySelectorAll('svg rect').length,
                donutCircles: root.querySelectorAll('svg circle').length,
                hasUpdateText: root.textContent.indexOf('使用统计') >= 0,
              })
            }, 1500)
          })
        })()
      `)
      if (typeof overlay === 'string' || (overlay as { barBars?: number }).barBars === undefined || (overlay as { barBars: number }).barBars === 0) {
        throw new Error('usage overlay did not render: ' + JSON.stringify(overlay))
      }
      console.log('DSH_DESKTOP_SMOKE usage overlay ok', JSON.stringify(overlay))
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
    // Usage tracking runs for the whole app lifetime; the observer is
    // skipped in headless smoke mode so probe traffic never touches the
    // real store. Token accounting is scanned from the harness session logs.
    usageController = startUsageTracking({
      dataDir: dataDir(),
      sessionsDir: join(resolveDshHome(), 'sessions'),
      observe: !SMOKE,
    })
    // The usage overlay in the harness GUI speaks over this IPC surface.
    registerSettingsIpc(usageController, () => mainWindow)
    buildMenu()
    if (SMOKE) void runSmoke()
    else void launch()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && !SMOKE && !quitting) void launch()
  })
  app.on('window-all-closed', () => {
    // In smoke mode runSmoke owns the lifecycle; quitting here races the
    // DSH_DESKTOP_SMOKE_OK report and swallows it.
    if (process.platform !== 'darwin' && !SMOKE) app.quit()
  })

  app.on('before-quit', () => { quitting = true })

  let serverStopped = false
  app.on('will-quit', (event) => {
    usageController?.flush()
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
