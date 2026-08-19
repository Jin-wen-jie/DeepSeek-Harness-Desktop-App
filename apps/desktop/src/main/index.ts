import { app, BrowserWindow, ipcMain, protocol, shell } from 'electron'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HostSupervisor } from './host-supervisor.ts'
import { validateDesktopHostRequest } from '../shared/protocol.ts'

// Privileged read-only scheme that backs the renderer page and plugin bundles
// (an ESM + same-origin-script home with webSecurity on; `file://` module
// loading was the Phase 2 fallback and is not relied on here).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

const root = dirname(fileURLToPath(import.meta.url))
const rendererRoot = resolve(root, '../renderer')
const renderer = resolve(rendererRoot, 'index.html')
// Sandboxed preloads must be CommonJS; the preload source is .cts -> index.cjs.
const preload = resolve(root, '../preload/index.cjs')
const host = resolve(root, '../host/bin.js')

// Build-generated pkg name -> absolute lib/client.js path (pnpm does not link
// every roster package into apps/desktop, so main cannot require.resolve them).
let bundleLocations: Record<string, string> | undefined
function clientBundleLocations(): Record<string, string> {
  if (bundleLocations === undefined) {
    try {
      const raw = readFileSync(resolve(rendererRoot, 'bundle-locations.json'), 'utf8')
      bundleLocations = JSON.parse(raw) as Record<string, string>
    } catch {
      bundleLocations = {}
    }
  }
  return bundleLocations
}

/** Resolve one client plugin's bundle via its package `./client` export. */
function resolveClientBundle(id: string): string | undefined {
  const located = clientBundleLocations()[id]
  if (located !== undefined) return located
  try {
    return createRequire(import.meta.url).resolve(`${id}/client`)
  } catch {
    return undefined
  }
}

function contentTypeFor(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8'
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript; charset=utf-8'
  if (path.endsWith('.css')) return 'text/css; charset=utf-8'
  if (path.endsWith('.json') || path.endsWith('.map')) return 'application/json; charset=utf-8'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.png')) return 'image/png'
  return 'application/octet-stream'
}

/** Serve the desktop renderer page and client plugin bundles under app://desktop/... */
function installAppProtocol(): void {
  const handlePath = (pathname: string): { file: string; contentType: string } | undefined => {
    if (pathname === '/renderer/index.html') {
      return { file: renderer, contentType: contentTypeFor('x.html') }
    }
    if (pathname.startsWith('/renderer/')) {
      // index.html, the esbuild bundle (+ map), the emitted CSS, and any font
      // assets — everything the read-only page needs, same-origin under app://.
      const name = pathname.slice('/renderer/'.length)
      return { file: resolve(rendererRoot, name), contentType: contentTypeFor(name) }
    }
    const bundleMatch = /^\/bundle\/([^/]+)\/client\.js$/.exec(pathname)
    if (bundleMatch !== null) {
      const id = decodeURIComponent(bundleMatch[1] ?? '')
      const file = resolveClientBundle(id)
      if (file !== undefined) return { file, contentType: contentTypeFor('x.js') }
    }
    return undefined
  }
  protocol.handle('app', (request) => {
    const url = new URL(request.url)
    if (url.host !== 'desktop') return new Response('not found', { status: 404 })
    const hit = handlePath(url.pathname)
    if (hit === undefined) return new Response('not found', { status: 404 })
    try {
      return new Response(readFileSync(hit.file), { headers: { 'content-type': hit.contentType } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

let windowRef: BrowserWindow | undefined
let supervisor: HostSupervisor | undefined

async function createWindow(): Promise<void> {
  supervisor = new HostSupervisor({
    command: process.execPath,
    args: [host],
    // A full dsh-base + desktop profile boot takes a while; do not call the
    // window open a timeout before the Host finishes composing.
    startupTimeoutMs: 45000,
    shutdownTimeoutMs: 8000,
  })
  supervisor.on('message', (message) => {
    if (message.type === 'event') windowRef?.webContents.send('dsh:event', message)
  })
  supervisor.on('error', (error) => { console.error(`[desktop-host] ${error.message}`) })
  supervisor.on('state', (state) => {
    // A lost/stopped Host must unstick the renderer's reconnecting UI.
    if (state === 'crashed' || state === 'stopped') windowRef?.webContents.send('dsh:lost')
  })
  await supervisor.start()
  windowRef = new BrowserWindow({
    minWidth: 960,
    minHeight: 640,
    title: 'Deepseek Harness',
    webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  })
  windowRef.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'https:') void shell.openExternal(url)
    } catch { /* malformed external URLs are refused */ }
    return { action: 'deny' }
  })
  windowRef.on('closed', () => { windowRef = undefined })
  windowRef.webContents.on('console-message', (event) => {
    const message = (event as { message?: unknown }).message
    console.error(`[desktop-renderer] ${String(message)}`)
  })
  await windowRef.loadURL('app://desktop/renderer/index.html')
  if (process.env.DSH_DESKTOP_CAPTURE !== undefined) {
    // Dev diagnostic: after the UI has a moment to settle, capture the window
    // to the given path (DSH_DESKTOP_CAPTURE_EXIT=1 to quit afterwards).
    const target = process.env.DSH_DESKTOP_CAPTURE
    const waitMs = Number(process.env.DSH_DESKTOP_CAPTURE_WAIT ?? '15000')
    setTimeout(() => {
      void (async () => {
        try {
          const diag = await windowRef?.webContents.executeJavaScript(
            'JSON.stringify({ boot: typeof window.__DSH_BOOT__, loader: typeof window.__ModuleLoader__, modules: typeof window.__DSH_MODULES__, rootChildren: document.getElementById(\'root\')?.childElementCount ?? -1, text: document.body.innerText.slice(0, 300) })',
          )
          console.log(`[desktop] renderer diag: ${diag}`)
        } catch (error) {
          console.error('[desktop] renderer diag failed:', error)
        }
        try {
          const image = await windowRef?.webContents.capturePage()
          if (image !== undefined && target !== undefined) {
            const { writeFileSync } = await import('node:fs')
            writeFileSync(target, image.toPNG())
            console.log(`[desktop] capture saved to ${target}`)
          }
        } catch (error) {
          console.error('[desktop] capture failed:', error)
        }
        if (process.env.DSH_DESKTOP_CAPTURE_EXIT === '1' && supervisor !== undefined) {
          await shutdown()
          app.exit(0)
        }
      })()
    }, waitMs)
  }
}

function registerIpc(): void {
  ipcMain.handle('dsh:invoke', async (_event, raw: unknown) => {
    const request = validateDesktopHostRequest({ version: 1, type: 'invoke', ...(raw as object) })
    if (request.type !== 'invoke') throw new Error('desktop IPC invoke request is invalid')
    if (supervisor === undefined) throw new Error('desktop host is not available')
    return supervisor.invoke(request.id, request.method, request.payload)
  })
  ipcMain.handle('dsh:respond', async (_event, raw: unknown) => {
    const request = validateDesktopHostRequest({ version: 1, type: 'respond', ...(raw as object) })
    if (request.type !== 'respond') throw new Error('desktop IPC respond request is invalid')
    if (supervisor === undefined) throw new Error('desktop host is not available')
    return supervisor.respond(request.id, request.result)
  })
  ipcMain.on('dsh:cancel', (_event, id: unknown) => {
    if (typeof id === 'string') supervisor?.cancel(id)
  })
  ipcMain.handle('dsh:state', () => supervisor?.state ?? 'idle')
}

async function shutdown(): Promise<void> {
  await supervisor?.stop()
  supervisor = undefined
}

const locked = app.requestSingleInstanceLock()
if (!locked) {
  app.quit()
} else {
  app.on('second-instance', () => { windowRef?.show(); windowRef?.focus() })
  app.whenReady().then(async () => {
    installAppProtocol()
    registerIpc()
    await createWindow()
  }).catch((error) => {
    console.error(error)
    app.exit(1)
  })
  app.on('before-quit', (event) => {
    if (supervisor === undefined) return
    event.preventDefault()
    void shutdown().finally(() => { app.exit(0) })
  })
}
