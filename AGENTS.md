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

## 写测试/替身时的第 4 条（本项目栽过四次）

**替身比生产代码更需要被怀疑。** 已发生的四种形态：

| 形态 | 后果 |
| --- | --- |
| 替身补上真机**不存在**的东西（`globalThis.styles`） | 一条在真机上永不执行的分支被测试「验证」了 |
| 替身自造**载荷形状**（`{ question }` + `this.agent`） | 事件接线全绿，真机通知正文是「未知会话…」 |
| 替身给 `this` 补上真机没有的 `agent` | 从 `this` 取会话的错误写法照样通过 |
| 替身**忽略输入**（`sessionQuery` 不按 id 应答） | 「id 取错了」整类缺陷被遮住，变异没被抓到 |

因此：替身只提供真实环境确实有的东西；输入要真的用上；每条关键断言都配一条
**反向断言**（喂错误形状必须失败）。

## 常用命令

```powershell
npm test                                     # 60 条离线断言
npm test -- --toast                          # 额外真发一条通知（真机冒烟）
node experiments/post-restart-check.mjs      # 重启后先跑这条：逐项判定哪些修复已生效
node experiments/events-wiring-check.mjs     # 事件接线（真实载荷 + 瀑布 next() 断言）
node experiments/client-style-audit.mjs --mutate  # 样式注入审计 + 变异检查
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
