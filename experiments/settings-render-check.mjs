// 设置页渲染自检：走**有数据的主分支**，用递归遍历确认关键内容都出现了。
//
// ## 这个文件能证明什么、不能证明什么（重要）
//
// **不能证明「设置页渲染正常」。** 它用一个自制的 React/DOM 替身运行组件函数，
// 而 DSH 官方 verification 参考明确说过：
//
//   "Before or after installation, do not … emulate React/DOM, or implement a custom
//    renderer to compensate for missing browser control. A screenshot of a mock page is
//    not verification of the running plugin."
//
// **能证明的是**：组件在「有数据」这条分支上不抛异常，且它产出的元素树里包含预期的
// 文本与类名。这抓的是**代码层面的错误**——本文件确实抓到过一次真问题：
// 替身把子组件的 hook 状态与父组件串了线，导致 TemplateEditor 读到 snapshot 对象而
// 返回 null。那次症状看着像「模板编辑器有 bug」，实际是替身的问题。
//
// 因此它的定位是**开发期的内部一致性检查**，不是验收证据。真正的渲染确认只能由连在
// DSH 上的页面做人眼（或浏览器控制）验证；这一点在 docs/implementation-progress.md
// 的未完成项里如实标注，不拿它冒充。
//
// ## 为什么需要它
//
// 之前那次自检用一个返回 null 的替身 fetch，因此组件停在「正在读取插件状态…」分支就返回了
// ——主分支（开关、模板编辑器、诊断区）一行都没执行过。而主分支才是用户真正看到的，
// 也是字段访问最容易出错的地方（snapshot.clients.liveKinds、dispatch.windowUsed 等）。
//
// ## 做法
//
// 喂一份**与真实 /state 同形状**的假快照，递归走一遍元素树，确认：
//   1. 不抛异常；
//   2. 关键区块都出现了（通用 / 抑制 / 模板 / 铃声 / 限流 / 诊断）；
//   3. 模板编辑器的切换器列出了四个场景；
//   4. 信号表与最近通知被渲染出来；
//   5. 文本字典确实注册进了 locale 服务。
// client.js 是 `__ModuleLoader__.load(...)` 形式的包内半边，**没有 ESM 导出**，
// 因此不能 `import { apply }`。它的加载方式要求先铺好 window.__ModuleLoader__，
// 再动态 import 让它自行注册——静态 import 会在铺好全局量之前就求值，必然失败。
//
// 注意：ESM 有模块缓存，同一个 specifier 只会求值一次。因此这里必须先铺全局量、
// 再 import；不要试图 import 两次来"重新触发"注册。

import { makeDom } from '../scripts/client-style-audit.mjs'
import { makeReact, syncThenable } from '../scripts/client-react-stub.mjs'

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures += 1
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${condition ? '' : '  ' + (detail || '')}`)
}

// ---- 与真实 /state 同形状的快照 ----
const snapshot = {
  ok: true,
  config: {
    enabled: true,
    title: 'DSH Session Alert',
    sound: true,
    onlyRootSessions: true,
    skipAbortedTurns: true,
    suppressWhenFocused: true,
    chime: { enabled: true, source: 'system', filePath: '' },
    rateLimit: { enabled: true, max: 3, windowSeconds: 10, coalesce: true },
    scenarios: {
      turnEnd: { enabled: true, minIntervalSeconds: 0, durationSeconds: 10, body: '{workspace} · {session} 已完成一轮。' },
      question: { enabled: true, minIntervalSeconds: 0, durationSeconds: 10, body: '{workspace} · {session} 在等你回答：{summary}' },
      approval: { enabled: false, minIntervalSeconds: 30, durationSeconds: 10, body: '{workspace} · {session} 等待授权：{tool}' },
      error: { enabled: true, minIntervalSeconds: 0, durationSeconds: 10, body: '{workspace} · {session} 出错：{summary}' },
    },
  },
  contract: {
    scenarios: [
      { id: 'turnEnd', label: '轮次结束', description: 'DSH 完成了一轮回复。', placeholders: ['workspace', 'session', 'time'], defaultBody: '默认一' },
      { id: 'question', label: '等待回答', description: 'Agent 提问。', placeholders: ['workspace', 'session', 'summary', 'time'], defaultBody: '默认二' },
      { id: 'approval', label: '等待授权', description: '需要批准。', placeholders: ['workspace', 'session', 'tool', 'summary', 'time'], defaultBody: '默认三' },
      { id: 'error', label: '执行出错', description: '某个步骤失败。', placeholders: ['workspace', 'session', 'summary', 'time'], defaultBody: '默认四' },
    ],
    variables: [
      { name: 'workspace', description: '所属工作区（目录名）' },
      { name: 'session', description: '会话标题' },
      { name: 'summary', description: '摘要' },
      { name: 'tool', description: '工具名' },
      { name: 'time', description: '触发时间' },
    ],
    scenarioIds: ['turnEnd', 'question', 'approval', 'error'],
  },
  configPath: 'C:\\Users\\fu\\.dsh\\dsh-session-alert\\config.json',
  aumid: { primary: 'DSH Session Alert', registered: true },
  platform: 'win32',
  clients: {
    liveKinds: ['desktop'],
    desktopOnline: true,
    webOnline: false,
    presence: [{ kind: 'desktop', focused: true, ageMs: 1200 }],
    suppressCardNow: true,
  },
  signals: [
    { time: '16:20:40', source: 'turn/end:completed', session: 'session-2624', verdict: 'suppressed:chime-only' },
    { time: '16:19:48', source: 'turn/end:completed', session: 'session-2624', verdict: 'sent:card+button' },
  ],
  dispatch: {
    counters: { sent: 1, blocked: 0, coalesced: 0, duplicate: 0, failed: 0, suppressed: 1, chimes: 1 },
    windowUsed: 1,
    windowMax: 3,
    windowSeconds: 10,
    pendingCoalesced: 0,
    recent: [
      { time: '16:19:48', scenario: 'turnEnd', title: 'DSH Session Alert', body: '我的项目 · 修复登录超时 已完成一轮。', reason: 'sent', ok: true, error: null, actions: 1, via: 'toast（自有 AUMID）' },
    ],
  },
}

// ---- 替身 React / thenable：复用 scripts/client-react-stub.mjs，不再写第二份 ----
//
// 它跨渲染保留状态格与 `useRef` 盒子、按依赖数组决定效应是否重跑、并在卸载时逆序执行
// 清理函数。为什么这三件事都必须有，见那个模块上方的注释——
// 一句话：**替身少模拟一样东西，就会有一整类缺陷在它眼皮底下通过。**
//
// 它最初就长在这个文件里，也是在这里踩过「状态格没按组件隔离」那个坑：
// 当时用一个全局 cells 数组，子组件 TemplateEditor 的 useState('turnEnd') 读到了父组件的
// 第 0 个状态格（也就是 snapshot 对象），active 变成对象 → 场景查找失败 → 组件返回 null。
// 看起来像「模板编辑器有 bug」，实际是替身把两个组件的 hook 串了线。
// **测试替身与生产代码一样需要被怀疑。**
const engine = makeReact()
const react = engine.react

// ---- DOM 替身：复用 scripts/client-style-audit.mjs，不再写第二份 ----
//
// **这里以前有一行 `globalThis.styles = { insert: () => () => {} }`，它是本文件最严重的
// 一处错误，必须单独说明。**
//
// 真实页面上**没有** `styles` 这个符号：它是动态半边的闭包实参，而本插件是静态半边
// （静态半边的物化只传一个实参 `require`）。那行替身把真机上不存在的东西补上了，
// 于是被执行的正是**在真机上永远走不到的分支**——设置页样式一整个迭代周期都没生效，
// 而这里一直显示「通过」。
//
// 教训与 waterfall 缺陷那次同源：**替身比生产代码更需要被怀疑**。
// 一个把环境补全到「代码想当然的样子」的替身，测的是替身自己的假设。
// 样式注入的真判据因此搬去了 scripts/client-style-audit.mjs，那里的替身**拒绝**提供 `styles`。
const dom = makeDom({ withSettingsRoot: true })
// 让端别判定走到 desktop 分支：这是本插件实际的运行端别（用户口径亦为「以桌面端为准」）。
dom.document.documentElement.dataset = { platform: 'win32' }

globalThis.window = { __ModuleLoader__: { load: (d) => { globalThis.__DEF = d } }, addEventListener: () => {}, removeEventListener: () => {} }
globalThis.document = dom.document
globalThis.getComputedStyle = dom.getComputedStyle
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
globalThis.fetch = () => syncThenable({ ok: true, json: () => syncThenable(snapshot) })
globalThis.setTimeout = (fn) => { try { fn() } catch { /* 忽略 */ } ; return 0 }

// client.js 是 `__ModuleLoader__.load(...)` 形式的包内半边，**没有 ESM 导出**，
// 因此不能 `import { apply }`。必须先铺好 window.__ModuleLoader__ 再动态 import
// 让它自行注册——静态 import 会在铺好全局量之前就求值，必然失败。
// 另外 ESM 有模块缓存，同一 specifier 只求值一次，不要试图 import 两次来"重新触发"注册。
const clientUrl = new URL('../lib/client.js', import.meta.url).href
await import(clientUrl)
const definition = globalThis.__DEF
if (definition === undefined) {
  console.log('client.js 没有调用 __ModuleLoader__.load')
  process.exit(1)
}

// ---- 从注册的 slot 里取出组件 ----
const injected = []
const slots = {
  inject: (key, cb) => { injected.push({ key, cb }); return () => {} },
  register: (meta, comp) => { injected.push({ meta, comp }); return () => {} },
}
// 设置页现在按官方模板写法取用 slots：插件声明 `inject: ['slots']`，
// 组件里用 `ctx.slots.inject(...)`，而不是运行时的 `ctx.get('slots')`。
// 替身必须照此提供，否则测的是已废弃的旧路径（会静默不注册，断言全挂）。
//
// 同时提供 `locale`：插件会把文本字典注册进去并绑定翻译函数。
// **只提供 slots 会让本地化那段代码根本不执行**，测不到它会不会抛错。
//
// 替身要**真实**：`bind` 返回的函数应当像真服务那样从**已注册的字典**里取词。
// 早先写成 `bind: () => (key) => key`（回显键名）是错的——那既测不到服务路径，
// 又会因为「服务返回了非空字符串」而绕过本地表回退，导致断言看到一排键名。
// 顺便说：真服务在未命中时也是回显键名，所以那个回退判断是必要的（见 client.js 的 text()）。
const registeredLocaleDicts = []
const localeDicts = new Map()
const localeService = {
  register: (ns, locale, dict) => {
    registeredLocaleDicts.push({ ns, locale, keys: Object.keys(dict).length })
    localeDicts.set(`${ns}\u0000${locale}`, dict)
    return () => {}
  },
  // 像真服务一样：按 (ns, locale) 查字典，未命中则回显键名。
  bind: (ns) => (key) => {
    for (const locale of ['zh', 'en']) {
      const dict = localeDicts.get(`${ns}\u0000${locale}`)
      if (dict !== undefined && dict[key] !== undefined) return dict[key]
    }
    return key
  },
}
const ctx = {
  effect: (fn) => { try { fn() } catch (e) { console.log('  effect 抛错:', e.message) } ; return () => {} },
  get: (name) => (name === 'locale' ? localeService : undefined),
  slots,
}

const clientMod = definition.factory((name) => (name === 'react' ? react : {}))
clientMod.apply(ctx)

if (injected.length === 0) { console.log('未登记 slot'); process.exit(1) }
injected[0].cb()
const reg = injected.find((r) => r.meta !== undefined)
const Section = reg.comp

// ---- 渲染直到稳定（模拟 React 的「渲染 → 提交 → setState → 重渲染」循环）----
let tree = null
let passes = 0
try {
  for (let pass = 0; pass < 6; pass++) {
    const result = engine.render(Section, {})
    tree = result.tree
    passes++
    // 提交：效应在这里跑（真实 React 也是渲染之后再跑 effect）。
    // 依赖数组由替身比较，因此**重复提交不会让效应重跑**——这一点必须由替身保证，
    // 否则「卸载时保存」这类逻辑在替身里会表现成「每渲染一次就存一次」。
    try { result.commit() } catch (error) { console.log('  effect 抛错:', error.message) }
    if (!result.isDirty()) break
  }
} catch (error) {
  check('主分支渲染不抛异常', false, error.message)
  process.exit(1)
}
check('主分支渲染不抛异常', true)
console.log(`  （渲染了 ${passes} 轮后稳定）`)

/** 求值一个函数型子组件，返回它的元素树。 */
function Component_renderSubtree(Component, props) {
  const result = engine.render(Component, props)
  try { result.commit() } catch { /* 子组件的 effect 失败不阻断遍历 */ }
  return result.tree
}

const texts = []
const classNames = []
;(function walk(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return }
  if (Array.isArray(node)) { node.forEach(walk); return }

  // 函数型组件（如 TemplateEditor、Toggle）必须被**求值**，否则它们的内部内容
  // 一条都遍历不到。真实 React 会调用它们；替身遍历器必须做同样的事，
  // 这属于「模拟宿主行为」而不是「放宽断言」——否则测不到的地方正是最容易出错的地方。
  if (typeof node.type === 'function') {
    try {
      // useState/useRef 在子组件里也需要可用：engine 会重置游标，因此这里单独渲染一轮
      const sub = Component_renderSubtree(node.type, node.props)
      walk(sub)
    } catch (error) {
      texts.push('[子组件渲染失败: ' + error.message + ']')
    }
    return
  }

  if (node.props && node.props.className) classNames.push(String(node.props.className))
  if (node.children) node.children.forEach(walk)
})(tree)

// 验证本地化注册确实发生了（此前替身不提供 locale，那段代码根本没执行）
check('向 locale 注册了字典', registeredLocaleDicts.length === 2,
  '实际注册 ' + registeredLocaleDicts.length + ' 条：' + JSON.stringify(registeredLocaleDicts))
check('注册覆盖 zh 与 en（en 是 DSH 的兜底语言，缺它会退化成显示键名）',
  registeredLocaleDicts.some((d) => d.locale === 'zh') && registeredLocaleDicts.some((d) => d.locale === 'en'))

// 设置页标签名：中文「会话通知」，其余语言（DSH 只有 en，且它是兜底语言）「Session Alert」。
// 两组字典的**其余键刻意相同**——通知模板本身是中文的，理由见 client.js 的 TEXTS 注释。
const zhDict = localeDicts.get('dsh-session-alert\u0000zh')
const enDict = localeDicts.get('dsh-session-alert\u0000en')
check('zh 字典的标题是「会话通知」', zhDict !== undefined && zhDict.title === '会话通知',
  `实际 ${JSON.stringify(zhDict && zhDict.title)}`)
check('en 字典的标题是「Session Alert」', enDict !== undefined && enDict.title === 'Session Alert',
  `实际 ${JSON.stringify(enDict && enDict.title)}`)
check('两份字典除标题外内容一致（通知模板是中文的，界面语言与通知内容是两件事）',
  zhDict !== undefined && enDict !== undefined
  && Object.keys(zhDict).filter((k) => k !== 'title').every((k) => zhDict[k] === enDict[k]))

const all = texts.join(' | ')
const hasClass = (c) => classNames.some((x) => x.split(' ').indexOf(c) >= 0)

check('已离开「加载中」占位分支（说明主分支真的渲染了）', !all.includes('正在读取插件状态'), '仍停在占位分支')
check('渲染出卡片区块', classNames.filter((c) => c === 'dsa-card').length >= 5,
  `实际 ${classNames.filter((c) => c === 'dsa-card').length} 个`)
check('出现六个区块标题', ['通用', '专注时抑制', '通知内容', '铃声', '限流', '诊断'].every((t) => all.includes(t)))
check('模板编辑器切换器列出四个场景', ['轮次结束', '等待回答', '等待授权', '执行出错'].every((t) => all.includes(t)))
check('关闭的场景标注「已关」', all.includes('已关'))
// 芯片文案是独立的文本节点，因此这里按**节点相等**匹配。
// 早先我写成 all.includes('{workspace}') 而失败——all 是用 ' | ' 拼起来的，
// 独立节点不会被当成子串命中。改用节点集合既更严格也更符合实际结构。
const chipTexts = ['{workspace}', '{session}', '{time}', '{summary}', '{tool}']
const chipHits = chipTexts.filter((c) => texts.indexOf(c) >= 0)
check('变量芯片按场景渲染（turnEnd 应有 workspace/session/time）',
  texts.indexOf('{workspace}') >= 0 && texts.indexOf('{session}') >= 0 && texts.indexOf('{time}') >= 0,
  '实际芯片: ' + chipHits.join(' '))
check('预览区出现示例工作区名', all.includes('我的项目'))
check('预览区出现示例会话名', all.includes('修复登录超时'))
check('诊断区显示在线端', all.includes('desktop'))
// 「发送这条通知」在「通知内容」卡片里，取代了原先那条与场景无关的「发一条测试通知」。
check('通知内容卡片里有「发送这条通知」按钮', all.includes('发送这条通知'),
  '实际文本里没有「发送这条通知」')
check('页面上不再有「发一条测试通知」按钮', !all.includes('发一条测试通知'),
  '旧按钮的文案仍然出现在页面上')
// 样式诊断的两行。它们是「设置页为什么不好看」的唯一可判定答案来源——
// 样式失效时页面不报任何错，只有这两行能把「没注入」与「注入了没生效」分开。
// 替身注入了 CSS（见上面的 makeDom），因此这里应当读到「已注入」与实测读数。
check('诊断区渲染出样式注入读数', all.includes('样式注入') && all.includes('已注入'),
  '实际文本里没有「样式注入／已注入」')
check('诊断区渲染出样式实测读数（从计算样式读回，不是自报意图）',
  all.includes('display=flex') && all.includes('gap=16px'),
  '实际文本里没有 display=flex / gap=16px')
check('诊断区显示通知署名', all.includes('DSH Session Alert'))
check('诊断区显示配置文件路径', all.includes('config.json'))
check('信号表渲染出判决', all.includes('sent:card+button'))
check('最近通知渲染出投递路径', all.includes('toast（自有 AUMID）'))
check('限流用量被渲染', all.includes('1') && all.includes('3'))
check('抑制状态提示被渲染', all.includes('卡片正被抑制'))

console.log('')
console.log(failures === 0 ? `设置页主分支渲染通过（${texts.length} 个文本节点）。` : `${failures} 项失败。`)
process.exit(failures === 0 ? 0 : 1)

