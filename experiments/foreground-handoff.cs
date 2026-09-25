// 前台授权转交演示（GUI 子系统，无控制台）
//
// ## 要验证的假设
//
// 实测：点击 toast 按钮时，Windows 把**激活授权**给了被激活的进程（我们的启动器），
// 但 DSH 是另一个进程，授权不会自动转移，因此启动器直接调 SetForegroundWindow
// 会连续失败（日志实录连续 8 次 False）。
//
// 用户提出的方案是「由 DSH 侧完成前台切换」。其技术前提是：
// 启动器能把激活授权**转交**给 DSH 进程，再由 DSH 自己置前。
//
// 这正是 AllowSetForegroundWindow(pid) 的用途——它把「允许设置前台窗口」的权利
// 授予指定进程。本演示工具就是把这一步单独拿出来验证：
//
//   1. 找到 DSH 主进程；
//   2. 记录 AllowSetForegroundWindow(DSH pid) 的返回值；
//   3. 通过信号文件通知 DSH 侧（真实实现里由插件承担这一角色）。
//
// 本工具不做置顶——置顶应由持有授权的那一方（DSH 侧）执行。它只回答
// 「授权转交这一步能不能做、返回值是什么」。
//
// 注意：本文件必须保持 CRLF 换行 + UTF-8 BOM（见 .gitattributes）。

using System;
using System.IO;
using System.Text;

internal static class ForegroundHandoff
{
    private static string _logPath;

    private static void Log(string message)
    {
        try
        {
            File.AppendAllText(_logPath,
                DateTime.Now.ToString("HH:mm:ss.fff") + "  " + message + Environment.NewLine,
                new UTF8Encoding(false));
        }
        catch { }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        _logPath = Path.Combine(Path.GetTempPath(), "foreground-handoff.log");
        Log("=== invoked; args=[" + string.Join(" | ", args) + "] ===");

        // 找 DSH 主进程：取有窗口的那个（Electron 会起多个同映像名进程）
        System.Diagnostics.Process target = null;
        foreach (var p in System.Diagnostics.Process.GetProcessesByName("DeepSeek Harness"))
        {
            try
            {
                if (p.MainWindowHandle != IntPtr.Zero) { target = p; break; }
            }
            catch { }
        }
        if (target == null)
        {
            // MainWindowHandle 在窗口隐藏时为 0，退化为取工作集最大的那个
            long best = -1;
            foreach (var p in System.Diagnostics.Process.GetProcessesByName("DeepSeek Harness"))
            {
                try { if (p.WorkingSet64 > best) { best = p.WorkingSet64; target = p; } }
                catch { }
            }
        }
        if (target == null) { Log("FAIL: 找不到 DeepSeek Harness 进程"); return 2; }

        Log("target dsh pid=" + target.Id);

        // 授权转交：这一步是用户方案的技术核心
        bool handed = Native.AllowSetForegroundWindow(target.Id);
        Log("AllowSetForegroundWindow(dsh pid=" + target.Id + ") = " + handed);

        // 通知 DSH 侧：真实实现里这里换成插件的 IPC；演示用信号文件。
        string signal = Path.Combine(Path.GetTempPath(), "dsh-foreground-request.json");
        string payload = "{\"requestedAt\":\"" + DateTime.Now.ToString("o") + "\","
                       + "\"dshPid\":" + target.Id + ","
                       + "\"allowSetForegroundWindow\":" + (handed ? "true" : "false") + ","
                       + "\"args\":\"" + string.Join(" ", args).Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"}";
        try
        {
            File.WriteAllText(signal, payload, new UTF8Encoding(false));
            Log("signal written: " + signal);
        }
        catch (Exception ex)
        {
            Log("FAIL writing signal: " + ex.Message);
            return 3;
        }

        Log("RESULT: handed=" + handed);
        return handed ? 0 : 1;
    }
}

internal static class Native
{
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    internal static extern bool AllowSetForegroundWindow(int dwProcessId);
}
