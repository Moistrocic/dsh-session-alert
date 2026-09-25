// 客户端半边「样式到底有没有进文档」的审计（可复用模块）。
//
// ## 这一组守的是什么
//
// 设置页的样式曾经**从来没有生效过**，而页面上不报任何错。根因是静态半边用了
// `styles.insert(STYLES)` —— 那是**动态半边**才有的符号。
//
// 证据（读自 DSH 安装包，不是推测）：
//
//  1. `@deepseek-ai/dsh-cordis-client-runner/lib/client.js` 构造
//     `DynamicCordisStyles`（`insert()` 把标签打上 `data-dyn`），并把它作为**闭包实参**
//     传给**动态**半边：`closure(react, taggedConsole(...), styles, host, harnessTrap(), ...)`。
//  2. 静态半边的物化语句是
//     `exports: registered.factory(this.makeRequire(ownerId, edges))`
//     ——**只传一个实参**（`require`）。工厂是 `(require) => {...}`，因此 `styles`
//     在工厂作用域里是自由变量，沿作用域链落到全局。
//  3. 全包里没有 `window.styles`，也没有 `globalThis.styles`（grep 命中 0）。
//
// 于是 `typeof styles !== 'undefined'` 走了 else 分支：代码执行了、日志打了、
// **CSS 一个字符都没进文档**。用户两次反馈「重启后完全没有变化」，都是这个原因。
//
// ## 为什么这个缺陷能活过一轮完整的自检
//
// 因为**自检替身自己造了一个 `globalThis.styles`**（`experiments/settings-render-check.mjs`
// 里那行 `globalThis.styles = { insert: () => () => {} }`）。替身把真实环境里不存在的
// 东西补上了，于是被执行的正是那条在真机上永远走不到的分支——
// **测试只证明了「我能喂饱我自己」**，与 waterfall 缺陷那次同源。
//
// 因此本审计的核心是**在「没有 styles」这个真实条件下运行代码**，并检查文档里
// 到底有没有多出标签。它同时拒绝替身提供 `styles`。
//
// ## 判据（全部是可判定的）
//
//  1. 源码里不得出现 `styles.insert`（静态半边的死路）；
//  2. 运行后 `<head>` 里恰好有 **1 个** `style[data-plugin="dsh-session-alert"]`，
//     且它的文本非空、含 `.dsa-root`；
//  3. 浏览器（替身）把它解析出 **> 0 条规则**——「标签在」与「规则可用」是两件事；
//  4. 实测读数（`getComputedStyle`）显示样式**作用到了元素上**；
//  5. 上报给 Host 的 `client-state` 正文里带着这份读数（机器可读的那一半）；
//  6. 清理函数执行后标签消失（卸载不留孤儿样式）。
//
// `npm test` 里还有两条**变异断言**：去掉注入、以及改回 `styles.insert`，
// 都必须被抓出来。一个不会失败的检查等于没有检查。

/**
 * data: URL 求值的计数器。
 *
 * `import()` 的缓存键就是 URL，而同一份源码算出的 base64 完全相同——因此**同一份源码
 * 跑第二次时模块不会重新求值**，`__ModuleLoader__.load` 不会再被调用。这个计数器把
 * 每次运行的 URL 岔开（见 `runClientHalf`）。
 */
let runCounter = 0

/**
 * 审计用的最小 DOM 替身。只实现被用到的那些 API，遇到不认识的选择器**抛错**。
 */
export function makeDom(options = {}) {  const withSettingsRoot = options.withSettingsRoot !== false

  class Element {
    constructor(tagName) {
      this.tagName = String(tagName).toUpperCase()
      this.attributes = new Map()
      this.textContent = null
      this.parentNode = null
      this.childNodes = []
      this.className = ''
    }

    setAttribute(name, value) { this.attributes.set(String(name), String(value)) }
    getAttribute(name) { return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null }
    hasAttribute(name) { return this.attributes.has(String(name)) }
    removeAttribute(name) { this.attributes.delete(String(name)) }
    appendChild(child) { child.parentNode = this; this.childNodes.push(child); return child }
    removeChild(child) {
      const at = this.childNodes.indexOf(child)
      if (at >= 0) this.childNodes.splice(at, 1)
      child.parentNode = null
      return child
    }
    remove() { if (this.parentNode !== null) this.parentNode.removeChild(this) }
    get classList() { return String(this.className).split(/\s+/).filter((x) => x !== '') }
  }

  const documentElement = new Element('html')
  const head = new Element('head')
  const body = new Element('body')

  /** 设置页的根元素。给了它，「实测」那一层才有东西可测。 */
  const settingsRoot = withSettingsRoot ? new Element('div') : null
  if (settingsRoot !== null) {
    settingsRoot.className = 'dsa-root'
    body.appendChild(settingsRoot)
  }

  /** 全部可达元素（用于选择器匹配）。 */
  const allElements = () => {
    const out = [documentElement, head, body]
    if (settingsRoot !== null) out.push(settingsRoot)
    for (const el of head.childNodes) out.push(el)
    return out
  }

  /**
   * 匹配选择器。
   *
   * **不支持的选择器一律抛错**，不返回空集：静默返回空会让断言变成「空集里没有违规」
   * 这种永远为真的假通过——本项目在路由自检上正是被这种断言坑过（只断言条数、不看形状）。
   */
  function matchAll(selector) {
    const attrMatch = /^([a-zA-Z]+)\[([a-zA-Z-]+)="([^"]*)"\]$/.exec(selector)
    if (attrMatch !== null) {
      const [, tag, attr, value] = attrMatch
      return allElements().filter((el) => el.tagName === tag.toUpperCase() && el.getAttribute(attr) === value)
    }
    const classMatch = /^\.([a-zA-Z0-9_-]+)$/.exec(selector)
    if (classMatch !== null) {
      const name = classMatch[1]
      return allElements().filter((el) => el.classList.indexOf(name) >= 0)
    }
    throw new Error(`DOM 替身不支持的选择器：${selector}（补进 matchAll，不要让它静默返回空集）`)
  }

  /** 把注入的 CSS 数成规则条数。本插件的样式表没有嵌套，因此「}」的个数就是规则数。 */
  function countRules(css) {
    const matches = String(css).match(/\}/g)
    return matches === null ? 0 : matches.length
  }

  const document = {
    head,
    body,
    documentElement,
    visibilityState: 'visible',
    hasFocus: () => true,
    createElement: (tag) => new Element(tag),
    querySelectorAll: (selector) => matchAll(selector),
    querySelector: (selector) => {
      const hits = matchAll(selector)
      return hits.length > 0 ? hits[0] : null
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    get styleSheets() {
      return head.childNodes
        .filter((el) => el.tagName === 'STYLE')
        .map((el) => ({ ownerNode: el, cssRules: new Array(countRules(el.textContent === null ? '' : el.textContent)) }))
    },
  }

  /**
   * 计算样式替身。
   *
   * 它**从真正注入了的 CSS 文本里推**，而不是无条件返回一个好看的值：只有当文档里的
   * 样式表确实含 `.dsa-root{…display:flex…}` 时，`.dsa-root` 才算成 `flex`。
   * 因此「实测」这一层的断言测的是「CSS 是不是真的到了文档里」，而不是替身的常量。
   *
   * （它仍然只是替身：真机上这一层的证据是连在 DSH 上的页面读回的 `getComputedStyle`，
   * 见 docs/implementation-progress.md 的未完成项。）
   */
  function getComputedStyle(el) {
    const css = head.childNodes
      .filter((node) => node.tagName === 'STYLE')
      .map((node) => (node.textContent === null ? '' : String(node.textContent)))
      .join('\n')
    const styled = el !== null && el !== undefined && el.classList.indexOf('dsa-root') >= 0
      && /\.dsa-root\s*\{[^}]*display\s*:\s*flex/.test(css)
    return styled
      ? { display: 'flex', gap: '16px', fontSize: '13px' }
      : { display: 'block', gap: 'normal', fontSize: '16px' }
  }

  return { document, getComputedStyle, settingsRoot, head, body, Element }
}

/**
 * 在受控的全局环境里求值一份客户端半边源码，并 `apply` 它。
 *
 * **全局环境是复原的**：本函数会保存并恢复被它替换的全局量。这一点不是洁癖——
 * `npm test` 里同一个进程还跑着别的用例，泄漏一个 `document` 会让后面的用例
 * 在错误的前提下通过。
 *
 * **它刻意删掉 `globalThis.styles`**：真实页面上没有这个符号（这就是那个缺陷的成因），
 * 替身若把它补上，测的就不再是真机条件。这是本文件存在的全部理由。
 *
 * @param {object} options
 * @param {string} options.source - `lib/client.js` 的文本。
 * @param {object} options.dom - `makeDom()` 的返回值。
 * @returns {Promise<{effects: Array, posts: Array, error: Error|null}>}
 */
export async function runClientHalf(options) {
  const source = options.source
  const dom = options.dom

  const saved = new Map()
  const override = (name, value) => {
    saved.set(name, Object.prototype.hasOwnProperty.call(globalThis, name) ? globalThis[name] : undefined)
    if (value === undefined) delete globalThis[name]
    else globalThis[name] = value
  }

  const effects = []
  const posts = []
  let definition
  let error = null

  // 最小 React 替身。`apply` 不渲染组件（那由 experiments/settings-render-check.mjs 覆盖），
  // 但工厂顶层会 `require('react')`，所以必须有东西可返回。
  const react = {
    createElement: () => null,
    useState: (init) => [init, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
  }

  const timers = []
  override('window', {
    __ModuleLoader__: { load: (def) => { definition = def } },
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  override('document', dom.document)
  override('getComputedStyle', dom.getComputedStyle)
  // **关键的一行**：真实页面上没有 `styles`。补上它，本审计就失去意义。
  override('styles', undefined)
  override('fetch', (url, init) => {
    let body = null
    try { body = JSON.parse(init.body) } catch (parseError) { body = null }
    posts.push({ url: String(url), body })
    return { catch: () => undefined, then: () => undefined }
  })
  override('setInterval', (fn) => { timers.push(fn); return timers.length })
  override('clearInterval', () => {})

  try {
    // 用 data: URL 求值任意源码文本。
    //
    // 为什么不用临时文件：`import()` 按 URL 缓存，同一路径的第二次 import 会拿到
    // **上一次的模块实例**——变异测试（喂一段改过的源码）就会静默地测回原文件，
    // 于是「变异必须被抓出来」那条断言永远通过。data: URL 每次都不同，天然绕开缓存。
    //
    // 但**同一份源码跑两次仍会命中缓存**（base64 相同 → URL 相同），而第二次
    // `__ModuleLoader__.load` 不会再被调用，症状是「源码没有调用 load」这种看着像
    // 源码坏了、其实是运行器坏了 的报错。因此在源码末尾追加一行唯一注释把 URL 岔开。
    // 追加注释是安全的：它不改变任何语义，而且被 `stripComments` 视为注释。
    runCounter += 1
    const marked = `${source}\n// audit-run:${runCounter}\n`
    const dataUrl = `data:text/javascript;base64,${Buffer.from(marked, 'utf8').toString('base64')}`
    await import(dataUrl)

    if (definition === undefined) {
      error = new Error('源码没有调用 window.__ModuleLoader__.load')
      return { effects, posts, error }
    }

    const module = definition.factory((name) => (name === 'react' ? react : {}))
    const ctx = {
      effect: (fn, label) => {
        const dispose = fn()
        effects.push({ label, dispose })
        return () => {}
      },
      get: () => undefined,
      on: () => {},
      // 只记录、不调用回调：本审计的对象是样式注入，不是组件渲染。
      slots: { inject: () => () => {}, register: () => () => {} },
      inject: () => {},
    }
    module.apply(ctx)
  } catch (cause) {
    error = cause
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete globalThis[name]
      else globalThis[name] = value
    }
  }

  return { effects, posts, error }
}

/** 取 `<head>` 里属于本插件的样式标签。 */
function ownedStyleTags(dom) {
  return dom.head.childNodes.filter(
    (el) => el.tagName === 'STYLE' && el.getAttribute('data-plugin') === 'dsh-session-alert',
  )
}

/**
 * 去掉注释，只留可执行代码。
 *
 * **这一步是必需的，而且我第一次就踩了。** 源码里写着这个缺陷的完整说明——
 * 包括「原先写的是 `styles.insert(STYLES)`」这句引用。直接对整份文本做模式匹配，
 * 于是**注释里对缺陷的解释被当成了缺陷本身**，审计对着正确的代码报了一条假失败。
 *
 * 这与本项目其它几次同源：**先确认判据本身成立，再拿它下结论。** 一条「在注释里也会
 * 命中」的规则，判的不是代码。
 *
 * 方向性说明：这个函数只会**删**内容，因此它可能造成漏报（假通过），不会造成误报。
 * 作为「不得出现某个 API」的负面检查，这个方向是安全的。
 *
 * @param {string} source - 源码文本。
 * @returns {string} 去掉 `/* … *\/` 与 `// …` 之后的文本。
 */
export function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
}

/**
 * 审计一份客户端半边源码的样式注入。
 *
 * @param {object} options
 * @param {string} options.source - `lib/client.js` 的文本。
 * @returns {Promise<{problems: string[], evidence: object}>} `problems` 为空即通过。
 */
export async function auditClientStyleInjection(options) {
  const source = options.source
  const problems = []
  const dom = makeDom({ withSettingsRoot: true })

  // --- 源码层先查，且**不因运行失败而跳过** ---
  //
  // 顺序与「不提前 return」都是刻意的：若先跑代码、抛错就返回，那么「改回 styles.insert」
  // 这种变异只会报出一句 `styles is not defined`，而真正该说的是「这条路在真机上不存在」。
  // 报错信息指错方向，比不报错更费时间。
  if (/styles\s*\.\s*insert/.test(stripComments(source))) {
    problems.push('源码里出现 `styles.insert`：静态半边没有这个内置（它是动态半边的闭包实参），' +
      '这条路径在真机上永远不会执行，CSS 不会进文档。改用自己创建 <style> 标签')
  }

  const run = await runClientHalf({ source, dom })
  if (run.error !== null) {
    problems.push(`客户端半边 apply 抛错：${run.error.message}`)
    return { problems, evidence: { error: run.error.message } }
  }

  // --- 行为层：文档里到底有没有多出标签 ---
  //
  // 读数在这里**先取下来**再进生命周期检查：清理函数会把标签移除，
  // 若在最后才读证据，就会得到「规则 0 条」这种与事实相反的记录。
  // （第一版就是这么写的，证据行显示 0 条规则，而检查却是通过的——两份读数不一致，
  //   差一点把「先移除后统计」当成真实现象记进文档。）
  const tags = ownedStyleTags(dom)
  let rules = -1
  let chars = 0
  if (tags.length !== 1) {
    problems.push(`<head> 里应当恰好有 1 个 style[data-plugin="dsh-session-alert"]，实际 ${tags.length} 个`)
  } else {
    const css = tags[0].textContent === null ? '' : String(tags[0].textContent)
    chars = css.length
    if (chars === 0) problems.push('样式标签的文本为空')
    if (css.indexOf('.dsa-root') < 0) problems.push('样式标签里没有 `.dsa-root` 规则——注入的可能是别的内容')
    const sheets = dom.document.styleSheets
    rules = sheets.length > 0 ? sheets[0].cssRules.length : 0
    if (rules <= 0) problems.push('样式标签没有解析出任何规则（标签在，但样式不可用）')
  }

  // --- 上报层：这份读数必须随 client-state 发给 Host，否则机器读不到 ---
  let report = null
  if (tags.length === 1) {
    const posted = run.posts.filter((p) => p.url.indexOf('/client-state') >= 0)
    if (posted.length === 0) {
      problems.push('没有向 /client-state 上报过任何内容')
    } else {
      report = posted[posted.length - 1].body === null ? null : posted[posted.length - 1].body.styles
      if (report === undefined || report === null) {
        problems.push('client-state 的上报正文里没有 styles 字段——样式状态对 Host 不可见')
        report = null
      } else {
        if (report.injected !== true) problems.push(`上报的 styles.injected 应为 true，实际 ${JSON.stringify(report.injected)}`)
        if (report.tags !== 1) problems.push(`上报的 styles.tags 应为 1，实际 ${JSON.stringify(report.tags)}`)
        if (!(report.chars > 0)) problems.push(`上报的 styles.chars 应大于 0，实际 ${JSON.stringify(report.chars)}`)
        if (!(report.rules > 0)) problems.push(`上报的 styles.rules 应大于 0，实际 ${JSON.stringify(report.rules)}`)
        if (report.applied === null || report.applied === undefined) {
          problems.push('上报的 styles.applied 为空——「样式真的作用到元素上了吗」这一层没有读数')
        } else if (report.applied.display !== 'flex') {
          problems.push(`实测 display 应为 flex（.dsa-root 的样式生效），实际 ${JSON.stringify(report.applied.display)}`)
        }
      }
    }
  }

  // --- 生命周期：清理函数必须把标签带走 ---
  for (const effect of run.effects) {
    if (typeof effect.dispose === 'function') {
      try { effect.dispose() } catch (error) {
        problems.push(`效应「${String(effect.label)}」的清理函数抛错：${error.message}`)
      }
    }
  }
  const leftover = ownedStyleTags(dom).length
  if (leftover !== 0) problems.push(`清理之后仍残留 ${leftover} 个样式标签——卸载会留下孤儿样式`)

  return {
    problems,
    evidence: {
      tags: tags.length,
      chars,
      rules,
      effectLabels: run.effects.map((e) => String(e.label)),
      report,
      leftover,
    },
  }
}
