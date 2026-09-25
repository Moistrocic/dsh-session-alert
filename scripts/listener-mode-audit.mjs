// 事件监听器的 dispatch-mode 审计（可复用模块）。
//
// ## 为什么需要它
//
// cordis 的瀑布（waterfall）契约（`@deepseek-ai/cordis/lib/types/events.js`）：
//
//   "The last dispatch argument is treated as the innermost `next`. Listeners run
//    outermost-first; a listener that does not call `next()` vetoes the rest of the
//    chain, including the built-in behavior."
//
// 本插件曾经在 `user-questions/request` 与 `approval/request` 上注册了**不调用 next**
// 的监听器，于是**否决了用户的提问与审批整条链**。而它在功能测试里表现为「一切正常」
// ——处理器确实跑了、也确实没报错。
//
// 这类缺陷无法靠人工记忆避免，因此做成机器校验，并纳入 `npm test`。
//
// ## 判据
//
// - `waterfall` 模式的监听器：处理器体内必须出现 `return next()`
// - 其它模式：不需要 next，也不应把 next 当形参
//
// 事件 mode 表在这里硬编码，来源是 `cordis_inspect_query` 的 Host Event 目录。
// 表里查不到的事件会让审计**失败**而不是跳过，以免新加监听器时漏审。
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** 事件 → dispatch mode。来源：cordis_inspect_query(platform:'host', provider:'Event')。 */
export const EVENT_MODES = {
  'session/event': 'emit',
  'user-questions/request': 'waterfall',
  'approval/request': 'waterfall',
  'api-session/error': 'emit',
}

/**
 * 从源码里找出所有 `ctx.on('event', handler, options)` 注册。
 *
 * 函数体的界定只对**花括号**配平，且从函数体的 `{` 开始数。
 * 这一点曾经写错过：最初对 `(){}[]` 一起配平，于是 `function (request, next)` 的
 * **参数括号**一开一合就把深度降回 0，提取到的片段只有函数签名，
 * `return next()` 自然找不到——审计因此报了两条**假失败**。
 * 教训与本项目其它几次同源：断言错而代码对。
 *
 * @param source - `lib/index.js` 的文本。
 * @returns `{ event, handler, line }[]`。
 */
export function findListenerRegistrations(source) {
  const out = []
  const marker = 'ctx.on('
  let searchFrom = 0
  for (;;) {
    const at = source.indexOf(marker, searchFrom)
    if (at < 0) break
    searchFrom = at + marker.length

    const nameMatch = /^ctx\.on\(\s*'([^']+)'/.exec(source.slice(at, at + 200))
    if (nameMatch === null) continue
    const event = nameMatch[1]

    const afterName = at + nameMatch[0].length
    const commaAt = source.indexOf(',', afterName)
    if (commaAt < 0) continue
    const bodyStart = source.indexOf('{', commaAt)
    if (bodyStart < 0) continue

    let depth = 0
    let end = -1
    for (let j = bodyStart; j < source.length; j++) {
      const ch = source[j]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) { end = j; break }
      }
    }
    if (end < 0) continue

    out.push({
      event,
      handler: source.slice(commaAt + 1, end + 1),
      line: source.slice(0, at).split('\n').length,
    })
  }
  return out
}

/**
 * 审计一个源码文本里的全部监听器注册。
 *
 * @param source - `lib/index.js` 的文本。
 * @returns `{ registrations, problems }`，`problems` 为空即通过。
 */
export function auditListenerModes(source) {
  const registrations = findListenerRegistrations(source)
  const problems = []
  for (const reg of registrations) {
    const mode = EVENT_MODES[reg.event]
    if (mode === undefined) {
      problems.push(`${reg.event}（第 ${reg.line} 行）不在 mode 表里；` +
        '请先用 cordis_inspect_query 查它的 mode 并补进 EVENT_MODES，不要跳过')
      continue
    }
    const hasReturnNext = /return\s+next\s*\(/.test(reg.handler)
    /**
     * 是否**调用**了 `next()`。
     *
     * 判据从「必须 `return next()`」放宽成「必须调用 `next()`」：瀑布监听器可以
     * **先接管、再交出决定权**，例如审批场景——插件把通知按钮的决定与界面那侧的决定
     * 赛跑（`Promise.race([armed.promise, fromUi])`），此时 `next()` 被调用、其结果被
     * 采用，但不是以 `return next()` 的字面形态出现。
     *
     * **放宽不等于不查**：一个从不调用 `next()` 的监听器仍然会被抓出来（那才会否决
     * 后续链）；而且「真的调用了 next()」还有一条行为断言兜着——静态审计看不见
     * `next()` 是不是写在死分支里，行为测试看得见。
     */
    const callsNext = /\bnext\s*\(/.test(reg.handler)
    const takesNext = /\(\s*[^)]*\bnext\b[^)]*\)/.test(reg.handler)
    if (mode === 'waterfall') {
      if (!callsNext) {
        problems.push(`${reg.event}（waterfall，第 ${reg.line} 行）没有调用 next()；` +
          '这会否决后续链，包括内建行为')
      }
    } else {
      if (hasReturnNext) {
        problems.push(`${reg.event}（${mode}，第 ${reg.line} 行）不应调用 next`)
      }
      if (takesNext) {
        problems.push(`${reg.event}（${mode}，第 ${reg.line} 行）形参里的 next 是多余的`)
      }
    }
  }
  return { registrations, problems }
}

/**
 * 读取并审计 `lib/index.js`。
 *
 * @param packageRoot - 包根目录，可以是文件系统路径或 file:// URL。
 *   注意 `new URL('lib/index.js', base)` 要求 base 是**目录 URL**（以斜杠结尾）；
 *   传文件路径字符串时它会被当成相对路径解析，得到错误的位置。
 *   这里统一归一化，避免调用方踩这个坑。
 */
export function auditPackageListeners(packageRoot) {
  const indexUrl = new URL('lib/index.js', toDirectoryUrl(packageRoot))
  const source = readFileSync(indexUrl, 'utf8')
  return auditListenerModes(source)
}

/** 把一个包根路径或 URL 归一化成以斜杠结尾的目录 URL。 */
function toDirectoryUrl(packageRoot) {
  const asUrl = packageRoot instanceof URL
    ? packageRoot
    : isUrlLike(String(packageRoot))
      ? new URL(String(packageRoot))
      : pathToFileURL(String(packageRoot))
  return asUrl.href.endsWith('/') ? asUrl : new URL(`${asUrl.href}/`)
}

/**
 * 判断一个字符串是 URL 而不是 Windows 路径。
 *
 * **`C:\Code\...` 看起来像 `scheme:`，这是 Windows 上的经典陷阱。**
 * 早先写成 `/^[a-zA-Z]+:/` 时，盘符被当成 scheme，`new URL('C:\\...')` 直接抛
 * Invalid URL。因此：单字母 scheme（盘符）排除，且要求 `:` 后面是 `//` 或不是路径分隔符。
 */
function isUrlLike(value) {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value)
  if (match === null) return false
  const scheme = match[1]
  // 单字母且后面紧跟 `\` 或 `/` 视为盘符（Windows 路径）。
  if (scheme.length === 1 && /^[a-zA-Z]:[\\/]/.test(value)) return false
  return true
}
