# 实现进度 — dsh-session-alert v0.2.0

本文件记录**代码实现阶段**的状态。设计决策见 [`docs/adr/`](./adr/)，
被实测证明的事实见 [`design-progress.md`](./design-progress.md)。
**接手请看 [`HANDOFF.md`](../HANDOFF.md)**，那里是结论与下一步。

---

# 2026-09-25 第二轮：样式根因、热重载机制、载荷形状

## 一、设置页样式：根因是「CSS 从来没有进过文档」

### 症状与代价

功能全部正常（六个区块、模板切换器、预览、诊断都能用），但观感不对：元素堆叠、
文字与控件挤在一起。用户两次反馈，第二次说「重启后完全没有变化」。
我上一轮把它当**数值问题**调了好几轮（字号、间距、令牌），那是在猜。

### 根因（源码级证据）

原代码：`if (typeof styles !== 'undefined' && styles.insert) { styles.insert(STYLES) } else { 记一条日志 }`。

| 半边 | 有 `styles` 吗 | 证据 |
| --- | --- | --- |
| 动态半边 | **有** | `@deepseek-ai/dsh-cordis-client-runner/lib/client.js` 构造 `DynamicCordisStyles`（`insert()` 把标签打上 `data-dyn`），作为闭包实参传入：`closure(react, taggedConsole(...), styles, host, harnessTrap(), …)` |
| 静态半边（本插件） | **没有** | `@deepseek-ai/dsh-client-modules/lib/client.js` 的物化：`exports: registered.factory(this.makeRequire(ownerId, edges))` —— **只传一个实参**；工厂是 `(require) => {}`，`styles` 是自由变量 |

第三条：全包 grep `window.styles` / `globalThis.styles` 命中 **0**。

⇒ `typeof styles !== 'undefined'` 走 else，**日志照打、代码照跑、CSS 一个字符没进文档**。

**这个缺陷的全部代价是「改动有没有生效」无从判定**——而这正是上一轮反复出错的地方
（见 `HANDOFF.md` 第三节的教训）。

### 修法（并保留宿主的样式生命周期）

`lib/client.js` 的 `installStyles()`：自己建 `<style>`，**自己打上 `data-plugin="dsh-session-alert"`**，
由 `ctx.effect` 管清理。为什么自己打标记而不是让宿主认领（`claimStyles(id)` 会把
「还没有 `data-plugin`」的标签认领给正在物化的插件）：

- 预打标记的标签不会被**别的**插件顺手认领；
- 宿主该做的清理照旧会做——`removeOwnedStyles(id)` 在本条目被替换/卸载时移除
  `style[data-plugin=id]`，因此热重载不会叠加样式。

### 判据（两层，刻意分开）

`probeStyles()` 每次上报都重新读数，字段分两层：

- **标签层**：`injected` / `tags` / `chars` / `rules`（浏览器 CSSOM 解析出的规则数）。
  「标签在」与「样式可用」是两件事——CSS 语法有问题时标签仍在，规则会少掉。
- **实测层**：`applied` = `getComputedStyle('.dsa-root')` 的 `display/gap/fontSize`。
  本插件的样式表把 `.dsa-root` 定为 `display:flex; gap:16px`，普通 div 是 `block/normal`，
  因此这一读数能区分「标签在但没作用」与「真的生效了」。**它来自浏览器，不来自插件意图。**

读数有三个出口：设置页诊断区两行（人眼）、`client-state` 上报（Host 存下）、
`/state` 的 `clients.styles`（机器读）。

### 它为什么活过了一整轮自检

`experiments/settings-render-check.mjs` 里有一行

```js
globalThis.styles = { insert: () => () => {} }
```

**替身把真机上不存在的东西补上了**，于是被执行的正是那条在真机上永远走不到的分支。
测试只证明了「我能喂饱我自己」。已删除该行，替身改为复用
`scripts/client-style-audit.mjs` 里的 DOM，而**那个 DOM 拒绝提供 `styles`**。

### 人眼确认

用户确认「正常了」并给截图：卡片圆角描边、标签在上控件在下、长说明自占一行、
场景切换是 Pill。截图里设置面板整体半透明是**主题皮肤**的效果——DSH 自己的左侧导航
同样透出后面的内容，因此本插件与宿主一致。

## 二、客户端半边可以热重载（推翻「必须重启」的一半）

`@deepseek-ai/dsh-client-hmr` 在该 profile 里已挂载（`immediately: true`）：

1. 每 500ms 按 mtime/ctime/size `stat` 每个 client bundle；
2. 变化 → `clientModules.rebuilt(id)` → SSE `/plugins/events` 推 `{"type":"rebuilt","id","rev"}`；
3. 页面另一半调 `entries.reload(id, rev)`：作废旧条目、`removeOwnedStyles(id)`、重新物化。

实测记录：

```
reload 前 ageMs: 22152
data: {"type":"rebuilt","id":"dsh-session-alert","rev":"dcd8d74d3f10"}
reload 后 ageMs: 3664        ← 新代码重新 apply（apply 里先注入样式、后上报，故这一跳是证据）
```

还做了一次**字节级**核对：用当前 rev 从 HTTP 取回被服务的 bundle，
前 70347 字节与磁盘上的 `lib/client.js` **完全相同**，尾部只多 74 字节
（`;\n//# sourceMappingURL=??dsh-session-alert/client.js.map&rev=…`，由 loader 追加）。
即：**页面收到的就是我审过的那一份代码**。

## 三、Host 半边为什么必须重启（机制）

`@deepseek-ai/dsh-hmr`（chokidar，监听 profile 目录）的默认忽略表：

```js
ignored: [ '**/node_modules', '**/.*', 'cache', 'data' ]
```

本插件经 `profiles/desktop/node_modules/dsh-session-alert`（junction）链入 profile，
**它在监听根里的唯一路径落在 `node_modules` 下**，因此被忽略——这就是「改动要重启」的机制。

（可以让 hmr 条目通过 patch 把该路径移出忽略表，但那是改用户 profile 的全局配置，
本轮没有做。）

## 四、四类事件的真实观测结果

| 场景 | 状态 | 记录 |
| --- | --- | --- |
| `turnEnd` | ✅ | `17:22:39 turn/end:completed → suppressed:chime-only`（焦点抑制，`chimes: 1`） |
| `question` | ✅ 三次 | `17:31:40 → sent:card+button`（焦点外，收到卡片并作答）<br>`17:42:08 → suppressed:chime-only`（焦点内，卡片扣下、只响铃）<br>`18:07:33 → sent:card+button`（**重启后**，用于验证载荷修复） |
| `error` | ✅ 两条路径 | `17:34:51 api-session/error → skipped:not-a-root-session`<br>`17:34:51 turn/end:error → skipped:not-a-root-session` |
| 用户打断 | ✅ 两次 | `17:43:35`、`18:06:57` 的 `turn/end:aborted-by-user → skipped:user-interrupted` |
| **`approval`** | ✅ **已观测** | `18:09:20 approval/request → suppressed:chime-only`，正文 `… · 对齐桌面版继续未完成任务 等待你的授权：工具 pwsh` |

**四类事件至此全部在真实会话中观测到。** 三条值得单独说：

- `suppressed:chime-only` 与 `skipped:user-interrupted` 都是**真实事件**在真实环境里落下的判决，
  而不是接线测试喂出来的。前者证明「专注时扣卡片但保留听觉通道」，后者证明「用户自己掐掉的
  轮次不打扰他」——这两条恰恰是设计上最容易被误做成噪音的地方。
- 重启后 `18:07:33` 那条把**载荷修复**验证了：正文含会话名（`对齐桌面版继续未完成任务`）、
  问题原文、以及 `（共 2 个问题）`。修复前是 `DSH · 未知会话 正在等待你的回答：`（空摘要）。
- `18:09:20` 的 approval 那条同样含会话名与工具名，而且**用户批准之后那条被升级的命令真的执行了**。
  若瀑布监听器仍在否决链路，审批走不到应答者，工具会直接失败——因此这是审批链上对
  waterfall 修复的独立确认。

### `approval` 的可复现配方（**已实测跑通**）

**先说为什么此前观测不到——不是代码问题，是配置问题**（两条都查证过）：

1. `@deepseek-ai/dsh-user-approval/README.md`：策略 `never` 会「rejects every request
   **deterministically before interactive dispatch**」——即 `approval/request`
   **根本不会被发出**，插件再正确也收不到。
2. `sandbox_permissions` 升级那条路在 `danger-full-access` 下走不通：
   `@deepseek-ai/dsh-sandbox` 的
   `WIDER_MODES = { 'read-only': ['workspace-write','danger-full-access'],
   'workspace-write': ['danger-full-access'] }` —— 表顶没有更宽的目标可升级，
   因此不会产生升级请求。

**跑通的三步**（每步都可判定）：

1. 文件策略收窄一档到 `workspace-write`，审批策略设为 `ask`；
2. 发一次带 `sandbox_permissions: 'danger-full-access'` + `justification` 的调用
   —— 沙箱层会在**执行之前**把这个升级请求交给审批通道；
3. 判定：`/state` 信号表出现 `approval/request`，且活动列表里有渲染好的正文。
   独立证据：`dsh-user-approval` 会向会话追加一对 `approval/asked` / `approval/decided`。

顺带**排除了一条曾以为可行的路**：`@deepseek-ai/dsh-experimental-auto-review` 的审查闸门
只在会话预设等于 `AUTO_PRESET` 时才生效（源码：`if (permissionPresets.current(agent.session)
!== AUTO_PRESET) return next()`），所以「随便跑一条扎眼命令等它拦下来」并不可靠；
`sandbox_permissions` 升级才是稳定触发的那条。

**一个环境事实**：在**本机**把文件策略收窄到 `workspace-write` 之后，**每一条命令都失败**，报
`SetNamedSecurityInfoW failed (Win32 5): grantWrite(C:\Code\Projects\dsh-session-alert)`
——沙箱授予工作区写权限时被拒（Win32 5 = 拒绝访问）。演练期间那条命令因此必须走升级路径，
而这恰好就是触发 `approval/request` 的那一步。（文件类操作不受影响：`edit`/`write` 在
workspace-write 下正常，这一点也实测过。）

与 ADR 0006 相关的两条契约事实（来自源码）：

- 审批通道要求**开放中的轮次**：`approval.request()` 在轮次之外会抛「must be turn-enclosed」，
  因此演练必须发生在一次真实工具调用里。
- `approval.request()` 先追加 `approval/asked`，决定后追加 `approval/decided`
  —— **这条独立于插件的证据通道**留给以后核对用。

`question` 的观测还确认了 **waterfall 修复在运行环境真的生效**：用户收到了那个问题并作答
（旧代码会否决整条提问链，问题根本不会出现）。

`error` 的可复现触发方式：用 `workflow` 让一个子代理指向不存在的模型名 →
子代理 LLM 请求失败 → `agent/error` → `api-session/error`，同轮还落下持久的 `turn/end:error`。
**一次故障，两条路径各自被记录**，并都被正确判为子代理会话而静默
（`onlyRootSessions` 的在位证明）。

## 五、真实观测暴露的缺陷：载荷字段读错（同类错误第 3 次）

通知发出去了，正文却是：

```
DSH · 未知会话 正在等待你的回答：      ← 会话名退化、摘要为空
```

| 读法 | 真实位置 | 权威依据 |
| --- | --- | --- |
| `this.agent.id` | `request.agent.id` | 发射点 `ctx.waterfall(scopeTarget(agent, agent), 'user-questions/request', { ...request, agent }, noAnswerer)`；`dsh-scope` 路由键 `(args) => args[0]['agent']` |
| `payload.question` | `request.questions[0].question` | Event 契约 `AskUserQuestionRequestEvent = { questions: AskUserQuestionItem[]; agent?; signal? }` |

`approval/request` 的会话来源同样写错（`toolName` 是对的）。

### 为什么接线测试没抓到——以及这次怎么补

测试的载荷是测试自己编的：`{ question: '…' }`，会话从替身 `this.agent` 取。
**真机上 `this` 不是 Agent**：信号表里该行的会话栏为空，正是它的痕迹。

1. 载荷形状照抄 Event 契约，集中在 `scripts/event-harness.mjs` 一处并注明来源；
2. 替身的 `this` 改成**空对象**——任何人把会话改回 `this.agent`，测试立刻失败；
3. 替身的 `sessionQuery` **按 id 应答**。第一版忽略参数，于是「id 取错了照样查到标题」，
   变异没被抓到才发现——**一个忽略输入的替身会把「输入取错了」整类缺陷遮住**；
4. `npm test` 加 6 条断言，含**反向断言**：喂旧的自造形状时必须失败。

真机变异验证（两次都恢复原文件、SHA256 一致）：

- `payload.questions` → `[]`：报「正文里没有问题原文（{summary} 取错字段）」
- `payload.agent` → `this.agent`：报「正文里没有会话名（{session} 没解析出来）」

## 六、`npm test` 不再写用户的注册表

`apply()` 会调 `ensureProtocolRegistered()`，spawn 真的 Windows PowerShell 写
`HKCU\Software\Classes\dsh-session-alert`。替身挂载期间实测捕到了那个进程：

```
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass
  -File C:\Code\Projects\dsh-session-alert\scripts\register-protocol.ps1 -Scheme dsh-session-alert …
```

单元测试不该改用户的系统设置（幂等也不行）。现在 `freshHarness()` 在挂载前后临时把
`DSH_SESSION_ALERT_POWERSHELL` 指向不存在的路径（`notify.js` 已有的覆盖口子），
注册被跳过；`npm test --toast` 的真机冒烟不受影响（覆盖是临时且会还原的）。
修复后同一探针捕获到 **0** 个注册进程。

## 七、这一轮的教训（一句话版）

**「改动有没有生效」必须是一个可判定的问题，否则调参就是猜。**
本轮之前，这个项目在这一点上栽过三次：调样式数值、判决串新旧代码同形、
替身补上真机没有的东西。现在样式有审计、HMR 有 rebuilt 帧、状态有 `/state`，
三者都是机器可读的。

---

# 以下为 2026-09-25 第一轮的记录（保留原文）

## 当前状态

插件已**装进 `profiles/desktop` 并挂载**（`dsh-session-alert link:C:/Code/Projects/dsh-session-alert`，
`application=applied`）。已实测：

| 项 | 证据 |
| --- | --- |
| Host 半边挂载 | `GET /api/dsh-session-alert/state` → 200，配置与信号齐全 |
| 客户端半边上报端别 | `POST /api/dsh-session-alert/client-state` → 200 `{"ok":true,"liveKinds":["desktop"]}` |
| 投递链（自有 AUMID） | 插件 `test` 端点 → `{"ok":true,"code":0,"note":"toast（自有 AUMID）"}` |
| 启动器无控制台 | 日志 `GetConsoleWindow()=0 => NO_CONSOLE` |
| 启动器尺寸不变 | `rect 1721x927 -> 1721x927 unchanged=True` |
| 启动器置顶可逆 | `raised=true reverted=True topmost=False` |
| 协议方案已注册 | `HKCU\Software\Classes\dsh-session-alert` → 启动器命令，幂等，写入后回读校验 |
| **端到端：点通知按钮 → 窗口浮到最上层** | 人工确认 + 日志双证据，见下 |

### 端到端验证（本次交付的核心功能，已完成）

用户点击真实通知的按钮后，日志完整记录了整条链路，用户亦确认视觉结果：

```
args(3)=[dsh-session-alert://open/?session=e2e-16:18:21 | --hold | 8]
console: GetConsoleWindow()=0  => NO_CONSOLE（未分配控制台）
sessionId='e2e-16:18:21'                         ← 参数透传正确
form before: visible=True iconic=False zoomed=True
ShowWindow(SW_SHOWMAXIMIZED) = True
rect 1721x927 at(-7,-7) → 1721x927               ← 尺寸未变
SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE|...) = True
HOLD begin: 窗口将保持最上层 8 秒
HOLD end: SetWindowPos(HWND_NOTOPMOST) = True     ← 已还原，不留副作用
RESULT: raised=true reverted=True unchanged=True
```

用户确认：**窗口浮到最上层约 8 秒，尺寸没变。**

这次恰好原窗口就是最大化状态，因此同时检验了 ADR 0002 里那条「不得把最大化窗口缩小」
——`rect 1721x927 -> 1721x927 unchanged=True` 正是它要保证的。

**端别自报已在真实环境跑通**——`liveKinds:["desktop"]` 说明 ADR 0001 那条「客户端自报端别」
的判断在 desktop 应用里确实成立。

## 已修复：设置页报 HTTP 404

### 症状

用户截图显示设置页报「读取状态失败：**HTTP 404**」——不是 401，这个区别是关键：
请求**确实到达了** Host 的 HTTP 服务（`dsh-app://` 代理生效），但插件那条路由不存在。

### 两个真实缺陷

**一、路由形状不符合契约（主因）。** `WebRoute` 的契约是
`{ kind: 'exact' | 'prefix'; path: string; handler }`，而插件注册的是
`{ method: 'POST', path, handler }`：

- **没有 `kind`** —— 缺它的路由不按预期生效；
- **`method` 根本不是契约的一部分** —— `register` 不校验多余字段，所以不报错。

而 `webServer` 服务文档写明了未命中请求的去向：「the fallback handler answers anything
not yet claimed during startup with **404**」——正是设置页收到的那个 404。

修法：改为**一条 `kind: 'prefix'` 路由**覆盖 `ROUTE_PREFIX`，在其处理器内按
`request.method` 与端点名分派（前缀匹配是纯字符串前缀，所以 `…/state` 与 `…/state-extra`
都会进来，分派必须精确相等）；未知端点如实回 404，不静默落到某个分支。

**二、服务查询时机（次因，但同样致命）。** 原写
`const webServer = ctx.get('webServer'); if (webServer !== undefined) { …注册… }`。
若激活时该服务尚未就绪，**整块注册被静默跳过**，只剩一条 warn——路由全没了。

官方 practices 的写法是 `ctx.inject([...], (scopedCtx) => …)`；DSH 自己的
`client-connection` 正是 `ctx.inject(['webServer'], (webCtx) => { webCtx.webServer.register(route) })`。

### 为什么自检没抓到（这是更值得记的一半）

`events-wiring-check.mjs` 当时**只断言「路由条数 >= 2」，从不检查路由形状**，因此照旧全绿。
而它读状态的方式是「找路径以 `/state` 结尾的路由」——那对应的是「每端点一条路由」的旧设计，
形状错了也照样能找到。

现在补上的断言：路由数量为 1、**带 `kind` 字段**、`kind` 是 `prefix`/`exact`、
**不再带非契约的 `method` 字段**、路径等于契约前缀、handler 是函数；
以及逐端点探测分派——`GET /state` → 200、未知端点 → **404**、方法不匹配 → **404**、
`POST /client-state` → 200。

**只断言「注册了」不够，必须断言「形状对、分派对」。**

### 教训

修运行时错误时，若某个自检「一直是绿的」，要问的不是「它为什么没报错」，
而是「**它到底断言了什么**」。这条 404 拖到现在，就是因为那个自检断言的是件无关紧要的
事（条数），而真正出错的地方（形状）它从没看过。

## 已修复的一个严重缺陷：waterfall 监听器否决了用户的提问与审批

### 缺陷

`user-questions/request` 与 `approval/request` 的处理器**既不接收 `next` 形参也不调用它**，
且返回 `undefined`。而 cordis 的契约是
（`@deepseek-ai/cordis/lib/types/events.js`）：

> The last dispatch argument is treated as the innermost `next`. Listeners run
> outermost-first; **a listener that does not call `next()` vetoes the rest of the
> chain, including the built-in behavior.**

**也就是说本插件一直在阻断提问与审批流程。** 最坏情况下用户会看不到提问、
需要授权的工具会直接失败——而通知是附加功能，绝不该有这种后果。

### 为什么当时没发现

我在注释里写了「这是瀑布事件，我们只观察、不干预——不调用 next 也不改结果，
因此不会影响真正的答题流程」。**那句话是未经验证的假设，而且正好说反了。**

### 为什么接线测试也没发现

`events-wiring-check.mjs` 自己造了一个 `{agent, request}` 形状的载荷去喂处理器。
那个形状与真实事件不一致——真实签名是 `(this: Scoped<Agent>, request, next)`，
载荷就是 `request` 本身、`sessionId` 取自 `this`。**测试只证明了「我能喂饱我自己」。**

### 发现路径

它是在补「另三类事件的真实观测」时暴露的：用 `ask_user_question` 真的问了一个问题，
而信号表**没有**出现 `user-questions/request`。于是去查 `cordis_inspect_query` 的 Event
目录，看到真实签名与 `mode: waterfall`，才顺藤摸到这条契约。

**这正是「真实观测」与「接线测试」不能相互替代的原因**——也是既定验收标准里同时要求
两者的理由。

### 修法与测试加强

两个监听器改为普通函数（`this` 是 cordis 传入的作用域 Agent，箭头函数拿不到），
签名为 `function (request, next)`，观察逻辑包在 try 里，**末尾无条件 `return next()`**，
且把 `next()` 的结果原样透传。

测试加强是更重要的一半：逐场景用例改为按真实签名 `.call(scoped, payload, next)` 调用；
新增 4 条断言（两个监听器都必须调用 `next()` 且原样返回其结果）；替身提供作用域对象，
否则 `this.agent.id` 这条路径测不到。

**一个只观察的事件监听器若忘记 `next`，后果是阻断真实功能，而它在功能测试里可能表现为
「一切正常」**——因为处理器确实跑了、也确实没报错。因此这条断言必须独立存在。

### 附带确认

`session/event` 与 `api-session/error` 是 `emit` 模式，无需 `next`，写法正确。

### 审计已机器化并纳入 `npm test`

这类缺陷无法靠人工记忆避免，因此做成了检查：读源码里每个 `ctx.on(...)` 的注册，
按事件的 dispatch mode 逐个判断它是否正确地交出了决定权。

- [`scripts/listener-mode-audit.mjs`](../scripts/listener-mode-audit.mjs)：可复用模块，
  含 mode 表（来源是 `cordis_inspect_query` 的 Host Event 目录）
- 纳入 `npm test`：3 条断言，其中一条是**变异测试**——确认审计本身能抓到缺陷
- [`experiments/listener-mode-audit.mjs`](../experiments/listener-mode-audit.mjs)：
  独立入口，**复用模块而不做第二份实现**（两份逻辑迟早漂移，而漂移的那份不会有人发现）

**一个不会失败的检查等于没有检查。** 因此变异断言要求：喂一段缺 `return next()` 的源码
必须恰好报出一条问题；补上后必须通过；`emit` 模式带 `next` 形参也应被指出。
也手工做过真实变异（从 `lib/index.js` 去掉 `return next()`）→ 退出 1，恢复 → 退出 0。

mode 表里查不到的事件会让审计**失败**而不是跳过，以免新加监听器时漏审。

**一个尚未消除的风险：修复要等 DSH 重启才生效。** Host 半边在 DSH 进程内，
而插件无法自行重载宿主。在重启之前，运行中的插件仍是旧代码，**用户的提问与审批
仍会被它否决**。这不是可以「稍后处理」的事，已当面告知用户。

## 尚未完成

> **以下四项已在第二轮全部了结**（保留原文以显示当时的判断口径，逐条对应见上方第二轮记录）：
> 1. 三类事件 → `question`/`error`/`approval` **都已在真实会话中观测到**；
> 2. 设置页样式 → 人眼确认「正常了」+ 截图 + 机器读数（根因是 CSS 从未进文档，见第二轮）；
> 3. 铃声 → 用户确认听到；
> 4. 审批控件形态 → 仍为 ADR 0006 的不代答设计，且 18:09:20 那次真实审批验证了它。
>
> 第二轮另外发现并修掉了三处：样式注入死路、载荷字段读错、`npm test` 误写注册表。

1. **另三类事件的真实环境观测**：接线已用逐场景隔离测试验证通过（见「已确证」），
   但 `question` / `approval` / `error` 尚未在真实会话中各自触发一次。
   两者不重复：测试验证接线，真实观测验证「事件会不会到达」。
2. **设置页重做样式后的人眼确认**：上一次人眼确认是针对**旧样式**的，结论是「很丑」。
   新样式已按 DSH 原语重做，界面文本也已全部走 locale，但还没被人眼看过。
   官方还要求「明暗两种主题下都可读、并与同类宿主页面并排比较」。
3. **焦点抑制的「实际听到铃声」**：逻辑已实测出 `suppressed:chime-only`（计数
   `chimes: 5`），但「用户确实听到」这一环未单独确认。
4. **审批控件的最终形态**：已按 [ADR 0006](./adr/0006-approval-controls-do-not-decide.md)
   改为不代答（文案「去处理…」），放弃了 ADR 0003 的代答设计——因为查证发现
   `approval.request` 是请求方调用 answerer 的入口，要求开放中的轮次与同进程，
   而本插件是轮次之外的外部进程。**这是目标的验收口径需要跟着更新的一处**：
   目标里写的是「按已定决策补齐……」，而这条决策在实现阶段被证据推翻了。

## 已确证

### 界面文本全部走 DSH 的 locale 服务

字典注册进 `ctx.locale`（`zh` + `en`），组件里的界面文本经 `tx('key')` 取出。
组件内剩余的中文字面量只有 4 处，全部合理：3 处是**预览示例数据**
（给眼睛看的假值，不是界面文本），1 处是诊断用的 `console.error` 前缀。

**顺带修掉一个真实缺陷**：`text()` 原先只判断「服务返回非空字符串就采用」。
但 locale 的查找在命名空间与兜底链都没命中时会「showing the key itself」——
**它不抛错、不返回空，而是把键名当文本还回来**。直接采用的话界面上会出现一排键名
（`sectionGeneral` 之类），比缺一句话糟得多。现在把「等于键名」视为未命中，退到本地表。

这个缺陷是**替身写错时暴露的**：替身原本 `bind: () => (key) => key`（回显键名），
断言因此看到一排键名而失败。把替身改成「像真服务一样从已注册字典取词」之后，
既测到了服务路径，也顺带确认了这个回退判断是必要的。

### 一次性的迁移脚本不入 `experiments/`

把 73 处字面量改走 locale 用的是一个脚本。它**已执行完毕并从仓库删除**：
`experiments/` 放的是可复跑的人工验证工具，而一个已执行过的迁移脚本再跑一次会损坏文件。

该脚本第一版闯了祸，值得记下：规则表里写着「不动 TEXTS / SCENARIO_LABELS /
SCENARIO_DESCRIPTIONS 三张表」，但**那只是注释里的意图，代码里没有落实**。
它匹配「中文字面量」，而这三张表的值恰好就是中文字面量——于是把表自己的值也换成了
`tx('title')`，造成自我引用。替换 127 处，其中 54 处是错的。

**而且 `node --check` 通过了**（`tx('title')` 是合法表达式），所以它看起来没坏，
要等运行才炸。教训与其它几次同源：**边界必须是代码判断的，不能是注释里的一句话。**

### 设置页样式：从 DSH 的 UI 原语读出设计语言，而非自创

用户反馈旧样式「很丑」。根因有两个，都不是审美问题：

1. **说明文字没被包住。** `Toggle` 把 label 与 hint 平铺给 flex 容器，于是它们被排成
   同一行：长句说明横向溢出、与相邻字段糊在一起（用户截图里可见）。现包进
   `.dsa-toggle-text`。
2. **样式是自创的。** 输入框用 padding 而非固定高度、圆角与描边宽度随手写、
   没有 focus ring、错误色用错令牌。

**正确做法**（官方 practices 参考原文）：不得 import `@deepseek-ai/dsh-client-ui-primitives`，
而应「copy markup, CSS, and behavior from the primitive into the plugin」，
「Rename copied classes under your plugin's prefix, keep only `--dsw-alias-*` token
references」。

据此对齐（数值来自抽出的 CSS，可复核）：

| 元素 | DSH 的写法 |
| --- | --- |
| 输入框 | `height:32px`、`border:.5px solid --dsw-alias-border-l4`、`radius-md` |
| 复选框行 | `inline-flex` + `gap:6px`、16×16、`accent-color:brand-primary`、`:has(input:disabled)` |
| 按钮 | `height:36px`（sm 28px）、`radius-md`、`button-primary-fill` |
| 场景切换 | Pill：`height:24px`、圆角 999px、选中 `button-ghost-active-fill` |
| 卡片 | `settings-card-fill` / `settings-card-stroke` |

新增用到而此前完全没用的令牌：`--dsw-radius-sm/md/lg`、`--dsw-focus-ring-width/color`、
`--dsw-alias-border-l3/l4`、`--dsw-alias-interactive-bg-hover`、`--dsw-alias-label-dimmed`、
`--dsw-alias-state-business-primary`、`--dsw-alias-button-ghost-active-fill/border`、
`--dsw-alias-settings-card-fill/stroke`。

「behavior」也补了：开关加 `role="switch"` + `aria-checked`，场景切换器加
`role="tab"`/`aria-selected` 与容器 `role="tablist"` + `aria-label`。
官方原文强调抄样式时不能只抄外观——这些是「users rely on」的行为。

工具：[`experiments/extract-dsh-css.cjs`](../experiments/extract-dsh-css.cjs)
从 app.asar 按原始字节抽出这些 CSS，使数值可随时复核而不是「照抄后失传」。

### 界面文本已注册进 DSH 的 locale 服务

`ctx.locale.register(ns, locale, dict)` 用**非类型化**形式（类型化形式要求
`LocaleNamespaceMap` 里有声明，而那是 DSH 编译期的合并表，外部插件加不进去）。

`zh` 与 `en` 都注册：DSH 只有这两个内置语言（`LOCALE_IDS = ["zh", "en"]`），
且 `en` 是兜底语言——只注册 `zh` 的话，活动语言为 `en` 时所有键都会 miss 并退化成
把键名当文本显示。两个字典内容相同，理由见代码注释（界面语言与通知内容是两件事）。

一个坑：`register` 对同一 `(ns, locale)` 重复注册会抛（single occupant），
插件热重载时就会遇到，因此包在 try 里并注明这是预期情况。

### 降级链：刻意演练四级全部真实发生

`experiments/notify-degradation-drill.ps1`（破坏性，自带 `try/finally` 恢复 + SHA256 自证），
`DRILL_EXIT=0`，五个阶段 `FAIL=0`，快捷方式指纹前后一致。关键是**每一级都真的发生了**，
不只是"没报错"：

```
已改名：DSH Session Alert.lnk -> .lnk.drill-bak      <- 制造「自有 AUMID 未注册」
投递计划: [{后备 AUMID, code:5}]                      <- 自有 AUMID 根本没被尝试
后备 toast: code=5   [PASS] 回退到退出码 5
托盘气泡:   code=6   [PASS] 回退到退出码 6
恢复后计划: [{自有 AUMID, code:0}, {后备, code:5}] -> code=0
快捷方式指纹前后一致: True                            <- 破坏性操作已完整还原
```

「自有 AUMID 根本没被尝试」值得单列：未注册时试它只会得到「进操作中心但无横幅」，
而按退出码约定会报 `0`——那是个**假信号**。所以正确做法是根本不试。

### 无可见控制台：三条触发路径一起验证

判据是「监视期间有没有**新出现的可见**控制台窗口」，而不是「进程自报没控制台」——
两者都要，因为自报只能证明该进程自己。

| 触发 | 独立证据 | 是否落在监视窗口内 |
| --- | --- | --- |
| 协议激活（启动器） | `[41372]` @16:39:33，`rect 1721x927 -> 1721x927`，`raised=true reverted=True` | ✅ |
| 通知投递 ×2 | `[test]` @16:39:27 与 16:39:37，`via=toast（自有 AUMID）` | ✅ |
| 监视器结果 | **共捕捉到 0 个新出现的可见控制台窗口**（命中日志文件未生成 = 零命中） | — |
| 启动器自报 | `GetConsoleWindow()=0 => NO_CONSOLE（未分配控制台）` | — |

**「触发是否真的落在监视窗口内」必须单独确认。** 我第一次跑这个检查时把
`console-watch.ps1` 当成命令包装器用了（它是**定时监视**，`-Seconds` 期间旁路观察），
于是什么都没触发就得到一个"0 个控制台窗口"——那个数字毫无意义。
第二次用 `Start-Process` 后台起监视器、再触发，并用启动器日志与插件记录的时间戳
证明触发确实落在窗口内，这次才成立。

顺带记一个使用细节：`-LogPath` **只在捕获到控制台窗口时才写入**，因此
「日志文件不存在」= 零命中，不是脚本失败。

### 事件接线：四类场景逐场景隔离验证通过

[`experiments/events-wiring-check.mjs`](../experiments/events-wiring-check.mjs) 13 项断言全通过。
做法：替身 ctx 挂载插件 → 捕获它注册的事件处理器 → 投喂合成事件 → 从插件的 `/state`
路由读回信号表与活动列表。**逐场景隔离**是必须的：同一环境里连投七类事件会被限流挡掉
（实测 `approval` 与 `api-session/error` 因此变成 `skipped:rate-limit`），
而那不是接线问题——误报比不测更糟，因为它会让人去"修"一个本来就正确的地方。

| 事件 | 场景 | 渲染出的正文 |
| --- | --- | --- |
| `turn/end:completed` | `turnEnd` | `我的项目 · 修复登录超时 已完成一轮，等待你的下一步指令。` |
| `turn/end:error` | `error` | `我的项目 · 修复登录超时 执行出错：连接被拒绝` |
| `user-questions/request` | `question` | `我的项目 · 修复登录超时 正在等待你的回答：要不要保留旧的迁移脚本？` |
| `approval/request` | `approval` | `我的项目 · 修复登录超时 等待你的授权：工具 run_command` |
| `api-session/error` | `error` | `我的项目 · 修复登录超时 执行出错：会话失败：磁盘已满` |
| `turn/end:aborted(user)` | — | 跳过（`skipped:user-interrupted`） |
| `turn/end:forked` | — | 跳过（`skipped:forked`） |
| 子代理会话的 `turn/end` | — | 静默（`skipped:not-a-root-session`） |

工作区名与会话名都渲染正确（`{workspace}` 取 cwd 末段，`{session}` 优先标题）。

**这次自检还顺带确证了一件事**：跑出的判决串是 `sent:card-only`——形状标识是同一轮才
加的。此前从真实环境看不出来，是因为抑制路径的判决串（`suppressed:chime-only`）不带形状。
所以形状选择与审批文案的改动**都已在运行中生效**。

### 四类事件：`turnEnd` 已在真实会话中触发

信号表实录（plugin 的 `/state` 路由）：

```
source              session            verdict
turn/end:completed  session-2624…      suppressed:chime-only     ← 根会话，正常
turn/end:completed  427ad608-12b…      skipped:not-a-root-session ← 子代理，正确静默
turn/end:completed  275ce19f-c3f…      skipped:not-a-root-session ← 子代理，正确静默
```

一次性确认了三件事：

1. **`turnEnd` 真的会触发**，且模板渲染正确：
   `dsh-session-alert · 开发dsh会话通知插件 已完成一轮，等待你的下一步指令。`
   ——`{workspace}` 与 `{session}` 都填对了。
2. **根会话过滤在工作**：队友那两个子代理会话被正确静默，主会话正常。
3. **焦点抑制在工作**：`suppressed:chime-only` + 计数 `chimes: 4` ——卡片被扣下但铃响了 4 次。

这回答了「装上之后真的会提醒我吗」这个最基本的疑问。

### 设置页与形状选择

- 设置页已在真实环境注册（客户端 bundle 已含新增标记，因 `link:` 指向工作区）。
- 形状选择：`dispatch` 按「是否有 desktop 端在线」决定带不带按钮；判决串区分
  `sent:card+button` / `sent:card-only` / `suppressed:chime-only`。
- 离线自检 [`experiments/shape-check.mjs`](../experiments/shape-check.mjs) 9 项全通过，
  实测确认空 actions 时生成的脚本数组为空、守卫为假、不建按钮。

## HTTP 环回路由是正确的选择（此前的「应改回 host.call」已撤销）

`host.call` 来自**动态客户端半边**的闭包参数 —— runner 把 `host` 与 `harnessTrap`
作为参数注入：

```js
closure(react, console, styles, host, harnessTrap(), ...traps, undefined, undefined)
```

它对应 Host 半边的 `harness.handle(method, fn)`。**两者都只存在于动态半边。**

本插件的两个半边都是**静态**的（Host 用 `apply(ctx, config)`，Client 用
`window.__ModuleLoader__.load`），闭包里没有 `host`，因此 **`host.call` 在这里不存在**。

而且动态半边是靠**遮蔽全局量**来禁网络的：

```js
DYNAMIC_CLIENT_REDIRECTS = {
  fetch: "network belongs to the HOST half: register a handler there with
          harness.handle(method, fn) and call it here via host.call(method, args).",
  setTimeout: TIMER_REDIRECT, setInterval: TIMER_REDIRECT, …
}
```

静态 bundle 走 `require()` 模块表，这些全局量不被遮蔽 —— 这正是我的 HTTP 环回路由能
工作、而动态半边不能用的原因。

**所以 HTTP 环回路由是静态半边的合理选择**，不是「放弃了官方原语」。
（此前记的「应改回 host.call」基于一个不成立的假设，已撤销。）

这个区别还解释了一个**曾经的潜在缺陷**：`insertVariable` 里用 `setTimeout` 设置光标位置。
在动态半边里那会抛 `setTimeout is not available in a dynamic client half`。
本插件是静态半边所以能跑，但依赖这一点是脆的——已改为同步设置选区。

## 官方插件技能文档：本该最先读的东西

`@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/` 是 DSH 自带的插件开发
技能，含 `SKILL.md`、五份 references（host-plugin / ui-plugin / mcp-bundle / practices /
verification）与两个可直接拷贝的模板。

**入口是它，而不是逆向 bundle。** 我直到第 4 轮才发现它，此前的实现有几处是自己摸索的。
从它那里确认或纠正的关键几条：

| 条目 | 结论 |
| --- | --- |
| 不得 import `@deepseek-ai/dsh-client-ui-primitives` | 正确做法是**把 markup/CSS/behavior 抄进插件**，类名加自己的前缀，只保留 `--dsw-alias-*` 令牌引用。我做对了——但**原本打算直接 import，只是还没走到那一步** |
| 样式只用主题令牌 | 已符合 |
| 客户端半边注入 slots | 应声明 `inject: ['slots']` 并直接用 `ctx.slots.inject(...)`，而不是运行时 `ctx.get('slots')` 守卫 |
| `dsh.client.immediately` | 模板里有 `true`，我漏了 |
| 可访问性行为 | 开关需 `role="switch"` + `aria-checked`；这些是「users rely on」的行为，抄样式时不能只抄外观 |
| 不要 `require` 其它 Harness Client 包 | 已符合（只 `require('react')`） |
| 验证局限要显式说明 | 见 `references/verification.md` |

## 一个必须记住的区别：磁盘上的代码 ≠ 运行中的代码

**Host 半边在 DSH 进程内，改了 `lib/index.js` 后必须重新挂载插件才生效。**
`lib/client.js` 不同——它是客户端 bundle，刷新页面即可（且 `link:` 指向工作区，
文件改动立刻可见）。

这个区别害我做过一次**错误推断**，值得完整记下：

1. 我跑了 `experiments/events-wiring-check.mjs`，看到判决串是 `sent:card-only`
   （形状标识是那一轮才加的），于是断言「运行中已是新代码」。
2. 下一轮真实投递的记录却是**裸的 `sent`**：
   `16:35:25 [turnEnd] via=toast（自有 AUMID） reason=sent`
   ——运行中的 Host **仍是 16:07 挂载的旧代码**。

**错在哪里：** 那个自检是 `import('../lib/index.js')`，读的是**磁盘上的新文件**，
所以它测的必然是新代码。拿「一个专门测新代码的测试」的输出去推断「另一个进程里运行的
是什么」，这个推断本身就不成立。

这与本项目其它几次「断言错而代码对」是同一类错误：**先确认判据本身成立，再拿它下结论。**
判据应是「运行中进程的实际输出」，而不是任何从磁盘加载的结果。

顺带说明为什么之前一直没看出来：抑制路径的判决串（`suppressed:chime-only`）**不带形状**，
只有成功投递才带。所以在抑制开启的常态下，新旧代码的判决串长得一模一样。

## 验收工具（`experiments/`，均为人工调用，不并入 `npm test`）

本项目的验收标准要求「**刻意演练整条降级链**」，因此这些工具必须留在仓库里、
可被下一个人复跑。它们都是**破坏性的**（会临时改开始菜单快捷方式），
所以刻意不挂到 `npm test` 上——挂在旗标下迟早有人在 CI 或手滑时触发。

| 工具 | 作用 |
| --- | --- |
| [`notify-degradation-drill.ps1`](../experiments/notify-degradation-drill.ps1) | 降级链演练编排：前置校验 → 改名 → 逐阶段驱动 → `try/finally` 恢复 → **SHA256 自证** |
| [`notify-drill-phases.mjs`](../experiments/notify-drill-phases.mjs) | 七个阶段的实现（`baseline` / `content` / `fallback` / `balloon` / `restored` / `enoent` / `cleanup`） |
| [`notify-register-write-path.ps1`](../experiments/notify-register-write-path.ps1) | 注册脚本的**写入**路径：注销 → 重建 → 校验 → 真机投递 → 幂等 |
| [`notify-action-center-persist.mjs`](../experiments/notify-action-center-persist.mjs) | 操作中心留存探针——「第 8 条不需要写 ShowInActionCenter」的可复现证据 |

最后一份值得单独说明：它把那条被推翻的结论变成了**可重复验证的实验**，而不是只留一句
「已排除」。下次有人怀疑留存问题时，跑一遍即可，不必重新推一遍。

## 已排除的旧结论（不再作为待办）

- **「操作中心持久化需要写 `ShowInActionCenter=1`」—— 已排除。** 真因是分发器自己的
  `ExpirationTime`（5 秒的通知 5 秒后自然消失，实测 4 → 2 条），行为完全正确。
  不写该注册表值，跨进程的常驻通知都留在操作中心。证据见上面的留存探针。
  **差一点就按错误归因去永久改用户的通知设置** —— 这是本轮最该记住的一条。

## 已完成的收尾项

- ~~`scripts/selftest.mjs`~~ → 已落库（`55d6476`），`npm test` 直接可跑，47/47 通过。
- ~~降级演练与注册写入路径驱动器整理进 `experiments/`~~ → 已完成（4 份文件）。

## 一个待合并的重复

`lib/index.js` 曾计划自带一份 `runPowerShellScriptFile` 以复用 notify.js 的启动约束；
`notify-dev` 已导出其 `runPowerShellFile`，因此**最终没有重复实现**，Host 直接复用。
这一点值得保持：那条 `stdio:'ignore'` + `windowsHide:true` 的约束只应有一份实现，
抄一份迟早走样，而走样的表现是用户看到闪窗（ADR 0004）。

## 队友的验收证据（已收到部分）

- **launcher-dev**：四项全通过 —— PE Subsystem=2；最大化/最小化/隐藏三形态均 PASS 且矩形
  1721x927 不变；三形态期间可见控制台窗口 **0** 个。另修了一个真实缺陷：并发实例写日志时
  旧的 `File.AppendAllText` 会**静默丢整行**，已改为共享读写追加。
- **notify-dev**：离线单测 47 条全绿（注入假时钟/假定时器/假投递），覆盖限流、合并、去重、
  四个开关、时长钳制、抑制、按钮透传、脚本生成的注入安全。真机降级演练进行中。

## 实现中确定下来的关键事实

1. **一轮结束用 `session/event` 的 `turn/end`**，不是布尔状态事件。`reason.kind` 有 7 种
   （`completed`/`aborted`/`blocked`/`error`/`max-tokens`/`interrupted`/`forked`），
   能区分「正常结束」与「用户打断」——后者不该提醒。布尔状态事件做不到这一点。
2. **端别判据沿用 DSH 自己的四个标记**（`dataset.platform` 优先），不解析 user-agent。
3. **客户端上报走 HTTP 环回路由**：实测插件用 `ctx.webServer.register` 注册的路由
   **不需要凭据**（对照：无插件路由接管时落到 Host 的 `/api` 并返回 401）。
4. **在线状态按端别记且会过期**（90 秒 = 3 个心跳）：崩溃的客户端不会发「我走了」。
5. **抑制判定在 Host 侧**，不交给分发器——焦点是端别概念（ADR 0001 的边界）。
6. **`{workspace}` 取 `SessionHeader.cwd` 的末段**；`{session}` 优先标题、否则 id 前 12 位。
7. **根会话判定 fail open**：一切不确定都返回 true。漏报一个该提醒的会话，比多报一个
   子会话更糟。判定按 **id 比较**，绝不按对象同一性（事件载荷里的 Agent 实例不保证与
   `roots()` 返回的是同一个包装对象）。

## 实现中修掉的一个缺陷

`renderTemplate` 原先只匹配 ASCII 变量名，导致用户把占位符打错成 `{会话}`（中文）时会
原样留在通知里——用户看到花括号会以为插件坏了。改为匹配任意 `{...}` 并兜底清理残留括号。

## 实现阶段踩到的坑（都已固化进代码或注释）

这些都是**不会在单测里失败、只在真机上以难以归因的方式表现**的类型，值得单独记住。

1. **`ShowWindow` 的返回值不是「成功与否」，而是「窗口此前是否可见」。**
   对一个隐藏的窗口调 `SW_SHOW` 返回 `False` 是**预期值**。若按「返回值必须为 True」
   写验收，会把正确实现误判为失败。这条差点让启动器的隐藏形态验收走偏。
2. **PowerShell 用 `&` 调用 GUI 子系统 exe 不会等待它退出。**
   实测 9ms 就返回，且 `$LASTEXITCODE` 保持的是上一个 native 命令的值——
   于是「用 `$LASTEXITCODE` 判断产物自检结果」得到的是**假证据**（那个码来自编译器
   而不是产物）。必须用 `Start-Process -Wait -PassThru` 再看 `.ExitCode`。
3. **PE Subsystem 字段在 optional header 偏移 68，PE32 与 PE32+ 相同。**
   按「PE32 是 64」写会解析出 0。PE32 的 `BaseOfData` 多 4 字节，而 PE32+ 的
   `ImageBase` 是 8 字节，正好抵消。
4. **并发实例用 `File.AppendAllText` 写日志会静默丢整行。**
   它只共享读；两个实例同时写时整行消失。实测确实丢过——而丢日志的表现是
   「看起来那段代码没执行」，与「代码没生效」无法区分。已改为共享读写追加，
   并给每行加 `[pid]` 前缀（协议激活可被连点触发，多实例日志必须能归属）。
5. **输出文件被运行中的实例占用会让编译失败**（CS0016「另一个程序正在使用此文件」）。
   已加识别该错误串并重试。
6. **「隐藏 + 最小化」是规格外的第 5 种形态。** 只按单形态分派时，`SW_SHOW` 之后窗口
   仍停在最小化，用户还是看不见。已补 `if (wasIconic && IsIconic) SW_RESTORE`。

## 一条仍待裁决的设计缺口

启动器对「窗口找到了、但还原后仍不可见」的情形返回退出码 3，而不是 1。这个选择是
对的——报成 1（「未置顶但已还原」）会把「根本没还原成功」混进「只是没抢到前台」，
而后者是前台锁的设计行为、前者是真实缺陷。但**这个缺口本身说明规格不完整**：
四种形态之外还存在「还原失败」这一类结果，应当在规格里显式列出。

## 两处被实测推翻的旧结论（已更正文档）

1. **「操作中心需要写 ShowInActionCenter 才持久」——错。**
   真因是分发器的 `ExpirationTime`（见上文第 4 条）。不写该注册表值，常驻通知也留在
   操作中心。**已从待办中移除**。
2. **「管道 stdio 会被沙箱拦（EPERM）」——在当前策略下不成立。**
   那是上一个会话策略（`workspace-write`）下的观察；`danger-full-access` 下
   `'ignore'` / `'pipe'` / `'inherit'` 三者都正常。
   **结论不变**（`spawn` 仍用 `stdio: 'ignore'` + `windowsHide: true`），
   但**理由要改成真正的那个**：ADR 0004 的判据是 `GetConsoleWindow()` 返回 `NULL`，
   实测满足。原文档把「沙箱会拦」当作理由，会让后来者在不拦的环境里以为可以随便改。

## 一条方法论修正（比上面两条都重要）

队友把投递验证从「条数 > 0 就算成功」加强为**每条通知带一次性随机 `Tag`，回读操作中心
历史按 Tag 命中才算平台接受**。这个加强暴露了一件关键事实：

**未注册的随机 AUMID 一样会进操作中心历史**，所以「历史里有这条」**证明不了横幅出现过**。
横幅只由 AUMID 的注册状态保证。

因此分发器现在的行为是：**未注册时根本不尝试自有 AUMID** —— 试它只会得到「进了历史但
没有横幅」，而按退出码约定会报 `0`，那是个**假信号**。

这条值得单列，因为它纠正的不只是实现，而是**验证的判据本身**：
「看起来成了」与「证明得了」是两回事。本项目在验证阶段已经在这上面栽过一次
（转交授权后首次成功被当成稳定机制，复现失败才发现）。

