import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HostSupervisor } from '../src/main/host-supervisor.ts'

const desktopRoot = fileURLToPath(new URL('..', import.meta.url))
const hostSource = join(desktopRoot, 'src/host/bin.ts')

function supervisor(): HostSupervisor {
  return new HostSupervisor({
    command: process.execPath,
    // Keep the real-profile readiness window aligned with the desktop Main
    // process, whose cold start exceeds the generic supervisor default.
    args: ['--import', 'tsx/esm', hostSource],
    startupTimeoutMs: 45000,
    shutdownTimeoutMs: 5000,
  })
}

describe('desktop HostSupervisor', () => {
  it('boots the real desktop profile: settings registration, host.describe, subscription, shutdown', async () => {
    const host = supervisor()
    host.on('error', (error) => { throw error })
    await expect(host.start()).resolves.toEqual([])
    const settings = await host.invoke('settings-onboarding', 'settings.mutate', {
      ns: 'ui-onboarding',
      ops: [{ op: 'set', path: ['welcomeNoticeVersion'], value: '2026-08-13.1' }],
    }) as { ok: boolean; error?: { code: string } }
    expect(settings.ok).toBe(true)
    const response = await host.invoke('d1', 'host.describe', {}) as {
      ok: boolean
      value?: { version: string; cwd: string; attachedSessions: number }
      error?: { code: string }
    }
    expect(response.ok).toBe(true)
    if (response.ok) {
      expect(response.value?.version).toEqual(expect.any(String))
      expect(response.value?.cwd).toEqual(expect.any(String))
      expect(response.value?.attachedSessions).toEqual(expect.any(Number))
    }
    host.subscribe('mux')
    await new Promise(resolve => setTimeout(resolve, 200))
    await host.stop()
    expect(host.state).toBe('stopped')
  }, 120000)

  it('reports crashed state if the Host exits unexpectedly', async () => {
    const host = supervisor()
    await host.start()
    const child = (host as unknown as { child?: { kill(): void } }).child
    child?.kill()
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(host.state).toBe('crashed')
  }, 120000)
})
