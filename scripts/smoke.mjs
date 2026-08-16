// Headless smoke runner: builds nothing, runs the app with DSH_DESKTOP_SMOKE=1
// so the packaged/dev Electron binary exercises server start, page load, boot
// manifest injection, and UI paint, then exits 0/1.
// Modern electron npm packages download their binary lazily: trigger the
// download through cli.js before resolving the executable path.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))
const electron = require('electron')
const cli = join(root, 'node_modules', 'electron', 'cli.js')

if (!existsSync(electron)) {
  console.log('electron binary missing, downloading via cli.js…')
  const fetch = spawnSync(process.execPath, [cli, '--version'], { stdio: 'inherit' })
  if (fetch.status !== 0 || !existsSync(electron)) {
    console.error('failed to fetch the electron binary')
    process.exit(1)
  }
}

const child = spawn(electron, [root], {
  env: { ...process.env, DSH_DESKTOP_SMOKE: '1' },
  stdio: 'inherit',
})
child.on('error', (error) => { console.error('failed to launch electron:', error); process.exit(1) })
child.on('exit', (code) => process.exit(code ?? 1))
