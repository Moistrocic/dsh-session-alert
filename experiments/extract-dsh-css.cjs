// 从 DSH 的 asar 包里抽出 UI 原语（primitives）的 CSS，用于对齐设置页的视觉语言。
//
// 为什么要做这件事：本插件的设置页用原生 HTML + 自写样式，观感与 DSH 自身设置页
// 不一致（用户反馈"样式很丑"）。DSH 用 CSS modules，类名被哈希（如 OK0UZW_settingsCard），
// 因此无法直接复用它编译后的类名；但它的 CSS 源码里写着**设计语言**
// （字号、间距、圆角、过渡、以及各处的令牌用法），照着写就能对上。
const fs = require('node:fs')
const path = require('node:path')

const asar = process.argv[2]
const outDir = process.argv[3]
const buf = fs.readFileSync(asar)
const headerSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'))
const base = 16 + headerSize

const wanted = [
  'Input.module.css',
  'Checkbox.module.css',
  'Button.module.css',
  'SegmentedTabs.module.css',
  'SegmentedControl.module.css',
  'Pill.module.css',
  'DisclosureRow.module.css',
]
// 还要找设置相关页面的样式（名字不确定，按内容匹配）
const alsoMatch = /settings/i

fs.mkdirSync(outDir, { recursive: true })

let found = 0
;(function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = `${prefix}/${name}`
    if (entry.files) { walk(entry, p); continue }
    if (!/\.css$/.test(name)) continue
    const hit = wanted.includes(name) || (alsoMatch.test(name) && /primitives|settings/i.test(p))
    if (!hit) continue
    const start = base + Number(entry.offset)
    const data = buf.subarray(start, start + Number(entry.size))
    const safe = p.replace(/[\\/]/g, '__')
    fs.writeFileSync(path.join(outDir, safe), data)
    console.log(`抽出 ${p}  (${entry.size}B)`)
    found++
  }
})(header, '')

console.log(`\n共抽出 ${found} 个文件到 ${outDir}`)
