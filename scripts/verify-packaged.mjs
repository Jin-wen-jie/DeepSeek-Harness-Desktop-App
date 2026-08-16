// Verify the packaged app ships the full production dependency closure.
// electron-builder collects `dependencies` walks, but npm auto-installs peer
// and optional dependencies that the collector can drop. This script walks the
// project's real node_modules graph and fails when the packaged app is missing
// any package the harness can import at runtime.
// Usage: node scripts/verify-packaged.mjs [packaged-app-dir]
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const projectModules = join(projectRoot, 'node_modules')
const packagedDir = process.argv[2] ?? join(projectRoot, 'release', 'win-unpacked', 'resources', 'app')
const packagedModules = join(packagedDir, 'node_modules')

if (!existsSync(packagedModules)) {
  console.error('packaged node_modules not found:', packagedModules)
  process.exit(1)
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const rootPkg = readJson(join(projectRoot, 'package.json'))

// Resolve a dep spec to a package directory under the project's node_modules.
function resolvePkg(name) {
  const rel = name.startsWith('@') ? name.split('/').slice(0, 2).join(sep) : name.split('/')[0]
  const dir = join(projectModules, ...rel.split('/'))
  return existsSync(join(dir, 'package.json')) ? rel : null
}

// BFS the production closure: direct dependencies plus each package's own
// dependencies, optionalDependencies, and peerDependencies (npm 7+ installs
// peers automatically, so the harness can import them).
const queue = Object.keys(rootPkg.dependencies ?? {}).map(resolvePkg).filter(Boolean)
const seen = new Set()
const missing = []
while (queue.length > 0) {
  const rel = queue.shift()
  if (seen.has(rel)) continue
  seen.add(rel)
  if (!existsSync(join(packagedModules, ...rel.split('/')))) {
    missing.push(rel)
    continue
  }
  const pkg = readJson(join(projectModules, ...rel.split('/'), 'package.json'))
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}), ...(pkg.peerDependencies ?? {}) }
  for (const name of Object.keys(deps)) {
    const depRel = resolvePkg(name)
    if (depRel !== null && !seen.has(depRel)) queue.push(depRel)
  }
}

if (missing.length > 0) {
  console.error('Packaged app is missing ' + missing.length + ' package(s) the harness can import:')
  for (const rel of missing) console.error('  - ' + rel)
  process.exit(1)
}

// The folder-picker worker must not ship the koffi.view()-based readUtf16:
// koffi.view() fatals under Electron-as-node (napi_fatal_error), crashing
// the worker process the moment a folder is picked. The postinstall patch
// (scripts/patch-dsh.mjs) rewrites it; fail the release if the packaged
// worker still carries the buggy read.
const workerPath = join(packagedModules, '@deepseek-ai', 'dsh-host-directory-picker-native', 'lib', 'worker.cjs')
if (existsSync(workerPath)) {
  const worker = readFileSync(workerPath, 'utf8')
  if (worker.includes('koffi.view(address, 32768)')) {
    console.error('Packaged worker.cjs still uses koffi.view() — the folder picker crashes under Electron-as-node.')
    console.error('Reinstall dependencies (npm install) to run the postinstall patch, then rebuild.')
    process.exit(1)
  }
}

// Deleting a workspace must permanently delete its sessions, not drop them
// into the ungrouped bucket. The postinstall patch (scripts/patch-dsh.mjs)
// rewrites deleteKnown; fail the release if the packaged registry lacks it.
const workspacePath = join(packagedModules, '@deepseek-ai', 'dsh-workspace', 'lib', 'index.js')
if (existsSync(workspacePath)) {
  const workspace = readFileSync(workspacePath, 'utf8')
  if (!workspace.includes('permanently deletes every session it accounted')) {
    console.error('Packaged dsh-workspace lacks the delete-sessions patch — workspace conversations would fall into the ungrouped bucket.')
    console.error('Reinstall dependencies (npm install) to run the postinstall patch, then rebuild.')
    process.exit(1)
  }
}

console.log('OK: packaged app contains all ' + seen.size + ' packages of the production closure')
