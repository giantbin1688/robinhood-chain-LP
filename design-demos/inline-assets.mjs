// 把 assets/ 里的官方 logo 原件转成 data URI，替换掉草稿里的 __LOGO_XXX__ 占位符。
// 为什么要有这一步：三版是「双击就能开」的单文件 HTML，用相对路径挪个目录就全员裂图。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mime = { png: 'image/png', svg: 'image/svg+xml' }
const uri = {}
for (const f of readdirSync(join(here, 'assets'))) {
  const ext = f.split('.').pop()
  if (!mime[ext]) continue
  const key = f.replace(/\.[^.]+$/, '').toUpperCase().replace(/-/g, '_')
  uri[key] = `data:${mime[ext]};base64,${readFileSync(join(here, 'assets', f)).toString('base64')}`
}

let n = 0
for (const f of process.argv.slice(2)) {
  let html = readFileSync(f, 'utf8')
  const missing = new Set()
  html = html.replace(/__LOGO_([A-Z_]+)__/g, (m, k) => (uri[k] ? (n++, uri[k]) : (missing.add(k), m)))
  if (missing.size) { console.error(`✗ ${f}: 缺资产 ${[...missing].join(', ')}`); process.exit(1) }
  writeFileSync(f, html)
  console.log(`✓ ${f} 内嵌完成`)
}
console.log(`共替换 ${n} 处，可用资产: ${Object.keys(uri).join(', ')}`)
