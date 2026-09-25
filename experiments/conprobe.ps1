# 诊断：报告自身是否**被分配了控制台**，并把结果立即落盘。
#
# 为什么落盘而不是写 stdout：真实场景是协议激活（ShellExecute），
# 没有父进程接收 stdout。落盘才能跨进程读到结果。
#
# 结果含义：
#   NO_CONSOLE      = 根本没分配控制台 → 不可能闪烁（理想）
#   CONSOLE_HIDDEN  = 分配了但被隐藏   → 通常仍会闪一下
#   CONSOLE_VISIBLE = 分配且可见       → 明显弹窗

$report = Join-Path $env:TEMP 'conprobe-out.txt'

Add-Type -Language CSharp @'
using System;
using System.Runtime.InteropServices;
public static class ConInfo {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("kernel32.dll")] public static extern int GetConsoleProcessList(int[] list, int count);
  public static string Probe() {
    int[] buf = new int[8];
    int n = GetConsoleProcessList(buf, 8);
    IntPtr h = GetConsoleWindow();
    string state = h == IntPtr.Zero ? "NO_CONSOLE" : (IsWindowVisible(h) ? "CONSOLE_VISIBLE" : "CONSOLE_HIDDEN");
    return state + " hwnd=" + h + " attachedProcs=" + n;
  }
}
'@

try {
  [IO.File]::WriteAllText($report, [ConInfo]::Probe(), (New-Object Text.UTF8Encoding($false)))
} catch {
  [IO.File]::WriteAllText($report, 'PROBE_ERROR ' + $_.Exception.Message, (New-Object Text.UTF8Encoding($false)))
}
