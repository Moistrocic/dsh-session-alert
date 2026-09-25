# dsh-session-alert

DSH 会话提醒插件：会话需要你介入时发一条可点击的 Windows 通知，
点击后把 DSH 窗口显示到最上层。Windows 专用。

## 新会话请先读

**[`HANDOFF.md`](./HANDOFF.md)** —— 交接说明。它刻意区分「已验证」与「只是声称」，
并写明当前唯一的阻塞点与下一步该怎么查。

## 三条最容易踩的前提

1. **改动要重启 DSH 才生效。** Host 半边在 DSH 进程内；桌面端也无法刷新页面，
   必须重启应用。**改完没重启就下结论，是上一个会话反复出错的原因。**
2. **要截图，不要自己推理。** 上一个会话从「401」猜到「通信拓扑」查了两轮，
   直到用户给截图才看到写的是 **404**，方向立刻清楚。
3. **写 DSH 插件的正确入口是官方技能文档**
   `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/`
   （用 `node experiments/asar-read.mjs list|read|grep` 读，shell 工具打不开 asar）。
   官方明令**不得 import** `@deepseek-ai/dsh-client-ui-primitives`——
   正确做法是把 markup/CSS/behavior 抄进插件、类名加自己前缀、只留 `--dsw-alias-*` 令牌。

## 常用命令

```powershell
npm test                                   # 50 条离线断言
node experiments/events-wiring-check.mjs   # 事件接线（含瀑布 next() 断言）
node experiments/stylesheet-validate.mjs   # 注入的 CSS 是否合法
node experiments/listener-mode-audit.mjs   # 监听器 dispatch-mode 审计
node experiments/settings-render-check.mjs # 设置页渲染（自制替身，不是验收证据）
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
