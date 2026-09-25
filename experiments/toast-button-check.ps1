# 从通知上点按钮 —— 端到端验证脚本
#
# ## 为什么需要人工点一下
#
# 我已经用程序验证了：**由协议激活启动的进程持有前台权**，能把 DSH 窗口还原并置顶，
# 且不分配控制台、不改变窗口尺寸（见 experiments/popup-two-flows.ps1）。
#
# 但「**点击 toast 上的按钮**是否走同一条 ShellExecute 路径」无法用程序验证——脚本点不了
# 通知上的按钮。这是整条跳转链上唯一悬空的一环，只能由人点一次确认。
#
# ## 这个脚本做什么
#
#   1. 注册一个自有协议方案（HKCU，无需管理员），其处理程序是我们的置顶脚本；
#   2. 弹出一条**带按钮**的 toast，按钮的 activationType 为 protocol、
#      arguments 指向该方案，并把一个会话 id 放进 URL 参数里；
#   3. 等待你点击。脚本随后读回置顶脚本的日志，报告三件事：
#        - 按钮点击是否真的激活了协议（日志是否产生）
#        - URL 参数里的会话 id 是否被正确送达（这决定「切到指定会话」增强项可不可行）
#        - 窗口是否被还原/置顶
#
# ## 用法
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File toast-button-check.ps1
#
# 运行后**点通知上的「打开会话」按钮**，然后回到终端看结果。
#
# 注意：本文件必须保持 CRLF 换行 + UTF-8 BOM（见 .gitattributes）。

param(
  [string]$Scheme = 'dsh-session-alert',
  [string]$SessionId = 'demo-session-abc123',
  [int]$WaitSeconds = 45
)

$ErrorActionPreference = 'Stop'
$here  = $PSScriptRoot
$probe = Join-Path $here 'focus-probe.ps1'
$PS5   = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$probeLog = Join-Path $env:TEMP 'toast-button-probe.log'

# ---------- 1. 注册自有协议方案 ----------
# 关键：命令行必须用 conhost.exe --headless，否则每次点击都会闪一个命令行窗口。
# -WindowStyle Hidden 与 wscript 经实测都不合格（仍会分配控制台），见 ADR 0004。
$regPath = "HKCU:\Software\Classes\$Scheme"
New-Item -Path $regPath -Force | Out-Null
New-ItemProperty -Path $regPath -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $regPath -Name '(default)' -Value 'DSH Session Alert' -PropertyType String -Force | Out-Null
New-Item -Path "$regPath\shell\open\command" -Force | Out-Null
$handler = 'conhost.exe --headless "{0}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{1}" -Url "%1" -LogPath "{2}"' -f $PS5, $probe, $probeLog
Set-ItemProperty -Path "$regPath\shell\open\command" -Name '(default)' -Value $handler

Write-Host "已注册协议方案 '$Scheme':" -ForegroundColor Cyan
Write-Host "  $handler"
Write-Host ''

# ---------- 2. 弹出带按钮的 toast ----------
if (Test-Path $probeLog) { Remove-Item $probeLog -Force }

$aumid = 'DSH Session Alert'
$args = "$Scheme" + '://open?session=' + $SessionId

# 用 -EncodedCommand 传（UTF-16LE base64），这是唯一能无损穿过中文的参数通道。
# 脚本内用 CreateTextNode 构造 XML，绝不字符串拼接，避免注入。
$script = @"
`$ErrorActionPreference = 'Stop'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

`$title = 'DSH Session Alert'
`$body  = '点击下方按钮，验证通知按钮能否拉起 DSH 窗口'
`$args  = '$args'
`$aumid = '$aumid'

`$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
`$doc.LoadXml('<toast duration="long"><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual><actions><action content="打开会话" activationType="protocol" arguments=""/></actions></toast>')

`$texts = `$doc.GetElementsByTagName('text')
`$null = `$texts.Item(0).AppendChild(`$doc.CreateTextNode(`$title))
`$null = `$texts.Item(1).AppendChild(`$doc.CreateTextNode(`$body))
`$action = `$doc.GetElementsByTagName('action').Item(0)
`$action.SetAttribute('arguments', `$args)

`$toast = New-Object Windows.UI.Notifications.ToastNotification `$doc
`$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(`$aumid)
`$notifier.Show(`$toast)
exit 0
"@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))

Write-Host '正在弹出带按钮的通知...' -ForegroundColor Cyan
& $PS5 -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded
if ($LASTEXITCODE -ne 0) { Write-Host "弹出失败，退出码 $LASTEXITCODE" -ForegroundColor Red; exit 1 }
Write-Host '已弹出。' -ForegroundColor Green
Write-Host ''
Write-Host ">>> 请点击通知上的「打开会话」按钮（最多等 $WaitSeconds 秒） <<<" -ForegroundColor Yellow
Write-Host ''

# ---------- 3. 等待并读回结果 ----------
$deadline = (Get-Date).AddSeconds($WaitSeconds)
$fired = $false
while ((Get-Date) -lt $deadline) {
  if (Test-Path $probeLog) { $fired = $true; break }
  Start-Sleep -Milliseconds 500
}

Write-Host '=================================================================='
Write-Host '结果'
Write-Host '=================================================================='

if (-not $fired) {
  Write-Host '未检测到按钮点击（置顶脚本没有被激活）。' -ForegroundColor Red
  Write-Host '可能原因：没有点击 / 通知被专注助手拦下 / 协议未生效。'
  Remove-Item $regPath -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}

Write-Host '✅ 按钮点击确实激活了协议——置顶脚本被拉起。' -ForegroundColor Green
Start-Sleep -Milliseconds 1200
Write-Host ''
Write-Host '--- 置顶脚本日志 ---'
Get-Content $probeLog | Out-String | Write-Host

Write-Host '--- 判定 ---'
$log = Get-Content $probeLog -Raw
$urlLine = ($log -split "`n" | Where-Object { $_ -match 'invoked; Url=' } | Select-Object -First 1)
if ($urlLine -match [regex]::Escape($SessionId)) {
  Write-Host "✅ 会话 id 被正确送达（URL 里含 '$SessionId'）——「切到指定会话」增强项可行。" -ForegroundColor Green
} else {
  Write-Host '⚠ 日志里没看到会话 id。' -ForegroundColor Yellow
  Write-Host "  实际收到: $urlLine"
  Write-Host '  说明按钮参数可能被截断或未传递，增强项需另行设计。'
}
if ($log -match 'RESULT: form .* sizeUnchanged=True') {
  Write-Host '✅ 窗口尺寸未变、形态已恢复。' -ForegroundColor Green
} else {
  Write-Host '⚠ 尺寸或形态检查未通过，见上面日志。' -ForegroundColor Yellow
}

Remove-Item $regPath -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host "(协议方案 '$Scheme' 已清理)"
