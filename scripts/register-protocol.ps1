# 注册自有协议方案，使通知按钮点击后能拉起启动器。
#
# ## 为什么必须注册
#
# 通知按钮用 `activationType="protocol"` 激活一个 URL。而自定义 URL 方案只有在
# **注册表里登记过**，Windows 才知道该由什么来处理它。没有登记，点击按钮不会报错，
# 但也**什么都不会发生**——这是最难排查的一类失败：链路两端都正常，中间少了一环。
#
# ## 为什么不用 DSH 自带的 dsh:
#
# 实测 `dsh:` 只做两个字符串的字面比较（`dsh://open` / `dsh://open/`），完全不解析参数，
# 而且在 Windows 上那个处理器根本不触发（`open-url` 在 Electron 里仅限 macOS）。
# 因此它既无法携带会话 id，也无法指向我们自己的启动器。
#
# ## 不需要管理员权限
#
# 全部写入 `HKCU\Software\Classes`，只对当前用户生效。
#
# 注意：本文件必须保持 CRLF 换行 + UTF-8 BOM（见 .gitattributes）。
# 无 BOM 时 Windows PowerShell 5.1 会按 ANSI（中文系统即 GBK）解码本文件，
# 中文注释变乱码后会破坏引号配对，报出与真实原因无关的语法错误。

param(
  # 协议方案名。必须与 lib/contract.js 的 PROTOCOL_SCHEME 一致，由调用方传入。
  [Parameter(Mandatory = $true)]
  [string]$Scheme,

  # 启动器可执行文件的绝对路径。
  [Parameter(Mandatory = $true)]
  [string]$LauncherPath,

  # 通知横幅上的显示名。
  [string]$DisplayName = 'DSH Session Alert',

  # 置顶保持时长（秒），透传给启动器。
  [int]$HoldSeconds = 8,

  # 只检查不写入。
  [switch]$Check,

  # 静默：不输出，只由退出码承载结果。
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

function Say([string]$Message) {
  if (-not $Quiet) { Write-Host $Message }
}

# 方案名会被写进注册表并出现在 URL 里，必须严格合法。
if ($Scheme -notmatch '^[a-z][a-z0-9+.-]*$') {
  Say "方案名不合法：'$Scheme'（要求小写字母开头，仅含 a-z 0-9 + . -）"
  exit 2
}

$keyPath = "HKCU:\Software\Classes\$Scheme"
$commandKey = Join-Path $keyPath 'shell\open\command'

# ---------- 检查模式 ----------
if ($Check) {
  if (-not (Test-Path -LiteralPath $commandKey)) { Say "未注册"; exit 1 }
  $current = (Get-ItemProperty -LiteralPath $commandKey -ErrorAction SilentlyContinue).'(default)'
  Say "已注册：$current"
  exit 0
}

# ---------- 校验启动器 ----------
if (-not (Test-Path -LiteralPath $LauncherPath)) {
  Say "找不到启动器：$LauncherPath"
  exit 3
}
if ([IO.Path]::GetExtension($LauncherPath) -ne '.exe') {
  Say "启动器应当是 .exe：$LauncherPath"
  exit 3
}
$LauncherPath = (Resolve-Path -LiteralPath $LauncherPath).Path

# 命令行里必须给 %1 留位置：协议激活时 Windows 会把完整 URL 作为第 1 个位置参数
# 传进来（实测形如 `dsh-session-alert://open/?session=xxx`，系统会规范化，
# 例如补上结尾斜杠）。启动器从查询串里解析会话 id。
$command = '"{0}" "%1" --hold {1}' -f $LauncherPath, $HoldSeconds

# ---------- 写入 ----------
# 幂等：已注册且完全一致时不做任何改动，避免每次启动都写注册表。
if (Test-Path -LiteralPath $commandKey) {
  $current = (Get-ItemProperty -LiteralPath $commandKey -ErrorAction SilentlyContinue).'(default)'
  $currentName = (Get-ItemProperty -LiteralPath $keyPath -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
  if ($current -eq $command -and $currentName -eq $DisplayName) {
    Say "已注册且一致，无需改动"
    exit 0
  }
}

New-Item -Path $keyPath -Force | Out-Null
# "URL Protocol" 这个值的存在本身即宣告「本方案是一个可激活的协议」。
# 它的内容会被忽略，但缺失时 Windows 不会把该方案当作协议处理。
New-ItemProperty -Path $keyPath -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $keyPath -Name '(default)' -Value $DisplayName -PropertyType String -Force | Out-Null
New-Item -Path $commandKey -Force | Out-Null
Set-ItemProperty -Path $commandKey -Name '(default)' -Value $command

# 回读校验：写入成功不等于写对了，必须读回来确认。
$verify = (Get-ItemProperty -LiteralPath $commandKey -ErrorAction SilentlyContinue).'(default)'
if ($verify -ne $command) {
  Say "写入后回读不一致：期望 '$command'，实际 '$verify'"
  exit 4
}

# 通知中心里的应用名与图标（可选，失败不影响激活）。
try {
  New-ItemProperty -Path $keyPath -Name 'FriendlyTypeName' -Value $DisplayName -PropertyType String -Force | Out-Null
} catch {
  # 忽略：这只影响显示名。
}

Say "已注册协议 '$Scheme' -> $command"
exit 0
