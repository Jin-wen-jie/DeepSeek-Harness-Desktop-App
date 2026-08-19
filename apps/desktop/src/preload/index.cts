// Sandboxed renderer preload. `sandbox: true` forces CommonJS loading, so this
// file must be `.cts` (compiled to `index.cjs`): Electron's sandboxed preloads
// cannot be ES modules. It exposes only the fixed renderer API; no ipcRenderer,
// filesystem, or arbitrary channels leak to the page.
import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopHostMessage } from '../shared/protocol.ts'
import type { DesktopRendererApi } from './contract.ts'

const api: DesktopRendererApi = {
  invoke: (id, method, payload) => ipcRenderer.invoke('dsh:invoke', { id, method, payload }),
  respond: (id, result) => ipcRenderer.invoke('dsh:respond', { id, result }),
  cancel: (id) => { ipcRenderer.send('dsh:cancel', id) },
  subscribe: (stream, listener) => {
    const handler = (_event: Electron.IpcRendererEvent, message: DesktopHostMessage): void => {
      if (message.type === 'event' && message.stream === stream) listener(message)
    }
    ipcRenderer.on('dsh:event', handler)
    return () => { ipcRenderer.removeListener('dsh:event', handler) }
  },
  getState: () => ipcRenderer.invoke('dsh:state'),
  onConnectionLost: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on('dsh:lost', handler)
    return () => { ipcRenderer.removeListener('dsh:lost', handler) }
  },
}

contextBridge.exposeInMainWorld('dshDesktop', api)
