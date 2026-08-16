/**
 * Preload bridge for the settings window: exposes the usage-statistics and
 * update-check APIs to the page over contextBridge. The page itself is a
 * sandboxed `data:` URL with no Node access, so this narrow surface is all
 * it can reach.
 * @module settings-preload
 */

import { contextBridge, ipcRenderer } from 'electron'

/** The exact channel names — shared vocabulary between this file and the page. */
const CHANNELS = {
  snapshot: 'usage:snapshot',
  updated: 'usage:updated',
  meta: 'usage:meta',
  openDataDir: 'usage:open-data-dir',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateProgress: 'update:progress',
} as const

contextBridge.exposeInMainWorld('usageAPI', {
  /** Fetch the aggregated view for one range (`7` | `30` | `'all'`). */
  getSnapshot: (range: 7 | 30 | 'all') => ipcRenderer.invoke(CHANNELS.snapshot, range),
  /** Subscribe to live counter updates (returns an unsubscribe). */
  onUpdated: (listener: () => void) => {
    const wrapped = (): void => listener()
    ipcRenderer.on(CHANNELS.updated, wrapped)
    return () => { ipcRenderer.removeListener(CHANNELS.updated, wrapped) }
  },
  /** Static facts about the store (file path). */
  getMeta: () => ipcRenderer.invoke(CHANNELS.meta),
  /** Reveal the store directory in the system file manager. */
  openDataDir: () => ipcRenderer.invoke(CHANNELS.openDataDir),
  /** Ask the main process whether a newer release exists. */
  checkUpdate: () => ipcRenderer.invoke(CHANNELS.updateCheck),
  /** Download the installer; progress arrives via {@link onUpdateProgress}. */
  downloadUpdate: (assetUrl: string) => ipcRenderer.invoke(CHANNELS.updateDownload, assetUrl),
  /** Launch the downloaded installer and quit the app. */
  installUpdate: (installerPath: string) => ipcRenderer.invoke(CHANNELS.updateInstall, installerPath),
  /** Subscribe to download progress (fraction 0..1); returns an unsubscribe. */
  onUpdateProgress: (listener: (fraction: number) => void) => {
    const wrapped = (_event: unknown, fraction: number): void => listener(fraction)
    ipcRenderer.on(CHANNELS.updateProgress, wrapped)
    return () => { ipcRenderer.removeListener(CHANNELS.updateProgress, wrapped) }
  },
})
