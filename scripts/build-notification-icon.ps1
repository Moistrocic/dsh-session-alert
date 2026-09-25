# 从 DeepSeek Harness 应用自己的图标生成插件要用的两份资源。
#
# ## 为什么要有这个脚本
#
# 通知上的图标有两个来源，需要两种格式：
#   - **应用身份图标**（注册表的 `IconUri` 与开始菜单快捷方式的图标）：Windows 认 `.ico`，
#     因此生成一份多尺寸 ICO（16/24/32/48/64/128/256）——只放一张大图会让任务栏/通知里
#     显示成缩略的模糊小图。
#   - **toast 的 `appLogoOverride`**：toast XML 的 `<image>` 认 PNG/JPG，因此生成一份 256×256 PNG。
#
# 图标来源是 DSH 安装目录里的 `resources\icon.png`（1024×1024）。它是**外部资源**，
# 大版本升级后可能变样，所以这里做成可复跑的脚本，而不是把图直接改一改塞进仓库就不管了。
#
# 用法（在仓库根目录）：
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-notification-icon.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-notification-icon.ps1 -Source D:\other\icon.png
#
# 退出码：0 = 两份资源都已写出并校验；3 = 源文件读不到；4 = 生成后校验不通过。

[CmdletBinding()]
param(
  [string]$Source = 'C:\Code\IDE\Deepseek Harness\resources\icon.png',
  [string]$OutDir
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Add-Type -AssemblyName System.Drawing

if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $OutDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'assets'
}

if (-not (Test-Path -LiteralPath $Source)) {
  [Console]::Error.WriteLine("找不到图标源文件：$Source")
  exit 3
}
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -Path $OutDir -ItemType Directory -Force | Out-Null }

$pngPath = Join-Path $OutDir 'notification-icon.png'
$icoPath = Join-Path $OutDir 'notification-icon.ico'

# 从源图渲染出指定边长的一张位图（等比缩放居中，保留透明通道）。
#
# **图片作为参数传进来，不要用 `$script:source`。** 踩过两个叠在一起的坑：
#   1. PowerShell 变量名大小写不敏感 —— `param([string]$Source)` 与 `$source = <图片>`
#      是**同一个变量**；
#   2. 在函数体里读 `$script:source` 取到的是 $null，于是 `$Size / $null` 报
#      「Attempted to divide by zero」——报错指向除法，真因是作用域与命名冲突。
# 显式传参让两个坑一起消失。
$sourceImage = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $Source).Path)
function New-Square([int]$Size, [System.Drawing.Image]$Image) {
  $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    # 等比放进正方形画布（源图是正方形，这里仍然按比例算，换源也不会变形）。
    $scale = [Math]::Min($Size / $Image.Width, $Size / $Image.Height)
    $w = [int][Math]::Round($Image.Width * $scale)
    $h = [int][Math]::Round($Image.Height * $scale)
    $g.DrawImage($Image, [int](($Size - $w) / 2), [int](($Size - $h) / 2), $w, $h)
  } finally { $g.Dispose() }
  return $bmp
}

# 1) toast 用的 PNG（256×256）
$png = New-Square 256 $sourceImage
try { $png.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $png.Dispose() }

# 2) IconUri / 快捷方式用的多尺寸 ICO。
#
# ICO 容器是自己拼的：Vista 以后允许条目里直接放 PNG 数据，而 .NET 没有公开的
# 多尺寸 ICO 写出 API（`Icon.Save` 只能存单张）。格式：
#   ICONDIR  : reserved(2)=0, type(2)=1, count(2)=N
#   每个条目  : width(1) height(1) colors(1)=0 reserved(1)=0 planes(2)=1 bpp(2)=32
#               bytesInRes(4) imageOffset(4)      ← 宽/高为 256 时写 0
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$blobs = @()
foreach ($size in $sizes) {
  $bmp = New-Square $size $sourceImage
  try {
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $blobs += , @{ size = $size; bytes = $ms.ToArray() }
    $ms.Dispose()
  } finally { $bmp.Dispose() }
}

$headerSize = 6 + (16 * $blobs.Count)
$offset = $headerSize
$ico = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($ico)
try {
  $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$blobs.Count)
  foreach ($blob in $blobs) {
    $dim = if ($blob.size -ge 256) { 0 } else { $blob.size }
    $writer.Write([byte]$dim); $writer.Write([byte]$dim)
    $writer.Write([byte]0); $writer.Write([byte]0)
    $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$blob.bytes.Length)
    $writer.Write([uint32]$offset)
    $offset += $blob.bytes.Length
  }
  foreach ($blob in $blobs) { $writer.Write($blob.bytes) }
} finally { $writer.Dispose() }
[System.IO.File]::WriteAllBytes($icoPath, $ico.ToArray())
$ico.Dispose()
$sourceImage.Dispose()

# --- 校验：尺寸/条目数/PNG 签名都要真的对得上，而不是「写完了就算」 ------------------
$ok = $true
$pngBytes = [System.IO.File]::ReadAllBytes($pngPath)
$pngOk = $pngBytes.Length -gt 100 -and $pngBytes[0] -eq 0x89 -and $pngBytes[1] -eq 0x50
$pngSize = if ($pngOk) {
  ([int]$pngBytes[16] * 16777216 + [int]$pngBytes[17] * 65536 + [int]$pngBytes[18] * 256 + [int]$pngBytes[19])
} else { 0 }
if (-not $pngOk -or $pngSize -ne 256) { $ok = $false }

$icoBytes = [System.IO.File]::ReadAllBytes($icoPath)
$icoCount = [int]$icoBytes[4] + [int]$icoBytes[5] * 256
if ($icoCount -ne $sizes.Count) { $ok = $false }
foreach ($blob in $blobs) {
  if ($blob.bytes[0] -ne 0x89 -or $blob.bytes[1] -ne 0x50) { $ok = $false }
}

Write-Host "源文件   : $Source"
Write-Host "PNG      : $pngPath（$($pngBytes.Length) 字节，${pngSize}x${pngSize}）"
Write-Host "ICO      : $icoPath（$($icoBytes.Length) 字节，$icoCount 个尺寸：$($sizes -join '/')）"
if (-not $ok) { [Console]::Error.WriteLine('生成后校验未通过'); exit 4 }
Write-Host '两份资源都已生成并校验。' -ForegroundColor Green
exit 0
