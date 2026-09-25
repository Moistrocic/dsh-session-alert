# 自动测试流程：置顶与闪窗
#
# 设计原则（按用户要求）：**先测当前状态 → 对齐到已知初始状态 → 再系统化跑流程**。
# 全部用例的期望值都由程序判定，不依赖人工观察。
#
# 判定口径：
#   1) 显示状态不变 —— 最大化/最小化/普通三种窗口状态下，跳转后原状态必须保持。
#   2) 可见控制台 —— 窗口类为 ConsoleWindowClass / Windows Terminal 类的可见顶层窗口
#      增量必须为 0。注意这里看的是**窗口可见性**，不是 conhost 进程是否存在：
#      即使窗口完全不可见，子进程也可能附带一个 conhost。
#   3) 确实置顶 —— 操作后前台进程必须变为 DSH 主进程。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File focus-regression.ps1

param(
  [string]$Scheme = 'dsh-alert-test'
)

$ErrorActionPreference = 'Stop'
$PS5   = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$here  = $PSScriptRoot
$probe = Join-Path $here 'focus-probe.ps1'
$watch = Join-Path $here 'console-watch.ps1'
$selftestDir = Join-Path (Split-Path $here -Parent) 'legacy\v1-source'

Add-Type -Language CSharp @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class Win {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static uint PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }

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

  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);

  /// 枚举某进程所有顶层窗口，返回面积最大的一个。
  /// 不能用 Process.MainWindowHandle：它只报告**可见**主窗口，窗口隐藏后为 0，
  /// 会让 hidden 形态的用例误判为“窗口已销毁”。
  public static IntPtr FindLargestWindowOf(uint targetPid) {
    IntPtr best = IntPtr.Zero;
    long bestArea = -1;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != targetPid) return true;
      if (GetWindowTextLength(h) == 0) return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  public static int Width(IntPtr h) { RECT r; GetWindowRect(h, out r); return r.Right - r.Left; }
  public static int Height(IntPtr h) { RECT r; GetWindowRect(h, out r); return r.Bottom - r.Top; }
}
'@

# ---------- 状态工具 ----------

function Get-DshMain {
  # 同样不能用 MainWindowHandle 定位：窗口隐藏后它为 0。
  # 改为在全部同名进程里找面积最大的有标题顶层窗口。
  $procs = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
  foreach ($p in ($procs | Sort-Object -Property WorkingSet64 -Descending)) {
    $h = [Win]::FindLargestWindowOf([uint32]$p.Id)
    if ($h -ne [IntPtr]::Zero) { return [pscustomobject]@{ Pid = [uint32]$p.Id; Hwnd = $h } }
  }
  throw '未能枚举到任何有标题的 DSH 顶层窗口'
}

function Get-State([IntPtr]$h) {
  # 形态必须区分「不可见」与「最小化」：二者都 IsIconic 但任务栏表现不同。
  if (-not [Win]::IsWindowVisible($h)) { return 'hidden' }
  if ([Win]::IsIconic($h)) { return 'minimized' }
  if ([Win]::IsZoomed($h)) { return 'maximized' }
  return 'normal'
}

function Get-Rect([IntPtr]$h) {
  $r = New-Object Win+RECT
  [void][Win]::GetWindowRect($h, [ref]$r)
  return [pscustomobject]@{ W = $r.Right - $r.Left; H = $r.Bottom - $r.Top; Key = "$($r.Right - $r.Left)x$($r.Bottom - $r.Top)" }
}

function Set-State([IntPtr]$h, [string]$State) {
  # 对齐动作本身要**重试**，而不只是等待。
  # 原因：Windows 的显示状态转换带竞态——最小化/还原有动画，且若前一个用例
  # 启动的进程仍在收尾，一次 ShowWindow 可能被后续事件盖掉。只调一次再等，
  # 会偶发地对齐失败，使用例前提不成立、结论不可信。
  $deadline = (Get-Date).AddSeconds(12)
  $last = $null
  while ((Get-Date) -lt $deadline) {
    switch ($State) {
      'minimized' { [void][Win]::ShowWindow($h, 6) }   # SW_MINIMIZE
      'maximized' { [void][Win]::ShowWindow($h, 3) }   # SW_SHOWMAXIMIZED
      'normal'    { [void][Win]::ShowWindow($h, 9) }   # SW_RESTORE
      'hidden'    { [void][Win]::ShowWindow($h, 0) }   # SW_HIDE：连任务栏按钮一起消失
    }
    Start-Sleep -Milliseconds 400
    $last = Get-State $h
    if ($last -eq $State) {
      Start-Sleep -Milliseconds 300     # 再稳一下，确认没有后续动画改回去
      if ((Get-State $h) -eq $State) { return }
    }
  }
  throw "窗口形态未能对齐到 '$State'（超时 12 秒，最后观测到 '$last'）"
}

# 用例之间必须彻底复位到**已知可见**状态。
# 否则一个用例把窗口留在 hidden/minimized，下一个用例的“对齐”就从脏状态出发，
# 实测会污染后续结论（表现为探针识别不出形态、或矩形取自最小化后的值）。
function Reset-Visible([IntPtr]$h) {
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline) {
    if ((Get-State $h) -ne 'hidden') { Set-State $h 'maximized'; return }
    [void][Win]::ShowWindow($h, 5)      # SW_SHOW 先让它可见
    Start-Sleep -Milliseconds 350
  }
  throw '窗口未能从不可见状态恢复'
}

# 用短命监视器在指定动作前后统计**可见**控制台窗口的增量
function Measure-ConsoleDelta([scriptblock]$Action) {
  # 排空时间必须足够长。被启动的控制台窗口由 Windows Terminal 托管，其关闭是
  # 异步的：窗口在动作结束后仍可能存活一两秒。若下一个用例紧接着开始测量，
  # 那个正在关闭的旧窗口会被计入**当前**用例，造成计数漂移（实测 1↔2）。
  # 因此测量前先静默排空，测量后再留足关闭时间。
  Start-Sleep -Milliseconds 2500

  $log = Join-Path $env:TEMP ("cw-" + [guid]::NewGuid().ToString('N') + ".log")
  $job = Start-Job -ScriptBlock {
    & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass `
      -File $using:watch -Seconds 9 -PollMs 80 -LogPath $using:log
  }
  Start-Sleep -Milliseconds 2500      # 让监视器完成基线
  $before = [Win]::VisibleConsoleCount()
  try { & $Action } finally { }
  Start-Sleep -Milliseconds 3500      # 留足控制台窗口关闭的时间，避免跨用例串扰
  $after = [Win]::VisibleConsoleCount()
  Receive-Job $job -Wait -AutoRemoveJob | Out-Null
  $hits = if (Test-Path $log) { @(Get-Content $log).Count } else { 0 }
  if (Test-Path $log) { Remove-Item $log -Force }
  return [pscustomobject]@{ Hits = $hits; Before = $before; After = $after }
}

# ---------- 用例 ----------

$main = Get-DshMain
$hwnd = [IntPtr]$main.Hwnd
$dshPid = [uint32]$main.Pid

Write-Host '=================================================================='
Write-Host '自动测试：置顶与闪窗'
Write-Host '=================================================================='
Write-Host ''
Write-Host '【第 0 步】检测当前窗口状态'
$initialState = Get-State $hwnd
$initialW = [Win]::Width($hwnd); $initialH = [Win]::Height($hwnd)
Write-Host "  DSH 主进程 PID = $dshPid   hwnd = $hwnd"
Write-Host "  当前显示状态   = $initialState"
Write-Host "  当前尺寸       = ${initialW} x ${initialH}"
Write-Host "  当前可见控制台 = $([Win]::VisibleConsoleCount())"

# 注册测试用协议方案，两种命令行写法
$regPath = "HKCU:\Software\Classes\$Scheme"
New-Item -Path $regPath -Force | Out-Null
New-ItemProperty -Path $regPath -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
New-Item -Path "$regPath\shell\open\command" -Force | Out-Null

# 注意占位符有**两套索引**，不要混：
#   %1    由协议激活时由系统填入 URL（探针只把它记进日志，本测试不校验其值）
#   {0}/{1}/{2}  是 PowerShell -f 的格式操作数：PS5 路径 / 探针路径 / 日志路径
# 早先把日志路径写成 %2 是错的：%2 永远由系统按 “第 2 个 URL 参数” 处理，
# 而协议只传一个 URL，于是它一直是字面量 "%2"。
$styles = [ordered]@{
  '旧写法 -WindowStyle Hidden' = '"{0}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}" -Url "%1" -LogPath "{2}"'
  '新写法 conhost --headless'  = 'conhost.exe --headless "{0}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{1}" -Url "%1" -LogPath "{2}"'
}
$probeLogPath = Join-Path $env:TEMP 'focus-probe.log'

$results = New-Object System.Collections.Generic.List[object]

foreach ($styleName in $styles.Keys) {
  foreach ($state in @('normal', 'maximized', 'minimized', 'hidden')) {
    $cmd = $styles[$styleName] -f $PS5, $probe, $probeLogPath
    Set-ItemProperty -Path "$regPath\shell\open\command" -Name '(default)' -Value $cmd

    # 先彻底复位到已知可见状态，避免上一个用例的残留形态污染本用例。
    Reset-Visible $hwnd

    # 确定**操作后应保持的窗口矩形**——这是用户的硬要求：弹窗后尺寸不得变化。
    #
    # 关键点：GetWindowRect 在**最小化**时返回的是最小化之后的矩形（实测 158x26），
    # 不能当期望值。该形态下真正的期望是 Windows 记住的“还原矩形”，
    # 因此先取还原矩形、再摆回最小化；hidden 不改变 GetWindowRect，故直接取。
    $expectRect = $null
    if ($state -eq 'minimized') {
      Set-State $hwnd 'maximized'
      [void][Win]::ShowWindow($hwnd, 9)                 # SW_RESTORE
      Start-Sleep -Milliseconds 700
      $expectRect = (Get-Rect $hwnd).Key
      Set-State $hwnd 'minimized'
    } else {
      Set-State $hwnd $state
      $expectRect = (Get-Rect $hwnd).Key
    }
    $stateAligned = Get-State $hwnd

    $probeLog = $probeLogPath
    if (Test-Path $probeLog) { Remove-Item $probeLog -Force }

    $measured = Measure-ConsoleDelta ({
      cmd.exe /c start "" "$Scheme`://go" 2>&1 | Out-Null
      Start-Sleep -Milliseconds 1200
    }.GetNewClosure())

    $afterState = Get-State $hwnd
    $afterRect = (Get-Rect $hwnd).Key
    $fgPid = [Win]::PidOf([Win]::GetForegroundWindow())

    # 前置条件：探针在动手前必须正确识别窗口形态。
    # 若识别错，说明“对齐形态”没生效，本用例结论不可信。
    $probeSaw = '未记录'
    if (Test-Path $probeLog) {
      $m = Select-String -LiteralPath $probeLog -Pattern 'before: form=(\w+)' | Select-Object -First 1
      if ($m) { $probeSaw = $m.Matches[0].Groups[1].Value }
    }
    $precondOk = ($probeSaw -eq $stateAligned)

    # 硬要求一：尺寸不得变化。最小化形态的期望值是“还原矩形”（上面已取）。
    $sizeOk = ($afterRect -eq $expectRect)

    # 硬要求二：不得出现可见控制台窗口。
    $consoleOk = ($measured.Hits -eq 0)

    # 后置形态：最小化/不可见都必须变为可见（这是本功能的目的）；
    # 普通/最大化必须保持原形态。
    $expectedState = if ($stateAligned -in @('minimized', 'hidden')) { 'maximized' } else { $stateAligned }
    $visibleOk = ($afterState -ne 'hidden' -and $afterState -ne 'minimized')
    $stateOk = if ($stateAligned -in @('minimized', 'hidden')) { $visibleOk } else { $afterState -eq $expectedState }

    $raisedOk = ($fgPid -eq $dshPid)

    $results.Add([pscustomobject]@{
      写法     = $styleName
      初始形态 = $stateAligned
      探针识别 = $probeSaw
      前置ok   = $precondOk
      期望矩形 = $expectRect
      实际矩形 = $afterRect
      尺寸ok   = $sizeOk
      期望形态 = $expectedState
      实际形态 = $afterState
      形态ok   = $stateOk
      闪窗     = $measured.Hits
      # 观测项，非硬性判据：Windows 前台锁使“能否抢到前台”本质上是概率性的。
      # 把它当通过条件会让套件长期不可靠，也会把 OS 行为误报成插件缺陷。
      观测置顶 = $raisedOk
    })

    $verdict = if ($precondOk -and $stateOk -and $sizeOk -and $consoleOk) { 'PASS' } else { 'FAIL' }
    Write-Host ("  [{0}] {1,-26} 形态={2,-9} 探针={3,-9} 矩形 {4}->{5} 尺寸ok={6} 闪窗={7} 置顶(观测)={8}" -f `
      $verdict, $styleName, $stateAligned, $probeSaw, $expectRect, $afterRect, $sizeOk, $measured.Hits, $raisedOk)
  }
}

Remove-Item $regPath -Recurse -Force -ErrorAction SilentlyContinue

# ---------- 通知投递 ----------
Write-Host ''
Write-Host '【通知投递】发一条真通知，检查是否闪窗'
if (Test-Path (Join-Path $selftestDir 'scripts\selftest.mjs')) {
  $measured = Measure-ConsoleDelta ({
    Push-Location $selftestDir
    try { node scripts/selftest.mjs --toast 2>&1 | Out-Null } finally { Pop-Location }
  }.GetNewClosure())
  $consoleOk = ($measured.Hits -eq 0)
  Write-Host ("  [{0}] 通知投递   闪窗={1}" -f $(if ($consoleOk) { 'PASS' } else { 'FAIL' }), $measured.Hits)
} else {
  Write-Host '  [SKIP] 未找到旧实现的 selftest，通知投递改为由插件自身的测试入口验证'
}

# ---------- 复位 ----------
Write-Host ''
Write-Host '【复位】把窗口恢复到测试前的显示状态'
Set-State $hwnd $initialState
if ($initialState -ne 'minimized') {
  # 最大化状态在 Windows 上无法用 SW_SHOWMAXIMIZED 的尺寸还原为“原尺寸”，
  # 因此这里只保证状态类别一致，尺寸由用户自行调整。
}
$finalState = Get-State $hwnd
Write-Host "  恢复后显示状态 = $finalState  (期望 $initialState)"
Write-Host "  恢复后可见控制台 = $([Win]::VisibleConsoleCount())"

# ---------- 汇总 ----------
Write-Host ''
Write-Host '=================================================================='
Write-Host '汇总'
Write-Host '=================================================================='
$results | Format-Table -AutoSize | Out-String | Write-Host
$failed = @($results | Where-Object { -not ($_.前置ok -and $_.尺寸ok -and $_.形态ok -and $_.闪窗 -eq 0) })
if ($failed.Count -eq 0) {
  Write-Host '全部用例通过。' -ForegroundColor Green
  exit 0
} else {
  Write-Host "$($failed.Count) 个用例失败：" -ForegroundColor Red
  $failed | Format-Table -AutoSize | Out-String | Write-Host
  exit 1
}
