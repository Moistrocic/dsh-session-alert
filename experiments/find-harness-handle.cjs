// 查 Host 半边如何注册 host.call 的处理器（即 harness.handle 的来源与形状）。
//
// 背景：客户端 Builtin 清单里 host.call 是「Client -> 本包 Host half」的官方 RPC；
// 动态半边的 fetch 陷阱文案也指向同一对：harness.handle(method, fn) / host.call(method, args)。
//
// 但本插件的 Host 半边是**静态** lib/index.js（apply(ctx, config)），
// 不是动态半边。因此必须先弄清：静态 Host 半边能不能拿到 harness？
// 怎么注册方法？注册在哪个服务上？不看清楚就改只会得到静默失效。
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
    if (!/\.(js|mjs|cjs|d\.ts)$/.test(name)) continue
    if (entry.size > 4_000_000) continue
    files.push({ path: p, offset: base + Number(entry.offset), size: Number(entry.size) })
  }
})(header, '')

const needles = ['harness.handle', 'harnessHandle', 'handlers.set', 'invokeHandler', 'clientHandler']
const found = new Map()

for (const f of files) {
  const text = buf.subarray(f.offset, f.offset + f.size).toString('utf8')
  for (const n of needles) {
    if (text.indexOf(n) < 0) continue
    if (!found.has(n)) found.set(n, [])
    found.get(n).push(f.path)
  }
}

for (const [n, paths] of found) {
  console.log(`\n### ${n} —— ${paths.length} 个文件`)
  for (const p of paths.slice(0, 6)) console.log('   ' + p)
}

// 抽出 harness.handle 的调用契约（参数、返回值、注册位置）
console.log('\n\n=== harness.handle 的上下文 ===')
let shown = 0
for (const f of files) {
  const text = buf.subarray(f.offset, f.offset + f.size).toString('utf8')
  let idx = text.indexOf('harness.handle')
  if (idx < 0) continue
  console.log(`\n--- ${f.path} ---`)
  while (idx >= 0 && shown < 3) {
    console.log(text.slice(Math.max(0, idx - 500), idx + 500).replace(/\s*\n\s*/g, ' ').trim())
    console.log('   …')
    idx = text.indexOf('harness.handle', idx + 1)
    shown++
  }
  if (shown >= 3) break
}

// 找 harness 对象的定义（含 handle 方法）
console.log('\n\n=== 含 `handle(method` 的定义 ===')
for (const f of files) {
  const text = buf.subarray(f.offset, f.offset + f.size).toString('utf8')
  const m = text.match(/handle\s*\(\s*method[\s\S]{0,300}/)
  if (m === null) continue
  console.log(`\n--- ${f.path} ---`)
  console.log(m[0].replace(/\s*\n\s*/g, ' ').trim())
  break
}
