/**
 * dsh-session-alert 的自检。
 *
 *   node scripts/selftest.mjs           仅离线单测（不依赖 Windows，不需要网络）
 *   node scripts/selftest.mjs --toast   离线单测 + 真机冒烟：真发一条通知并按退出码判定路径
 *
 * 退出码：全绿 0，有失败非 0（`node:test` 自己会设）。
 *
 * ## 为什么离线部分必须占大头
 *
 * `AlertDispatcher` 里的规则——限流、合并（不静默丢弃）、回声去重、四类开关、时长钳制、
 * 抑制时「扣卡片但响铃」、按钮透传——全部是**纯逻辑**，靠注入假时钟、假定时器、假投递
 * 就能覆盖。真机验收一次几十秒且会弹通知，不适合守回归；这里每次不到 30 毫秒。
 *
 * ## 真机坑位（不会在离线单测里失败，只在真机上以难以归因的方式表现）
 *
 * 这几条都被实际踩过，写在这里是因为**下一个读代码的人不会自己发现它们**：
 *
 * 1. **AUMID 的读回必须走 shell 的扩展属性。** 同一个刚写好的 `.lnk`，
 *    `IPropertyStore.GetValue(PKEY_AppUserModel_ID)` 会返回 `VT_EMPTY`（vt=0），
 *    而 `Shell.Application` → `ExtendedProperty('System.AppUserModel.ID')` 读得出正确值。
 *    拿前者做注册/幂等判断，会永远认为快捷方式不对而反复重建——外表看是「注册没生效」。
 *    读 `scripts/register-aumid.ps1` 里的 `Get-ShortcutAumid`。
 * 2. **未注册的 AUMID 一样会进操作中心历史。** 所以「历史里有这条」证明不了横幅会出现；
 *    横幅只由注册状态（开始菜单 `.lnk`）保证。据此本插件在自有 AUMID 未注册时**根本不去
 *    尝试它**——试了只会得到「进操作中心但无横幅」，再报退出码 0 就是假信号。
 * 3. **`ExpirationTime` 到期会把条目从操作中心清掉**（`durationSeconds > 0` 的正常行为）。
 *    因此投递脚本的回读校验必须在**同一进程内、退出之前**完成，事后从别的进程读已经太晚。
 * 4. **必须 Windows PowerShell 5.1，且脚本经 `-EncodedCommand`（UTF-16LE base64）传入。**
 *    PowerShell 7 里 `[Windows.UI.Notifications.ToastNotificationManager, ...,
 *    ContentType=WindowsRuntime]` 会抛 `Unable to find type`（.NET 5 移除了内置 WinRT
 *    类型投影），整条 toast 路径必然失败。标题与正文绝不拼命令行，脚本内用 `CreateTextNode`
 *    构造 XML。
 * 5. **`stdio: 'ignore'` + `windowsHide: true` 的判据是 `GetConsoleWindow()` 返回 NULL**，
 *    不是「窗口被隐藏」。见 docs/adr/0004-no-console-allocation.md。
 * 6. **`.ps1` 必须 UTF-8 BOM + CRLF**：无 BOM 时 PowerShell 5.1 按 GBK 解码中文，乱码会
 *    破坏引号配对并报出与真实原因无关的语法错误；LF 会让 `param(...)` 解析失败。
 *
 * @module dsh-session-alert/selftest
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

const notify = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'notify.js')).href)
const contract = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'contract.js')).href)
const configModule = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'config.js')).href)
const { auditListenerModes, auditPackageListeners } = await import(
  pathToFileURL(join(PACKAGE_ROOT, 'scripts', 'listener-mode-audit.mjs')).href
)
const { auditClientStyleInjection, makeDom, runClientHalf, stripComments } = await import(
  pathToFileURL(join(PACKAGE_ROOT, 'scripts', 'client-style-audit.mjs')).href
)
// 客户端**行为**审计（自动保存 + 标签名本地化）。与 experiments/client-behavior-audit.mjs 共用。
const { auditClientAutosave, sampleState } = await import(
  pathToFileURL(join(PACKAGE_ROOT, 'scripts', 'client-behavior-audit.mjs')).href
)
// 事件接线的替身环境与**真实载荷**。与 experiments/events-wiring-check.mjs 共用一份实现。
const {
  SESSION_TITLE,
  approvalRequestPayload,
  callRoute,
  freshHarness,
  postClientState,
  questionRequestPayload,
  readState,
  tick,
} = await import(pathToFileURL(join(PACKAGE_ROOT, 'scripts', 'event-harness.mjs')).href)

/** `lib/client.js` 的文本。样式注入审计要用它跑两种变异。 */
const CLIENT_SOURCE = readFileSync(join(PACKAGE_ROOT, 'lib', 'client.js'), 'utf8')

const {
  AlertDispatcher,
  DELIVERY_CODES,
  buildChimeScript,
  buildToastScript,
  clampDurationSeconds,
  clockTime,
  deliveryPlan,
  normaliseActions,
  sendWindowsToast,
  utf16leBase64,
} = notify

const T0 = 1_700_000_000_000

/**
 * 造一个受控环境：假时钟、假定时器、记录调用的假投递与假铃声。
 * 这是「策略能在没有 Windows 的机器上被单测」的落地点——接缝全在构造函数里。
 */
function harness(options = {}) {
  const state = { now: T0 }
  const timers = []
  const sent = []
  const chimes = []
  const logs = []

  const config = contract.defaultConfig()
  if (typeof options.patch === 'function') options.patch(config)

  const dispatcher = new AlertDispatcher({
    getConfig: () => (typeof options.getConfig === 'function' ? options.getConfig(config) : config),
    now: () => state.now,
    setTimer: (callback, delay) => {
      const handle = { callback, at: state.now + delay, unref() {} }
      timers.push(handle)
      return handle
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle)
      if (index >= 0) timers.splice(index, 1)
    },
    send: async (request) => {
      sent.push(request)
      return options.sendOutcome !== undefined ? options.sendOutcome : { ok: true, code: 0, note: 'toast（自有 AUMID）' }
    },
    chime: async (request) => {
      chimes.push({ ...request, at: state.now })
      return { ok: true }
    },
    onEvent: (level, message) => logs.push({ level, message }),
    platform: 'test',
    dedupeMs: options.dedupeMs,
  })

  /** 推进假时钟，并按到期顺序执行定时器。 */
  const advance = (ms) => {
    const target = state.now + ms
    let guard = 0
    for (;;) {
      const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)
      if (due.length === 0) break
      const next = due[0]
      state.now = next.at
      timers.splice(timers.indexOf(next), 1)
      next.callback()
      guard += 1
      if (guard > 100) throw new Error('定时器没有收敛')
    }
    state.now = target
  }

  /** 让被 dispatch 触发的 promise 链跑完。 */
  const settle = async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve()
    await new Promise((resolve) => setImmediate(resolve))
  }

  return { dispatcher, state, timers, sent, chimes, logs, config, advance, settle }
}

// ---------------------------------------------------------------- 总开关 / 场景开关

// 默认配置。这一组守的是**用户明确要求过的那几条默认值**——它们很容易在后续重构里
// 被顺手改回去，而「默认值悄悄变了」不会有任何症状，只会让人以为插件坏了。
test('默认配置：四个场景最短间隔一律 0（不限），显示时长按场景给（轮次结束 30 秒，其余常驻）', () => {
  const config = contract.defaultConfig()

  assert.deepEqual(
    contract.SCENARIO_IDS.map((id) => config.scenarios[id].minIntervalSeconds),
    [0, 0, 0, 0],
    '四个场景的最短间隔都应当是 0',
  )
  // 逐场景断言而不是只断言一个数组：失败信息里要能看出是哪个场景错了。
  assert.equal(config.scenarios.turnEnd.durationSeconds, 30, '轮次结束应当显示 30 秒')
  assert.equal(config.scenarios.question.durationSeconds, 0, '等待回答应当常驻（0）')
  assert.equal(config.scenarios.approval.durationSeconds, 0, '等待授权应当常驻（0）')
  assert.equal(config.scenarios.error.durationSeconds, 0, '执行出错应当常驻（0）')

  // 0 的语义是「常驻」而不是「立刻消失」——这一条由 notify 侧解释，这里只钉住数字。
  assert.equal(contract.SCENARIO_IDS.length, 4)
})

test('默认配置：归一化只补缺失字段，不覆盖用户已保存的值', () => {
  // 默认值改了之后，老配置文件里的显式值必须原样保留——否则用户的调整会被
  // 一次升级悄悄改掉，而那是比「默认值不好」严重得多的行为。
  const saved = { scenarios: { approval: { minIntervalSeconds: 45, durationSeconds: 12 } } }
  const merged = configModule.normalizeConfig(saved)
  assert.equal(merged.scenarios.approval.minIntervalSeconds, 45)
  assert.equal(merged.scenarios.approval.durationSeconds, 12)
  // 没写到的场景才吃默认值。
  assert.equal(merged.scenarios.turnEnd.durationSeconds, 30)
  assert.equal(merged.scenarios.question.durationSeconds, 0)
})

test('总开关关闭时任何提醒都不发', async () => {
  const h = harness({ patch: (c) => { c.enabled = false } })
  const result = h.dispatcher.dispatch({ scenario: 'turnEnd', body: '一轮结束' })
  assert.deepEqual(result, { sent: false, reason: 'plugin-disabled' })
  await h.settle()
  assert.equal(h.sent.length, 0)
  assert.equal(h.chimes.length, 0)
})

test('场景开关关闭时只挡该场景', async () => {
  const h = harness({ patch: (c) => { c.scenarios.approval.enabled = false } })
  assert.equal(h.dispatcher.dispatch({ scenario: 'approval', body: '等授权' }).reason, 'scenario-disabled')
  assert.equal(h.dispatcher.dispatch({ scenario: 'turnEnd', body: '一轮结束' }).sent, true)
  await h.settle()
  assert.equal(h.sent.length, 1)
})

test('未知场景按关闭处理', () => {
  const h = harness()
  assert.equal(h.dispatcher.dispatch({ scenario: 'nope', body: 'x' }).reason, 'scenario-disabled')
})

test('空正文不发（模板被渲染成空的情形）', () => {
  const h = harness()
  assert.equal(h.dispatcher.dispatch({ scenario: 'turnEnd', body: '   ' }).reason, 'empty-message')
  assert.equal(h.dispatcher.dispatch({ scenario: 'turnEnd', body: undefined }).reason, 'empty-message')
})

// ------------------------------------------------------------------------ 去重

test('同一个结构化 dedupeKey 在短窗口内只发一次，窗口过后可以再发', async () => {
  const h = harness()
  const first = h.dispatcher.dispatch({ scenario: 'turnEnd', body: 'A 已完成一轮', dedupeKey: 'turn-end\u0000s1\u00007' })
  assert.equal(first.sent, true)
  const echo = h.dispatcher.dispatch({ scenario: 'turnEnd', body: 'A 已完成一轮（渲染时间戳不同）', dedupeKey: 'turn-end\u0000s1\u00007' })
  assert.deepEqual(echo, { sent: false, reason: 'duplicate' })
  await h.settle()
  assert.equal(h.sent.length, 1)

  h.advance(10_100)
  const later = h.dispatcher.dispatch({ scenario: 'turnEnd', body: 'A 已完成一轮', dedupeKey: 'turn-end\u0000s1\u00007' })
  assert.equal(later.sent, true)
  assert.equal(h.dispatcher.snapshot().counters.duplicate, 1)
})

test('正文相同但 dedupeKey 不同时不去重（两次真实事件）', async () => {
  const h = harness()
  h.dispatcher.dispatch({ scenario: 'turnEnd', body: '同一句话', dedupeKey: 'turn-end\u0000s1\u00001' })
  h.dispatcher.dispatch({ scenario: 'turnEnd', body: '同一句话', dedupeKey: 'turn-end\u0000s1\u00002' })
  await h.settle()
  assert.equal(h.sent.length, 2)
})

test('没有 dedupeKey 时退化为按正文去重', async () => {
  const h = harness()
  h.dispatcher.dispatch({ scenario: 'turnEnd', body: '重复的正文' })
  assert.equal(h.dispatcher.dispatch({ scenario: 'turnEnd', body: '重复的正文' }).reason, 'duplicate')
  await h.settle()
  assert.equal(h.sent.length, 1)
})

// ------------------------------------------------------------------ 限流与合并

test('限流窗口满后超出部分被合并成一条稍后发出（不静默丢弃）', async () => {
  const h = harness()
  for (const id of [1, 2, 3]) {
    assert.equal(h.dispatcher.dispatch({ scenario: 'turnEnd', body: `第 ${id} 条`, dedupeKey: `k${id}` }).sent, true)
  }
  const blockedA = h.dispatcher.dispatch({ scenario: 'question', body: '第 4 条', dedupeKey: 'k4' })
  const blockedB = h.dispatcher.dispatch({ scenario: 'error', body: '第 5 条', dedupeKey: 'k5' })
  assert.equal(blockedA.reason, 'rate-limit')
  assert.equal(blockedA.coalescing, true)
  assert.equal(blockedB.reason, 'rate-limit')
  await h.settle()
  assert.equal(h.sent.length, 3, '被限流的两条不该立刻发出')
  assert.equal(h.dispatcher.snapshot().pendingCoalesced, 2)

  h.advance(10_200)
  await h.settle()
  assert.equal(h.sent.length, 4, '合并的那条要在窗口放行后发出')
  assert.match(h.sent[3].body, /第 5 条/)
  assert.match(h.sent[3].body, /另有 1 条提醒在限流窗口内被合并/)
  const snapshot = h.dispatcher.snapshot()
  assert.equal(snapshot.counters.blocked, 2)
  assert.equal(snapshot.counters.coalesced, 1)
  assert.equal(snapshot.pendingCoalesced, 0)
  assert.equal(snapshot.counters.sent, 4)
})

test('coalesce 关闭时被限流的提醒直接丢弃', async () => {
  const h = harness({ patch: (c) => { c.rateLimit.coalesce = false } })
  for (const id of [1, 2, 3]) h.dispatcher.dispatch({ scenario: 'turnEnd', body: `第 ${id} 条`, dedupeKey: `k${id}` })
  const blocked = h.dispatcher.dispatch({ scenario: 'turnEnd', body: '第 4 条', dedupeKey: 'k4' })
  assert.deepEqual(blocked, { sent: false, reason: 'rate-limit' })
  h.advance(20_000)
  await h.settle()
  assert.equal(h.sent.length, 3)
  assert.equal(h.dispatcher.snapshot().pendingCoalesced, 0)
})

test('限流关闭时不限条数', async () => {
  const h = harness({ patch: (c) => { c.rateLimit.enabled = false } })
  for (const id of [1, 2, 3, 4, 5]) {
    assert.equal(h.dispatcher.dispatch({ scenario: 'turnEnd', body: `第 ${id} 条`, dedupeKey: `k${id}` }).sent, true)
  }
  await h.settle()
  assert.equal(h.sent.length, 5)
})

test('每场景最小间隔：窗口内的同场景提醒被合并，窗口外照发', async () => {
  // **间隔在这里显式给定，不依赖默认值。** 这条测的是分发器的「场景冷却」行为，
  // 而不是默认配置是多少——默认值改动（四个场景一律 0）不该让它失败，
  // 而它先前恰恰是靠 approval 的默认 30 秒站着的。
  const h = harness({ patch: (c) => { c.scenarios.approval.minIntervalSeconds = 30 } })
  assert.equal(h.dispatcher.dispatch({ scenario: 'approval', body: '等授权 A', dedupeKey: 'a1' }).sent, true)
  const second = h.dispatcher.dispatch({ scenario: 'approval', body: '等授权 B', dedupeKey: 'a2' })
  assert.equal(second.reason, 'scenario-interval')
  await h.settle()
  assert.equal(h.sent.length, 1)

  h.advance(30_100)
  await h.settle()
  assert.equal(h.sent.length, 2, '最小间隔过后，被合并的那条要发出')
  assert.match(h.sent[1].body, /等授权 B/)
})

test('限流窗口内的投递时刻会随窗口滑出', async () => {
  const h = harness()
  for (const id of [1, 2, 3]) h.dispatcher.dispatch({ scenario: 'turnEnd', body: `第 ${id} 条`, dedupeKey: `k${id}` })
  await h.settle()
  assert.equal(h.dispatcher.snapshot().windowUsed, 3)
  h.advance(10_100)
  assert.equal(h.dispatcher.snapshot().windowUsed, 0)
})

// ------------------------------------------------------------------------ 抑制

test('抑制时卡片不弹但铃声照响，且计入活动列表', async () => {
  const h = harness()
  const result = h.dispatcher.dispatch({ scenario: 'turnEnd', body: '一轮结束', suppressed: true })
  await h.settle()
  assert.equal(h.sent.length, 0, '抑制时绝不能调用投递')
  assert.equal(h.chimes.length, 1, '抑制时铃声必须响')
  assert.equal(result.sent, false)
  assert.equal(result.reason, 'focused-suppressed')
  assert.equal(result.chime, true)
  const snapshot = h.dispatcher.snapshot()
  assert.equal(snapshot.counters.suppressed, 1)
  assert.equal(snapshot.counters.chimes, 1)
  assert.equal(snapshot.lastResult.via, 'chime-only')
  assert.equal(snapshot.lastResult.scenario, 'turnEnd')
})

test('抑制 + 铃声关闭 = 彻底静音，但仍记为一次抑制', async () => {
  const h = harness({ patch: (c) => { c.chime.enabled = false } })
  const result = h.dispatcher.dispatch({ scenario: 'turnEnd', body: '一轮结束', suppressed: true })
  await h.settle()
  assert.equal(h.sent.length, 0)
  assert.equal(h.chimes.length, 0)
  assert.equal(result.chime, false)
  assert.equal(h.dispatcher.snapshot().lastResult.via, 'suppressed-silent')
})

test('suppressCard 是 suppressed 的别名', async () => {
  const h = harness()
  const result = h.dispatcher.dispatch({ scenario: 'turnEnd', body: '一轮结束', suppressCard: true })
  await h.settle()
  assert.equal(result.reason, 'focused-suppressed')
  assert.equal(h.chimes.length, 1)
})

test('focused + suppressWhenFocused 由分发器自行推导抑制', async () => {
  const h = harness()
  const result = h.dispatcher.dispatch({ scenario: 'turnEnd', body: '一轮结束', focused: true })
  await h.settle()
  assert.equal(result.reason, 'focused-suppressed')
  assert.equal(h.sent.length, 0)
  assert.equal(h.chimes.length, 1)
})

test('suppressWhenFocused 关闭时 focused 不抑制', async () => {
  const h = harness({ patch: (c) => { c.suppressWhenFocused = false } })
  h.dispatcher.dispatch({ scenario: 'turnEnd', body: '一轮结束', focused: true })
  await h.settle()
  assert.equal(h.sent.length, 1)
  assert.equal(h.chimes.length, 0)
})

test('抑制不绕过限流：窗口满时连铃声都不响', async () => {
  const h = harness()
  for (const id of [1, 2, 3]) h.dispatcher.dispatch({ scenario: 'turnEnd', body: `第 ${id} 条`, dedupeKey: `k${id}` })
  await h.settle()
  h.chimes.length = 0
  const result = h.dispatcher.dispatch({ scenario: 'turnEnd', body: '第 4 条', dedupeKey: 'k4', suppressed: true })
  await h.settle()
  assert.deepEqual(result, { sent: false, reason: 'rate-limit' })
  assert.equal(h.chimes.length, 0)
  assert.equal(h.dispatcher.snapshot().counters.suppressed, 1)
})

test('抑制不合并：不会在几秒后弹出一张卡片', async () => {
  const h = harness({ patch: (c) => { c.rateLimit.max = 1 } })
  h.dispatcher.dispatch({ scenario: 'turnEnd', body: '第一条', dedupeKey: 'k1' })
  h.dispatcher.dispatch({ scenario: 'turnEnd', body: '第二条', dedupeKey: 'k2', suppressed: true })
  await h.settle()
  h.advance(30_000)
  await h.settle()
  assert.equal(h.sent.length, 1, '抑制的事件不得进入合并队列')
  assert.equal(h.dispatcher.snapshot().pendingCoalesced, 0)
})

// ------------------------------------------------------------------------ 铃声

test('toast 自带声音时不再补一次铃声（不双重提示）', async () => {
  const h = harness()
  h.dispatcher.dispatch({ scenario: 'turnEnd', body: '一轮结束' })
  await h.settle()
  assert.equal(h.sent.length, 1)
  assert.equal(h.chimes.length, 0)
})

test('关闭 toast 声音但开着铃声时，铃声走独立路径', async () => {
  const h = harness({ patch: (c) => { c.sound = false } })
  h.dispatcher.dispatch({ scenario: 'turnEnd', body: '一轮结束' })
  await h.settle()
  assert.equal(h.sent.length, 1)
  assert.equal(h.chimes.length, 1)
  assert.equal(h.chimes[0].source, 'system')
})

test('chimeWhen: always / never 覆盖默认策略', async () => {
  const always = harness({ patch: (c) => { c.sound = true } })
  always.dispatcher.chimeWhen = 'always'
  always.dispatcher.dispatch({ scenario: 'turnEnd', body: '一轮结束' })
  await always.settle()
  assert.equal(always.chimes.length, 1)

  const never = harness()
  never.dispatcher.chimeWhen = 'never'
  never.dispatcher.dispatch({ scenario: 'turnEnd', body: '一轮结束', suppressed: true })
  await never.settle()
  assert.equal(never.chimes.length, 0)
  assert.equal(never.dispatcher.snapshot().lastResult.via, 'suppressed-silent')
})

test('铃声配置为文件时把文件路径透传给铃声传输', async () => {
  const h = harness({ patch: (c) => { c.chime.source = 'file'; c.chime.filePath = 'C:/x/y.wav'; c.sound = false } })
  h.dispatcher.dispatch({ scenario: 'turnEnd', body: '一轮结束' })
  await h.settle()
  assert.equal(h.chimes.length, 1)
  assert.equal(h.chimes[0].filePath, 'C:/x/y.wav')
})

test('铃声失败只记日志，不影响投递结果', async () => {
  const h = harness({ patch: (c) => { c.sound = false } })
  h.dispatcher.chime = async () => ({ ok: false, error: '没有音频设备' })
  h.dispatcher.dispatch({ scenario: 'turnEnd', body: '一轮结束' })
  await h.settle()
  assert.equal(h.sent.length, 1)
  assert.ok(h.logs.some((entry) => entry.level === 'warn' && entry.message.includes('铃声播放失败')))
})

// --------------------------------------------------------------- 时长与按钮透传

test('时长按 MAX_DURATION_SECONDS 钳制后透传给投递', async () => {
  const h = harness({ patch: (c) => { c.scenarios.turnEnd.durationSeconds = 999 } })
  h.dispatcher.dispatch({ scenario: 'turnEnd', body: '一轮结束' })
  await h.settle()
  assert.equal(h.sent[0].durationSeconds, contract.MAX_DURATION_SECONDS)
})

test('时长 0（常驻）原样透传', async () => {
  const h = harness({ patch: (c) => { c.scenarios.turnEnd.durationSeconds = 0 } })
  h.dispatcher.dispatch({ scenario: 'turnEnd', body: '一轮结束' })
  await h.settle()
  assert.equal(h.sent[0].durationSeconds, 0)
})

test('按钮原样透传到投递，并在合并后那条上保留', async () => {
  const actions = [{ content: '打开会话', arguments: 'dsh-session-alert://open/?session=abc', activationType: 'protocol' }]
  const h = harness()
  h.dispatcher.dispatch({ scenario: 'approval', body: '等授权', dedupeKey: 'a1', actions })
  await h.settle()
  assert.deepEqual(h.sent[0].actions, actions)

  // 限流窗口内再来的那条被合并，合并出去的通知同样要带按钮
  const h2 = harness({ patch: (c) => { c.rateLimit.max = 1 } })
  h2.dispatcher.dispatch({ scenario: 'turnEnd', body: '第一条', dedupeKey: 'k1' })
  h2.dispatcher.dispatch({ scenario: 'approval', body: '第二条', dedupeKey: 'k2', actions })
  h2.advance(10_200)
  await h2.settle()
  assert.equal(h2.sent.length, 2)
  assert.deepEqual(h2.sent[1].actions, actions)
})

test('normaliseActions 丢弃空内容、容忍 label 别名、最多 5 个', () => {
  assert.deepEqual(normaliseActions(undefined), [])
  assert.deepEqual(normaliseActions([null, 'x', {}]), [])
  assert.deepEqual(
    normaliseActions([{ label: '别名', arguments: 'u' }]),
    [{ content: '别名', arguments: 'u', activationType: 'protocol' }],
  )
  const many = normaliseActions(Array.from({ length: 8 }, (_v, i) => ({ content: `b${i}`, arguments: 'u' })))
  assert.equal(many.length, 5)
})

// ------------------------------------------------------------------ 测试通知

test('test() 绕过限流与去重、真的投递，并把结果记入活动列表', async () => {
  const h = harness({ patch: (c) => { c.rateLimit.max = 1 } })
  h.dispatcher.dispatch({ scenario: 'turnEnd', body: '占满窗口', dedupeKey: 'k1' })
  await h.settle()
  const outcome = await h.dispatcher.test()
  assert.equal(outcome.ok, true)
  assert.equal(h.sent.length, 2, '测试通知必须真的投递，不受窗口限制')
  assert.match(h.sent[1].body, /这是一条测试通知/)
  const snapshot = h.dispatcher.snapshot()
  assert.equal(snapshot.lastResult.scenario, 'test')
  assert.equal(snapshot.lastResult.via, 'toast（自有 AUMID）')
  assert.equal(snapshot.windowUsed, 1, '测试通知不占用限流窗口')
})

test('test() 投递失败时如实记录', async () => {
  const h = harness({ sendOutcome: { ok: false, error: '没有任何一条通知路径成功（退出码 3）' } })
  const outcome = await h.dispatcher.test(5)
  assert.equal(outcome.ok, false)
  const snapshot = h.dispatcher.snapshot()
  assert.equal(snapshot.lastResult.ok, false)
  assert.match(snapshot.lastResult.error, /退出码 3/)
  assert.equal(snapshot.counters.failed, 1)
})

test('test() 用 turnEnd 场景的时长，无参时也如此', async () => {
  const h = harness({ patch: (c) => { c.scenarios.turnEnd.durationSeconds = 25 } })
  await h.dispatcher.test()
  assert.equal(h.sent[0].durationSeconds, 25)
})

// ------------------------------------------------------------- 快照与生命周期

test('snapshot 的字段齐备且与计数一致', async () => {
  const h = harness()
  h.dispatcher.dispatch({ scenario: 'turnEnd', body: '一条', dedupeKey: 'k1' })
  h.dispatcher.dispatch({ scenario: 'turnEnd', body: '一条', dedupeKey: 'k1' })
  await h.settle()
  const snapshot = h.dispatcher.snapshot()
  for (const key of ['counters', 'lastResult', 'recent', 'windowUsed', 'windowMax', 'windowSeconds', 'pendingCoalesced']) {
    assert.ok(key in snapshot, `snapshot 缺字段 ${key}`)
  }
  assert.deepEqual(
    Object.keys(snapshot.counters).sort(),
    ['blocked', 'chimes', 'coalesced', 'duplicate', 'failed', 'sent', 'suppressed'],
  )
  assert.equal(snapshot.windowMax, 3)
  assert.equal(snapshot.windowSeconds, 10)
  assert.equal(snapshot.counters.sent, 1)
  assert.equal(snapshot.counters.duplicate, 1)
  assert.equal(snapshot.recent.length, 1)
  assert.equal(snapshot.recent[0].time, clockTime(T0))
  assert.equal(snapshot.recent[0].scenario, 'turnEnd')
})

test('活动列表最多保留 20 条', async () => {
  const h = harness({ patch: (c) => { c.rateLimit.enabled = false } })
  for (let i = 0; i < 25; i += 1) {
    h.dispatcher.dispatch({ scenario: 'turnEnd', body: `第 ${i} 条`, dedupeKey: `k${i}` })
  }
  await h.settle()
  assert.equal(h.dispatcher.snapshot().recent.length, 20)
})

test('clearActivity 清空活动与计数但不动限流窗口', async () => {
  const h = harness()
  h.dispatcher.dispatch({ scenario: 'turnEnd', body: '一条', dedupeKey: 'k1' })
  await h.settle()
  h.dispatcher.clearActivity()
  const snapshot = h.dispatcher.snapshot()
  assert.equal(snapshot.recent.length, 0)
  assert.equal(snapshot.lastResult, null)
  assert.equal(snapshot.counters.sent, 0)
  assert.equal(snapshot.windowUsed, 1)
})

test('dispose 撤销未触发的合并定时器', async () => {
  const h = harness({ patch: (c) => { c.rateLimit.max = 1 } })
  h.dispatcher.dispatch({ scenario: 'turnEnd', body: '第一条', dedupeKey: 'k1' })
  h.dispatcher.dispatch({ scenario: 'turnEnd', body: '第二条', dedupeKey: 'k2' })
  assert.equal(h.timers.length, 1)
  h.dispatcher.dispose()
  assert.equal(h.timers.length, 0)
  h.advance(60_000)
  await h.settle()
  assert.equal(h.sent.length, 1)
})

test('投递抛异常被吞掉并记为失败，不影响后续分发', async () => {
  const h = harness()
  h.dispatcher.send = async () => { throw new Error('spawn EPERM') }
  h.dispatcher.dispatch({ scenario: 'turnEnd', body: '一条', dedupeKey: 'k1' })
  await h.settle()
  const snapshot = h.dispatcher.snapshot()
  assert.equal(snapshot.lastResult.ok, false)
  assert.match(snapshot.lastResult.error, /EPERM/)
  assert.equal(snapshot.counters.failed, 1)
  assert.ok(h.logs.some((entry) => entry.level === 'warn'))
})

test('getConfig 抛异常不会让 dispatch 抛出去', () => {
  const dispatcher = new AlertDispatcher({ getConfig: () => { throw new Error('坏配置') } })
  assert.throws(() => dispatcher.dispatch({ scenario: 'turnEnd', body: 'x' }), /坏配置/)
})

// ------------------------------------------------------------ 纯函数与脚本生成

test('clampDurationSeconds 的边界', () => {
  assert.equal(clampDurationSeconds(0), 0)
  assert.equal(clampDurationSeconds(10), 10)
  assert.equal(clampDurationSeconds(60), 60)
  assert.equal(clampDurationSeconds(61), 60)
  assert.equal(clampDurationSeconds(9999), 60)
  assert.equal(clampDurationSeconds(-5), 0)
  assert.equal(clampDurationSeconds(9.6), 10)
  assert.equal(clampDurationSeconds(Number.NaN), 0)
  assert.equal(clampDurationSeconds(Number.POSITIVE_INFINITY), 0)
  assert.equal(clampDurationSeconds('30'), 0)
  assert.equal(clampDurationSeconds(undefined), 0)
  assert.equal(contract.MAX_DURATION_SECONDS, 60)
})

test('utf16leBase64 与 -EncodedCommand 的编码一致（含中文与 emoji）', () => {
  const text = "$x = '中文标题 😀 <b>'\r\nexit 0\r\n"
  const decoded = Buffer.from(utf16leBase64(text), 'base64').toString('utf16le')
  assert.equal(decoded, text)
})

test('clockTime 输出 HH:MM:SS', () => {
  const date = new Date(2024, 0, 2, 3, 4, 5)
  assert.equal(clockTime(date.getTime()), '03:04:05')
})

test('投递顺序由注册状态决定，未注册的自有 AUMID 根本不被尝试', () => {
  const registered = deliveryPlan(undefined, { isRegistered: (aumid) => aumid === contract.PRIMARY_AUMID })
  assert.deepEqual(registered.senders, [
    { aumid: contract.PRIMARY_AUMID, code: 0 },
    { aumid: contract.FALLBACK_AUMID, code: 5 },
  ])

  const unregistered = deliveryPlan(undefined, { isRegistered: () => false })
  assert.deepEqual(unregistered.senders, [{ aumid: contract.FALLBACK_AUMID, code: 5 }])
  assert.equal(unregistered.primaryRegistered, false)

  const explicitRegistered = deliveryPlan('Other App', { isRegistered: (aumid) => aumid === 'Other App' })
  assert.deepEqual(explicitRegistered.senders.map((entry) => entry.aumid), ['Other App', contract.FALLBACK_AUMID])

  const explicitUnregistered = deliveryPlan('Ghost App', { isRegistered: (aumid) => aumid === contract.PRIMARY_AUMID })
  assert.deepEqual(explicitUnregistered.senders.map((entry) => entry.aumid), [contract.PRIMARY_AUMID, contract.FALLBACK_AUMID])

  const explicitFallback = deliveryPlan(contract.FALLBACK_AUMID, { isRegistered: () => false })
  assert.deepEqual(explicitFallback.senders, [{ aumid: contract.FALLBACK_AUMID, code: 5 }])
})

test('生成的投递脚本：常驻用 scenario="urgent"，定时用 ExpirationTime', () => {
  const urgent = buildToastScript({ title: 't', body: 'b', durationSeconds: 0 })
  assert.match(urgent, /\$urgent = \$true/)
  assert.match(urgent, /\$durationSeconds = 0/)
  assert.match(urgent, /if \(\$durationSeconds -gt 0\)/)

  const timed = buildToastScript({ title: 't', body: 'b', durationSeconds: 999 })
  assert.match(timed, /\$urgent = \$false/)
  assert.match(timed, /\$durationSeconds = 60/)
  assert.match(timed, /ExpirationTime/)
})

test('生成的投递脚本不写 stdout/stderr，只用退出码汇报', () => {
  const script = buildToastScript({ title: 't', body: 'b' })
  assert.doesNotMatch(script, /Write-Output|Write-Host|Write-Error|Write-Warning|Write-Verbose/)
  assert.match(script, /exit \$exitCode/)
  assert.match(script, /\$exitCode = 3/)
  assert.match(script, /\$exitCode = 6/)
})

test('生成的投递脚本：声音开关落到 <audio> 上，且永远是 DOM 构造', () => {
  const withSound = buildToastScript({ title: 't', body: 'b', sound: true })
  const silent = buildToastScript({ title: 't', body: 'b', sound: false })
  assert.match(withSound, /ms-winsoundevent:Notification\.Default/)
  assert.match(silent, /silent', 'true/)
  assert.match(withSound, /CreateTextNode/)
  assert.match(withSound, /CreateElement\('action'\)/)
})

test('注入自测：标题与正文只以 base64 出现，引号与尖括号进不了脚本语法', () => {
  const title = "it's a <b>title</b> '; exit 99; #"
  const body = '<script>alert("x")</script> 中文 😀 \r\n exit 7'
  const script = buildToastScript({
    title,
    body,
    actions: [{ content: "点'我", arguments: 'dsh-session-alert://open/?session=a&b=<c>', activationType: 'protocol' }],
  })
  assert.doesNotMatch(script, /<b>title<\/b>/, '原文不得出现在脚本里')
  assert.doesNotMatch(script, /alert\("x"\)/)
  assert.doesNotMatch(script, /exit 99/)
  assert.doesNotMatch(script, /exit 7/)
  const payloads = [...script.matchAll(/ConvertFrom-B64Text '([A-Za-z0-9+/=]+)'/g)].map((match) => match[1])
  const decoded = payloads.map((payload) => Buffer.from(payload, 'base64').toString('utf8'))
  assert.ok(decoded.includes(title))
  assert.ok(decoded.includes(body))
  assert.ok(decoded.includes("点'我"))
})

test('生成的铃声脚本：系统声音与文件两条路径', () => {
  const system = buildChimeScript({ source: 'system' })
  assert.match(system, /SystemSounds\]::Asterisk\.Play\(\)/)
  const file = buildChimeScript({ source: 'file', filePath: 'C:/a/b.wav' })
  assert.match(file, /SoundPlayer/)
  const payloads = [...file.matchAll(/ConvertFrom-B64Text '([A-Za-z0-9+/=]+)'/g)].map((match) => match[1])
  assert.equal(Buffer.from(payloads[0], 'base64').toString('utf8'), 'C:/a/b.wav')
})

test('生成的脚本用 CRLF（PowerShell 5.1 对 param 块的要求）', () => {
  assert.ok(buildToastScript({ title: 't', body: 'b' }).includes('\r\n'))
  assert.ok(!/(?<!\r)\n/.test(buildToastScript({ title: 't', body: 'b' })))
})

// ------------------------------------------- 事件监听器的 dispatch-mode 审计
//
// 这一组守的是**最严重的一类缺陷**：瀑布监听器不交出决定权会否决真实功能。
//
// 本插件曾经在 `user-questions/request` 与 `approval/request` 上注册了不调用 next 的
// 监听器，于是**用户的提问与审批整条链都被否决**。而它在功能测试里表现为「一切正常」
// ——处理器确实跑了、也确实没报错。因此这条断言必须独立存在，不能靠功能用例覆盖。
//
// cordis 契约原文（`@deepseek-ai/cordis/lib/types/events.js`）：
//   "a listener that does not call `next()` vetoes the rest of the chain,
//    including the built-in behavior."

test('每个事件监听器都与它的 dispatch mode 相符（瀑布必须 return next()）', () => {
  const { registrations, problems } = auditPackageListeners(PACKAGE_ROOT)
  assert.ok(registrations.length > 0, '没有找到任何监听器注册——审计脚本本身可能失效了')
  assert.deepEqual(problems, [], `监听器 mode 审计失败：\n  - ${problems.join('\n  - ')}`)
})

test('审计本身有效：缺 return next() 的瀑布监听器必须被抓出来', () => {
  // 变异测试。一个不会失败的检查等于没有检查——它必须先能抓到。
  const mutated = `
    ctx.on('user-questions/request', function (request, next) {
      observe(request)
    }, { global: true })
  `
  const { problems } = auditListenerModes(mutated)
  assert.equal(problems.length, 1, '应当恰好报出一条问题')
  assert.match(problems[0], /缺少 return next\(\)/)

  // 补上 return next() 之后应当通过
  const fixed = `
    ctx.on('user-questions/request', function (request, next) {
      observe(request)
      return next()
    }, { global: true })
  `
  assert.deepEqual(auditListenerModes(fixed).problems, [])

  // emit 模式的监听器带 next 形参也应被指出
  const wrongMode = `
    ctx.on('session/event', function (session, event, next) {
      observe(event)
    }, { global: true })
  `
  const wrongProblems = auditListenerModes(wrongMode).problems
  assert.ok(wrongProblems.some((p) => p.includes('next')), `emit 模式不应带 next：${wrongProblems.join('；')}`)
})

test('审计覆盖了事件目录里全部已注册的监听器（新增监听器不会漏审）', () => {
  const { registrations } = auditPackageListeners(PACKAGE_ROOT)
  const events = registrations.map((r) => r.event).sort()
  // 这四个是本插件当前的全部监听器。新增监听器时这条会失败，提醒把它的 mode 补进
  // scripts/listener-mode-audit.mjs 的 EVENT_MODES——审计会因为「不在表里」而失败，
  // 而不是静默跳过。
  assert.deepEqual(events, [
    'api-session/error',
    'approval/request',
    'session/event',
    'user-questions/request',
  ])
})

// ------------------------------------------------- 客户端半边的样式注入审计
//
// 这一组守的是**「改动到底有没有生效」这件事本身**。
//
// 设置页的样式曾经从来没有进过文档：静态半边用了 `styles.insert(STYLES)`，而那是
// **动态半边**才有的闭包实参。静态半边的物化是
// `registered.factory(this.makeRequire(ownerId, edges))`——**只传一个实参**，
// 因此 `styles` 是自由变量，全局里也没有它，那条 `typeof styles !== 'undefined'`
// 的守卫走了 else：代码执行了、日志打了、CSS 一个字符都没进文档。
//
// 而它活过了一整轮自检，因为**替身自己造了一个 `globalThis.styles`**
// （见 experiments/settings-render-check.mjs）。替身把真机上不存在的东西补上了，
// 于是被执行的正是那条在真机上永远走不到的分支——测试只证明了「我能喂饱我自己」，
// 与 waterfall 缺陷那次同源。
//
// 因此这一组的第一条不是断言「注册了样式」，而是**在「没有 styles」这个真实条件下
// 跑一遍代码，再检查文档里到底有没有多出标签**。

test('客户端半边在「没有 styles 内置」的真实条件下注入样式标签，且上报里带着实测读数', async () => {
  const { problems, evidence } = await auditClientStyleInjection({ source: CLIENT_SOURCE })
  assert.deepEqual(problems, [], `样式注入审计失败：\n  - ${problems.join('\n  - ')}`)
  // 顺手把关键读数固定下来：这些值本身就是「注入真的发生了」的证据。
  assert.equal(evidence.tags, 1)
  assert.ok(evidence.chars > 1000, `注入的 CSS 只有 ${evidence.chars} 字符，像是没注进去`)
  assert.ok(evidence.rules > 0, '样式标签没有解析出规则')
  assert.equal(evidence.leftover, 0, '清理之后仍残留样式标签')
})

test('样式审计本身有效：去掉注入、或改回 styles.insert，都必须被抓出来', async () => {
  // 变异测试。一个不会失败的检查等于没有检查——它必须先能抓到。
  const injectionEffect = /ctx\.effect\(function \(\) \{\s*return installStyles\(\)\s*\}, 'dsh-session-alert: styles'\)/
  assert.match(CLIENT_SOURCE, injectionEffect, '找不到注入效应的原文，变异检查自身已失效')

  // 变异一：整块注入被移除。
  const withoutInjection = CLIENT_SOURCE.replace(injectionEffect, '/* 变异：注入被移除 */')
  const mutated = await auditClientStyleInjection({ source: withoutInjection })
  assert.ok(
    mutated.problems.some((p) => p.includes('恰好有 1 个')),
    `去掉注入后必须报出「没有样式标签」，实际：${JSON.stringify(mutated.problems)}`,
  )

  // 变异二：改回真机上永不执行的那条路。
  const withDeadApi = CLIENT_SOURCE.replace(
    injectionEffect,
    "ctx.effect(function () { return styles.insert(STYLES) }, 'dsh-session-alert: styles')",
  )
  const deadProblems = (await auditClientStyleInjection({ source: withDeadApi })).problems
  assert.ok(
    deadProblems.some((p) => p.includes('styles.insert')),
    `改回 styles.insert 后必须报出「这条路在真机上不存在」，实际：${JSON.stringify(deadProblems)}`,
  )
})

test('注释里对这个缺陷的解释不会被当成缺陷本身', () => {
  // 变异检查的检查。源码里写着「原先写的是 `styles.insert(STYLES)`」这句引用，
  // 第一版审计直接对整份文本匹配，于是**注释里对缺陷的解释被当成了缺陷**，
  // 对着正确的代码报了一条假失败。判据必须只看可执行代码。
  assert.match(CLIENT_SOURCE, /styles\.insert/, '源码注释里应当保留对这条死路的说明')
  assert.ok(!/styles\s*\.\s*insert/.test(stripComments(CLIENT_SOURCE)), '去掉注释后不应再有 styles.insert')

  // 反向确认：把死路写进**代码**（不是注释）时，必须仍然被抓到。
  assert.match(stripComments('var x = 1; /* styles.insert(a) */ var y = 2'), /var y = 2/)
  assert.match(stripComments('var x = 1; // styles.insert(a)\nvar y = 2'), /var y = 2/)
})

test('DOM 替身遇到不认识的选择器必须抛错，不能静默返回空集', () => {
  // 静默返回空集会让「空集里没有违规」永远为真——本项目在路由自检上正是被这种
  // 断言坑过（只断言条数、从不检查形状）。
  const dom = makeDom({})
  assert.throws(() => dom.document.querySelectorAll('.dsa-root > *:nth-child(2)'), /不支持的选择器/)
  assert.doesNotThrow(() => dom.document.querySelectorAll('style[data-plugin="dsh-session-alert"]'))
})

test('DOM 替身不提供 styles：真实页面上没有这个符号，补上它这个审计就失去意义', async () => {
  const dom = makeDom({})
  // 故意先放一个假的 styles 进去，确认审计的运行器会把它**删掉**。
  globalThis.styles = { insert: () => () => {} }
  try {
    const run = await runClientHalf({ source: CLIENT_SOURCE, dom })
    assert.equal(run.error, null, `在删掉 styles 之后运行不应抛错：${run.error && run.error.message}`)
  } finally {
    delete globalThis.styles
  }
})


// ------------------------------------------- 事件载荷形状（照真实契约，不自己编）
//
// 这一组守的是**「载荷字段读对了没有」**。它与 `next()` 那条审计是两件事：
//
//  - 审计守的是「瀑布监听器有没有交出决定权」；
//  - 这一组守的是「交出去之前，它有没有把会话与摘要读对」。
//
// 为什么必须单独有：这个错误犯过两次，形态相同——**测试的载荷是测试自己编的**。
// 第二次（本次）表现是通知正文「… · 未知会话 正在等待你的回答：」：会话名退化、
// 摘要为空，而事件照发、页面上不报任何错。接线测试当时全绿。
//
// 因此这里做两件事：
//  1. 用**真实契约**的载荷跑一遍，断言渲染出的正文（会话名 + 问题原文）；
//  2. **反向断言**：喂旧的自造形状时，同一条断言必须失败。
//     没有第 2 条，第 1 条将来还会再失效一次——它以前就失效过。
//
// 投递走**抑制路径**（desktop 报在焦点 + 关铃声），因此测试既不弹通知也不发声，
// 但活动列表里留下完整渲染好的正文。`via` 也一并断言，确保这条测试始终是静默的。

test('question 载荷按真实契约解析：正文里有会话名与问题原文', async () => {
  const h = freshHarness({ suppressWhenFocused: true, chime: { enabled: false } })
  await postClientState(h.routes, 'desktop', true)
  h.handlers.get('user-questions/request').call(h.scoped, questionRequestPayload(), () => {})
  await tick()
  const state = await readState(h.routes)
  assert.notEqual(state, null, '读不到 /state')
  const entry = state.dispatch.recent[0]
  assert.ok(entry !== undefined, '没有记录到任何投递')
  assert.equal(entry.via, 'suppressed-silent', `这条测试必须保持静默，实际 via=${entry.via}`)
  assert.match(String(entry.body), new RegExp(SESSION_TITLE), '正文里没有会话名（{session} 没解析出来）')
  assert.match(String(entry.body), /要不要保留旧的迁移脚本/, '正文里没有问题原文（{summary} 取错字段）')
})

test('旧的自造载荷形状必须无法通过同一条断言（否则测试又在喂饱自己）', async () => {
  const h = freshHarness({ suppressWhenFocused: true, chime: { enabled: false } })
  await postClientState(h.routes, 'desktop', true)
  // 旧形状：顶层的 `question` 字符串，且没有 agent 字段——这正是当初测试自己编的那个。
  h.handlers.get('user-questions/request').call(h.scoped, { question: '要不要保留旧的迁移脚本？' }, () => {})
  await tick()
  const state = await readState(h.routes)
  const entry = state.dispatch.recent[0]
  assert.ok(entry !== undefined, '没有记录到任何投递')
  assert.ok(
    !/要不要保留旧的迁移脚本/.test(String(entry.body)),
    `旧形状居然也能渲染出问题原文，说明这条断言的判据不对：${entry.body}`,
  )
})

test('approval 载荷按真实契约解析：正文里有会话名与工具名', async () => {
  const h = freshHarness({ suppressWhenFocused: true, chime: { enabled: false } })
  await postClientState(h.routes, 'desktop', true)
  h.handlers.get('approval/request').call(h.scoped, approvalRequestPayload(), () => {})
  await tick()
  const state = await readState(h.routes)
  const entry = state.dispatch.recent[0]
  assert.ok(entry !== undefined, '没有记录到任何投递')
  assert.equal(entry.scenario, 'approval')
  assert.match(String(entry.body), new RegExp(SESSION_TITLE), '正文里没有会话名')
  assert.match(String(entry.body), /run_command/, '正文里没有工具名')
})

test('客户端上报的样式实测经 /state 暴露（机器可读的那一半）', async () => {
  const h = freshHarness()
  const styles = {
    injected: true,
    tags: 1,
    dynTags: 0,
    chars: 7459,
    rules: 68,
    applied: { display: 'flex', gap: '16px', fontSize: '13px' },
    error: null,
  }
  await postClientState(h.routes, 'desktop', true, styles)
  const state = await readState(h.routes)
  const record = (state.clients.styles || []).find((s) => s.kind === 'desktop')
  assert.ok(record !== undefined, `clients.styles 里没有 desktop 的读数：${JSON.stringify(state.clients.styles)}`)
  assert.equal(record.report.injected, true)
  assert.equal(record.report.rules, 68)
  assert.equal(record.report.applied.display, 'flex')
  assert.ok(typeof record.ageMs === 'number', '缺少 ageMs，无法判断读数有多旧')
})

test('缺 styles 字段的上报不会抹掉已有读数（旧客户端不该把诊断清空）', async () => {
  const h = freshHarness()
  await postClientState(h.routes, 'desktop', true, { injected: true, tags: 1, chars: 10, rules: 2, applied: null })
  await postClientState(h.routes, 'desktop', true) // 不带 styles
  const state = await readState(h.routes)
  const record = (state.clients.styles || []).find((s) => s.kind === 'desktop')
  assert.ok(record !== undefined, '不带 styles 的上报把读数抹掉了')
  assert.equal(record.report.tags, 1)
})

// ------------------------------------------- 客户端行为：自动保存与标签名本地化
//
// 这一组守的是**行为**，不是字符串：真的把组件挂起来、改一个字段、推着计时器走，
// 看它有没有把改动写到 Host。它覆盖四种真实的坑：
//   1. 改了字段却永远不保存（自动保存没接上）；
//   2. 每敲一下键盘就写一次盘（缺少防抖）；
//   3. **切换/关闭设置页时没落盘**——用户点名要的那一刻，靠组件卸载时的清理函数；
//   4. 「存完又发现改动」的自咬循环。
// 第 3、4 条只有在替身真的模拟「ref 跨渲染存活 + 依赖比较 + 卸载清理」时才测得到，
// 见 scripts/client-react-stub.mjs 的注释。

test('自动保存：装载不写盘、改动防抖后写一次、切换/关闭设置页立刻写一次、存完不自咬', async () => {
  const { problems, evidence } = await auditClientAutosave({ source: CLIENT_SOURCE, snapshot: sampleState() })
  assert.deepEqual(problems, [], `自动保存行为审计失败：\n  - ${problems.join('\n  - ')}`)
  assert.equal(evidence.saveButtonSeen, false, '界面上不该再有「保存」按钮')
  assert.equal(evidence.postsAfterLoad, 2, `应当恰好写 2 次配置（防抖 1 + 卸载 1），实际 ${evidence.postsAfterLoad}`)
  assert.deepEqual(evidence.debounceMs, [700], '防抖时长应当是 700ms')
})

test('设置页标签名按语言给：中文「会话通知」，其余语言「Session Alert」', async () => {
  const { problems, evidence } = await auditClientAutosave({ source: CLIENT_SOURCE, snapshot: sampleState() })
  assert.deepEqual(problems.filter((p) => p.includes('标签名')), [])
  assert.equal(evidence.titleZh, '会话通知')
  assert.equal(evidence.titleEn, 'Session Alert')
})

test('行为审计本身有效：破坏自动保存、加回保存按钮、拿走发送按钮、改回标签名，都必须被抓出来', async () => {
  // 变异测试。一个不会失败的检查等于没有检查——这四种破坏各自对应需求的一半。
  const mutations = [
    {
      label: '去掉「卸载时保存」',
      source: CLIENT_SOURCE.split('flushSave({ ui: false })').join('void 0'),
      expect: /卸载/,
    },
    {
      label: '给按钮文案塞上「保存」',
      source: CLIENT_SOURCE.replace("sendPreview: '发送这条通知',", "sendPreview: '保存',"),
      expect: /保存.*按钮/,
    },
    {
      label: '把「发送这条通知」按钮降级成普通按钮',
      source: CLIENT_SOURCE.replace("className: 'dsa-btn dsa-btn-primary dsa-btn-sm',", "className: 'dsa-btn dsa-btn-sm',"),
      expect: /找不到「发送这条通知」按钮/,
    },
    {
      label: '把发送结果挪回页面底部（用户点了看不到反应）',
      source: CLIENT_SOURCE.split("where: 'editor'").join("where: 'footer'"),
      expect: /没有显示在「发送这条通知」那一行/,
    },
    {
      label: '把标签名改回去',
      source: CLIENT_SOURCE.replace("title: '会话通知',", "title: 'SessionAlert',")
        .replace("title: 'Session Alert',", "title: 'SessionAlert',"),
      expect: /会话通知|Session Alert/,
    },
  ]
  for (const mutation of mutations) {
    assert.notEqual(mutation.source, CLIENT_SOURCE, `${mutation.label}：变异没能构造出来（找不到原文），这个检查自身已失效`)
    const { problems } = await auditClientAutosave({ source: mutation.source, snapshot: sampleState() })
    assert.ok(
      problems.some((p) => mutation.expect.test(p)),
      `${mutation.label} 必须被抓出来，实际：${JSON.stringify(problems)}`,
    )
  }
})

// ------------------------------------------------------- 设置页的「发送这条通知」
//
// 预览投递（`bypass`）的语义只有一条：**用户当场按下的动作必须看得见结果**。
// 因此它绕过去重、场景开关、场景最小间隔、限流与抑制；但不绕总开关
// （「别给我发通知」是明确意图，此时该如实回一句，而不是照发）。
// 另外它**不占用限流窗口**——否则点两下预览就能把一条真实提醒挤掉，而用户不会预料到。

test('预览投递绕过去重、场景开关、最小间隔、限流与抑制', async () => {
  const h = harness({
    patch: (c) => {
      c.scenarios.turnEnd.enabled = false            // 关着的场景也该能预览
      c.scenarios.turnEnd.minIntervalSeconds = 600   // 冷却中
      c.rateLimit.max = 1
      c.suppressWhenFocused = true
    },
  })
  // 先把限流窗口占满
  h.dispatcher.dispatch({ scenario: 'approval', body: '占位', dedupeKey: 'x' })
  await h.settle()
  // 普通投递此刻会被拦下
  const blocked = h.dispatcher.dispatch({ scenario: 'turnEnd', body: '普通投递', dedupeKey: 'y' })
  assert.notEqual(blocked.sent, true, '普通投递应当被限流/开关拦下')
  // 预览照样发得出去，而且带抑制也不会被扣下
  const preview = h.dispatcher.dispatch({
    scenario: 'turnEnd', body: '预览这条', dedupeKey: 'z', suppressed: true, bypass: true,
  })
  assert.equal(preview.sent, true, `预览应当发出，实际 ${JSON.stringify(preview)}`)
  await h.settle()
  assert.equal(h.sent[h.sent.length - 1].body, '预览这条')
})

test('预览投递不占用限流窗口，也不更新场景冷却', async () => {
  const h = harness({ patch: (c) => { c.rateLimit.max = 2 } })
  for (let i = 0; i < 5; i += 1) {
    assert.equal(h.dispatcher.dispatch({ scenario: 'turnEnd', body: `预览 ${i}`, bypass: true }).sent, true)
  }
  await h.settle()
  assert.equal(h.dispatcher.snapshot().windowUsed, 0, '预览不该占用限流窗口')
  // 窗口没被占用，真实投递仍有完整额度。
  assert.equal(h.dispatcher.dispatch({ scenario: 'turnEnd', body: '真实 1', dedupeKey: 'r1' }).sent, true)
  assert.equal(h.dispatcher.dispatch({ scenario: 'turnEnd', body: '真实 2', dedupeKey: 'r2' }).sent, true)
})

test('预览投递仍然尊重总开关', () => {
  const h = harness({ patch: (c) => { c.enabled = false } })
  const result = h.dispatcher.dispatch({ scenario: 'turnEnd', body: '预览这条', bypass: true })
  assert.deepEqual(result, { sent: false, reason: 'plugin-disabled' })
})

test('预览连点两下都发得出去，且不污染去重表', async () => {
  const h = harness()
  assert.equal(h.dispatcher.dispatch({ scenario: 'turnEnd', body: '一样的', dedupeKey: 'same', bypass: true }).sent, true)
  assert.equal(h.dispatcher.dispatch({ scenario: 'turnEnd', body: '一样的', dedupeKey: 'same', bypass: true }).sent, true)
  await h.settle()
  assert.equal(h.sent.length, 2, '两次预览都应当真的发出去')
  // 同样正文的真实事件不该因为刚才的预览被判成重复。
  assert.equal(h.dispatcher.dispatch({ scenario: 'turnEnd', body: '一样的', dedupeKey: 'same' }).sent, true)
})

test('预览接口：未知场景与空正文都如实回 400，不发任何东西', async () => {
  // 只打**不会真的投递**的分支：合法请求会走投递链（真发通知），那由 dispatcher 的单测覆盖。
  const h = freshHarness()
  const unknown = await callRoute(
    h.routes.find((r) => r.kind === 'prefix'),
    'POST', '/api/dsh-session-alert/notify', JSON.stringify({ scenario: 'nope', body: 'x' }),
  )
  assert.equal(unknown.status, 400, `未知场景应当回 400，实际 ${unknown.status}`)
  assert.match(String(unknown.body.error), /未知场景/)

  const empty = await callRoute(
    h.routes.find((r) => r.kind === 'prefix'),
    'POST', '/api/dsh-session-alert/notify', JSON.stringify({ scenario: 'turnEnd', body: '   ' }),
  )
  assert.equal(empty.status, 400, `空正文应当回 400，实际 ${empty.status}`)
  assert.match(String(empty.body.error), /预览为空/)
})

// --------------------------------------------------- 通知署名（通知最上方那一行）
//
// 用户看到的「通知标题」其实是 Windows 用 AUMID 的**显示名**渲染的应用名，
// 而不是 toast XML 里的标题行。因此：显示名同步成功后，自有 AUMID 那一条**不该再写标题行**
// （否则同一句话出现两次）；后备 AUMID（应用名是「Windows PowerShell」）则**必须保留**
// 标题行——去掉它，通知就完全看不出是谁发的。

test('投递脚本：署名同步后自有 AUMID 不写标题行，后备 AUMID 始终保留', () => {
  const senders = [{ aumid: contract.PRIMARY_AUMID, code: 0 }, { aumid: contract.FALLBACK_AUMID, code: 5 }]
  // 按**顺序**取发送者行（第一行是自有 AUMID、第二行是后备），不去硬编码 base64 片段——
  // 第一版就是这么写的，而片段对不上时报出来的失败是「后备 AUMID 必须保留标题行」，
  // 看起来像产品错了，其实是断言自己的定位方式错了。
  const senderFlags = (script) => script.split('\r\n')
    .filter((line) => /@\{ aumid = .*withTitle = \$/.test(line))
    .map((line) => /\$true|\$false/.exec(line)[0])

  const notSynced = senderFlags(notify.buildToastScript({ title: 'T', body: 'B', senders, titleInAppName: false }))
  assert.deepEqual(notSynced, ['$true', '$true'], '署名未同步时两条都要写标题行')

  const synced = senderFlags(notify.buildToastScript({ title: 'T', body: 'B', senders, titleInAppName: true }))
  assert.deepEqual(synced, ['$false', '$true'],
    '署名已同步时自有 AUMID 不写标题行；后备 AUMID（应用名是 Windows PowerShell）必须保留')
})

test('投递脚本：标题节点确实受 $WithTitle 控制，且正文节点无条件写出', () => {
  const script = notify.buildToastScript({ title: 'T', body: 'B' })
  assert.match(script, /if \(\$WithTitle\) \{/)
  assert.match(script, /-WithTitle \(\[bool\]\$sender\.withTitle\)/)
  // 正文节点必须在 if 之外——否则不写标题时会连正文一起丢掉。
  const bodyAppend = script.indexOf("[void]$binding.AppendChild($bodyNode)")
  const ifStart = script.indexOf('if ($WithTitle) {')
  const ifEnd = script.indexOf('}', script.indexOf("[void]$titleNode.AppendChild"))
  assert.ok(bodyAppend > ifEnd && bodyAppend > ifStart, '正文节点应当在 $WithTitle 分支之外')
})

test('全部 .ps1 都是 UTF-8 BOM + CRLF（PowerShell 5.1 的硬要求）', () => {
  // 这一条是本轮真实踩坑后补的：新写的 .ps1 用无 BOM 的 UTF-8，Windows PowerShell 5.1
  // 会按 ANSI 读它，中文注释与字符串全部变成乱码，**连代码结构都会被读歪**
  // （实测报出来的错是「DisplayName 不能为空」——看起来像参数传错了，其实是编码）。
  // 只支持 LF 的编辑器（以及某些工具）会悄悄写回 LF，因此这条断言盯住两样东西。
  const dirs = ['scripts', 'experiments']
  const files = []
  for (const dir of dirs) {
    for (const entry of readdirSync(join(PACKAGE_ROOT, dir))) {
      if (entry.endsWith('.ps1')) files.push(join(PACKAGE_ROOT, dir, entry))
    }
  }
  assert.ok(files.length > 0, '没有找到任何 .ps1——这条检查会静默失效')
  for (const file of files) {
    const bytes = readFileSync(file)
    const hasBom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF
    assert.ok(hasBom, `${file} 缺少 UTF-8 BOM（PowerShell 5.1 会把中文读成乱码）`)
    const text = bytes.toString('utf8')
    const bareLf = /(?<!\r)\n/.test(text)
    assert.ok(!bareLf, `${file} 里有裸 LF（PowerShell 5.1 的 param 块要求 CRLF）`)
  }
})

if (process.argv.includes('--toast')) {
  test('真机冒烟：真发一条通知，按退出码判定实际走通了哪条路径', async () => {
    assert.equal(process.platform, 'win32', `--toast 只在 Windows 上有意义，当前是 ${process.platform}`)
    const registered = notify.isAumidRegistered(contract.PRIMARY_AUMID)
    console.log(`  AUMID 注册状态：${registered ? '已注册（期望退出码 0）' : '未注册（会借用后备 AUMID，期望 5）'}`)
    const outcome = await sendWindowsToast({
      title: 'DSH Session Alert · 自检',
      body: `scripts/selftest.mjs --toast，退出码语义见 DELIVERY_CODES：${Object.keys(DELIVERY_CODES).join(' / ')}`,
      sound: true,
      durationSeconds: 10,
    })
    console.log(`  投递结果：ok=${outcome.ok} code=${outcome.code ?? '-'} note=${outcome.note ?? '-'} error=${outcome.error ?? '-'}`)
    assert.equal(outcome.ok, true, outcome.error ?? '投递失败：没有任何一条路径被平台接受')
    assert.ok(DELIVERY_CODES[outcome.code] !== undefined, `退出码 ${outcome.code} 不属于 ${Object.keys(DELIVERY_CODES).join('/')}`)
  })
} else {
  console.log('提示：加 --toast 会在本机真发一条通知并按退出码判定路径（需要 Windows 与已注册的 AUMID）。')
}
