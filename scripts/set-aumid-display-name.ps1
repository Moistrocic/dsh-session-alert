# 把 AUMID 的显示名写成通知标题。
#
# ## 为什么需要它
#
# 通知最上面那一行（应用名）由 Windows 根据 AUMID 的显示名渲染，而**不是**由 toast XML
# 决定——XML 里的 `<text id="1">` 只是正文上方的标题行。因此「让通知最上面那行显示我设的
# 通知标题」这件事只能在注册层面做。
#
# 实测（2026-09-25）：只改这一个注册表值、**不动开始菜单快捷方式**，下一条通知的应用名
# 就变了。这也是本脚本刻意不去重命名 `.lnk` 的原因——快捷方式的名字同时是
# `isAumidRegistered()` 的判据（`<AUMID>.lnk` 是否存在），改名会让插件误判「未注册」
# 而退回后备 AUMID，横幅的来源反而变错。
#
# 幂等：值已经相同就直接退出 0，不做写入。这样调用方可以放心地在每次配置保存后调用它。
#
# 退出码：0 = 已就绪（写入成功或本来就相同）；3 = 写入后回读不一致；4 = 参数非法。

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Aumid,
  [Parameter(Mandatory = $true)][string]$DisplayName,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Say([string]$Text) {
  if (-not $Quiet) { Write-Host $Text }
}

if ([string]::IsNullOrWhiteSpace($Aumid)) { [Console]::Error.WriteLine('Aumid 不能为空'); exit 4 }
# 显示名的首尾空白会被 Windows 原样显示，看着像 bug，因此这里就去掉。
$clean = $DisplayName.Trim()
# **不要用 `Write-Error` 报参数错**：`$ErrorActionPreference = 'Stop'` 会把它变成终止错误，
# 脚本在那之前就退出，调用方拿到的是 1 而不是这里约定的 4——诊断指错方向比不报错更费时间。
if ([string]::IsNullOrWhiteSpace($clean)) { [Console]::Error.WriteLine('DisplayName 不能为空'); exit 4 }
if ($clean.Length -gt 128) { $clean = $clean.Substring(0, 128) }

$keyPath = "HKCU:\Software\Classes\AppUserModelId\$Aumid"

$current = $null
if (Test-Path $keyPath) {
  try { $current = (Get-ItemProperty -Path $keyPath -Name 'DisplayName' -ErrorAction Stop).DisplayName } catch { $current = $null }
}

if ($current -ceq $clean) {
  Say "AUMID 显示名已是「$clean」，无需改动。"
  exit 0
}

if (-not (Test-Path $keyPath)) { New-Item -Path $keyPath -Force | Out-Null }
# `New-ItemProperty -Force` 在值已存在时覆盖。**不要用 `Set-ItemProperty -PropertyType`**：
# 它没有这个参数，会直接抛 ParameterBindingException——看起来像脚本坏了，其实只是用错了 cmdlet。
New-ItemProperty -Path $keyPath -Name 'DisplayName' -Value $clean -PropertyType String -Force | Out-Null

# 回读校验：写注册表不报错并不等于写对了（键名写错、权限被重定向都可能静默成功）。
$after = $null
try { $after = (Get-ItemProperty -Path $keyPath -Name 'DisplayName' -ErrorAction Stop).DisplayName } catch { $after = $null }
if ($after -cne $clean) {
  [Console]::Error.WriteLine("回读不一致：期望「$clean」，实际「$after」")
  exit 3
}

Say "AUMID 显示名：$current → $clean"
exit 0
