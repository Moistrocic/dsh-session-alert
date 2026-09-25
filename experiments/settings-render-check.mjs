// 设置页渲染自检：走**有数据的主分支**（此前只测过「加载中」占位分支）。
//
// ## 为什么需要它
//
// 之前那次自检用一个返回 null 的替身 fetch，因此组件停在「正在读取插件状态…」分支就返回了
// ——主分支（开关、模板编辑器、诊断区）一行都没执行过。而主分支才是用户真正看到的，
// 也是字段访问最容易出错的地方（snapshot.clients.liveKinds、dispatch.windowUsed 等）。
//
// 做法：喂一份**与真实 /state 同形状**的假快照，递归走一遍元素树，确认：
//   1. 不抛异常；
//   2. 关键区块都出现了（通用 / 抑制 / 模板 / 铃声 / 限流 / 诊断）；
//   3. 模板编辑器的切换器列出了四个场景；
//   4. 信号表与最近通知被渲染出来。
// client.js 是 `__ModuleLoader__.load(...)` 形式的包内半边，**没有 ESM 导出**，
// 因此不能 `import { apply }`。它的加载方式要求先铺好 window.__ModuleLoader__，
// 再动态 import 让它自行注册——静态 import 会在铺好全局量之前就求值，必然失败。
//
// 注意：ESM 有模块缓存，同一个 specifier 只会求值一次。因此这里必须先铺全局量、
// 再 import；不要试图 import 两次来"重新触发"注册。

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

// ---- 替身 React：必须支持「状态更新后重新渲染」----
//
// 这是本文件最关键的实现。最初我用 `useState: (init) => [init, () => {}]` 的替身，
// 组件永远停在「正在读取插件状态…」——因为 snapshot 从未被写进去。
// **那不是代码缺陷，是替身不会重渲染。**
//
// 真实 React 的流程是：渲染 → 跑 effect → fetch 完成 → setState → 重渲染。
// 这里用「多次渲染 + 跨渲染保留的状态格 + 同步 thenable」复现这个循环：
//   - 状态格**按组件隔离**并跨渲染保留，模拟 React 的 state 存活；
//   - fetch 返回已 resolve 的 thenable，其 then 同步执行，因此 setState 在本次
//     effect 内就落地，下一轮渲染即可见。
//
// **「按组件隔离」这一点我第一版漏了，而且症状极具误导性。** 当时用一个全局 cells
// 数组，于是子组件 TemplateEditor 的 useState('turnEnd') 读到了父组件的第 0 个状态格
// （也就是 snapshot 对象），active 变成对象 → 场景查找失败 → 组件返回 null。
// 看起来像「模板编辑器有 bug」，实际是替身把两个组件的 hook 串了线。
// **测试替身与生产代码一样需要被怀疑。**
function makeReact() {
  const stores = new WeakMap()
  let currentStore = { cells: [] }
  let cursor = 0
  let effects = []
  let dirty = false

  function storeFor(Component) {
    let store = stores.get(Component)
    if (store === undefined) {
      store = { cells: [] }
      stores.set(Component, store)
    }
    return store
  }

  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState: (init) => {
      const store = currentStore
      const index = cursor++
      if (!(index in store.cells)) store.cells[index] = typeof init === 'function' ? init() : init
      const setter = (value) => {
        const next = typeof value === 'function' ? value(store.cells[index]) : value
        // Object.is 语义：相同则不重渲染，避免无限循环。
        if (!Object.is(next, store.cells[index])) {
          store.cells[index] = next
          dirty = true
        }
      }
      return [store.cells[index], setter]
    },
    useEffect: (fn) => { effects.push(fn) },
    useRef: () => ({ current: null }),
  }

  return {
    react,
    /** 渲染一次；返回元素树、本轮收集到的 effect，以及是否请求了重渲染。 */
    render(Component, props) {
      currentStore = storeFor(Component)
      cursor = 0
      effects = []
      dirty = false
      const tree = Component(props)
      return { tree, effects, isDirty: () => dirty }
    },
  }
}
function syncThenable(value) {
  const wrap = (v) => {
    if (v !== null && typeof v === 'object' && typeof v.then === 'function') return v
    return {
      then(onFulfilled) { return wrap(onFulfilled(v)) },
      catch() { return this },
    }
  }
  return wrap(value)
}

const engine = makeReact()
const react = engine.react

globalThis.window = { __ModuleLoader__: { load: (d) => { globalThis.__DEF = d } }, addEventListener: () => {} }
globalThis.setInterval = () => 0
globalThis.styles = { insert: () => () => {} }
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
const registeredLocaleDicts = []
const localeService = {
  register: (ns, locale, dict) => {
    registeredLocaleDicts.push({ ns, locale, keys: Object.keys(dict).length })
    return () => {}
  },
  bind: () => (key) => key,
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

// ---- 渲染直到稳定（模拟 React 的「effect -> setState -> 重渲染」循环）----
let tree = null
let passes = 0
try {
  for (let pass = 0; pass < 6; pass++) {
    const result = engine.render(Section, {})
    tree = result.tree
    passes++
    // 跑本轮的 effect（useEffect 在真实 React 里于渲染后执行）
    for (const effect of result.effects) {
      try { effect() } catch (error) { console.log('  effect 抛错:', error.message) }
    }
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
  for (const effect of result.effects) {
    try { effect() } catch { /* 子组件的 effect 失败不阻断遍历 */ }
  }
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
check('诊断区显示通知署名', all.includes('DSH Session Alert'))
check('诊断区显示配置文件路径', all.includes('config.json'))
check('信号表渲染出判决', all.includes('sent:card+button'))
check('最近通知渲染出投递路径', all.includes('toast（自有 AUMID）'))
check('限流用量被渲染', all.includes('1') && all.includes('3'))
check('抑制状态提示被渲染', all.includes('卡片正被抑制'))

console.log('')
console.log(failures === 0 ? `设置页主分支渲染通过（${texts.length} 个文本节点）。` : `${failures} 项失败。`)
process.exit(failures === 0 ? 0 : 1)

