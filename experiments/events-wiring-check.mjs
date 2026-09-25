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
      if (name === 'webServer') return { register: (route) => { routes.push(route); return () => {} } }
      return undefined
    },
    on: (event, handler) => { handlers.set(event, handler) },
  }
  // 关掉限流与抑制，让每个场景都能独立地走到投递
  apply(ctx, Object.assign({ suppressWhenFocused: false, rateLimit: { enabled: false } }, config || {}))
  return { handlers, routes, ctxs: scoped }
}

/** 从插件的 /state 路由读回信号表与活动列表。 */
async function readState(routes) {
  const route = routes.find((r) => r.path.endsWith('/state'))
  if (route === undefined) return null
  let captured = null
  await route.handler(
    { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:19387' } },
    { statusCode: 0, setHeader: () => {}, end: (body) => { captured = JSON.parse(body) } },
  )
  return captured
}

const tick = () => new Promise((r) => setTimeout(r, 30))

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
  check('注册了设置页路由', routes.length >= 2, `实际 ${routes.length} 条`)
}

console.log('')
console.log(failures === 0 ? '事件接线全部通过。' : `${failures} 项失败。`)
process.exit(failures === 0 ? 0 : 1)
