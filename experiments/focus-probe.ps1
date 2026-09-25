# 前台置顶探针
#
# 用途：把一个 DSH 窗口还原/显示并拉到前台，记录**实际发生了什么**。
# 它是本项目的**验收工具**，不是产品代码。
#
# 为什么需要它：Windows 有前台锁，后台进程不保证能把窗口抢到前台。
# 但当本脚本**由协议激活启动**时，它作为被激活的进程运行、持有前台权，置顶可以成功。
# 直接手工运行时不持有该权利，所以「手工跑失败」不等于产品会失败。
#
# ## 两条硬要求（用户明确要求，已列为验收项）
#
# 1. **不得改变窗口大小。** 判据是直接比对窗口矩形（GetWindowRect），
#    而不是间接看“最大化/普通”这类状态类别。唯一的例外是**从最小化还原**：
#    那正是本功能的目的，此时应回到最小化之前记住的矩形。
# 2. **不得出现可见控制台窗口。** 启动方式必须用 conhost --headless，
#    详见 ADR 0004。
#
# ## 必须覆盖的窗口形态
#
#   normal      普通可见
#   maximized   最大化可见
#   minimized   最小化（任务栏按钮仍在）
#   hidden      完全不可见（从任务栏消失，例如关到托盘）—— 用户明确指出的场景
#
# 注意 hidden 与 minimized 是**不同**的形态：minimized 的窗口仍有任务栏按钮，
# hidden 的窗口连任务栏按钮都没有。前者用 SW_RESTORE 还原，后者需先让它可见，
# 且 SW_SHOW 会把原本最大化的窗口显示成普通大小，故必须再恢复其原形态。
#
# 注意：本文件必须保持 CRLF 换行 + UTF-8 BOM（见 .gitattributes）。
param(
  [string]$Url = '',
  [string]$LogPath = "$env:TEMP\dsh-focus-probe.log"
)

function Write-Log([string]$Message) {
  $line = "{0:yyyy-MM-dd HH:mm:ss.fff}  {1}" -f (Get-Date), $Message
  Add-Content -LiteralPath $LogPath -Value $line -Encoding utf8
}

Add-Type -Language CSharp @'
using System;
using System.Runtime.InteropServices;
public static class DshFocus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static uint PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static string RectOf(IntPtr h) {
    RECT r; if (!GetWindowRect(h, out r)) return "unavailable";
    return (r.Right - r.Left) + "x" + (r.Bottom - r.Top);
  }

  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  /// 枚举某进程的所有顶层窗口，返回其中面积最大的一个。
  ///
  /// 必须这样定位窗口：PowerShell 的 Process.MainWindowHandle 只报告**可见**的主窗口，
  /// 窗口一旦隐藏它就变成 0。实测：可见时能取到，SW_HIDE 之后同一命令返回空。
  /// 因此「按映像名取 MainWindowHandle」在 hidden 形态下会误判为“窗口已销毁”。
  public static IntPtr FindLargestWindowOf(uint targetPid) {
    IntPtr best = IntPtr.Zero;
    long bestArea = -1;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != targetPid) return true;
      if (GetWindowTextLength(h) == 0) return true;   // 跳过无标题的辅助窗口
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
'@

$SW_SHOW          = 5
$SW_SHOWMAXIMIZED = 3
$SW_RESTORE       = 9

function Get-Form([IntPtr]$h) {
  if (-not [DshFocus]::IsWindowVisible($h)) { return 'hidden' }
  if ([DshFocus]::IsIconic($h)) { return 'minimized' }
  if ([DshFocus]::IsZoomed($h)) { return 'maximized' }
  return 'normal'
}

Write-Log "=== invoked; Url='$Url' ==="

# 前置自检：确认每个要用的 P/Invoke 入口点都真的存在。
# 这条检查是被一个真实 bug 逼出来的——重写脚本时漏掉 AllowSetForegroundWindow 的
# DllImport 声明，调用处抛异常并被末尾的 catch 吞掉，只留一行日志，
# 外表表现为“探针没生效”，极难归因。宁可在这里显式失败。
$required = @(
  'GetForegroundWindow', 'IsIconic', 'IsZoomed', 'IsWindowVisible',
  'ShowWindow', 'SetForegroundWindow', 'AllowSetForegroundWindow',
  'BringWindowToTop', 'GetWindowRect', 'PidOf', 'RectOf',
  'FindLargestWindowOf', 'EnumWindows', 'GetWindowTextLength'
)
$missing = @($required | Where-Object { $null -eq [DshFocus].GetMethod($_) })
if ($missing.Count -gt 0) {
  Write-Log ("SELFCHECK FAIL: DshFocus 缺少方法: {0}" -f ($missing -join ', '))
  exit 4
}
Write-Log "selfcheck: 全部 $($required.Count) 个入口点就绪"

try {
  # 窗口定位：不能依赖 PowerShell 的 MainWindowHandle —— 它只报告**可见**的主窗口，
  # 窗口隐藏后变为 0（实测：可见时能取到，SW_HIDE 之后取不到）。用户明确要求覆盖
  # “应用从任务栏完全消失”的场景，因此必须用 EnumWindows 按进程枚举。
  # 窗口类 Chrome_WidgetWin_1 是 Chromium 通用的、标题是动态的，都不能作为目标依据。
  $procs = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
  $main = $procs | Sort-Object -Property WorkingSet64 -Descending | Select-Object -First 1
  if ($null -eq $main) {
    Write-Log 'FAIL: 找不到 DeepSeek Harness 进程'
    exit 2
  }
  $hwnd = [DshFocus]::FindLargestWindowOf([uint32]$main.Id)
  if ($hwnd -eq [IntPtr]::Zero) {
    # 主进程不一定持有窗口（Electron 的窗口可能归属另一进程），退化为全局搜索：
    # 在所有同映像名的进程里找面积最大的有标题顶层窗口。
    foreach ($p in $procs) {
      $candidate = [DshFocus]::FindLargestWindowOf([uint32]$p.Id)
      if ($candidate -ne [IntPtr]::Zero) { $hwnd = $candidate; $main = $p; break }
    }
  }
  if ($hwnd -eq [IntPtr]::Zero) {
    Write-Log 'FAIL: 未能枚举到任何有标题的顶层窗口（窗口可能已被真正销毁）'
    exit 2
  }
  $formBefore = Get-Form $hwnd
  $rectBefore = [DshFocus]::RectOf($hwnd)
  Write-Log "target pid=$($main.Id) hwnd=$hwnd title='$($main.MainWindowTitle)'"
  Write-Log "before: form=$formBefore rect=$rectBefore iconic=$([DshFocus]::IsIconic($hwnd)) zoomed=$([DshFocus]::IsZoomed($hwnd)) visible=$([DshFocus]::IsWindowVisible($hwnd)) foregroundPid=$([DshFocus]::PidOf([DshFocus]::GetForegroundWindow()))"

  # AllowSetForegroundWindow 让**其他**进程有权抢前台；对自己置顶不是必需。
  # 实测返回值不稳定（同机两次一 False 一 True 且都成功），故只记录。
  $allowed = [DshFocus]::AllowSetForegroundWindow(-1)
  Write-Log "AllowSetForegroundWindow(ASFW_ANY) = $allowed"

  # 按形态决定如何让它出现，且**必须保持原有形态与尺寸**。
  #
  # hidden 这一支是缺陷高发区：PowerShell/多数示例只用 SW_SHOW 让它出现，
  # 但 SW_SHOW 会把**原本最大化**的窗口显示成普通大小。实测正是如此
  # （1721x927 缩成 1279x671），与用户报告的现象一致。
  # 因此先让它可见，再按其原本形态恢复。
  switch ($formBefore) {
    'hidden' {
      # 隐藏不会抹掉最大化状态，IsZoomed 在隐藏时仍可读，据此恢复原形态。
      $wasZoomed = [DshFocus]::IsZoomed($hwnd)
      $r1 = [DshFocus]::ShowWindow($hwnd, $SW_SHOW)
      Write-Log "ShowWindow(SW_SHOW) = $r1   (原为不可见；隐藏前最大化=$wasZoomed)"
      Start-Sleep -Milliseconds 300
      if ($wasZoomed -and -not [DshFocus]::IsZoomed($hwnd)) {
        # SW_SHOW 把它降级成了普通大小，必须显式恢复最大化，否则尺寸会变小
        $rFix = [DshFocus]::ShowWindow($hwnd, $SW_SHOWMAXIMIZED)
        Write-Log "ShowWindow(SW_SHOWMAXIMIZED) = $rFix   (修正 SW_SHOW 造成的降级)"
      }
    }
    'minimized' {
      $r1 = [DshFocus]::ShowWindow($hwnd, $SW_RESTORE)
      Write-Log "ShowWindow(SW_RESTORE) = $r1   (原为最小化)"
    }
    'maximized' {
      $r1 = [DshFocus]::ShowWindow($hwnd, $SW_SHOWMAXIMIZED)
      Write-Log "ShowWindow(SW_SHOWMAXIMIZED) = $r1   (原为最大化，保持全屏)"
    }
    default {
      $r1 = [DshFocus]::ShowWindow($hwnd, $SW_SHOW)
      Write-Log "ShowWindow(SW_SHOW) = $r1   (原为普通可见)"
    }
  }
  Start-Sleep -Milliseconds 300

  # 置顶：BringWindowToTop 改 Z 序，SetForegroundWindow 抢前台。
  # 必须有界重试并复验——SetForegroundWindow 可能返回 True 而实际未生效，
  # 且从最小化/不可见恢复时前台归属要稍后才落定。
  $r2 = [DshFocus]::BringWindowToTop($hwnd)
  Write-Log "BringWindowToTop = $r2"

  $deadline = (Get-Date).AddMilliseconds(2000)
  $attempt = 0
  $fgPid = [DshFocus]::PidOf([DshFocus]::GetForegroundWindow())
  while ($fgPid -ne $main.Id -and (Get-Date) -lt $deadline) {
    $attempt++
    $r3 = [DshFocus]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 200
    $fgPid = [DshFocus]::PidOf([DshFocus]::GetForegroundWindow())
    Write-Log "置顶尝试 #${attempt}: SetForegroundWindow = $r3, foregroundPid = $fgPid"
  }
  Write-Log "置顶循环结束：共 $attempt 次尝试，foregroundPid = $fgPid"

  $rectAfter = [DshFocus]::RectOf($hwnd)
  $formAfter = Get-Form $hwnd
  $sizeOk = ($rectAfter -eq $rectBefore)
  Write-Log "after: form=$formAfter rect=$rectAfter foregroundPid=$fgPid"
  Write-Log "SIZE: before=$rectBefore after=$rectAfter unchanged=$sizeOk"
  Write-Log ("RESULT: form {0} -> {1}; sizeUnchanged={2}; foreground={3}" -f `
    $formBefore, $formAfter, $sizeOk, ($fgPid -eq $main.Id))

  if ($fgPid -eq $main.Id) { exit 0 }
  exit 1
}
catch {
  Write-Log ("EXCEPTION: {0}" -f $_.Exception.Message)
  exit 3
}
