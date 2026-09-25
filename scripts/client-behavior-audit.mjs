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
import { SCENARIOS, SCENARIO_IDS, VARIABLES, defaultConfig } from '../lib/contract.js'

/**
 * 与真实 `/state` **同形状**的假快照。
 *
 * `config` 与 `contract` **直接取自契约**（`defaultConfig()` 与 `SCENARIOS`），不手抄。
 * 这不是洁癖：第一版手抄了一份，其中 `contract.scenarios` 写成了空数组，于是
 * `TemplateEditor` 找不到场景、`return null`，**整个「通知内容」卡片在树里根本不存在**——
 * 审计于是「找不到发送按钮」，而那是**审计自己的数据不对**，不是产品的问题。
 * （假失败和假通过一样有害：它会让人去修一个正确的地方。）
 *
 * 只有那些与契约无关的运行时字段（客户端在线状态、活动列表）才是这里写的。
 */
export function sampleState() {
  return {
    ok: true,
    config: defaultConfig(),
    contract: {
      scenarios: SCENARIOS,
      variables: VARIABLES,
      scenarioIds: SCENARIO_IDS,
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
/**
 * 本模块**会临时改写全局**（`setTimeout`/`clearTimeout`/`fetch`）来接管防抖与请求。
 *
 * 这里在模块加载时记下真正的原件：以前只在 `override` 里「保存当前值」，却**从来没有还原**
 * ——于是本模块被 in-process 导入时（`scripts/selftest.mjs` 就是这么用的），
 * 后续所有用例拿到的都是那个**永不触发的假计时器**：任何 `setTimeout` 断言都会静默挂死。
 * 实测就是被这条坑到：一个 10ms 的计时器让整份测试卡到超时。
 */
const PRISTINE_GLOBALS = new Map(
  ['setTimeout', 'clearTimeout', 'fetch'].map((name) => [name, globalThis[name]]),
)

/** 把被改写的全局还原成模块加载时的原件。**必须在 finally 里调用。** */
function restoreGlobals() {
  for (const [name, value] of PRISTINE_GLOBALS) {
    if (value === undefined) delete globalThis[name]
    else globalThis[name] = value
  }
}

export async function auditClientAutosave(options) {
  try {
    return await auditClientAutosaveInner(options)
  } finally {
    restoreGlobals()
  }
}

async function auditClientAutosaveInner(options) {
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

  // ---- 受控 fetch：把「写配置」「发预览」「读状态」分开记账 ----
  const configPosts = []
  const previewPosts = []
  /** 预览端点的应答模式：`'ok'` 正常；`'missing'` 模拟 Host 半边还没重启（404）。 */
  let notifyMode = 'ok'
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
    if (target.indexOf('/notify') >= 0 && method === 'POST') {
      let body = null
      try { body = JSON.parse(init.body) } catch { body = null }
      if (notifyMode === 'missing') {
        // 端点不存在时的真实形状：Host 的前缀路由如实回 404 与一句说明。
        return syncThenable({
          ok: false,
          status: 404,
          json: () => syncThenable({ ok: false, error: '未知端点：POST /api/dsh-session-alert/notify' }),
        })
      }
      previewPosts.push(body)
      return syncThenable({ ok: true, status: 200, json: () => syncThenable({ ok: true, outcome: { sent: true } }) })
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
  //
  // `walk` 带上**祖先链**：有它才能断言「反馈出现在按钮所在的那一行」。
  // 「点了按钮、结果显示在页面底部」正是本轮用户报的「按了没反应」——
  // 只断言「文本存在」是抓不到这种问题的。
  function walk(node, visit, ancestors) {
    const chain = ancestors === undefined ? [] : ancestors
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') return
    if (Array.isArray(node)) { for (const item of node) walk(item, visit, chain); return }
    visit(node, chain)
    if (typeof node.type === 'function') {
      // 函数型子组件要求值，否则它们内部的内容一条都遍历不到。
      try {
        const sub = engine.render(node.type, node.props)
        sub.commit()
        walk(sub.tree, visit, chain)
      } catch { /* 子组件渲染失败不阻断收集 */ }
      return
    }
    const next = chain.concat([node])
    if (node.children) for (const child of node.children) walk(child, visit, next)
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
  let sendButton = null
  let sendButtonRow = null
  let previewText = ''
  const buttonTexts = []
  walk(tree, (node, ancestors) => {
    const props = node.props || {}
    if (node.type === 'button') {
      buttonTexts.push(`${textOf(node)}[${typeof props.className === 'string' ? props.className : ''}]`)
    }
    if (node.type === 'button' && /保存|save/i.test(textOf(node))) evidence.saveButtonSeen = true
    if (typeof props.className === 'string' && props.className.indexOf('dsa-hint') >= 0
      && /自动保存/.test(textOf(node))) evidence.hintSeen = true
    if (node.type === 'input' && props.type === 'number' && typeof props.onChange === 'function' && numberInput === null) {
      numberInput = props
    }
    // 「发送这条通知」是页面上**唯一**的主按钮（保存按钮已经删掉了），因此按类名找它。
    if (node.type === 'button' && typeof props.className === 'string'
      && props.className.indexOf('dsa-btn-primary') >= 0 && sendButton === null) {
      sendButton = { props, text: textOf(node) }
      // 它所在的那一行（`dsa-actions`）：发送结果必须出现在这里面。
      for (let i = ancestors.length - 1; i >= 0; i -= 1) {
        const cls = ancestors[i].props !== undefined && typeof ancestors[i].props.className === 'string'
          ? ancestors[i].props.className
          : ''
        if (cls.indexOf('dsa-actions') >= 0) { sendButtonRow = ancestors[i]; break }
      }
    }
    // 预览区那一行：发送的正文必须与它逐字相同（「看到什么就发什么」）。
    if (typeof props.className === 'string' && props.className.indexOf('dsa-preview-body') >= 0 && previewText === '') {
      previewText = textOf(node)
    }
  })

  /**
   * 读回「发送结果报在哪」。
   *
   * @returns `{ inRow: string|null, anywhere: string|null }`：`inRow` 是出现在发送按钮那一行
   * 里的提示文本，`anywhere` 是页面上任何位置的提示文本。**只出现在别处等于用户看不到**，
   * 而那正是本轮「按了没反应」的成因。
   *
   * 两样东西（按钮所在的行、提示）必须在**同一次遍历**里收集：`walk` 每次遇到函数型组件
   * 都会重新渲染它，于是**每次遍历产生的节点对象都是新的**——拿上一次遍历拿到的行去比
   * 这一次的祖先链永远不会命中。这一点让我连报了两轮假的「没有显示在按钮那一行」。
   */
  function readNotice() {
    let row = null
    const notices = []
    walk(tree, (node, ancestors) => {
      const props = node.props || {}
      const className = typeof props.className === 'string' ? props.className : ''
      if (row === null && node.type === 'button' && className.indexOf('dsa-btn-primary') >= 0) {
        for (let i = ancestors.length - 1; i >= 0; i -= 1) {
          const ancestorClass = ancestors[i].props !== undefined && typeof ancestors[i].props.className === 'string'
            ? ancestors[i].props.className
            : ''
          if (ancestorClass.indexOf('dsa-actions') >= 0) { row = ancestors[i]; break }
        }
      }
      if (className.indexOf('dsa-notice') >= 0) notices.push({ text: textOf(node), chain: ancestors })
    })
    const inRow = notices.find((n) => row !== null && n.chain.indexOf(row) >= 0)
    return {
      inRow: inRow === undefined ? null : inRow.text,
      anywhere: notices.length > 0 ? notices[0].text : null,
    }
  }

  /** 逐叶比较两份配置，返回发生变化的路径与新值。 */
  function diffLeaves(left, right, prefix) {
    const out = []
    const base = prefix === undefined ? '' : prefix
    const keys = new Set([...Object.keys(left === null || left === undefined ? {} : left),
      ...Object.keys(right === null || right === undefined ? {} : right)])
    for (const key of keys) {
      const a = left === null || left === undefined ? undefined : left[key]
      const b = right === null || right === undefined ? undefined : right[key]
      const path = base === '' ? key : `${base}.${key}`
      const bothObjects = a !== null && b !== null && typeof a === 'object' && typeof b === 'object'
        && !Array.isArray(a) && !Array.isArray(b)
      if (bothObjects) out.push(...diffLeaves(a, b, path))
      else if (!Object.is(a, b)) out.push({ path, value: b })
    }
    return out
  }

  const configDict = dicts.get('dsh-session-alert\u0000zh')
  const enDict = dicts.get('dsh-session-alert\u0000en')
  evidence.titleZh = configDict === undefined ? null : configDict.title
  evidence.titleEn = enDict === undefined ? null : enDict.title
  evidence.sendButtonText = sendButton === null ? null : sendButton.text
  evidence.previewText = previewText
  evidence.buttonTexts = buttonTexts

  /**
   * 重渲染到稳定，并**更新 `tree`**。
   *
   * 第一版只渲染不更新，于是后面所有「读回界面」的断言都在看**旧树**：
   * 报出来的是「结果没有显示在按钮那一行（页面上它出现在 null）」——看着像产品没渲染，
   * 其实是审计自己没看新树。
   */
  const rerender = () => {
    for (let pass = 0; pass < 4; pass += 1) {
      const result = engine.render(component, {})
      tree = result.tree
      result.commit()
      if (!result.isDirty()) break
    }
    return tree
  }

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

  // ---- 「发送这条通知」：在「通知内容」卡片里，按当前场景发一条 ----
  const expectedSendLabel = configDict === undefined ? null : configDict.sendPreview
  if (sendButton === null) {
    problems.push('「通知内容」卡片里找不到「发送这条通知」按钮（它是页面上唯一的 dsa-btn-primary）')
  } else {
    if (expectedSendLabel !== null && sendButton.text !== expectedSendLabel) {
      problems.push(`发送按钮的文案应为 ${JSON.stringify(expectedSendLabel)}，实际 ${JSON.stringify(sendButton.text)}`)
    }
    if (previewText === '') {
      problems.push('读不到预览区那一行——无法核对「看到什么就发什么」')
    } else {
      const before = previewPosts.length
      sendButton.props.onClick()
      if (previewPosts.length !== before + 1) {
        problems.push(`点「发送这条通知」应当恰好发一次预览，实际 ${previewPosts.length - before} 次`)
      } else {
        const posted = previewPosts[previewPosts.length - 1]
        if (posted === null || typeof posted !== 'object') {
          problems.push(`预览请求的正文不是 JSON 对象：${JSON.stringify(posted)}`)
        } else {
          if (posted.scenario !== 'turnEnd') {
            problems.push(`预览应当带上当前选中的场景 id（期望 turnEnd），实际 ${JSON.stringify(posted.scenario)}`)
          }
          // **核心断言**：发出的正文与预览区显示的那一行逐字相同。
          if (posted.body !== previewText) {
            problems.push(`发出的正文与预览不一致：预览 ${JSON.stringify(previewText)}，发出 ${JSON.stringify(posted.body)}`)
          }
        }
      }
      rerender()
      // **结果必须报在按钮那一行里。** 「点了按钮、结果显示在页面底部」正是本轮
      // 用户报的「按了没反应」——只断言「文本存在」抓不到它。
      const okNotice = readNotice()
      evidence.noticeInRow = okNotice.inRow
      evidence.noticeAnywhere = okNotice.anywhere
      if (okNotice.inRow === null) {
        problems.push(`发送成功后，结果没有显示在「发送这条通知」那一行（页面上它出现在 ${JSON.stringify(okNotice.anywhere)}）`)
      }

      // 失败路径同样要报在按钮旁边，而且 404 要说清是「Host 半边还没重启」。
      notifyMode = 'missing'
      const beforeFailure = previewPosts.length
      sendButton.props.onClick()
      rerender()
      const failNotice = readNotice()
      evidence.failureNoticeInRow = failNotice.inRow
      if (failNotice.inRow === null) {
        problems.push(`发送失败时，原因没有显示在按钮那一行（页面上它出现在 ${JSON.stringify(failNotice.anywhere)}）`)
      } else if (!/重启/.test(failNotice.inRow)) {
        problems.push(`端点不存在（404）时应当说清是「要重启 DSH」，实际提示是 ${JSON.stringify(failNotice.inRow)}`)
      }
      if (previewPosts.length !== beforeFailure) {
        problems.push('404 探针不该被记成一次成功投递')
      }
      notifyMode = 'ok'
    }
  }

  if (numberInput === null) {
    problems.push('元素树里找不到可改动的数字输入框——审计无法驱动「改一个字段」这一步')
    return { problems, evidence }
  }

  // 一、装载本身不算改动：不该产生任何写盘。
  if (configPosts.length !== 0) {
    problems.push(`刚装载就写了 ${configPosts.length} 次配置——装载不该被当成改动`)
  }
  const loadedConfig = JSON.parse(JSON.stringify(snapshot.config))

  // 二、改一个字段：应当**排一个定时器**，而不是立刻发请求（防抖）。
  const before = configPosts.length
  numberInput.onChange({ target: { value: '5' } })
  rerender()
  if (configPosts.length !== before) {
    problems.push('改一个字段后立刻写了配置——缺少防抖，用户每敲一下都会写盘')
  }
  if (pendingTimers().length === 0) {
    problems.push('改一个字段后没有排任何定时器——自动保存没有接上')
    return { problems, evidence }
  }

  // 三、推着定时器走：应当恰好写一次，且内容里带着刚改的那个值。
  //
  // **不写死字段名**：审计取的是树里第一个数字输入框，而它属于哪张卡片会随页面结构变化
  // （第一版写死 `rateLimit.max`，页面上第一个数字框其实是模板编辑器的「显示时长」，
  //  于是审计报了一个**假失败**）。改判「恰好一处叶子变化、且新值就是刚输入的那个数」，
  // 这样它既与结构无关，也比原来更严：多写一处、写错值都会被抓出来。
  const pendingMs = pendingTimers().map((t) => t.ms)
  fireTimers()
  if (configPosts.length !== before + 1) {
    problems.push(`防抖到点后应当恰好写 1 次配置，实际 ${configPosts.length - before} 次`)
  } else {
    const changed = diffLeaves(loadedConfig, configPosts[configPosts.length - 1])
    if (changed.length !== 1 || Number(changed[0].value) !== 5) {
      problems.push(`写盘的内容应当恰好只有一处变化、且新值为 5，实际 ${JSON.stringify(changed)}`)
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
    const changed = diffLeaves(loadedConfig, configPosts[configPosts.length - 1])
    if (changed.length !== 1 || Number(changed[0].value) !== 7) {
      problems.push(`卸载时写盘的内容应当恰好只有一处变化、且新值为 7，实际 ${JSON.stringify(changed)}`)
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
