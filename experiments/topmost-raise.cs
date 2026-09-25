// 无焦点置顶验证（GUI 子系统，无控制台）
//
// ## 依据
//
// 微软官方 SetForegroundWindow 文档明确两点：
//   1. “An application cannot force a window to the foreground while the user is
//      working with another window. Instead, Windows flashes the taskbar button.”
//      —— 即：用户正在别的窗口里工作时，任何进程都无法强取前台焦点，这是设计行为。
//   2. 文档的官方示例把「可见地置于最上层」与「取得前台焦点」**分成两步**：
//        若窗口不可见 → SetWindowPos(HWND_TOP, SWP_SHOWWINDOW)  且**不带** SWP_NOACTIVATE
//        若窗口可见   → SetWindowPos(HWND_TOP, ... SWP_NOACTIVATE)  只抬起，不抢焦点
//        需要焦点时   → 另外再调 SetForegroundWindow
//
// 本工具只做第一件事：把窗口**可见地抬到最上层**（Z 序最前），且**不抢键盘焦点**。
// 它要回答的是：点击通知后，用户能不能看见窗口出现在 Chrome 之上。
//
// 注意：置顶后要恢复为“非最上层”，否则窗口会长期压住其他内容。
// 本工具保持最上层若干秒后自动还原，便于观察，也避免留下副作用。
//
// 注意：本文件必须保持 CRLF 换行 + UTF-8 BOM（见 .gitattributes）。

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class TopMostRaise
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
        _logPath = Path.Combine(Path.GetTempPath(), "topmost-raise.log");
        Log("=== invoked; args=[" + string.Join(" | ", args) + "] ===");

        // 找 DSH 窗口：按进程枚举，取面积最大的有标题顶层窗口。
        // 不用 MainWindowHandle：窗口隐藏时它为 0。
        var pids = new HashSet<uint>();
        foreach (var p in System.Diagnostics.Process.GetProcessesByName("DeepSeek Harness"))
            pids.Add((uint)p.Id);
        if (pids.Count == 0) { Log("FAIL: 没有 DeepSeek Harness 进程"); return 2; }

        IntPtr hwnd = Native.FindLargestWindow(pids);
        if (hwnd == IntPtr.Zero) { Log("FAIL: 未枚举到有标题的顶层窗口"); return 2; }

        Log("target hwnd=" + hwnd + " pid=" + Native.PidOf(hwnd)
            + " rect=" + Native.RectOf(hwnd)
            + " visible=" + Native.IsWindowVisible(hwnd)
            + " iconic=" + Native.IsIconic(hwnd)
            + " zoomed=" + Native.IsZoomed(hwnd));
        Log("foregroundPid(before)=" + Native.PidOf(Native.GetForegroundWindow()));

        bool wasVisible = Native.IsWindowVisible(hwnd);
        bool wasIconic = Native.IsIconic(hwnd);
        bool wasZoomed = Native.IsZoomed(hwnd);
        string rectBefore = Native.RectOf(hwnd);

        // 第一步：让它出现并保持原有形态与尺寸
        if (!wasVisible)
        {
            Native.ShowWindow(hwnd, Native.SW_SHOW);
            Thread.Sleep(350);
            if (wasZoomed && !Native.IsZoomed(hwnd)) Native.ShowWindow(hwnd, Native.SW_SHOWMAXIMIZED);
        }
        else if (wasIconic)
        {
            Native.ShowWindow(hwnd, Native.SW_RESTORE);
        }
        else if (wasZoomed)
        {
            Native.ShowWindow(hwnd, Native.SW_SHOWMAXIMIZED);
        }
        else
        {
            Native.ShowWindow(hwnd, Native.SW_SHOW);
        }
        Thread.Sleep(400);

        // 第二步：**可见地**抬到最上层，但不抢焦点（SWP_NOACTIVATE）。
        // 这是官方示例里那条“可见但无焦点”的路径，不触发前台锁。
        const uint flags = Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_SHOWWINDOW | Native.SWP_NOACTIVATE;
        bool raised = Native.SetWindowPos(hwnd, Native.HWND_TOPMOST, 0, 0, 0, 0, flags);
        Log("SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE|SWP_SHOWWINDOW) = " + raised);
        Thread.Sleep(300);
        Log("after topmost: rect=" + Native.RectOf(hwnd)
            + " foregroundPid=" + Native.PidOf(Native.GetForegroundWindow())
            + " (DSH=" + Native.PidOf(hwnd) + ")");

        // 保持可观察的一段时间，然后还原为非最上层，避免留下副作用。
        // 时长可配：默认 12 秒便于人工观察，传 --hold <秒> 覆盖。
        int holdSeconds = 12;
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], "--hold", StringComparison.OrdinalIgnoreCase))
            {
                int parsed;
                if (int.TryParse(args[i + 1], out parsed) && parsed > 0 && parsed <= 120) holdSeconds = parsed;
            }
        }
        Log("HOLD begin: 窗口将保持最上层 " + holdSeconds + " 秒 —— 请现在看屏幕");
        Thread.Sleep(holdSeconds * 1000);
        bool reverted = Native.SetWindowPos(hwnd, Native.HWND_NOTOPMOST, 0, 0, 0, 0,
            Native.SWP_NOMOVE | Native.SWP_NOSIZE);
        Log("HOLD end: SetWindowPos(HWND_NOTOPMOST) = " + reverted);

        string rectAfter = Native.RectOf(hwnd);
        Log("RESULT: visibleRaise=" + raised + " rect " + rectBefore + " -> " + rectAfter
            + " unchanged=" + (rectBefore == rectAfter));
        return raised ? 0 : 1;
    }
}

internal static class Native
{
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    public const int SW_SHOW = 5;
    public const int SW_SHOWMAXIMIZED = 3;
    public const int SW_RESTORE = 9;
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_SHOWWINDOW = 0x0040;
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int n);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static uint PidOf(IntPtr hWnd) { uint p; GetWindowThreadProcessId(hWnd, out p); return p; }

    public static string RectOf(IntPtr hWnd)
    {
        RECT r; if (!GetWindowRect(hWnd, out r)) return "unavailable";
        return (r.Right - r.Left) + "x" + (r.Bottom - r.Top);
    }

    public static IntPtr FindLargestWindow(ICollection<uint> pids)
    {
        IntPtr best = IntPtr.Zero; long bestArea = -1;
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
}
