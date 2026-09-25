// 事件接线的替身环境（可复用模块）。
//
// `experiments/events-wiring-check.mjs` 与 `npm test` 都用它——**只有一份实现**。
// 两份逻辑迟早漂移，而漂移的那份不会有人发现；这条在本项目的
// `listener-mode-audit` 上已经写过一次，理由相同。
//
// ## 为什么 `npm test` 也需要它
//
// 因为「载荷形状」这个错误犯过**两次**，而且两次都是同一形态：
//
//  1. 第一次（waterfall 缺陷）：处理器不调用 `next()`，把用户的提问与审批整条链
//     否决掉了。接线测试没发现，因为它自己造了一个 `{agent, request}` 外壳去喂。
//  2. 第二次（本次）：处理器的签名与 `next()` 都改对了，但**载荷字段读错了**——
//     `this.agent.id` 与 `payload.question`。真机上表现为通知正文
//     「… · 未知会话 正在等待你的回答：」：会话名退化、摘要为空，而事件照发、
//     页面上不报任何错。接线测试仍然没发现，因为它喂的是 `{ question: '…' }`。
//
// 两次的共同点：**测试的载荷是测试自己编的**。它只能证明「我能喂饱我自己」。
// 因此这里的载荷**照抄 `cordis_inspect_query` 的 Event 契约**（下方逐字段注明来源），
// 并由 `npm test` 断言渲染结果——包括一条**反向断言**：喂旧的错误形状时，
// 断言必须失败。否则这条检查将来还会再失效一次。
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

/** 替身里的根会话 id。形如 DSH 的根会话（`session-` 前缀），子代理是裸 uuid。 */
export const ROOT_SESSION_ID = 'session-root-1'

/** 替身 `sessionQuery` 返回的会话标题与工作目录。 */
export const SESSION_TITLE = '修复登录超时'
export const WORKSPACE_DIR = 'C:\\\\Code\\\\Projects\\\\我的项目'
export const WORKSPACE_NAME = '我的项目'

/**
 * 建一个**独立**的替身环境并挂载插件。
 *
 * 为什么每个场景必须独立：限流是「每 10 秒最多 N 条」的滑动窗口。若在同一环境里
 * 连着投喂七类事件，后面的会被限流挡掉（实测 `approval` 与 `api-session/error`
 * 就因此变成 `skipped:rate-limit`）。那不是接线问题，但会让断言误报——
 * 而误报比不测更糟，因为它会让人去「修」一个本来就正确的地方。
 *
 * @param {object} [config] - 覆盖插件配置。默认关掉限流与抑制，让场景都能走到投递。
 * @returns {{ handlers: Map<string, Function>, routes: object[], ctxs: object, scoped: object }}
 */
export function freshHarness(config) {
  const handlers = new Map()
  const routes = []
  // cordis 传给监听器的 `this`。
  //
  // **它刻意是空的，不是一个带 `agent` 的对象。** 这一点是实测确定的，不是推测：
  // 真实提问发生后，信号表里 `user-questions/request` 那一行的**会话栏为空**——
  // 也就是说处理器里的 `this.agent.id` 在真机上取不到东西。真实发射点把 agent
  // 并进了载荷（见 `questionRequestPayload()` 的注释），`this` 不是 Agent。
  //
  // 替身早先给它加了 `agent`，那等于把**代码想当然的样子**补进环境里：
  // 于是「从 `this` 取会话」这条在真机上无效的路径，在测试里反而能通过。
  // 这与 `styles` 那次是同一类错误（替身补上了真机不存在的东西），
  // 因此这里改成忠实的空对象；若有代码回退到 `this.agent`，测试会立刻失败。
  const scoped = {}
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    effect: (fn) => { try { fn() } catch { /* 忽略 */ } ; return () => {} },
    get: (name) => {
      if (name === 'sessionQuery') {
        return {
          // **替身按 id 应答，不忽略参数。**
          //
          // 这一点也是被一次「变异没被抓到」逼出来的：最初写成
          // `readTitleSnapshot: async () => ({ title: …, session: … })`，
          // 于是**无论传什么 id 都能查到标题**——把会话 id 的读取改错（改回从 `this` 取，
          // 那是真机上取不到的路径）时，通知正文里照样有会话名，测试因此全绿。
          // 一个忽略输入的替身，会把「输入取错了」这一类缺陷整体遮住。
          readTitleSnapshot: async (id) => (id === ROOT_SESSION_ID
            ? {
              title: { title: SESSION_TITLE },
              session: { cwd: WORKSPACE_DIR, isSeeded: false },
            }
            // 未知会话：DSH 的真实行为是「没有 header / 没有标题」，而不是编一个出来。
            : { title: undefined, session: undefined }),
        }
      }
      if (name === 'agents') return { roots: () => [{ id: ROOT_SESSION_ID }] }
      return undefined
    },
    // 路由注册走 `ctx.inject(['webServer'], cb)` —— 等依赖就绪再执行。
    // 替身必须**同步调用该回调**，否则路由一条都注册不上，而针对路由的断言
    // 会因此静默失效（拿不到 /state 就报「读不到状态」，看起来像插件的问题）。
    inject: (deps, callback) => {
      if (Array.isArray(deps) && deps.includes('webServer')) {
        callback({ webServer: { register: (route) => { routes.push(route); return () => {} } } })
      }
      return () => {}
    },
    on: (event, handler) => { handlers.set(event, handler) },
  }
  // **挂载前把 PowerShell 覆盖指向一个不存在的路径，避免测试写用户的注册表。**
  //
  // `apply()` 会调 `ensureProtocolRegistered()`，它真的会 spawn 一个 Windows PowerShell
  // 去执行 `scripts/register-protocol.ps1`——**那是一处真实的机器副作用**（写
  // `HKCU\Software\Classes\dsh-session-alert`）。实测确认过：替身挂载期间能捕获到
  // `powershell.exe ... -File ...\register-protocol.ps1 -Scheme dsh-session-alert` 进程。
  //
  // 单元测试不该改用户的系统设置，哪怕它是幂等的。`notify.js` 早就为此留了口子：
  // `DSH_SESSION_ALERT_POWERSHELL` 是解释器覆盖项，且 `pickPowerShellInterpreter()`
  // 只取候选表的第一项——指向不存在的文件即 spawn 失败，注册被跳过，只剩一条 warn
  // （替身的 logger 是空实现）。
  //
  // 覆盖是**临时的**：`ensureProtocolRegistered()` 在第一个 await 之前就把解释器路径
  // 求好了（参数在调用点同步求值），因此 `apply` 返回后即可还原。必须还原——
  // `npm test --toast` 那条真机冒烟要用真的解释器。
  const savedOverride = process.env.DSH_SESSION_ALERT_POWERSHELL
  process.env.DSH_SESSION_ALERT_POWERSHELL = join(tmpdir(), 'dsh-session-alert-no-such-powershell.exe')
  try {
    apply(ctx, Object.assign({ suppressWhenFocused: false, rateLimit: { enabled: false } }, config || {}))
  } finally {
    if (savedOverride === undefined) delete process.env.DSH_SESSION_ALERT_POWERSHELL
    else process.env.DSH_SESSION_ALERT_POWERSHELL = savedOverride
  }
  return { handlers, routes, ctxs: scoped, scoped }
}

/**
 * `user-questions/request` 的**真实载荷**。
 *
 * 契约（`cordis_inspect_query`，platform host / provider Event）：
 *
 *   'user-questions/request'( this: Scoped<Agent>, request: AskUserQuestionRequestEvent, next )
 *   AskUserQuestionRequestEvent = { questions: AskUserQuestionItem[]; agent?: Agent; signal? }
 *   AskUserQuestionItem        = { id; question; detail?; header?; options?; multiSelect?; intent? }
 *
 * 更硬的一处依据是发射点自己（`@deepseek-ai/dsh-user-questions/lib/index.js`）：
 *
 *   ctx.waterfall(scopeTarget(agent, agent), 'user-questions/request', { ...request, agent }, noAnswerer)
 *
 * **agent 被并进了载荷**。scoped 事件的路由键也印证：`@deepseek-ai/dsh-scope` 的
 * `scopedSubjectResolvers` 里写着 `'user-questions/request': (args) => args[0]['agent']`。
 *
 * @param {object} [overrides] - 覆盖字段，用于构造「错误形状」做反向断言。
 * @returns {object} 可直接投给监听器的载荷。
 */
export function questionRequestPayload(overrides) {
  return Object.assign({
    questions: [{ id: 'q1', question: '要不要保留旧的迁移脚本？', header: '迁移' }],
    agent: { id: ROOT_SESSION_ID },
  }, overrides || {})
}

/**
 * `approval/request` 的**真实载荷**。
 *
 * 契约：`'approval/request'( this: Scoped<Agent>, req: ApprovalRequestEvent, next )`
 *   `ApprovalRequestEvent = { agent: Agent; toolName: string; callId?; reason?;
 *                             displayReason?: { en: string; [locale]: string }; signal? }`
 *
 * @param {object} [overrides] - 覆盖字段。
 * @returns {object} 可直接投给监听器的载荷。
 */
export function approvalRequestPayload(overrides) {
  return Object.assign({
    agent: { id: ROOT_SESSION_ID },
    toolName: 'run_command',
    reason: '需要执行一条命令',
    displayReason: { en: 'Run a command', zh: '需要执行一条命令' },
  }, overrides || {})
}

/** 等一拍，让 `void dispatch(...)` 的异步链落地。 */
export const tick = () => new Promise((r) => setTimeout(r, 30))

/**
 * 从插件的路由读回信号表、活动列表与客户端状态。
 *
 * 路由形状是**一条 `kind: 'prefix'` 路由**覆盖 `ROUTE_PREFIX`，端点在其处理器内分派。
 * 早先这里按「路径以 `/state` 结尾」去找路由，那个写法对应的是「每端点一条路由」的
 * 旧设计——而**旧设计的路由根本没生效**（缺 `kind` 字段），设置页因此收到 404。
 * 自检当时却绿着，因为它只检查了路由**条数**，没检查**形状**。
 *
 * @param {object[]} routes - 替身捕获到的路由。
 * @returns {Promise<object|null>} `/state` 的正文，或 null（没有前缀路由）。
 */
export async function readState(routes) {
  const route = routes.find((r) => r.kind === 'prefix' && r.path === '/api/dsh-session-alert')
  if (route === undefined) return null
  // 只回正文：调用方关心的是状态内容。状态码由 `probeEndpoints` 单独断言——
  // 那也是「路由分派对不对」的判据所在。
  const result = await callRoute(route, 'GET', '/api/dsh-session-alert/state', undefined)
  return result.status === 200 && result.body !== null && typeof result.body === 'object' ? result.body : null
}

/**
 * 往替身路由打一个请求，返回解析后的正文与**真实状态码**。
 *
 * 用真实的 `Readable` 作为请求体，而不是手写的 async iterator：手写版本与 Node 的
 * 流协议不完全一致，会让读取请求体的处理器抛错，探针于是报错——那是**探针的问题**，
 * 却看起来像端点坏了。
 *
 * **状态码取自替身响应的 `statusCode`，不是从正文里猜的。** 这一点是补测「预览接口
 * 应当回 400」时才发现的：早先的版本把「正文里含『未知端点』」当作 404、其余一律记 200，
 * 于是任何**非 404 的失败**（比如 400）都被记成 200——断言看起来在检查状态码，
 * 实际检查的是那句错误文案。这正是本项目反复强调的那类错误：**先确认判据本身成立**。
 *
 * @param {object} route - 一条路由。
 * @param {string} method - HTTP 方法。
 * @param {string} url - 完整路径。
 * @param {string|undefined} body - 请求体文本。
 * @returns {Promise<{ status: number, body: any }>} 状态码与正文。
 */
export async function callRoute(route, method, url, body) {
  let captured = null
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
  const request = Object.assign(stream, {
    method,
    url,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:19387' },
  })
  const response = {
    statusCode: 0,
    setHeader: () => {},
    end: (text) => { try { captured = JSON.parse(text) } catch { captured = text } },
  }
  let status = 0
  try {
    await route.handler(request, response)
    status = response.statusCode > 0 ? response.statusCode : 200
  } catch (error) {
    status = -1
  }
  return { status, body: captured }
}

/**
 * 上报一次客户端状态。
 *
 * **`npm test` 用它制造「静默但有记录」的投递**：把 desktop 端报成在焦点，
 * 再打开 `suppressWhenFocused` 并关掉铃声，于是通知走抑制路径——
 * 卡片不发、声音不响，但活动列表里留下**完整渲染好的正文**。
 * 这样断言能检查正文渲染，而测试不会在别人机器上弹通知或发声音。
 *
 * @param {object[]} routes - 替身捕获到的路由。
 * @param {string} kind - `web` 或 `desktop`。
 * @param {boolean} focused - 该端是否在焦点。
 * @param {object} [styles] - 样式实测读数（可选）。
 * @returns {Promise<{ status: number, body: any }>} 路由响应。
 */
export async function postClientState(routes, kind, focused, styles) {
  const route = routes.find((r) => r.kind === 'prefix' && r.path === '/api/dsh-session-alert')
  if (route === undefined) return { status: 0, body: null }
  const payload = { kind, focused, at: Date.now() }
  if (styles !== undefined) payload.styles = styles
  return callRoute(route, 'POST', '/api/dsh-session-alert/client-state', JSON.stringify(payload))
}
