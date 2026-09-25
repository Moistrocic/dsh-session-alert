// 事件接线自检：用替身 ctx 挂载插件，捕获它注册的事件处理器，投喂合成事件。
//
// ## 为什么需要它
//
// 真实环境里只观测到 `turn/end:completed`。另外三类（error / question / approval）
// 很难稳定地真实触发——造一次模型报错不可靠，而问一次问题要消耗一轮真实交互。
// 但它们的事件接线是可以直接验证的：插件的 `apply(ctx)` 会注册处理器，
// 抓住这些处理器、投喂合成载荷，就能确认「事件 → 场景 → 分发」的正确性。
//
// ## 它不替代什么
//
// 它验证的是**接线**，不是「真实环境下事件会不会到达」。后者只能靠真实观测，
// 已在 docs/implementation-progress.md 里如实标注。
import { Readable } from 'node:stream'
import { apply } from '../lib/index.js'

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures += 1
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${condition ? '' : '  ' + (detail || '')}`)
}

/**
 * 每个场景用**独立的替身环境**验证。
 *
 * 为什么必须隔离：限流是「每 10 秒最多 N 条」的滑动窗口，若在同一环境里连着投喂
 * 七类事件，后面的会被限流挡掉（实测 approval 与 api-session/error 就因此变成
 * `skipped:rate-limit`）。那不是接线问题，但会让断言误报——而误报比不测更糟，
 * 因为它会让人去"修"一个本来就正确的地方。
 */
function freshHarness(config) {
  const handlers = new Map()
  const routes = []
  // cordis 传入的作用域对象（`this`）。真实签名是 `(this: Scoped<Agent>, …)`，
  // 因此处理器用 `this.agent.id` 取会话；替身必须提供它，否则测不到这条路径。
  const scoped = { agent: { id: 'session-root-1' } }
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    effect: (fn) => { try { fn() } catch { /* 忽略 */ } ; return () => {} },
    get: (name) => {
      if (name === 'sessionQuery') {
        return {
          readTitleSnapshot: async () => ({
            title: { title: '修复登录超时' },
            session: { cwd: 'C:\\\\Code\\\\Projects\\\\我的项目', isSeeded: false },
          }),
        }
      }
      if (name === 'agents') return { roots: () => [{ id: 'session-root-1' }] }
      return undefined
    },
    // 路由注册现在走 `ctx.inject(['webServer'], cb)` —— 等依赖就绪再执行。
    // 替身必须**同步调用该回调**，否则路由一条都注册不上，而本文件针对路由的断言
    // 会因此静默失效（拿不到 /state 就报「读不到状态」，看起来像插件的问题）。
    inject: (deps, callback) => {
      if (Array.isArray(deps) && deps.includes('webServer')) {
        callback({ webServer: { register: (route) => { routes.push(route); return () => {} } } })
      }
      return () => {}
    },
    on: (event, handler) => { handlers.set(event, handler) },
  }
  // 关掉限流与抑制，让每个场景都能独立地走到投递
  apply(ctx, Object.assign({ suppressWhenFocused: false, rateLimit: { enabled: false } }, config || {}))
  return { handlers, routes, ctxs: scoped }
}

/**
 * 从插件的路由读回信号表与活动列表。
 *
 * 路由形状是**一条 `kind: 'prefix'` 路由**覆盖 ROUTE_PREFIX，端点在其处理器内分派。
 * 早先这里按「路径以 `/state` 结尾」去找路由，那个写法对应的是「每个端点一条路由」的
 * 旧设计——而**旧设计的路由根本没生效**（缺 `kind` 字段），设置页因此收到 404。
 * 自检当时却绿着，因为它只检查了路由**条数**，没检查**形状**。
 */
async function readState(routes) {
  const route = routes.find((r) => r.kind === 'prefix' && r.path === '/api/dsh-session-alert')
  if (route === undefined) return null
  let captured = null
  await route.handler(
    {
      method: 'GET',
      url: '/api/dsh-session-alert/state',
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:19387' },
    },
    { statusCode: 0, setHeader: () => {}, end: (body) => { captured = JSON.parse(body) } },
  )
  return captured
}

const tick = () => new Promise((r) => setTimeout(r, 30))

/**
 * 逐端点探测前缀路由的**分派是否正确**。
 *
 * 只断言「路由注册了」不够：真正出错的地方是分派——端点名、HTTP 方法、未知路径的回退。
 * 这里按「方法 + 路径」逐一打进去，拿回状态码。
 *
 * @returns `Map<'GET /path', statusCode>`。
 */
async function probeEndpoints(routes) {
  const route = routes.find((r) => r.kind === 'prefix')
  const out = new Map()
  if (route === undefined) return out
  const probes = [
    ['GET', '/api/dsh-session-alert/state', undefined],
    ['GET', '/api/dsh-session-alert/nope', undefined],
    ['POST', '/api/dsh-session-alert/state', '{}'],
    ['POST', '/api/dsh-session-alert/client-state', '{"kind":"desktop","focused":false}'],
    ['POST', '/api/dsh-session-alert/test', '{}'],
    ['POST', '/api/dsh-session-alert/clear-activity', '{}'],
  ]
  for (const [method, url, body] of probes) {
    let status = 0
    let captured = null
    // 用真实的 Readable 作为请求体，而不是手写的 async iterator。
    // 手写版本与 Node 的流协议不完全一致，会让读取请求体的处理器抛错，
    // 于是探针报 -1——那是**探针的问题**，却看起来像端点坏了。
    const stream = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
    const request = Object.assign(stream, {
      method,
      url,
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:19387' },
    })
    try {
      await route.handler(request, {
        statusCode: 0,
        setHeader: () => {},
        end: (text) => { try { captured = JSON.parse(text) } catch { captured = text } },
      })
      status = 200
    } catch (error) {
      status = -1
    }
    // 未知端点回 404——替身没保存 statusCode，因此按响应体识别。
    const text = typeof captured === 'string' ? captured : JSON.stringify(captured)
    if (text.includes('未知端点')) status = 404
    out.set(`${method} ${url}`, status)
  }
  return out
}

// ---- 逐场景隔离验证 ----
const cases = [
  {
    label: '轮次正常结束 -> turnEnd',
    fire: (h) => h.get('session/event')({ id: 'session-root-1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
    expectSource: 'turn/end:completed',
    expectScenario: 'turnEnd',
  },
  {
    label: '轮次出错 -> error（不重复报「结束」）',
    fire: (h) => h.get('session/event')({ id: 'session-root-1' }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: '连接被拒绝' } } } }),
    expectSource: 'turn/end:error',
    expectScenario: 'error',
    expectBodyHas: '连接被拒绝',
  },
  {
    label: '用户打断 -> 跳过',
    fire: (h) => h.get('session/event')({ id: 'session-root-1' }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } } }),
    expectSource: 'turn/end:aborted-by-user',
    expectSkipped: true,
  },
  {
    label: '分叉 -> 跳过',
    fire: (h) => h.get('session/event')({ id: 'session-root-1' }, { type: 'turn/end', data: { turn: 4, reason: { kind: 'forked' } } }),
    expectSource: 'turn/end:forked',
    expectSkipped: true,
  },
  {
    label: 'Agent 提问 -> question',
    // 真实签名：'user-questions/request'(this: Scoped<Agent>, request, next)
    // 载荷就是 request 本身，**不带** {agent, request} 外壳；sessionId 取自 `this`。
    fire: (h, scoped) => h.get('user-questions/request').call(scoped, { question: '要不要保留旧的迁移脚本？' }, () => {}),
    expectSource: 'user-questions/request',
    expectScenario: 'question',
    expectBodyHas: '要不要保留旧的迁移脚本',
  },
  {
    label: '工具待授权 -> approval',
    fire: (h, scoped) => h.get('approval/request').call(scoped, { toolName: 'run_command' }, () => {}),
    expectSource: 'approval/request',
    expectScenario: 'approval',
    expectBodyHas: 'run_command',
  },
  {
    label: '会话级失败 -> error',
    fire: (h) => h.get('api-session/error')('session-root-1', '会话失败：磁盘已满'),
    expectSource: 'api-session/error',
    expectScenario: 'error',
    expectBodyHas: '磁盘已满',
  },
  {
    label: '子代理会话 -> 静默',
    fire: (h) => h.get('session/event')({ id: '275ce19f-c3fb-4587-82c5-0214bf8fecc1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
    expectSource: 'turn/end:completed',
    expectSkipped: true,
  },
]

console.log('=== 逐场景隔离验证 ===')
for (const c of cases) {
  const { handlers, routes, ctxs } = freshHarness()
  // 调用时带上 cordis 传入的作用域对象作为 `this`（真实签名是 `(this, …args)`）。
  const result = c.fire(handlers, ctxs)
  await tick()
  const state = await readState(routes)
  if (state === null) { check(c.label, false, '读不到状态'); continue }
  const signal = state.signals.find((s) => s.source === c.expectSource)
  const hasSignal = signal !== undefined
  const verdict = hasSignal ? String(signal.verdict) : '(无)'
  const skipped = verdict.indexOf('skipped') === 0

  if (c.expectSkipped === true) {
    check(c.label, hasSignal && skipped, `期望被跳过，实际 verdict=${verdict}`)
    continue
  }
  const scenarioOk = state.dispatch.recent.some((r) => r.scenario === c.expectScenario)
  const bodyOk = c.expectBodyHas === undefined
    || state.dispatch.recent.some((r) => String(r.body).includes(c.expectBodyHas))
  check(c.label, hasSignal && scenarioOk && bodyOk,
    `verdict=${verdict} 场景命中=${scenarioOk} 正文命中=${bodyOk}`)
  void result
  if (bodyOk && state.dispatch.recent.length > 0) {
    console.log(`         正文: ${state.dispatch.recent[0].body}`)
  }
}

// ---- 瀑布事件必须交出决定权 ----
//
// **这一组断言是本文件最重要的部分。**
//
// cordis 的契约（@deepseek-ai/cordis/lib/types/events.js）：
//   "a listener that does not call `next()` vetoes the rest of the chain, including
//    the built-in behavior."
//
// 本插件的 `user-questions/request` 与 `approval/request` 监听器曾经既不接收 `next`
// 形参也不调用它，于是**把用户的提问与审批整条链都否决掉了**。
// 而当时的接线测试没能发现它——因为它自己造了一个 `{agent, request}` 形状的载荷去喂
// 处理器，形状与真实事件不一致，测试只证明了「我能喂饱我自己」。
//
// 因此这里显式断言：这两个监听器被调用后，`next` 必须**被调用过**。
// 一个只观察的事件监听器若忘记了 next，后果是阻断真实功能，而它在功能测试里
// 可能表现为「一切正常」（因为处理器确实跑了、也确实没报错）。
console.log('\n=== 瀑布事件必须交出决定权（否则会否决真实功能）===')
{
  const waterfallCases = [
    { event: 'user-questions/request', payload: { question: '要不要保留旧的迁移脚本？' } },
    { event: 'approval/request', payload: { toolName: 'run_command' } },
  ]
  for (const wc of waterfallCases) {
    const { handlers, ctxs } = freshHarness()
    const handler = handlers.get(wc.event)
    let nextCalls = 0
    let returned
    try {
      returned = handler.call(ctxs, wc.payload, () => { nextCalls += 1; return 'CHAIN-RESULT' })
    } catch (error) {
      check(`${wc.event} 调用不抛错`, false, error.message)
      continue
    }
    check(`${wc.event} 调用了 next()（不否决后续链）`, nextCalls === 1,
      `next 被调用 ${nextCalls} 次 —— 为 0 表示这条链被否决，用户将看不到提问/审批`)
    check(`${wc.event} 把 next() 的结果原样返回（不改写决定）`, returned === 'CHAIN-RESULT',
      `返回值是 ${JSON.stringify(returned)}，期望透传 'CHAIN-RESULT'`)
  }
}

// ---- 接线存在性 ----
console.log('\n=== 接线存在性 ===')
{
  const { handlers, routes } = freshHarness()
  check('注册了 session/event', handlers.has('session/event'))
  check('注册了 user-questions/request', handlers.has('user-questions/request'))
  check('注册了 approval/request', handlers.has('approval/request'))
  check('注册了 api-session/error', handlers.has('api-session/error'))

  // **路由形状必须断言，不能只断言条数。**
  //
  // 这条曾经漏掉，代价是设置页在真实环境里收到 404：
  // 旧代码注册的是 `{ method, path, handler }`，而契约是
  // `WebRoute { kind: 'exact' | 'prefix'; path; handler }`——缺 `kind` 的路由不会按预期生效，
  // 未命中的请求由 fallback 回 404。而当时的自检只检查「路由条数 >= 2」，**照样绿**。
  check('路由数量为 1（一条前缀路由，端点在内部分派）', routes.length === 1, `实际 ${routes.length} 条`)
  const route = routes[0]
  check('路由带 kind 字段（契约要求，缺它路由不生效）', route !== undefined && typeof route.kind === 'string',
    route === undefined ? '没有路由' : `kind=${JSON.stringify(route.kind)}`)
  check("路由 kind 是 'prefix' 或 'exact'",
    route !== undefined && (route.kind === 'prefix' || route.kind === 'exact'),
    route === undefined ? '' : `kind=${JSON.stringify(route.kind)}`)
  check('路由不再带非契约的 method 字段', route === undefined || route.method === undefined,
    route === undefined ? '' : `method=${JSON.stringify(route.method)}`)
  check('路由路径是契约前缀', route !== undefined && route.path === '/api/dsh-session-alert',
    route === undefined ? '' : `path=${JSON.stringify(route.path)}`)
  check('路由 handler 是函数', route !== undefined && typeof route.handler === 'function')

  // 端点分派必须真的按方法区分：GET /state 应成功，未知端点应回 404。
  const endpoints = await probeEndpoints(routes)
  check('GET /state 返回 200', endpoints.get('GET /api/dsh-session-alert/state') === 200,
    `实际 ${endpoints.get('GET /api/dsh-session-alert/state')}`)
  check('未知端点返回 404（不静默落到某个分支）',
    endpoints.get('GET /api/dsh-session-alert/nope') === 404,
    `实际 ${endpoints.get('GET /api/dsh-session-alert/nope')}`)
  check('方法不匹配时返回 404（POST /state 不是合法端点）',
    endpoints.get('POST /api/dsh-session-alert/state') === 404,
    `实际 ${endpoints.get('POST /api/dsh-session-alert/state')}`)
  check('POST /client-state 返回 200',
    endpoints.get('POST /api/dsh-session-alert/client-state') === 200,
    `实际 ${endpoints.get('POST /api/dsh-session-alert/client-state')}`)
}

console.log('')
console.log(failures === 0 ? '事件接线全部通过。' : `${failures} 项失败。`)
process.exit(failures === 0 ? 0 : 1)
