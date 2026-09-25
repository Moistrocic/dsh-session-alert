# dsh-session-alert

DSH 的会话提醒插件：**当一轮会话结束、或 Agent 卡在需要你出手的地方时，给你发一条 Windows 通知** —— 这样你可以离开电脑，等它叫你。

Windows 专用。桌面端与 web 端共用同一份实现，但**卡片上的能力不同**：

| 端别 | 卡片上的控件 | 为什么 |
| --- | --- | --- |
| 桌面端（`desktop` profile） | 审批 3 个按钮；其余 1 个 | 有窗口可跳转，审批也能直接作答 |
| web 端（`web` profile） | **没有按钮** | 浏览器里没有可跳转的桌面窗口；给一个点了没反应的按钮，等于承诺做不到的事 |

## 什么时候会通知

| 场景 | 触发时机 | 默认显示时长 |
| --- | --- | --- |
| **轮次结束** | DSH 回复完一轮并转入空闲，等你给出下一步指令 | 30 秒 |
| **等待回答** | Agent 通过提问工具询问，必须由你作答才能继续 | 常驻 |
| **等待授权** | Agent 请求批准一次工具调用（审批策略为 `ask` 时阻塞在这里） | 常驻 |
| **执行出错** | 某个步骤 / 轮次失败，或会话本身失败 | 常驻 |

**这些情况不会打扰你：**

- **你手动打断了会话**（点了停止）—— 依据 DSH 持久日志里 `turn/end` 的结束原因判断，`aborted` / `interrupted` 一律不通知；工具报错与轮次失败仍然通知。
- **子代理内部的轮次结束** —— 默认只提醒主会话。
- **限流窗口内超出的提醒** —— 默认合并成一条稍后发出，不会丢。
- **你正看着桌面端窗口** —— 默认不弹卡片（铃声照响）；这条只对桌面端生效。

## 通知长什么样

一张卡片自上而下是这样的：

```
Deepseek Harness                      ← ① 应用名：Windows 按 AUMID 的显示名渲染，就是「通知署名」
（同步成功时不再重复写标题行）          ← ② 省略，避免同一句话出现两次
对齐桌面版继续未完成任务 等待你的授权：工具 pwsh   ← ③ 正文：由场景模板渲染
[ 批准 ] [ 拒绝 ] [ 跳转到Harness ]     ← ④ 按钮（审批场景；纯 web 受众没有这一行）
```

几个刻意的选择，都有实测依据：

- **① 由插件同步**：改动「通知署名」会自动写进 AUMID 的显示名（`scripts/set-aumid-display-name.ps1`，幂等 + 回读校验），此后通知最上方那一行就是它；**同步成功后 ② 就不再写**，因为同一句话不该出现两次。
- **左侧图标**取自 DeepSeek Harness 自己的图标：源图存在 [`assets/app-icon-source.png`](./assets/app-icon-source.png)，由 `npm run build:icon` 生成多尺寸 ICO 并注册到 AUMID 与开始菜单快捷方式（换 logo 时用 `-Source <新图>` 或直接覆盖那份源图）。**不要在 toast XML 里写 `<image>`**：那会在正文里多出一个图标。
- **点卡片本身什么都不做**（`activationType="system"`）：只确认收到。所有动作都在明确的按钮上。
- **「跳转到Harness」** 把桌面窗口显示到最上层（自有协议 → 无控制台启动器，只用 `SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE)` 这条无焦点路径）。
- **「批准 / 拒绝」是真的提交决定**：插件作为 DSH 的审批应答者，在轮次内等待你的点击，令牌一次性、有期限，超时或异常一律交回界面作答。安全边界见 [ADR 0007](./docs/adr/0007-approval-controls-submit-decisions.md)。
- **显示时长**：`0` = 常驻直到手动关闭；`1–60` = 显示指定秒数（上限 60）。

## 安装

**官方通道**（推荐；它会同步 profile 的依赖与 lockfile，并返回是否已生效）：

```
plugin_manager  action: install_bundle  target: <本仓库目录的绝对路径>
```

命令行等价写法：

```powershell
dsh plugin --profile <profile 名> add link:<本仓库目录>
```

装完看返回的 `application` 字段：`applied` 表示**当场生效**。若你替换的是**已在进程里的那份实现**（而不是新增一行），需要重启对应的 Host 才生效。

首次运行时插件会自己完成两件事（幂等，无需手工干预）：

1. 向 Windows 注册通知来源（AUMID）。**未注册的通知来源，通知会被收进通知中心却不显示横幅。**
2. 注册 `dsh-session-alert://` 协议并同步署名 —— 后者是「跳转到Harness」按钮能工作的前提。

### 卸载

```powershell
dsh plugin --profile <profile 名> remove dsh-session-alert
```

彻底清理（可选）：删掉 `%DSH_HOME%\dsh-session-alert` 配置目录，并运行

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-aumid.ps1 -Unregister
```

## 使用

设置页在 **设置 → 会话通知**（英文环境显示 `Session Alert`）。**没有保存按钮：改动会自动保存**（防抖 + 关闭标签页时补一次）。

| 项 | 说明 |
| --- | --- |
| 启用通知 | 总开关。关掉后不发送任何通知（预览也不发）。 |
| 通知署名 | 显示在通知最上方那一行；改动会自动同步到系统。 |
| 提醒场景 | 每个场景一组：开关 / 最小间隔（秒，0 = 不限）/ 显示时长 / 正文模板（下方实时预览）。 |
| 最大频率 | 滑动窗口限流：每 X 秒最多 N 条；超出默认合并成一条稍后发出。10 秒内完全相同的消息始终去重。 |
| 铃声 | 系统声音或自定义音频文件。 |
| 抑制 | 「桌面端在焦点内时不弹卡片」（仍响铃）。仅对桌面端生效。 |
| 发送这条通知 | 每个场景一个按钮：**按当前场景真发一条预览**，正文就是你预览区看到的那一行。 |

正文模板可用变量：

| 变量 | 含义 |
| --- | --- |
| `{workspace}` | 所属工作区（目录名） |
| `{session}` | 会话标题；取不到时退化为会话 id 前 12 位 |
| `{summary}` | 问题摘要 / 错误摘要 / 工具名等补充信息 |
| `{tool}` | 请求授权的工具名（仅「等待授权」场景） |
| `{time}` | 触发时间 `HH:MM:SS` |

写错或没有值的变量会渲染成空字符串，不会让通知失败。默认正文**不含** `{workspace}`（通知最上方已经是署名，正文再出现目录名既重复又容易被误认成插件的名字）。

配置文件：`%DSH_HOME%\dsh-session-alert\config.json`（`DSH_HOME` 默认 `~/.dsh`）。桌面端与 web 端**共用这一份**。

诊断页就在设置页下方：**运行状态**（本次进程的发送 / 限流 / 合并 / 去重 / 失败计数）、**信号日志**（每个信号与它的判决串）、**最近活动**（最近若干条通知及其投递路径与失败原因）。**收不到通知时先看这里**：完全没有记录 = 信号没到达插件；`skipped:` = 被开关/去重/限流拦下；`sent:card-only` / `sent:card+3buttons` = 已交给 Windows，并写明卡片有几个控件。

## 自检与验证

```powershell
npm test                                 # 89 条离线断言（不真发通知）
node scripts/selftest.mjs --deliver      # 真发一条：唯一覆盖「宿主投递接线」的检查
node experiments/events-wiring-check.mjs # 事件接线（真实载荷 + 瀑布 next() 断言）
node experiments/post-restart-check.mjs  # 逐项判定哪些修复已在运行环境生效（端口见下）
npm run build:icon                       # 重新生成通知图标（assets/）
npm run build:launcher                   # 重新编译无控制台启动器（bin/）
```

**端口按 profile 不同**：桌面端 `19387`，web 端 `3080`。`post-restart-check.mjs` 里写死的是桌面端口；验 web 端请直接读 `http://127.0.0.1:3080/api/dsh-session-alert/state`。

## 文档

- [`HANDOFF.md`](./HANDOFF.md) —— 交接说明：**哪些是已验证、哪些只是声称**，以及可判定的判据。
- [`AGENTS.md`](./AGENTS.md) —— 给新会话的操作要点与踩过的坑（Windows/PowerShell 硬约束、两个 profile、安装通道）。
- [`docs/adr/`](./docs/adr/0001-client-kind-and-announcement-shape.md) —— 七条设计决定（端别与卡片形态、卡片交互、启动器、审批控件）。
- [`docs/design-progress.md`](./docs/design-progress.md) —— 设计结论与实测知识。
- [`docs/implementation-progress.md`](./docs/implementation-progress.md) —— 逐轮实现记录（含每次缺陷的根因与验收证据）。

## 许可

[MIT](./LICENSE) © 2026 Moistrocic
