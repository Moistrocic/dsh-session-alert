# 前台切换手法：面向「由 DSH 侧执行」的验证
#
# 背景：用户提出「由 DSH 侧完成前台切换」的思路。这有两条独立理由：
#   1. 应用激活自己的窗口，Windows 通常是允许的；
#   2. Windows 的前台规则里，「调用进程收到了最后一次输入事件」本身就是取得前台权的
#      条件之一，而点击通知正是这样一次输入。
#
# 前一轮实验里 AttachThreadInput 返回 False，怀疑是**附着对象错了**：当时附到了
# GetForegroundWindow() 当时的持有者（可能是 shell 宿主 ShellExperienceHost），
# 而不是真正需要附着的那个线程。
#
# 本脚本系统性地把几种「附着/授权」组合分开试，每一步都复验前台归属：
#   A. 直调 SetForegroundWindow
#   B. AttachThreadInput 到**当前前台窗口**的线程，再调
#   C. 先 AllowSetForegroundWindow(目标 pid)，再直调
#   D. 组合：AllowSetForegroundWindow(目标) + AttachThreadInput + SetForegroundWindow
#   E. ShowWindow(SW_SHOW) 触发激活 + SetForegroundWindow
#
# 注意：本文件必须保持 CRLF 换行 + UTF-8 BOM（见 .gitattributes）。

param(
  [string]$Url = '',
  [string]$LogPath = "$env:TEMP\foreground-fix.log"
)

function Write-Log([string]$m) {
  Add-Content -LiteralPath $LogPath -Value ("{0:HH:mm:ss.fff}  {1}" -f (Get-Date), $m) -Encoding utf8
}

Add-Type -Language CSharp @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class FX {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  public static uint PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static uint ThreadOf(IntPtr h) { uint p; return GetWindowThreadProcessId(h, out p); }
  public static IntPtr FindLargest(uint targetPid) {
    IntPtr best = IntPtr.Zero; long bestArea = -1;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != targetPid) return true;
      if (GetWindowTextLength(h) == 0) return true;
      RECT r; if (!GetWindowRect(h, out r)) return true;
      long a = (long)(r.R - r.L) * (r.B - r.T);
      if (a > bestArea) { bestArea = a; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
  public static string Rect(IntPtr h) { RECT r; GetWindowRect(h, out r); return (r.R - r.L) + "x" + (r.B - r.T); }
}
'@

$required = @('GetForegroundWindow','EnumWindows','GetWindowTextLength','GetWindowRect',
  'IsWindowVisible','IsIconic','IsZoomed','ShowWindow','SetForegroundWindow',
  'BringWindowToTop','AllowSetForegroundWindow','AttachThreadInput',
  'PidOf','ThreadOf','FindLargest','Rect','GetCurrentThreadId')
$missing = @($required | Where-Object { $null -eq [FX].GetMethod($_) })
if ($missing.Count -gt 0) { Write-Log ("SELFCHECK FAIL: 缺少 {0}" -f ($missing -join ',')); exit 4 }
Write-Log "selfcheck ok ($($required.Count) 个入口点)"

function Get-FgPid { [FX]::PidOf([FX]::GetForegroundWindow()) }

try {
  $procs = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
  $target = $null; $hwnd = [IntPtr]::Zero
  foreach ($p in ($procs | Sort-Object WorkingSet64 -Descending)) {
    $h = [FX]::FindLargest([uint32]$p.Id)
    if ($h -ne [IntPtr]::Zero) { $target = $p; $hwnd = $h; break }
  }
  if ($null -eq $target) { Write-Log 'FAIL: 找不到 DSH 窗口'; exit 2 }

  # 先还原窗口（已单独验证过，这段不是本脚本要回答的问题）
  $wasZoomed = [FX]::IsZoomed($hwnd)
  $wasIconic = [FX]::IsIconic($hwnd)
  $wasVisible = [FX]::IsWindowVisible($hwnd)
  Write-Log "invoked Url='$Url' targetPid=$($target.Id) hwnd=$hwnd rect=$([FX]::Rect($hwnd)) visible=$wasVisible iconic=$wasIconic zoomed=$wasZoomed"
  if (-not $wasVisible) {
    [void][FX]::ShowWindow($hwnd, 5); Start-Sleep -Milliseconds 350
    if ($wasZoomed -and -not [FX]::IsZoomed($hwnd)) { [void][FX]::ShowWindow($hwnd, 3) }
  } elseif ($wasIconic) { [void][FX]::ShowWindow($hwnd, 9) }
  elseif ($wasZoomed) { [void][FX]::ShowWindow($hwnd, 3) }
  else { [void][FX]::ShowWindow($hwnd, 5) }
  Start-Sleep -Milliseconds 400

  $myPid = $PID
  $myThread = [FX]::GetCurrentThreadId()
  Write-Log "myPid=$myPid myThread=$myThread foregroundPid(before)=$(Get-FgPid)"
  Write-Log "AllowSetForegroundWindow(target) = $([FX]::AllowSetForegroundWindow([int]$target.Id))"

  function Test([string]$label) {
    $fg = Get-FgPid
    $ok = ($fg -eq $target.Id)
    Write-Log ("  {0} -> foregroundPid={1} inFront={2}" -f $label, $fg, $ok)
    return $ok
  }

  Write-Log '--- A: 直调 SetForegroundWindow ---'
  [void][FX]::SetForegroundWindow($hwnd); Start-Sleep -Milliseconds 400
  if (Test 'A') { Write-Log 'SUCCESS via A'; exit 0 }

  Write-Log '--- B: AttachThreadInput 到当前前台窗口的线程 ---'
  $fgHwnd = [FX]::GetForegroundWindow()
  $fgThread = [FX]::ThreadOf($fgHwnd)
  Write-Log "  foregroundHwnd=$fgHwnd fgThread=$fgThread"
  $att = [FX]::AttachThreadInput($myThread, $fgThread, $true)
  Write-Log "  AttachThreadInput = $att"
  if ($att) {
    [void][FX]::BringWindowToTop($hwnd)
    [void][FX]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 400
    $ok = Test 'B'
    [void][FX]::AttachThreadInput($myThread, $fgThread, $false)
    if ($ok) { Write-Log 'SUCCESS via B'; exit 0 }
  }

  Write-Log '--- C: AllowSetForegroundWindow(target) 后直调（已在开头调用，再次确认）---'
  [void][FX]::AllowSetForegroundWindow([int]$target.Id)
  [void][FX]::SetForegroundWindow($hwnd); Start-Sleep -Milliseconds 400
  if (Test 'C') { Write-Log 'SUCCESS via C'; exit 0 }

  Write-Log '--- D: AllowSetForegroundWindow(target) + AttachThreadInput + SetForegroundWindow ---'
  $fgHwnd = [FX]::GetForegroundWindow()
  $fgThread = [FX]::ThreadOf($fgHwnd)
  [void][FX]::AllowSetForegroundWindow([int]$target.Id)
  $att = [FX]::AttachThreadInput($myThread, $fgThread, $true)
  Write-Log "  attach=$att fgThread=$fgThread"
  [void][FX]::BringWindowToTop($hwnd)
  [void][FX]::SetForegroundWindow($hwnd)
  Start-Sleep -Milliseconds 450
  $ok = Test 'D'
  if ($att) { [void][FX]::AttachThreadInput($myThread, $fgThread, $false) }
  if ($ok) { Write-Log 'SUCCESS via D'; exit 0 }

  Write-Log '--- E: ShowWindow(SW_SHOW) 后再 SetForegroundWindow ---'
  [void][FX]::ShowWindow($hwnd, 5); Start-Sleep -Milliseconds 300
  [void][FX]::SetForegroundWindow($hwnd); Start-Sleep -Milliseconds 400
  if (Test 'E') { Write-Log 'SUCCESS via E'; exit 0 }

  Write-Log "ALL FAILED. rect=$([FX]::Rect($hwnd))"
  exit 1
}
catch {
  Write-Log ("EXCEPTION: {0}" -f $_.Exception.Message)
  exit 3
}
