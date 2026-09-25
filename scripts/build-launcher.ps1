# 编译 dsh-session-alert 的无控制台启动器
#
# 输入：lib\launcher\dsh-session-alert-launcher.cs（+ 由 lib\contract.js 生成的契约常量）
# 输出：bin\dsh-session-alert.exe，PE Subsystem 必须为 2（Windows GUI）
#
# ## 为什么用 /target:winexe
#
# 子系统为 Windows 的进程**根本不分配控制台**，因此协议激活时不会闪命令行。
# `-WindowStyle Hidden` 与 wscript 都只是隐藏已分配的控制台，实测仍会闪。
# 判据是进程内 `GetConsoleWindow()` 返回 NULL——本脚本在编译后会用
# `--selfcheck` 真跑一次该 exe 并核对它的日志。
# 见 docs\adr\0004-no-console-allocation.md、docs\adr\0005-windowless-launcher-and-foreground-lock.md。
#
# ## 为什么生成一个 .cs
#
# 协议方案名必须与 lib\contract.js 的 PROTOCOL_SCHEME 单一来源一致（它同时被注册表
# 注册与通知按钮的 arguments 引用）。因此方案名不写在启动器源码里，而是由本脚本从
# lib\contract.js 读出后生成 LauncherContract.g.cs，与主源码一起编译。源码里那份
# 兜底值只在直接编译 .cs 时生效，本脚本会核对它与 contract.js 一致。
#
# ## 编码硬要求
#
# 本脚本与生成的 .cs 都必须是 **UTF-8 BOM + CRLF**：Windows PowerShell 5.1 读无 BOM
# 的 .ps1 会按 ANSI（中文系统上是 GBK）解码，中文乱码后会破坏引号配对；LF 换行会让
# param(...) 解析失败。csc 也需要 BOM 才能正确识别源码里的中文注释。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-launcher.ps1
#   npm run build:launcher
#   pwsh -File scripts\build-launcher.ps1 -OutDir D:\tmp -KeepStaging
#
# 退出码：0 成功；1 失败。

[CmdletBinding()]
param(
  # 输出目录，默认 <仓库根>\bin
  [string]$OutDir = '',
  # 保留暂存目录（生成的 .g.cs 留在那里），便于排查编译问题
  [switch]$KeepStaging
)

$ErrorActionPreference = 'Stop'

# csc 用 /utf8output 输出，这里把控制台解码也切成 UTF-8，否则中文错误信息会乱码。
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false) } catch { }

function Write-Step([string]$Message) {
  Write-Host $Message
}

function Fail([string]$Message) {
  Write-Host ''
  Write-Host "BUILD FAILED: $Message" -ForegroundColor Red
  exit 1
}

# 读文件的编码与换行形态：BOM 决定 csc / PowerShell 5.1 的解码，换行决定脚本能否被解析。
function Get-TextShape([string]$Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $text = [IO.File]::ReadAllText($Path)
  $crlf = ([regex]::Matches($text, "`r`n")).Count
  $loneLf = ([regex]::Matches($text, "(?<!`r)`n")).Count
  return [pscustomobject]@{ HasBom = $hasBom; Crlf = $crlf; LoneLf = $loneLf }
}

# 读 PE 头里的 Subsystem 字段：2 = IMAGE_SUBSYSTEM_WINDOWS_GUI。
# 这是「无控制台」的静态判据，比肉眼看有没有闪窗可靠。
function Get-PeInfo([string]$Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 0x100) { throw "文件太小，不是有效的 PE：$Path" }
  if ($bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) { throw "缺少 MZ 头：$Path" }

  $peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
  if ($peOffset -le 0 -or ($peOffset + 0x60) -ge $bytes.Length) { throw 'e_lfanew 越界' }
  if ($bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset + 1] -ne 0x45 -or
      $bytes[$peOffset + 2] -ne 0 -or $bytes[$peOffset + 3] -ne 0) {
    throw '缺少 PE\0\0 签名'
  }

  $machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
  $optional = $peOffset + 4 + 20
  $magic = [BitConverter]::ToUInt16($bytes, $optional)
  if ($magic -ne 0x10B -and $magic -ne 0x20B) {
    throw ("未知的 optional header magic: 0x{0:X}" -f $magic)
  }
  # Subsystem 在 optional header 偏移 68，且 PE32 与 PE32+ **都是** 68：
  # PE32 多一个 4 字节 BaseOfData，PE32+ 的 ImageBase 则是 8 字节，两者正好抵消。
  # （实测核对过解析本身：notepad.exe=2、powershell.exe=3、cmd.exe=3。）
  $subsystemAt = $optional + 68
  $subsystem = [BitConverter]::ToUInt16($bytes, $subsystemAt)

  return [pscustomobject]@{
    Subsystem = $subsystem
    Machine   = $machine
    Magic     = $magic
    Size      = $bytes.Length
  }
}

# ---------- 路径 ----------
$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot 'lib\launcher\dsh-session-alert-launcher.cs'
$contract = Join-Path $repoRoot 'lib\contract.js'
if ($OutDir -eq '') { $OutDir = Join-Path $repoRoot 'bin' }
$outExe = Join-Path $OutDir 'dsh-session-alert.exe'

Write-Host '=================================================================='
Write-Host 'dsh-session-alert 启动器编译'
Write-Host '=================================================================='
Write-Host "repo      : $repoRoot"
Write-Host "source    : $source"
Write-Host "contract  : $contract"
Write-Host "output    : $outExe"
Write-Host ''

if (-not (Test-Path -LiteralPath $source)) { Fail "找不到源码：$source" }
if (-not (Test-Path -LiteralPath $contract)) { Fail "找不到契约文件：$contract" }

# ---------- 源码编码形态（硬要求，先自己核对一遍）----------
$srcShape = Get-TextShape $source
Write-Host ("source 编码: BOM={0}  CRLF行={1}  孤立LF={2}" -f $srcShape.HasBom, $srcShape.Crlf, $srcShape.LoneLf)
if (-not $srcShape.HasBom) {
  Write-Host 'WARNING: 源码缺少 UTF-8 BOM——csc 可能按 ANSI 解码中文注释（见 .gitattributes）' -ForegroundColor Yellow
}
if ($srcShape.LoneLf -gt 0) {
  Write-Host 'WARNING: 源码含 LF 换行——请归一化为 CRLF（见 .gitattributes）' -ForegroundColor Yellow
}

# ---------- 从 lib\contract.js 读协议方案名 ----------
$contractText = [IO.File]::ReadAllText($contract)
$schemeMatch = [regex]::Match($contractText, "export\s+const\s+PROTOCOL_SCHEME\s*=\s*'([^']*)'")
if (-not $schemeMatch.Success) {
  Fail "无法从 lib\contract.js 解析 PROTOCOL_SCHEME（期望形如 export const PROTOCOL_SCHEME = 'xxx'）"
}
$scheme = $schemeMatch.Groups[1].Value
if ($scheme -notmatch '^[A-Za-z][A-Za-z0-9+.\-]*$') {
  Fail "PROTOCOL_SCHEME 不是合法的 URL 方案名：'$scheme'"
}
Write-Host "contract 方案名: PROTOCOL_SCHEME = '$scheme'"

# 主源码里的兜底值必须与 contract.js 一致，否则单文件编译会造出与注册表不同的方案名。
$srcText = [IO.File]::ReadAllText($source)
$fallbackMatch = [regex]::Match($srcText, 'internal\s+const\s+string\s+ProtocolScheme\s*=\s*"([^"]*)"')
if ($fallbackMatch.Success) {
  $fallback = $fallbackMatch.Groups[1].Value
  if ($fallback -ne $scheme) {
    Write-Host ("WARNING: 源码兜底方案名 '{0}' 与 contract.js 的 '{1}' 不一致（正式产物以 contract.js 为准）" -f $fallback, $scheme) -ForegroundColor Yellow
  }
} else {
  Write-Host 'WARNING: 源码里没有找到兜底方案名常量（直接编译单文件时会失败）' -ForegroundColor Yellow
}
Write-Host ''

# ---------- 找编译器 ----------
$cscCandidates = @(
  (Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $null
foreach ($candidate in $cscCandidates) {
  if (Test-Path -LiteralPath $candidate) { $csc = $candidate; break }
}
if ($null -eq $csc) {
  Fail "找不到 C# 编译器。已尝试：`n  $($cscCandidates -join "`n  ")`n请安装 .NET Framework 4.x（Windows 自带）后重试。"
}
Write-Host "compiler  : $csc"

# ---------- 生成契约常量 ----------
$staging = Join-Path ([IO.Path]::GetTempPath()) ('dsh-session-alert-build-' + [guid]::NewGuid().ToString('N'))
New-Item -Path $staging -ItemType Directory -Force | Out-Null
$generated = Join-Path $staging 'LauncherContract.g.cs'

$generatedBody = @"
// 本文件由 scripts/build-launcher.ps1 生成，请勿手工编辑，也不入库。
//
// 它把 lib/contract.js 的 PROTOCOL_SCHEME 带进启动器，使方案名只有一处来源，
// 避免启动器与应用侧各写一份而静默漂移。

internal static partial class LauncherContract
{
    internal const string ProtocolScheme = "$scheme";
}
"@
$utf8Bom = New-Object Text.UTF8Encoding($true)
$generatedBody = ($generatedBody -replace "`r`n", "`n") -replace "`n", "`r`n"
[IO.File]::WriteAllText($generated, $generatedBody, $utf8Bom)
Write-Host "generated : $generated"
Write-Host ''

if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -Path $OutDir -ItemType Directory -Force | Out-Null }

# ---------- 编译 ----------
$cscArgs = @(
  '/nologo'
  '/target:winexe'          # GUI 子系统 → PE Subsystem = 2 → 不分配控制台
  '/platform:anycpu'
  '/optimize+'
  '/utf8output'
  '/define:SCHEME_FROM_CONTRACT'   # 让主源码用生成的方案名，而不是兜底值
  ('/out:' + $outExe)
  $source
  $generated
)

Write-Step ('csc ' + ($cscArgs -join ' '))
Write-Host ''
# 输出文件可能正被占用：刚点过通知、上一个启动器实例还在保持最上层时，csc 会报
# CS0016（无法写入输出文件）。这不是构建错误，短暂等待后重试即可。
$cscLines = @()
$cscExit = -1
$maxAttempts = 4
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
  # PS 5.1 下 native 命令的 stderr 重定向在 Stop 模式会抛 NativeCommandError，这里临时放宽。
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $cscRaw = & $csc @cscArgs 2>&1
  $cscExit = $LASTEXITCODE
  $ErrorActionPreference = $prevEap

  $cscLines = @(@($cscRaw) | ForEach-Object {
    if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { [string]$_ }
  })

  if ($cscExit -eq 0) { break }
  $locked = (($cscLines -join "`n") -match 'CS0016|another process|另一个程序正在使用')
  if (-not $locked -or $attempt -eq $maxAttempts) { break }
  Write-Host ("  输出文件正被占用（可能有一个启动器实例在运行），1200ms 后重试（第 {0}/{1} 次）..." -f $attempt, $maxAttempts) -ForegroundColor Yellow
  Start-Sleep -Milliseconds 1200
}
foreach ($line in $cscLines) {
  if ($line -ne '') { Write-Host ("  " + $line) }
}
Write-Host ''

if ($cscExit -ne 0) {
  if (-not $KeepStaging) { Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue }
  Fail "编译器退出码 $cscExit"
}
if (-not (Test-Path -LiteralPath $outExe)) {
  if (-not $KeepStaging) { Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue }
  Fail "编译器返回 0 但没有产出 $outExe"
}

# ---------- 校验产物 ----------
$pe = Get-PeInfo $outExe
$machineName = switch ($pe.Machine) {
  0x014C { 'x86' }
  0x8664 { 'x64' }
  0xAA64 { 'ARM64' }
  default { ('0x{0:X}' -f $pe.Machine) }
}
$subsystemName = switch ($pe.Subsystem) {
  2 { 'IMAGE_SUBSYSTEM_WINDOWS_GUI' }
  3 { 'IMAGE_SUBSYSTEM_WINDOWS_CUI（不合格：会分配控制台）' }
  default { 'unknown' }
}

Write-Host '=================================================================='
Write-Host '产物校验'
Write-Host '=================================================================='
Write-Host ("PE Subsystem = {0} ({1})" -f $pe.Subsystem, $subsystemName)
Write-Host ("PE Machine   = 0x{0:X} ({1})，optional header magic = 0x{2:X}" -f $pe.Machine, $machineName, $pe.Magic)
if ($pe.Machine -eq 0x014C) {
  Write-Host '               （托管 AnyCPU 程序集的 PE 头固定写 I386；实际位数由 CLR 决定，见启动器日志的 runtime 行）'
}
Write-Host ("size         = {0} bytes" -f $pe.Size)
Write-Host ''

if ($pe.Subsystem -ne 2) {
  if (-not $KeepStaging) { Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue }
  Fail "PE Subsystem 必须是 2（Windows GUI），实际为 $($pe.Subsystem)。启动器会分配控制台并闪窗。"
}

# ---------- 自检：真跑一次 --selfcheck ----------
# 编译成功不代表入口点齐全、也不代表真的没有控制台，所以这里用产物自证一次。
$logPath = Join-Path ([IO.Path]::GetTempPath()) 'dsh-session-alert-launcher.log'
Write-Host '自检: 运行 dsh-session-alert.exe --selfcheck（不触碰任何窗口）'
# 注意：PowerShell 用 & 调用 GUI 子系统程序时**不会等待**它退出（实测 elapsed≈9ms，
# 且 $LASTEXITCODE 保持旧值），拿到的会是上一个 native 命令的退出码 —— 那等于假证据。
# 必须用 Start-Process -Wait -PassThru 取真实退出码。
$selfCheckProc = Start-Process -FilePath $outExe -ArgumentList '--selfcheck' -Wait -PassThru
$selfCheckExit = $selfCheckProc.ExitCode
Write-Host ("selfcheck 退出码 = {0}  (0=通过, 4=前置自检失败)" -f $selfCheckExit)
if (Test-Path -LiteralPath $logPath) {
  Write-Host "日志尾部（$logPath）:"
  Get-Content -LiteralPath $logPath -Tail 5 -Encoding UTF8 | ForEach-Object { Write-Host ("  | " + $_) }
}
Write-Host ''

$buildOk = ($selfCheckExit -eq 0)
if (-not $KeepStaging) { Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue }

if (-not $buildOk) {
  Fail "产物自检失败（退出码 $selfCheckExit）。请查看上面的日志尾部。"
}

Write-Host '=================================================================='
Write-Host 'BUILD OK' -ForegroundColor Green
Write-Host '=================================================================='
Write-Host "产物: $outExe"
Write-Host 'PE Subsystem = 2，无控制台；入口点自检通过。'
exit 0
