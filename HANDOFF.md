# 交接说明（新会话请先读这一页）

本文件是 2026-09-25 那次会话的交接。**它刻意区分「已验证」与「只是声称」**，
因为前几轮最大的问题就是多次把「看起来成了」当成「证明得了」。

---

## 一、当前状态（一句话）

**原定的四项待办已全部了结；用户随后提出的三项改动（默认配置、自动保存、标签名本地化）
也已落地并各自配了机器判据。磁盘与运行环境基本一致（客户端半边已热重载，Host 半边的
默认值改动等一次重启），`npm test` 65/65。**

「设置页为什么不好看」这个卡了两轮的问题，答案是：**CSS 从来没有进过文档**。

验证的分量分布（这也是接手时最该知道的一件事）：

| 结论 | 靠什么站住 |
| --- | --- |
| 样式已注入且生效 | 机器读数（`/state` 的 `clients.styles`：1 标签 / 68 规则 / `dynTags: 0`）+ 用户读设置页诊断区确认 `display=flex gap=16px` |
| 四类事件到达 | `/state` 信号表 + 渲染后的通知正文 + 用户当场作答/批准 |
| 代码就是页面收到的那份 | 从 HTTP 取回 bundle 与磁盘 `lib/client.js` **逐字节**比对 |
| 自动保存真的会落盘 | `scripts/client-behavior-audit.mjs`：挂起组件、改字段、推计时器，断言「防抖一次 + 卸载一次」且无自咬循环（含 3 条变异断言） |
| 标签名按语言给 | 同上审计读回两份字典；宿主 catalog 原文确认 thunk 每次投影重读 |
| 改坏了会被发现 | 15 条新断言，含 7 条变异断言 |

### 用户随后提出的三项改动（都已落地）

| 改动 | 现状 | 判据 |
| --- | --- | --- |
| 默认配置：四个场景最短间隔一律 0；显示时长 `turnEnd` 30 秒、其余 0（常驻） | 默认值改在 `SCENARIOS` 表自己身上；**用户已保存的配置里这四项已经是目标值** | `npm test` 两条断言（含「归一化不覆盖已保存值」） |
| **去掉保存按钮**，改成切换/关闭设置页时自动保存 | 已生效（客户端半边已热重载） | `scripts/client-behavior-audit.mjs`：断言「装载不写盘、防抖写一次、卸载立刻写一次、存完不自咬」，含 3 条变异断言 |
| 设置页标签名：中文「会话通知」，其余语言「Session Alert」 | 已生效 | 同一审计读回 `zh`/`en` 两份字典；宿主 catalog 原文确认 thunk 每次投影重读，语言切换不需重新注册 |
| 「发送这条通知」：删掉通用的「发一条测试通知」，改到「通知内容」卡片里**按当前场景**真发一条 | 客户端已生效；**Host 侧的 `/notify` 与 `bypass` 需重启** | 行为审计断言「发出的正文与预览区那一行逐字相同」；`npm test` 5 条 bypass/400 断言 |

一轮内的三处「判据本身不对」（路由探针不读真实状态码、审计快照手抄且为空、
审计写死字段名）记在 `docs/implementation-progress.md` 第四轮——它们的共同点是
**断言看起来在检查一件事，实际检查的是另一件事**。

自动保存的三个触发点（缺一个都会丢改动）：编辑停止 700ms 防抖、**组件卸载**
（切换/关闭设置页——用户点名的那一刻）、`pagehide`（应用关闭）。
实现里四处必须留意的细节（ref 存草稿、键序无关比较、在途排队、回填不覆盖输入）
写在 `docs/implementation-progress.md` 第三轮。

**唯一还没生效的是「默认值」本身**：它在 Host 半边（`lib/contract.js`），要一次重启才进进程。
由于保存的配置已含目标值，重启前后行为一致。

---

## 二、这次会话解决的核心问题：设置页样式

### 根因（有源码级证据，不是推测）

原代码写的是 `styles.insert(STYLES)`。**`styles` 是动态半边才有的符号**：

| 半边 | 拿得到 `styles` 吗 | 证据 |
| --- | --- | --- |
| 动态半边（`cordis-client-runner` 闭包） | **拿得到** | `closure(react, taggedConsole(...), styles, host, harnessTrap(), …)`；`styles` 是 `DynamicCordisStyles`，`insert()` 把标签打上 `data-dyn` |
| 静态半边（本插件：`window.__ModuleLoader__.load`） | **拿不到** | 物化语句是 `registered.factory(this.makeRequire(ownerId, edges))` —— **只传一个实参**；工厂是 `(require) => {}`，因此 `styles` 是自由变量 |

再加上第三条：全包里 **没有** `window.styles` / `globalThis.styles`（grep 命中 0）。
于是 `typeof styles !== 'undefined'` 走了 else 分支——**代码执行了、日志打了、
CSS 一个字符都没进文档**，而页面上不报任何错。这就是「改数值、改令牌、重启都没变化」的原因：
改的是一个没有被执行的字符串。

### 修法

静态半边必须**自己创建 `<style>` 标签**（`dsh-client-modules` 的 lazy-CJS 契约原文说
「every module body side effect — including CSS injection — lives inside the factory closure」）。
现在 `lib/client.js` 的 `installStyles()`：

- 建 `<style>` 并**自己打上 `data-plugin="dsh-session-alert"`**。预打标记的标签不会被
  别的插件顺手认领（宿主 `claimStyles` 只挑没有该属性的），而宿主该做的清理照旧会做：
  `removeOwnedStyles(id)` 在本条目被替换/卸载时移除 `style[data-plugin=id]`，因此热重载
  不会叠加样式。
- 生命周期仍由 `ctx.effect` 管，返回的清理函数移除标签。

### 它为什么能活过一整轮自检（**这条比根因更值得记住**）

因为**自检替身自己造了一个 `globalThis.styles`**——
`experiments/settings-render-check.mjs` 里那行 `globalThis.styles = { insert: () => () => {} }`。
替身把真实环境里不存在的东西补上了，于是被执行的正是那条在真机上永远走不到的分支。
**测试只证明了「我能喂饱我自己」。** 这与 waterfall 缺陷同源，而这次是同类错误的第 2 次发生
（第 3 次见第五节的载荷形状）。

### 现在的判据（不再是「重启后看看好不好看」）

设置页诊断区多了两行，且同一个读数经 `/state` 暴露，可机器读：

- **样式注入**：标签在不在、浏览器解析出多少条规则（标签在 ≠ 样式可用）
- **样式实测（读回）**：`getComputedStyle('.dsa-root')` 读回的计算值。本插件的样式表把
  `.dsa-root` 定为 `display:flex; gap:16px`，而普通 div 的默认值是 `block/normal`——
  因此这一行能区分「标签在但没作用」与「真的生效了」。它来自浏览器，不来自插件的意图。

离线判据在 `scripts/client-style-audit.mjs`（纳入 `npm test`，5 条断言），它的替身
**拒绝提供 `styles`**，并含两条变异断言：去掉注入、改回 `styles.insert`，都必须被抓出来。

### 人眼确认（已完成）

用户确认「正常了」并给了截图：卡片有圆角描边、标签在上控件在下、长说明文字自占一行、
场景切换是 Pill 形态。截图里设置面板整体半透明是**主题皮肤**的效果——DSH 自己的左侧导航
同样透出后面的内容，因此本插件与宿主一致，不是本插件的问题。

---

## 三、推翻一条旧前提：客户端半边**可以**热重载，不必重启

旧交接写着「桌面端无法刷新页面，必须重启应用」。**这句话只对一半。**

DSH 自带 `@deepseek-ai/dsh-client-hmr`（该 profile 里**已挂载**，`immediately: true`）：

1. 它每 500ms `stat` 每个 client bundle（按 mtime/ctime/size）
2. 有变化 → `clientModules.rebuilt(id)` → SSE `/plugins/events` 推一帧 `{"type":"rebuilt","id","rev"}`
3. 页面的另一半收到后调 `entries.reload(id, rev)`：作废旧条目、移除其样式、重新物化

本轮实测（有记录）：

```
data: {"type":"rebuilt","id":"dsh-session-alert","rev":"dcd8d74d3f10"}
reload 前 ageMs: 22152   →   reload 后 ageMs: 3664      ← 新代码真的重新 apply 了
SHA256(服务端发来的 client.js) 与磁盘逐字节相同（只差 74 字节的 sourcemap 尾部）
```

**因此：改 `lib/client.js` 只需保存文件，1 秒内自动生效；改 `lib/index.js` 才需要重启。**

### 为什么 Host 半边必须重启（确切机制，也查清了）

DSH 也有 Host 侧 HMR：`@deepseek-ai/dsh-hmr`（chokidar）。它监听 **profile 目录**，
而默认忽略表是：

```js
ignored: [ '**/node_modules', '**/.*', 'cache', 'data' ]   // dsh-hmr 的 Config 默认值
```

本插件是通过 `profiles/desktop/node_modules/dsh-session-alert`（junction）链进 profile 的，
**它在监听根里的唯一路径落在 `node_modules` 下**，因此被默认忽略 —— 这就是「改动要重启」的机制。

（理论上可以给 hmr 条目加一条 patch 把该路径移出忽略表，从而让 Host 半边也热重载。
本轮**没有做**：那会改动用户 profile 的全局配置，属于该先问过用户的事。）

---

## 四、四类事件的真实观测（这是本轮第二个主要产出）

| 场景 | 状态 | 证据 |
| --- | --- | --- |
| `turnEnd` | ✅ 早已观测 | 信号表 `turn/end:completed` → `suppressed:chime-only` |
| `question` | ✅ **两次观测** | `17:31:40 user-questions/request → sent:card+button`（用户在焦点外，收到卡片并作答）；`17:42:08` 同源事件 → `suppressed:chime-only`（用户在焦点内，卡片扣下、只响铃） |
| `error` | ✅ **已观测（两条路径）** | `17:34:51 api-session/error` 与 `turn/end:error` **同时**到达，都判为 `skipped:not-a-root-session`（子代理会话，正确静默） |
| 「用户打断 → 不提醒」 | ✅ **两次观测** | `17:43:35` 与 `18:06:57` 的 `turn/end:aborted-by-user → skipped:user-interrupted`（`skipAbortedTurns` 在真实打断上生效，不再只是合成事件） |
| **`approval`** | ✅ **已观测（18:09:20）** | `approval/request → suppressed:chime-only`，正文 `dsh-session-alert · 对齐桌面版继续未完成任务 等待你的授权：工具 pwsh` |

**四类事件至此全部在真实会话中观测到。** 重启之后这一轮还把两处 Host 侧修复一并验证了：

```
18:07:33  user-questions/request  sent:card+button       session=session-d004
   正文：… · 对齐桌面版继续未完成任务 正在等待你的回答：<问题原文>（共 2 个问题）
18:09:20  approval/request        suppressed:chime-only  session=session-d004
   正文：… · 对齐桌面版继续未完成任务 等待你的授权：工具 pwsh
```

修复前这两条都会是「未知会话」且摘要在冒号后为空。现在**会话名、问题原文、工具名都在**，
`（共 2 个问题）` 那句数量提示也在——说明 `questions[]` 数组被正确读了。

`approval` 那次还顺带证明了 **waterfall 修复在审批链上同样生效**：用户批准之后，
那条被升级的命令**真的执行了**。若监听器仍然否决链路，审批走不到应答者，工具会直接失败。

`question` 的观测也确认了同一件事：**用户真的收到了那个问题并作了答**
（旧代码会把整条提问链否决掉，问题根本不会出现）。

`error` 的触发方式是可复现的：用 `workflow` 让一个子代理指向不存在的模型名，
于是子代理的 LLM 请求失败 → `agent/error` → `api-session/error`，
同轮还会落下一条持久的 `turn/end:error`。**一次故障，两条路径各自被记录**，
这比「接线测试说它接上了」强得多。

`approval` 的可复现配方（**已实测跑通**，比猜「auto-review 会拦什么」可靠）：

1. 会话的文件策略改成**比 `danger-full-access` 窄**的一档（本次是 `workspace-write`）；
   审批策略改成 `ask`。两者缺一不可——`dsh-sandbox` 的
   `WIDER_MODES = { 'read-only': [workspace-write, danger-full-access], 'workspace-write': [danger-full-access] }`
   决定了「表顶没有更宽的目标可升级」，所以 `danger-full-access` 下不会有升级请求。
2. 让 Agent 发一次带 `sandbox_permissions: 'danger-full-access'` + `justification` 的调用。
   沙箱层会在**执行之前**把这个升级请求交给审批通道 → `approval/request` 触发。
3. 判定：`/state` 的信号表出现 `approval/request`，且活动列表里有渲染好的正文。
   独立证据：`dsh-user-approval` 会向会话追加 `approval/asked` / `approval/decided` 一对事件。

**顺带记一个环境事实**：在**本机**把文件策略收窄到 `workspace-write` 后，**每一条命令都失败**，
报 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(C:\Code\Projects\dsh-session-alert)`
——沙箱要授予工作区写权限时被拒（Win32 5 = 拒绝访问）。也就是说演练期间那条命令必须走升级路径，
这反而正好是触发 `approval/request` 的那一步。

### 铃声：已由用户确认听到

`[System.Media.SystemSounds]::Asterisk.Play()`。顺带核对过声音方案：
`HKCU\AppEvents\Schemes\Apps\.Default\SystemAsterisk\.Current` → `C:\WINDOWS\media\Windows Background.wav`（存在）。
因此「听不到」若再发生，先去查系统音量/静音，而不是先改代码。

---

## 五、真实观测暴露的第二个真实缺陷：载荷字段读错了

`question` 的通知**发出去了**，但正文是：

```
DSH · 未知会话 正在等待你的回答：          ← 会话名退化成「未知会话」，摘要为空
```

两个字段都读错了：

| 读法 | 真实位置 | 权威依据 |
| --- | --- | --- |
| `this.agent.id` | `request.agent.id`（**agent 被并进了载荷**） | 发射点：`ctx.waterfall(scopeTarget(agent, agent), 'user-questions/request', { ...request, agent }, noAnswerer)`；`dsh-scope` 的路由键 `(args) => args[0]['agent']` |
| `payload.question` | `request.questions[0].question`（数组） | `cordis_inspect_query` 的 Event 契约：`AskUserQuestionRequestEvent = { questions: AskUserQuestionItem[]; agent?; signal? }` |

`approval/request` 同样写错了会话来源（`toolName` 那处是对的）。
两者都已改为**只读载荷**，并按契约取字段。

### 为什么接线测试没抓到（**同类错误的第 3 次**）

因为测试的载荷是测试自己编的：`{ question: '…' }`，会话则从替身 `this.agent` 取。
真机上 `this` 不是 Agent（信号表里该行的**会话栏为空**，正是它的痕迹）。

这次做的修补比上次更硬：

1. 载荷形状**照抄 Event 契约**，并在 `scripts/event-harness.mjs` 里集中一处、注明来源；
2. 替身的 `this` 改成**空对象**（忠实于实测：真机上 `this.agent` 取不到东西），
   因此任何人把会话改回从 `this` 取，测试立刻失败；
3. 替身的 `sessionQuery` **按 id 应答**（第一版忽略参数，导致「id 取错了也照样查到标题」——变异没被抓到才发现）；
4. `npm test` 里有 6 条断言，含**反向断言**：喂旧的自造形状时，同一条断言必须失败。

真机变异验证过：把 `payload.questions` 改回旧写法则报「正文里没有问题原文」；
把会话改回 `this.agent` 则报「正文里没有会话名」。两次都恢复回原文件（SHA256 一致）。

### 顺带修掉：`npm test` 不该写用户的注册表

`apply()` 会调 `ensureProtocolRegistered()`，它会 spawn 真的 Windows PowerShell 去写
`HKCU\Software\Classes\dsh-session-alert`。替身挂载期间实测捕到了那个进程。
现在替身把 `DSH_SESSION_ALERT_POWERSHELL` 临时指向一个不存在的路径（`notify.js` 早就
留了这个覆盖口子），注册被跳过，测试不再有机器副作用；`--toast` 的真机冒烟不受影响。

---

## 六、给新会话的几条建议

1. **改 `lib/client.js` 不用重启**——保存后约 1 秒自动生效（client-hmr）。
   要用一条命令确认它真的生效了：`curl -sN http://127.0.0.1:19387/plugins/events`，
   保存文件后应看到 `{"type":"rebuilt","id":"dsh-session-alert",...}`。
2. **改 `lib/index.js` 要重启 DSH**（原因见第三节的 `**/node_modules`）。
   改完没重启就下结论，仍然是本项目的头号错误来源。
3. **设置页样式的判据已经存在**，不要再靠「看看好不好看」：`npm test` 的样式审计 +
   设置页诊断区那两行读数 + `/state` 的 `clients.styles`。
4. **要截图，不要自己推理。** 但截图之外，现在还有一条机器通道：
   `curl -s 127.0.0.1:19387/api/dsh-session-alert/state` ——插件注册的路由不需要凭据。
   信号表、判决串、计数、样式读数都在里面。
5. **写替身时先问：真实环境里有没有这个东西？** 本项目已经三次栽在「替身把真机上不存在的
   东西补上」（`styles`、载荷形状、`this.agent`），一次栽在「替身忽略输入」（sessionQuery）。
   替身比生产代码更需要被怀疑。
6. 官方明令不得 import `@deepseek-ai/dsh-client-ui-primitives`；正确做法是把
   markup/CSS/behavior 抄进插件、类名加前缀、只留 `--dsw-alias-*` 令牌。

---

## 七、完成状态（截至本次交接，全部待办已了）

### 0. 先跑这一条命令——它会告诉你哪些修复已在运行环境生效

```powershell
node experiments/post-restart-check.mjs      # 退出码 0 = 所有「应当生效」的都生效了
```

它逐项判定并打印原因：Host 半边可达、客户端半边在线、**样式读数经 `/state` 暴露**
（injected / tags / rules / 实测 `display`）、`dynTags` 是否为 0（非零就说明有人把
`styles.insert` 那条死路加了回来）、**运行中的 client bundle 与磁盘逐字节相同**、
信号表汇总，以及 question 正文修复是否生效、approval 是否已观测到。

**只有「应当生效却没生效」才让它失败。** 三种情形走信息项、不影响退出码：
`applied` 为 null（设置页没打开，无从测量）、question 尚未发生、approval 尚未观测。
（这三种都曾经被第一版误报成失败——**假失败和假通过一样有害**，它会让人去修一个正确的地方。）

### 1. 两处 Host 侧改动：**已生效并已实测**

重启（17:45:16）之后：

| 改动 | 实测证据 |
| --- | --- |
| `/state` 新增 `clients.styles` | `{"injected":true,"tags":1,"dynTags":0,"chars":7459,"rules":68,"applied":null}` |
| `question` 载荷字段 | `18:07:33 → sent:card+button`，正文含**会话名 + 问题原文 + （共 2 个问题）** |
| `approval` 载荷字段 | `18:09:20 → suppressed:chime-only`，正文含**会话名 + 工具名 `pwsh`** |

`applied` 那一位由**用户读了设置页诊断区**确认：`display=flex gap=16px font-size=13px`。
它平时为 `null` 是设计如此——只有设置页渲染时 `.dsa-root` 才在文档里，那时才测得到。

### 2. `approval` 的真实观测：**已完成**（配方见第四节末）

不再是待办。可复现配方：文件策略收窄到 `workspace-write` + 审批策略 `ask` +
一次带 `sandbox_permissions`/`justification` 的调用。三条独立证据都拿到了：
插件的信号表与渲染正文、用户当场看到并批准了审批请求、以及那条命令**真的执行了**。

### 3. 剩下可做但非必须的事（都不阻塞使用）

- **明暗两种主题下并排比较观感**：官方 practices 要求「与同类宿主页面并排比较」。
  目前只在当前（深色 + 皮肤）主题下人眼确认过。
- **让 Host 半边也热重载**：给 profile 的 hmr 条目加一条 patch，把插件路径移出
  `**/node_modules` 忽略表。属于改用户 profile 全局配置，需先问过用户。
- **`question` 场景一次问多个问题时的摘要文案**：现在是首题原文 + `（共 N 个问题）`，
  已在实机验证；若想让每道题都出现在正文里，需要另做设计（模板只有一个 `{summary}`）。

---

## 八、仓库地图

| 路径 | 内容 |
| --- | --- |
| `lib/index.js` | Host 半边：事件接线、端别在线状态、抑制判定、协议注册、HTTP 路由 |
| `lib/client.js` | 浏览器半边：端别自报、焦点上报、设置页（含样式表 `STYLES` 与 `installStyles()`） |
| `lib/contract.js` | 跨半边契约：协议名、AUMID、场景定义、`protocolUrl()` |
| `lib/config.js` | 配置读写与归一化、原子保存、模板渲染 |
| `lib/notify.js` | 投递链 + 降级 + 铃声 + `AlertDispatcher`（限流/合并/去重/抑制） |
| `lib/launcher/*.cs` | 无控制台启动器（`/target:winexe`，PE Subsystem 2） |
| `scripts/selftest.mjs` | `npm test`：60 条离线断言 |
| `scripts/client-style-audit.mjs` | 样式注入审计（替身拒绝提供 `styles`，含变异断言） |
| `scripts/event-harness.mjs` | 事件接线替身 + **照 Event 契约的真实载荷**（`npm test` 与接线检查共用） |
| `scripts/listener-mode-audit.mjs` | 监听器 dispatch-mode 审计（被 selftest 使用） |
| `docs/adr/0001…0006` | 六条设计决定（**0003 已被 0006 取代**） |
| `docs/design-progress.md` | 设计阶段结论 + **16 条已验证的实测知识**（PowerShell / Windows UI 的坑） |
| `docs/implementation-progress.md` | 实现进度与已确证项（本轮的详细记录在这里） |
| `experiments/` | 人工验证工具。**不并入 `npm test`**，多数是破坏性的 |

### 常用命令

```powershell
npm test                                     # 60 条离线断言
npm test -- --toast                          # 额外真发一条通知（真机冒烟）
node experiments/post-restart-check.mjs      # 重启后先跑这条：逐项判定哪些修复已生效
node experiments/events-wiring-check.mjs     # 事件接线（真实载荷 + 瀑布 next() 断言）
node experiments/client-style-audit.mjs --mutate  # 样式注入审计 + 变异检查
node experiments/settings-render-check.mjs   # 设置页渲染（自制替身，不是验收证据）
node experiments/stylesheet-validate.mjs     # 注入的 CSS 是否合法
node experiments/listener-mode-audit.mjs     # 监听器 mode 审计
node experiments/asar-read.mjs list|read|grep     # 读 DSH 的 app.asar
```

### 一条不重启也能用的运行时读法

```powershell
curl.exe -s http://127.0.0.1:19387/api/dsh-session-alert/state
curl.exe -sN --max-time 3 http://127.0.0.1:19387/plugins/events   # SSE：graph / rebuilt 帧
```
