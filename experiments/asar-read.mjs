// 从 DSH 的 app.asar 里按路径读取任意文件，或按关键字搜索。
//
// ## 为什么需要它
//
// DSH 装成 asar 归档（`resources/app.asar`）。shell 的 `ls` / `cat` / `grep`、
// 以及 glob 与搜索工具（它们跑原生 ripgrep）都打不开它。而 `node` 可以直接读——
// 这个脚本就是那扇门。
//
// 本项目的实现过程反复需要它：查 cordis 的 waterfall 契约、查 UI 原语的 CSS、
// 查客户端 Builtin 清单、查桌面端与 Host 的通信拓扑，都是靠它拿到的。
//
// ## 用法
//
//   node experiments/asar-read.cjs list   <路径片段>     列出匹配的文件路径
//   node experiments/asar-read.cjs read   <完整路径>     打印该文件内容
//   node experiments/asar-read.cjs grep   <关键字> [路径片段]   在文件里搜索并打印上下文
//
// ## 已知的重要事实（省得下次重新查）
//
// - **官方插件开发技能**：`@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/`
//   （SKILL.md + references/ + templates/）。**这是写 DSH 插件的正确入口**，
//   比逆向 bundle 高效得多。用法：`list cordis-plugin-development` 再逐个 `read`。
// - **cordis 的 waterfall 契约**：`@deepseek-ai/cordis/lib/types/events.js` ——
//   「不调用 next() 会否决整条链，包括内建行为」。
//   查它用 `grep "vetoes the rest" cordis/lib/types`。
// - **UI 原语的 CSS**（用来对齐观感，但**不得 import 该包**）：
//   `list dsh-client-ui-primitives/lib`。
// - **桌面端通信拓扑**：桌面端页面服务在特权 scheme `dsh-app://`；Host 的 HTTP 服务在
//   `http://127.0.0.1:<port>` 且要求浏览器 cookie 认证；桌面端注入
//   `__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }`，连接层据此把请求判为环回，
//   因此页面的相对路径请求不需要 cookie。**外部未认证探测会得到 401，这是预期。**
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const command = argv[0]
const asarPath = process.env.DSH_ASAR
  || String.raw`C:\Code\IDE\Deepseek Harness\resources\app.asar`

if (command === undefined) {
  console.error('用法：node experiments/asar-read.mjs <list|read|grep> <参数>')
  process.exit(2)
}

const buf = readFileSync(asarPath)
const headerSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'))
const base = 16 + headerSize

/** 遍历 asar 里的全部文件条目。 */
function entries() {
  const out = []
  ;(function walk(node, prefix) {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const p = `${prefix}/${name}`
      if (entry.files) { walk(entry, p); continue }
      out.push({ path: p, size: Number(entry.size), offset: base + Number(entry.offset) })
    }
  })(header, '')
  return out
}

const all = entries()

if (command === 'list') {
  const filter = argv[1] ?? ''
  const hits = all.filter((e) => e.path.includes(filter))
  console.log(`${hits.length} 个匹配 "${filter}"（共 ${all.length} 个文件）`)
  for (const e of hits.slice(0, 200)) console.log(`  ${String(e.size).padStart(9)}  ${e.path}`)
  if (hits.length > 200) console.log(`  …还有 ${hits.length - 200} 个`)
} else if (command === 'read') {
  const want = argv[1]
  const hit = all.find((e) => e.path === want)
  if (hit === undefined) {
    console.error(`未找到：${want}`)
    const near = all.filter((e) => e.path.includes(want ?? '')).slice(0, 20)
    if (near.length > 0) { console.error('相近路径：'); for (const e of near) console.error('  ' + e.path) }
    process.exit(1)
  }
  process.stdout.write(buf.subarray(hit.offset, hit.offset + hit.size).toString('utf8'))
} else if (command === 'grep') {
  const needle = argv[1]
  const pathFilter = argv[2] ?? ''
  if (needle === undefined) { console.error('grep 需要关键字'); process.exit(2) }
  // **压平时必须连行首注释标记一起去掉，否则跨行的句子搜不到。**
  //
  // 实测的坑：源码里那句话是
  //     ... vetoes the
  //      * rest of the chain, including the built-in behavior.
  // 只把换行换成空格会得到 `vetoes the * rest of the chain`——中间多出一个 `*`，
  // 于是搜 `vetoes the rest of the` 命中 0。
  //
  // 更值得记的是我当时的反应：以为自己记错了原文。实际上我把两行接起来读时
  // **看不出中间夹着注释符**。引用文本与文件里的字面文本可以不一致，
  // 而这种不一致会让人去怀疑代码而不是怀疑自己的引用。
  let filesScanned = 0
  let hits = 0
  for (const e of all) {
    if (pathFilter !== '' && !e.path.includes(pathFilter)) continue
    if (!/\.(js|mjs|cjs|ts|json|css|md|yml|yaml)$/.test(e.path)) continue
    if (e.size > 3_000_000) continue
    filesScanned++
    const raw = buf.subarray(e.offset, e.offset + e.size).toString('utf8')
    const text = raw
      .replace(/\r?\n[ \t]*(?:\*|\/\/|\/\*|#)[ \t]?/g, ' ') // 行首注释标记
      .replace(/\s*\n\s*/g, ' ')                            // 其余换行折叠
    const at = text.indexOf(needle)
    if (at < 0) continue
    hits++
    console.log(`\n===== ${e.path} =====`)
    console.log(text.slice(Math.max(0, at - 400), at + 700).trim())
    if (hits >= 8) { console.log('\n（已达 8 个文件上限）'); break }
  }
  console.log(`\n扫过 ${filesScanned} 个文件，命中 ${hits} 个`)
} else {
  console.error(`未知命令：${command}`)
  process.exit(2)
}
