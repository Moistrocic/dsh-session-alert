// 看桌面端宿主如何加载页面、以及 `dsh-app://` 与 Host HTTP 服务的关系。
//
// 目的（承接上一个探查）：插件的客户端半边用相对路径 fetch 上报端别。
// 若页面在 `dsh-app://` 而 Host 在 `http://127.0.0.1:19387` 且要求 cookie 认证，
// 那套上报就会失效——而它是形状选择的前提（ADR 0001）。
// 先把「页面从哪来、能不能访问 Host」这件事看清楚。
const fs = require('node:fs')

const asar = process.argv[2]
const buf = fs.readFileSync(asar)
const hs = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + hs).toString('utf8'))
const base = 16 + hs

function read(path) {
  let found = null
  ;(function walk(node, prefix) {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const p = `${prefix}/${name}`
      if (entry.files) { walk(entry, p); continue }
      if (p === path) {
        found = buf.subarray(base + Number(entry.offset), base + Number(entry.offset) + Number(entry.size)).toString('utf8')
      }
    }
  })(header, '')
  return found
}

const target = '/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'
const src = read(target)
if (src === null) { console.log('未找到 ' + target); process.exit(1) }
console.log(`文件大小: ${src.length}`)

const lines = src.split('\n')
const needles = ['dsh-app://', 'loadURL', 'loadFile', 'registerScheme', 'protocol.handle', 'webPreferences', 'preload', 'executeJavaScript', 'inject']
for (const n of needles) {
  const hits = []
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(n)) hits.push(i)
  if (hits.length === 0) continue
  console.log(`\n===== "${n}"（${hits.length} 处）=====`)
  for (const i of hits.slice(0, 3)) {
    const from = Math.max(0, i - 2)
    const to = Math.min(lines.length, i + 3)
    for (let j = from; j < to; j++) console.log(`  ${String(j + 1).padStart(5)}: ${lines[j].trim().slice(0, 160)}`)
    console.log('  ---')
  }
}
