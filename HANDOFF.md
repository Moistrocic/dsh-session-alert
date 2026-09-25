# 交接说明（新会话请先读这一页）

本文件是 2026-09-25 那次会话的交接。**它刻意区分「已验证」与「只是声称」**，
因为前几轮最大的问题就是多次把「看起来成了」当成「证明得了」。

---

## 一、当前状态（一句话）

**设置页样式的根因已定位并修复，且经人眼确认；四类事件里三类已在真实会话中观测到；
焦点抑制下的铃声已由用户确认听到。当前只剩两项待办，都不阻塞使用。**

「设置页为什么不好看」这个卡了两轮的问题，答案是：**CSS 从来没有进过文档**。

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
| `question` | ✅ **已观测** | `17:31:40 user-questions/request → sent:card+button`；用户确实收到卡片并作答 |
| `error` | ✅ **已观测（两条路径）** | `17:34:51 api-session/error` 与 `turn/end:error` **同时**到达，都判为 `skipped:not-a-root-session`（子代理会话，正确静默） |
| `approval` | ⛔ **仍未观测** | 当前审批策略是 `never`，DSH 根本不会发出 `approval/request`。见第七节 |

`question` 的观测还顺带确认了一件重要的事：**waterfall 修复在运行环境里生效了**——
用户真的收到了那个问题并作了答（旧代码会把整条提问链否决掉，问题根本不会出现）。

`error` 的触发方式是可复现的：用 `workflow` 让一个子代理指向不存在的模型名，
于是子代理的 LLM 请求失败 → `agent/error` → `api-session/error`，
同轮还会落下一条持久的 `turn/end:error`。**一次故障，两条路径各自被记录**，
这比「接线测试说它接上了」强得多。

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

## 七、尚未完成（只剩两项）

1. **`approval` 的真实观测。** 需要用户把审批策略临时改回 `ask`，然后触发一次需要授权的
   工具调用。当前策略是 `never`，DSH 不会发出 `approval/request`，因此这条**无法在不改策略的
   前提下完成**——这不是代码问题。
   接线的离线验证是齐的（`npm test` 的 `approval 载荷按真实契约解析` + 接线检查的
   `工具待授权 -> approval`），缺的只是「真实环境里它会不会到达」。
2. **`lib/index.js` 的两处改动尚未在运行环境生效**（需要重启 DSH）：
   - `question` / `approval` 监听器的载荷字段修复（上面第五条，已修，未生效）
   - `/state` 新增的 `clients.styles`（样式读数经 Host 暴露）
   重启后应能看到：`GET /state` 的 `clients.styles[0].report.injected === true`，
   以及下一次真实提问的通知正文里出现**会话名与问题原文**。

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
node experiments/events-wiring-check.mjs     # 事件接线（含真实载荷与 next() 断言）
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
