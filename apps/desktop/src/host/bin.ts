/**
 * Desktop Host subprocess entry. Boots the real `desktop` Cordis profile
 * (`dsh-base` + `dsh-desktop-app`) over Electron-as-node, then adapts the
 * versioned stdio line protocol to the composed `ctx.desktopRuntime` (the
 * fetch-shaped Host API handler and the mux/host event streams). The bridge
 * and every protocol invariant live in desktop-bridge.ts; this file only owns
 * booting, the ready handshake, and process lifetime.
 */

import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  boot,
  healProfilesModuleFallback,
  installFailLoud,
  loadLayeredEnv,
  loadOptionalPatches,
  loadProfile,
  PROFILE_PATCH_FILENAME,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import '@deepseek-ai/dsh-desktop-app' // loads the cordis Context augmentation for ctx.desktopRuntime
import { DesktopBridge } from './desktop-bridge.ts'

const NAME = 'dsh-host'
/** apps/desktop/package.json — the anchor whose dependency closure makes every desktop bundle resolvable. */
const INSTALL_ANCHOR = fileURLToPath(new URL('../../package.json', import.meta.url))

const ROOT_CONFIG = `# desktop host root — an empty entry list. The composition arrives as patches:
# each bundle in package.json's dsh.profile.bundles, then the profile's cordis.patch.yml, then the home layer.
[]
`

async function main(): Promise<void> {
  installFailLoud(NAME)
  healProfilesModuleFallback(INSTALL_ANCHOR)
  const profile = loadProfile(NAME, 'desktop', INSTALL_ANCHOR)
  const rootConfig = join(profile.dir, 'cordis.yml')
  // The empty root exists only so the Loader has a real include file to anchor
  // baseUrl at the profile directory; the whole tree is patch layers.
  writeFileSync(rootConfig, ROOT_CONFIG)
  const environment = loadLayeredEnv(NAME)
  const patches = [
    ...profile.layers.flatMap(layer => layer.patches),
    ...profile.patches,
    ...(loadOptionalPatches(NAME, join(resolveDshHome(), PROFILE_PATCH_FILENAME)) ?? []),
  ]
  // boot() resolves only once every enabled entry is ACTIVE, so ctx.apiProxy
  // and ctx.desktopRuntime are guaranteed live here.
  const ctx = await boot(NAME, rootConfig, structuredClone(patches), (hostCtx) => {
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
    provideCmdline(hostCtx, {
      args: [],
      exit: code => disposeAndExit(code),
    })
  })

  let disposed = false
  const disposeAndExit = (code: number): void => {
    if (disposed) return
    disposed = true
    void ctx.fiber.dispose().finally(() => process.exit(code))
  }
  const bridge = new DesktopBridge(ctx.desktopRuntime, {
    send: (message) => {
      process.stdout.write(`${JSON.stringify(message)}\n`)
      // Graceful exit after the stopped handshake lands; the supervisor sees
      // the final line before the process leaves.
      if (message.type === 'stopped') setTimeout(() => { disposeAndExit(0) }, 0)
    },
  })
  bridge.start()
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  input.on('line', (line) => { bridge.handleLine(line) })
  input.on('close', () => { disposeAndExit(0) })
}

void main().catch((error) => {
  // Surface boot/plugin failures as a fatal handshake so the desktop shell can
  // show the backend-start-failed state instead of a silently hung window.
  const message = error instanceof Error ? error.message : String(error)
  process.stdout.write(`${JSON.stringify({ version: 1, type: 'fatal', message })}\n`)
  process.exit(1)
})
