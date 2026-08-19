#!/usr/bin/env node
/**
 * Bundles the desktop renderer boot (Shell kernel + seed words + the
 * transport-bound connection carrier) into one self-contained ESM bundle at
 * `lib/renderer/bundle.js`. Single-bundle on purpose: plugin bundles require
 * their seed words (react, cordis, web-react, ...) through the client module
 * table, which resolves to these same bundled instances — so the shell and its
 * seed must be one esbuild graph. The page is served over the read-only
 * `app://` protocol, where ESM and same-origin bundle scripts load cleanly
 * under `sandbox` + `webSecurity`.
 */
import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..') // apps/desktop
const repo = resolve(root, '../..')

// The vendored cordis loader's node half imports node:* builtins at module
// top level; the browser shell never evaluates them (client-loader.internal is
// the ClientModuleSystem), so stub them to empty for esbuild resolution.
const nodeBuiltinStub = {
  name: 'node-builtin-stub',
  setup(build) {
    build.onResolve({ filter: /^node:/ }, () => ({ path: 'node-stub-empty', namespace: 'node-stub' }))
    build.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({
      // Never reached: the client process-shim pins versions.node to 0.0.0 so
      // the loader's node-internal detection short-circuits before calling this.
      contents: `export function createRequire(){ throw new Error("node:module is not available in the desktop renderer") }`,
      loader: 'js',
    }))
  },
}

await build({
  entryPoints: [resolve(root, 'src/renderer/desktop-boot.ts')],
  bundle: true,
  outfile: resolve(root, 'lib/renderer/bundle.js'),
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  alias: {
    // esbuild's exports-map resolution does not follow a ".ts" target; point
    // the carrier and the ConnectionController runtime value at their sources.
    '@deepseek-ai/dsh-client-connection-desktop': resolve(repo, 'packages/client/connection-desktop/src/client/index.ts'),
    '@deepseek-ai/dsh-client-connection/src/client/connection.ts': resolve(repo, 'packages/client/connection/src/client/connection.ts'),
    '@deepseek-ai/dsh-host-apiproxy/api/rpc.ts': resolve(repo, 'packages/host/apiproxy/src/api/rpc.ts'),
  },
  plugins: [nodeBuiltinStub],
  loader: {
    '.json': 'json',
    '.css': 'css',
    // The shell pulls KaTeX/markdown CSS with url() font references; emit them
    // as assets next to the bundle so the read-only app:// page can serve them.
    '.woff': 'file',
    '.woff2': 'file',
    '.ttf': 'file',
    '.eot': 'file',
    '.png': 'file',
    '.jpg': 'file',
    '.gif': 'file',
  },
  // Nothing is external: every bare import (the web shell, cordis, the carrier
  // source) lands in this one bundle so names resolve to a single instance.
  logLevel: 'info',
})
