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
// 替身环境与真实载荷**复用 scripts/event-harness.mjs**，不在这里做第二份实现。
// 两份逻辑迟早漂移，而漂移的那份不会有人发现。
import {
  ROOT_SESSION_ID,
  approvalRequestPayload,
  callRoute,
  freshHarness,
  questionRequestPayload,
  readState,
  tick,
} from '../scripts/event-harness.mjs'

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures += 1
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${condition ? '' : '  ' + (detail || '')}`)
}

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
    // 预览接口只探「会如实回绝」的那条：**未知场景回 400**。
    // 合法请求会走投递链真发一条通知，因此不在这里探——那由 selftest 的 dispatcher
    // 单测覆盖（绕过去重/限流/抑制、且不占用限流窗口）。
    ['POST', '/api/dsh-session-alert/notify', '{"scenario":"nope","body":"x"}'],
  ]
  // 请求的构造复用 `callRoute`（真实 Readable 作为请求体，理由见那里的注释）。
  for (const [method, url, body] of probes) {
    const result = await callRoute(route, method, url, body)
    out.set(`${method} ${url}`, result.status)
  }
  return out
}

// ---- 逐场景隔离验证 ----
const cases = [
  {
    label: '轮次正常结束 -> turnEnd',
    fire: (h) => h.get('session/event')({ id: ROOT_SESSION_ID }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
    expectSource: 'turn/end:completed',
    expectScenario: 'turnEnd',
  },
  {
    label: '轮次出错 -> error（不重复报「结束」）',
    fire: (h) => h.get('session/event')({ id: ROOT_SESSION_ID }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: '连接被拒绝' } } } }),
    expectSource: 'turn/end:error',
    expectScenario: 'error',
    expectBodyHas: '连接被拒绝',
  },
  {
    label: '用户打断 -> 跳过',
    fire: (h) => h.get('session/event')({ id: ROOT_SESSION_ID }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } } }),
    expectSource: 'turn/end:aborted-by-user',
    expectSkipped: true,
  },
  {
    label: '分叉 -> 跳过',
    fire: (h) => h.get('session/event')({ id: ROOT_SESSION_ID }, { type: 'turn/end', data: { turn: 4, reason: { kind: 'forked' } } }),
    expectSource: 'turn/end:forked',
    expectSkipped: true,
  },
  {
    label: 'Agent 提问 -> question',
    // **载荷形状照抄 `cordis_inspect_query` 的 Event 契约，不再自己编。**
    //
    //   'user-questions/request'(this: Scoped<Agent>, request: AskUserQuestionRequestEvent, next)
    //   AskUserQuestionRequestEvent = { questions: AskUserQuestionItem[]; agent?: Agent; signal? }
    //   AskUserQuestionItem        = { id; question; detail?; header?; options?; multiSelect?; intent? }
    //
    // 还有一处更硬的依据——发射点自己把 agent 并进了载荷
    // （`@deepseek-ai/dsh-user-questions/lib/index.js`）：
    //   ctx.waterfall(scopeTarget(agent, agent), 'user-questions/request', { ...request, agent }, noAnswerer)
    //
    // **这里第一版写的是 `{ question: '…' }` 并从 `this` 取会话——两处都与真实形状不符**，
    // 于是接线测试全绿而真机上通知正文是「未知会话 正在等待你的回答：」（会话名退化、
    // 摘要为空）。这与 waterfall 那次是**同一个错误的第二次发生**：
    // 测试造了一个自己满意的载荷，于是只证明了「我能喂饱我自己」。
    // 会话 id 因此改成放在载荷里的 `session-root-1`（与替身 roots() 一致）。
    fire: (h, scoped) => h.get('user-questions/request').call(scoped, questionRequestPayload(), () => {}),
    expectSource: 'user-questions/request',
    expectScenario: 'question',
    expectBodyHas: '要不要保留旧的迁移脚本',
    // 摘要取错字段时正文会是「等待你的回答：」——空摘要，而事件仍然“发出去了”。
    // 因此这里额外断言会话名被解析出来了（它是 `{session}` 变量的来源）。
    expectBodyHasAll: ['修复登录超时', '要不要保留旧的迁移脚本'],
  },
  {
    label: '工具待授权 -> approval',
    //   'approval/request'(this: Scoped<Agent>, req: ApprovalRequestEvent, next)
    //   ApprovalRequestEvent = { agent: Agent; toolName: string; reason?; displayReason?; signal? }
    fire: (h, scoped) => h.get('approval/request').call(scoped, approvalRequestPayload(), () => {}),
    expectSource: 'approval/request',
    expectScenario: 'approval',
    expectBodyHas: 'run_command',
    expectBodyHasAll: ['修复登录超时', 'run_command'],
  },
  {
    label: '会话级失败 -> error',
    fire: (h) => h.get('api-session/error')(ROOT_SESSION_ID, '会话失败：磁盘已满'),
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
  // `expectBodyHasAll`：正文里**每一段**都要出现。用来分开「事件发出去了」与
  // 「正文渲染对了」——空摘要的情形下事件同样会发出去，只看 fail 不了。
  const allOk = c.expectBodyHasAll === undefined
    || state.dispatch.recent.some((r) => c.expectBodyHasAll.every((frag) => String(r.body).includes(frag)))
  check(c.label, hasSignal && scenarioOk && bodyOk && allOk,
    `verdict=${verdict} 场景命中=${scenarioOk} 正文命中=${bodyOk} 正文片段齐全=${allOk}`)
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
    // 载荷形状同上面的逐场景用例：取自 `cordis_inspect_query` 的 Event 契约。
    {
      event: 'user-questions/request',
      payload: { questions: [{ id: 'q1', question: '要不要保留旧的迁移脚本？' }], agent: { id: ROOT_SESSION_ID } },
    },
    {
      event: 'approval/request',
      payload: { agent: { id: ROOT_SESSION_ID }, toolName: 'run_command' },
    },
  ]
  for (const wc of waterfallCases) {
    const { handlers, ctxs } = freshHarness()
    const handler = handlers.get(wc.event)
    let nextCalls = 0
    let returned
    try {
      returned = handler.call(ctxs, wc.payload, () => { nextCalls += 1; return 'CHAIN-RESULT' })
      // **瀑布监听器可以返回 promise**——事件契约本身就是 `Promise<ApprovalOutcome>`：
      // 审批场景要等用户在通知上按下「批准 / 拒绝」。早先这里直接比字符串，
      // 于是一个正确实现（返回 `Promise.race([…])`）会被判成「返回值是 {}」。
      // 先把 promise 兑现出来，再比对结果。
      if (returned !== null && typeof returned === 'object' && typeof returned.then === 'function') {
        returned = await returned
      }
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
  // 预览接口：未知场景必须**如实回 400**，而不是静默落到某个分支或假装成功。
  check('POST /notify 的未知场景返回 400',
    endpoints.get('POST /api/dsh-session-alert/notify') === 400,
    `实际 ${endpoints.get('POST /api/dsh-session-alert/notify')}`)
}

console.log('')
console.log(failures === 0 ? '事件接线全部通过。' : `${failures} 项失败。`)
process.exit(failures === 0 ? 0 : 1)
