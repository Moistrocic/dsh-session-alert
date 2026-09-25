// 查桌面端如何让 `dsh-app://` 页面访问 Host：是否注入端口 / 令牌 / 桥对象。
//
// ## 为什么这件事要紧
//
// 本插件的客户端半边用 `fetch('/api/dsh-session-alert/client-state')` 上报端别与焦点。
// 但桌面端页面服务在**特权 scheme `dsh-app://`** 上（进程命令行里的
// `--standard-schemes=dsh-app --secure-schemes=dsh-app`），而 Host 的 HTTP 服务在
// `http://127.0.0.1:19387` 且**要求浏览器认证**（root 的 `?token=` 铸造 `dsh-auth-*` cookie）。
//
// 两者不同源，因此相对路径 fetch 要么解析不到、要么被 401 挡掉。
// 而当初把上报写成「失败静默忽略」，所以**失效了也看不出来**——
// 这是端别自报的前提（ADR 0001），一旦失效，形状选择会退化成「永远无按钮」。
//
// 于是需要查清：桌面端是否给页面注入了端口、令牌或桥对象，供客户端访问 Host。
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
    if (!/\.(js|mjs|json)$/.test(name)) continue
    if (entry.size > 3_000_000) continue
    files.push({ path: p, offset: base + Number(entry.offset), size: Number(entry.size) })
  }
})(header, '')

const needles = ['__DSH_BOOT__', 'dshDesktop', 'preload', 'executeJavaScript', 'injectBoot']
const seen = new Set()

for (const f of files) {
  if (!/desktop|preload|boot/i.test(f.path)) continue
  const t = buf.subarray(f.offset, f.offset + f.size).toString('utf8')
  for (const n of needles) {
    const i = t.indexOf(n)
    if (i < 0) continue
    const key = `${f.path}:${n}`
    if (seen.has(key)) continue
    seen.add(key)
    console.log(`\n===== ${n}  @  ${f.path} =====`)
    console.log(t.slice(Math.max(0, i - 500), i + 800).replace(/\s*\n\s*/g, ' ').trim())
  }
}
if (seen.size === 0) console.log('未找到注入点')
