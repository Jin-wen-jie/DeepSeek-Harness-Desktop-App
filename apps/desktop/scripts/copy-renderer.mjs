import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(root, 'src/renderer/index.html')
const target = resolve(root, 'lib/renderer/index.html')
await mkdir(dirname(target), { recursive: true })
await copyFile(source, target)
