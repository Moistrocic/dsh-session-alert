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

1. **四类事件的实际触发**：`turnEnd` 已确认真实触发（见下方「已确证」），
   另三类（`question` / `approval` / `error`）的接线完成、投递路径也分别验证过，
   但尚未在真实会话中各自观测到一次。
2. **设置页的完整配置界面**：已完成（见下方「已确证」）。剩余的是**在 GUI 里人工过一眼**。
3. **ADR 0002 的审批卡片形态**：普通卡片（一个确认按钮）与无控件形态已实现；
   审批卡片应是**批准 / 拒绝两个按钮且没有确认按钮**，尚未实现。
4. **审批按钮的代答路径**（ADR 0003）：批准/拒绝要真的把决定提交给 DSH。技术路径未落地。
   已知可用原语是客户端半边的 `uiWorkspace.openSession`（见 design-progress 5.2），
   但「Host 把决定回传给客户端」这条通道尚未验证——动态插件通道是浏览器→Host 单向的。
5. **焦点抑制的真机验证**：逻辑已接且实测有 `suppressed:chime-only` 记录（见下方），
   但「用户实际听到铃声」这一环未单独确认。
6. **Host 半边改动的重挂载**：Host 代码在 DSH 进程内，改动需重新挂载插件才生效。
   本轮的三项改动（设置页、形状选择、判决串）**客户端部分即时可见**（`link:` 指向工作区），
   Host 部分待下次重挂载验证。

## 已确证

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

