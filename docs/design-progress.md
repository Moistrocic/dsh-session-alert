# 设计进度 — dsh-session-alert

本次设计访谈的持续记录。词汇表见 [`CONTEXT.md`](../CONTEXT.md)，决定见
[`docs/adr/`](./adr/)。本文记录**已定、未定、以及已被验证**的东西。

> **关于验证口径：** 本文只陈述**任何人都能在本机复现**的事实。
> 凡是结论，要么附上验证命令，要么注明它是「既有实现中已确立、尚待重新验证」。
> 本文不引用任何读者拿不到的源码、仓库或历史版本。

## 状态

设计访谈的前沿已走空。剩余未定项均为**细节**（见文末），不阻塞开工。

---

## 一、已在本机验证的事实

以下均在本次会话中实际执行过：

- **Windows 通知链端到端可用。** 用 PowerShell 5.1 的 WinRT
  `ToastNotificationManager` 发出一条 toast，返回**退出码 0**——该码表示投递用的是
  自有 AUMID（`DSH Session Alert`），而非借用 Windows PowerShell 的身份。**用户亦
  独立确认横幅出现**，标题为 `DSH Session Alert`。
  > 注意：这个退出码的语义是既有投递脚本自己定义的，**重新实现时需要保持同一约定**，
  > 否则该验证信号失效。
- **AUMID `DSH Session Alert` 已注册，且两处都在：**
  - HKCU 的 `AppUserModelId` 键（`DisplayName`、`ShowInSettings=1`、`IconUri`）；
  - 开始菜单快捷方式
    `%APPDATA%\Microsoft\Windows\Start Menu\Programs\DSH Session Alert.lnk`。

  复现：检查该 `.lnk` 是否存在，以及
  `HKCU:\SOFTWARE\Classes\AppUserModelId\DSH Session Alert` 是否存在。
- **PowerShell 5.1 存在**：`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`。
- **工具链：** Node 24.19.0、pnpm 11.21.0、git 2.47.1。
- **环境里留有一份旧配置** `~/.dsh/dsh-session-alert/config.json`（上一次尝试的残留），
  含标题、声音开关、限流参数与四类消息模板。v2 需要决定是迁移还是弃用。

---

## 二、投递链的关键实现知识

这些是本次设计中最有价值的资产。它们的来源是既有实现，**尚未在 v2 中重新验证**；
标注「须验证」的项要求在实现阶段逐条实测。

| # | 结论 | 验证方式 |
| --- | --- | --- |
| 1 | **必须用 PowerShell 5.1，不能用 `pwsh`。** PowerShell 7 里 `[Windows.UI.Notifications.ToastNotificationManager, ..., ContentType=WindowsRuntime]` 会抛 `Unable to find type`——.NET 5 移除了内置的 WinRT 类型投影。 | 须验证：在 pwsh 7 与 5.1 各跑一次同一段脚本 |
| 2 | **脚本用 `-EncodedCommand` 传，编码为 UTF-16LE 的 base64。** 这是唯一能无损穿过中文标题与正文的参数通道。 | 须验证：发一条含中文的 toast |
| 3 | **`Show()` 无返回值，所以投递必须「验证」而非「假定」。** 做法是发送后回读操作中心历史，命中才认为平台接受了这条 toast。 | 须验证：故意发一条非法 AUMID，确认历史回读能区分成功与失败 |
| 4 | **AUMID 决定是否真的上屏。** 未注册的 AUMID 是合法发送者，但 toast 会被接受进操作中心却**不显示横幅**——所以「API 没抛异常」什么也不能证明。发送者应由**注册状态**选择：自有 AUMID 可用就用它，否则借用 Windows PowerShell 的 AUMID 兜底。 | 须验证（也是验收项）：临时注销自有 AUMID，确认回退生效 |
| 5 | **`scenario="urgent"` 是 Windows 唯一会让 toast 留在屏幕上直到用户关闭的形态**（对应「常驻」模式）；`duration="long"` 是可申请的最长横幅。 | 须验证：分别发「常驻」与「10 秒」两条，观察差异 |
| 6 | **降级顺序：** 自有 AUMID toast → PowerShell AUMID toast → 托盘气泡（`NotifyIcon.ShowBalloonTip`）。脚本用**退出码**汇报实际走通的是哪条路径。 | 须验证（验收项）：逐级制造失败，确认降级发生 |
| 7 | **`spawn` 必须用 `stdio: 'ignore'`**（配合 `windowsHide: true`）。 | 须验证：确认管道 stdio 在本沙箱下确实失败、`'ignore'` 确实可用 |
| 8 | **操作中心持久化需要一次 HKCU 写入：** 建 `...\Notifications\Settings\<aumid>` 键并写 `ShowInActionCenter=1`。否则 Win32 AUMID 的 toast 在应用获得焦点后就会从操作中心消失。 | 须验证：写入前后各发一条，检查通知中心 |
| 9 | **注入风险：绝不能把标题/正文拼进命令行字符串。** 必须用 `-EncodedCommand`；脚本内构造 XML 时用 `CreateTextNode`，不拼 XML 字符串。 | 须验证：标题里放引号与 `<b>`，确认安全且显示正确 |
| 10 | **任何进程启动都不得分配控制台**，判据是 `GetConsoleWindow()` 返回 `NULL`，而不是「窗口被隐藏」。通知路径的 `stdio:'ignore'` + `windowsHide:true` 实测已满足；协议激活路径必须用 `conhost.exe --headless`。 | 已实测，见 [ADR 0004](./adr/0004-no-console-allocation.md) |
| 11 | **`.ps1` 必须带 UTF-8 BOM。** Windows PowerShell 5.1 读取**无 BOM** 的 `.ps1` 时按 ANSI 解码（中文系统即 GBK），脚本内中文变乱码，进而破坏引号配对、报出与真实原因无关的语法错误。 | 已实测：无 BOM 时报 `Missing '=' operator after key in hash literal`，加 BOM 后正常 |
| 12 | **`.ps1` 必须用 CRLF 换行。** LF 会让 PowerShell 5.1 的 `param(...)` 块解析失败，报 `Unexpected token ')'`。 | 已实测：同一脚本 LF 换行报错，CRLF 正常 |

> 第 10–12 条都是**静态约束**，不是运行时逻辑：违反它们的代码不会在单测里失败，只会在真实
> 机器上以难以归因的方式表现（闪窗、乱码、莫名语法错误）。因此已写进 `.gitattributes`
> 并应作为代码审查检查项。

---

## 三、开工的起点状态

- 本工作区为**空白起点**，只有设计文档，尚无代码。
- 环境里残留着上一次尝试的产物，开工时需先清理，否则会出现两个同功能插件互相干扰：
  - `profiles/web` 里装有一个同名的通知插件，且**被 `disabled: true` 禁用**；
  - `profiles/desktop`（实际使用的 GUI）里**从未装过**任何通知插件；
  - `~/.dsh/dsh-session-alert/config.json` 旧配置。
- **这解释了「收不到通知」的真实原因：插件装在了没被使用的 profile 里，而且在那里
  还被禁用了。** 因此 v2 的一条硬要求是：**必须装进实际在用的 profile**，并且要在那里
  验证，而不是在网上能搜到的地方验证。
- v2 **沿用名称 `dsh-session-alert`**。为平滑起见，重新实现时应保持 AUMID 名称不变
  （`DSH Session Alert`），因为它已在系统注册，换名会导致横幅重新回到「借用
  PowerShell 身份」的状态。

---

## 四、已定的决定

### 宣告什么

| # | 决定 |
| --- | --- |
| 1 | Attention Event 由四类上游事实触发：一轮结束、一轮出错、工具等待授权、Agent 提出结构化提问。 |
| 2 | 仅**根会话**可产生 Attention Event；服务性会话保持沉默。 |
| 3 | **等待授权**场景保留并默认启用（含批准/拒绝控件），尽管当前审批策略为 `never`、尚不会触发。 |

### 告知谁、怎么告知

| # | 决定 | 记录 |
| --- | --- | --- |
| 4 | 端别由**客户端自报**确定，绝不由 Host 环境推断。 | [ADR 0001](./adr/0001-client-kind-and-announcement-shape.md) |
| 5 | **两种端别的通知都由 Host 发出**。端别决定宣告的**形状**，不决定目的地。 | ADR 0001 |
| 6 | **一个 Attention Event 永远只发一条宣告。** 有 `desktop`（无论是否同时有 `web`）→ 可点击带控件的完整卡片；仅有 `web` 或都没有 → 无控件的 web 形态。 | ADR 0001 |
| 7 | 保住能力边界的保证：为**仅 web 受众**发出的卡片**绝不能携带控件**。 | ADR 0001 |
| 8 | 客户端缺席**永不**压掉宣告。 | ADR 0001 |
| 9 | 批准/拒绝**代用户把决定提交给 DSH**；过期卡片 fail closed；沉默绝不是同意。 | [ADR 0003](./adr/0003-approval-controls-answer-on-the-users-behalf.md) |

### desktop 卡片

| # | 决定 | 记录 |
| --- | --- | --- |
| 10 | **点击卡片** = 把 DSH 窗口提到前台 + 切换到该会话。跳转不占用按钮。 | [ADR 0002](./adr/0002-card-interaction-model.md) |
| 11 | **分阶段**：第一阶段只做「提到前台」；「切换到指定会话」作为增强项。 | ADR 0002 |
| 12 | 普通卡片**只有一个确认按钮**，仅用于确认收到，**刻意不跳转**。 | ADR 0002 |
| 13 | 审批卡片**没有**确认按钮，改为**批准** / **拒绝**。 | ADR 0002 |

### 抑制、焦点、提示音

| # | 决定 |
| --- | --- |
| 14 | 抑制**仅限 desktop 端**，web 端完全没有。 |
| 15 | 抑制开启且不在焦点 → 发通知。抑制开启且在焦点 → **扣下卡片，但仍响提示音**。抑制关闭 → 通知与提示音都发。 |
| 16 | 抑制**默认开启**。 |
| 17 | **焦点**的定义：**DSH 窗口是前台窗口**——不是「可见」，也不是「未最小化」。 |
| 18 | 焦点由**客户端侧**检测（页面自身的 focus/blur 信号），上报给 Host。 |
| 19 | 提示音**两者都支持**：Windows 系统声音事件，以及用户自备的音频文件；默认用系统声音。 |

### 内容与配置

| # | 决定 |
| --- | --- |
| 20 | 内容是**通知模板**，由字面文本与变量组成；用户控制哪些变量出现、以什么顺序出现。 |
| 21 | 编辑器是**按事件类型分组的完整可视化编辑器**，配一个**切换器**选择正在编辑哪套模板。 |
| 22 | 模板默认顺序：**工作区名 → 会话名 → 事件类型**。 |
| 23 | 设置放在 **DSH 设置页的一张卡片**里。 |

### 范围与交付

| # | 决定 |
| --- | --- |
| 24 | **仅 Windows**，不考虑 Linux 及其他平台。 |
| 25 | 在本工作区开发，沿用名称 `dsh-session-alert`。 |
| 26 | **先装 `profiles/desktop`**；desktop 验收通过后再装 `profiles/web`。 |
| 27 | 投递链**沿用既有实现中已确立的做法**（见第二节），结构与 UI 重做。 |

### 验收标准

| # | 决定 |
| --- | --- |
| 28 | 验收 = **真实场景端到端**（在 desktop profile 里让一个真实会话跑到真实停止点并看到卡片）**＋** 离线单元测试 **＋** **刻意演练整条降级链**（注销 AUMID → 确认回退到 PowerShell 身份 → 确认回退到托盘气泡）**＋** 每一个模板变量与每一项设置逐条验证 **＋** **跳转不得改变窗口原有的显示状态**（最大化仍是最大化、最小化被正确还原）**＋** **任何进程启动都不得分配可见控制台**（见 [ADR 0004](./adr/0004-no-console-allocation.md)）。 |

> 后两项是**由实测缺陷反推出来的验收项**，不是凭空加的：闪窗与「全屏变窗口」都是用户
> 实际报告并已定位的问题，因此它们必须进入验收，否则修好了也可能再退化回去。

---

## 五、已解决的两个技术未知

### 5.1 端别怎么识别

**DSH 自己的前端就用一个 DOM 标记判断端别**，本插件沿用同一判据即可，共四个可用信号，
按可靠性排序：

1. `document.documentElement.dataset.platform` —— **仅 desktop 端存在**（Windows 上值为
   `win32`）。DSH 前端正是用它推出 `runtime: "desktop" | "web"`。
2. `'dshDesktop' in globalThis`
3. `location.protocol === 'dsh-app:'`
4. `document.documentElement.hasAttribute('data-windows-titlebar')`

另外两条约束：

- **`dsh.client.platform: "web"` 不能用来区分端别** —— desktop 应用是一个跑在 Electron
  外壳里的 web 平台客户端，声明 `platform: "web"` 的包在两个 profile 里都装。
- **客户端半边拿不到 Node 或 Electron**：渲染进程是 `nodeIntegration: false` +
  `contextIsolation: true`，且 preload 暴露的表面里没有任何通知通道。因此**交互式
  toast 不可能由客户端半边发出**，必须由 Host 半边发。

### 5.2 卡片点击与会话切换

- **`dsh://` 只认两个字符串，完全不解析参数。** 唯一的处理器是
  `if (url === "dsh://open" || url === "dsh://open/") focusPrimaryWindow();`。
  整个归档里字面量 `dsh://` 只出现一次。**而且在 Windows 上该处理器根本不触发**
  —— `open-url` 在 Electron 里仅限 macOS —— 所以链接载荷在 Windows 上是死数据。
- **切换到指定会话无法从应用外部触发。** 没有按会话寻址的深度链接，没有入站 IPC，
  没有 CLI 开关，DSH 自己没有 AUMID。
- **但原语存在，且是客户端半边服务：** `uiWorkspace.openSession(target)`，签名注明
  「选中一个 Session 并展示其对话，作为一个 UI 导航动作」，`target` 接受 `SessionId`。
  它的调用者全是客户端半边。
- **所以这个增强项由我们自己实现，不是等 DSH 提供。** 客户端半边既然已在上报端别，
  Host 就可以在同一通道回话「显示会话 X」，由客户端半边执行切换。**须注意**：动态插件
  通道是**浏览器→Host 单向**的，没有 Host→浏览器的推送，所以客户端必须轮询，或依托
  已同步的 store 状态。
- **窗口定位事实：** 窗口类是 `Chrome_WidgetWin_1`（Chromium 通用），标题是动态的
  （内含当前会话/项目名），二者都不是稳定目标——应按映像名找到主进程，取唯一非零的
  `MainWindowHandle`。

复现方式：在 `resources/app.asar` 上直接 grep（该文件可按文本读取）以下字面量：
`setAsDefaultProtocolClient("dsh")`、`dsh://open`、`requestSingleInstanceLock`、
`second-instance`、`uiWorkspace`。

### 5.3 置顶由谁来做：实测结论（推翻了原计划）

**原计划是让卡片点击指向 `dsh://open`，寄望于应用自己把窗口拉起来。实测不成立。**

做了三组实验，全部可复现：

| 实验 | 操作 | 结果 |
| --- | --- | --- |
| A | 最小化 DSH → `Start-Process 'dsh://open'` | **失败**：窗口仍最小化，进程数不变（第二实例启动后立刻退出） |
| B | 最小化 DSH → 直接启动 `DeepSeek Harness.exe`（不带 URL） | **失败**：窗口仍最小化，进程数不变 |
| C | 最小化 DSH → 激活一个把处理程序指向**我们自己的 PowerShell 脚本**的协议 | **成功**：`ShowWindow(SW_RESTORE)`、`BringWindowToTop`、`SetForegroundWindow` 三者皆 `True`，前台进程变为 DSH 主进程 |

实验 B 是关键：**连不带 URL 的直接启动也拉不起窗口**，说明问题不在协议，而在应用自身
——它那条「第二次启动就还原并聚焦窗口」的路径在当前状态下没有生效（源码里有一处
「尚未进入工作区则直接返回」的守卫，是可疑原因，但未进一步归因）。既然实验 A 与 B
结论一致，**A 之所以失败就不是测试方法的问题，而是结论本身**。

实验 C 证明了一件更有用的事：**由协议激活启动的脚本持有前台权**，因此它能真正置顶。
（附带观察：`AllowSetForegroundWindow(ASFW_ANY)` 的返回值在两次运行中一次 `False`
一次 `True`，而**两次都成功**——所以它不是成功的前提，不应作为前置条件依赖。）

**据此推荐：卡片点击指向一个自有协议方案，命令指向我们自己的脚本，由脚本还原并置顶
DSH 窗口**——而不是依赖 `dsh://open` 让应用自己爬起来。

代价与约束：

- 需要一次性写 HKCU 注册该协议方案（无需管理员）。
- 需要一个常驻的隐藏进程或短命脚本；本实验用的是短命脚本。
- **命令行必须用 `conhost.exe --headless` 启动**，否则每次点击都会闪一个命令行窗口。
  `-WindowStyle Hidden` 与 `wscript` 启动器经实测都不合格（仍会分配控制台），
  详见 [ADR 0004](./adr/0004-no-console-allocation.md)。这是用户实际报告的问题，
  已实测定位并给出可用方案。
- **一个无法用程序验证的缺口**：我点不了 toast 上的按钮，所以「toast 按钮的
  `activationType="protocol"` 是否会走与实验 C 相同的 ShellExecute 路径」**只能由人工
  点击确认**。这一点已列入验收标准。

探针脚本见 [`experiments/focus-probe.ps1`](../experiments/focus-probe.ps1)，
控制台判据见 [`experiments/conprobe.ps1`](../experiments/conprobe.ps1) 与
[`experiments/launch-methods.ps1`](../experiments/launch-methods.ps1)，
均可在验收时直接复用。

---

## 六、弹出流程：两条流程 + 置顶归属，均已实测收敛

用户把验收范围收窄为**两条流程**（最小化→前台、完全隐藏→前台），其余现象都是这两条的
故障表现。测试：[`experiments/popup-two-flows.ps1`](../experiments/popup-two-flows.ps1)。

| 流程 | 基准尺寸 | 实际尺寸 | 尺寸未变 | 命令行闪烁 |
| --- | --- | --- | --- | --- |
| 1 最小化 → 弹出 | 1721x927 | 1721x927 | ✅ | 0 |
| 2 完全隐藏 → 弹出 | 1721x927 | 1721x927 | ✅ | 0 |

连续三次运行结果一致。**还原是硬要求，已达成。**

### 按钮链路的实测结论

用 [`experiments/toast-button-check.ps1`](../experiments/toast-button-check.ps1) 与
[`experiments/click-probe.ps1`](../experiments/click-probe.ps1) 验证：

| 环节 | 结论 |
| --- | --- |
| 通知能弹出（含按钮） | ✅ |
| 点击按钮 → 协议激活 → 处理程序被拉起 | ✅ 实测点击后 2 秒内到达 |
| URL 参数完整送达（可用于「切到指定会话」） | ✅ 日志实录 `Url=dshclicktest://open/` |

复现提示：每轮验证后会清理协议方案，**通知中心里的旧通知按钮因此会变成死链**。若点击
「没反应」，先确认点的是当轮新弹出的那条通知。

### 前台锁：一个必须如实呈现的限制

**置顶是尽力而为，失败不是缺陷。** 实测（同一 helper、同一窗口状态，唯一变量是「DSH
是否为最近使用的应用」）：

| 条件 | `SetForegroundWindow` | 结果 |
| --- | --- | --- |
| 用户正在别的程序里活动 | 连续 8 次 `False` | 前台不切换 |
| DSH 是最近使用的应用 | 第 1 次即 `True` | 置顶成功 |

这是 Windows 前台锁的**设计行为**（实测场景：用户在 Chrome 里看视频），目的是不打断
用户当前正在做的事。七种手法实测**全部无效**：直调 `SetForegroundWindow`、
`AllowSetForegroundWindow` 后再调、先最小化再还原、
`SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE)`、`BringWindowToTop` 循环、
`AttachThreadInput`（返回 `False`）、`SwitchToThisWindow`。

**关键区分：还原与置顶是两件事。** 前台锁拒绝切换时，窗口仍然被正确还原。把两者混成
一个结论会掩盖真实缺陷。

### 投递方式改为无控制台的外部启动器

由 `conhost --headless` 包住 PowerShell 虽解决了控制台分配，却引入一个无窗口的中间进程。
改为一个编译成 **GUI 子系统**（PE Subsystem = 2）的 C# 启动器：
[`experiments/dsh-focus-helper.cs`](../experiments/dsh-focus-helper.cs)。
它以 `/target:winexe` 编译，既不分配控制台、也没有 conhost 中间层，且不需要
`-EncodedCommand` 这类绕参数编码的机制。安装时一次性编译，随包分发。

详见 [ADR 0005](./adr/0005-windowless-launcher-and-foreground-lock.md)。

### 过程中定位到的真实缺陷（都已修）

1. **`SW_RESTORE` 会把最大化窗口缩小** —— 它的语义是「还原」，对最大化窗口调用会缩回
   最大化之前的普通尺寸。应按形态分派。
2. **`SW_SHOW` 会把隐藏的最大化窗口降级成普通大小**（实测 1721x927 → 1279x671）。
   隐藏不会抹掉最大化状态，需先显示、再按原形态修正。
3. **`Process.MainWindowHandle` 在窗口隐藏时为 0** —— 它只报告可见主窗口。用户明确要求
   覆盖「应用从任务栏完全消失」，而这一定位方式会把该场景误判为「窗口已销毁」。
   改用 `EnumWindows` 按进程枚举。

### 测试自身踩过的坑（都已修，值得记住）

- **两套占位符索引混用**：协议激活的 `%1`（系统填 URL）与 PowerShell `-f` 的 `{0}`
  是两回事，混用会让参数一直是字面量。
- **窗口形态转换是异步且有竞态的**：对齐形态必须**重试动作本身**；用例之间还必须彻底
  复位到已知可见状态，否则残留形态会污染后续结论。为此加了**前置条件检查**——探针必须
  报告出预期形态，否则该用例结论作废。
- **被 `catch` 吞掉的异常极难归因**：漏写一个 `DllImport` 声明时，调用处抛出的异常被
  末尾 `catch` 吞掉只留一行日志，外表表现为「脚本没生效」。**这个 bug 咬了两次**，因此
  现在每个这类脚本都有**前置自检**，显式校验全部入口点存在，缺失即报错退出。
- **`$pid` 是只读自动变量**；**`$attempt:` 与 `$scheme://` 中的 `:` 会被当成驱动器限定
  变量名**，需写成 `${attempt}` / `${scheme}`。这两处都实际踩到。
- **控制台窗口关闭是异步的**：测量窗口之间必须留足排空时间，否则上一个用例正在关闭的
  窗口会被计入下一个用例，造成计数漂移。
- **`csc` 需要 BOM** 才能正确识别源码里的中文，与 `.ps1` 同理。

---

## 七、未定

均为细节，不阻塞开工：

- **模板预览的示例值**从哪来（固定假数据 / 取最近一个真实会话 / 二者可切）。
- **审批场景的冷却策略**：四类信号都接且带冷却，但审批卡片带按钮——多条审批被合并到
  一张卡片时，按钮该绑定哪一个请求。相关约束已在 ADR 0003 写明（决定必须绑定到恰好
  一个请求，过期卡片 fail closed）。
- **审批答复路径的落地方式**：客户端半边的 `host.call` 是浏览器→Host 单向，Host 若要
  请桌面卡片上的按钮落定，需要一条可达路径（轮询 / 同步 store / 其他）。
- **旧配置 `~/.dsh/dsh-session-alert/config.json` 是迁移还是弃用。**
- **自有协议方案的名称**（实验用的是临时名 `dshalertprobe`，产品需要一个正式名）。

**已不再未定：** 卡片点击用哪种激活。见 5.3——`dsh://open` 经实测不成立，改为自有协议
方案 + 自有脚本置顶。

---

## 八、本次访谈中修正过的推论

记录于此，以免后续读者以为从没发生过：

1. **ADR 0001 最初把端别当作「目的地」选择器**，并推出「两端各弹一份、跨端不去重」。
   在确定 **web 端也由 Host 发 Windows 通知**之后，这条推论失效——同一条通道、同一个
   通知中心，各弹一份就是重复噪音。用户随即明确：**只弹一条，取带按钮的 desktop
   卡片。** 我保留的是原则（两种端别是不同产物），推翻的是我推错的那一步。
2. **我一度判断环境里已安装的同名插件已损坏**（以为 `lib/`、`scripts/` 是空目录）。
   那是 PowerShell 输出被截断导致的误读，实际文件齐全。已纠正。
3. **我曾把「识别 web / desktop」当作主要未知。** 实际上 DSH 自己的前端就用
   `document.documentElement.dataset.platform` 判断端别，沿用同一判据即可。
