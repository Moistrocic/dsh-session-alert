// 重启后的验收检查：**一条命令回答「哪些修复已经在运行环境生效」**。
//
// ## 为什么需要它
//
// 本项目历史上最大的时间黑洞是「改动到底有没有生效」无从判定：调了好几轮样式数值，
// 而 CSS 从来没有进过文档；把「磁盘上的新代码」当成「进程里跑的代码」。
// 因此这里把四件事各做成一条可判定的读数，**不依赖任何人的印象**：
//
//   1. Host 半边在不在（`/state` 能否读到）
//   2. 客户端半边在不在（`liveKinds` 里有没有 desktop）
//   3. **样式链条端到端**：客户端从浏览器读回的 `styles` 读数经 Host 暴露
//      （injected / tags / rules / applied）——这一条同时验证「注入发生了」与
//      「样式真的作用到元素上了」
//   4. **运行中的 client 代码 == 磁盘上的 lib/client.js**（逐字节，忽略 loader 追加的
//      sourcemap 尾部）——这是「我改的东西在不在里面」的硬判据
//
// 另外它会把信号表按来源汇总，并判定 `question` 的正文修复是否生效、
// `approval` 的真实观测是否已完成。
//
// ## 用法
//
//   node experiments/post-restart-check.mjs
//   node experiments/post-restart-check.mjs --base http://127.0.0.1:19387
//
// 退出码：**只有「应当生效却没生效」的项目**才让脚本失败（样式没注入、代码对不上、
// 客户端掉线、Host 读不到）。「尚未观测到 approval」属于信息项，不算失败——
// 它依赖用户把审批策略改成 ask 并让 auto-review 拦下一次调用，见 HANDOFF 第七节。
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const baseIndex = argv.indexOf('--base')
const BASE = (baseIndex >= 0 && argv[baseIndex + 1] !== undefined
  ? argv[baseIndex + 1]
  : (process.env.DSH_WEB_URL || 'http://127.0.0.1:19387')).replace(/\/+$/, '')

const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const ROUTE = `${BASE}/api/dsh-session-alert/state`
const EVENTS = `${BASE}/plugins/events`

let failures = 0
const notes = []

/** 一条可判定的检查。 */
function check(label, condition, detail) {
  if (!condition) failures += 1
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${condition ? '' : `\n         ${detail || ''}`}`)
}

/** 只作记录、不影响退出码的观察。 */
function note(label, detail) {
  notes.push({ label, detail })
  console.log(`  --   ${label}\n         ${detail}`)
}

/**
 * 读一次 SSE 的第一帧 `graph`。
 *
 * `/plugins/events` 是 `@deepseek-ai/dsh-client-hmr` 提供的通道，连上就会先推一帧当前模块图。
 * 它顺便也是「client-hmr 在不在」的判据——改 `lib/client.js` 能不能免重启生效就靠它。
 *
 * **拿到帧之后必须把这条连接关干净**：它是永不结束的流，留着它会让 Node 在退出时
 * 撞上 libuv 的断言（`!(handle->flags & UV_HANDLE_CLOSING)`，退出码变成 0xC0000409），
 * 于是这个脚本「跑完了但退出码是崩的」——用它做验收的人会读到一个假的失败。
 * 修法是显式 `reader.cancel()` + `abort()`，并且最后用 `process.exitCode`
 * 而不是 `process.exit()`，让句柄自然排空。
 */
async function readGraph() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  let reader = null
  try {
    const response = await fetch(EVENTS, { signal: controller.signal })
    reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const line = buffer.split('\n').find((l) => l.startsWith('data: '))
      if (line === undefined) continue
      try {
        const frame = JSON.parse(line.slice(6))
        if (frame.type === 'graph') return frame.graph
      } catch {
        // 半行，继续读。
      }
    }
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    try { if (reader !== null) await reader.cancel() } catch { /* 已关闭 */ }
    try { controller.abort() } catch { /* 已中止 */ }
  }
}

console.log(`目标：${BASE}\n`)

// ---------------------------------------------------------------- 1) Host 半边
let state = null
try {
  const response = await fetch(ROUTE)
  const text = await response.text()
  state = JSON.parse(text)
  check('Host 半边可达：/state 返回 200 且 ok:true', response.status === 200 && state.ok === true,
    `HTTP ${response.status}：${text.slice(0, 200)}`)
} catch (error) {
  check('Host 半边可达：/state 返回 200 且 ok:true', false, `请求失败：${error.message}（DSH 没在跑？端口不对？）`)
}

// ---------------------------------------------------------------- 2) 客户端半边
if (state !== null) {
  const kinds = Array.isArray(state.clients?.liveKinds) ? state.clients.liveKinds : []
  check('客户端半边在线（liveKinds 含 desktop）', kinds.includes('desktop'),
    `liveKinds=${JSON.stringify(kinds)}——客户端半边可能崩了，或未上报`)
  const presence = Array.isArray(state.clients?.presence) ? state.clients.presence : []
  for (const entry of presence) {
    console.log(`         端别 ${entry.kind}：focused=${entry.focused}，最近上报 ${entry.ageMs}ms 前`)
  }
  console.log(`         当前抑制卡片：${state.clients?.suppressCardNow === true}`)

  // ------------------------------------------------------------- 3) 样式链条
  //
  // 注意：`clients.styles` 是**重启后才会出现**的字段（Host 半边的改动）。
  // 它为空时既可能是「Host 未重启」，也可能是「客户端没上报」——
  // 两者都能从下面这行的措辞里看出来，不必猜。
  const styles = Array.isArray(state.clients?.styles) ? state.clients.styles : []
  const desktopStyles = styles.find((s) => s.kind === 'desktop')
  if (desktopStyles === undefined) {
    check('样式读数经 /state 暴露（Host 侧改动已生效）', false,
      styles.length === 0
        ? 'clients.styles 为空：Host 半边仍是旧代码（改了 lib/index.js 就要重启 DSH），' +
          '或客户端还没上报。重启后若仍为空，请看 npm test 的样式审计。'
        : `clients.styles 里没有 desktop：${JSON.stringify(styles)}`)
  } else {
    const report = desktopStyles.report || {}
    const applied = report.applied || null
    check('样式已注入且浏览器解析出规则', report.injected === true && report.tags === 1 && report.rules > 0,
      `injected=${report.injected} tags=${report.tags} rules=${report.rules} error=${report.error}`)
    // **`applied === null` 不是失败**，只表示设置页此刻没有渲染（`.dsa-root` 不在文档里），
    // 因此无从测量。这一点本轮踩过：第一版把它判成 FAIL，于是在应用刚重启、用户还没打开
    // 设置页时，「还没看」被报成「坏了」——**假失败和假通过一样有害**。
    // 只有**测到了却不是 flex** 才是真失败。
    if (applied === null) {
      note('样式实测暂不可测（设置页未渲染）',
        '打开「设置 → SessionAlert」后这一项变成可判定读数：本插件的样式表把 .dsa-root ' +
        '定为 display:flex，而普通 div 是 block/normal。')
    } else {
      check('样式实测作用到元素上（.dsa-root 算成 display:flex）', applied.display === 'flex',
        `applied=${JSON.stringify(applied)}——若为 block，说明样式表在文档里但没匹配到元素`)
    }
    // `dynTags` 是**动态半边**那条路留下的标记（`styles.insert` 打的 `data-dyn`）。
    // 它非零就说明有人把死路加了回来——这条断言与源码审计互为补充。
    check('没有走 `styles.insert` 那条死路（data-dyn 标签数为 0）', (report.dynTags || 0) === 0,
      `dynTags=${report.dynTags}——静态半边不存在这个内置，出现它说明代码被改回去了`)
    console.log(`         读数：${JSON.stringify(report)}（${desktopStyles.ageMs}ms 前）`)
  }

  // ------------------------------------------------------------- 4) 信号表
  const signals = Array.isArray(state.signals) ? state.signals : []
  const bySource = new Map()
  for (const signal of signals) {
    const key = String(signal.source || '')
    bySource.set(key, (bySource.get(key) || 0) + 1)
  }
  console.log(`\n  信号表（${signals.length} 条）：`)
  for (const signal of signals.slice(-12)) {
    console.log(`         ${signal.time}  ${String(signal.source).padEnd(24)} ${signal.verdict}  ${signal.session || ''}`)
  }

  // question 的正文修复是否生效：只有在真的观测到过 question 之后才能判定。
  const questionRows = signals.filter((s) => String(s.source).startsWith('user-questions/request'))
  if (questionRows.length === 0) {
    note('question 尚未在本次运行中观测到',
      '随便问一次问题（或让我用 ask_user_question 问一次），再看这里的 verdict 与正文。')
  } else {
    const recent = Array.isArray(state.dispatch?.recent) ? state.dispatch.recent : []
    const questionNotice = recent.find((r) => r.scenario === 'question')
    if (questionNotice === undefined) {
      note('question 有信号但没有对应的通知记录', `verdict=${questionRows[questionRows.length - 1].verdict}`)
    } else {
      const body = String(questionNotice.body || '')
      // 修复前的正文形如「DSH · 未知会话 正在等待你的回答：」——会话名退化、摘要为空。
      const degraded = body.includes('未知会话') || /等待你的回答：\s*$/.test(body)
      check('question 载荷修复已生效（正文含会话名与问题原文）', degraded === false, `正文：${body}`)
      console.log(`         最近一条 question 正文：${body}`)
    }
  }

  // approval 的真实观测：完成与否是信息项（依赖用户改审批策略），不是失败。
  const approvalRows = signals.filter((s) => String(s.source) === 'approval/request')
  if (approvalRows.length === 0) {
    note('approval 仍未观测到',
      '这不是代码问题：审批策略为 never 时 DSH 根本不会发出 approval/request。' +
      '演练步骤见 HANDOFF.md 第七节（改成 ask → 让 auto-review 拦下一次调用 → 事后改回 never）。')
  } else {
    console.log(`\n  approval 已观测到：${approvalRows.map((r) => r.verdict).join(' / ')}`)
    const recent = Array.isArray(state.dispatch?.recent) ? state.dispatch.recent : []
    const approvalNotice = recent.find((r) => r.scenario === 'approval')
    if (approvalNotice !== undefined) {
      console.log(`         正文：${approvalNotice.body}`)
      const body = String(approvalNotice.body || '')
      check('approval 正文含会话名与工具名', !body.includes('未知会话') && body.includes('工具'),
        `正文：${body}`)
    }
  }
}

// ------------------------------------------------- 5) 运行中的 client 代码 == 磁盘
const graph = await readGraph()
if (graph === null) {
  check('能读到模块图（client-hmr 在线）', false,
    `/plugins/events 没有推出 graph 帧——client-hmr 不在，改 lib/client.js 将不会自动生效`)
} else {
  const row = (graph.entries || []).find((entry) => entry.id === 'dsh-session-alert')
  if (row === undefined) {
    check('模块图里有 dsh-session-alert 这一行', false, '插件没被加载？看设置 → 插件列表')
  } else {
    check('模块图里有 dsh-session-alert 这一行', true)
    console.log(`         运行中的 rev：${row.rev}，inject=${JSON.stringify(row.inject)}`)
    const servedUrl = `${BASE}/${row.url}`
    try {
      const response = await fetch(servedUrl)
      const served = Buffer.from(await response.arrayBuffer())
      const disk = readFileSync(CLIENT_PATH)
      const same = served.length >= disk.length && disk.compare(served, 0, disk.length) === 0
      check('页面收到的 client bundle 与磁盘 lib/client.js 逐字节相同',
        same,
        `served=${served.length}B disk=${disk.length}B；若前者更小或内容不同，说明页面拿到的是旧代码`)
      if (same) {
        console.log(`         磁盘 ${disk.length}B，服务端多出 ${served.length - disk.length}B（loader 追加的 sourcemap 尾部）`)
      }
    } catch (error) {
      check('页面收到的 client bundle 与磁盘 lib/client.js 逐字节相同', false, `取回失败：${error.message}`)
    }
  }
}

// ------------------------------------- 5) 通知最上方那一行（AUMID 显示名）
//
// 用户把通知最上面那一行当作「通知标题」，而它其实是 Windows 按 **AUMID 的显示名**渲染的
// 应用名——toast XML 里的标题行在它下面。插件会在署名变化时把这个注册表值同步过去，
// 同步成功后 toast 里就不再写标题行（否则同一句话出现两次）。
//
// 因此这一条是**可机器判定**的：注册表里的值与配置里的通知署名一致 = 那一行显示的就是它。
if (process.platform === 'win32' && state !== null) {
  const primary = state.aumid?.primary
  const wanted = state.config?.title
  let actual = null
  if (typeof primary === 'string' && primary.length > 0) {
    try {
      const out = execFileSync('reg.exe', [
        'query', `HKCU\\Software\\Classes\\AppUserModelId\\${primary}`, '/v', 'DisplayName',
      ], { encoding: 'utf8' })
      const match = /DisplayName\s+REG_SZ\s+(.*)/.exec(out)
      actual = match === null ? null : match[1].trim()
    } catch {
      actual = null
    }
  }
  check('通知最上方那一行 == 配置里的通知署名（AUMID 显示名已同步）',
    actual !== null && actual === wanted,
    `注册表里是 ${JSON.stringify(actual)}，配置里是 ${JSON.stringify(wanted)}` +
    '——不一致时通知最上方仍显示注册名，插件会在 toast 里保留标题行（不静默，但也不是你要的样子）')
  if (actual !== null) console.log(`         AUMID「${primary}」的显示名：${JSON.stringify(actual)}；titleInAppName=${state.aumid?.titleInAppName}`)
}

// ---------------------------------------------------------------- 汇总
console.log('')
if (notes.length > 0) {
  console.log(`信息项（不影响退出码）：${notes.length} 条`)
  for (const n of notes) console.log(`  · ${n.label}`)
}
if (failures === 0) {
  console.log('\n✔ 所有「应当生效」的项目都已生效。')
} else {
  console.log(`\n✘ ${failures} 项应生效而未生效——逐条看上面的说明。`)
}
// 用 `exitCode` 而不是 `exit()`：SSE 那条连接刚被取消，强行退出会在 libuv 上撞断言，
// 于是退出码变成 0xC0000409——**跑完了却看起来像崩了**。
process.exitCode = failures === 0 ? 0 : 1
