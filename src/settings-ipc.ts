/**
 * Main-process IPC surface for the usage overlay injected into the harness
 * GUI. The GUI pane is the app's own preload-rendered overlay, so these
 * handlers and pushes target the main window's webContents rather than a
 * separate settings window.
 * @module settings-ipc
 */

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { UsageController } from './usage-main.js'
import type { UsageRange } from './usage.js'
import { checkForUpdate, downloadUpdate, installUpdate } from './updater.js'

/** Normalize an IPC range argument (string) to a known `UsageRange`. */
function asRange(value: unknown): UsageRange {
  if (value === 'all') return 'all'
  if (value === '30') return 30
  return 7
}

/** Process-wide registration guard — handlers must be installed exactly once. */
let registered = false

/**
 * Register the IPC channels the usage overlay speaks, wiring updates and
 * download progress to a single webContents supplied by the caller.
 * @param controller - the running usage controller.
 * @param getWindow - resolves the window whose contents should receive
 *   live-update events (the harness GUI's main window).
 */
export function registerSettingsIpc(controller: UsageController, getWindow: () => BrowserWindow | null): void {
  if (registered) return
  registered = true

  ipcMain.handle('usage:snapshot', (_event, range: unknown) => controller.snapshot(asRange(range)))
  ipcMain.handle('usage:meta', () => ({ filePath: controller.filePath }))
  ipcMain.handle('usage:open-data-dir', () => controller.openDataDir())
  const sendProgress = (fraction: number): void => {
    getWindow()?.webContents.send('update:progress', fraction)
  }
  ipcMain.handle('update:check', () => checkForUpdate(sendProgress))
  ipcMain.handle('update:download', () => downloadUpdate(sendProgress))
  ipcMain.handle('update:install', () => {
    installUpdate()
    return { ok: true }
  })

  controller.subscribe(() => {
    getWindow()?.webContents.send('usage:updated')
  })
}
