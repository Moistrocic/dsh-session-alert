// 查静态 bundle 的 __ModuleLoader__ 是否也注入 host（即 host.call 对静态半边是否可用）。
//
// 背景：动态半边的 host.call 来自闭包参数（runner 注入 host 与 harnessTrap）。
// 本插件的客户端半边是**静态 bundle**（window.__ModuleLoader__.load({id, factory})），
// 因此必须查清 ModuleLoader 的 factory(require) 里能不能拿到 host。
// 这决定我该用 host.call 还是沿用 HTTP 环回路由——而这两条路的可用性完全不同。
const fs = require('node:fs')

const asar = process.argv[2]
const buf = fs.readFileSync(asar)
const headerSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'))
const base = 16 + headerSize

const files = []
;(function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = `${prefix}/${name}`
    if (entry.files) { walk(entry, p); continue }
    if (!/\.(js|mjs|cjs)$/.test(name)) continue
    if (entry.size > 4_000_000) continue
    files.push({ path: p, offset: base + Number(entry.offset), size: Number(entry.size) })
  }
})(header, '')

const needles = ['__ModuleLoader__', 'ModuleLoader', 'moduleLoader']

for (const n of needles) {
  const paths = []
  for (const f of files) {
    const text = buf.subarray(f.offset, f.offset + f.size).toString('utf8')
    if (text.indexOf(n) >= 0) paths.push(f.path)
  }
  console.log(`\n### ${n} —— ${paths.length} 个文件`)
  for (const p of paths.slice(0, 12)) console.log('   ' + p)
}

// 找 __ModuleLoader__ 的定义（含 load 方法的对象）
console.log('\n\n=== __ModuleLoader__ 的定义处 ===')
for (const f of files) {
  const text = buf.subarray(f.offset, f.offset + f.size).toString('utf8')
  const idx = text.indexOf('__ModuleLoader__')
  if (idx < 0) continue
  // 只关心"定义"而不是"使用"：找 load: 或 load( 附近
  const window = text.slice(Math.max(0, idx - 300), idx + 900)
  if (!/load\s*[:(]/.test(window)) continue
  console.log(`\n--- ${f.path} ---`)
  console.log(window.replace(/\s*\n\s*/g, ' ').trim())
  console.log()
}
