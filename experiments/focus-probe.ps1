# 前台置顶探针
#
# 用途：把一个已存在的 DSH 窗口还原并拉到前台，并记录**实际发生了什么**。
# 它是本项目的**验收工具**，不是产品代码——产品侧的前台逻辑由插件自己实现，
# 但两者做的是同一件事，因此这份脚本是那条路径的对照物与诊断出口。
#
# 为什么需要它：Windows 有前台锁，后台进程不保证能把窗口抢到前台。
# 但当这个脚本**由协议激活启动**时，它作为被激活的进程运行，因而持有前台权，
# 置顶可以成功。直接手工运行时它不持有该权利，所以「手工跑失败」不等于产品会失败。
#
# 已实测（见 docs/design-progress.md）：把协议处理指向本脚本、激活该协议，
# 在一个最小化的 DSH 窗口上得到 ShowWindow/BringWindowToTop/SetForegroundWindow
# 三者皆 True，且前台进程变为 DSH 主进程。
#
# 注意：本文件必须保持 CRLF 换行（见 .gitattributes）。LF 换行会让
# Windows PowerShell 5.1 的 param(...) 块解析失败。
param(
  [string]$Url = '',
  [string]$LogPath = "$env:TEMP\dsh-focus-probe.log"
)

function Write-Log([string]$Message) {
  $line = "{0:yyyy-MM-dd HH:mm:ss.fff}  {1}" -f (Get-Date), $Message
  Add-Content -LiteralPath $LogPath -Value $line -Encoding utf8
}

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DshFocus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static uint PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
}
'@

$SW_RESTORE = 9
$ASFW_ANY = -1

Write-Log "=== invoked; Url='$Url' ==="

try {
  # 窗口定位：窗口类是 Chromium 通用的 Chrome_WidgetWin_1，标题是动态的
  # （内含当前会话/项目名），两者都不能作为稳定目标。因此按映像名找主进程，
  # 取唯一非零的 MainWindowHandle——只有主进程有主窗口。
  $procs = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
  $main = $procs | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($null -eq $main) {
    Write-Log 'FAIL: 没有任何 DeepSeek Harness 进程持有 MainWindowHandle'
    exit 2
  }

  $hwnd = [IntPtr]$main.MainWindowHandle
  Write-Log ("target pid={0} hwnd={1} title='{2}'" -f $main.Id, $hwnd, $main.MainWindowTitle)
  Write-Log ("before: iconic={0} visible={1} foregroundPid={2}" -f `
    [DshFocus]::IsIconic($hwnd), [DshFocus]::IsWindowVisible($hwnd), `
    [DshFocus]::PidOf([DshFocus]::GetForegroundWindow()))

  # AllowSetForegroundWindow 是让**其他**进程有权抢前台；对自己置顶不是必需。
  # 实测返回 False 也不影响成功，故只记录，不作为失败依据。
  $allowed = [DshFocus]::AllowSetForegroundWindow($ASFW_ANY)
  Write-Log "AllowSetForegroundWindow(ASFW_ANY) = $allowed"

  $r1 = [DshFocus]::ShowWindow($hwnd, $SW_RESTORE)
  Write-Log "ShowWindow(SW_RESTORE) = $r1"
  Start-Sleep -Milliseconds 250

  $r2 = [DshFocus]::BringWindowToTop($hwnd)
  Write-Log "BringWindowToTop = $r2"

  $r3 = [DshFocus]::SetForegroundWindow($hwnd)
  Write-Log "SetForegroundWindow = $r3"
  Start-Sleep -Milliseconds 400

  $fgPid = [DshFocus]::PidOf([DshFocus]::GetForegroundWindow())
  Write-Log ("after: iconic={0} visible={1} foregroundPid={2} (target pid={3})" -f `
    [DshFocus]::IsIconic($hwnd), [DshFocus]::IsWindowVisible($hwnd), $fgPid, $main.Id)

  if ($fgPid -eq $main.Id) {
    Write-Log 'RESULT: SUCCESS — DSH 已在前台'
    exit 0
  }
  Write-Log 'RESULT: FAIL — DSH 未在前台'
  exit 1
}
catch {
  Write-Log ("EXCEPTION: {0}" -f $_.Exception.Message)
  exit 3
}
