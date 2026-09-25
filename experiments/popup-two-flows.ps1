# 弹出流程测试：只测两条
#
#   流程 1：最小化 → 弹出到前台
#   流程 2：完全隐藏 → 弹出到前台
#
# 判定标准只有两条（其余一律不测）：
#   A. 窗口尺寸不得变化
#   B. 不得出现命令行窗口
#
# ## 定位窗口的关键坑（已实测）
#
# 不能用 PowerShell 的 Process.MainWindowHandle：它只报告**可见**的主窗口，
# 窗口一旦隐藏就变成 0，会把「从任务栏消失」误判成「窗口已销毁」。
# 因此这里用 EnumWindows 按进程枚举，取面积最大的有标题顶层窗口。
#
# ## 尺寸基准
#
# 期望尺寸取「已知可见形态下的矩形」，而不是最小化/隐藏时 GetWindowRect 的值：
#   - 最小化时 GetWindowRect 返回最小化后的矩形（实测 158x26），不是还原目标；
#   - 隐藏不改变 GetWindowRect，可以直接取。
# 因此两条流程都先把窗口摆到**最大化可见**，取基准矩形，再进入目标形态。

param(
  [string]$Scheme = 'dsh-popup-test'
)

$ErrorActionPreference = 'Stop'
$PS5   = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$here  = $PSScriptRoot
$probe = Join-Path $here 'focus-probe.ps1'
$watch = Join-Path $here 'console-watch.ps1'

Add-Type -Language CSharp @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class P {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static IntPtr FindLargestWindowOf(uint targetPid) {
    IntPtr best = IntPtr.Zero; long bestArea = -1;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != targetPid) return true;
      if (GetWindowTextLength(h) == 0) return true;
      RECT r; if (!GetWindowRect(h, out r)) return true;
      long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  public static int VisibleConsoleCount() {
    int n = 0;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var cls = new StringBuilder(256);
      GetClassName(h, cls, 256);
      string c = cls.ToString();
      if (c == "ConsoleWindowClass" || c == "CASCADIA_HOSTING_WINDOW_CLASS" || c == "PseudoConsoleWindow") n++;
      return true;
    }, IntPtr.Zero);
    return n;
  }

  public static string RectOf(IntPtr h) {
    RECT r; if (!GetWindowRect(h, out r)) return "unavailable";
    return (r.Right - r.Left) + "x" + (r.Bottom - r.Top);
  }
  public static string FormOf(IntPtr h) {
    if (!IsWindowVisible(h)) return "hidden";
    if (IsIconic(h)) return "minimized";
    if (IsZoomed(h)) return "maximized";
    return "normal";
  }
}
'@

function Find-DshWindow {
  foreach ($proc in (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
                     Sort-Object -Property WorkingSet64 -Descending)) {
    $h = [P]::FindLargestWindowOf([uint32]$proc.Id)
    if ($h -ne [IntPtr]::Zero) { return $h }
  }
  throw '未能枚举到任何有标题的 DSH 顶层窗口'
}

function Set-Form([IntPtr]$h, [string]$Form) {
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline) {
    switch ($Form) {
      'maximized' { [void][P]::ShowWindow($h, 3) }
      'minimized' { [void][P]::ShowWindow($h, 6) }
      'hidden'    { [void][P]::ShowWindow($h, 0) }
    }
    Start-Sleep -Milliseconds 400
    if ([P]::FormOf($h) -eq $Form) {
      Start-Sleep -Milliseconds 300
      if ([P]::FormOf($h) -eq $Form) { return }
    }
  }
  throw "无法把窗口摆成 '$Form'"
}

# 只统计**可见**控制台窗口的增量（隐藏的 conhost 不算——它不代表用户看到了窗口）
function Invoke-WithConsoleWatch([scriptblock]$Action) {
  Start-Sleep -Milliseconds 2000
  $log = Join-Path $env:TEMP ("pop-" + [guid]::NewGuid().ToString('N') + ".log")
  $job = Start-Job -ScriptBlock {
    & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass `
      -File $using:watch -Seconds 9 -PollMs 80 -LogPath $using:log
  }
  Start-Sleep -Milliseconds 2500
  try { & $Action } finally { }
  Start-Sleep -Milliseconds 3500
  Receive-Job $job -Wait -AutoRemoveJob | Out-Null
  $hits = if (Test-Path $log) { @(Get-Content $log).Count } else { 0 }
  if (Test-Path $log) { Remove-Item $log -Force }
  return $hits
}

# ---------- 准备 ----------
$hwnd = Find-DshWindow
$originalForm = [P]::FormOf($hwnd)
Write-Host '=================================================================='
Write-Host '弹出流程测试：最小化→前台 / 完全隐藏→前台'
Write-Host '=================================================================='
Write-Host ''
Write-Host "窗口 hwnd = $hwnd    测试前形态 = $originalForm"
Write-Host ''

$regPath = "HKCU:\Software\Classes\$Scheme"
New-Item -Path $regPath -Force | Out-Null
New-ItemProperty -Path $regPath -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
New-Item -Path "$regPath\shell\open\command" -Force | Out-Null
$probeLog = Join-Path $env:TEMP 'popup-probe.log'
$command = 'conhost.exe --headless "{0}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{1}" -LogPath "{2}"' -f $PS5, $probe, $probeLog
Set-ItemProperty -Path "$regPath\shell\open\command" -Name '(default)' -Value $command

$results = New-Object System.Collections.Generic.List[object]

# ---------- 两条流程 ----------
$flows = @(
  [pscustomobject]@{ Name = '流程1 最小化→前台'; Form = 'minimized' },
  [pscustomobject]@{ Name = '流程2 完全隐藏→前台'; Form = 'hidden' }
)

foreach ($flow in $flows) {
  Write-Host "── $($flow.Name) ──"

  # 基准：先摆成最大化可见，取此时矩形作为“尺寸不得变化”的基准
  Set-Form $hwnd 'maximized'
  Start-Sleep -Milliseconds 400
  $baseline = [P]::RectOf($hwnd)

  # 进入目标形态
  Set-Form $hwnd $flow.Form
  $formBefore = [P]::FormOf($hwnd)
  Write-Host "  进入形态: $formBefore   基准尺寸: $baseline"

  if (Test-Path $probeLog) { Remove-Item $probeLog -Force }
  $hits = Invoke-WithConsoleWatch ({
    cmd.exe /c start "" "$Scheme`://go" 2>&1 | Out-Null
    Start-Sleep -Milliseconds 1500
  }.GetNewClosure())

  $formAfter = [P]::FormOf($hwnd)
  $rectAfter = [P]::RectOf($hwnd)
  $sizeOk = ($rectAfter -eq $baseline)
  $consoleOk = ($hits -eq 0)
  $visibleOk = ($formAfter -ne 'hidden' -and $formAfter -ne 'minimized')

  $results.Add([pscustomobject]@{
    流程 = $flow.Name
    操作前 = $formBefore
    操作后 = $formAfter
    基准尺寸 = $baseline
    实际尺寸 = $rectAfter
    尺寸未变 = $sizeOk
    命令行闪烁 = $hits
    已可见 = $visibleOk
    通过 = ($sizeOk -and $consoleOk -and $visibleOk)
  })

  $verdict = if ($sizeOk -and $consoleOk -and $visibleOk) { 'PASS' } else { 'FAIL' }
  Write-Host ("  [{0}] 操作前={1}  操作后={2}  尺寸 {3} -> {4} (未变={5})  命令行闪烁={6}" -f `
    $verdict, $formBefore, $formAfter, $baseline, $rectAfter, $sizeOk, $hits)
  Write-Host ''
}

Remove-Item $regPath -Recurse -Force -ErrorAction SilentlyContinue

# ---------- 复位 ----------
Set-Form $hwnd 'maximized'
if ($originalForm -eq 'normal') { Set-Form $hwnd 'maximized' }   # 保持可用

# ---------- 汇总 ----------
Write-Host '=================================================================='
Write-Host '汇总'
Write-Host '=================================================================='
$results | Format-Table -AutoSize | Out-String | Write-Host
$failed = @($results | Where-Object { -not $_.通过 })
if ($failed.Count -eq 0) {
  Write-Host '两条流程全部通过。' -ForegroundColor Green
  exit 0
}
Write-Host "$($failed.Count) 条流程失败。" -ForegroundColor Red
exit 1
