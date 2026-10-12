import vue from '@vitejs/plugin-vue'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const root = path.dirname(fileURLToPath(import.meta.url))
const pdfjsRoot = path.join(root, 'node_modules', 'pdfjs-dist')

const pdfjsDirs = {
  cmaps: path.join(pdfjsRoot, 'cmaps'),
  iccs: path.join(pdfjsRoot, 'iccs'),
  standard_fonts: path.join(pdfjsRoot, 'standard_fonts'),
  wasm: path.join(pdfjsRoot, 'wasm'),
}

function mimeType(filePath) {
  if (filePath.endsWith('.wasm')) return 'application/wasm'
  if (filePath.endsWith('.svg')) return 'image/svg+xml'
  if (filePath.endsWith('.gif')) return 'image/gif'
  if (filePath.endsWith('.mjs') || filePath.endsWith('.js')) return 'text/javascript; charset=utf-8'
  return 'application/octet-stream'
}

function pdfjsAssets() {
  return {
    name: 'pdfjs-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? '').split('?')[0])
        const match = url.match(/^\/pdfjs\/(cmaps|iccs|standard_fonts|wasm)\/([^/]+)$/)
        if (!match) return next()

        const base = path.resolve(pdfjsDirs[match[1]])
        const filePath = path.resolve(base, match[2])
        if (!filePath.startsWith(`${base}${path.sep}`) || !fs.existsSync(filePath)) {
          res.statusCode = 404
          res.end()
          return
        }

        res.setHeader('Content-Type', mimeType(filePath))
        fs.createReadStream(filePath).pipe(res)
      })
    },
    writeBundle(options) {
      const outDir = options.dir ?? path.resolve(root, 'dist')
      const target = path.join(outDir, 'pdfjs')
      for (const [name, dir] of Object.entries(pdfjsDirs)) {
        fs.cpSync(dir, path.join(target, name), { recursive: true })
      }
    },
  }
}

export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [
    vue(),
    pdfjsAssets(),
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
})
