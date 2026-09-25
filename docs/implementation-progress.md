# 实现进度 — dsh-session-alert v0.2.0

本文件记录**代码实现阶段**的状态。设计决策见 [`docs/adr/`](./adr/)，
被实测证明的事实见 [`design-progress.md`](./design-progress.md)。

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

## 尚未完成

1. **另三类事件的真实环境观测**：接线已用**逐场景隔离测试**验证通过
   （见下方「已确证 · 事件接线」），但 `question` / `approval` / `error` 尚未在真实会话中
   各自触发一次。两者不重复：测试验证接线，真实观测验证「事件会不会到达」。
2. **设置页到 GUI 里人工过一眼**：代码已实现、渲染路径已自检，但没有人眼确认过布局与交互。
3. **焦点抑制的「实际听到铃声」**：逻辑已实测评测出 `suppressed:chime-only`（计数
   `chimes: 5`），但「用户确实听到」这一环未单独确认。
4. **审批控件的最终形态**：已按 [ADR 0006](./adr/0006-approval-controls-do-not-decide.md)
   改为不代答（文案「去处理…」），放弃了 ADR 0003 的代答设计——因为查证发现
   `approval.request` 是请求方调用 answerer 的入口，要求开放中的轮次与同进程，
   而本插件是轮次之外的外部进程。**这是目标的验收口径需要跟着更新的一处**：
   目标里写的是「按已定决策补齐……」，而这条决策在实现阶段被证据推翻了。

## 已确证

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

