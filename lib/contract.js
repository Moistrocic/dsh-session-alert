/**
 * 跨半边共享的契约。
 *
 * 这里只放「Host 半边、浏览器半边、以及外部启动器三方都必须一致」的东西。
 * 任何一方单独改动都会让链路静默失效，因此集中在一处并写清不可改动的原因。
 *
 * @module dsh-session-alert/contract
 */

/** 插件名。与 package.json 的 name 一致，也用作 loader 条目 id 的来源。 */
export const PLUGIN_NAME = 'dsh-session-alert'

/**
 * 自有协议方案名。
 *
 * 为什么不能改用 DSH 自带的 `dsh:`：实测 `dsh:` 只做两个字符串的字面比较
 * （`dsh://open` / `dsh://open/`），完全不解析参数，而且在 Windows 上那个处理器
 * 根本不触发（`open-url` 在 Electron 里仅限 macOS）。因此它无法携带会话 id，
 * 也无法指向我们自己的启动器。
 *
 * 改动此值必须同时改：注册表注册的命令、通知按钮的 arguments、启动器的解析。
 */
export const PROTOCOL_SCHEME = 'dsh-session-alert'

/**
 * 通知呈现用的 AUMID（应用用户模型 ID）。
 *
 * 它决定通知横幅上显示谁的名字，也决定横幅是否真的出现——未注册的 AUMID 是合法
 * 发送者，但通知会被接受进操作中心却**不显示横幅**，所以「API 没抛异常」什么也证明
 * 不了。发送者由**注册状态**选择，而不是靠乐观。
 *
 * 不要改名：它已在系统注册（HKCU 的 AppUserModelId 键 + 开始菜单快捷方式），
 * 改名会让横幅退回「借用 Windows PowerShell 身份」的状态。
 */
export const PRIMARY_AUMID = 'DSH Session Alert'

/**
 * Windows 必然认识的后备 AUMID。
 *
 * Windows PowerShell 自带一个带此 AUMID 的开始菜单快捷方式，因此在任何机器上都已注册。
 * 自有 AUMID 未注册时借它兜底，使横幅仍然能出现。
 *
 * 注意这是**未见于微软文档**的事实（见 docs/design-progress.md 的须验证项）：
 * 它依赖那个快捷方式存在。因此发送前必须先探测自有 AUMID 的注册状态。
 */
export const FALLBACK_AUMID =
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

/**
 * 投递路径。投递脚本用退出码汇报实际走通了哪一条，便于诊断与验收。
 *
 * 重新实现投递脚本时必须保持这套约定，否则这个验证信号失效——
 * 退出码是唯一能区分「平台接受了通知」与「什么都没发生」的依据
 * （`Show()` 不返回任何有用信息）。
 */
export const DELIVERY_CODES = {
  0: 'toast（自有 AUMID）',
  5: 'toast（Windows PowerShell AUMID 后备）',
  6: '托盘气泡后备',
}

/** 单条通知正文的长度上限。 */
export const SUMMARY_LIMIT = 200

/** 请求体上限。设置页只提交小配置补丁，这个上限很宽松。 */
export const BODY_LIMIT_BYTES = 128 * 1024

/** 设置页路由前缀。 */
export const ROUTE_PREFIX = '/api/dsh-session-alert'

/**
 * 构造通知按钮要激活的 URL。
 *
 * 形状已实测：协议激活时 Windows 把 URL **原样**作为第 1 个位置参数交给处理程序
 * （系统会规范化，例如补上结尾斜杠变成 `…://open/?session=x`）。启动器从查询串里
 * 解析会话 id，因此这里必须是完整 URL，而不是 `--session` 那种开关。
 *
 * 方案名取自本文件顶部的 {@link PROTOCOL_SCHEME}，改那一处即可。
 *
 * @param sessionId - 要跳转到的会话 id。
 * @returns 可放进 toast action `arguments` 的 URL。
 */
export function protocolUrl(sessionId) {
  const id = typeof sessionId === 'string' ? sessionId : ''
  return `${PROTOCOL_SCHEME}://open/?session=${encodeURIComponent(id)}`
}

/**
 * 客户端上报端别与焦点所用的包内 RPC 方法名。
 *
 * 为什么用包内 RPC 而不是 HTTP 路由：Host 的 `/api` 通道要求一个浏览器侧拿不到的
 * 凭据（实测未带凭据请求返回 401），而包内私有 RPC（客户端 `host.call` ↔ Host 侧
 * `harness.handle`）正是为「同一包的两个半边互相对话」设计的可用通道。
 *
 * 两侧都必须用这里的名字：改一处漏一处会让上报静默失效，而失效的表现是
 * 「端别永远判为未知」，不会报错。
 */
export const RPC_CLIENT_STATE = 'client-state'

/**
 * 四种 Attention Event 场景。
 *
 * `id` 是 Host 分发器与设置页共同寻址的稳定键，改动会导致用户已保存的模板失配。
 * `placeholders` 列出该场景可用的变量——设置页据此渲染变量面板，
 * Host 据此渲染模板。
 */
export const SCENARIOS = [
  {
    id: 'turnEnd',
    label: '轮次结束',
    description: 'DSH 完成了一轮回复并转入空闲，等你给出下一步指令。',
    placeholders: ['workspace', 'session', 'time'],
    defaultBody: '{workspace} · {session} 已完成一轮，等待你的下一步指令。',
  },
  {
    id: 'question',
    label: '等待回答',
    description: 'Agent 通过提问工具询问，必须由你作答才能继续。',
    placeholders: ['workspace', 'session', 'summary', 'time'],
    defaultBody: '{workspace} · {session} 正在等待你的回答：{summary}',
  },
  {
    id: 'approval',
    label: '等待授权',
    description: 'Agent 请求批准一次工具调用，审批策略允许询问时会阻塞在这里。',
    placeholders: ['workspace', 'session', 'tool', 'summary', 'time'],
    defaultBody: '{workspace} · {session} 等待你的授权：工具 {tool}',
  },
  {
    id: 'error',
    label: '执行出错',
    description: '某个步骤或轮次失败，通常需要人工介入排查。',
    placeholders: ['workspace', 'session', 'summary', 'time'],
    defaultBody: '{workspace} · {session} 执行出错：{summary}',
  },
]

/** 场景 id 列表，按设置页展示顺序。 */
export const SCENARIO_IDS = SCENARIOS.map((s) => s.id)

/**
 * 全部变量的说明。
 *
 * 顺序即设置页变量面板的顺序，默认模板的排列也遵循它（工作区名 → 会话名 → 事件类型）。
 */
export const VARIABLES = [
  { name: 'workspace', description: '所属工作区（目录名）' },
  { name: 'session', description: '会话标题；取不到时退化为会话 id 前 12 位' },
  { name: 'summary', description: '问题摘要 / 错误摘要 / 工具名等补充信息' },
  { name: 'tool', description: '请求授权的工具名（仅“等待授权”场景）' },
  { name: 'time', description: '触发时间 HH:MM:SS' },
]

/** 通知默认显示时长（秒）。0 表示常驻，直到用户手动关闭。 */
export const DEFAULT_DURATION_SECONDS = 10

/** 可配置的最长显示时长（秒）。 */
export const MAX_DURATION_SECONDS = 60

/**
 * 默认配置。
 *
 * 关键默认值及其理由：
 *  - `suppressWhenFocused` 默认 **true**：抑制功能存在的目的就是减少噪音，
 *    默认关闭等于用户装完还得先被吵一次才去开它。
 *  - `suppressWhenFocused` **仅对 desktop 端生效**：web 端无从判断「你在看」，
 *    强行套用会误抑制。
 *  - 四个场景默认全开：审批与提问最有价值，但受冷却约束避免刷屏。
 */
export function defaultConfig() {
  const scenarios = {}
  for (const scenario of SCENARIOS) {
    scenarios[scenario.id] = {
      enabled: true,
      /** 同一场景两次提醒之间的最小间隔（秒）。0 表示不限。 */
      minIntervalSeconds: scenario.id === 'approval' ? 30 : 0,
      durationSeconds: DEFAULT_DURATION_SECONDS,
      body: scenario.defaultBody,
    }
  }
  return {
    /** 总开关。 */
    enabled: true,
    /** 通知标题。 */
    title: 'DSH Session Alert',
    /** 是否播放声音。 */
    sound: true,
    /** 只提醒根会话，忽略子代理与 workflow 子会话。 */
    onlyRootSessions: true,
    /** 用户手动打断的轮次不提醒（停止按钮触发的那种）。 */
    skipAbortedTurns: true,
    /** 抑制：desktop 端在焦点内时不弹卡片，但仍响铃声。仅对 desktop 端生效。 */
    suppressWhenFocused: true,
    /** 铃声：'system' 用 Windows 系统声音，'file' 用自定义音频文件。 */
    chime: {
      enabled: true,
      source: 'system',
      filePath: '',
    },
    /** 滑动窗口限流：每 windowSeconds 秒最多 max 条，超出则合并成一条稍后发出。 */
    rateLimit: {
      enabled: true,
      max: 3,
      windowSeconds: 10,
      coalesce: true,
    },
    scenarios,
  }
}
