// 查 `__DSH_TRANSPORT__` 的形状与用法。
//
// ## 为什么这是关键
//
// 本插件的客户端半边用 `fetch('/api/dsh-session-alert/client-state')` 上报端别与焦点。
// 但：
//   - 桌面端页面在特权 scheme `dsh-app://`，Host 的 HTTP 服务在 http://127.0.0.1:19387
//     且要求浏览器 cookie 认证 —— 两者不同源，相对路径 fetch 解析不到 Host。
//   - 而 DSH 自己的客户端连接层用 `globalThis.__DSH_TRANSPORT__`（宿主注入）访问 Host，
//     不做相对路径 fetch。
//
// 所以我的上报很可能**从来没在桌面端真正工作过**，或者只在某个时间窗内恰好能用。
// 必须看清 transport 的形状，才能判断该怎样正确地访问 Host。
const fs = require('node:fs')

const asar = process.argv[2]
const buf = fs.readFileSync(asar)
const hs = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + hs).toString('utf8'))
const base = 16 + hs

const files = []
;(function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = `${prefix}/${name}`
    if (entry.files) { walk(entry, p); continue }
    if (!/\.(js|mjs)$/.test(name)) continue
    if (entry.size > 2_000_000) continue
    files.push({ path: p, offset: base + Number(entry.offset), size: Number(entry.size) })
  }
})(header, '')

for (const f of files) {
  const t = buf.subarray(f.offset, f.offset + f.size).toString('utf8')
  for (const needle of ['__DSH_TRANSPORT__', '__DSH_CONNECTION_RECOVERY__']) {
    let i = t.indexOf(needle)
    if (i < 0) continue
    let n = 0
    while (i >= 0 && n < 3) {
      console.log(`\n===== ${needle} @ ${f.path} =====`)
      console.log(t.slice(Math.max(0, i - 600), i + 900).replace(/\s*\n\s*/g, ' ').trim())
      i = t.indexOf(needle, i + 1)
      n++
    }
  }
}
