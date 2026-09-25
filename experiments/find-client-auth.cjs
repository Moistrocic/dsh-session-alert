// 读 dsh-client-connection 的认证实现，弄清：
//   1. 客户端是如何认证的（cookie？header？URL token？）
//   2. 我插件的客户端半边该怎样发请求才能通过
//
// 为什么必须查清：本插件的客户端半边用 `fetch('/api/dsh-session-alert/client-state')`
// 上报端别与焦点。DSH 重启后外部请求返回 401；如果这同样影响页面内的请求，
// 那**端别自报会静默失效**——而端别自报是整个形状选择的前提（ADR 0001）。
const fs = require('node:fs')

const asar = process.argv[2]
const buf = fs.readFileSync(asar)
const hs = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + hs).toString('utf8'))
const base = 16 + hs

let target = null
;(function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = `${prefix}/${name}`
    if (entry.files) { walk(entry, p); continue }
    if (p === '/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js') {
      target = buf.subarray(base + Number(entry.offset), base + Number(entry.offset) + Number(entry.size)).toString('utf8')
    }
  }
})(header, '')

if (target === null) { console.log('未找到目标文件'); process.exit(1) }
console.log('文件大小:', target.length)

const lines = target.split('\n')
for (const needle of ['401', 'unauthorized', 'token', 'credentials', 'Authorization', 'fetch(']) {
  const hits = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) hits.push(i)
  }
  if (hits.length === 0) continue
  console.log(`\n===== "${needle}" 命中 ${hits.length} 处，前 3 处上下文 =====`)
  for (const i of hits.slice(0, 3)) {
    const from = Math.max(0, i - 3)
    const to = Math.min(lines.length, i + 4)
    console.log(`--- 第 ${i + 1} 行 ---`)
    for (let j = from; j < to; j++) console.log('   ' + lines[j].trim().slice(0, 170))
  }
}
