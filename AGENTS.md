# dsh-session-alert

DSH 会话提醒插件：会话需要你介入时发一条可点击的 Windows 通知，
点击后把 DSH 窗口显示到最上层。Windows 专用。

## 新会话请先读

**[`HANDOFF.md`](./HANDOFF.md)** —— 交接说明。它刻意区分「已验证」与「只是声称」，
写明**每条结论各自靠什么站住**，以及可判定的判据：
`node experiments/post-restart-check.mjs` 一条命令就能回答「哪些修复已在运行环境生效」。

## 三条最容易踩的前提

1. **半边不同，生效方式不同。**
   - 改 `lib/client.js`：**不用重启**。DSH 自带 `client-hmr` 每 500ms 检查 bundle，
     有变化就推 `rebuilt` 帧、页面重新物化——保存后约 1 秒生效。
     确认方法：`curl -sN --max-time 3 http://127.0.0.1:19387/plugins/events`
     应出现 `{"type":"rebuilt","id":"dsh-session-alert",...}`。
   - 改 `lib/index.js`：**必须重启 DSH**。`dsh-hmr` 默认忽略 `**/node_modules`，
     而本插件是经 profile 的 `node_modules` 链入的，因此 Host 半边不在监听范围内。
   **改完没确认生效就下结论，是本项目反复出错的第一原因。**
2. **要截图，不要自己推理；但截图之外还有机器通道。**
   `curl -s http://127.0.0.1:19387/api/dsh-session-alert/state`
   （插件注册的路由**不需要凭据**）能读到信号表、判决串、计数与样式实测读数。
3. **写 DSH 插件的正确入口是官方技能文档**
   `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/`
   （用 `node experiments/asar-read.mjs list|read|grep` 读，shell 工具打不开 asar）。
   官方明令**不得 import** `@deepseek-ai/dsh-client-ui-primitives`——
   正确做法是把 markup/CSS/behavior 抄进插件、类名加自己前缀、只留 `--dsw-alias-*` 令牌。

## 写测试/替身时的第 4 条（本项目栽过六次）

**替身比生产代码更需要被怀疑。** 已发生的六种形态：

| 形态 | 后果 |
| --- | --- |
| 替身补上真机**不存在**的东西（`globalThis.styles`） | 一条在真机上永不执行的分支被测试「验证」了 |
| 替身自造**载荷形状**（`{ question }` + `this.agent`） | 事件接线全绿，真机通知正文是「未知会话…」 |
| 替身给 `this` 补上真机没有的 `agent` | 从 `this` 取会话的错误写法照样通过 |
| 替身**忽略输入**（`sessionQuery` 不按 id 应答） | 「id 取错了」整类缺陷被遮住，变异没被抓到 |
| 替身**少模拟一样 React 能力**（ref 不跨渲染、效应无依赖比较与清理） | 「切换/关闭设置页时保存」这条需求根本没法被验证 |
| 两个审计**各自的自增计数器都从 1 开始** → 同一个 `data:` URL | `import()` 命中缓存、模块体没跑，报出来的却是「源码没调用 load」 |

因此：替身只提供真实环境确实有的东西；输入要真的用上；**该模拟的能力一样不能少**；
每条关键断言都配一条**反向断言**（喂错误形状必须失败）。
唯一 URL 由 `uniqueSourceUrl()` 统一负责，别自己写计数器。

## 两条与 Windows/PowerShell 有关的硬约束

1. **`.ps1` 必须是 UTF-8 BOM + CRLF**：Windows PowerShell 5.1 会按 ANSI 读无 BOM 的文件，
   中文变乱码、**代码结构也会被读歪**（实测报出来的是「DisplayName 不能为空」，看着像参数错了）。
   `npm test` 有一条断言盯着。**注意 `edit` 工具写的是无 BOM UTF-8**——改完 `.ps1` 要重新补 BOM。
2. **通知最上面那一行不是 toast 标题**：它由 Windows 按 AUMID 的**显示名**渲染，
   而 `<text id="1">` 是它下面那一行。插件把显示名同步成配置里的通知署名
   （`scripts/set-aumid-display-name.ps1`），同步成功后自有 AUMID 就不再写标题行
   （后备 AUMID 始终写）。**不要为了让那行改名去重命名开始菜单快捷方式**：
   快捷方式的名字是 `isAumidRegistered()` 的判据，改名会让插件退回后备 AUMID。
   **通知左侧那个图标同理只能靠应用身份**（注册表 `IconUri` + 快捷方式图标，由
   `npm run build:icon` 从 DSH 自己的 `resources\icon.png` 生成多尺寸 ICO）。
   **不要在 toast XML 里写 `<image placement="appLogoOverride">`**：那会在**正文里多出一个
   图标**（用户实测反馈：「标题的图标正常，内容为什么还有一个图标？」）。XML 里一个 image 都不写。
3. **动作的结果必须报在动作旁边。** 「发送这条通知」的按钮在页面中部，而提示一开始报在
   页面底部的「操作」行——用户点了按钮、结果出现在屏幕外，反馈就是「按了没反应」。
   `notice` 因此带 `where`，行为审计会用**祖先链**断言提示确实在按钮那一行里。
   同理，失败提示要说清**下一步该做什么**（404 = Host 半边没重启，就直说）。
4. **Host 半边改了必须重启，重挂载插件不能替代。** 实测：用插件管理器把
   `include:session-alert` 禁用再启用，插件确实重新挂载（`/state` 401 → 200），
   但**跑的还是旧代码**——cordis Loader 复用 Node 的 ESM 缓存（按 URL 缓存）。
   验证新 Host 代码是否在跑，看 `/state` 里的新字段，不要靠「我刚重启过」的记忆。
5. **PowerShell 变量名大小写不敏感**：`param([string]$Source)` 与 `$source = …` 是**同一个
   变量**。踩过一次：函数体里读 `$script:source` 得到 `$null`，`$Size / $null` 报
   「Attempted to divide by zero」——报错指向除法，真因是命名冲突。函数要用什么就显式传参。
6. **投递路径只有「真的投递」才走得到，离线测试看不到它。** 踩过一次：宿主为了让投递带上
   额外字段而包了一层 `send`，里面引用了没导入的 `sendWindowsToast` —— 每次投递都在运行时
   失败，而**全部离线测试是绿的**、界面上还写着「已发送」。
   两道防线：`node scripts/selftest.mjs --deliver`（真发一条，覆盖宿主的投递接线）与
   `post-restart-check.mjs`（**最近一次投递失败就让验收失败**）。
   因此给投递加字段时**别让宿主去包 `send`**——用 `sendExtras` 交纯数据。

## 常用命令

```powershell
npm test                                     # 78 条离线断言（不真发通知）
node scripts/selftest.mjs --deliver          # 额外真发一条：**唯一覆盖宿主投递接线的检查**
npm test -- --toast                          # 额外真发一条通知（走 notify.js 的投递链）
npm run build:icon                           # 从 DSH 自己的图标重新生成通知图标（assets/）
node experiments/post-restart-check.mjs      # 重启后先跑这条：逐项判定哪些修复已生效
node experiments/events-wiring-check.mjs     # 事件接线（真实载荷 + 瀑布 next() 断言）
node experiments/client-style-audit.mjs --mutate     # 样式注入审计 + 变异检查
node experiments/client-behavior-audit.mjs --mutate  # 自动保存行为审计 + 变异检查
node experiments/stylesheet-validate.mjs     # 注入的 CSS 是否合法
node experiments/listener-mode-audit.mjs     # 监听器 dispatch-mode 审计
node experiments/settings-render-check.mjs   # 设置页渲染（自制替身，不是验收证据）
node experiments/asar-read.mjs list|read|grep   # 读 DSH 的 app.asar
```

`experiments/` 下多为**破坏性的人工验证工具**，刻意不并入 `npm test`。

## 文档

- [`CONTEXT.md`](./CONTEXT.md) —— 术语表
- [`docs/adr/`](./docs/adr/0001-client-kind-and-announcement-shape.md) —— 六条设计决定
  （**0003 已被 0006 取代**）
- [`docs/design-progress.md`](./docs/design-progress.md) —— 设计结论 +
  **16 条已验证的实测知识**（PowerShell / Windows UI 的各种坑）
- [`docs/implementation-progress.md`](./docs/implementation-progress.md) —— 实现进度
- [`docs/session-event-timeline.md`](./docs/session-event-timeline.md) —— 事件时间线的判定方法
