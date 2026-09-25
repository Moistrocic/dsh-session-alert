// 查页面（dsh-app://）如何访问 Host：找 __DSH_BOOT__ / dshDesktop / 基础 URL 的注入。
//
// 这是上一个探查的收尾。目标只有一个：**插件的客户端半边到底能不能、以及该怎样**
// 从页面访问 Host 的 HTTP 服务。
//
// 已知：
//   - 页面服务在特权 scheme `dsh-app://`（进程命令行确认）
//   - Host 的 HTTP 服务在 http://127.0.0.1:19387，且要求浏览器 cookie 认证
//   - 两者不同源，相对路径 fetch 会以 dsh-app:// 为基解析
//
// 因此需要找到桌面端是否把「Host 的地址 / 令牌 / 桥」注入给页面。
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

// 只找与 boot / app-boot / web-app / desktop-runtime 相关的文件
const candidates = files.filter((f) => /app-boot|dshDesktop|desktop-runtime|web-app\/lib|api-remotes\/lib\/client|client-connection\/lib\/client/.test(f.path))
console.log(`候选文件 ${candidates.length} 个`)

const needles = ['__DSH_BOOT__', 'dshDesktop', 'baseUrl', 'origin', '__DSH_']
for (const f of candidates) {
  const t = buf.subarray(f.offset, f.offset + f.size).toString('utf8')
  for (const n of needles) {
    const i = t.indexOf(n)
    if (i < 0) continue
    console.log(`\n===== ${n}  @  ${f.path} =====`)
    console.log(t.slice(Math.max(0, i - 350), i + 650).replace(/\s*\n\s*/g, ' ').trim())
  }
}
