// dsh-session-alert 无控制台启动器
//
// ## 它做什么
//
// 通知卡片被点击后，Windows 通过自有协议方案拉起本程序（命令形如
// "<本 exe 路径>" "%1"）。本程序负责：
//
//   1. 从协议激活传入的 URL 里解析会话 id；
//   2. 用 EnumWindows 定位 DSH 主窗口；
//   3. 按窗口原形态还原它，且**保持原有尺寸**；
//   4. 用无焦点路径把它**可见地**抬到最上层，保持若干秒后复位。
//
// 退出码：
//
//   0 置顶成功
//   1 未置顶，但窗口已还原
//   2 找不到进程 / 找不到有标题的顶层窗口
//   3 异常
//   4 前置自检失败
//
// 另有一个诊断模式 `--selfcheck`：只跑前置自检并退出，**不触碰任何窗口**。
// 该模式下 0 表示自检通过、4 表示自检失败；它不参与上面的置顶语义。
//
// ## 为什么必须是编译成 GUI 子系统的 exe
//
// 以 `/target:winexe` 编译（PE Subsystem = 2）后**根本不分配控制台**，因此没有
// 命令行一闪；`-WindowStyle Hidden` 与 wscript 都只是隐藏已分配的控制台，仍会闪。
// 同时它中间没有 conhost 这一层无窗口进程。判据是进程内 `GetConsoleWindow()`
// 必须返回 NULL——本程序把它写进日志，可直接核对。
// 见 docs/adr/0004-no-console-allocation.md、docs/adr/0005-windowless-launcher-and-foreground-lock.md。
//
// ## 三处踩过坑、不能改回的做法
//
//   * 置顶只用 `SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE|...)` 这条**无焦点**路径。
//     不要改用 SetForegroundWindow 抢焦点：Windows 前台锁按设计拒绝，实测七种手法
//     （含 AttachThreadInput、SwitchToThisWindow、循环抢）全部失败。核心需求是
//     「用户能看见窗口」，这条可靠路径已经足够。
//   * 还原必须**按形态分派**。`SW_RESTORE` 会把最大化窗口缩回普通尺寸；`SW_SHOW`
//     会把隐藏的最大化窗口降级成普通大小（实测 1721x927 → 1279x671）。
//   * 窗口定位必须走 **EnumWindows**。`Process.MainWindowHandle` 只报告可见主窗口，
//     窗口隐藏时为 0，会把「从任务栏消失」误判成「窗口已销毁」。
//   * 主流程前有**前置自检**（反射校验每个 P/Invoke 入口点，再真调一次 user32 证明
//     可绑定）。漏写 DllImport 时异常曾被 catch 吞掉，外表表现为「脚本没生效」，
//     极难归因。
//
// ## 用法
//
//   dsh-session-alert.exe "<协议激活传入的 URL>" [--session <id>] [--hold <秒>]
//                         [--process <进程名>] [--selfcheck]
//
// 协议激活时 Windows 把原始 URL 作为**第 1 个位置参数**传入（实测形如
// `dsh-session-alert://open/?session=xxx`，且系统会规范化，例如补上结尾斜杠），
// 因此不能只认 `--session` 开关，必须同时能解析 URL 的查询串。
//
// 协议方案名不在这里硬编码：scripts/build-launcher.ps1 从 lib/contract.js 的
// PROTOCOL_SCHEME 读出后生成 LauncherContract.ProtocolScheme 一起编译（见下方
// `#if`）。直接编译本文件时会退回默认值，仅供临时排查使用。
//
// 日志：%TEMP%\dsh-session-alert-launcher.log（日志写入失败绝不影响主流程）。
//
// 编码硬要求：本文件必须保持 **UTF-8 BOM + CRLF**（见 .gitattributes）。
// csc 需要 BOM 才能正确识别这里的中文注释。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

/// 从 lib/contract.js 带来的契约常量。
///
/// 正式产物由构建脚本从 lib/contract.js 读出 PROTOCOL_SCHEME 生成这一部分
/// （生成文件里带 SCHEME_FROM_CONTRACT 编译符号），避免两处各写一份而漂移。
internal static partial class LauncherContract
{
#if !SCHEME_FROM_CONTRACT
    /// 兜底值：仅在直接编译本文件（未经 scripts/build-launcher.ps1）时生效。
    /// 构建脚本会核对它与 lib/contract.js 一致，不一致会在构建时报警。
    internal const string ProtocolScheme = "dsh-session-alert";
#endif

    /// 日志文件名（落在 %TEMP% 下）。
    internal const string LogFileName = "dsh-session-alert-launcher.log";
}

internal static class Launcher
{
    // ---------- 退出码 ----------
    private const int EXIT_RAISED = 0;
    private const int EXIT_NOT_RAISED_BUT_RESTORED = 1;
    private const int EXIT_NO_TARGET = 2;
    private const int EXIT_EXCEPTION = 3;
    private const int EXIT_SELFCHECK_FAILED = 4;

    // ---------- 默认参数 ----------
    /// 默认目标进程名（不带 .exe）。
    private const string DefaultProcessName = "DeepSeek Harness";

    /// 默认保持最上层的秒数：约等于一条通知横幅的存在期，够用户看见，
    /// 又不至于长期压住别的窗口。
    private const int DefaultHoldSeconds = 8;

    /// --hold 的允许范围。上限防止手误传出一个离谱的置顶时长。
    private const int MinHoldSeconds = 1;
    private const int MaxHoldSeconds = 120;

    /// 解析后的命令行。
    private sealed class Options
    {
        internal string SessionId = "";
        internal int HoldSeconds = DefaultHoldSeconds;
        internal string ProcessName = DefaultProcessName;
        internal bool SelfCheckOnly;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        LauncherLog.Init();

        // 入口参数必须逐条落日志——协议激活传进来的到底是什么，只有这里能看到。
        Log("=== invoked ===");
        Log("exe=" + SafeExePath());
        Log("protocolScheme=" + LauncherContract.ProtocolScheme);
        Log("runtime: Is64BitProcess=" + Environment.Is64BitProcess
            + " IntPtr.Size=" + IntPtr.Size + " clr=" + Environment.Version);
        Log("args(" + args.Length + ")=[" + string.Join(" | ", args) + "]");

        Options options;
        try
        {
            options = ParseArgs(args);
        }
        catch (Exception ex)
        {
            Log("FAIL: 参数解析异常: " + Describe(ex));
            return EXIT_EXCEPTION;
        }

        // 结论先行：无控制台的判据是 GetConsoleWindow() == NULL（见 ADR 0004）。
        LogConsoleState();

        // ---------- 前置自检 ----------
        // 进入主流程前显式校验所有 P/Invoke 入口点。缺一个就写日志并以 4 退出，
        // 绝不让它落进主流程的 catch 里被吞成一句含糊的「什么都没发生」。
        try
        {
            string missing = Native.DescribeMissingEntryPoints();
            if (missing.Length > 0)
            {
                Log("SELFCHECK FAIL: 缺少 P/Invoke 入口点: " + missing);
                return EXIT_SELFCHECK_FAILED;
            }

            // 反射只证明「声明在源码里」；再真调一次 user32，证明它能绑定成功。
            // IsWindowVisible(NULL) 必然返回 false，我们要的是它不抛异常。
            bool probe = Native.IsWindowVisible(IntPtr.Zero);
            Log("SELFCHECK ok: " + Native.RequiredEntryPoints.Length
                + " 个 P/Invoke 入口点就绪，绑定探针 IsWindowVisible(0)=" + probe);
        }
        catch (Exception ex)
        {
            Log("SELFCHECK FAIL: 自检本身抛异常: " + Describe(ex));
            return EXIT_SELFCHECK_FAILED;
        }

        if (options.SelfCheckOnly)
        {
            Log("SELFCHECK exit: 0（诊断模式，不触碰窗口）");
            return EXIT_RAISED;
        }

        IntPtr hwnd = IntPtr.Zero;
        try
        {
            Log("sessionId='" + options.SessionId + "'");
            Log("options: hold=" + options.HoldSeconds + "s process='" + options.ProcessName + "'");

            // ---------- 定位目标窗口 ----------
            // 不用 Process.MainWindowHandle：窗口隐藏时它为 0。
            uint[] pids = CollectPids(options.ProcessName);
            if (pids.Length == 0)
            {
                Log("FAIL: 没有找到进程 '" + options.ProcessName + "'");
                return EXIT_NO_TARGET;
            }

            WindowCandidate target = Native.FindLargestTitledWindow(pids);
            if (target == null)
            {
                Log("FAIL: 进程 '" + options.ProcessName + "' 里未枚举到有标题的顶层窗口");
                return EXIT_NO_TARGET;
            }
            hwnd = target.Hwnd;

            // ---------- 记录还原前的形态与矩形 ----------
            bool wasVisible = Native.IsWindowVisible(hwnd);
            bool wasIconic = Native.IsIconic(hwnd);
            bool wasZoomed = Native.IsZoomed(hwnd);
            string rectBefore = Native.RectOf(hwnd);

            Log("target " + target.Describe());
            Log("form before: visible=" + wasVisible + " iconic=" + wasIconic + " zoomed=" + wasZoomed);
            Log("rect before: " + rectBefore + " " + Native.PositionOf(hwnd));
            Log("foregroundPid(before)=" + Native.PidOf(Native.GetForegroundWindow())
                + " (附带观察，不作为成败依据)");

            // ---------- 还原：按形态分派，且保持尺寸 ----------
            RestoreWindow(hwnd, wasVisible, wasIconic, wasZoomed);

            // 还原是硬要求，必须复验，而不是假定 ShowWindow 一定生效。
            bool visibleAfterRestore = Native.IsWindowVisible(hwnd);
            Log("form after restore: visible=" + visibleAfterRestore
                + " iconic=" + Native.IsIconic(hwnd)
                + " zoomed=" + Native.IsZoomed(hwnd));
            string rectAfterRestore = Native.RectOf(hwnd);
            Log("rect after restore: " + rectAfterRestore + " " + Native.PositionOf(hwnd));

            // ---------- 置顶：无焦点路径 ----------
            const uint raiseFlags = Native.SWP_NOMOVE | Native.SWP_NOSIZE
                | Native.SWP_SHOWWINDOW | Native.SWP_NOACTIVATE;
            bool raised = Native.SetWindowPos(hwnd, Native.HWND_TOPMOST, 0, 0, 0, 0, raiseFlags);
            Log("SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE|SWP_NOMOVE|SWP_NOSIZE|SWP_SHOWWINDOW) = " + raised);

            // 等窗口管理器把 Z 序改动落定后再读矩形，避免拿到中间态。
            Thread.Sleep(300);
            string rectAfterRaise = Native.RectOf(hwnd);
            Log("rect after topmost: " + rectAfterRaise
                + " visible=" + Native.IsWindowVisible(hwnd)
                + " topmost=" + Native.IsTopmost(hwnd));
            Log("foregroundPid(afterTopmost)=" + Native.PidOf(Native.GetForegroundWindow())
                + " (前台锁按设计可能拒绝切换，不影响「可见地在最上层」)");

            if (!raised)
            {
                // 置顶失败不等于还原失败——两者独立判定（见 ADR 0005 第六节）。
                Log("RAISE failed: 跳过保持阶段（没有需要复位的置顶状态）");
                Log("RESULT: raised=false restored=" + visibleAfterRestore
                    + " rect " + rectBefore + " -> " + rectAfterRaise
                    + " unchanged=" + (rectBefore == rectAfterRaise));
                // 还原没有复验通过时不能报「已还原但未置顶」(1)——那正是最容易掩盖
                // 真实缺陷的情形。退出码集合里没有更贴切的码，用 3（异常/失败）。
                return visibleAfterRestore ? EXIT_NOT_RAISED_BUT_RESTORED : EXIT_EXCEPTION;
            }

            // ---------- 保持，然后复位 ----------
            Log("HOLD begin: 窗口将保持最上层 " + options.HoldSeconds + " 秒");
            Thread.Sleep(options.HoldSeconds * 1000);

            const uint revertFlags = Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE;
            bool reverted = Native.SetWindowPos(hwnd, Native.HWND_NOTOPMOST, 0, 0, 0, 0, revertFlags);
            Log("HOLD end: SetWindowPos(HWND_NOTOPMOST) = " + reverted);

            string rectAfter = Native.RectOf(hwnd);
            Log("rect final: " + rectAfter + " " + Native.PositionOf(hwnd)
                + " visible=" + Native.IsWindowVisible(hwnd)
                + " topmost=" + Native.IsTopmost(hwnd));
            // rectBefore 在最小化形态下是最小化后的矩形（实测 158x26），不是还原目标，
            // 因此单看 unchanged 会误读成「尺寸变了」。真正该守的是「还原之后的尺寸
            // 不再被后续动作改动」，即 rectAfterRestore == rectAfter。
            Log("RESULT: raised=true reverted=" + reverted
                + " rect " + rectBefore + " -> " + rectAfter
                + " unchanged=" + (rectBefore == rectAfter)
                + " rectAfterRestore=" + rectAfterRestore
                + " sizeStableAfterRestore=" + (rectAfterRestore == rectAfter));
            return EXIT_RAISED;
        }
        catch (Exception ex)
        {
            Log("EXCEPTION: " + Describe(ex));
            return EXIT_EXCEPTION;
        }
    }

    // =====================================================================
    // 还原
    // =====================================================================

    /// 按窗口**原形态**让它可见，并保持原有尺寸。
    ///
    /// 形态之间的差别是实测出来的，不能合并成一次 `SW_SHOW`：
    ///   * 最小化 → `SW_RESTORE`
    ///   * 最大化 → `SW_SHOWMAXIMIZED`
    ///   * 普通   → `SW_SHOW`
    ///   * 不可见 → 先 `SW_SHOW`；若隐藏前是最大化，`SW_SHOW` 会把它降级成普通大小
    ///     （实测 1721x927 → 1279x671），必须再补一次 `SW_SHOWMAXIMIZED` 修正。
    ///
    /// 注意 `ShowWindow` 的返回值语义是「窗口**此前是否可见**」，不是「调用是否成功」：
    /// 对隐藏窗口调 `SW_SHOW` 返回 False 是预期值，不代表还原失败。
    ///
    /// 另外补了「不可见且最小化」这个组合：任务描述只按单形态分派，而
    /// `SW_SHOW` 对最小化的窗口只是把它摆回任务栏，用户仍然看不见，需再 `SW_RESTORE`。
    /// 这一支不改动上面四种已实测形态的结果。
    private static void RestoreWindow(IntPtr hwnd, bool wasVisible, bool wasIconic, bool wasZoomed)
    {
        if (!wasVisible)
        {
            // ShowWindow 的返回值是「窗口**此前是否可见**」，不是「调用是否成功」：
            // 对隐藏窗口调 SW_SHOW 返回 False 是预期值。
            bool shown = Native.ShowWindow(hwnd, Native.SW_SHOW);
            Log("ShowWindow(SW_SHOW) = " + shown + "   (原为不可见；隐藏前 maximized="
                + wasZoomed + " minimized=" + wasIconic + ")");
            Thread.Sleep(350);

            if (wasIconic && Native.IsIconic(hwnd))
            {
                bool restored = Native.ShowWindow(hwnd, Native.SW_RESTORE);
                Log("ShowWindow(SW_RESTORE) = " + restored + "   (原为不可见+最小化)");
                Thread.Sleep(350);
            }

            if (wasZoomed && !Native.IsZoomed(hwnd))
            {
                // SW_SHOW 把它降级成了普通大小，必须显式恢复最大化，否则尺寸会变小。
                bool fixedUp = Native.ShowWindow(hwnd, Native.SW_SHOWMAXIMIZED);
                Log("ShowWindow(SW_SHOWMAXIMIZED) = " + fixedUp + "   (修正 SW_SHOW 造成的最大化降级)");
                Thread.Sleep(350);
            }
            return;
        }

        if (wasIconic)
        {
            bool restored = Native.ShowWindow(hwnd, Native.SW_RESTORE);
            Log("ShowWindow(SW_RESTORE) = " + restored + "   (原为最小化)");
            Thread.Sleep(400);
            return;
        }

        if (wasZoomed)
        {
            bool shown = Native.ShowWindow(hwnd, Native.SW_SHOWMAXIMIZED);
            Log("ShowWindow(SW_SHOWMAXIMIZED) = " + shown + "   (原为最大化，保持全屏)");
            Thread.Sleep(400);
            return;
        }

        bool normal = Native.ShowWindow(hwnd, Native.SW_SHOW);
        Log("ShowWindow(SW_SHOW) = " + normal + "   (原为普通可见)");
        Thread.Sleep(400);
    }

    // =====================================================================
    // 参数与进程
    // =====================================================================

    /// 解析命令行。
    ///
    /// 会话 id 有两个来源，按「显式开关优先」处理：
    ///   1. `--session <id>`；
    ///   2. 协议激活传入的 URL 查询串（形如 `.../open/?session=xxx`，系统会规范化，
    ///      例如补上结尾斜杠），逐个参数扫描，取第一个 `session=` 命中。
    private static Options ParseArgs(string[] args)
    {
        Options o = new Options();
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            if (a == null) continue;

            if (string.Equals(a, "--session", StringComparison.OrdinalIgnoreCase))
            {
                if (i + 1 < args.Length)
                {
                    o.SessionId = args[i + 1];
                    i++;
                }
                continue;
            }

            if (string.Equals(a, "--hold", StringComparison.OrdinalIgnoreCase))
            {
                if (i + 1 < args.Length)
                {
                    int parsed;
                    if (int.TryParse(args[i + 1], NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed))
                    {
                        if (parsed < MinHoldSeconds) parsed = MinHoldSeconds;
                        if (parsed > MaxHoldSeconds) parsed = MaxHoldSeconds;
                        o.HoldSeconds = parsed;
                    }
                    else
                    {
                        Log("WARN: --hold 的值不是整数，用默认值 " + DefaultHoldSeconds + "s: '" + args[i + 1] + "'");
                    }
                    i++;
                }
                continue;
            }

            if (string.Equals(a, "--process", StringComparison.OrdinalIgnoreCase))
            {
                if (i + 1 < args.Length && args[i + 1].Length > 0)
                {
                    o.ProcessName = args[i + 1];
                    i++;
                }
                continue;
            }

            if (string.Equals(a, "--selfcheck", StringComparison.OrdinalIgnoreCase))
            {
                o.SelfCheckOnly = true;
                continue;
            }

            // URL 形态：从查询串里取 session=<id>。
            if (o.SessionId.Length == 0)
            {
                string fromUrl = SessionFromUrl(a);
                if (fromUrl.Length > 0) o.SessionId = fromUrl;
            }
        }
        return o;
    }

    /// 从协议激活传入的 URL（或任意含查询串的参数）里取出会话 id。
    /// 取不到就返回空串——会话 id 只用于日志与将来的「切到指定会话」，不是必需项。
    private static string SessionFromUrl(string arg)
    {
        int q = arg.IndexOf("session=", StringComparison.OrdinalIgnoreCase);
        if (q < 0) return "";
        string rest = arg.Substring(q + "session=".Length);
        int end = rest.IndexOfAny(new char[] { '&', '#', ' ', '?' });
        string value = end < 0 ? rest : rest.Substring(0, end);
        if (value.Length == 0) return "";
        try
        {
            return Uri.UnescapeDataString(value);
        }
        catch (Exception)
        {
            // 百分号编码非法时按原样使用，绝不因为一个装饰性的 id 让主流程失败。
            return value;
        }
    }

    /// 收集同名进程的所有 pid。
    ///
    /// 取**全部**同名进程而不是某一个进程的主窗口：Electron 的窗口未必挂在主进程上，
    /// 实测 DSH 就有多个同名进程。窗口归属靠 EnumWindows 判定。
    private static uint[] CollectPids(string processName)
    {
        Process[] processes = Process.GetProcessesByName(processName);
        List<uint> pids = new List<uint>();
        for (int i = 0; i < processes.Length; i++)
        {
            try
            {
                uint pid = (uint)processes[i].Id;
                if (!pids.Contains(pid)) pids.Add(pid);
            }
            catch (Exception)
            {
                // 进程可能在枚举与取值之间退出，忽略即可。
            }
            finally
            {
                processes[i].Dispose();
            }
        }
        return pids.ToArray();
    }

    // =====================================================================
    // 日志与诊断
    // =====================================================================

    private static void Log(string message)
    {
        LauncherLog.Write(message);
    }

    /// 记录控制台状态。ADR 0004 的判据就在这里：GUI 子系统下必须是 NULL。
    private static void LogConsoleState()
    {
        try
        {
            IntPtr console = Native.GetConsoleWindow();
            if (console == IntPtr.Zero)
            {
                Log("console: GetConsoleWindow()=0  => NO_CONSOLE（未分配控制台）");
            }
            else
            {
                Log("console: GetConsoleWindow()=0x" + console.ToInt64().ToString("X")
                    + "  => CONSOLE_ALLOCATED（不合格：子系统不是 Windows GUI？）");
            }
        }
        catch (Exception ex)
        {
            Log("console: 探测失败: " + Describe(ex));
        }
    }

    private static string SafeExePath()
    {
        try
        {
            return Assembly.GetExecutingAssembly().Location;
        }
        catch (Exception)
        {
            return "(未知)";
        }
    }

    private static string Describe(Exception ex)
    {
        Exception inner = ex;
        StringBuilder sb = new StringBuilder();
        while (inner != null)
        {
            if (sb.Length > 0) sb.Append(" <- ");
            sb.Append(inner.GetType().Name).Append(": ").Append(inner.Message);
            inner = inner.InnerException;
        }
        return sb.ToString();
    }
}

/// 一个候选顶层窗口。
internal sealed class WindowCandidate
{
    internal IntPtr Hwnd;
    internal uint Pid;
    internal long Area;
    internal string Title = "";

    internal string Describe()
    {
        return "hwnd=0x" + Hwnd.ToInt64().ToString("X")
            + " pid=" + Pid
            + " area=" + Area
            + " title='" + Title + "'";
    }
}

/// 所有 Win32 入口点与窗口查询的封装。
///
/// 每个入口点都必须在这里有一个 `[DllImport]` 声明——漏写时调用处会抛异常，
/// 若被 catch 吞掉就只剩「什么都没发生」。因此 `RequiredEntryPoints` 把本类真正
/// 依赖的名字列全，由反射在每次启动时核对。
internal static class Native
{
    // ---------- ShowWindow 命令 ----------
    internal const int SW_SHOWMAXIMIZED = 3;
    internal const int SW_SHOW = 5;
    internal const int SW_RESTORE = 9;

    // ---------- SetWindowPos 标志 ----------
    internal const uint SWP_NOSIZE = 0x0001;
    internal const uint SWP_NOMOVE = 0x0002;
    internal const uint SWP_NOACTIVATE = 0x0010;
    internal const uint SWP_SHOWWINDOW = 0x0040;
    internal static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    internal static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);

    // ---------- GetWindowLong 索引与位 ----------
    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TOPMOST = 0x00000008;

    /// 写日志用的标题长度上限，避免一条超长标题把日志刷满。
    private const int TitleLimit = 120;

    internal delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    internal static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    internal static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    internal static extern bool IsZoomed(IntPtr hWnd);

    [DllImport("user32.dll")]
    internal static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
        int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    internal static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    internal static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    internal static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    // 32/64 位两个入口点都声明：64 位系统上 user32 导出 GetWindowLongPtrW，
    // 32 位系统上不存在该导出（C 里它是宏），因此只在 IntPtr.Size == 8 时调用它。
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    private static extern int GetWindowLong32(IntPtr hWnd, int nIndex);

    [DllImport("kernel32.dll")]
    internal static extern IntPtr GetConsoleWindow();

    [StructLayout(LayoutKind.Sequential)]
    internal struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    /// 前置自检要核对的入口点清单：本类真正调用的每一个 P/Invoke 都在这里。
    internal static readonly string[] RequiredEntryPoints = new string[]
    {
        "EnumWindows",
        "IsWindowVisible",
        "IsIconic",
        "IsZoomed",
        "ShowWindow",
        "SetWindowPos",
        "GetWindowTextLength",
        "GetWindowText",
        "GetWindowRect",
        "GetForegroundWindow",
        "GetWindowThreadProcessId",
        "GetWindowLongPtr64",
        "GetWindowLong32",
        "GetConsoleWindow",
    };

    // =====================================================================
    // 前置自检
    // =====================================================================

    /// 反射校验每个入口点存在、是方法、且真的带 `DllImport` 特性（含非空库名）。
    /// 返回缺失项的说明串；全部就绪时返回空串。
    internal static string DescribeMissingEntryPoints()
    {
        List<string> problems = new List<string>();
        Type t = typeof(Native);

        for (int i = 0; i < RequiredEntryPoints.Length; i++)
        {
            string name = RequiredEntryPoints[i];
            MethodInfo mi = t.GetMethod(name,
                BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public);
            if (mi == null)
            {
                problems.Add(name + "(未声明)");
                continue;
            }

            object[] attrs = mi.GetCustomAttributes(typeof(DllImportAttribute), false);
            if (attrs.Length == 0)
            {
                problems.Add(name + "(缺少 [DllImport])");
                continue;
            }

            DllImportAttribute dll = (DllImportAttribute)attrs[0];
            if (dll.Value == null || dll.Value.Length == 0)
            {
                problems.Add(name + "([DllImport] 未指定库名)");
            }
        }

        // 委托类型也要存在，否则 EnumWindows 无法调用。
        if (t.GetNestedType("EnumWindowsProc", BindingFlags.Public | BindingFlags.NonPublic) == null)
        {
            problems.Add("EnumWindowsProc(委托类型缺失)");
        }

        return string.Join(", ", problems.ToArray());
    }

    // =====================================================================
    // 窗口查询
    // =====================================================================

    internal static uint PidOf(IntPtr hWnd)
    {
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        return pid;
    }

    internal static string RectOf(IntPtr hWnd)
    {
        RECT r;
        if (!GetWindowRect(hWnd, out r)) return "unavailable";
        return (r.Right - r.Left) + "x" + (r.Bottom - r.Top);
    }

    internal static string PositionOf(IntPtr hWnd)
    {
        RECT r;
        if (!GetWindowRect(hWnd, out r)) return "at(?)";
        return "at(" + r.Left + "," + r.Top + ")";
    }

    /// 是否处于最上层（读扩展样式里的 WS_EX_TOPMOST）。
    /// 只用于日志复验：决定成败的是 SetWindowPos 的返回值。
    internal static bool IsTopmost(IntPtr hWnd)
    {
        try
        {
            if (IntPtr.Size == 8)
            {
                long v = GetWindowLongPtr64(hWnd, GWL_EXSTYLE).ToInt64();
                return (v & WS_EX_TOPMOST) != 0;
            }
            int v32 = GetWindowLong32(hWnd, GWL_EXSTYLE);
            return (v32 & WS_EX_TOPMOST) != 0;
        }
        catch (Exception)
        {
            return false;
        }
    }

    internal static string TitleOf(IntPtr hWnd)
    {
        int len = GetWindowTextLength(hWnd);
        if (len <= 0) return "";
        StringBuilder sb = new StringBuilder(len + 2);
        int copied = GetWindowText(hWnd, sb, sb.Capacity);
        if (copied <= 0) return "";
        string title = sb.ToString();
        if (title.Length > TitleLimit) title = title.Substring(0, TitleLimit) + "…";
        return title;
    }

    /// 在给定 pid 集合里找面积最大的**有标题**顶层窗口。
    ///
    /// 为什么不能用 `Process.MainWindowHandle`：它只报告可见主窗口，窗口隐藏时为 0，
    /// 会把「从任务栏消失」误判成「窗口已销毁」——而「完全隐藏」正是要覆盖的场景。
    internal static WindowCandidate FindLargestTitledWindow(uint[] pids)
    {
        List<WindowCandidate> candidates = new List<WindowCandidate>();
        EnumWindowsProc callback = delegate(IntPtr h, IntPtr l)
        {
            uint pid = PidOf(h);
            bool match = false;
            for (int i = 0; i < pids.Length; i++)
            {
                if (pids[i] == pid) { match = true; break; }
            }
            if (!match) return true;

            if (GetWindowTextLength(h) == 0) return true;   // 跳过无标题的辅助窗口

            RECT r;
            if (!GetWindowRect(h, out r)) return true;

            WindowCandidate c = new WindowCandidate();
            c.Hwnd = h;
            c.Pid = pid;
            c.Area = (long)(r.Right - r.Left) * (long)(r.Bottom - r.Top);
            c.Title = TitleOf(h);
            candidates.Add(c);
            return true;
        };

        EnumWindows(callback, IntPtr.Zero);

        WindowCandidate best = null;
        for (int i = 0; i < candidates.Count; i++)
        {
            if (best == null || candidates[i].Area > best.Area) best = candidates[i];
        }

        // 候选清单值得留档：定位错了窗口时，这是唯一能看出「为什么选中它」的证据。
        LauncherLog.Write("candidates(" + candidates.Count + "):");
        for (int i = 0; i < candidates.Count && i < 12; i++)
        {
            LauncherLog.Write("  [" + i + "] " + candidates[i].Describe()
                + " visible=" + IsWindowVisible(candidates[i].Hwnd)
                + " iconic=" + IsIconic(candidates[i].Hwnd)
                + " zoomed=" + IsZoomed(candidates[i].Hwnd));
        }

        return best;
    }
}

/// 诊断日志。
///
/// 唯一职责是把一行行文字追加到 `%TEMP%\dsh-session-alert-launcher.log`，
/// 并且**任何失败都不许冒泡**——日志是诊断手段，绝不能成为主流程的失败原因
/// （文件被占用、目录不可写、磁盘满，都应静默跳过）。
internal static class LauncherLog
{
    /// 日志超过这个大小就在下次写入时截断，避免无界增长。
    private const long RolloverBytes = 512 * 1024;

    private static string _path;

    /// 本进程 pid。每行都带上它，因为协议激活可能被连续触发多次（用户连点几条通知），
    /// 多实例的日志会交错在同一份文件里，没有 pid 就无法把行归属回具体一次调用。
    private static int _pid;

    internal static void Init()
    {
        try
        {
            _path = Path.Combine(Path.GetTempPath(), LauncherContract.LogFileName);
            _pid = Process.GetCurrentProcess().Id;
        }
        catch (Exception)
        {
            _path = null;
        }
    }

    internal static void Write(string message)
    {
        try
        {
            if (_path == null) Init();
            if (_path == null) return;

            FileInfo info = new FileInfo(_path);
            if (info.Exists && info.Length > RolloverBytes)
            {
                File.Delete(_path);
            }

            // 用显式 FileStream + FileShare.ReadWrite 追加，而不是 File.AppendAllText：
            // 后者只共享读，另一个实例同时写就会让整行被静默丢弃（实测遇到过——并发
            // 触发时日志缺行），而诊断日志的价值全在「不缺行」。
            string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff")
                + "  [" + _pid + "]  " + message + Environment.NewLine;
            using (FileStream stream = new FileStream(_path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
            using (StreamWriter writer = new StreamWriter(stream, new UTF8Encoding(false)))
            {
                writer.Write(line);
            }
        }
        catch (Exception)
        {
            // 故意忽略。
        }
    }
}
