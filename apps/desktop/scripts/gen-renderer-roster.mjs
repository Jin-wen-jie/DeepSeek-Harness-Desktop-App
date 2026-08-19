#!/usr/bin/env node
/**
 * Generates the desktop renderer's `window.__DSH_BOOT__` roster: every
 * workspace package declaring `dsh.client.platform === 'web'` (the same set
 * the web profile's `ClientModuleRegistry` would scan from its mounted host
 * entries), minus the transport-injected carrier which the renderer imports
 * directly. `@deepseek-ai/dsh-client-connection` stays a row — the desktop
 * boot registers its carrier as a shell static under that name, so the row's
 * bundle is never fetched while the runtime's `inject: ['connection']` edges
 * still resolve.
 *
 * Emits `apps/desktop/src/renderer/roster.generated.json` consumed by the
 * esbuild renderer boot bundle.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const rosterOut = join(root, 'apps/desktop/src/renderer/roster.generated.json')
// Main-facing path map: pkg name -> absolute lib/client.js (Main cannot
// require.resolve these from apps/desktop — pnpm does not link them there).
const locationsOut = join(root, 'apps/desktop/lib/renderer/bundle-locations.json')

// The desktop Host exposes the native directory-picker capability. The browse
// and native browser plugins both fill the same single slots, so loading both
// makes the renderer reject the second registration.
const desktopExcludedClientPackages = new Set([
  '@deepseek-ai/dsh-client-ui-directory-picker-browse',
])

const entries = []
const locations = {}
for (const group of readdirSync(join(root, 'packages'))) {
  const groupPath = join(root, 'packages', group)
  if (!statSync(groupPath).isDirectory()) continue
  for (const name of readdirSync(groupPath)) {
    const pkgPath = join(groupPath, name, 'package.json')
    if (!existsSync(pkgPath)) continue
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const dshClient = pkg.dsh?.client
    if (dshClient?.platform !== 'web') continue
    const id = pkg.name
    // Transport-injected: imported by the renderer boot directly, never a row.
    if (id === '@deepseek-ai/dsh-client-connection-desktop') continue
    if (desktopExcludedClientPackages.has(id)) continue
    entries.push({
      id,
      url: `app://desktop/bundle/${encodeURIComponent(id)}/client.js`,
      rev: 'desktop-scan',
      inject: Array.isArray(dshClient.inject) ? dshClient.inject : [],
      immediately: dshClient.immediately === true,
    })
    const clientExport = pkg.exports?.['./client']
    const rel = typeof clientExport === 'string' ? clientExport : clientExport?.default
    if (typeof rel === 'string') locations[id] = join(groupPath, name, rel)
  }
}

const rev = createHash('sha1').update(entries.map(e => e.id).join(',')).digest('hex').slice(0, 12)
writeFileSync(rosterOut, `${JSON.stringify({ rev, entries }, null, 2)}\n`)
mkdirSync(dirname(locationsOut), { recursive: true })
writeFileSync(locationsOut, `${JSON.stringify(locations, null, 2)}\n`)
console.log(`wrote ${rosterOut}: ${entries.length} client rows; ${locationsOut}: ${Object.keys(locations).length} bundle paths`)
