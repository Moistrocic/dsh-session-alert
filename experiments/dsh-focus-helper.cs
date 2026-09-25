// DSH 前台置顶启动器（无控制台）
//
// ## 为什么需要它
//
// 实测结论：由 toast 按钮的协议激活拉起的 PowerShell 进程，即使
// AllowSetForegroundWindow 返回 True（拿到激活授权），SetForegroundWindow 仍然连续
// 失败，窗口无法到前台。七种手法（含 AttachThreadInput、SwitchToThisWindow、
// SetWindowPos HWND_TOPMOST）全部无效。
//
// 怀疑原因：我们经 `conhost.exe --headless` 启动，而 conhost 是**无窗口**的。
// Windows 把激活授权交给一个没有窗口的进程后，无法完成焦点转移。
//
// 另一种可能：Windows 前台锁在“用户正在别的应用里活动”时本就拒绝转移
// （实测时前台是 Chrome 里正在播放的视频）。这两种原因需要分开验证。
//
// ## 这个程序
//
// 编译成 /target:winexe（子系统为 Windows，**不分配控制台**，因此既无闪烁、
// 也没有 conhost 这一层中间进程）。它自己直接持有激活授权并拥有可操作的窗口目标，
// 用来判定「无窗口中间进程」是不是失败原因。
//
// 用法：dsh-focus.exe [--session <id>]
// 日志：%TEMP%\dsh-focus-helper.log
//
// 注意：本文件必须保持 CRLF 换行 + UTF-8 BOM（见 .gitattributes）。csc 需要 BOM
// 才能正确识别源码里的中文注释。

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class DshFocusHelper
{
    private const int SW_SHOW = 5;
    private const int SW_SHOWMAXIMIZED = 3;
    private const int SW_RESTORE = 9;

    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int n);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool AllowSetForegroundWindow(int pid);
    [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    private static string _logPath;

    private static void Log(string message)
    {
        try
        {
            File.AppendAllText(_logPath,
                DateTime.Now.ToString("HH:mm:ss.fff") + "  " + message + Environment.NewLine,
                new UTF8Encoding(false));
        }
        catch { /* 日志失败不能影响主流程 */ }
    }

    private static uint PidOf(IntPtr hWnd)
    {
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        return pid;
    }

    private static string RectOf(IntPtr hWnd)
    {
        RECT r;
        if (!GetWindowRect(hWnd, out r)) return "unavailable";
        return (r.Right - r.Left) + "x" + (r.Bottom - r.Top);
    }

    /// 在指定进程集合里找面积最大的有标题顶层窗口。
    /// 不用 Process.MainWindowHandle：它只报告可见主窗口，窗口隐藏后为 0。
    private static IntPtr FindLargestWindow(ICollection<uint> pids)
    {
        IntPtr best = IntPtr.Zero;
        long bestArea = -1;
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            uint pid = PidOf(h);
            if (!pids.Contains(pid)) return true;
            if (GetWindowTextLength(h) == 0) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
            if (area > bestArea) { bestArea = area; best = h; }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    /// 从被激活的 URL 里取出会话 id。
    ///
    /// 协议激活时 Windows 把 URL 作为**第 1 个位置参数**原样传入（实测形如
    /// `dshalert://open/?session=xxx`，且未必与注册时写的完全一致——系统会做
    /// 规范化，例如补上结尾斜杠）。因此不能只找 `--session` 这种显式开关，
    /// 必须同时能从 URL 的查询串里解析。
    private static string ParseSession(string[] args)
    {
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            if (string.Equals(a, "--session", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                return args[i + 1];

            int q = a.IndexOf("session=", StringComparison.OrdinalIgnoreCase);
            if (q < 0) continue;
            string rest = a.Substring(q + "session=".Length);
            int end = rest.IndexOfAny(new[] { '&', '#', ' ' });
            string value = end < 0 ? rest : rest.Substring(0, end);
            if (value.Length > 0) return Uri.UnescapeDataString(value);
        }
        return "";
    }

    [STAThread]
    private static int Main(string[] args)
    {
        _logPath = Path.Combine(Path.GetTempPath(), "dsh-focus-helper.log");

        string session = ParseSession(args);
        Log("rawArgs=[" + string.Join(" | ", args) + "]");

        Log("=== invoked; session='" + session + "' ===");

        // 找到 DSH 主窗口
        var pids = new HashSet<uint>();
        foreach (var p in System.Diagnostics.Process.GetProcessesByName("DeepSeek Harness"))
        {
            pids.Add((uint)p.Id);
        }
        if (pids.Count == 0) { Log("FAIL: 没有 DeepSeek Harness 进程"); return 2; }

        IntPtr hwnd = FindLargestWindow(pids);
        if (hwnd == IntPtr.Zero) { Log("FAIL: 未枚举到有标题的顶层窗口"); return 2; }

        // 会话 id 来自协议激活时系统填入的 URL 查询参数（形如 <scheme>://open/?session=xxx）。
        // 记录它，是为了证明「切到指定会话」这个增强项在参数传递上可行——后台切换
        // 会话需要把 id 交给插件，先确认它确实能送达。
        Log("sessionId='" + session + "'");

        uint targetPid = PidOf(hwnd);
        bool wasVisible = IsWindowVisible(hwnd);
        bool wasIconic = IsIconic(hwnd);
        bool wasZoomed = IsZoomed(hwnd);
        string rectBefore = RectOf(hwnd);
        Log("target pid=" + targetPid + " hwnd=" + hwnd + " rect=" + rectBefore
            + " visible=" + wasVisible + " iconic=" + wasIconic + " zoomed=" + wasZoomed);
        Log("foregroundPid(before)=" + PidOf(GetForegroundWindow()));
        Log("AllowSetForegroundWindow(ASFW_ANY)=" + AllowSetForegroundWindow(-1));

        // 让它出现，并保持原有形态与尺寸
        if (!wasVisible)
        {
            ShowWindow(hwnd, SW_SHOW);
            System.Threading.Thread.Sleep(350);
            if (wasZoomed && !IsZoomed(hwnd)) ShowWindow(hwnd, SW_SHOWMAXIMIZED);
        }
        else if (wasIconic)
        {
            ShowWindow(hwnd, SW_RESTORE);
        }
        else if (wasZoomed)
        {
            ShowWindow(hwnd, SW_SHOWMAXIMIZED);
        }
        else
        {
            ShowWindow(hwnd, SW_SHOW);
        }
        System.Threading.Thread.Sleep(400);

        // 置顶：有界重试并复验前台归属
        bool raised = false;
        for (int attempt = 1; attempt <= 8 && !raised; attempt++)
        {
            BringWindowToTop(hwnd);
            bool r = SetForegroundWindow(hwnd);
            System.Threading.Thread.Sleep(250);
            uint fg = PidOf(GetForegroundWindow());
            raised = (fg == targetPid);
            Log("  attempt " + attempt + ": SetForegroundWindow=" + r + " foregroundPid=" + fg + " inFront=" + raised);
        }

        string rectAfter = RectOf(hwnd);
        Log("RESULT: raised=" + raised + " rect " + rectBefore + " -> " + rectAfter
            + " unchanged=" + (rectBefore == rectAfter));
        return raised ? 0 : 1;
    }
}
