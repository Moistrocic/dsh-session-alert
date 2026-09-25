/**
 * 通知降级演练的 **Node 侧阶段实现**（人工验收工具，不参与 `npm test`）。
 *
 * 它由 [`notify-degradation-drill.ps1`](./notify-degradation-drill.ps1) 逐阶段调用，
 * 也可以单独跑某一阶段做定点排查。为什么要单独一个文件：阶段里必须调用**真实的**
 * `lib/notify.js`（真实 spawn、真实退出码），而破坏性的「改开始菜单快捷方式」只能放在
 * PowerShell 侧用 `try/finally` 兜住——两边职责分开，恢复逻辑就不会被 JS 的异常路径绕过。
 *
 * 用法（`<phase>` 见下）：
 *
 *   node experiments/notify-drill-phases.mjs baseline
 *
 * 各阶段与期望结果：
 *
 * | phase | 做什么 | 期望 |
 * | --- | --- | --- |
 * | `baseline` | 中文 / 注入 / 常驻 / 带按钮四条真机投递 + 两种铃声 + 控制台判据 | 全部 PASS，`code=0`，`NO_CONSOLE` |
 * | `content` | 逐条发完**立刻**回读操作中心里存下来的 XML | 中文与注入逐字显示，`scenario="urgent"` 与 `<actions>` 都在 |
 * | `fallback` | 快捷方式此时已被改名 | 投递计划只剩后备 AUMID，`code=5` |
 * | `balloon` | 快捷方式未注册 + 解释器强制为 pwsh 7 | `code=6`（托盘气泡） |
 * | `restored` | 快捷方式已恢复 | 投递计划恢复两项，`code=0` |
 * | `enoent` | 第一个解释器候选不存在 | 落到 PS 5.1 绝对路径，`code=0` |
 * | `cleanup` | 清空自有 AUMID 的操作中心历史 | 测试通知不留在用户的通知中心里 |
 *
 * 退出码：该阶段全部 PASS 为 0，有 FAIL 为 1。
 *
 * **注意**：`fallback` / `balloon` 阶段本身不改任何东西，但只有在快捷方式被改名之后
 * 才有意义——改名与恢复由 `notify-degradation-drill.ps1` 负责，请不要手工分开跑。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const notify = await import(pathToFileURL(join(REPO, 'lib', 'notify.js')).href)
const contract = await import(pathToFileURL(join(REPO, 'lib', 'contract.js')).href)

const PS5 = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const TMP = join(process.env.TEMP ?? REPO, 'dsh-session-alert-drill')
mkdirSync(TMP, { recursive: true })
const consoleReport = join(TMP, 'console.txt')
const historyReport = join(TMP, 'history.txt')
const phase = process.argv[2] ?? 'baseline'
const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64')

let failures = 0
function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures += 1
  console.log(`  [${mark}] ${label}${detail.length > 0 ? ` —— ${detail}` : ''}`)
}
function show(label, outcome) {
  console.log(`  ${label}: ok=${outcome.ok} code=${outcome.code ?? '-'} note=${outcome.note ?? '-'} error=${outcome.error ?? '-'}`)
}

/** 用与 lib/notify.js 完全相同的 spawn 参数跑一段脚本（同一条无控制台约束）。 */
function spawnIdentical(script) {
  return new Promise((resolve) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', notify.utf16leBase64(script)]
    const child = spawn(PS5, args, { windowsHide: true, stdio: 'ignore', detached: false })
    child.on('error', (error) => resolve({ ok: false, error: error.message }))
    child.on('close', (code) => resolve({ ok: true, code }))
  })
}

const HEAD = [
  "$ErrorActionPreference = 'Stop'",
  'function ConvertFrom-B64Text { param([string]$Value) [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Value)) }',
].join('\r\n')

/** 清空自有 AUMID 的操作中心历史，让接下来的回读没有歧义。 */
async function clearHistory() {
  await spawnIdentical([
    HEAD,
    `$aumid = ConvertFrom-B64Text '${b64(contract.PRIMARY_AUMID)}'`,
    '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
    'try { [Windows.UI.Notifications.ToastNotificationManager]::History.Clear($aumid) } catch { }',
    'exit 0',
    '',
  ].join('\r\n'))
}

/**
 * 回读尾部：把这一个进程里**刚刚**存进操作中心的条目 XML 落盘。
 *
 * 加这个尾部是因为操作中心的历史会被 ExpirationTime 到期清掉（实测：durationSeconds=5
 * 的条目 5 秒后消失），事后从另一个进程读已经太晚；而内容必须是被平台**存下来**的那份，
 * 不能拿送进去的原文自证。
 */
function readbackTail(outputPath) {
  return [
    'try {',
    '    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
    `    $aumid = ConvertFrom-B64Text '${b64(contract.PRIMARY_AUMID)}'`,
    '    $items = @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($aumid))',
    '    $lines = @()',
    '    foreach ($item in $items) { $lines += [string]$item.Content.GetXml() }',
    `    [IO.File]::WriteAllLines((ConvertFrom-B64Text '${b64(outputPath)}'), $lines, (New-Object Text.UTF8Encoding($false)))`,
    '} catch { }',
    '',
  ].join('\r\n')
}

/** XML 反转义，用于把「存下来的 XML」还原成「用户看到的文本」。 */
function unescapeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 发一条通知并回读它存进操作中心的那份 XML。 */
async function sendAndRead({ label, scriptOptions }) {
  if (existsSync(historyReport)) rmSync(historyReport, { force: true })
  await clearHistory()
  const script = notify.buildToastScript(scriptOptions).replace('exit $exitCode', readbackTail(historyReport) + 'exit $exitCode')
  const outcome = await spawnIdentical(script)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const xml = existsSync(historyReport) ? readFileSync(historyReport, 'utf8').trim() : ''
  console.log(`  ${label}: 投递退出码 ${outcome.code}，回读到 ${xml.length > 0 ? '1' : '0'} 条 XML`)
  return { code: outcome.code, xml }
}

const CHINESE_TITLE = 'DSH 会话提醒 · 轮次结束'
const CHINESE_BODY = 'dsh-session-alert · 我的项目 已完成一轮，等待你的下一步指令。时间 12:34:56'
const INJECTION_TITLE = "it's a <b>title</b> '; exit 99; #"
const INJECTION_BODY = '<script>alert("x")</script> 中文 😀 \'quoted\' & <b>bold</b>'

console.log(`=== phase=${phase} ===`)
console.log(`  platform=${process.platform} PowerShell 5.1 存在=${existsSync(PS5)}`)
console.log(`  PRIMARY_AUMID=${contract.PRIMARY_AUMID}  FALLBACK_AUMID=${contract.FALLBACK_AUMID}`)
console.log(`  开始菜单快捷方式存在=${notify.isAumidRegistered(contract.PRIMARY_AUMID)}`)
console.log(`  DELIVERY_CODES=${JSON.stringify(contract.DELIVERY_CODES)}`)

if (phase === 'baseline') {
  console.log('--- 1. 中文标题与正文（10 秒横幅） ---')
  const chinese = await notify.sendWindowsToast({ title: CHINESE_TITLE, body: CHINESE_BODY, sound: true, durationSeconds: 10 })
  show('中文 toast', chinese)
  check('中文 toast 走自有 AUMID（退出码 0）', chinese.ok === true && chinese.code === 0, `code=${chinese.code}`)

  console.log('--- 2. 注入自测：标题含 \' 与 <b>，正文含 <script> 与引号 ---')
  const injected = await notify.sendWindowsToast({ title: INJECTION_TITLE, body: INJECTION_BODY, sound: false, durationSeconds: 10 })
  show('注入 toast', injected)
  check('注入内容不报错、走自有 AUMID（退出码 0）', injected.ok === true && injected.code === 0, `code=${injected.code}`)

  console.log('--- 3. 常驻（durationSeconds=0 → scenario="urgent"） ---')
  const urgent = await notify.sendWindowsToast({
    title: 'DSH 会话提醒 · 等待授权',
    body: '工具 Bash 等待你的授权（常驻，直到你关闭）',
    sound: true,
    durationSeconds: 0,
  })
  show('常驻 toast', urgent)
  check('常驻 toast 退出码 0', urgent.ok === true && urgent.code === 0, `code=${urgent.code}`)

  console.log('--- 4. 带按钮（approval 卡片：批准 / 拒绝） ---')
  const withActions = await notify.sendWindowsToast({
    title: 'DSH 会话提醒 · 等待授权',
    body: '工具 Bash 等待你的授权：rm -rf build',
    sound: true,
    durationSeconds: 0,
    actions: [
      { content: '批准', arguments: 'dsh-session-alert://open/?session=live-check&decision=approve', activationType: 'protocol' },
      { content: '拒绝', arguments: 'dsh-session-alert://open/?session=live-check&decision=deny', activationType: 'protocol' },
    ],
  })
  show('带按钮 toast', withActions)
  check('带按钮 toast 退出码 0', withActions.ok === true && withActions.code === 0, `code=${withActions.code}`)

  console.log('--- 5. 铃声（系统声音 / 音频文件） ---')
  const systemChime = await notify.playChime({ source: 'system' })
  show('系统铃声', systemChime)
  check('系统铃声成功', systemChime.ok === true, `error=${systemChime.error ?? '-'}`)
  const wav = 'C:/Windows/Media/Windows Notify System Generic.wav'
  const fileChime = await notify.playChime({ source: 'file', filePath: wav })
  show(`文件铃声(${wav})`, fileChime)
  check('文件铃声成功', fileChime.ok === true, `error=${fileChime.error ?? '-'}`)

  console.log('--- 6. 控制台分配判据（与真实投递完全相同的 spawn 参数与脚本体） ---')
  if (existsSync(consoleReport)) rmSync(consoleReport, { force: true })
  const probePrepend = [
    "$ErrorActionPreference = 'Continue'",
    'function ConvertFrom-B64Text { param([string]$Value) [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Value)) }',
    'try {',
    "    Add-Type -Language CSharp @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class DshBConInfo {',
    '  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("kernel32.dll")] public static extern int GetConsoleProcessList(int[] list, int count);',
    '  public static string Probe() {',
    '    int[] buf = new int[8];',
    '    int n = GetConsoleProcessList(buf, 8);',
    '    IntPtr h = GetConsoleWindow();',
    '    string state = h == IntPtr.Zero ? "NO_CONSOLE" : (IsWindowVisible(h) ? "CONSOLE_VISIBLE" : "CONSOLE_HIDDEN");',
    '    return state + " hwnd=" + h + " attachedProcs=" + n;',
    '  }',
    '}',
    "'@",
    `    [IO.File]::WriteAllText((ConvertFrom-B64Text '${b64(consoleReport)}'), [DshBConInfo]::Probe(), (New-Object Text.UTF8Encoding($false)))`,
    '} catch { }',
    '',
  ].join('\r\n')
  const probeScript = probePrepend + notify.buildToastScript({
    title: '控制台判据探针',
    body: '这条通知与探针同进程发出，用来证明投递不分配控制台',
    sound: false,
    senders: notify.deliveryPlan().senders,
    durationSeconds: 10,
  })
  const probeOutcome = await spawnIdentical(probeScript)
  await new Promise((resolve) => setTimeout(resolve, 400))
  const consoleState = existsSync(consoleReport) ? readFileSync(consoleReport, 'utf8').trim() : '<探针未落盘>'
  console.log(`  子进程自报控制台状态: ${consoleState}  （投递退出码 ${probeOutcome.code}）`)
  check('投递路径不分配控制台（GetConsoleWindow() 返回 NULL）', consoleState.startsWith('NO_CONSOLE'), consoleState)
  check('探针进程里的投递仍然成功（退出码 0）', probeOutcome.code === 0, `code=${probeOutcome.code}`)
} else if (phase === 'content') {
  console.log('--- 逐条回读操作中心里存下来的 XML ---')

  const chinese = await sendAndRead({
    label: '中文（10 秒）',
    scriptOptions: { title: CHINESE_TITLE, body: CHINESE_BODY, sound: true, senders: notify.deliveryPlan().senders, durationSeconds: 10 },
  })
  check('中文条投递成功（退出码 0）', chinese.code === 0, `code=${chinese.code}`)
  const chineseText = unescapeXml(chinese.xml)
  check('存下来的标题逐字等于送进去的中文', chinese.xml.includes(`<text>${CHINESE_TITLE}</text>`), chinese.xml)
  check('存下来的正文逐字等于送进去的中文', chineseText.includes(CHINESE_BODY))
  check('带默认提示音（<audio src="ms-winsoundevent:Notification.Default">）', chinese.xml.includes('ms-winsoundevent:Notification.Default'))
  check('非 0 时长仍用 duration="long" 申请最长横幅', chinese.xml.includes('duration="long"'))
  console.log(`    XML: ${chinese.xml}`)

  const injected = await sendAndRead({
    label: '注入（\' 与 <b>）',
    scriptOptions: { title: INJECTION_TITLE, body: INJECTION_BODY, sound: false, senders: notify.deliveryPlan().senders, durationSeconds: 10 },
  })
  check('注入条投递成功（退出码 0）', injected.code === 0, `code=${injected.code}`)
  const injectedText = unescapeXml(injected.xml)
  check('标题逐字显示（未被当成标记）', injectedText.includes(INJECTION_TITLE), injectedText)
  check('正文逐字显示（<script> 是文本不是脚本）', injectedText.includes(INJECTION_BODY), injectedText)
  check('尖括号在 XML 里已被转义', injected.xml.includes('&lt;b&gt;title&lt;/b&gt;') && injected.xml.includes('&lt;script&gt;'))
  check('关闭声音时是 <audio silent="true">', injected.xml.includes('silent="true"'))
  console.log(`    XML: ${injected.xml}`)

  const urgent = await sendAndRead({
    label: '常驻（durationSeconds=0）',
    scriptOptions: { title: 'DSH 会话提醒 · 常驻', body: '常驻形态：直到用户手动关闭', sound: true, senders: notify.deliveryPlan().senders, durationSeconds: 0 },
  })
  check('常驻条投递成功（退出码 0）', urgent.code === 0, `code=${urgent.code}`)
  check('存下来的 XML 带 scenario="urgent"', urgent.xml.includes('scenario="urgent"'), urgent.xml)
  console.log(`    XML: ${urgent.xml}`)

  const actions = await sendAndRead({
    label: '带按钮（批准 / 拒绝）',
    scriptOptions: {
      title: 'DSH 会话提醒 · 等待授权',
      body: '工具 Bash 等待你的授权',
      sound: true,
      senders: notify.deliveryPlan().senders,
      durationSeconds: 0,
      actions: [
        { content: '批准', arguments: 'dsh-session-alert://open/?session=live-check&decision=approve', activationType: 'protocol' },
        { content: '拒绝', arguments: 'dsh-session-alert://open/?session=live-check&decision=deny', activationType: 'protocol' },
      ],
    },
  })
  check('带按钮条投递成功（退出码 0）', actions.code === 0, `code=${actions.code}`)
  check('批准按钮进了通知', actions.xml.includes('content="批准"'))
  check('拒绝按钮进了通知', actions.xml.includes('content="拒绝"'))
  check('按钮参数是完整 URL（协议激活用）', actions.xml.includes('dsh-session-alert://open/?session=live-check&amp;decision=approve'))
  check('激活方式为 protocol', (actions.xml.match(/activationType="protocol"/g) ?? []).length === 2)
  console.log(`    XML: ${actions.xml}`)
} else if (phase === 'fallback') {
  console.log('--- 降级演练第 1 级：自有 AUMID 未注册，借用 Windows PowerShell 的 AUMID ---')
  check('此刻自有 AUMID 确实未被探测到注册', notify.isAumidRegistered(contract.PRIMARY_AUMID) === false)
  const plan = notify.deliveryPlan()
  console.log(`  投递计划: ${JSON.stringify(plan.senders)}`)
  check('投递计划里只有后备 AUMID（自有 AUMID 根本没被尝试）',
    plan.senders.length === 1 && plan.senders[0].aumid === contract.FALLBACK_AUMID, JSON.stringify(plan.senders))
  const outcome = await notify.sendWindowsToast({
    title: 'DSH 会话提醒 · 降级演练',
    body: '自有 AUMID 已被临时改名，这条应当由 Windows PowerShell 的身份发出（退出码 5）',
    sound: true,
    durationSeconds: 10,
  })
  show('后备 toast', outcome)
  check('回退到退出码 5（PowerShell 后备 AUMID）', outcome.ok === true && outcome.code === 5, `code=${outcome.code}`)
} else if (phase === 'balloon') {
  console.log('--- 降级演练第 2 级：让整条 toast 路径失败，落到托盘气泡 ---')
  const override = 'C:/Program Files/PowerShell/7/pwsh.exe'
  process.env.DSH_SESSION_ALERT_POWERSHELL = override
  console.log(`  DSH_SESSION_ALERT_POWERSHELL=${override}（PowerShell 7 没有内置 WinRT 类型投影，类型标记必然抛 Unable to find type）`)
  console.log(`  解释器候选: ${JSON.stringify(notify.powershellCandidates())}`)
  check('自有 AUMID 仍未注册', notify.isAumidRegistered(contract.PRIMARY_AUMID) === false)
  const outcome = await notify.sendWindowsToast({
    title: 'DSH 会话提醒 · 降级演练',
    body: 'toast 两条路径都失败，这条应当由托盘气泡发出（退出码 6）',
    sound: true,
    durationSeconds: 10,
  })
  show('托盘气泡', outcome)
  check('回退到退出码 6（托盘气泡后备）', outcome.ok === true && outcome.code === 6, `code=${outcome.code}`)
} else if (phase === 'restored') {
  console.log('--- 演练恢复：快捷方式已还原，应当回到自有 AUMID 路径 ---')
  check('自有 AUMID 已重新注册', notify.isAumidRegistered(contract.PRIMARY_AUMID) === true)
  const plan = notify.deliveryPlan()
  console.log(`  投递计划: ${JSON.stringify(plan.senders)}`)
  const outcome = await notify.sendWindowsToast({
    title: 'DSH 会话提醒 · 演练恢复',
    body: '快捷方式已还原，这条应当回到自有 AUMID（退出码 0）',
    sound: true,
    durationSeconds: 10,
  })
  show('恢复后 toast', outcome)
  check('恢复后回到退出码 0', outcome.ok === true && outcome.code === 0, `code=${outcome.code}`)
} else if (phase === 'enoent') {
  console.log('--- 解释器候选的降级：第一个候选不存在时应落到下一个，而不是整体失败 ---')
  process.env.DSH_SESSION_ALERT_POWERSHELL = 'C:/definitely/not/here/powershell.exe'
  console.log(`  解释器候选: ${JSON.stringify(notify.powershellCandidates())}`)
  const outcome = await notify.sendWindowsToast({
    title: 'DSH 会话提醒 · 解释器降级探针',
    body: '第一个候选不存在，应当落到 PS 5.1 绝对路径（退出码 0）',
    sound: false,
    durationSeconds: 10,
  })
  show('解释器降级 toast', outcome)
  check('仍然投递成功（退出码 0）', outcome.ok === true && outcome.code === 0, `code=${outcome.code}`)
} else if (phase === 'cleanup') {
  await clearHistory()
  console.log('  已清空自有 AUMID 的操作中心历史（测试通知不留在用户的通知中心里）')
}

console.log(`=== phase=${phase} 结束：FAIL=${failures} ===`)
process.exit(failures === 0 ? 0 : 1)
