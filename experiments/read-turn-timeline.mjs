// 直接读会话持久日志，列出 turn/start 与 turn/end 的时间线。
//
// ## 为什么需要它
//
// 「一轮结束」这类通知依赖 `turn/end` 事件。若某个驱动路径（例如目标轮次）不产生
// turn/end，那类通知在该路径上就不会触发——而这是**驱动方式**的问题，不是插件的问题。
// 要区分二者，唯一可靠的办法是直接看持久日志里事件到底有没有被写入。
//
// ## 日志格式（实测，别照标准 zstd 流写）
//
// 文件是**多个独立 zstd 帧顺序拼接**：第一帧是会话头，之后每帧含若干 JSONL 事件。
// 因此 createZstdDecompress 的流式解压会在第二帧报 "Unknown frame descriptor"——
// 它不是单条 zstd 流。正确做法是按魔数定位每个帧、逐帧独立解压。
//
// 这个格式细节最初让我误以为日志里只有 1 条事件（zstdDecompressSync 只解第一帧）。
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const path = process.argv[2]
if (!path) {
  console.error('用法: node read-turn-timeline.mjs <会话日志路径>')
  process.exit(2)
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 按魔数切分并逐帧解压，返回全部 JSONL 文本。 */
function readFrames(file) {
  const buf = readFileSync(file)
  const offsets = []
  let pos = 0
  for (;;) {
    const idx = buf.indexOf(ZSTD_MAGIC, pos)
    if (idx < 0) break
    offsets.push(idx)
    pos = idx + 4
  }
  const parts = []
  let framesOk = 0
  let framesBad = 0
  for (let i = 0; i < offsets.length; i++) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    try {
      parts.push(zstdDecompressSync(buf.subarray(offsets[i], end)).toString('utf8'))
      framesOk++
    } catch {
      // 单帧解压失败不能让整体失败：日志可能正在被追加，末帧可能不完整。
      framesBad++
    }
  }
  return { text: parts.join(''), framesOk, framesBad }
}

const { text, framesOk, framesBad } = readFrames(path)
const lines = text.split('\n').filter((l) => l.trim().length > 0)
console.log(`帧：解出 ${framesOk} 个，失败 ${framesBad} 个；事件行数 ${lines.length}`)

const fmt = (ms) => {
  if (typeof ms !== 'number') return '?'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const events = []
for (const line of lines) {
  let ev
  try { ev = JSON.parse(line) } catch { continue }
  if (ev.type !== 'turn/start' && ev.type !== 'turn/end') continue
  events.push({
    type: ev.type,
    time: ev.time,
    turn: ev.data ? ev.data.turn : undefined,
    reason: ev.data && ev.data.reason ? ev.data.reason.kind : '',
  })
}

const starts = events.filter((e) => e.type === 'turn/start').length
const ends = events.filter((e) => e.type === 'turn/end').length
console.log(`turn/start = ${starts}   turn/end = ${ends}`)

console.log('\n最后 14 条 turn 事件:')
for (const r of events.slice(-14)) {
  console.log(`  ${fmt(r.time)}  ${r.type.padEnd(10)} turn=${String(r.turn).padStart(3)}  ${r.reason}`)
}

const lastStart = [...events].reverse().find((e) => e.type === 'turn/start')
const lastEnd = [...events].reverse().find((e) => e.type === 'turn/end')
console.log('')
if (lastStart !== undefined && (lastEnd === undefined || lastStart.time > lastEnd.time)) {
  console.log(`结论：最后一次 turn/start(${fmt(lastStart.time)}) 尚无配对的 turn/end —— 轮次进行中。`)
} else if (lastEnd !== undefined) {
  console.log(`结论：最后一次 turn/end 在 ${fmt(lastEnd.time)}（reason=${lastEnd.reason}）。`)
} else {
  console.log('结论：日志里没有任何 turn 事件。')
}
