/**
 * Windows 通知投递链与分发策略。
 *
 * ## 投递：一次 Send 就是一次降级链
 *
 * Windows 的 toast API 有一个致命的信息缺口：`Show()` 不返回任何有用信息。调用成功
 * **不代表**通知会显示——未注册的 AUMID 是合法发送者，通知会被接受进操作中心却
 * **不显示横幅**，且全程不报错。因此本模块用两个独立的手段代替那个不存在的返回值：
 *
 * 1. **发送者由注册状态选择，不靠乐观。** 自有 AUMID 只有它的开始菜单 `.lnk` 存在时
 *    才会被采用；否则直接借用 {@link FALLBACK_AUMID}（Windows PowerShell 自带，任何
 *    机器上都已注册）。
 * 2. **投递被验证，而不是被假定。** 每条 toast 带一个一次性随机 `Tag`，发送后回读
 *    操作中心历史并按 `Tag` 命中才算平台接受了它。
 *
 * 走通的路径由退出码承载，语义与既有实现一致（见 {@link DELIVERY_CODES}）：
 * `0` 自有 AUMID、`5` PowerShell 后备 AUMID、`6` 托盘气泡、`3` 全部失败。
 *
 * ## 为什么必须用 Windows PowerShell 5.1 与 `-EncodedCommand`
 *
 * PowerShell 7 里 `[Windows.UI.Notifications.ToastNotificationManager, ...,
 * ContentType=WindowsRuntime]` 会抛 `Unable to find type`（.NET 5 移除了内置的 WinRT
 * 类型投影），所以脚本只交给 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`。
 *
 * 标题与正文**绝不拼进命令行**：整个脚本以 UTF-16LE 的 base64 经 `-EncodedCommand`
 * 传入，脚本内的数据字段再各自以 base64 承载，XML 由 `CreateTextNode` 构造。这样
 * 引号、尖括号、emoji、换行都不可能逃逸成语法或注入。
 *
 * 子进程一律 `stdio: 'ignore'` + `windowsHide: true`：实测这对组合**不分配控制台**
 * （判据是 `GetConsoleWindow()` 返回 NULL），而管道 stdio 既会被沙箱拦，也不是无闪窗。
 *
 * @module dsh-session-alert/notify
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_DURATION_SECONDS,
  DELIVERY_CODES,
  FALLBACK_AUMID,
  MAX_DURATION_SECONDS,
  PRIMARY_AUMID,
  defaultConfig,
} from './contract.js'

export { PRIMARY_AUMID, FALLBACK_AUMID, DELIVERY_CODES }

/** 相同消息在该窗口内折叠成一条。 */
const DEDUPE_MS = 10_000

/** 活动列表保留条数。 */
const RECENT_LIMIT = 20

/** 合并后的提醒最早也要等这么久才发，避免零延迟定时器把它立刻冲出去。 */
const COALESCE_MIN_DELAY_MS = 250

/** 限流窗口边界上多留一点余量，防止因取整误差立刻又被拒。 */
const WINDOW_MARGIN_MS = 50

/** 子进程最长存活时间；到点即杀，绝不让一次投递挂住 Host。 */
const SPAWN_TIMEOUT_MS = 30_000

/** 发送后回读历史的节奏：最多 3 次、每次间隔 400ms。 */
const VERIFY_ATTEMPTS = 3
const VERIFY_INTERVAL_MS = 400

/** 托盘气泡显示时长（脚本内 `ShowBalloonTip` 的毫秒数）。 */
const BALLOON_MS = 8_000

/** 需要维护去重表的规模上限；超过就顺手清一次过期项。 */
const DEDUPE_SWEEP_THRESHOLD = 128

/** 包根目录，用于定位 `scripts/`。 */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 一个字符串的 UTF-16LE base64 —— 正是 `powershell.exe -EncodedCommand` 期望的编码。
 *
 * 用 `Buffer.from(text, 'utf16le')`：它按 UTF-16 码元逐个编码，代理对（emoji）与
 * 中文都能无损往返。
 * @param text - 脚本文本。
 * @returns base64 字符串。
 */
export function utf16leBase64(text) {
  return Buffer.from(String(text), 'utf16le').toString('base64')
}

/** 一个字符串的 UTF-8 base64，供脚本内的数据字段自解码。 */
function utf8Base64(text) {
  return Buffer.from(String(text), 'utf8').toString('base64')
}

/**
 * 归一化通知按钮。契约是 `[{ content, arguments, activationType }]`，
 * 同时容忍 `label` 这个别名；内容为空的条目直接丢掉。
 *
 * 上限 5 个：Win32 toast 的 `<actions>` 最多 5 个按钮，多出来的不是被忽略而是会让
 * 整条通知构造失败。
 * @param actions - 调用方给的按钮数组。
 * @returns 干净的按钮数组。
 */
export function normaliseActions(actions) {
  return (Array.isArray(actions) ? actions : [])
    .filter((action) => action !== null && typeof action === 'object')
    .slice(0, 5)
    .map((action) => ({
      content: String(action.content ?? action.label ?? ''),
      arguments: String(action.arguments ?? ''),
      activationType: String(action.activationType ?? 'protocol'),
    }))
    .filter((action) => action.content.length > 0)
}

/**
 * 投递路径的中文说明。
 * @param code - 退出码。
 * @returns 该码的说明；未知码给出一句可读的兜底。
 */
export function deliveryNote(code) {
  return DELIVERY_CODES[code] ?? `未知退出码 ${code}`
}

/**
 * 把显示时长钳进合法范围。
 *
 * 契约：`0` 表示常驻（脚本里用 `scenario="urgent"`），正数表示若干秒后过期，
 * 上限是 {@link MAX_DURATION_SECONDS}。非数值一律当作 `0`——宁可常驻，也不要
 * 因为一个坏配置让通知一闪而过。
 * @param value - 配置里的时长。
 * @returns `0..MAX_DURATION_SECONDS` 之间的整数。
 */
export function clampDurationSeconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.min(MAX_DURATION_SECONDS, Math.round(value)))
}

/**
 * 某个 AUMID 的开始菜单快捷方式路径。
 * @param aumid - 应用用户模型 ID。
 * @param env - 环境变量表，默认 `process.env`（测试可注入）。
 * @returns `.lnk` 路径；`%APPDATA%` 不可用时返回 `undefined`。
 */
export function aumidShortcutPath(aumid, env = process.env) {
  const appData = env === undefined || env === null ? undefined : env.APPDATA
  if (typeof appData !== 'string' || appData.length === 0) return undefined
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${aumid}.lnk`)
}

/**
 * AUMID 是否已在系统里注册。
 *
 * **这才是决定横幅会不会出现的判据**，而不是 `Show()` 有没有抛异常。未注册的 AUMID
 * 是合法发送者：通知被接受、进操作中心、不显示横幅、不报错。因此发送前必须问这里。
 * @param aumid - 应用用户模型 ID。
 * @param env - 环境变量表，默认 `process.env`。
 * @returns 承载该 AUMID 的开始菜单快捷方式是否存在。
 */
export function isAumidRegistered(aumid, env = process.env) {
  const path = aumidShortcutPath(aumid, env)
  return path !== undefined && existsSync(path)
}

/**
 * 决定这次投递按什么顺序尝试哪些发送者，以及每个发送者命中时该报哪个退出码。
 *
 * 规则（**注册状态是唯一依据**）：
 *  - 显式传入的 `aumid` 只有在系统认识它（或有 `.lnk`，或它就是那个必然注册的后备）
 *    时才会被采用；
 *  - 自有 AUMID 未注册时**根本不尝试它**——试了也只会得到「进操作中心但无横幅」，
 *    再报一个 `0` 就是假信号；
 *  - 最后一项永远是 {@link FALLBACK_AUMID}，它是这张网的最后一道。
 *
 * 抽成纯函数是为了能离线单测：注入假 `isRegistered` 即可覆盖全部注册状态组合。
 *
 * @param aumid - 调用方显式指定的发送者（可选）。
 * @param options - `isRegistered` 谓词注入。
 * @returns `{ primaryRegistered, senders: [{ aumid, code }] }`。
 */
export function deliveryPlan(aumid, options = {}) {
  const isRegistered = typeof options.isRegistered === 'function' ? options.isRegistered : isAumidRegistered
  const explicit = typeof aumid === 'string' && aumid.trim().length > 0 ? aumid.trim() : undefined
  const primaryRegistered = isRegistered(PRIMARY_AUMID) === true

  const senders = []
  const push = (value, code) => {
    if (value === undefined || value === null || value.length === 0) return
    if (senders.some((entry) => entry.aumid === value)) return
    senders.push({ aumid: value, code })
  }

  if (explicit !== undefined && (explicit === FALLBACK_AUMID || isRegistered(explicit) === true)) {
    push(explicit, explicit === FALLBACK_AUMID ? 5 : 0)
  }
  if (primaryRegistered) push(PRIMARY_AUMID, 0)
  push(FALLBACK_AUMID, 5)

  return { primaryRegistered, senders }
}

/**
 * 生成投递脚本。
 *
 * 脚本**不写 stdout/stderr**：结果只由退出码承载。它按顺序尝试每个发送者，每条 toast
 * 带一次性 `Tag`，发送后回读操作中心历史并按 `Tag` 命中；全部落空才落到托盘气泡。
 *
 * XML 一律用 `CreateTextNode` / `SetAttribute` 构造，不做字符串拼接——标题里的 `'`
 * 或 `<b>` 因此只能是文本，不可能变成标记或语法。
 *
 * @param request - 标题、正文、声音、发送者序列、时长、按钮。
 * @returns PowerShell 脚本源码。
 */
export function buildToastScript({
  title = '',
  body = '',
  sound = true,
  senders = [{ aumid: PRIMARY_AUMID, code: 0 }],
  durationSeconds = 0,
  actions = [],
} = {}) {
  const seconds = clampDurationSeconds(durationSeconds)
  const normalisedActions = normaliseActions(actions)

  const senderLines = senders.map((sender) => {
    const code = Number.isInteger(sender.code) ? sender.code : 0
    return `    @{ aumid = (ConvertFrom-B64Text '${utf8Base64(sender.aumid)}'); code = ${code} }`
  })
  const actionLines = normalisedActions.map((action) => (
    `    @{ label = (ConvertFrom-B64Text '${utf8Base64(action.content)}'); `
    + `arguments = (ConvertFrom-B64Text '${utf8Base64(action.arguments)}'); `
    + `activationType = (ConvertFrom-B64Text '${utf8Base64(action.activationType)}') }`
  ))

  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '',
    'function ConvertFrom-B64Text {',
    '    param([string]$Value)',
    '    return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Value))',
    '}',
    '',
    'function New-ToastDocument {',
    '    param(',
    '        [string]$Title,',
    '        [string]$Body,',
    '        [bool]$WithSound,',
    '        [bool]$Urgent,',
    '        [object[]]$Actions',
    '    )',
    '    $document = New-Object Windows.Data.Xml.Dom.XmlDocument',
    "    $toast = $document.CreateElement('toast')",
    "    if ($Urgent) { $toast.SetAttribute('scenario', 'urgent') }",
    "    $toast.SetAttribute('duration', 'long')",
    "    $visual = $document.CreateElement('visual')",
    "    $binding = $document.CreateElement('binding')",
    "    $binding.SetAttribute('template', 'ToastGeneric')",
    "    $titleNode = $document.CreateElement('text')",
    '    [void]$titleNode.AppendChild($document.CreateTextNode($Title))',
    "    $bodyNode = $document.CreateElement('text')",
    '    [void]$bodyNode.AppendChild($document.CreateTextNode($Body))',
    '    [void]$binding.AppendChild($titleNode)',
    '    [void]$binding.AppendChild($bodyNode)',
    '    [void]$visual.AppendChild($binding)',
    '    [void]$toast.AppendChild($visual)',
    '    if ($Actions -ne $null -and $Actions.Count -gt 0) {',
    "        $actionsNode = $document.CreateElement('actions')",
    '        foreach ($spec in $Actions) {',
    "            $actionNode = $document.CreateElement('action')",
    "            $actionNode.SetAttribute('content', [string]$spec.label)",
    "            $actionNode.SetAttribute('arguments', [string]$spec.arguments)",
    "            $actionNode.SetAttribute('activationType', [string]$spec.activationType)",
    '            [void]$actionsNode.AppendChild($actionNode)',
    '        }',
    '        [void]$toast.AppendChild($actionsNode)',
    '    }',
    "    $audioNode = $document.CreateElement('audio')",
    "    if ($WithSound) { $audioNode.SetAttribute('src', 'ms-winsoundevent:Notification.Default') }",
    "    else { $audioNode.SetAttribute('silent', 'true') }",
    '    [void]$toast.AppendChild($audioNode)',
    '    [void]$document.AppendChild($toast)',
    '    return $document',
    '}',
    '',
    `$title = ConvertFrom-B64Text '${utf8Base64(title)}'`,
    `$body = ConvertFrom-B64Text '${utf8Base64(body)}'`,
    `$durationSeconds = ${seconds}`,
    `$urgent = $${seconds === 0 ? 'true' : 'false'}`,
    `$withSound = $${sound === false ? 'false' : 'true'}`,
    '$senders = @(',
    ...senderLines,
    ')',
    '$actions = @(',
    ...actionLines,
    ')',
    '',
    '$exitCode = 3',
    'try {',
    '    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
    '    [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
    '    $history = [Windows.UI.Notifications.ToastNotificationManager]::History',
    '    foreach ($sender in $senders) {',
    '        $aumid = [string]$sender.aumid',
    '        $code = [int]$sender.code',
    "        $tag = [Guid]::NewGuid().ToString('N').Substring(0, 16)",
    '        $document = New-ToastDocument -Title $title -Body $body -WithSound $withSound -Urgent $urgent -Actions $actions',
    '        $toast = New-Object Windows.UI.Notifications.ToastNotification $document',
    '        $toast.Tag = $tag',
    '        if ($durationSeconds -gt 0) { $toast.ExpirationTime = [DateTimeOffset]::Now.AddSeconds($durationSeconds) }',
    '        $accepted = $false',
    '        $shown = $false',
    '        try {',
    '            [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)',
    '            $shown = $true',
    '        } catch { $shown = $false }',
    '        if ($shown) {',
    `            for ($attempt = 0; $attempt -lt ${VERIFY_ATTEMPTS} -and -not $accepted; $attempt++) {`,
    `                Start-Sleep -Milliseconds ${VERIFY_INTERVAL_MS}`,
    '                try {',
    '                    foreach ($item in @($history.GetHistory($aumid))) {',
    "                        if ([string]$item.Tag -eq $tag) { $accepted = $true; break }",
    '                    }',
    '                } catch { }',
    '            }',
    '        }',
    '        if ($accepted) { $exitCode = $code; break }',
    '    }',
    '} catch { }',
    '',
    '# 全部 toast 路径都没被平台接受：退到托盘气泡。',
    'if ($exitCode -eq 3) {',
    '    try {',
    '        Add-Type -AssemblyName System.Windows.Forms',
    '        Add-Type -AssemblyName System.Drawing',
    '        $balloon = New-Object System.Windows.Forms.NotifyIcon',
    '        $balloon.Icon = [System.Drawing.SystemIcons]::Information',
    '        $balloon.Visible = $true',
    `        $balloon.ShowBalloonTip(${BALLOON_MS}, $title, $body, [System.Windows.Forms.ToolTipIcon]::Info)`,
    `        Start-Sleep -Seconds ${Math.ceil(BALLOON_MS / 1000)}`,
    '        $balloon.Visible = $false',
    '        $balloon.Dispose()',
    '        $exitCode = 6',
    '    } catch { }',
    '}',
    '',
    'exit $exitCode',
    '',
  ].join('\r\n')
}

/**
 * 生成铃声音脚本。
 *
 * 铃声必须是**独立于 toast 的一条路径**：抑制场景下卡片被扣下，铃声仍要响，所以它
 * 不能挂在 toast 脚本里（那条路径根本不会被执行）。
 * @param request - `source` 为 `'system'` 或 `'file'`，`filePath` 为音频文件。
 * @returns PowerShell 脚本源码。
 */
export function buildChimeScript({ source = 'system', filePath = '' } = {}) {
  const useFile = source === 'file' && typeof filePath === 'string' && filePath.trim().length > 0
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    'function ConvertFrom-B64Text {',
    '    param([string]$Value)',
    '    return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Value))',
    '}',
    `$filePath = ConvertFrom-B64Text '${utf8Base64(useFile ? filePath : '')}'`,
    'try {',
    '    if ($filePath.Length -gt 0) {',
    '        $player = New-Object System.Media.SoundPlayer -ArgumentList $filePath',
    '        $player.PlaySync()',
    '    } else {',
    '        [System.Media.SystemSounds]::Asterisk.Play()',
    '        Start-Sleep -Milliseconds 900',
    '    }',
    '    exit 0',
    '} catch {',
    '    exit 3',
    '}',
    '',
  ].join('\r\n')
}

/**
 * 可用的 PowerShell 解释器，最具体的排在最前。
 *
 * 首选**永远是 Windows PowerShell 5.1 的绝对路径**：PowerShell 7 里 WinRT 类型标记会
 * 抛 `Unable to find type`，投递必然失败。`DSH_SESSION_ALERT_POWERSHELL` 是给非常规
 * 安装与故障演练用的显式覆盖。
 * @param env - 环境变量表。
 * @returns 去重后的候选路径。
 */
export function powershellCandidates(env = process.env) {
  const candidates = []
  const override = env !== undefined && env !== null && typeof env.DSH_SESSION_ALERT_POWERSHELL === 'string'
    ? env.DSH_SESSION_ALERT_POWERSHELL.trim()
    : ''
  if (override.length > 0) candidates.push(override)

  const root = env !== undefined && env !== null ? (env.SystemRoot ?? env.windir) : undefined
  if (typeof root === 'string' && root.length > 0) {
    candidates.push(join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  }
  candidates.push('powershell.exe')

  const seen = new Set()
  return candidates.filter((candidate) => {
    const key = candidate.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 少写一点样板：把一次投递结果归一成永不 reject 的 outcome。 */
function failure(error, extra = {}) {
  return { ok: false, error, ...extra }
}

/**
 * 启动一次 PowerShell 并等它结束，把退出码归一成投递结果。**永不 reject。**
 *
 * `stdio: 'ignore'` + `windowsHide: true` 不是可选项：实测这对组合不分配控制台
 * （判据 `GetConsoleWindow()` 返回 NULL），而 `-WindowStyle Hidden` 只是把已经分配出来
 * 的控制台藏起来，用户仍会看到一闪。
 *
 * @param executable - 解释器路径。
 * @param script - 要执行的脚本文本（经 `-EncodedCommand` 传入）。
 * @returns `{ ok, code?, note?, error? }`。
 */
function runPowerShell(executable, script) {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const settle = (value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve(value)
    }

    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', utf16leBase64(script),
    ]

    let child
    try {
      child = spawn(executable, args, { windowsHide: true, stdio: 'ignore', detached: false })
    } catch (error) {
      settle(failure(error && error.message ? error.message : String(error)))
      return
    }

    timer = setTimeout(() => {
      try { child.kill() } catch { /* 已经结束了 */ }
      settle(failure(`子进程超过 ${SPAWN_TIMEOUT_MS}ms 未结束，已终止`))
    }, SPAWN_TIMEOUT_MS)
    if (timer !== null && typeof timer.unref === 'function') timer.unref()

    child.on('error', (error) => {
      settle(failure(error && error.message ? error.message : String(error)))
    })
    child.on('close', (code) => {
      const note = DELIVERY_CODES[code]
      if (note !== undefined) {
        settle({ ok: true, code, note })
        return
      }
      settle(failure(`没有任何一条通知路径成功（退出码 ${code}）`, { code }))
    })
  })
}

/** 解释器缺失才换下一个候选；脚本层面的失败换解释器也不会变好。 */
function isMissingInterpreter(outcome) {
  return /ENOENT|not found|找不到/i.test(String(outcome.error ?? ''))
}

/**
 * 发一条 Windows 桌面通知。
 *
 * 发送者由注册状态选择（见 {@link deliveryPlan}），投递结果由脚本回读操作中心历史
 * 验证。**永不 reject。**
 *
 * @param request - 标题、正文、是否带声音、可选显式发送者、显示时长、按钮。
 * @returns `{ ok, code?, note?, error? }`；`ok: true` 时 `note` 说明走通了哪条路径。
 */
export async function sendWindowsToast({ title = '', body = '', sound = true, aumid, durationSeconds = 0, actions = [] } = {}) {
  if (process.platform !== 'win32') {
    return failure(`当前平台 ${process.platform} 不支持 Windows 通知`)
  }

  const plan = deliveryPlan(aumid)
  const script = buildToastScript({
    title,
    body,
    sound,
    senders: plan.senders,
    durationSeconds,
    actions,
  })

  let last = failure('没有可用的 PowerShell 解释器')
  for (const executable of powershellCandidates()) {
    last = await runPowerShell(executable, script)
    if (last.ok) return last
    if (!isMissingInterpreter(last)) return last
  }
  return last
}

/**
 * 单独响一次铃声。**永不 reject。**
 *
 * 与 toast 完全解耦：抑制场景下卡片不弹，但铃声仍要响，所以它自己起一个短命进程。
 * `source: 'file'` 但没给文件路径时退回系统声音——用户既然开了铃声，就不该静音。
 *
 * @param request - `source` 与 `filePath`。
 * @returns `{ ok, error? }`。
 */
export async function playChime({ source = 'system', filePath = '' } = {}) {
  if (process.platform !== 'win32') {
    return failure(`当前平台 ${process.platform} 不支持 Windows 系统声音`)
  }
  const wantsFile = source === 'file' && typeof filePath === 'string' && filePath.trim().length > 0
  const script = buildChimeScript({ source: wantsFile ? 'file' : 'system', filePath })

  let last = failure('没有可用的 PowerShell 解释器')
  for (const executable of powershellCandidates()) {
    last = await runPowerShell(executable, script)
    if (last.ok) return last
    if (!isMissingInterpreter(last)) return last
  }
  return last
}

/**
 * 注册自有 AUMID，使其通知以本插件自己的名义弹出横幅而不是借用 Windows PowerShell 的
 * 身份。
 *
 * 幂等且尽力而为：已经注册、非 Windows、脚本缺失都直接返回，不起进程；调用方在
 * 返回 `false` 时改用 {@link FALLBACK_AUMID} 即可。
 * @param aumid - 要注册的 AUMID。
 * @returns 尝试结束后该 AUMID 是否已注册。
 */
export async function registerAumid(aumid = PRIMARY_AUMID) {
  if (process.platform !== 'win32') return false
  if (isAumidRegistered(aumid)) return true
  const script = join(PACKAGE_ROOT, 'scripts', 'register-aumid.ps1')
  if (!existsSync(script)) return false

  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-Aumid', aumid, '-Quiet',
  ]
  for (const executable of powershellCandidates()) {
    const outcome = await runPowerShellFile(executable, args)
    if (outcome.ok) break
    if (!isMissingInterpreter(outcome)) break
  }
  return isAumidRegistered(aumid)
}

/**
 * 用 `-File` 跑一个脚本文件并等它结束（脚本要收具名参数时不适合 `-EncodedCommand`）。
 *
 * 导出给 Host 半边的其它 PowerShell 助手复用（例如注册协议方案）。**复用它的理由不是
 * 省几行代码，而是那条启动约束只应有一份实现**：`stdio: 'ignore'` + `windowsHide: true`
 * 是 ADR 0004 判定的「不分配控制台」组合，抄一份就迟早会有一份走样，而走样的表现是
 * 用户看到闪窗。
 *
 * 参数是数组里的独立元素，不经过任何 shell，因此参数值不可能被解释成命令。
 * @param executable - 解释器路径。
 * @param args - 参数数组。
 * @returns `{ ok, code?, error? }`；退出码 0 才算成功。
 */
export function runPowerShellFile(executable, args) {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const settle = (value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve(value)
    }
    let child
    try {
      child = spawn(executable, args, { windowsHide: true, stdio: 'ignore', detached: false })
    } catch (error) {
      settle(failure(error && error.message ? error.message : String(error)))
      return
    }
    timer = setTimeout(() => {
      try { child.kill() } catch { /* 已经结束了 */ }
      settle(failure(`注册脚本超过 ${SPAWN_TIMEOUT_MS}ms 未结束，已终止`))
    }, SPAWN_TIMEOUT_MS)
    if (timer !== null && typeof timer.unref === 'function') timer.unref()
    child.on('error', (error) => settle(failure(error && error.message ? error.message : String(error))))
    child.on('close', (code) => settle(code === 0 ? { ok: true, code } : failure(`注册脚本退出码 ${code}`, { code })))
  })
}

/**
 * 格式化时钟时间，供 `{time}` 变量与活动列表使用。
 * @param timestamp - epoch 毫秒。
 * @returns 宿主本地时间的 `HH:MM:SS`。
 */
export function clockTime(timestamp) {
  const date = new Date(timestamp)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 起一个定时器并尽量 unref，免得合并定时器把 Host 的进程吊住。 */
function defaultSetTimer(callback, delay) {
  const handle = setTimeout(callback, delay)
  if (handle !== null && typeof handle.unref === 'function') handle.unref()
  return handle
}

/**
 * 事件与投递之间的全部分发决策，外加设置页要展示的计数与活动列表。
 *
 * 构造函数里的时钟、定时器、投递、铃声全部可注入——策略必须是能在没有 Windows 的
 * 机器上被单测的纯逻辑，否则「限流/合并/去重/开关」这些最容易出错的规则就只能靠
 * 真机碰运气。
 *
 * 抑制（decision 15）：`suppressCard: true` 时卡片被扣下，**铃声仍然响**。抑制只对
 * desktop 端有意义，因此是否抑制由调用方按端别与实测焦点决定。
 */
export class AlertDispatcher {
  /**
   * @param options - 配置读取器，以及可注入的时钟 / 定时器 / 投递 / 铃声 / 日志。
   */
  constructor(options = {}) {
    this.getConfig = typeof options.getConfig === 'function' ? options.getConfig : () => defaultConfig()
    this.platform = options.platform ?? process.platform
    this.send = typeof options.send === 'function' ? options.send : sendWindowsToast
    this.chime = typeof options.chime === 'function' ? options.chime : playChime
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.setTimer = typeof options.setTimer === 'function' ? options.setTimer : defaultSetTimer
    this.clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : (handle) => clearTimeout(handle)
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {}
    /**
     * 铃声策略：
     *  - `'auto'`（默认）：只在**这条通知不会自己发声**时补铃声——被抑制（没有卡片）
     *    或配置关掉了 toast 声音。这样任何情形下都恰好响一次，不会双重提示。
     *  - `'always'` / `'never'`：给设置页与诊断留的显式覆盖。
     */
    this.chimeWhen = options.chimeWhen ?? 'auto'
    this.dedupeMs = typeof options.dedupeMs === 'number' ? options.dedupeMs : DEDUPE_MS

    /** 限流窗口内的投递时刻。 */
    this.windowHits = []
    /** 每个场景最近一次投递时刻。 */
    this.lastByScenario = new Map()
    /** 去重键 → 首次出现时刻。 */
    this.dedupe = new Map()
    /** 等待窗口放行的合并批次。 */
    this.pending = null
    this.timer = null
    this.counters = { sent: 0, blocked: 0, coalesced: 0, duplicate: 0, failed: 0, suppressed: 0, chimes: 0 }
    this.recent = []
  }

  /** 释放合并定时器。 */
  dispose() {
    if (this.timer !== null) {
      try { this.clearTimer(this.timer) } catch { /* 定时器可能已经触发 */ }
      this.timer = null
    }
  }

  /** 记一条日志。日志失败绝不能影响分发。 */
  log(level, message) {
    try { this.onEvent(level, message) } catch { /* 忽略 */ }
  }

  /** 丢掉窗口外的投递时刻。 */
  pruneWindow(now, windowMs) {
    const cutoff = now - windowMs
    while (this.windowHits.length > 0 && this.windowHits[0] <= cutoff) this.windowHits.shift()
  }

  /** 顺手清掉过期的去重项，避免长会话里这张表无限增长。 */
  pruneDedupe(now) {
    if (this.dedupe.size <= DEDUPE_SWEEP_THRESHOLD) return
    for (const [key, at] of this.dedupe) {
      if (now - at >= this.dedupeMs) this.dedupe.delete(key)
    }
  }

  /** 窗口最早允许下一条通知的时刻。 */
  nextSlotAt(now) {
    const config = this.getConfig()
    const rateLimit = config !== null && typeof config === 'object' ? config.rateLimit : undefined
    if (rateLimit === undefined || rateLimit.enabled !== true) return now
    const windowMs = rateLimit.windowSeconds * 1000
    this.pruneWindow(now, windowMs)
    if (this.windowHits.length < rateLimit.max) return now
    return this.windowHits[this.windowHits.length - rateLimit.max] + windowMs + WINDOW_MARGIN_MS
  }

  /** 记一条活动，最新的在前。 */
  pushRecent(entry) {
    this.recent.unshift(entry)
    if (this.recent.length > RECENT_LIMIT) this.recent.length = RECENT_LIMIT
  }

  /**
   * 该不该为这条通知补一次独立铃声。
   * @param config - 当前配置。
   * @param viaToast - 这次是否真的发了卡片。
   * @returns 是否需要单独响铃。
   */
  shouldChime(config, viaToast) {
    if (this.chimeWhen === 'never') return false
    const chime = config !== null && typeof config === 'object' ? config.chime : undefined
    if (chime === undefined || chime.enabled !== true) return false
    if (this.chimeWhen === 'always') return true
    // auto：卡片自己会发声时不再补一次，避免双重提示。
    return viaToast !== true || config.sound !== true
  }

  /**
   * 起一条独立的铃声路径。
   * @param config - 当前配置。
   * @param timestamp - 触发时刻。
   * @param reason - `'toast'` 表示这次有卡片，`'suppressed'` 表示卡片被扣下。
   * @returns 是否真的起了铃声。
   */
  ring(config, timestamp, reason) {
    if (!this.shouldChime(config, reason === 'toast')) return false
    this.counters.chimes += 1
    const chime = config.chime ?? {}
    Promise.resolve()
      .then(() => this.chime({ source: chime.source, filePath: chime.filePath }))
      .then((outcome) => {
        if (outcome !== undefined && outcome.ok === false) {
          this.log('warn', `铃声播放失败：${outcome.error ?? '未知原因'}`)
        }
      })
      .catch((error) => this.log('warn', `铃声播放失败：${error && error.message ? error.message : String(error)}`))
    return true
  }

  /**
   * 焦点抑制路径：**扣下卡片，但保留听觉通道**。
   *
   * 抑制不等于免于限流——否则用户盯着界面工作时，一串事件就会变成一串铃声，正是这条
   * 功能要消灭的噪音。因此场景间隔与滑动窗口在这里照常生效，被挡下时如实回报
   * `sent: false`，并且**不合并**：合并出来的卡片会在几秒后弹出来，那等于绕过了抑制。
   *
   * 判决仍是 `sent: false`（没有卡片发出），但活动条目里带 `via: 'chime-only'`，
   * 让它与「彻底没发」在设置页上区分得开。
   */
  suppress(scenario, config, body, now) {
    const scenarioConfig = config.scenarios[scenario]
    const minIntervalMs = typeof scenarioConfig.minIntervalSeconds === 'number'
      ? scenarioConfig.minIntervalSeconds * 1000
      : 0
    const lastAt = this.lastByScenario.get(scenario)

    this.counters.suppressed += 1
    if (minIntervalMs > 0 && lastAt !== undefined && now - lastAt < minIntervalMs) {
      this.counters.blocked += 1
      return { sent: false, reason: 'scenario-interval' }
    }
    if (config.rateLimit !== undefined && config.rateLimit.enabled === true) {
      this.pruneWindow(now, config.rateLimit.windowSeconds * 1000)
      if (this.windowHits.length >= config.rateLimit.max) {
        this.counters.blocked += 1
        return { sent: false, reason: 'rate-limit' }
      }
    }

    const rang = this.ring(config, now, 'suppressed')
    const entry = {
      at: now,
      time: clockTime(now),
      scenario,
      title: config.title,
      body,
      reason: 'focused-suppressed',
      ok: true,
      error: null,
      // 让设置页一眼看出「响过铃但没弹卡片」与「彻底静音」的区别。
      via: rang ? 'chime-only' : 'suppressed-silent',
    }
    // 铃声同样占用限流窗口：抑制的是卡片，不是「无限次打扰」的许可。
    this.windowHits.push(now)
    this.lastByScenario.set(scenario, now)
    this.pushRecent(entry)
    return { sent: false, reason: 'focused-suppressed', suppressed: true, chime: rang, via: entry.via }
  }

  /** 把一条消息交给投递链，并把结果折进活动条目。 */
  deliver(config, scenario, body, now, reason, durationSeconds, actions) {
    const entry = {
      at: now,
      time: clockTime(now),
      scenario,
      title: config.title,
      body,
      reason,
      ok: true,
      error: null,
      actions: normaliseActions(actions).length,
    }
    this.windowHits.push(now)
    this.lastByScenario.set(scenario, now)
    this.counters.sent += 1
    this.pushRecent(entry)
    this.ring(config, now, 'toast')

    Promise.resolve()
      .then(() => this.send({
        title: config.title,
        body,
        sound: config.sound,
        durationSeconds: clampDurationSeconds(durationSeconds),
        actions: normaliseActions(actions),
      }))
      .then((outcome) => {
        if (outcome === undefined || outcome === null || outcome.ok === false) {
          entry.ok = false
          entry.error = (outcome !== null && outcome !== undefined && outcome.error !== undefined)
            ? outcome.error
            : '未知失败'
          this.counters.failed += 1
          this.log('warn', `通知投递失败：${entry.error}`)
          return
        }
        // 成功也要记下走通的是哪条路径：这是诊断「横幅到底有没有出来」的唯一信号。
        if (outcome.note !== undefined) entry.via = outcome.note
        if (outcome.code !== undefined) entry.code = outcome.code
      })
      .catch((error) => {
        entry.ok = false
        entry.error = error && error.message ? error.message : String(error)
        this.counters.failed += 1
        this.log('warn', `通知投递失败：${entry.error}`)
      })

    return { sent: true, entry }
  }

  /** 被拦下的提醒：要么并入稍后的一条，要么（配置不允许合并时）丢弃。 */
  block(scenario, config, body, now, reason, durationSeconds, actions) {
    this.counters.blocked += 1
    if (config.rateLimit === undefined || config.rateLimit.coalesce !== true) {
      return { sent: false, reason }
    }
    if (this.pending === null) {
      this.pending = { count: 0, body, scenario, durationSeconds, actions: [], reasons: new Set() }
    }
    this.pending.count += 1
    this.pending.body = body
    this.pending.scenario = scenario
    this.pending.durationSeconds = durationSeconds
    // 合并后的那条通知也要点得动，因此按钮跟着走。多个事件并成一条时按钮只能绑定
    // 最后一个事件——ADR 0003 记着这个待定项（「多条审批合并到一张卡片时按钮该绑定
    // 哪一个请求」），这里取最后一条，与正文取最后一条保持一致。
    if (normaliseActions(actions).length > 0) this.pending.actions = normaliseActions(actions)
    this.pending.reasons.add(reason)
    this.scheduleFlush(now)
    return { sent: false, reason, coalescing: true }
  }

  /** 装上一次性的合并定时器。 */
  scheduleFlush(now) {
    if (this.timer !== null) return
    const delay = Math.max(COALESCE_MIN_DELAY_MS, this.nextSlotAt(now) - now)
    this.timer = this.setTimer(() => {
      this.timer = null
      this.flush()
    }, delay)
    if (this.timer !== null && typeof this.timer === 'object' && typeof this.timer.unref === 'function') {
      this.timer.unref()
    }
  }

  /** 窗口一放行就把合并批次发出去（**不静默丢弃**）。 */
  flush() {
    const pending = this.pending
    if (pending === null) return
    const config = this.getConfig()
    const now = this.now()
    if (config.enabled !== true) {
      this.pending = null
      return
    }
    if (config.rateLimit !== undefined && config.rateLimit.enabled === true) {
      this.pruneWindow(now, config.rateLimit.windowSeconds * 1000)
      if (this.windowHits.length >= config.rateLimit.max) {
        this.scheduleFlush(now)
        return
      }
    }
    this.pending = null
    const body = pending.count > 1
      ? `${pending.body}（另有 ${pending.count - 1} 条提醒在限流窗口内被合并）`
      : pending.body
    if (pending.count > 1) this.counters.coalesced += 1
    this.deliver(config, pending.scenario, body, now, 'coalesced', pending.durationSeconds, pending.actions)
  }

  /**
   * 判决并投递一条提醒。
   *
   * @param request - 场景 id、**已渲染好的**正文、结构化去重键、抑制开关与按钮。
   * `body` 的模板渲染由调用方（config）负责，这里只做策略与投递。
   * `dedupeKey` 必须是结构化键而不是渲染后的文本——两次渲染的时间戳不同，用文本做键
   * 会让「同一个真实事件被两个信号重复报告」的回声去重失效。
   * `suppressed: true`（别名 `suppressCard: true`）时卡片被扣下、铃声照响，
   * 见 {@link AlertDispatcher#suppress}。`focused: true` 是另一种说法：只有调用方
   * 明确知道端别是 desktop、且两个抑制字段都没给时才由本类按 `suppressWhenFocused`
   * 自行推导，供尚未接线的调用方使用。
   * `actions` 原样透传到通知上（`[{ content, arguments, activationType }]`）；协议方案
   * 与 URL 形状由 Host 决定，这里不解释它们。
   * @returns `{ sent, reason, coalescing? }`。
   */
  dispatch({ scenario, body, dedupeKey, focused, suppressed, suppressCard, actions } = {}) {
    const config = this.getConfig()
    if (config === null || typeof config !== 'object' || config.enabled !== true) {
      return { sent: false, reason: 'plugin-disabled' }
    }
    const scenarioConfig = config.scenarios !== undefined && config.scenarios !== null
      ? config.scenarios[scenario]
      : undefined
    if (scenarioConfig === undefined || scenarioConfig === null || scenarioConfig.enabled !== true) {
      return { sent: false, reason: 'scenario-disabled' }
    }

    const text = typeof body === 'string' ? body.trim() : ''
    if (text.length === 0) return { sent: false, reason: 'empty-message' }

    const now = this.now()
    const durationSeconds = clampDurationSeconds(scenarioConfig.durationSeconds)
    const buttons = normaliseActions(actions)

    const key = `${scenario}\u0000${dedupeKey === undefined || dedupeKey === null || dedupeKey === '' ? text : dedupeKey}`
    const seenAt = this.dedupe.get(key)
    if (seenAt !== undefined && now - seenAt < this.dedupeMs) {
      this.counters.duplicate += 1
      return { sent: false, reason: 'duplicate' }
    }
    // 先占用再判限流：同一个真实事件的第二个信号必须读成回声，即使第一个被限流了，
    // 否则它会虚增合并条数。
    this.dedupe.set(key, now)
    this.pruneDedupe(now)

    const holdCard = suppressed === true || suppressCard === true
      || (suppressed === undefined && suppressCard === undefined
        && focused === true && config.suppressWhenFocused === true)
    if (holdCard) return this.suppress(scenario, config, text, now)

    const minIntervalMs = typeof scenarioConfig.minIntervalSeconds === 'number'
      ? scenarioConfig.minIntervalSeconds * 1000
      : 0
    const lastAt = this.lastByScenario.get(scenario)
    if (minIntervalMs > 0 && lastAt !== undefined && now - lastAt < minIntervalMs) {
      return this.block(scenario, config, text, now, 'scenario-interval', durationSeconds, buttons)
    }

    if (config.rateLimit !== undefined && config.rateLimit.enabled === true) {
      this.pruneWindow(now, config.rateLimit.windowSeconds * 1000)
      if (this.windowHits.length >= config.rateLimit.max) {
        return this.block(scenario, config, text, now, 'rate-limit', durationSeconds, buttons)
      }
    }

    return this.deliver(config, scenario, text, now, 'sent', durationSeconds, buttons)
  }

  /**
   * 发一条**绕过全部限流与模板**的测试通知——设置页的「测试」按钮。
   *
   * 这是证明投递链可用的唯一手段，所以必须真的投递，并且把结果如实回报。
   * @param durationSeconds - 要演练的显示时长；缺省用 turnEnd 场景的配置。
   * @returns `sendWindowsToast` 的 outcome。
   */
  async test(durationSeconds) {
    const config = this.getConfig()
    const fallbackSeconds = config.scenarios !== undefined
      && config.scenarios.turnEnd !== undefined
      && typeof config.scenarios.turnEnd.durationSeconds === 'number'
      ? config.scenarios.turnEnd.durationSeconds
      : DEFAULT_DURATION_SECONDS
    const seconds = clampDurationSeconds(typeof durationSeconds === 'number' ? durationSeconds : fallbackSeconds)
    const persistent = seconds === 0
    const now = this.now()
    const body = [
      '这是一条测试通知。',
      `时间：${clockTime(now)}`,
      `平台：${this.platform}`,
      `显示：${persistent ? '常驻，直到你手动关闭' : `${seconds} 秒`}`,
    ].join('\n')

    const entry = {
      at: now,
      time: clockTime(now),
      scenario: 'test',
      title: config.title,
      body,
      reason: 'test',
      ok: true,
      error: null,
    }
    this.pushRecent(entry)

    let outcome
    try {
      outcome = await this.send({
        title: config.title,
        body,
        sound: config.sound,
        durationSeconds: seconds,
      })
    } catch (error) {
      outcome = failure(error && error.message ? error.message : String(error))
    }

    if (outcome === undefined || outcome === null || outcome.ok === false) {
      entry.ok = false
      entry.error = (outcome !== null && outcome !== undefined && outcome.error !== undefined)
        ? outcome.error
        : '未知失败'
      this.counters.failed += 1
    } else {
      if (outcome.note !== undefined) entry.via = outcome.note
      if (outcome.code !== undefined) entry.code = outcome.code
    }
    return outcome
  }

  /** 清空活动列表与计数（限流窗口不动）。 */
  clearActivity() {
    this.recent = []
    this.counters = { sent: 0, blocked: 0, coalesced: 0, duplicate: 0, failed: 0, suppressed: 0, chimes: 0 }
  }

  /** 设置页轮询的 JSON 视图。 */
  snapshot() {
    const config = this.getConfig()
    const rateLimit = config !== null && typeof config === 'object' && config.rateLimit !== undefined
      ? config.rateLimit
      : { enabled: false, max: 0, windowSeconds: 0 }
    const now = this.now()
    const windowMs = rateLimit.windowSeconds * 1000
    this.pruneWindow(now, windowMs)
    return {
      counters: { ...this.counters },
      lastResult: this.recent.length > 0 ? { ...this.recent[0] } : null,
      recent: this.recent.map((entry) => ({ ...entry })),
      windowUsed: this.windowHits.length,
      windowMax: rateLimit.max,
      windowSeconds: rateLimit.windowSeconds,
      pendingCoalesced: this.pending === null ? 0 : this.pending.count,
    }
  }
}
