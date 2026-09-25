/**
 * 操作中心留存探针 —— 人工验证工具，不参与 `npm test`。
 *
 * 用来检验（并已经**排除**）设计文档第二节第 8 条：
 *
 *   「操作中心持久化需要一次 HKCU 写入：建 ...\Notifications\Settings\<aumid> 键并写
 *     ShowInActionCenter=1。否则 Win32 AUMID 的 toast 在应用获得焦点后就会从操作中心消失。」
 *
 * ## 实测结论（本机，未写 ShowInActionCenter）
 *
 * - **跨进程留存正常**：两条 `durationSeconds=0` 的通知由**两个不同进程**发出，
 *   之后从第三个进程回读，`historyCount: 2` —— 不需要那次 HKCU 写入。
 * - **条目消失的真因是 `ExpirationTime`**：两条 `durationSeconds=5` 的通知先让计数升到 4，
 *   5 秒后回落到 2。这是 `durationSeconds > 0` 的正常行为，不是「不持久」。
 *
 * 这条结论重要在于它会误导实现：先用「条数 > 0」去证明横幅、再被自己的过期时间骗一次，
 * 就会去写一个既无用、又永久改变用户通知设置的注册表值。**先归因，再动手。**
 *
 * ## 用法
 *
 *   node experiments/notify-action-center-persist.mjs state         # 看当前设置键与历史
 *   node experiments/notify-action-center-persist.mjs send-urgent   # 发两条常驻（跨两个进程）
 *   node experiments/notify-action-center-persist.mjs send-timed    # 发两条 5 秒过期
 *   node experiments/notify-action-center-persist.mjs clear         # 清空自有 AUMID 的历史
 *
 * 重新检验「第 8 条已排除」这个结论时，才需要下面两条 —— **它们会写用户的 HKCU**：
 *
 *   node experiments/notify-action-center-persist.mjs settings-key-write
 *   node experiments/notify-action-center-persist.mjs settings-key-remove   # 用完请务必执行
 *
 * 期望序列（未写设置键）：
 *
 *   clear → send-urgent → state   ⇒ historyCount: 2
 *   send-timed → state            ⇒ historyCount: 4
 *   （等 8 秒）→ state             ⇒ historyCount: 2
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
const OUT = join(TMP, 'persist.txt')
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')
const phase = process.argv[2] ?? 'state'

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
  `$out = ConvertFrom-B64Text '${b64(OUT)}'`,
].join('\r\n')

const FOOT = 'exit 0\r\n'

/** 读注册表 + 操作中心历史，落盘成文本。 */
async function probeState(label) {
  if (existsSync(OUT)) rmSync(OUT, { force: true })
  const script = [
    HEAD,
    `$aumid = ConvertFrom-B64Text '${b64(contract.PRIMARY_AUMID)}'`,
    `$settings = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\' + $aumid`,
    '$lines = @()',
    '$lines += "aumid: $aumid"',
    '$lines += "settingsKeyExists: " + (Test-Path $settings)',
    'if (Test-Path $settings) {',
    '    try { $lines += "ShowInActionCenter: " + (Get-ItemProperty -Path $settings -Name ShowInActionCenter -ErrorAction Stop).ShowInActionCenter } catch { $lines += "ShowInActionCenter: <未设置>" }',
    '}',
    'try {',
    '    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
    '    $items = @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($aumid))',
    '    $lines += "historyCount: " + $items.Count',
    '    foreach ($item in $items) { $lines += "  tag=" + [string]$item.Tag + " | text=" + [string]$item.Content.InnerText }',
    '} catch { $lines += "historyError: " + $_.Exception.Message }',
    '[IO.File]::WriteAllLines($out, $lines, (New-Object Text.UTF8Encoding($false)))',
    FOOT,
  ].join('\r\n')
  await spawnIdentical(script)
  const text = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '<未落盘>'
  console.log(`--- ${label} ---`)
  console.log(text.trimEnd().split('\n').map((line) => `    ${line}`).join('\n'))
  return text
}

if (phase === 'state') {
  await probeState('当前状态')
} else if (phase === 'send') {
  // 10 秒过期：用来对照 send-urgent，观察 ExpirationTime 到期后条目消失
  for (const index of [1, 2]) {
    const outcome = await notify.sendWindowsToast({
      title: `持久化探针 ${index}`,
      body: `这是第 ${index} 条，10 秒后过期`,
      sound: false,
      durationSeconds: 10,
    })
    console.log(`  第 ${index} 条: ok=${outcome.ok} code=${outcome.code}`)
  }
} else if (phase === 'send-urgent') {
  // durationSeconds=0 → 不设 ExpirationTime，Windows 应长期保留
  for (const index of [1, 2]) {
    const outcome = await notify.sendWindowsToast({
      title: `常驻探针 ${index}`,
      body: `第 ${index} 条常驻通知`,
      sound: false,
      durationSeconds: 0,
    })
    console.log(`  常驻第 ${index} 条: ok=${outcome.ok} code=${outcome.code}`)
  }
} else if (phase === 'send-timed') {
  // durationSeconds=5 → 设 ExpirationTime，5 秒后应从操作中心消失
  for (const index of [1, 2]) {
    const outcome = await notify.sendWindowsToast({
      title: `定时探针 ${index}`,
      body: `第 ${index} 条 5 秒后过期`,
      sound: false,
      durationSeconds: 5,
    })
    console.log(`  定时第 ${index} 条: ok=${outcome.ok} code=${outcome.code}`)
  }
} else if (phase === 'clear') {
  if (existsSync(OUT)) rmSync(OUT, { force: true })
  const script = [
    HEAD,
    `$aumid = ConvertFrom-B64Text '${b64(contract.PRIMARY_AUMID)}'`,
    '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
    '$lines = @()',
    'try {',
    '    [Windows.UI.Notifications.ToastNotificationManager]::History.Clear($aumid)',
    '    $lines += "已清空 $aumid 的操作中心历史"',
    '} catch { $lines += "清空失败: " + $_.Exception.Message }',
    'try { $lines += "剩余条数: " + @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($aumid)).Count } catch { }',
    '[IO.File]::WriteAllLines($out, $lines, (New-Object Text.UTF8Encoding($false)))',
    FOOT,
  ].join('\r\n')
  await spawnIdentical(script)
  console.log(existsSync(OUT) ? readFileSync(OUT, 'utf8').trimEnd() : '<未落盘>')
} else if (phase === 'settings-key-write' || phase === 'settings-key-remove') {
  if (existsSync(OUT)) rmSync(OUT, { force: true })
  const create = phase === 'settings-key-write'
  const script = [
    HEAD,
    `$aumid = ConvertFrom-B64Text '${b64(contract.PRIMARY_AUMID)}'`,
    `$settings = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\' + $aumid`,
    '$lines = @()',
    `if (${create ? '$true' : '$false'}) {`,
    '    New-Item -Path $settings -Force | Out-Null',
    '    Set-ItemProperty -Path $settings -Name ShowInActionCenter -Value 1 -Type DWord',
    '    $lines += "已写 ShowInActionCenter=1: $settings"',
    '} else {',
    '    if (Test-Path $settings) { Remove-Item -LiteralPath $settings -Recurse -Force; $lines += "已删除: $settings" } else { $lines += "本来就不存在: $settings" }',
    '}',
    '$lines += "settingsKeyExists: " + (Test-Path $settings)',
    '[IO.File]::WriteAllLines($out, $lines, (New-Object Text.UTF8Encoding($false)))',
    FOOT,
  ].join('\r\n')
  await spawnIdentical(script)
  console.log(existsSync(OUT) ? readFileSync(OUT, 'utf8').trimEnd() : '<未落盘>')
} else {
  console.error(`未知阶段 '${phase}'。可用：state | send | send-urgent | send-timed | clear | settings-key-write | settings-key-remove`)
  process.exit(2)
}
