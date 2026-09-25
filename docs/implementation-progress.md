# 实现进度 — dsh-session-alert v0.2.0

本文件记录**代码实现阶段**的状态。设计决策见 [`docs/adr/`](./adr/)，
被实测证明的事实见 [`design-progress.md`](./design-progress.md)。
**接手请看 [`HANDOFF.md`](../HANDOFF.md)**，那里是结论与下一步。

---

# 2026-09-25 第五轮：通知最上方那一行 = 配置的通知署名

## 用户要的是什么（先把话说清楚）

用户说「通知标题有些问题：我想换的标题应当把 `dsh-session-alert` 替换掉，而不是放在通知
内容最上方」。实测把运行中的记录读出来之后才对齐：

```
DSH Session Alert          ← ① 应用名：Windows 按 AUMID 的显示名渲染，**不是** toast XML 决定的
Deepseek Harness           ← ② toast XML 的标题行（设置里的「通知标题」）
dsh-session-alert · 对齐桌面版继续未完成任务 已完成一轮，等待你的下一步指令。
                           ← ③ 正文（开头的 dsh-session-alert 是 {workspace} = 工作区目录名）
```

用户要的是 **① 显示他的署名**，而不是让署名再占一行（②）。

## 先做实验，再改结构

`<text id="1">` 只是正文上方那一行；① 由 Windows 按 AUMID 的显示名渲染。改它有两条件:

| 路线 | 代价 |
| --- | --- |
| 改注册表 `HKCU\Software\Classes\AppUserModelId\<AUMID>\DisplayName` | 一个值，快捷方式不动 |
| 重命名开始菜单快捷方式 | 快捷方式的名字同时是 `isAumidRegistered()` 的判据（`<AUMID>.lnk`），改名会让插件误判「未注册」而退回后备 AUMID——**把横幅来源换成 Windows PowerShell，比原问题更糟** |

因此先做了**一次可判定的实验**：只改那一个注册表值（已备份原值），发两条测试通知，
请用户读 ①。结果：**① 变成了 `Deepseek Harness`**。于是实现走轻的那条路。

## 实现

1. 新脚本 [`scripts/set-aumid-display-name.ps1`](../scripts/set-aumid-display-name.ps1)：
   幂等（值相同直接退出 0）、写入后**回读校验**、参数非法退出 4、回读不一致退出 3。
2. Host 在**挂载时**与**每次保存配置后**同步它；AUMID 是「挂载后才注册成功」的情形也补了一次
   （否则全新安装第一次会漏掉这一步）。同步成功后 `titleInAppName = true`。
3. `buildToastScript` 按发送者决定要不要写标题行：`titleInAppName` 为真时**自有 AUMID 不写**
   （那一行已经在最上面了），**后备 AUMID 始终写**（它的应用名是「Windows PowerShell」，
   去掉标题就完全看不出是谁发的）。
4. 同步失败**不假装成功**：`titleInAppName` 保持 `false`，toast 里继续写标题行——宁可
   一句话出现两次，也不要让通知没有标题；同时记一条 warn。
5. 设置页：字段改名为「通知署名」并加一句说明；诊断区新增一行「通知最上方那行」，
   显示它是已同步还是仍是注册名。
6. 验收工具 `post-restart-check.mjs` 新增一条**可机器判定**的检查：
   读注册表里的 `DisplayName` 与 `/state` 里的 `config.title` 比对——不需要人眼看通知。

## 顺带踩到并补上的一条硬约束：`.ps1` 必须是 UTF-8 BOM + CRLF

新写的脚本第一版是**无 BOM 的 UTF-8**，于是 Windows PowerShell 5.1 按 ANSI 读它，
中文全部乱码，**连代码结构都被读歪**：报出来的错是「DisplayName 不能为空」，
看起来像参数传错了。仓库里其它 `.ps1` 都是 BOM + CRLF，只有新文件不是。

现在 `npm test` 里有一条断言盯着：`scripts/` 与 `experiments/` 下每个 `.ps1` 都必须是
UTF-8 BOM 且无裸 LF。**注意 `edit` 工具写的是无 BOM 的 UTF-8**，所以编辑 `.ps1` 之后
必须重新补 BOM（这条断言会立刻抓到，本轮就抓到了两次）。

另外把参数校验从 `Write-Error` 改成 `[Console]::Error.WriteLine` + `exit 4`：
`$ErrorActionPreference = 'Stop'` 会把 `Write-Error` 变成终止错误，脚本在那之前就退出，
调用方拿到的是 1 而不是约定的 4——**诊断指错方向比不报错更费时间**。

## 实测

- 实验：改注册表前 ① 是 `DSH Session Alert`，改后 ① 是 `Deepseek Harness`（用户确认）。
- 脚本单测：幂等退出 0、写入并回读、非法参数退出 4、改回原值都实测过。
- `post-restart-check.mjs`：`ok 通知最上方那一行 == 配置里的通知署名`。
- `npm test` 70 → **73 条**（署名两条 + `.ps1` 编码一条）。

---

# 2026-09-25 第四轮：按场景发送预览（取代「发一条测试通知」）

## 一、按钮搬家：从通用测试通知 → 「通知内容」卡片里按场景发

原先页面上有一条「发一条测试通知」，它发的内容与任何场景都无关。现在：

- 那条按钮**删掉了**；发通知的入口移到「通知内容」卡片里、**预览的正下方**：
  「发送这条通知」按**当前选中的场景**真发一条。
- 正文由**客户端**给出（就是预览区显示的那一行），Host 只负责策略与投递。
  这样「看到什么就发什么」是由构造保证的，而不是靠两处渲染实现碰巧一致。
- 判决串多了一种形态：`preview:card+button`（与真实事件的 `sent:` 区分开），
  活动列表里 `reason: 'preview'`。

### 预览投递的语义（`AlertDispatcher.dispatch({ bypass: true })`）

只绕该绕的：

| 绕 | 为什么 |
| --- | --- |
| 总开关 | **不绕**。「别给我发通知」是明确意图，此时应如实回一句，而不是照发 |
| 场景开关 / 场景最小间隔 / 限流 / 抑制 | 绕。用户当场按下的动作被静默扣下，只会让他以为按钮坏了 |
| 去重 | 绕。连点两下就该看到两条；而且预览**不污染去重表**，否则同样正文的真实事件会被误判成回声 |
| 限流窗口与「该场景上次提醒时刻」 | **不记录**。否则点两下预览就能把一条真实提醒挤掉，而用户不会预料到 |

活动列表照记（`reason: 'preview'`）——「刚才那条到底发出去没有」必须能查。

Host 侧新增 `POST /notify { scenario, body }`：未知场景回 **400** 并列出可用值，
空正文回 **400**（空模板渲染出来就是空，不该发一条空白通知），超长回 **400**。
`/test` 端点保留（无界面入口），它是「投递链到底通不通」的 curl 冒烟入口。

## 二、补测过程中暴露的三个「判据本身不对」

这一轮有三处是**测试自己错了**，都值得记下来——它们的共同点是：断言看起来在检查一件事，
实际检查的是另一件事。

1. **路由探针把「正文里含『未知端点』」当作 404、其余一律记 200。**
   于是任何**非 404 的失败**（比如新加的 400）都被记成 200，断言「应当回 400」时
   拿到的是 200。修法：替身响应保存 `statusCode`，探针读真实状态码。
2. **行为审计的快照是手抄的，其中 `contract.scenarios` 写成了空数组。**
   于是 `TemplateEditor` 找不到场景、`return null`，**整个「通知内容」卡片在树里不存在**，
   审计报「找不到发送按钮」——那是审计自己的数据不对。修法：快照的 `config` 与 `contract`
   **直接取自契约**（`defaultConfig()` / `SCENARIOS`），只有运行时字段才是手写的。
3. **审计把「改了哪个字段」写死成 `rateLimit.max`。** 页面上第一个数字输入框其实是
   模板编辑器的「显示时长」，于是它报了一个假失败。修法：改成**逐叶比较**——
   「恰好一处叶子变化、且新值就是刚输入的那个数」，与页面结构无关，而且更严。

## 三、实测

- 客户端半边已热重载；「发送这条通知」按钮与文案已在页面里。
- **Host 侧改动（`/notify` 路由与 `bypass` 语义）需要重启 DSH**：重启前点按钮会拿到
  404，界面会如实显示「发送失败：未知端点…」（这也是它对失败诚实的证明）。
- `npm test` 65 → **70 条**：新增 5 条（4 条 bypass 语义 + 1 条预览接口的 400），
  行为审计新增「发送按钮存在、且发出的正文与预览逐字相同」的断言与 1 条变异。

---

# 2026-09-25 第三轮：默认配置、自动保存、标签名本地化

用户提出的三项改动，都已落地并各自配了机器判据。

## 一、默认配置：间隔一律不限，显示时长按场景给

| 场景 | 最短间隔 | 显示时长 |
| --- | --- | --- |
| `turnEnd`（轮次结束） | 0（不限） | **30 秒** |
| `question`（等待回答） | 0 | 0（常驻） |
| `approval`（等待授权） | 0 | 0（常驻） |
| `error`（执行出错） | 0 | 0（常驻） |

改法上有一处刻意的结构调整：**每个场景的默认值放进 `SCENARIOS` 表自己身上**
（`defaultMinIntervalSeconds` / `defaultDurationSeconds`），`defaultConfig()` 只读表。
原先写的是 `scenario.id === 'approval' ? 30 : 0` 这样的条件表达式——它把「这个场景多久
提醒一次、通知留多久」从场景定义里拆了出去，读定义时看不到，加场景时也容易漏。

`durationSeconds = 0` 的语义是**常驻**（直到用户手动关闭），而不是立刻消失：提问、授权、
出错这三类都要人动手，等通知自己消失只会让人以为没事了。

**注意生效范围**：默认值只补「配置文件里没有写」的字段。用户已保存的值原样保留——
这一点有断言盯着（`归一化只补缺失字段，不覆盖用户已保存的值`），因为「升级时把用户的
调整悄悄改掉」比「默认值不好」严重得多。本轮实测读取用户配置时，这四个字段**已经是
上表的值**，因此行为层面无需再动。

## 二、自动保存：没有保存按钮

**触发点有三个**（缺一个都会丢改动）：

1. 编辑停止 `AUTOSAVE_DEBOUNCE_MS = 700ms` 后防抖落盘。防抖不是为了省请求，而是因为
   「把 30 打成 3」的那一瞬间也是一次合法改动，立刻落盘会把 `3` 写进配置文件。
2. **组件卸载**——用户切换设置分区、或关掉设置面板。这正是用户点名要的那一刻。
3. `pagehide`——应用被关掉时，防抖计时器可能来不及触发。

实现里有四处不写清楚就会踩的地方：

- **草稿必须放 `useRef` 而不是 state**：卸载时的清理函数与 `pagehide` 监听器是
  **第一次渲染**那次闭包创建的，读 state 只会读到装载时的旧值。
- **比较「有没有新改动」要用键序无关的序列化**（`stableJson`）：服务端归一化后重建的
  对象键序可能与草稿不同，于是「其实没改」会被判成「改过了」，**保存按钮没了以后这就是
  一个自咬循环**（存完又发现改动 → 再存）。这条有断言盯着。
- **在途请求 + 排队**：一次保存在途中又改了草稿，就在它回来后再存一次；不这么做，
  两次请求可能乱序落地，最后留在盘上的是旧值。
- **服务端归一化的回填只在用户没有再改时进行**：否则会把用户正在输入的内容覆盖掉——
  那是「自动保存」最容易造成的伤害。钳制值仍会回填，因为「我填了 999 却生效了 60」
  同样是让人以为插件坏了的情形。

界面侧：删掉保存按钮，改为一行说明「改动会自动保存（切换或关闭设置页时立即写入）」，
外加 `正在保存… / 已自动保存。/ 保存失败：…` 的状态与告警。

## 三、设置页标签名按语言给

- 中文：**会话通知**
- 其余语言（DSH 只有 `en`，且它是兜底语言）：**Session Alert**

做法是把字典拆成「中文基准表 + 英文覆盖表」，两份**只有 `title` 不同**。
其余键两种语言下仍是中文，理由没变：本插件的**通知模板**本身是中文的，
界面切成英文而通知是中文会更怪；DSH 自己的设置页在这个语言下的键也是中文的。

`label` 传的是**函数**（`() => text(translateBound, 'title')`），这一点与宿主契约一致——
`settings.section` 的 catalog 原文写着：「A thunk is re-read on every projection, so
localized text follows the active locale without re-registering.」
因此语言切换不需要我们重新注册。

## 四、验证：新增「行为审计」+ 替身补齐三样能力

`npm test` 从 62 条增到 **65 条**，其中三条属于新的
[`scripts/client-behavior-audit.mjs`](../scripts/client-behavior-audit.mjs)。
它不看源码里有没有某个字符串，而是真的把组件挂起来、改一个字段、推着计时器走，
看它有没有把改动写到 Host。覆盖四种失败：永远不保存、每敲一下就写盘、
**切换/关闭设置页时没落盘**、以及上面那个自咬循环。

要让这些测得到，替身必须先补齐三样能力，否则它们**在替身里根本不存在**：

| 能力 | 不补的后果 |
| --- | --- |
| `useRef` 跨渲染保留 | ref 每次渲染都是新盒子，自动保存逻辑在替身里全错、在真机上却是对的 |
| 依赖数组比较 | 效应每渲染必重跑，「卸载时保存」会表现成「每次渲染都保存」 |
| 卸载时逆序跑清理 | 「切换/关闭设置页时保存」这条需求**无法被验证** |

这三条连同「状态格按组件隔离」一起写在 [`scripts/client-react-stub.mjs`](../scripts/client-react-stub.mjs)
的注释里；替身从 `experiments/settings-render-check.mjs` 抽出来做成共用模块，
两个入口不再各留一份。

### 顺带修掉一个只在 `npm test` 里出现的坑

两个审计模块**各有各的自增计数器、都从 1 开始**，于是第一次运行造出了
**一模一样的 `data:` URL**——`import()` 按 URL 缓存，第二次模块体根本没执行，
报出来的却是「源码没有调用 `window.__ModuleLoader__.load`」（看着像源码坏了）。
现在唯一性由 [`uniqueSourceUrl()`](../scripts/client-style-audit.mjs) 统一负责，
并带上进程与随机成分。教训与其它几次同源：**假失败和假通过一样有害**，
而这条只在「两个审计在同一进程里先后跑」时出现，也就是**只在 `npm test` 里出现**。

### 实测

- 客户端半边（自动保存 + 标签名）**已热重载**：rev `dcd8d74d3f10 → 94546854660e`，
  且从 HTTP 取回的 bundle 与磁盘 `lib/client.js` **逐字节相同**（只差 74 字节 sourcemap 尾部）。
- 默认值改动在 **Host 半边**，需重启才生效；但用户已保存的配置里这四项**已经是目标值**
  （实测读 `/state` 与配置文件确认），因此行为不受影响。
- 改配置走的是插件自己的 `POST /config`（`ok=true persisted=true`），即经过归一化与原子写入。

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

