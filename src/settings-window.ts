/**
 * The settings window: the app's own UI pane (the first step away from a
 * pure harness shell). It hosts the 使用统计 page, serves snapshots from the
 * usage controller over IPC, and pushes live counter updates while open.
 * @module settings-window
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { SETTINGS_PAGE_URL } from './settings-page.js'
import type { UsageController } from './usage-main.js'
import type { UsageRange } from './usage.js'
import { checkForUpdate, downloadUpdate, installUpdate } from './updater.js'

/** Open settings windows, reused across menu clicks. */
const openWindows = new Set<BrowserWindow>()

/** IPC handlers are process-wide; register exactly once. */
let ipcRegistered = false

/** Normalize an IPC range argument (string) to a known `UsageRange`. */
function asRange(value: unknown): UsageRange {
  if (value === 'all') return 'all'
  if (value === '30') return 30
  return 7
}

/** Register the settings-window IPC surface for a usage controller. */
function registerUsageIpc(controller: UsageController): void {
  if (ipcRegistered) return
  ipcRegistered = true
  ipcMain.handle('usage:snapshot', (_event, range: unknown) => controller.snapshot(asRange(range)))
  ipcMain.handle('usage:meta', () => ({ filePath: controller.filePath }))
  ipcMain.handle('usage:open-data-dir', () => controller.openDataDir())
  ipcMain.handle('update:check', () => checkForUpdate())
  ipcMain.handle('update:download', (_event, assetUrl: unknown) => {
    if (typeof assetUrl !== 'string') throw new Error('无效的下载地址。')
    return downloadUpdate(assetUrl, (fraction) => {
      for (const window of openWindows) {
        if (!window.isDestroyed()) window.webContents.send('update:progress', fraction)
      }
    })
  })
  ipcMain.handle('update:install', (_event, installerPath: unknown) => {
    if (typeof installerPath !== 'string') throw new Error('无效的安装包路径。')
    installUpdate(installerPath)
    return { ok: true }
  })

  controller.subscribe(() => {
    for (const window of openWindows) {
      if (!window.isDestroyed()) window.webContents.send('usage:updated')
    }
  })
}

/**
 * Open (or focus) the settings window.
 * @param options - usage controller, the app icon path, the parent window
 *   (the harness GUI) when present, and whether the window may show itself
 *   (`false` for headless smoke verification).
 * @returns the settings window.
 */
export function openSettingsWindow(options: { controller: UsageController; iconPath: string; parent: BrowserWindow | null; visible?: boolean }): BrowserWindow {
  for (const existing of openWindows) {
    if (!existing.isDestroyed()) {
      existing.show()
      existing.focus()
      return existing
    }
  }

  registerUsageIpc(options.controller)

  const window = new BrowserWindow({
    width: 1160,
    height: 780,
    minWidth: 940,
    minHeight: 620,
    parent: options.parent !== null && !options.parent.isDestroyed() ? options.parent : undefined,
    show: false,
    autoHideMenuBar: true,
    icon: options.iconPath,
    backgroundColor: '#0d1117',
    title: '设置 — DeepSeek Harness',
    webPreferences: {
      // Sandboxed preloads are CommonJS-only, hence the .cjs artifact that
      // tsc emits for the .cts source.
      preload: join(app.getAppPath(), 'dist', 'settings-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  window.once('ready-to-show', () => { if (options.visible !== false) window.show() })
  window.on('closed', () => { openWindows.delete(window) })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  openWindows.add(window)
  void window.loadURL(SETTINGS_PAGE_URL)
  return window
}
