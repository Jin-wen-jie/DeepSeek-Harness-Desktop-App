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
console.log('OK: packaged app contains all ' + seen.size + ' packages of the production closure')
