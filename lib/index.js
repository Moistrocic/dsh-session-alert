/**
 * dsh-session-alert 的 Host 半边。
 *
 * 职责边界：本模块只负责**接线**——监听 DSH 事件、把事件翻译成场景与变量、把渲染与
 * 投递交给 {@link AlertDispatcher}、把设置页要的读写暴露成路由。投递链与分发策略在
 * `notify.js`，配置模型在 `config.js`，跨半边契约在 `contract.js`。
 *
 * ## 为什么监听的是 `session/event` 而不是某个状态事件
 *
 * 一轮结束的**权威依据**是持久日志里的 `turn/end`，它的 `reason.kind` 能区分
 * 「正常结束」「用户打断」「出错」等 7 种情形（见 TurnEndReasonMap）。若改用某个
 * 布尔状态事件，就只能知道「不跑了」，无法区分是跑完了还是被用户按了停止——而后者
 * 恰恰不该提醒。因此以 `turn/end` 为准。
 *
 * ## 为什么每个信号都记录判决
 *
 * 「没收到通知」有两种完全不同的原因：信号根本没到达，或到达后被过滤掉了。从外面看
 * 两者都是沉默。因此每一次到达与每一次跳过都记入 `signals`，并在设置页上呈现——
 * 这是排查「为什么没提醒我」的唯一手段。
 *
 * @module dsh-session-alert
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AlertDispatcher,
  PRIMARY_AUMID,
  clockTime,
  isAumidRegistered,
  powershellCandidates,
  registerAumid,
  runPowerShellFile,
} from './notify.js'
import {
  BODY_LIMIT_BYTES,
  PROTOCOL_SCHEME,
  ROUTE_PREFIX,
  SCENARIOS,
  SCENARIO_IDS,
  SUMMARY_LIMIT,
  VARIABLES,
  protocolUrl,
} from './contract.js'
import {
  SCENARIO_BY_ID,
  configFilePath,
  loadConfig,
  normalizeConfig,
  renderTemplate,
  saveConfig,
} from './config.js'

export const name = 'dsh-session-alert'

/** 本包根目录，用于定位 bin/ 与 scripts/ 下的随包资源。 */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 挑一个 PowerShell 解释器。
 *
 * **必须是 Windows PowerShell 5.1，不能用 pwsh。** PowerShell 7 里
 * `[Windows.UI.Notifications.ToastNotificationManager, ..., ContentType=WindowsRuntime]`
 * 会抛 `Unable to find type`——.NET 5 移除了内置的 WinRT 类型投影。
 * 候选顺序由 notify.js 统一维护（它还要在其中择优支持降级），这里只取第一个。
 */
function pickPowerShellInterpreter() {
  const candidates = powershellCandidates()
  return Array.isArray(candidates) && candidates.length > 0 ? candidates[0] : 'powershell.exe'
}

/** 所有 Host 服务都当作可选，使插件能在任何 profile 里挂载。 */
export const inject = []

/** 信号记录的保留条数。 */
const SIGNAL_LIMIT = 60

/** 同一会话内「turn/end 已处理」与兜底之间的静默窗口。 */
const TURN_END_SETTLE_MS = 1500

/** 把任意抛出的值转成一句话。 */
function errorText(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error === 'object' && typeof error.message === 'string') return error.message
  try {
    return String(error)
  } catch {
    return '未知错误'
  }
}

/** 折叠空白并截断，供通知正文使用。 */
function truncate(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}…` : text
}

/** 取路径最后一段作为工作区名。 */
function basenameOf(path) {
  if (typeof path !== 'string' || path.length === 0) return ''
  const parts = path.split(/[\\/]+/).filter((part) => part.length > 0)
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

/**
 * 挂载插件。
 *
 * @param ctx - 插件的 Cordis 上下文。
 * @param config - loader 行里给出的组合层覆盖值（可选）。
 */
export function apply(ctx, config) {
  const logger = (() => {
    try {
      if (ctx.logger && typeof ctx.logger.info === 'function') return ctx.logger
    } catch {
      // 没有 logger 也不影响功能。
    }
    return undefined
  })()

  /** 记录一条日志。日志失败绝不能影响分发。 */
  const report = (level, message) => {
    if (logger === undefined) return
    try {
      if (level === 'warn' && typeof logger.warn === 'function') logger.warn(`[${name}] ${message}`)
      else logger.info(`[${name}] ${message}`)
    } catch {
      // 忽略。
    }
  }

  let current = normalizeConfig({ ...loadConfig((m) => report('warn', m)), ...(config ?? {}) })

  const dispatcher = new AlertDispatcher({
    getConfig: () => current,
    onEvent: (level, message) => report(level, message),
  })

  // 用 ctx.effect 注册清理：回调本身即清理函数，effect 返回 disposer（同时被 scope 托管）。
  ctx.effect(() => () => dispatcher.dispose(), `${name}: dispatcher`)

  // ---------- AUMID 注册 ----------
  // 注册状态决定通知横幅是否会真的出现：未注册的 AUMID 是合法发送者，但通知会被
  // 接受进操作中心却**不显示横幅**，且不报任何错。因此这里要真的去注册并回报结果。
  let aumid = { primary: PRIMARY_AUMID, registered: isAumidRegistered(PRIMARY_AUMID) }
  if (process.platform === 'win32' && !aumid.registered) {
    void registerAumid()
      .then((registered) => {
        aumid = { primary: PRIMARY_AUMID, registered }
        report('info', registered
          ? `已注册 AUMID「${PRIMARY_AUMID}」，通知将以该名称显示`
          : `未能注册 AUMID「${PRIMARY_AUMID}」，将借用 Windows PowerShell 的 AUMID（横幅仍会出现，但署名不同）`)
      })
      .catch((error) => report('warn', `AUMID 注册失败：${errorText(error)}`))
  }

  /**
   * 确保自有协议方案已注册。
   *
   * **这一步不做，点击通知按钮会静默无反应**：自定义 URL 方案只有登记过，Windows 才
   * 知道该由什么处理它。缺失时的表现是「两端都正常、中间少一环」，属于最难排查的一类
   * 失败——所以这里主动注册并回报结果，而不是等用户来问「为什么点了没反应」。
   *
   * 启动器路径取自本包安装位置。找不到启动器（例如源码清单里漏打包 bin/）时如实告警，
   * 因为那意味着跳转功能不可用。
   */
  async function ensureProtocolRegistered() {
    if (process.platform !== 'win32') return
    const launcher = join(PACKAGE_ROOT, 'bin', 'dsh-session-alert.exe')
    if (!existsSync(launcher)) {
      report('warn', `未找到启动器 ${launcher}，点击通知按钮将无法把窗口带到最上层（通知本身不受影响）。请先运行 npm run build:launcher`)
      return
    }
    const script = join(PACKAGE_ROOT, 'scripts', 'register-protocol.ps1')
    if (!existsSync(script)) {
      report('warn', `未找到协议注册脚本 ${script}，点击通知按钮将无反应`)
      return
    }
    const outcome = await runPowerShellFile(pickPowerShellInterpreter(), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-Scheme', PROTOCOL_SCHEME,
      '-LauncherPath', launcher,
      '-HoldSeconds', String(typeof current.protocolHoldSeconds === 'number' ? current.protocolHoldSeconds : 8),
      '-Quiet',
    ])
    if (outcome.ok) report('info', `协议 ${PROTOCOL_SCHEME} 已注册，点击通知按钮可把窗口带到最上层`)
    else report('warn', `协议 ${PROTOCOL_SCHEME} 注册失败：${outcome.error ?? `退出码 ${outcome.code}`}（点击通知按钮将无反应）`)
  }

  void ensureProtocolRegistered().catch((error) => {
    report('warn', `协议注册过程异常：${errorText(error)}`)
  })

  // ---------- 客户端在线状态 ----------
  /**
   * 各端别的「在线」记录：kind → 最后上报时刻。
   *
   * 为什么按端别记而不是记客户端数量：ADR 0001 明确端别是**范畴性**的——用户可能同时
   * 开着多个 web 页签，但插件只区分「有没有 web 端在看」与「有没有 desktop 端在看」。
   * 记数量会让「三个页签」与「一个页签」产生不同行为，而那不是设计意图。
   *
   * 为什么要过期：崩溃或强制关闭的客户端不会发「我走了」。若只记「曾经上报过」，
   * 一个已经关掉的端会被永远当作在线。客户端每 30 秒心跳一次，因此 90 秒即 3 个
   * 心跳周期没有消息就判定离线。
   */
  const CLIENT_PRESENCE_TTL_MS = 90_000
  const clientPresence = new Map()

  /** 记录一次客户端上报。 */
  function noteClientPresence(kind, focused) {
    if (kind !== 'web' && kind !== 'desktop') return
    clientPresence.set(kind, { at: Date.now(), focused: focused === true })
  }

  /** 当前仍在线的端别集合（已剔除过期项）。 */
  function liveClientKinds() {
    const now = Date.now()
    const live = []
    for (const [kind, record] of clientPresence) {
      if (now - record.at <= CLIENT_PRESENCE_TTL_MS) live.push(kind)
      else clientPresence.delete(kind)
    }
    return live
  }

  /**
   * 是否应抑制这次通知的**卡片**（但仍响铃声）。
   *
   * 仅对 desktop 端生效：web 端可能只是后台开着个页签，用它来判断「用户在看」
   * 会把通知误抑制掉。ADR 0001 明确了抑制是 desktop 端独有的行为。
   */
  function shouldSuppressCard() {
    if (!current.suppressWhenFocused) return false
    const record = clientPresence.get('desktop')
    if (record === undefined) return false
    if (Date.now() - record.at > CLIENT_PRESENCE_TTL_MS) return false
    return record.focused === true
  }

  // ---------- 会话信息 ----------
  const sessionLabels = new Map()

  /**
   * 取会话的展示信息：标题、工作区名。
   *
   * 异步且**失败即降级**：拿不到标题就退化为 id 前 12 位，拿不到 cwd 就退化为空。
   * 通知迟到比通知内容不完整更糟，因此绝不为取标题而阻塞。
   */
  async function describeSession(sessionId) {
    const id = typeof sessionId === 'string' ? sessionId : ''
    const known = sessionLabels.get(id)
    if (known !== undefined && Date.now() - known.at < 30_000) return known

    const info = { title: '', workspace: '', parentSession: undefined, origin: undefined, at: Date.now() }
    try {
      const query = ctx.get('sessionQuery')
      if (query !== undefined && typeof query.readTitleSnapshot === 'function') {
        const snapshot = await query.readTitleSnapshot(id)
        const header = snapshot !== undefined ? snapshot.session : undefined
        if (header !== undefined && header !== null) {
          info.parentSession = header.parentSession
          info.origin = header.origin
          info.workspace = basenameOf(header.cwd)
        }
        const title = snapshot !== undefined && snapshot.title !== undefined ? snapshot.title.title : undefined
        if (typeof title === 'string') info.title = title.trim()
      }
    } catch {
      // 取不到就降级；id 兜底始终可用。
    }

    if (id.length > 0) {
      if (sessionLabels.size > 500) sessionLabels.clear()
      sessionLabels.set(id, info)
    }
    return info
  }

  /** 会话名：标题优先，否则 id 前 12 位。 */
  const sessionLabel = (info, sessionId) => {
    if (typeof info.title === 'string' && info.title.length > 0) return info.title
    const raw = typeof sessionId === 'string' ? sessionId : ''
    if (raw.length === 0) return '未知会话'
    return raw.length > 12 ? raw.slice(0, 12) : raw
  }

  // ---------- 根会话判定 ----------
  /**
   * 某个 session id 是否代表面向用户的根会话（而不是子代理）。
   *
   * **一切不确定的情形都返回 true（fail open）。** 理由：漏报一个本该提醒的会话，
   * 比多报一个子会话更糟——前者的后果是用户在等一个永远不来的通知。
   *
   * 判定按 **id 比较**，绝不按对象同一性：事件载荷里带的 Agent 实例不保证与
   * `roots()` 返回的是同一个包装对象，靠同一性判断会静默吞掉通知（这是踩过的坑）。
   */
  function isRootSession(info, sessionId) {
    const id = typeof sessionId === 'string' ? sessionId : ''
    if (id.length === 0) return true

    // 权威依据一：header 明确标记为子代理来源。
    if (info.origin === 'subagent') return false
    // 权威依据二：有父会话即不是根。
    if (typeof info.parentSession === 'string' && info.parentSession.length > 0) return false

    try {
      const agents = ctx.get('agents')
      if (agents === undefined || typeof agents.roots !== 'function') return true
      const roots = agents.roots()
      if (!Array.isArray(roots) || roots.length === 0) return true
      for (const root of roots) {
        if (root !== null && typeof root === 'object' && root.id === id) return true
      }
      // roots() 有内容但没列出它：DSH 的根会话 id 形如 `session-<uuid>`，
      // 子代理会话是裸 `<uuid>`。据此再放行一次，避免根会话短暂掉出注册表被误判。
      return id.startsWith('session-')
    } catch {
      return true
    }
  }

  // ---------- 信号记录 ----------
  const signals = []
  const noteSignal = (source, sessionId, verdict) => {
    signals.push({
      time: clockTime(Date.now()),
      source,
      session: typeof sessionId === 'string' && sessionId.length > 12 ? sessionId.slice(0, 12) : String(sessionId ?? ''),
      verdict,
    })
    if (signals.length > SIGNAL_LIMIT) signals.shift()
  }

  // ---------- 分发 ----------
  /** 分发一个场景，并把判决记入信号表。 */
  async function dispatch(scenarioId, sessionId, extra, meta) {
    const scenario = SCENARIO_BY_ID.get(scenarioId)
    if (scenario === undefined) return { sent: false, reason: 'unknown-scenario' }

    const info = await describeSession(sessionId)
    if (current.onlyRootSessions && !isRootSession(info, sessionId)) {
      noteSignal(meta.source, sessionId, 'skipped:not-a-root-session')
      return { sent: false, reason: 'not-a-root-session' }
    }

    const vars = {
      workspace: info.workspace || 'DSH',
      session: sessionLabel(info, sessionId),
      summary: extra.summary ?? '',
      tool: extra.tool ?? '',
      time: clockTime(Date.now()),
    }

    const scenarioConfig = current.scenarios[scenarioId]
    const body = renderTemplate(scenarioConfig.body, vars)

    // 抑制：用户在 desktop 端看着界面时不弹卡片，但**铃声照响**。
    // 抑制的理由是「他肯定看到了，卡片是多余噪音」；但「看着界面」不等于「注意力在
    // 这条通知上」，所以听觉通道保留。
    //
    // 判定放在 Host 侧而不是交给分发器读配置：分发器不该知道「焦点」这种端别概念——
    // 那是 ADR 0001 划定的边界（抑制仅对 desktop 端生效，且以各端自报的在线状态为准）。
    const suppressed = shouldSuppressCard()

    // 卡片上的按钮。
    //
    // **端别决定有无控件，事件类型决定控件是什么**（ADR 0001 + 0002）。
    // 按钮是 desktop 端的能力：web 端没有可跳转的应用窗口，给「仅 web 受众」的卡片
    // 携带控件等于承诺一件做不到的事——失败表现是用户看到一个点了没反应的按钮，不报错。
    //
    // 两种形状：
    //   普通场景  -> 一个「知道了」按钮，**只确认收到、不跳转**（跳转由点击卡片本身承担）
    //   审批场景  -> 文案是「去处理…」，**不带确认按钮**
    //
    // 审批场景为什么不是「批准 / 拒绝」：见 ADR 0006。实测 `approval.request` 是
    // **请求方**调用 answerer 的入口，要求开放中的轮次与同进程，而本插件是轮次之外的
    // 外部进程（Windows 投递通知、协议激活的独立启动器接收点击）。因此无法安全地代用户
    // 提交决定，且按钮文案必须与实际行为一致——写成「批准」却只把窗口带上前来，
    // 比没有这个按钮更糟。
    const desktopOnline = liveClientKinds().includes('desktop')
    const isApproval = scenarioId === 'approval'
    const actions = desktopOnline
      ? [{
        content: isApproval ? '去处理…' : '知道了',
        arguments: protocolUrl(sessionId),
        activationType: 'protocol',
      }]
      : []

    const result = dispatcher.dispatch({
      scenario: scenarioId,
      body,
      dedupeKey: meta.dedupeKey,
      suppressed,
      actions,
    })

    // 判决要如实反映「扣了卡片但响了铃」——这与「根本没发」是两回事，
    // 也与「发了卡片」是两回事。混成一个 'sent' 会让排查时看不出发生过抑制。
    // 同时记下卡片形态：无控件的形态是**设计结果**而不是缺陷，诊断时要能区分。
    const shape = actions.length > 0 ? 'card+button' : 'card-only'
    const verdict = result.sent === true
      ? (suppressed ? 'sent:card-withheld' : `sent:${shape}`)
      : (result.reason === 'focused-suppressed' ? 'suppressed:chime-only' : `skipped:${result.reason}`)
    noteSignal(meta.source, sessionId, verdict)
    return result
  }

  // ---------- 事件接线 ----------

  /**
   * 轮次结束的权威记录。
   *
   * `turn/end` 的 `reason.kind` 决定这轮该不该提醒：
   *  - `completed`   → 正常结束，提醒（turnEnd 场景）
   *  - `error`       → 出错本身就是可行动事件，走 error 场景（不重复报「结束」）
   *  - `aborted` /
   *    `interrupted` → 用户主动打断，**不提醒**（可配置）。用户在等一个自己刚刚
   *                    掐掉的任务的通知，是最典型的噪音。
   *  - `blocked` /   → 提醒（它们同样意味着需要人介入）
   *    `max-tokens`
   *  - `forked`      → 不提醒（分叉不是停止）
   */
  ctx.on('session/event', (session, event) => {
    try {
      if (event === null || typeof event !== 'object') return
      if (event.type !== 'turn/end') return
      const sessionId = (session !== null && typeof session === 'object' && typeof session.id === 'string')
        ? session.id
        : ''
      if (sessionId.length === 0) return

      const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
      const reason = data.reason !== null && typeof data.reason === 'object' ? data.reason : {}
      const kind = typeof reason.kind === 'string' ? reason.kind : 'unknown'

      if (kind === 'forked') {
        noteSignal(`turn/end:${kind}`, sessionId, 'skipped:forked')
        return
      }

      if (kind === 'aborted' || kind === 'interrupted') {
        if (current.skipAbortedTurns) {
          const cause = reason.reason !== null && typeof reason.reason === 'object' && typeof reason.reason.kind === 'string'
            ? `-by-${reason.reason.kind}`
            : ''
          noteSignal(`turn/end:${kind}${cause}`, sessionId, 'skipped:user-interrupted')
          return
        }
      }

      if (kind === 'error') {
        // 失败本身走 error 场景；这里不再额外报一条「结束了」。
        const failure = reason.error !== null && typeof reason.error === 'object' ? reason.error : {}
        void dispatch('error', sessionId, {
          summary: truncate(typeof failure.message === 'string' ? failure.message : ''),
        }, { source: 'turn/end:error', dedupeKey: `turn-failed\u0000${sessionId}` })
        return
      }

      void dispatch('turnEnd', sessionId, {}, {
        source: `turn/end:${kind}`,
        dedupeKey: `turn-end\u0000${sessionId}\u0000${data.turn ?? ''}`,
      })
    } catch (error) {
      report('warn', `turn/end 监听器失败：${errorText(error)}`)
    }
  }, { global: true })

  /**
   * Agent 提问：必须由人作答才能继续。
   *
   * ## 这是瀑布（waterfall）监听器，**必须调用并返回 `next()`**
   *
   * cordis 的契约原文（`@deepseek-ai/cordis/lib/types/events.js`）：
   *
   * > The last dispatch argument is treated as the innermost `next`. Listeners run
   * > outermost-first; **a listener that does not call `next()` vetoes the rest of
   * > the chain, including the built-in behavior.**
   *
   * 本插件曾经既不接收 `next` 形参也不调用它——那是一处**严重缺陷**：它把提问的
   * 整个答题链都否决掉了。当时注释里写的是「只观察、不干预——不调用 next 也不改结果，
   * 因此不会影响真正的答题流程」，**那是一句未经验证的假设**，而且正好说反了。
   *
   * 因此这里的写法是：观察 → 无论观察是否成功，都把决定权交还 `next()`。
   * 观察逻辑包在 try 里，**任何异常都不允许阻断链路**——通知是附加功能，
   * 不能因为它出问题而让用户答不了问题。
   *
   * 参数形状以 `cordis_inspect_query` 的 Event 目录为准：
   *   'user-questions/request'(this: Scoped<Agent>, request: …, next: …)
   * `this` 是作用域内的 Agent（监听器的调用者），不在参数列表里。
   */
  // 注意用**普通函数**而不是箭头函数：`this` 是 cordis 传入的作用域 Agent。
  ctx.on('user-questions/request', function (request, next) {
    try {
      const agent = this !== undefined && this !== null ? this.agent : undefined
      const sessionId = agent !== null && agent !== undefined && typeof agent.id === 'string'
        ? agent.id
        : ''
      const payload = request !== null && typeof request === 'object' ? request : {}
      const question = typeof payload.question === 'string'
        ? payload.question
        : (typeof payload.title === 'string' ? payload.title : '')
      void dispatch('question', sessionId, { summary: truncate(question) }, {
        source: 'user-questions/request',
        dedupeKey: `question\u0000${sessionId}`,
      })
    } catch (error) {
      report('warn', `user-questions 监听器失败（不影响答题本身）：${errorText(error)}`)
    }
    // 交出决定权。**这一行不能省。**
    return next()
  }, { global: true })

  /**
   * 工具等待授权。
   *
   * 与提问同理，这是瀑布事件，**必须调用并返回 `next()`**；否则会把整条审批链否决掉，
   * 用户再也看不到审批提示，需要授权的工具会直接失败。见上一个监听器的长注释。
   *
   * **插件绝不在这里替用户作答。** 观察不等于干预：这里只是发一条通知，
   * 决定仍然原样交给 `next()`。ADR 0006 已明确插件不代答，因此这个监听器
   * 不可能改变审批结果——它唯一的输出通道是通知。
   */
  ctx.on('approval/request', function (request, next) {
    try {
      const agent = this !== undefined && this !== null ? this.agent : undefined
      const sessionId = agent !== null && agent !== undefined && typeof agent.id === 'string'
        ? agent.id
        : ''
      const payload = request !== null && typeof request === 'object' ? request : {}
      const tool = typeof payload.toolName === 'string'
        ? payload.toolName
        : (typeof payload.tool === 'string' ? payload.tool : '')
      void dispatch('approval', sessionId, { tool: truncate(tool), summary: truncate(tool) }, {
        source: 'approval/request',
        dedupeKey: `approval\u0000${sessionId}\u0000${tool}`,
      })
    } catch (error) {
      report('warn', `approval 监听器失败（不影响审批本身）：${errorText(error)}`)
    }
    // 交出决定权。**这一行不能省。**
    return next()
  }, { global: true })

  /** 会话级失败（不在某个持久轮次位置上发生的那些）。 */
  ctx.on('api-session/error', (sessionId, message) => {
    try {
      void dispatch('error', sessionId, { summary: truncate(message) }, {
        source: 'api-session/error',
        dedupeKey: `session-error\u0000${sessionId}\u0000${truncate(message)}`,
      })
    } catch (error) {
      report('warn', `api-session/error 监听器失败：${errorText(error)}`)
    }
  })

  // ---------- 设置页路由 ----------
  const routes = []

  /** 写一个 JSON 响应。 */
  function sendJson(response, status, payload) {
    let body
    try {
      body = JSON.stringify(payload)
    } catch {
      body = JSON.stringify({ ok: false, error: '响应无法序列化' })
      status = 500
    }
    response.statusCode = status
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.end(body)
  }

  /**
   * 环回信任栅栏：只接受来自本机环回地址、且 Host 头也是环回名的请求。
   * 这是本机单用户工具，栅栏针对的是跨站浏览器向量，因此不引入令牌机制。
   */
  function isLoopbackRequest(request) {
    const address = request.socket ? request.socket.remoteAddress : undefined
    if (typeof address !== 'string') return false
    const normalized = address.toLowerCase()
    const isV4Loopback = (v) => {
      const parts = v.split('.')
      return parts.length === 4 && parts[0] === '127'
        && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
    }
    const addressOk = normalized === '::1'
      || (normalized.startsWith('::ffff:') ? isV4Loopback(normalized.slice(7)) : isV4Loopback(normalized))
    if (!addressOk) return false
    const host = request.headers.host
    if (typeof host !== 'string') return false
    let hostname
    try {
      hostname = new URL(`http://${host}`).hostname
    } catch {
      return false
    }
    if (!(hostname === 'localhost' || hostname === '[::1]' || isV4Loopback(hostname))) return false
    if (request.headers['sec-fetch-site'] === 'cross-site') return false
    return true
  }

  /** 读取有上限的 JSON 请求体；不可用时 resolve undefined。 */
  function readJsonBody(request) {
    return new Promise((resolve) => {
      const chunks = []
      let size = 0
      let settled = false
      const settle = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      request.on('data', (chunk) => {
        size += chunk.length
        if (size > BODY_LIMIT_BYTES) {
          settle(undefined)
          try { request.destroy() } catch { /* 套接字已断 */ }
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (text.length === 0) { settle(undefined); return }
        try { settle(JSON.parse(text)) } catch { settle(undefined) }
      })
      request.on('error', () => settle(undefined))
    })
  }

  /** 设置页要读的完整状态。 */
  function snapshot() {
    const live = liveClientKinds()
    return {
      config: current,
      contract: {
        scenarios: SCENARIOS,
        variables: VARIABLES,
        scenarioIds: SCENARIO_IDS,
      },
      configPath: configFilePath(),
      aumid: { primary: aumid.primary, registered: aumid.registered },
      platform: process.platform,
      // 端别识别本来完全不可见，出问题只能靠猜。这里如实暴露，让它在设置页上看得见。
      clients: {
        liveKinds: live,
        desktopOnline: live.includes('desktop'),
        webOnline: live.includes('web'),
        presence: [...clientPresence.entries()].map(([kind, record]) => ({
          kind,
          focused: record.focused,
          ageMs: Date.now() - record.at,
        })),
        suppressCardNow: shouldSuppressCard(),
      },
      signals: signals.slice(-SIGNAL_LIMIT),
      dispatch: dispatcher.snapshot(),
    }
  }

  /**
   * 注册设置页的读写路由。
   *
   * ## 两个曾经真实出错的地方
   *
   * ### 一、路由形状：`WebRoute` 是 `{ kind, path, handler }`
   *
   * 契约（`cordis_inspect_query` 的 Service 目录）：
   *   `WebRoute { kind: 'exact' | 'prefix'; path: string; handler }`
   *
   * 本插件原先写的是 `{ method: 'POST', path, handler }` —— **没有 `kind`，
   * 而 `method` 根本不是契约的一部分**。`register` 不校验多余字段，因此它不报错，
   * 只是路由没按预期生效；而未命中的请求由 fallback 回 **404**，正是设置页里
   * 「读取状态失败：HTTP 404」的来源。
   *
   * 现在用一个 `kind: 'prefix'` 路由覆盖 `ROUTE_PREFIX`，在处理器内按 `request.method`
   * 与方法分派——前缀匹配是纯字符串前缀，所以 `…/state` 与 `…/state-extra` 都会进来，
   * 分派时必须用**精确相等**，并且未知路径要回 404 而不是静默落到某个分支。
   *
   * ### 二、服务时机：一次性 `ctx.get` 会静默跳过整块注册
   *
   * 原先写成 `const webServer = ctx.get('webServer'); if (webServer !== undefined) { … }`。
   * 若插件激活时该服务尚未就绪，整块注册被跳过，只剩一条 warn 日志——而**路由全没了**。
   * 官方 practices 的写法是 `ctx.inject([...], (scopedCtx) => …)`：等依赖就绪再执行。
   * DSH 自己的 `client-connection` 正是这么做的：
   *   `ctx.inject(['webServer'], (webCtx) => { webCtx.webServer.register(route) })`
   */
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    if (webServer === undefined || typeof webServer.register !== 'function') {
      report('warn', 'webServer 服务不可用，设置页的读写路由未注册（通知功能不受影响）')
      return
    }

    /** 统一的环回校验；不通过时已写好响应并返回 false。 */
    const fence = (request, response) => {
      if (isLoopbackRequest(request)) return true
      sendJson(response, 403, { ok: false, error: '只接受本机环回请求' })
      return false
    }

    routes.push(webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (request, response) => {
        if (!fence(request, response)) return
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const endpoint = url.pathname.slice(ROUTE_PREFIX.length)
        const method = (request.method ?? 'GET').toUpperCase()

        // 客户端上报端别与焦点。
        //
        // 这条路由**必须存在**：客户端半边按这个路径上报，路径不一致会让上报静默失败，
        // 而失败的表现是「端别永远判为未知」「抑制永远不生效」——都不报错，极难发现。
        if (endpoint === '/client-state' && method === 'POST') {
          const body = await readJsonBody(request)
          if (body === undefined || body === null || typeof body !== 'object') {
            sendJson(response, 400, { ok: false, error: '请求体必须是 JSON 对象' })
            return
          }
          noteClientPresence(body.kind, body.focused)
          sendJson(response, 200, { ok: true, liveKinds: liveClientKinds() })
          return
        }

        if (endpoint === '/state' && method === 'GET') {
          sendJson(response, 200, { ok: true, ...snapshot() })
          return
        }

        if (endpoint === '/config' && method === 'POST') {
          const patch = await readJsonBody(request)
          if (patch === undefined || patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
            sendJson(response, 400, { ok: false, error: '请求体必须是 JSON 对象' })
            return
          }
          current = normalizeConfig({ ...current, ...patch })
          const saved = saveConfig(current)
          // 保存失败仍然应用内存里的改动：让用户当场看到效果，比静默回滚更好，
          // 但要如实回报，否则他会以为设置已经持久化了。
          sendJson(response, saved ? 200 : 500, { ok: saved, config: current, persisted: saved })
          return
        }

        if (endpoint === '/test' && method === 'POST') {
          const outcome = await dispatcher.test()
          sendJson(response, 200, { ok: outcome !== undefined && outcome.ok !== false, outcome })
          return
        }

        if (endpoint === '/clear-activity' && method === 'POST') {
          dispatcher.clearActivity()
          signals.length = 0
          sendJson(response, 200, { ok: true })
          return
        }

        // 未知路径如实回 404：静默落到某个分支会让「哪条路由没生效」变得看不出来。
        sendJson(response, 404, { ok: false, error: `未知端点：${method} ${url.pathname}` })
      },
    }))
  })

  ctx.effect(() => () => {
    for (const dispose of routes) {
      try { dispose() } catch { /* 卸载期间的失败无需上报 */ }
    }
    routes.length = 0
  }, `${name}: routes`)

  report('info', `已挂载；配置 ${configFilePath()}；场景 ${SCENARIO_IDS.join(', ')}`)
}
