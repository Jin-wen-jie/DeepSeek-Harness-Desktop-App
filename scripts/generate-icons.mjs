// Generates assets/icon.png, build/icon.png, build/icon-1024.png and build/icon.ico
// from assets/icon-src/appstore-512.jpg (the official DeepSeek App Store artwork).
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = join(root, 'assets', 'icon-src', 'appstore-512.jpg')

const master512 = await sharp(src).resize(512, 512).png().toBuffer()
writeFileSync(join(root, 'assets', 'icon.png'), master512)
mkdirSync(join(root, 'build'), { recursive: true })
writeFileSync(join(root, 'build', 'icon.png'), master512)
await sharp(src).resize(1024, 1024).png().toFile(join(root, 'build', 'icon-1024.png'))

const sizes = [16, 24, 32, 48, 64, 128, 256]
const pngs = await Promise.all(sizes.map(size => sharp(src).resize(size, size).png().toBuffer()))
const ico = await pngToIco(pngs)
writeFileSync(join(root, 'build', 'icon.ico'), ico)
writeFileSync(join(root, 'assets', 'icon.ico'), ico)

console.log('icons generated: assets/icon.png, assets/icon.ico, build/icon.png, build/icon-1024.png, build/icon.ico')
