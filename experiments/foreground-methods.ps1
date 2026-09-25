# 置顶手法对比：找出在「按钮激活的进程」里真正能把窗口拉到前台的做法。
#
# 背景：实测发现，由 toast 按钮的协议激活拉起的进程调用 SetForegroundWindow
# 会连续返回 False，窗口上不到前台。而此前在「直接激活协议」的实验里同一调用成功过。
# 二者差别可疑，需要用可复现的对比来定论，而不是靠推测。
#
# 依次尝试若干手法，每一步都复验前台归属（GetForegroundWindow 的进程 id）：
#   1. SetForegroundWindow 直接调用
#   2. AllowSetForegroundWindow(ASFW_ANY) 后再调
#   3. 先最小化再还原（改变窗口激活状态，可能解除前台锁）
#   4. SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE) 抬到最上层
#   5. ShowWindow(SW_SHOW) + SetForegroundWindow 组合
#
# 注意：本文件必须保持 CRLF 换行 + UTF-8 BOM（见 .gitattributes）。

param(
  [string]$Url = '',
  [string]$LogPath = "$env:TEMP\foreground-methods.log"
)

function Write-Log([string]$m) {
  Add-Content -LiteralPath $LogPath -Value ("{0:HH:mm:ss.fff}  {1}" -f (Get-Date), $m) -Encoding utf8
}

Add-Type -Language CSharp @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class FG {
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
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  public const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOACTIVATE = 0x0010, SWP_SHOWWINDOW = 0x0040;

  public static uint PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
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

$SW_RESTORE = 9
$SW_MINIMIZE = 6

# 前置自检：显式确认每个要用的入口点都存在。
# 这是一条被同一个 bug 咬了两次之后加的检查——漏写一个 DllImport 声明时，
# 调用处抛的异常会被末尾的 catch 吞掉只留一行日志，外表表现成「脚本没生效」，
# 极难归因。宁可在这里显式失败。
$required = @(
  'GetForegroundWindow', 'EnumWindows', 'GetWindowTextLength', 'GetWindowRect',
  'IsWindowVisible', 'IsIconic', 'IsZoomed', 'ShowWindow', 'SetForegroundWindow',
  'BringWindowToTop', 'AllowSetForegroundWindow', 'SetWindowPos',
  'AttachThreadInput', 'SwitchToThisWindow', 'GetCurrentThreadId',
  'PidOf', 'FindLargest', 'Rect'
)
$missing = @($required | Where-Object { $null -eq [FG].GetMethod($_) })
if ($missing.Count -gt 0) {
  Write-Log ("SELFCHECK FAIL: FG 缺少方法: {0}" -f ($missing -join ', '))
  exit 4
}
Write-Log "selfcheck: 全部 $($required.Count) 个入口点就绪"

try {
  $procs = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
  $main = $null; $hwnd = [IntPtr]::Zero
  foreach ($p in ($procs | Sort-Object WorkingSet64 -Descending)) {
    $h = [FG]::FindLargest([uint32]$p.Id)
    if ($h -ne [IntPtr]::Zero) { $main = $p; $hwnd = $h; break }
  }
  if ($null -eq $main) { Write-Log 'FAIL: 找不到 DSH 窗口'; exit 2 }

  # 先让它出现，且**保持原形态**（这一段已在 popup-two-flows.ps1 中验证通过）。
  # 本脚本专注回答的是下一问：能否把它拉到**前台**。
  $wasZoomed  = [FG]::IsZoomed($hwnd)
  $wasIconic  = [FG]::IsIconic($hwnd)
  $wasVisible = [FG]::IsWindowVisible($hwnd)
  Write-Log "invoked Url='$Url'"
  Write-Log "target pid=$($main.Id) hwnd=$hwnd rect=$([FG]::Rect($hwnd)) iconic=$wasIconic zoomed=$wasZoomed visible=$wasVisible"

  if (-not $wasVisible) {
    [void][FG]::ShowWindow($hwnd, 5)                    # SW_SHOW
    Start-Sleep -Milliseconds 350
    if ($wasZoomed -and -not [FG]::IsZoomed($hwnd)) {
      [void][FG]::ShowWindow($hwnd, 3)                  # SW_SHOWMAXIMIZED 修正降级
    }
  } elseif ($wasIconic) {
    [void][FG]::ShowWindow($hwnd, $SW_RESTORE)
  } elseif ($wasZoomed) {
    [void][FG]::ShowWindow($hwnd, 3)
  } else {
    [void][FG]::ShowWindow($hwnd, 5)
  }
  Start-Sleep -Milliseconds 400
  $rectBefore = [FG]::Rect($hwnd)
  Write-Log "after restore: rect=$rectBefore visible=$([FG]::IsWindowVisible($hwnd)) iconic=$([FG]::IsIconic($hwnd)) zoomed=$([FG]::IsZoomed($hwnd))"

  function Test-InFront([string]$label) {
    $fg = [FG]::PidOf([FG]::GetForegroundWindow())
    $ok = ($fg -eq $main.Id)
    Write-Log ("  {0}: foregroundPid={1} inFront={2}" -f $label, $fg, $ok)
    return $ok
  }

  Write-Log '--- 手法 1: SetForegroundWindow 直接调用 ---'
  [void][FG]::SetForegroundWindow($hwnd); Start-Sleep -Milliseconds 400
  if (Test-InFront '直接 SetForegroundWindow') { Write-Log 'SUCCESS via 手法1'; exit 0 }

  Write-Log '--- 手法 2: AllowSetForegroundWindow(ASFW_ANY) 后再调 ---'
  $a = [FG]::AllowSetForegroundWindow(-1)
  [void][FG]::SetForegroundWindow($hwnd); Start-Sleep -Milliseconds 400
  Write-Log "  AllowSetForegroundWindow=$a"
  if (Test-InFront 'ASFW_ANY + SetForegroundWindow') { Write-Log 'SUCCESS via 手法2'; exit 0 }

  Write-Log '--- 手法 3: 先最小化再还原（改变激活状态）---'
  [void][FG]::ShowWindow($hwnd, $SW_MINIMIZE); Start-Sleep -Milliseconds 350
  [void][FG]::ShowWindow($hwnd, $SW_RESTORE); Start-Sleep -Milliseconds 700
  if (Test-InFront '最小化后还原') { Write-Log 'SUCCESS via 手法3'; exit 0 }

  Write-Log '--- 手法 4: SetWindowPos 抬到最上层（NOACTIVATE，不改尺寸）---'
  [void][FG]::SetWindowPos($hwnd, [FG]::HWND_TOPMOST, 0, 0, 0, 0,
    [FG]::SWP_NOMOVE -bor [FG]::SWP_NOSIZE -bor [FG]::SWP_SHOWWINDOW)
  Start-Sleep -Milliseconds 500
  $inFront = Test-InFront 'HWND_TOPMOST'
  Write-Log ("  rect after topmost = {0}" -f [FG]::Rect($hwnd))
  # 无论成功与否都取消置顶，避免窗口长期压住别的内容
  [void][FG]::SetWindowPos($hwnd, [FG]::HWND_NOTOPMOST, 0, 0, 0, 0,
    [FG]::SWP_NOMOVE -bor [FG]::SWP_NOSIZE)
  if ($inFront) { Write-Log 'SUCCESS via 手法4'; exit 0 }

  Write-Log '--- 手法 5: BringWindowToTop + SetForegroundWindow 循环 ---'
  for ($i = 1; $i -le 5; $i++) {
    [void][FG]::BringWindowToTop($hwnd)
    $r = [FG]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 250
    $fg = [FG]::PidOf([FG]::GetForegroundWindow())
    Write-Log "  尝试 $i : SetForegroundWindow=$r foregroundPid=$fg"
    if ($fg -eq $main.Id) { Write-Log 'SUCCESS via 手法5'; exit 0 }
  }

  Write-Log '--- 手法 6: AttachThreadInput 附着前台线程以窃取激活权 ---'
  # 原理：把本线程的输入队列附着到当前前台窗口所属线程，之后本线程被视为
  # “前台线程”，SetForegroundWindow 的前台锁便不再拒绝。用完必须解附着。
  $fgHwnd = [FG]::GetForegroundWindow()
  $fgPidHolder = [uint32]0
  $fgThread = [FG]::GetWindowThreadProcessId($fgHwnd, [ref]$fgPidHolder)
  $myThread = [FG]::GetCurrentThreadId()
  Write-Log "  foregroundHwnd=$fgHwnd fgThread=$fgThread myThread=$myThread"
  $attached = $false
  try {
    $attached = [FG]::AttachThreadInput($myThread, $fgThread, $true)
    Write-Log "  AttachThreadInput = $attached"
    [void][FG]::BringWindowToTop($hwnd)
    $r = [FG]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 400
    Write-Log "  SetForegroundWindow after attach = $r"
    if (Test-InFront 'AttachThreadInput + SetForegroundWindow') { Write-Log 'SUCCESS via 手法6'; exit 0 }
  }
  finally {
    if ($attached) { [void][FG]::AttachThreadInput($myThread, $fgThread, $false) }
  }

  Write-Log '--- 手法 7: SwitchToThisWindow ---'
  [void][FG]::SwitchToThisWindow($hwnd, $true)
  Start-Sleep -Milliseconds 500
  if (Test-InFront 'SwitchToThisWindow') { Write-Log 'SUCCESS via 手法7'; exit 0 }

  $rectAfter = [FG]::Rect($hwnd)
  Write-Log "ALL FAILED. rect before=$rectBefore after=$rectAfter unchanged=$($rectBefore -eq $rectAfter)"
  exit 1
}
catch {
  Write-Log ("EXCEPTION: {0}" -f $_.Exception.Message)
  exit 3
}
