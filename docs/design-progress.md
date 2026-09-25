# 设计进度 — dsh-session-alert

本次设计访谈的持续记录。词汇表见 [`CONTEXT.md`](../CONTEXT.md)，决定见
[`docs/adr/`](./adr/)。本文记录**已定、未定、以及已被实证**的东西。

> `legacy/` 目录（v1 源码副本与旧配置）**不入 git**，见 [`.gitignore`](../.gitignore)。
> 因此本文不引用 v1 的行号——凡是值得留下的实现知识都已经提炼成本文的结论，
> 并将在 v2 源码注释中重新落地。

## 状态

设计访谈的前沿已走空。剩余未定项均为**细节**（见文末），不再阻塞开工。

---

## 一、已被实验证明的事实

在本机、本次会话中实际跑出来的：

- **Windows 通知链端到端可用。** 对 v1 源码执行 `node scripts/selftest.mjs --toast`
  返回 `{"ok":true,"code":0,"note":"toast (DSH Session Alert)"}`。退出码 `0` 表示这次
  投递用的是**插件自己的 AUMID**，而非借用 PowerShell 的身份；该结论通过回读
  操作中心历史得到，不是靠「API 没抛异常」。用户亦独立确认横幅出现，标题为
  `DSH Session Alert`。
- **支撑条件均已就位：**
  - AUMID `DSH Session Alert` 已注册，且**两处都在**——HKCU 的
    `AppUserModelId` 键（`DisplayName`、`ShowInSettings=1`、`IconUri`），
    以及开始菜单快捷方式
    `%APPDATA%\Microsoft\Windows\Start Menu\Programs\DSH Session Alert.lnk`。
  - `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` 存在。
  - Node 24.19.0、pnpm 11.21.0、git 2.47.1 可用。
- **v1 的离线策略测试全部通过**：限流、合并、去重、场景开关、总开关、占位符替换、
  转义、时长钳制。

### 投递链的关键实现知识（必须带进 v2）

这些是 v1 已经踩过的坑，属于本次最有价值的资产：

1. **必须用 PowerShell 5.1，不能用 `pwsh`。** PowerShell 7 里
   `[Windows.UI.Notifications.ToastNotificationManager, ..., ContentType=WindowsRuntime]`
   会抛 `Unable to find type`——.NET 5 移除了内置的 WinRT 类型投影，且 PowerShell
   团队已按「Resolved-By-Design」关闭该议题。
2. **脚本必须用 `-EncodedCommand` 传，编码是 UTF-16LE 的 base64。** 这是唯一能
   无损穿过中文标题与正文的参数通道，无需任何编码往返。
3. **`Show()` 什么也不返回，所以投递必须「验证」而不是「假定」。** 具体做法是发送
   后回读操作中心的 action center history；命中才认为平台接受了这条 toast。
4. **AUMID 决定是否真的上屏。** 未注册的 AUMID 是合法发送者，但 toast 会被接受
   到操作中心却**不显示横幅**——所以「API 没抛异常」什么也不能证明。发送者由
   **注册状态**选择，而不是靠乐观：自有 AUMID 未注册时借用 Windows PowerShell 的
   AUMID 兜底。
5. **`scenario="urgent"` 是 Windows 唯一会留在屏幕上直到用户关闭的 toast 形态**
   （用于「常驻」模式）；`duration="long"` 是可申请的最长横幅。
6. **降级顺序**：自有 AUMID toast → PowerShell AUMID toast → 托盘气泡
   （`NotifyIcon.ShowBalloonTip`）。脚本用退出码汇报实际走通的是哪条路径。
7. **`spawn` 必须用 `stdio: 'ignore'`**（配合 `windowsHide: true`）。DSH 沙箱会阻止
   Node 的 `child_process` 使用**管道 stdio**（命名管道限制 → EPERM），而
   `'ignore'` 绕过它。
8. **操作中心持久化需要一次 HKCU 写入**：给该 AUMID 建
   `...\Notifications\Settings\<aumid>` 键并写 `ShowInActionCenter=1`。Win32 AUMID
   的 toast 在应用获得焦点后就会从操作中心消失，除非显式开启。
9. **注入风险**：绝不能把标题/正文拼进命令行字符串。用 `-EncodedCommand`；脚本内
   构造 XML 时用 `CreateTextNode`，不拼 XML 字符串。

---

## 二、v1 插件的状态

v1（`github:Moistrocic/dsh-session-alert`，用户本人所写，自评「不好用」）：

- **装在 `profiles/web`，但在那里被 `disabled: true` 禁用**（profile patch 中）。
- **从未装进 `profiles/desktop`**——而用户实际在用的正是 desktop。所以它**根本
  不可能在需要的地方响**。这很可能是「不好用」的首要原因，而非代码缺陷。
- 它自己的文档写着「审批策略为 `ask` 时会阻塞」，而当前策略已是 `never`。

处理方式：v1 将被卸载；源码副本与旧配置放在 `legacy/`（不入库）；v2 **扩展而非
重写**——保留上面那条已经淬炼过的投递链，重做结构与 UI。

---

## 三、已定的决定

### 宣告什么

| # | 决定 |
| --- | --- |
| 1 | Attention Event 由四类上游事实触发：一轮结束、一轮出错、工具等待授权、Agent 提出结构化提问。 |
| 2 | 仅**根会话**可产生 Attention Event；服务性会话保持沉默。 |
| 3 | **等待授权**场景保留并默认启用（含批准/拒绝控件），尽管当前策略为 `never`、尚不会触发。 |

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
| 25 | 在本工作区开发，沿用原名 `dsh-session-alert`；v1 卸载。 |
| 26 | **先装 `profiles/desktop`**；desktop 验收通过后再装 `profiles/web`。 |
| 27 | v1 **扩展而非重写**：保留已淬炼的投递链，重做结构与 UI。 |

### 验收标准

| # | 决定 |
| --- | --- |
| 28 | 验收 = **真实场景端到端**（在 desktop profile 里让一个真实会话跑到真实停止点并看到卡片）**＋** 离线单元测试 **＋** **刻意演练整条降级链**（注销 AUMID → 确认回退到 PowerShell 身份 → 确认回退到托盘气泡）**＋** 每一个模板变量与每一项设置逐条验证。 |

---

## 四、由取证解决的可行性问题：卡片点击与会话切换

在应用 bundle 内查证。**「先置顶、切会话当增强项」这个分期是对的，但原因与预期
不同：会话切换根本不是 DSH 的深度链接能力——它只能在应用内部触达，而那正是本插件
客户端半边所在的位置。**

- **`dsh://` 只认两个字符串，完全不解析。** 唯一的处理器是
  `if (url === "dsh://open" || url === "dsh://open/") focusPrimaryWindow();`
  没有 host、path、query 解析；整个 117 MB 归档里字面量 `dsh://` 只出现一次。
  **而且在 Windows 上这个处理器根本不触发**——`open-url` 在 Electron 里仅限 macOS
  ——所以 `dsh:` 链接的载荷在 Windows 上是死数据。
- **置顶仍然可行，靠的是副作用。** `dsh:` 已在操作系统注册为启动该应用；应用持有
  单实例锁（`claimDesktopSingleInstance`），所以第二次启动会立刻退出，而已运行实例
  的 `second-instance` 处理器执行 `focusPrimaryWindow()`，其内容是
  「最小化则 `restore()` → `show()` → `focus()`」。
  - 必须尊重的边界情况：`if (window === mainWindow && !enteredWorkspace) return;`
    ——冷启动、尚未进入工作区时，这次置顶会被静默跳过。
  - Windows 前台锁依然生效，而 DSH 不帮忙：它只在 macOS 调
    `app.focus({steal:true})`，只在带 `--updated` 参数时才调 `window.moveTop()`。
- **切换到指定会话无法从应用外部触发。** 没有按会话寻址的深度链接，没有入站 IPC，
  没有 CLI 开关，DSH 自己没有 AUMID。**但原语存在，且是客户端半边服务**：
  `uiWorkspace.openSession(target)`，签名注明「选中一个 Session 并展示其对话，作为
  一个 UI 导航动作」，`target` 接受 `SessionId`。它的调用者全是客户端半边。
- **所以这个增强项是我们自己实现，不是等 DSH 提供。** 客户端半边既然已在上报端别，
  Host 就可以在同一通道回话「显示会话 X」，由客户端半边执行切换。**须注意**：动态
  插件通道是**浏览器→Host 单向**的，没有 Host→浏览器的推送，所以客户端必须轮询，
  或依托已同步的 store 状态。
- **若要「可靠置顶」，有办法。** toast 动作若使用 `activationType="protocol"`，
  被激活的进程就是我们自己的处理器；因此再注册一个自有协议方案、命令指向我们自己的
  脚本，该脚本就能在仍持有激活权时调用 `AllowSetForegroundWindow` +
  `ShowWindow(SW_RESTORE)` + `SetForegroundWindow`。`dsh://open` 提供的是较弱的
  间接路径，但免费。
- **窗口定位事实：** 窗口类是 `Chrome_WidgetWin_1`（Chromium 通用），标题是动态的
  （内含当前会话/项目名），二者都不是稳定目标——应按映像名找到主进程，取唯一非零的
  `MainWindowHandle`。
- **DSH 自己没有 AUMID，本插件已经拥有了 toast 身份**（`DSH Session Alert`）。每一条
  toast 都是我们发的。

---

## 五、未定

均为细节，不阻塞开工：

- **模板预览的示例值**从哪来（固定假数据 / 取最近一个真实会话 / 二者可切）。
- **卡片点击用哪种激活**：`dsh://open`（免费、已注册、受前台锁限制，可能只闪任务栏）
  还是再注册一个自有协议方案（需一次性写 HKCU，但置顶可靠）。
- **审批场景的冷却策略**：四类信号都接且带冷却，但审批卡片带按钮——多条审批被合并
  到一张卡片时，按钮该绑定哪一个请求。相关约束已在 ADR 0003 写明（决定必须绑定到
  恰好一个请求，过期卡片 fail closed）。
- **审批答复路径的落地方式**：客户端半边的 `host.call` 是浏览器→Host 单向，Host 若
  要请桌面卡片上的按钮落定，需要一条可达路径（轮询 / 同步 store / 其他）。

---

## 六、我在本次访谈中修正过的推论

记录于此，以免被后续读者当成从没发生过：

1. **ADR 0001 最初把端别当作「目的地」选择器**，并推出「两端各弹一份、跨端不去重」。
   在用户确定 **web 端也由 Host 发 Windows 通知**之后，这条推论失效——同一条通道、
   同一个通知中心，各弹一份就是重复噪音。用户随即明确：**只弹一条，取带按钮的
   desktop 卡片。** 我保留的是原则（两种端别是不同产物），推翻的是我推错的那一步。
2. **我一度判断 `profiles\web` 里那份 v1 已损坏**（以为 `lib/`、`scripts/` 是空目录）。
   那是 PowerShell 输出被截断导致的误读，实际文件齐全。已纠正。
3. **我曾把「识别 web / desktop」当作主要未知。** 实际上 DSH 自己的前端就用
   `document.documentElement.dataset.platform` 判断端别，本插件沿用同一判据即可。
