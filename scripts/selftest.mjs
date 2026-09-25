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
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

const notify = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'notify.js')).href)
const contract = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib', 'contract.js')).href)
const { auditListenerModes, auditPackageListeners } = await import(
  pathToFileURL(join(PACKAGE_ROOT, 'scripts', 'listener-mode-audit.mjs')).href
)

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
  const h = harness()
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

// ------------------------------------------------------- 可选的真机冒烟（--toast）

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
