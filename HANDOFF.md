# 交接说明（新会话请先读这一页）

本文件是 2026-09-25 那次会话的交接。**它刻意区分「已验证」与「只是声称」**，
因为上一个会话最大的问题就是多次把「看起来成了」当成「证明得了」。

---

## 一、当前状态（一句话）

**插件的功能骨架已完备且多数环节经真机验证；设置页能渲染但观感不对，
而「样式到底有没有注入」尚未判定——这是当前唯一的阻塞点。**

---

## 二、真正验证过的（有独立证据）

| 能力 | 证据 |
| --- | --- |
| 通知投递（自有 AUMID） | `{"ok":true,"code":0,"note":"toast（自有 AUMID）"}` |
| 点通知按钮 → 协议激活 → 启动器 | 用户人工确认 + 启动器日志 |
| **窗口浮到最上层** | 用户确认「浮到最上层约 8 秒，尺寸没变」 |
| **跳转不改变窗口尺寸/形态** | `rect 1721x927 -> 1721x927 unchanged=True`，最小化/隐藏/最大化三形态 |
| **任何进程启动不分配可见控制台** | 三条路径监视，捕捉 **0 个**新可见控制台；`GetConsoleWindow()=0` |
| **刻意演练降级链** | `code=5 → code=6 → code=0`，快捷方式指纹前后一致 |
| 端别自报 | `/client-state` 返回 `{"ok":true,"liveKinds":["desktop"]}` |
| `turnEnd` 事件真实触发 | 信号表实录：`turn/end:completed` → `suppressed:chime-only` |
| 根会话过滤 | 子代理会话被 `skipped:not-a-root-session` |
| 焦点抑制 | `chimes:4`——卡片扣下但铃响 |
| 四类事件**接线** | `events-wiring-check.mjs` 逐场景隔离验证，含 `next()` 调用断言 |
| 离线单测 | `npm test` **50/50** |
| 设置页已注册 | `settings.section` 的 occupants 里有 `id: session-alert, order: 130, active: true` |

验收标准（`docs/design-progress.md` 决定 28）的六条里，**五条已达成**：
端到端真实场景、离线单测、刻意演练降级链、跳转不改变尺寸形态、不分配可见控制台。
第六条「逐项验证设置与变量」卡在设置页观感上。

---

## 三、当前阻塞：设置页样式

### 症状

功能正常（六个区块、模板切换器、预览、诊断都能用），但**观感不对**：
元素堆叠、文字与控件挤在一起、不像 DSH 自身的设置页。

用户两次反馈，第二次说「重启后完全没有变化」。

### 已经排除的（都做过核对，不是推测）

- 源文件含新样式：`box-sizing:border-box`、`auto-fit`、`grid-template-columns`、`bg-layer-3` 全在
- **bundle 与源文件 SHA256 一致**（`profiles/desktop/node_modules/dsh-session-alert`
  是指向工作区的 Junction，`lib/client.js` 就是被服务的文件）
- 无预打包缓存（无 `.dsh-client-bundles` / `.cache` / `dist`）
- DSH 重启时间（17:18:30）**晚于**最后一次样式写入（17:17:38）
- 注入的 CSS **文本合法**：`experiments/stylesheet-validate.mjs` 校验 68 条规则，
  花括号/圆括号配平、规则无粘连、无空声明

### 尚未判定的一种可能（**下一步就该查这个**）

只剩两种可能，而它们在页面上都不报错：

1. **`styles.insert` 没有真的注入**（`styles` 内置不可用，或 `apply` 没跑到那一步）
2. **注入成功但被覆盖**（选择器优先级 / 官方样式后注入）

**已加好诊断**（未验证，因为需要重启才生效）：`lib/client.js` 的 `apply` 里，
`styles.insert` 之后会写一条控制台日志：

```
[dsh-session-alert] 样式已注入（xxxxx 字符）
[dsh-session-alert] styles 内置不可用（typeof styles = ...），设置页将没有自定义样式
[dsh-session-alert] 样式注入失败：...
```

**下一步动作**：重启 DSH → 打开设置页 → F12 看 Console 有没有那行。
- 有 → 属于「被覆盖」，去查优先级
- 显示内置不可用 → 属于「没注入」，去查 Builtin 的实际可用性
- 什么都没有 → `apply` 根本没跑到，是更基础的问题

同时可看 Elements 面板里有没有带 `data-dyn` 属性的 `<style>` 标签（DSH 给自己的样式标签打这个标记）。

### 之前几轮为什么没查出来（供参考，避免重蹈）

我连续把「样式不对」当成**数值问题**去调（字号、间距、令牌），
直到后来才去读官方参照物。真正有价值的发现只有一个：
`@linxin666/dsh-pet` 的 `settings-card.module.css` 里有一条注释说明
**套件不强制全局 `border-box`**，因此 `width:100%` + `padding` 会撑出容器。
这条已修，但**用户说没有变化**——所以它可能根本不是主因，或者注入压根没发生。

**教训**：在不确定「改动有没有生效」之前调样式，是在猜。应先建立可判定的反馈。

---

## 四、另一个必须知道的前提：改动要重启才生效

- **Host 半边**（`lib/index.js`）在 DSH 进程内，改后必须重启 DSH
- **Client 半边**（`lib/client.js`）桌面端**无法刷新页面，必须重启应用**
  （用户明确说过：「桌面端无法刷新，必须重启」）

所以每一次验证都要一次重启。**上一个会话有多轮把「已验证」说早了，就是因为改完没重启就下结论。**

**当前磁盘上至少有两处修复尚未在运行环境生效**：
1. waterfall 监听器修复（严重缺陷，见下）
2. 设置页路由修复 + 样式改动

---

## 五、修过的严重缺陷（确认修好了，但需重启生效）

### waterfall 监听器否决了用户的提问与审批

`user-questions/request` 与 `approval/request` 都是 **waterfall** 事件，
而处理器**既不接收 `next` 也不调用它**，返回 `undefined`。cordis 的契约原文：

> a listener that does not call `next()` **vetoes the rest of the chain, including
> the built-in behavior.**

**也就是说插件一直在阻断提问与审批流程。** 已修（普通函数 + 末尾 `return next()`），
并做成机器审计 `scripts/listener-mode-audit.mjs`（纳入 `npm test`，含变异测试）。

### 设置页 HTTP 404

路由写成 `{ method, path, handler }`，而契约是 `{ kind: 'exact'|'prefix', path, handler }`
——**缺 `kind`**。未命中请求由 fallback 回 404。已改为一条 `kind: 'prefix'` 路由，
端点内部分派。同时把一次性 `ctx.get('webServer')` 改为 `ctx.inject(['webServer'], cb)`。

---

## 六、尚未完成

1. **设置页样式**（当前阻塞，见第三节）
2. **`question` / `approval` / `error` 三类事件的真实观测**
   —— 接线已验证，但从未在真实环境观察到（`approval` 需要审批策略为 `ask` 才能构造）
3. **焦点抑制的「实际听到铃声」**——`chimes` 计数有记录，但没人确认听到过
4. **审批控件的最终形态**——见 ADR 0006：**不代答**
   （`approval.request` 要求开放中的轮次与同进程，插件是轮次之外的外部进程）

---

## 七、给新会话的几条建议

1. **先重启 DSH**，再按第三节的判定步骤查样式。不要跳过这一步去调样式数值。
2. **要截图，不要自己推理**。上一个会话从「401」猜到「通信拓扑」，查了两轮，
   直到用户给截图才看到写的是 **404**——方向立刻清楚了。
   截图能一眼分开「没注入」与「被覆盖」，而推理不能。
3. **读官方文档**：`@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/`
   （`SKILL.md` + 五份 `references/` + 模板）。这是写 DSH 插件的正确入口，
   上一个会话直到第 4 轮才发现它，此前都在逆向 `app.asar`。
   用 `experiments/asar-read.mjs list/read/grep` 读它（shell 工具打不开 asar）。
4. **官方明令不得 import** `@deepseek-ai/dsh-client-ui-primitives`。
   正确做法是把 markup/CSS/behavior **抄进插件**，类名加自己前缀，
   只保留 `--dsw-alias-*` 令牌引用。
5. **改运行时错误时，若某个自检一直是绿的，要问「它到底断言了什么」**。
   设置页 404 之所以拖了很久，就是因为自检只断言了「路由条数 >= 2」，
   从不检查形状。

---

## 八、仓库地图

| 路径 | 内容 |
| --- | --- |
| `lib/index.js` | Host 半边：事件接线、端别在线状态、抑制判定、协议注册、HTTP 路由 |
| `lib/client.js` | 浏览器半边：端别自报、焦点上报、设置页（含样式表 `STYLES`） |
| `lib/contract.js` | 跨半边契约：协议名、AUMID、场景定义、`protocolUrl()` |
| `lib/config.js` | 配置读写与归一化、原子保存、模板渲染 |
| `lib/notify.js` | 投递链 + 降级 + 铃声 + `AlertDispatcher`（限流/合并/去重/抑制） |
| `lib/launcher/*.cs` | 无控制台启动器（`/target:winexe`，PE Subsystem 2） |
| `scripts/selftest.mjs` | `npm test`：50 条离线断言 |
| `scripts/listener-mode-audit.mjs` | 监听器 dispatch-mode 审计（被 selftest 使用） |
| `docs/adr/0001…0006` | 六条设计决定（**0003 已被 0006 取代，见 0006**） |
| `docs/design-progress.md` | 设计阶段结论 + **16 条已验证的实测知识**（含 PowerShell/UI 各种坑） |
| `docs/implementation-progress.md` | 实现进度与已确证项 |
| `docs/session-event-timeline.md` | 「目标轮次不产生 turn/end」的判定方法 |
| `experiments/` | 人工验证工具（26 个）。**不并入 `npm test`**，多数是破坏性的 |

### 常用命令

```powershell
npm test                                   # 50 条离线断言
node experiments/events-wiring-check.mjs   # 事件接线（含瀑布 next() 断言）
node experiments/settings-render-check.mjs # 设置页渲染（自制替身，非验收证据）
node experiments/stylesheet-validate.mjs   # 注入的 CSS 是否合法
node experiments/listener-mode-audit.mjs   # 监听器 mode 审计
node experiments/shape-check.mjs           # 卡片形状选择
node experiments/asar-read.mjs list|read|grep   # 读 DSH 的 app.asar
```
