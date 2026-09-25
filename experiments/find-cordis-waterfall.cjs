// 查 cordis 的 waterfall 事件语义：监听器注册后**是否必须调用 next()**。
//
// 为什么这件事非要查清：本插件在 `user-questions/request` 与 `approval/request` 上注册了
// 监听器（两者都是 waterfall），而处理器既没有 next 形参也不返回 Promise。
// 我在注释里写了「只观察、不干预——不调用 next 也不改结果，因此不会影响真正的流程」，
// **但那是一句未经验证的假设**。如果瀑布要求返回 next()，那么这个监听器就可能正在
// 阻断用户的提问与审批——那是最严重的一类缺陷。
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
      if (p === path) found = buf.subarray(base + Number(entry.offset), base + Number(entry.offset) + Number(entry.size)).toString('utf8')
    }
  })(header, '')
  return found
}

const events = read('/node_modules/@deepseek-ai/cordis/lib/types/events.js')
if (events === null) { console.log('没找到 events.js'); process.exit(1) }

console.log('=== events.js 里 waterfall 相关的全部内容 ===')
// 抽出含 waterfall 的段落
const lines = events.split('\n')
for (let i = 0; i < lines.length; i++) {
  if (/waterfall|Waterfall|parallel|emit|serial/i.test(lines[i])) {
    console.log(`${String(i + 1).padStart(4)}: ${lines[i]}`)
  }
}
