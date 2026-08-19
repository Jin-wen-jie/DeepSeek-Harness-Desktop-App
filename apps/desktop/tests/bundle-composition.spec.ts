import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const patch = readFileSync(fileURLToPath(new URL('../../../packages/bundle/desktop-app/cordis.patch.yml', import.meta.url)), 'utf8')
const profileSource = readFileSync(fileURLToPath(new URL('../../../packages/boot/app-boot/src/profile.ts', import.meta.url)), 'utf8')
const roster = JSON.parse(readFileSync(fileURLToPath(new URL('../src/renderer/roster.generated.json', import.meta.url)), 'utf8')) as {
  entries: { id: string }[]
}

describe('dsh-desktop-app bundle composition', () => {
  it('mounts the Host API gateway and the desktop runtime glue', () => {
    expect(patch).toContain('id: api-gateway')
    expect(patch).toContain('@deepseek-ai/dsh-host-apiproxy')
    expect(patch).toContain('id: desktop-runtime')
    expect(patch).toContain('@deepseek-ai/dsh-desktop-app')
  })

  it('never mounts a web server or static frontend', () => {
    expect(patch).not.toContain('@deepseek-ai/dsh-host-webserver')
    expect(patch).not.toContain('@deepseek-ai/dsh-host-frontend-static')
    expect(patch).not.toContain('web-startup')
    expect(patch).not.toContain('web-runtime')
  })

  it('overlays dsh-base and disables HMR', () => {
    expect(patch).toContain('id: system-prompt')
    expect(patch).toContain('id: hmr')
    expect(patch).toContain('disabled: true')
  })

  it('does not duplicate services already mounted by dsh-base or the desktop host', () => {
    expect(patch).not.toContain('desktop-api-gateway')
    expect(patch).not.toContain('desktop-typert-registry')
    expect(patch).not.toContain('desktop-session-log-export')
  })

  it('mounts only the welcome settings registration from the client Host face', () => {
    expect(patch).toContain('desktop-client-ui-settings-general')
    expect(patch).not.toContain('desktop-client-ui-theme')
    expect(patch).not.toContain('desktop-cordis-client-runner')
  })

  it('selects the native directory picker without its competing browse client', () => {
    const ids = roster.entries.map(entry => entry.id)
    expect(ids).toContain('@deepseek-ai/dsh-client-ui-directory-picker-native')
    expect(ids).not.toContain('@deepseek-ai/dsh-client-ui-directory-picker-browse')
  })

  it('registers the desktop profile template over dsh-base', () => {
    expect(profileSource).toMatch(/desktop: \['@deepseek-ai\/dsh-base', '@deepseek-ai\/dsh-desktop-app'\]/)
  })
})
