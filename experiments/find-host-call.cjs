// 从 DSH 的 asar 包里找出 host.call 的实现与契约。
//
// 用途：本插件的客户端半边目前用 HTTP 环回路由与 Host 通信。官方 Builtin 清单里
// 存在 host.call（"Package-private JSON RPC from Client to this Package's Host half."），
// 它是更合适的通道。但要改用它必须先弄清：Host 半边要如何注册方法、方法名如何约定、
// 参数与返回值如何传递。不看清楚就改，只会得到静默失效。
const fs = require('node:fs')

const asar = process.argv[2]
const buf = fs.readFileSync(asar)
const headerSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'))
const base = 16 + headerSize

/** 递归收集所有文本资源。 */
const files = []
;(function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = `${prefix}/${name}`
    if (entry.files) { walk(entry, p); continue }
    if (!/\.(js|mjs|cjs|json)$/.test(name)) continue
    if (entry.size > 6_000_000) continue
    files.push({ path: p, offset: base + Number(entry.offset), size: Number(entry.size) })
  }
})(header, '')

console.log(`扫描 ${files.length} 个文本资源…`)

const needle = 'host.call'
let hits = 0
for (const f of files) {
  const text = buf.subarray(f.offset, f.offset + f.size).toString('utf8')
  let idx = text.indexOf(needle)
  if (idx < 0) continue
  hits++
  console.log(`\n===== ${f.path} =====`)
  let shown = 0
  while (idx >= 0 && shown < 4) {
    const from = Math.max(0, idx - 420)
    const to = Math.min(text.length, idx + 420)
    console.log('--- 上下文 ---')
    console.log(text.slice(from, to).replace(/\s*\n\s*/g, ' ').trim())
    idx = text.indexOf(needle, idx + 1)
    shown++
  }
  if (hits >= 6) break
}
if (hits === 0) console.log('未找到 host.call')
