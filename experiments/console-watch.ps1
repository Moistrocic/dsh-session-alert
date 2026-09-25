# 可见控制台窗口监视器
#
# 目的：捕捉屏幕上**真正出现过**的控制台窗口，并指出是哪个程序启动的。
# 它直接测量用户肉眼看到的现象（一个可见的控制台类顶层窗口闪现），
# 因此不依赖安全日志审计策略，也不需要管理员权限。
#
# 为什么不用「监视 conhost.exe 进程」：即使 stdio 全部 ignore、窗口完全不可见，
# 子进程仍可能附带一个 conhost，所以「有 conhost」并不等于「用户看到了窗口」。
# 监视窗口可见性才是对的判据。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File console-watch.ps1 -Seconds 120
#
# 输出：逐条打印被捕捉到的可见控制台窗口，含窗口标题、所属进程名与命令行。

param(
  [int]$Seconds = 120,
  [int]$PollMs = 100,
  [string]$LogPath = ''
)

Add-Type -Language CSharp @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class WinWatch {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

  /// 当前所有「可见的」控制台类顶层窗口：hwnd -> 标题。
  public static Dictionary<IntPtr, string> VisibleConsoleWindows() {
    var found = new Dictionary<IntPtr, string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var cls = new StringBuilder(256);
      GetClassName(h, cls, 256);
      string c = cls.ToString();
      if (c == "ConsoleWindowClass" || c == "CASCADIA_HOSTING_WINDOW_CLASS" || c == "PseudoConsoleWindow") {
        var title = new StringBuilder(512);
        GetWindowText(h, title, 512);
        found[h] = title.ToString();
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static uint PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
}
'@

# 一次取回全部进程，避免逐进程查询拖慢轮询——一闪只有几十毫秒，慢一轮就漏掉。
function Get-ProcessMap {
  $map = @{}
  foreach ($proc in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) {
    $map[[uint32]$proc.ProcessId] = $proc
  }
  return $map
}

function Format-Cmd([string]$cmd, [int]$max = 150) {
  if (-not $cmd) { return '' }
  if ($cmd.Length -le $max) { return $cmd }
  return $cmd.Substring(0, $max) + ' …'
}

Write-Host "监视可见控制台窗口，持续 $Seconds 秒。期间请照常操作。" -ForegroundColor Cyan
Write-Host '（只报告**新出现且可见**的控制台窗口；隐藏的不计入）'
Write-Host ''

$seen = New-Object 'System.Collections.Generic.HashSet[IntPtr]'
foreach ($h in [WinWatch]::VisibleConsoleWindows().Keys) { [void]$seen.Add($h) }
Write-Host "启动时已有 $($seen.Count) 个可见控制台窗口（计入基线，不再报告）。`n"

$deadline = (Get-Date).AddSeconds($Seconds)
$hits = 0
$procMap = Get-ProcessMap

while ((Get-Date) -lt $deadline) {
  $now = [WinWatch]::VisibleConsoleWindows()
  foreach ($h in @($now.Keys)) {
    if ($seen.Contains($h)) { continue }
    [void]$seen.Add($h)
    $hits++

    $ownerPid = [WinWatch]::PidOf($h)
    # 进程表是循环前取的快照；新出现的窗口所属进程通常不在其中，故按需刷新。
    if (-not $procMap.ContainsKey([uint32]$ownerPid)) { $procMap = Get-ProcessMap }
    $info = $procMap[[uint32]$ownerPid]
    $stamp = (Get-Date).ToString('HH:mm:ss.fff')

    Write-Host "[$stamp] 捕捉到可见控制台窗口" -ForegroundColor Yellow
    Write-Host "    标题   : $($now[$h])"
    # 机器可读的一行记录，供自动化测试按时间区间把命中归属到具体测试用例。
    if ($LogPath -ne '') {
      $tick = (Get-Date).ToString('o')
      $owner = if ($null -ne $info) { $info.Name } else { '(已退出)' }
      Add-Content -LiteralPath $LogPath -Encoding utf8 -Value "$tick`tHIT`t$owner`t$($now[$h])"
    }
    if ($null -ne $info) {
      Write-Host "    进程   : $($info.Name)  (PID $ownerPid)"
      $parentPid = $info.ParentProcessId
      $parent = $procMap[[uint32]$parentPid]
      $parentName = if ($null -ne $parent) { $parent.Name } else { '?' }
      Write-Host "    父进程 : $parentName  (PID $parentPid)"
      Write-Host "    命令行 : $(Format-Cmd $info.CommandLine)"
    } else {
      Write-Host "    进程   : (PID $ownerPid，已退出；可能是极短命进程)"
    }
    Write-Host ''
  }
  Start-Sleep -Milliseconds $PollMs
}

Write-Host "监视结束。共捕捉到 $hits 个新出现的可见控制台窗口。" -ForegroundColor Cyan
if ($hits -eq 0) { Write-Host '（这段时间内没有可见控制台窗口出现）' -ForegroundColor Green }
