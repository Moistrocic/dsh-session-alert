// 客户端半边**行为**审计：自动保存（没有保存按钮）与设置页标签名的本地化。
//
// ## 为什么需要它
//
// 「不要保存按钮，改成切换/关闭设置页时自动保存」是一条**行为**需求，而行为最容易
// 在重构里悄悄丢掉：按钮删了、保存却没接上，页面上一切正常，用户的数据没了才发现。
// 因此这里不看「源码里有没有某个字符串」，而是真的把组件挂起来、改一个字段、
// 推着计时器走，看它**有没有把改动写到 Host**。
//
// ## 它覆盖的四种失败（都是这类实现真实的坑）
//
//  1. 改了字段却永远不保存（自动保存没接上）；
//  2. 每敲一下键盘就写一次盘（缺少防抖）；
//  3. **切换/关闭设置页时没落盘**——这正是用户点名要的那一刻，靠组件卸载时的清理函数；
//  4. 「存完又发现改动」的自咬循环（服务端归一化后键序或值与原草稿不同）。
//     这一条尤其阴：它会表现为配置文件被反复写，而界面上完全看不出来。
//
// 替身（`scripts/client-react-stub.mjs`）必须真的模拟 ref 存活、依赖比较与卸载清理，
// 否则上面第 3、4 条在替身里根本测不到——见那个模块的注释。
import { makeDom, uniqueSourceUrl } from './client-style-audit.mjs'
import { makeReact, syncThenable } from './client-react-stub.mjs'

/**
 * 与真实 `/state` **同形状**的假快照（字段取自实测输出，默认值取当前契约）。
 *
 * 放在这里导出，好让 `npm test` 与独立入口 `experiments/client-behavior-audit.mjs`
 * 用同一份——两份快照迟早漂移，而漂移的那份不会有人发现。
 * 注意它是**形状**的样本，不是数值的断言：数值断言在 selftest 里。
 */
export function sampleState() {
  return {
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
        turnEnd: { enabled: true, minIntervalSeconds: 0, durationSeconds: 30, body: '{workspace} · {session} 已完成一轮，等待你的下一步指令。' },
        question: { enabled: true, minIntervalSeconds: 0, durationSeconds: 0, body: '{workspace} · {session} 正在等待你的回答：{summary}' },
        approval: { enabled: true, minIntervalSeconds: 0, durationSeconds: 0, body: '{workspace} · {session} 等待你的授权：工具 {tool}' },
        error: { enabled: true, minIntervalSeconds: 0, durationSeconds: 0, body: '{workspace} · {session} 执行出错：{summary}' },
      },
    },
    contract: {
      scenarios: [],
      variables: [],
      scenarioIds: ['turnEnd', 'question', 'approval', 'error'],
    },
    configPath: 'C:\\Users\\fu\\.dsh\\dsh-session-alert\\config.json',
    aumid: { primary: 'DSH Session Alert', registered: true },
    platform: 'win32',
    clients: {
      liveKinds: ['desktop'],
      desktopOnline: true,
      webOnline: false,
      presence: [{ kind: 'desktop', focused: false, ageMs: 1200 }],
      suppressCardNow: false,
      styles: [],
    },
    signals: [],
    dispatch: {
      counters: { sent: 0, blocked: 0, coalesced: 0, duplicate: 0, failed: 0, suppressed: 0, chimes: 0 },
      windowUsed: 0,
      windowMax: 3,
      windowSeconds: 10,
      pendingCoalesced: 0,
      recent: [],
    },
  }
}

/**
 * 审计一份客户端半边源码的自动保存行为。
 *
 * @param {object} options
 * @param {string} options.source - `lib/client.js` 的文本。
 * @param {object} options.snapshot - 与真实 `/state` 同形状的快照（用于装载）。
 * @returns {Promise<{problems: string[], evidence: object}>} `problems` 为空即通过。
 */
export async function auditClientAutosave(options) {
  const source = options.source
  const snapshot = options.snapshot
  const problems = []
  const evidence = {
    posts: [],
    timersScheduled: 0,
    saveButtonSeen: false,
    hintSeen: false,
    titleZh: null,
    titleEn: null,
    loaded: false,
  }

  const dom = makeDom({ withSettingsRoot: true })
  dom.document.documentElement.dataset = { platform: 'win32' }

  const engine = makeReact()
  const react = engine.react

  // ---- 受控计时器：自动保存的防抖必须是「排一个定时器」，而不是立刻发请求 ----
  let timerSeq = 0
  const timers = new Map()
  const saved = new Map()
  const override = (name, value) => {
    saved.set(name, Object.prototype.hasOwnProperty.call(globalThis, name) ? globalThis[name] : undefined)
    if (value === undefined) delete globalThis[name]
    else globalThis[name] = value
  }

  // ---- 受控 fetch：把「写配置」与「读状态」分开记账 ----
  const configPosts = []
  let definition = null
  const fetchStub = (url, init) => {
    const method = init !== undefined && init !== null && init.method !== undefined ? init.method : 'GET'
    const target = String(url)
    if (target.indexOf('/config') >= 0 && method === 'POST') {
      let body = null
      try { body = JSON.parse(init.body) } catch { body = null }
      configPosts.push(body)
      evidence.posts.push(JSON.stringify(body))
      // Host 会归一化后回给客户端；替身原样回，因此「回填」不该引起第二次保存。
      return syncThenable({ ok: true, json: () => syncThenable({ ok: true, config: body, persisted: true }) })
    }
    if (target.indexOf('/client-state') >= 0 || target.indexOf('/test') >= 0) {
      // 上报与测试通知：组件只调 `.catch()`，返回一个带 catch 的空壳即可。
      return { catch: () => undefined }
    }
    return syncThenable({ ok: true, json: () => syncThenable(snapshot) })
  }

  // ---- 本地化替身：真的按 (ns, locale) 存字典，未命中回显键名（与真服务一致） ----
  const dicts = new Map()
  const localeService = {
    register: (ns, locale, dict) => {
      dicts.set(`${ns}\u0000${locale}`, dict)
      return () => {}
    },
    bind: (ns) => (key) => {
      for (const locale of ['zh', 'en']) {
        const dict = dicts.get(`${ns}\u0000${locale}`)
        if (dict !== undefined && dict[key] !== undefined) return dict[key]
      }
      return key
    },
  }

  let component = null
  const slots = {
    inject: (key, cb) => { cb(); return () => {} },
    register: (meta, comp) => { component = comp; void meta; return () => {} },
  }

  override('window', {
    __ModuleLoader__: { load: (def) => { definition = def } },
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  override('document', dom.document)
  override('getComputedStyle', dom.getComputedStyle)
  // 自动保存必须靠 setTimeout 防抖；这里把计时器接管过来，由审计决定何时触发。
  override('setTimeout', (fn, ms) => {
    timerSeq += 1
    timers.set(timerSeq, { fn, ms })
    evidence.timersScheduled += 1
    return timerSeq
  })
  override('clearTimeout', (id) => { timers.delete(id) })
  override('setInterval', () => 0)
  override('clearInterval', () => {})
  override('fetch', fetchStub)

  const pendingTimers = () => [...timers.values()]
  const fireTimers = () => {
    const due = pendingTimers()
    timers.clear()
    for (const timer of due) timer.fn()
  }

  try {
    // 唯一 URL 由 `uniqueSourceUrl` 统一负责（它带着一段踩坑记录：两个审计各自的
    // 自增计数器会造出同一个 URL，于是在 npm test 里命中模块缓存）。
    await import(uniqueSourceUrl(source))
    if (definition === null) {
      problems.push('源码没有调用 window.__ModuleLoader__.load')
      return { problems, evidence }
    }
    const module = definition.factory((name) => (name === 'react' ? react : {}))
    module.apply({
      effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
      get: (name) => (name === 'locale' ? localeService : undefined),
      on: () => {},
      inject: () => {},
      slots,
    })
  } catch (error) {
    problems.push(`客户端半边 apply 抛错：${error.message}`)
    return { problems, evidence }
  }

  if (component === null) {
    problems.push('没有注册设置页组件（settings.section 的 register 未被调用）')
    return { problems, evidence }
  }

  // ---- 渲染到稳定 ----
  let tree = null
  try {
    for (let pass = 0; pass < 8; pass += 1) {
      const result = engine.render(component, {})
      tree = result.tree
      result.commit()
      if (!result.isDirty()) break
    }
  } catch (error) {
    problems.push(`渲染抛错：${error.message}`)
    return { problems, evidence }
  }
  evidence.loaded = true

  // ---- 收集元素树里的可交互节点 ----
  function walk(node, visit) {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') return
    if (Array.isArray(node)) { for (const item of node) walk(item, visit); return }
    visit(node)
    if (typeof node.type === 'function') {
      // 函数型子组件要求值，否则它们内部的内容一条都遍历不到。
      try {
        const sub = engine.render(node.type, node.props)
        sub.commit()
        walk(sub.tree, visit)
      } catch { /* 子组件渲染失败不阻断收集 */ }
      return
    }
    if (node.children) for (const child of node.children) walk(child, visit)
  }

  const textOf = (node) => {
    const out = []
    const collect = (n) => {
      if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return }
      if (Array.isArray(n)) { for (const item of n) collect(item); return }
      if (n !== null && n !== undefined && n.children) for (const c of n.children) collect(c)
    }
    collect(node)
    return out.join('')
  }

  let numberInput = null
  walk(tree, (node) => {
    const props = node.props || {}
    if (node.type === 'button' && /保存|save/i.test(textOf(node))) evidence.saveButtonSeen = true
    if (typeof props.className === 'string' && props.className.indexOf('dsa-hint') >= 0
      && /自动保存/.test(textOf(node))) evidence.hintSeen = true
    if (node.type === 'input' && props.type === 'number' && typeof props.onChange === 'function' && numberInput === null) {
      numberInput = props
    }
  })

  const configDict = dicts.get('dsh-session-alert\u0000zh')
  const enDict = dicts.get('dsh-session-alert\u0000en')
  evidence.titleZh = configDict === undefined ? null : configDict.title
  evidence.titleEn = enDict === undefined ? null : enDict.title

  // ---- 断言 ----
  if (evidence.saveButtonSeen) {
    problems.push('界面上仍然有「保存」按钮——需求是不要保存按钮，改动应自动保存')
  }
  if (!evidence.hintSeen) {
    problems.push('没有渲染「改动会自动保存」的说明——没有按钮又不说明，用户会去找按钮或不敢关掉设置页')
  }
  if (evidence.titleZh !== '会话通知') {
    problems.push(`zh 字典的标签名应为「会话通知」，实际 ${JSON.stringify(evidence.titleZh)}`)
  }
  if (evidence.titleEn !== 'Session Alert') {
    problems.push(`en（其余语言的兜底）字典的标签名应为「Session Alert」，实际 ${JSON.stringify(evidence.titleEn)}`)
  }
  if (numberInput === null) {
    problems.push('元素树里找不到可改动的数字输入框——审计无法驱动「改一个字段」这一步')
    return { problems, evidence }
  }

  // 一、装载本身不算改动：不该产生任何写盘。
  if (configPosts.length !== 0) {
    problems.push(`刚装载就写了 ${configPosts.length} 次配置——装载不该被当成改动`)
  }

  // 二、改一个字段：应当**排一个定时器**，而不是立刻发请求（防抖）。
  const before = configPosts.length
  numberInput.onChange({ target: { value: '5' } })
  const rerender = () => {
    for (let pass = 0; pass < 4; pass += 1) {
      const result = engine.render(component, {})
      result.commit()
      if (!result.isDirty()) break
    }
  }
  rerender()
  if (configPosts.length !== before) {
    problems.push('改一个字段后立刻写了配置——缺少防抖，用户每敲一下都会写盘')
  }
  if (pendingTimers().length === 0) {
    problems.push('改一个字段后没有排任何定时器——自动保存没有接上')
    return { problems, evidence }
  }

  // 三、推着定时器走：应当恰好写一次，且正文里带着新值。
  const pendingMs = pendingTimers().map((t) => t.ms)
  fireTimers()
  if (configPosts.length !== before + 1) {
    problems.push(`防抖到点后应当恰好写 1 次配置，实际 ${configPosts.length - before} 次`)
  } else {
    const posted = configPosts[configPosts.length - 1]
    const wrote = posted !== null && posted.rateLimit !== undefined && Number(posted.rateLimit.max) === 5
    if (!wrote) {
      problems.push(`写盘的内容里没有新值 rateLimit.max=5：${JSON.stringify(posted && posted.rateLimit)}`)
    }
  }

  // 四、存完不该又觉得「有改动」——那会变成一个反复写盘的自咬循环。
  rerender()
  fireTimers()
  if (configPosts.length !== before + 1) {
    problems.push(`存完之后又写了 ${configPosts.length - before - 1} 次——出现了「存完又发现改动」的循环`)
  }

  // 五、**用户点名的那一刻**：切换或关闭设置页 = 组件卸载，此时必须立刻落盘。
  const beforeUnmount = configPosts.length
  numberInput.onChange({ target: { value: '7' } })
  rerender()
  if (configPosts.length !== beforeUnmount) {
    problems.push('改完之后还没到防抖时间就写了盘（这一步本应等着卸载那一刻）')
  }
  engine.unmount(component)
  if (configPosts.length !== beforeUnmount + 1) {
    problems.push(`卸载（切换/关闭设置页）时应当立刻写 1 次配置，实际 ${configPosts.length - beforeUnmount} 次`)
  } else {
    const posted = configPosts[configPosts.length - 1]
    if (!(posted !== null && posted.rateLimit !== undefined && Number(posted.rateLimit.max) === 7)) {
      problems.push(`卸载时写盘的内容里没有新值 rateLimit.max=7：${JSON.stringify(posted && posted.rateLimit)}`)
    }
  }

  // 六、卸载之后再改什么也不该写盘（界面已经不在了）。
  const afterUnmount = configPosts.length
  fireTimers()
  if (configPosts.length !== afterUnmount) {
    problems.push('卸载之后仍然写了配置——清理没有真正结束')
  }

  evidence.debounceMs = pendingMs
  evidence.postsAfterLoad = configPosts.length
  return { problems, evidence }
}
