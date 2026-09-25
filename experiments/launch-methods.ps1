# 按**真实协议激活路径**对比四种启动方式下的控制台状态。
#
# 为什么不在 shell 里直接调用：当前 shell 自带控制台，子进程会继承它，
# 从而掩盖差异。真实场景是 ShellExecute 从零启动，没有父控制台。
# 因此对每种方式各激活一次协议，由探针把自身状态落盘后再读回。

$PS5     = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$WSCRIPT = "$env:SystemRoot\System32\wscript.exe"
$probe   = Join-Path $PSScriptRoot 'conprobe.ps1'
$out     = Join-Path $env:TEMP 'conprobe-out.txt'
$vbs     = Join-Path $env:TEMP 'dsh-nolaunch.vbs'
$scheme  = 'HKCU:\Software\Classes\dshconprobe'

# 无窗口启动器：WScript 以窗口样式 0（隐藏）运行命令，不分配控制台
$vbsBody = 'CreateObject("WScript.Shell").Run """' + $PS5 + '"" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""' + $probe + '""", 0, False'
[IO.File]::WriteAllText($vbs, $vbsBody, (New-Object Text.UTF8Encoding($false)))

New-Item -Path $scheme -Force | Out-Null
New-ItemProperty -Path $scheme -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
New-Item -Path "$scheme\shell\open\command" -Force | Out-Null

$methods = [ordered]@{
  'A -WindowStyle Hidden'  = ('"{0}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}"' -f $PS5, $probe)
  'B 无 WindowStyle(对照)' = ('"{0}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{1}"' -f $PS5, $probe)
  'C conhost --headless'   = ('conhost.exe --headless "{0}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{1}"' -f $PS5, $probe)
  'D wscript 无窗口'       = ('"{0}" "{1}"' -f $WSCRIPT, $vbs)
}

foreach ($name in $methods.Keys) {
  if (Test-Path $out) { Remove-Item $out -Force }
  Set-ItemProperty -Path "$scheme\shell\open\command" -Name '(default)' -Value $methods[$name]
  cmd.exe /c start "" "dshconprobe://go" 2>&1 | Out-Null
  Start-Sleep -Milliseconds 3000
  $state = if (Test-Path $out) { (Get-Content $out -Raw) } else { '<探针未执行>' }
  if ($null -eq $state) { $state = '<结果为空>' }
  Write-Host ("{0,-24} {1}" -f $name, $state.ToString().Trim())
}

Remove-Item $scheme -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path $out) { Remove-Item $out -Force }
if (Test-Path $vbs) { Remove-Item $vbs -Force }
Write-Host ''
Write-Host '(诊断用的协议方案与临时文件已清理)'
