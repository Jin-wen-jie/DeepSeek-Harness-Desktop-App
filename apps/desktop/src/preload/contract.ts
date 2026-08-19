import type { DesktopHostMessage } from '../shared/protocol.ts'

export interface DesktopRendererApi {
  invoke(id: string, method: string, payload: unknown): Promise<unknown>
  respond(id: string, result: unknown): Promise<unknown>
  cancel(id: string): void
  subscribe(stream: 'mux' | 'host', listener: (message: Extract<DesktopHostMessage, { type: 'event' }>) => void): () => void
  /** Subscribe to Host loss/stop so the client carrier can reconnect (returns an unsubscribe). */
  onConnectionLost(listener: () => void): () => void
  getState(): Promise<string>
}

declare global {
  interface Window { dshDesktop: DesktopRendererApi }
}
