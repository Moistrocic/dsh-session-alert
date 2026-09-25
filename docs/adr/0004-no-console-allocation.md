# ADR 0004 — 任何进程启动都必须不分配控制台

状态：已接受

## 背景

插件需要在两处启动进程：

1. **发通知**时，spawn 一个短命的 PowerShell 去调 WinRT toast API。
2. **卡片被点击**时，由协议激活启动一个脚本去置顶 DSH 窗口。

用户报告：切换窗口时会弹出一个命令行界面，虽然很快关闭，但很难看。

这类「一闪而过」的黑窗是 Windows 上加载外部帮助程序的经典缺陷。它不只是观感问题——
一个每分钟可能触发多次的通知插件，如果每次都闪一下窗，它本身就成了干扰源，而这与插件
存在的目的直接矛盾。

## 决定

**凡是插件启动的进程，都不允许分配控制台窗口。** 判据不是「窗口被隐藏」，而是
**根本没有控制台**。隐藏是不合格的：窗口已经存在并出现过，只是随后被藏起来。

**验收判据：被启动的进程内 `GetConsoleWindow()` 必须返回 `NULL`。**

### 实测依据

在**真实协议激活路径**下（ShellExecute 从零启动，无父控制台——在本 shell 里直接调用会
因子进程继承父控制台而掩盖差异），四种启动方式的结果：

| 启动方式 | 子进程看到的控制台 | 判定 |
| --- | --- | --- |
| `powershell.exe -WindowStyle Hidden` | `CONSOLE_HIDDEN`，`hwnd≠0` | **不合格** —— 分配了控制台，只是隐藏 |
| `powershell.exe`（无 `-WindowStyle`） | `CONSOLE_VISIBLE` | 明显弹窗 |
| **`conhost.exe --headless powershell.exe …`** | **`NO_CONSOLE`，`hwnd=0`** | **合格** |
| `wscript.exe` 启动器（窗口样式 0） | `CONSOLE_HIDDEN`，`hwnd≠0` | **不合格** —— 同样分配了控制台 |

两个反直觉的结论值得记住：

- **`-WindowStyle Hidden` 不是无闪烁方案。** 它隐藏的是已经分配出来的控制台，用户仍会
  看到它一闪。这正是本次用户报告的现象。
- **wscript 启动器同样不合格。** 这是流传很广的「零窗口启动」偏方，但实测它只是隐藏，
  并未避免分配。

### 两条路径各自的落地方式

- **通知路径无需改动，但必须保持不变。** 用 Node 的 `child_process.spawn`，配
  `stdio: 'ignore'` 与 `windowsHide: true`，实测得到 `NO_CONSOLE`。这也是为什么此处的
  `stdio` **绝不能改成管道**——不仅因为沙箱会拦（命名管道限制 → EPERM），也因为
  `'ignore'` 正是控制台不被分配的原因之一。
- **协议激活路径必须用 `conhost.exe --headless`。**

## 后果

- 协议处理程序的命令行必须是
  `conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script> …`，
  而不是直接调 `powershell.exe -WindowStyle Hidden`。
- **`conhost.exe` 是 Windows 10 1809+ 才有的。** 更早的系统上 `conhost --headless`
  不存在，需要探测后降级到 `-WindowStyle Hidden`（接受一闪）。这个降级是已知的观感损失，
  不是错误。
- 「不分配控制台」成为一条**贯穿性的启动约束**，适用于将来新增的任何帮助进程，而不只是
  上面这两处。
- 该判据是可自动化的：探针脚本调用 `GetConsoleWindow()` 并落盘，因此可以纳入验收，
  而不必靠肉眼盯着屏幕捕捉一闪。

## 考虑过的替代方案

- **`powershell.exe -WindowStyle Hidden`。** 已否决，实测不合格：控制台仍被分配。
- **`wscript.exe` 启动器。** 已否决，实测不合格：同上，且引入一个额外脚本文件。
- **把脚本编译成无控制台的 exe。** 已否决：为一个观感问题引入构建步骤与二进制产物，
  与「插件是一个 npm 包」的形态不符。
- **接受一闪，认为它无害。** 已否决：对通知插件而言，「不打扰」是核心目标之一，
  告警机制自身不该成为打扰来源。
