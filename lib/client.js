/**
 * dsh-session-alert 的浏览器半边。
 *
 * 三件事：
 *  1. **端别自报**——判断自己是 web 客户端还是 desktop 客户端，上报给 Host；
 *  2. **焦点上报**——页面焦点变化时上报，供 Host 决定要不要抑制通知；
 *  3. **设置页**——注册 `settings.section`，呈现状态与配置。
 *
 * ## 为什么端别必须由客户端自报
 *
 * Host 无法从一个请求里看出「当前是谁在看我」——它的请求身份里没有端别字段，也没有
 * 环境里的端别事实。而且用户可能**同时**开着 web 与 desktop，「哪些端在线」只有各端
 * 自己知道。因此端别由各客户端自报，Host 汇总。
 *
 * ## 为什么走 HTTP 而不是包内 RPC
 *
 * 实测：插件用 `ctx.webServer.register` 注册的环回路由**不需要凭据**。
 * （对照：请求没有被任何插件路由接走时，会落到 Host 自己的 `/api` 通道并返回 401。）
 * 既然这条路可用，就不引入 RPC 中转。
 *
 * ## 本文件是纯 JavaScript
 *
 * 不用 JSX、不用 TypeScript、不 import 模块 —— 浏览器半边由 client-modules 直接取用，
 * 没有构建步骤。React 通过 `require('react')` 取得。
 */

window.__ModuleLoader__.load({
	id: 'dsh-session-alert',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		var react = require('react')

		/** 端别取值。 */
		var KIND_WEB = 'web'
		var KIND_DESKTOP = 'desktop'

		/** 上报端点。路径必须与 lib/contract.js 的 ROUTE_PREFIX 一致。 */
		var STATE_ENDPOINT = '/api/dsh-session-alert/state'
		var CLIENT_STATE_ENDPOINT = '/api/dsh-session-alert/client-state'
		var CONFIG_ENDPOINT = '/api/dsh-session-alert/config'
		var TEST_ENDPOINT = '/api/dsh-session-alert/test'

		/** 本地化命名空间。文本全部从这里取，组件里不出现裸字符串。 */
		var LOCALE_NS = 'dsh-session-alert'

		/**
		 * 本插件在客户端模块系统里的 id。
		 *
		 * 与 `window.__ModuleLoader__.load({ id })` 的 id 以及包名一致——它同时是
		 * 样式标签的归属标记（`data-plugin`）与「哪些标签属于我」的判据。两处必须同源，
		 * 写成两个字面量迟早会漂移。
		 */
		var STYLE_PLUGIN_ID = 'dsh-session-alert'

		/**
		 * 界面文本。
		 *
		 * **为什么 `en` 字典里也填中文**：DSH 内置语言只有 `zh` 与 `en`，且 `en` 是
		 * 兜底语言——查不到的键会退到它。如果只注册 `zh`，那么当活动语言是 `en` 时，
		 * 所有键都会 miss 并退化成把 key 本身显示出来（界面上会出现一排 ID）。
		 *
		 * 更好的理由是这个插件的界面语言与**通知内容**是两件事：模板本身就是中文
		 * （包括默认模板与 `{workspace}` 这类占位符），界面切成英文而通知是中文会很怪。
		 * DSH 自己的设置页在这个语言下的键也是中文的。
		 *
		 * 关键不在于"填了什么"，而在于**注册了**：`ctx.locale` 从此是文本的唯一来源，
		 * 将来要真正加英文只改这张表。
		 */
		var TEXTS = {
			title: 'SessionAlert',
			desc: '会话需要你介入时发一条 Windows 通知；点击通知可把 DSH 窗口显示到最上层。',
			sectionGeneral: '通用',
			enableNotifications: '启用通知',
			notifyTitle: '通知标题',
			withSound: '通知带声音',
			rootOnly: '只提醒根会话',
			rootOnlyHint: '子代理与 workflow 子会话不打扰你',
			skipAborted: '你手动打断的轮次不提醒',
			sectionSuppress: '专注时抑制',
			suppressToggle: '你正在看 DSH 时不弹卡片，但仍响铃声',
			suppressHint: '仅对 desktop 端生效；web 端不做抑制',
			suppressOn: '当前：desktop 端在线且在焦点，卡片正被抑制。',
			suppressOff: '当前：desktop 端在线；此刻不会抑制。',
			suppressNoDesktop: '当前：未检测到 desktop 端（该项仅对 desktop 端生效）。',
			sectionTemplate: '通知内容',
			scenarioOn: '启用这个场景',
			durationLabel: '显示时长（秒，0 = 常驻）',
			intervalLabel: '最短间隔（秒）',
			insertVariable: '插入变量：',
			noVariables: '（本场景无可用变量）',
			previewLabel: '预览（示例数据）',
			previewEmpty: '（模板为空，不会发出通知）',
			resetTemplate: '恢复本场景默认模板',
			disabledTag: '已关',
			sectionChime: '铃声',
			chimeEnable: '启用铃声',
			chimeEnableHint: '卡片被抑制时铃声照响——「看着界面」不等于「注意力在这条通知上」',
			chimeSource: '铃声来源',
			chimeSystem: 'Windows 系统声音',
			chimeFile: '自定义音频文件',
			chimePath: '音频文件路径（.wav）',
			sectionRate: '限流',
			rateEnable: '启用限流',
			rateMax: '最多条数',
			rateWindow: '窗口（秒）',
			rateCoalesce: '超出窗口时合并成一条稍后发出',
			rateCoalesceHint: '关闭则超出的被丢弃',
			rateUsage: '当前窗口用量：',
			ratePending: '，待合并 ',
			ratePendingUnit: ' 条',
			rateSecondsUnit: ' 秒）',
			save: '保存',
			saving: '处理中…',
			sendTest: '发一条测试通知',
			saved: '已保存。',
			savedNoPersist: '改动已生效，但写入配置文件失败——重启后会丢失。',
			sendFailed: '发送失败：',
			saveFailed: '保存失败：',
			loadFailed: '读取状态失败：',
			loading: '正在读取插件状态…',
			testPrefix: '测试通知：',
			sectionDiag: '诊断',
			currentClient: '当前端',
			onlineClients: '在线的端',
			noneOnline: '（无）',
			aumid: '通知署名',
			aumidRegistered: '（已注册）',
			aumidFallback: 'Windows PowerShell（后备 AUMID）',
			configPath: '配置文件',
			recentSignals: '最近的信号（',
			recentSignalsUnit: ' 条）',
			noSignals: '还没有任何信号到达。',
			recentToasts: '最近发出的通知',
			noToasts: '还没有发出过通知。可点上方「发一条测试通知」验证投递链。',
			// 样式诊断：这两行是「设置页为什么不好看」的唯一可判定答案来源。
			// 上一轮在不知道改动有没有生效的情况下调了好几轮数值，那是在猜。
			styleState: '样式注入',
			styleInjected: '已注入',
			styleNotInjected: '未注入',
			styleTagsUnit: ' 个标签',
			styleCharsUnit: ' 字符',
			styleRulesUnit: ' 条规则',
			styleApplied: '样式实测（读回）',
			styleNotMeasured: '（设置页尚未渲染，无法实测）',
			toastFailed: '失败：',
			unknown: '未知',
			clientDesktop: 'desktop（桌面应用）',
			clientWeb: 'web（浏览器）',
			scenarioTabs: '通知场景',
		}

		/** 场景标签与说明也在契约里，但展示文本同样要走本地化。 */
		var SCENARIO_LABELS = {
			turnEnd: '轮次结束',
			question: '等待回答',
			approval: '等待授权',
			error: '执行出错',
		}
		var SCENARIO_DESCRIPTIONS = {
			turnEnd: 'DSH 完成了一轮回复并转入空闲，等你给出下一步指令。',
			question: 'Agent 通过提问工具询问，必须由你作答才能继续。',
			approval: 'Agent 请求批准一次工具调用，审批策略允许询问时会阻塞在这里。',
			error: '某个步骤或轮次失败，通常需要人工介入排查。',
		}

		/**
		 * 设置页样式。
		 *
		 * 样式对齐 DSH 自身的设置页。
		 *
		 * 这些数值与令牌**不是猜的**，是从 DSH 的 UI 原语包
		 * `@deepseek-ai/dsh-client-ui-primitives` 的 CSS 源码里读出来的
		 * （`Input.module.css` / `Checkbox.module.css` / `Button.module.css` /
		 * `Pill.module.css` / `settings-form/SettingsForm.module.css`）。
		 *
		 * 提取脚本：`experiments/extract-dsh-css.cjs`。它从 app.asar 里按原始字节抽出这些
		 * CSS，因此这些数值可以随时重新核对，而不是"照抄后失传"。
		 *
		 * DSH 用 CSS modules，类名被哈希（如 `OK0UZW_settingsCard`），因此无法直接复用
		 * 它的类名；能对齐的是**设计语言**：控制高度、圆角、描边宽度、焦点环、以及各处的
		 * 令牌用法。这些才是"看起来像同一个应用"的来源。
		 *
		 * | 元素 | DSH 的写法 |
		 * | --- | --- |
		 * | 输入框 | `height:32px`、`border:.5px solid --dsw-alias-border-l4`、`radius-md` |
		 * | 复选框行 | `inline-flex` + `gap:6px`、`16x16` 且 `accent-color:brand-primary` |
		 * | 按钮 | `height:36px`（sm 为 28px）、`radius-md`、`button-primary-fill` |
		 * | 标签 | Pill 形态：`height:24px`、圆角 999px、选中用 `button-ghost-active-fill` |
		 * | 卡片 | `settings-card-fill` / `settings-card-stroke` |
		 *
		 * 令牌都带 `--dsw-*` 名，因此跟随 DSH 的明暗主题；缺失时有回退，避免主题换版后
		 * 变成不可读的裸文本。
		 */
		var STYLES = [
			// ---- 作用域内的边框盒重置（**必须放在最前**）----
			//
			// 这条来自官方设置卡片样式的注释（`@linxin666/dsh-pet` 的
			// settings-card.module.css，其文件头写明「Aligned with the official
			// ui-settings-plugins PluginCard / fields CSS」）：
			//
			//   "The suite does not force a global border-box, so width:100% + padding
			//    would stretch the row 32px past the card and push the trailing pending
			//    badge (last flex item) outside the card border."
			//
			// **这正是本插件设置页「挤成一团」的机制**：我给控件写了 `width:100%`
			// 加 `padding`，而套件没有全局 border-box，于是每个控件都比容器宽，
			// 内容溢出、相邻文字贴在一起。
			//
			// 官方做法是**在卡片自己的类上逐条声明**，不依赖全局。这里在插件根作用域内
			// 统一重置，范围用 `.dsa-root` 限定，不影响宿主页面其它部分。
			'.dsa-root,.dsa-root *,.dsa-root *::before,.dsa-root *::after{box-sizing:border-box}',

			// ---- 根与标题（字号照官方卡片的 15/13/12 层级）----
			'.dsa-root{display:flex;flex-direction:column;gap:16px;font-size:13px;line-height:1.5}',
			'.dsa-head{display:flex;flex-direction:column;gap:4px}',
			'.dsa-title{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}',
			// 说明用 secondary 而**不是 tertiary**。官方那条注释解释过原因：
			// 某些主题的 tertiary 是为大字号调的，12–13px 下对比度不足（举例约 3.4:1）。
			'.dsa-desc{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',

			// ---- 卡片：照官方 PluginCard 的令牌与圆角 ----
			// 官方用的是 `bg-layer-3` + `border-l2` + 12px 圆角，
			// 而不是 `settings-card-fill/stroke`（那两个令牌是我先前猜的，方向错了）。
			'.dsa-card{display:flex;flex-direction:column;gap:12px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3)}',
			'.dsa-card-title{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}',

			// ---- 开关行 ----
			// 关键：说明文字必须包在一个 span 里，否则它会与标签一起被 flex 排成一行，
			// 长句就会溢到旁边去（第一版就是这样，截图里能看到文字横向糊在一起）。
			'.dsa-toggle{display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}',
			'.dsa-toggle input{flex:0 0 auto;width:16px;height:16px;margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary);cursor:inherit}',
			'.dsa-toggle input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
			'.dsa-toggle:has(input:disabled){cursor:default;opacity:.5}',
			'.dsa-toggle-text{display:flex;flex-direction:column;gap:2px;min-width:0}',
			// 说明文字必须**自占一行**并留出上间距。
			//
			// 截图里的症状是「…子代理与 workflow 子会话不打扰你☑你手动打断的轮次不提醒」——
			// 说明文字的结尾与下一个开关的标签连成一片，看起来像一句话。
			// 原因是说明只是 flex 列里的普通行内文本，与相邻行的分界只靠 2px 的 gap 区分。
			// 显式 block + 上间距后，每一项的边界才看得出来。
			'.dsa-hint{display:block;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
			'.dsa-toggle-text>.dsa-hint{margin-top:2px}',
			// 卡片内各行的间距：开关与开关之间也要有明确分隔，
			// 否则连续多个开关看起来是一段文字。
			'.dsa-card>.dsa-toggle+.dsa-toggle{margin-top:2px}',

			// ---- 表单控件：尺寸与描边宽度照 DSH 的 Input / Button ----
			'.dsa-field{display:flex;flex-direction:column;gap:6px}',
			'.dsa-field>span{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
			'.dsa-input,.dsa-select,.dsa-textarea{box-sizing:border-box;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l3));border-radius:var(--dsw-radius-md,6px);padding:0 8px;height:32px}',
			// **宽度必须显式给 100% 并允许收缩。**
			//
			// 截图里输入框只有 34px 宽（`3`、`10` 这种），是因为它们处在被压缩的 flex 行里。
			// 现在容器改成了 Grid，但控件自身仍要声明占满列宽，否则会退回内容宽度。
			'.dsa-input,.dsa-select,.dsa-textarea{width:100%}',
			'.dsa-input::placeholder{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary))}',
			'.dsa-input:focus,.dsa-select:focus,.dsa-textarea:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary))}',
			'.dsa-input:disabled,.dsa-select:disabled,.dsa-textarea:disabled{opacity:.5;cursor:default}',
			'.dsa-select{appearance:none;padding-right:26px;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 14px) 14px,calc(100% - 9px) 14px;background-size:5px 5px,5px 5px;background-repeat:no-repeat}',
			'.dsa-textarea{height:auto;min-height:72px;padding:6px 8px;resize:vertical;line-height:1.6;font-family:inherit}',
			'.dsa-input-num{width:80px;text-align:left}',

			// ---- 成组字段 ----
			//
			// **这里曾经用 flex，是「挤成一团」的直接原因。**
			//
			// 原写法是 `.dsa-inline{display:flex;align-items:center}`，而里面每一项又是
			// 一个 label 套着「文字 + 输入框」。flex 会把 label **压成内容宽度**，
			// 于是文字被折成两三行、输入框紧贴在文字右侧，整块看起来糊在一起。
			//
			// 改用 CSS Grid 的 auto-fit：**容器窄时自动落成单列、宽时自动两列**，
			// 且每一项占满自己的列宽。这样无论设置页里可用宽度是多少都不会挤——
			// 而这正是之前失败的地方：它依赖宽度，窄了就崩。
			'.dsa-inline{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}',
			// 每个字段是纵向的「标签在上、控件在下」，并让控件占满整列。
			'.dsa-inline>label{display:flex;flex-direction:column;gap:6px;min-width:0}',
			'.dsa-inline>label>span{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
			// 数字输入占满列宽，不再固定 80px——固定宽在窄容器里会和标签抢位置。
			'.dsa-input-num{width:100%}',

			// ---- 模板编辑器 ----
			'.dsa-editor{display:flex;flex-direction:column;gap:12px}',
			// 场景切换用 Pill 形态（DSH 的 Pill：高 24px、圆角 999px）
			'.dsa-tabs{display:flex;flex-wrap:wrap;gap:8px}',
			'.dsa-tab{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:none;border-radius:999px;cursor:pointer;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}',
			'.dsa-tab:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-3))}',
			'.dsa-tab:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
			'.dsa-tab-active{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-button-ghost-active-fill,var(--dsw-alias-bg-layer-3));box-shadow:inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border,transparent);font-weight:600}',
			'.dsa-tab-off{font-size:11px;color:var(--dsw-alias-label-tertiary)}',

			// 变量芯片：等宽字体，因为它们是字面占位符
			'.dsa-chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px}',
			'.dsa-chips-label{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
			'.dsa-chip{display:inline-flex;align-items:center;height:24px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,4px);cursor:pointer;font:inherit;font-size:12px;line-height:18px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}',
			'.dsa-chip:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}',

			// 预览：用虚线框与层级背景，表明它是"示意"而非真实内容
			'.dsa-preview{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:.5px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,6px);background:var(--dsw-alias-bg-layer-2)}',
			'.dsa-preview-label{font-size:11px;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary)}',
			'.dsa-preview-body{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);word-break:break-word}',

			// ---- 操作区 ----
			'.dsa-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding-top:4px}',
			'.dsa-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md,6px);cursor:pointer;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent}',
			'.dsa-btn:disabled{cursor:not-allowed;opacity:.4}',
			'.dsa-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
			'.dsa-btn-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground,#fff)}',
			'.dsa-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary))}',
			'.dsa-btn-outline{border:.5px solid var(--dsw-alias-border-l3)}',
			'.dsa-btn-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}',
			'.dsa-btn-sm{height:28px;padding:0 10px;font-size:12px;line-height:18px;border-radius:var(--dsw-radius-sm,4px)}',
			'.dsa-notice{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
			'.dsa-notice-error{color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary))}',
			'.dsa-notice-warn{color:var(--dsw-alias-state-warn-primary)}',

			// ---- 诊断区 ----
			'.dsa-rows{display:flex;flex-direction:column;gap:6px}',
			'.dsa-row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
			'.dsa-label{flex:none;min-width:76px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
			'.dsa-value{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);word-break:break-all}',
			'.dsa-subtitle{margin-top:4px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
			'.dsa-signals{display:flex;flex-direction:column;gap:3px;max-height:260px;overflow:auto;padding-right:4px}',
			'.dsa-signal{display:flex;align-items:baseline;gap:8px;font-size:12px;line-height:1.5}',
			'.dsa-signal-time{flex:none;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-tertiary)}',
			'.dsa-signal-source{flex:none;min-width:186px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-secondary)}',
			'.dsa-signal-verdict{color:var(--dsw-alias-label-primary);word-break:break-word}',
			'.dsa-dim{color:var(--dsw-alias-label-tertiary)}',
			'.dsa-warn{color:var(--dsw-alias-state-warn-primary)}',
			'.dsa-error{color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary))}',
		].join('')

		/** 焦点轮询间隔（毫秒）。 */
		var FOCUS_POLL_MS = 2000

		/** 心跳间隔（毫秒）。Host 据此判断该端是否仍在线。 */
		var HEARTBEAT_MS = 30000

		/**
		 * `ctx.locale.bind(ns)` 返回的翻译函数，由 `apply` 在挂载时设置。
		 *
		 * 放在模块作用域而不是 React 状态里：`bind` 返回的引用对同一命名空间是稳定的，
		 * 它读活动语言发生在**调用时**，因此不需要在语言切换时重新绑定或触发重渲染。
		 */
		var translateBound = null

		/**
		 * 输出一条带插件前缀的调试日志。
		 *
		 * 走宿主提供的 `console`（Builtin 清单里的一个包内符号），而不是直接摸
		 * `window.console`：前者被打上插件标签，便于在控制台里区分是谁打的。
		 *
		 * 用途：把「样式有没有注入成功」这类**在页面上不报错、只能靠猜**的事情变成可读事实。
		 *
		 * @param message - 日志内容。
		 */
		function logDebug(message) {
			try {
				if (typeof console !== 'undefined' && console !== null && typeof console.log === 'function') {
					console.log(`[dsh-session-alert] ${message}`)
					return
				}
			} catch (error) {
				// 日志不可用不该影响功能。
			}
			try {
				if (typeof globalThis !== 'undefined' && globalThis.console && typeof globalThis.console.log === 'function') {
					globalThis.console.log(`[dsh-session-alert] ${message}`)
				}
			} catch (error) {
				// 同上。
			}
		}

		/**
		 * 取一条界面文本，已绑定到模块级翻译函数。
		 *
		 * 每个组件在开头写 `var tx = textFor()`，之后所有界面文本都走 `tx('key')`。
		 * 这样**组件里不出现裸字符串**：文本只有一个来源，加语言只改字典。
		 *
		 * 为什么不在模块顶层直接算好：`apply` 挂载时才拿得到 `ctx.locale`，而挂载晚于
		 * 模块求值。组件在渲染时才调用这个函数，因此那时它已经就绪。
		 *
		 * @returns {(key: string) => string} 取词函数。
		 */
		function textFor() {
			return function (key) {
				return text(translateBound, key)
			}
		}

		/**
		 * 取一条界面文本。
		 *
		 * 优先走 `ctx.locale` 的服务绑定（这样文本有一个唯一来源，将来加语言只改字典）；
		 * 服务尚未就绪或绑定失败时退到本地表，因此界面在任何情况下都不会因为本地化而空掉。
		 *
		 * @param t - `ctx.locale.bind(ns)` 返回的翻译函数，可为 null。
		 * @param key - 文本键。
		 * @returns 该键的文本；键不存在时返回键本身（便于发现遗漏）。
		 */
		function text(t, key) {
			if (typeof t === 'function') {
				try {
					var viaService = t(key)
					// **服务返回键名本身时视为 miss。**
					//
					// locale 的查找在命名空间与兜底链都没命中时会「showing the key itself」——
					// 也就是说它不抛错、不返回空，而是把键名当文本还回来。此时若直接采用，
					// 界面上就会出现一排键名（`sectionGeneral` 之类），比缺一句话糟得多。
					// 因此把「等于键名」当作未命中，退到本地表。
					if (typeof viaService === 'string' && viaService.length > 0 && viaService !== key) {
						return viaService
					}
				} catch (error) {
					// 落到本地表。
				}
			}
			return TEXTS[key] !== undefined ? TEXTS[key] : key
		}

		/**
		 * 判断当前端别。
		 *
		 * 判据是 **DSH 自己的判据**，不是我们发明的：它的前端就是用
		 * `document.documentElement.dataset.platform` 推出 `runtime: 'desktop' | 'web'`。
		 *
		 * 为什么不解析 user-agent：UA 可被改写，且浏览器里也可能出现类似串；而这些
		 * 标记是 DSH 自己写进 DOM 的，语义明确。
		 *
		 * @returns {'web' | 'desktop'}
		 */
		function detectClientKind() {
			try {
				var root = typeof document !== 'undefined' ? document.documentElement : undefined
				// 一：桌面端 preload 写入 dataset.platform（Windows 上为 'win32'）。
				if (root !== undefined && root.dataset !== undefined && root.dataset.platform !== undefined) {
					return KIND_DESKTOP
				}
				// 二：桌面端 preload 暴露的桥对象。
				if (typeof globalThis !== 'undefined' && 'dshDesktop' in globalThis) {
					return KIND_DESKTOP
				}
				// 三：桌面端以特权 scheme 提供页面。
				if (typeof location !== 'undefined' && location.protocol === 'dsh-app:') {
					return KIND_DESKTOP
				}
				// 四：桌面端在 Windows 上写入的标题栏标记。
				if (root !== undefined && typeof root.hasAttribute === 'function'
					&& root.hasAttribute('data-windows-titlebar')) {
					return KIND_DESKTOP
				}
			} catch (error) {
				// 缺某个全局量不该让端别判定抛出去，退化为 web 即可。
			}
			return KIND_WEB
		}

		/**
		 * 页面此刻是否处于焦点。
		 *
		 * 语义是「用户此刻是不是在看这个界面」。用 `document.hasFocus()` 而不是自己
		 * 维护焦点标志：它由浏览器维护，涵盖窗口切换、页面被切到后台等情况。
		 *
		 * 判断不了时返回 `false`（当作不在焦点）—— 宁可多发一条通知，
		 * 也不要静默抑制掉一条本该出现的提醒。
		 *
		 * @returns {boolean}
		 */
		function isFocused() {
			try {
				if (typeof document === 'undefined') return false
				if (document.visibilityState === 'hidden') return false
				if (typeof document.hasFocus === 'function') return document.hasFocus()
				return document.visibilityState === 'visible'
			} catch (error) {
				return false
			}
		}

		/**
		 * 上报一次端别与焦点状态。
		 *
		 * 失败是常态（Host 尚未就绪、插件路由还没挂上），因此**静默忽略** ——
		 * 上报机制绝不能因自身失败而干扰界面。
		 *
		 * @param {string} kind - 当前端别。
		 * @param {boolean} focused - 页面此刻是否在焦点。
		 */
		function reportClientState(kind, focused) {
			try {
				if (typeof fetch !== 'function') return
				// 样式状态随每次上报一起发。
				//
				// **每次重新探测而不是复用上次的结果**：这个字段的用处正是「现在的文档里
				// 到底是什么样」，而不是「我当初打算做什么」。复用会把它变成自报意图，
				// 而自报意图恰恰是这个项目反复踩的坑（判决串说 sent、实际没发出去之类）。
				var styleReport = probeStyles()
				fetch(CLIENT_STATE_ENDPOINT, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ kind: kind, focused: focused, at: Date.now(), styles: styleReport }),
				}).catch(function () {
					// 忽略。
				})
			} catch (error) {
				// 忽略。
			}
		}

		/**
		 * 启动端别与焦点的持续上报。
		 *
		 * 为什么要轮询而不只靠事件：桌面端窗口最小化、或应用整体被切到后台时，
		 * 页面不一定收到 focus/blur —— 而这些恰恰是「用户不在看」的关键情形。
		 * 2 秒的周期对抑制决策足够，开销可忽略。
		 *
		 * @param {object} ctx - 客户端 cordis 上下文。
		 */
		function startReporting(ctx) {
			var kind = detectClientKind()
			var lastFocused = null

			function push() {
				var focused = isFocused()
				if (focused !== lastFocused) {
					lastFocused = focused
					reportClientState(kind, focused)
				}
			}

			// 立即报一次，让 Host 尽快知道这个端存在。
			lastFocused = isFocused()
			reportClientState(kind, lastFocused)

			ctx.effect(function () {
				var onFocusChange = push

				try {
					if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
						window.addEventListener('focus', onFocusChange)
						window.addEventListener('blur', onFocusChange)
					}
					if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
						document.addEventListener('visibilitychange', onFocusChange)
					}
				} catch (error) {
					// 监听不可用时仍有下面的轮询兜底。
				}

				var poll = setInterval(push, FOCUS_POLL_MS)
				// 心跳：端别不变，重报的意义在于让 Host 知道这个端还在。
				var heartbeat = setInterval(function () {
					reportClientState(kind, isFocused())
				}, HEARTBEAT_MS)

				return function () {
					clearInterval(poll)
					clearInterval(heartbeat)
					try {
						if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
							window.removeEventListener('focus', onFocusChange)
							window.removeEventListener('blur', onFocusChange)
						}
						if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
							document.removeEventListener('visibilitychange', onFocusChange)
						}
					} catch (error) {
						// 卸载期间的失败无需上报。
					}
				}
			}, 'dsh-session-alert: client reporting')
		}

		// ------------------------------------------------------------------
		// 样式注入与「样式到底有没有生效」的可判定反馈
		// ------------------------------------------------------------------

		/** 注入的样式标签所用的归属标记。宿主自己的清理也认这个属性。 */
		var STYLE_OWNER_ATTR = 'data-plugin'

		/**
		 * 最近一次样式探测的结果。
		 *
		 * **为什么要有这个东西。** 样式没生效时页面上不报任何错：标签可能在、也可能不在，
		 * 在也不一定被应用。上一轮就是在「不确定改动有没有生效」的情况下反复调数值，
		 * 那是在猜。这里把「注入没注入、注入的又有没有真的作用到元素上」变成一组
		 * 可以被读出来的事实——它同时被渲染到设置页的诊断区（人眼可看），并随每次
		 * 上报发给 Host（机器可读）。
		 *
		 * 字段分两层，是刻意的：
		 *  - `injected`/`tags`/`chars`/`rules` 回答「标签在不在、浏览器认不认」；
		 *  - `applied` 回答「**真的作用到元素上了吗**」——它读的是 `getComputedStyle`，
		 *    即浏览器算出来的值，而不是我打算写进去的值。这两层必须分开，因为
		 *    「标签存在」与「样式生效」是两件事，而这个项目已经在这上面栽过。
		 */
		var styleState = {
			injected: false,
			tags: 0,
			dynTags: 0,
			chars: 0,
			rules: -1,
			applied: null,
			error: null,
			at: 0,
		}

		/**
		 * 从浏览器读回当前样式状态（**实测，不是自报意图**）。
		 *
		 * @returns {object} 一份新的样式状态快照。
		 */
		function probeStyles() {
			var report = {
				injected: false,
				tags: 0,
				dynTags: 0,
				chars: 0,
				rules: -1,
				applied: null,
				error: styleState.error,
				at: Date.now(),
			}
			try {
				if (typeof document === 'undefined' || document === null || document.head === null) {
					report.error = 'no-document'
					styleState = report
					return report
				}

				var owned = document.querySelectorAll('style[' + STYLE_OWNER_ATTR + '="' + STYLE_PLUGIN_ID + '"]')
				report.tags = owned.length
				// `data-dyn` 是动态半边那条路（`styles.insert`）留下的标记。单独计数，
				// 因为「一条都没有」正好是「那条路从来没走通」的独立证据。
				report.dynTags = document.querySelectorAll('style[data-dyn="' + STYLE_PLUGIN_ID + '"]').length

				if (owned.length > 0) {
					var tag = owned[0]
					var css = tag.textContent === null ? '' : String(tag.textContent)
					report.injected = css.length > 0
					report.chars = css.length
					report.rules = countStyleRules(tag)
				}

				report.applied = probeStylesApplied()
			} catch (error) {
				report.error = error !== null && error !== undefined && error.message ? String(error.message) : String(error)
			}
			styleState = report
			return report
		}

		/**
		 * 数一个 `<style>` 标签被浏览器解析成了多少条规则。
		 *
		 * 这是「标签在」与「样式可用」之间的那一步：CSS 若语法有问题，标签仍在文档里，
		 * 但规则会少掉或整个为空——只看标签是看不出来的。
		 *
		 * @param {Element} tag - 待检查的样式标签。
		 * @returns {number} 规则数；读不到时返回 -1。
		 */
		function countStyleRules(tag) {
			try {
				if (typeof document === 'undefined' || document.styleSheets === undefined) return -1
				var sheets = document.styleSheets
				for (var i = 0; i < sheets.length; i++) {
					if (sheets[i].ownerNode === tag) {
						var rules = sheets[i].cssRules
						return rules === undefined || rules === null ? -1 : rules.length
					}
				}
			} catch (error) {
				// 读 CSSOM 失败不该让上报本身失败。
			}
			return -1
		}

		/**
		 * 实测样式是否**真的作用到了元素上**。
		 *
		 * 办法是读设置页根元素的 `getComputedStyle`：本插件的样式表把 `.dsa-root` 定为
		 * `display:flex; gap:16px`，而一个普通 `div` 的默认值是 `display:block; gap:normal`。
		 * 因此这一读数能区分「样式表已应用」与「标签在但没起作用」——它来自浏览器，
		 * 不来自插件的意图。
		 *
		 * 设置页没打开时取不到元素，返回 null（这不是失败，只是此刻无法测量）。
		 *
		 * @returns {object|null} 实测值，或 null。
		 */
		function probeStylesApplied() {
			try {
				if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return null
				var root = document.querySelector('.dsa-root')
				if (root === null) return null
				var computed = getComputedStyle(root)
				return {
					display: computed.display,
					gap: computed.gap,
					fontSize: computed.fontSize,
				}
			} catch (error) {
				return null
			}
		}

		/**
		 * 以静态半边的方式注入样式表，返回清理函数。
		 *
		 * **这是「重启后完全没有变化」的根因修复。**
		 *
		 * 原先写的是 `styles.insert(STYLES)`，而 `styles` 是**动态半边**才有的符号：
		 * 它由 `@deepseek-ai/dsh-cordis-client-runner` 构造（`DynamicCordisStyles`，
		 * 把标签打上 `data-dyn`）并作为闭包实参传给动态半边。
		 *
		 * 本插件是**静态半边**：`window.__ModuleLoader__.load({ id, factory })`。
		 * Module Loader 的物化语句是 `registered.factory(this.makeRequire(ownerId, edges))`
		 * ——**只传一个实参**（`require`）。因此工厂作用域里的 `styles` 是自由变量，
		 * 沿作用域链落到全局后是 undefined（DSH 里没有任何 `window.styles` / `globalThis.styles`）。
		 * 那条 `typeof styles !== 'undefined'` 的守卫于是走了 else 分支：**CSS 从来没有进过文档**，
		 * 而页面上不报任何错。这解释了为什么改数值、改令牌、重启都没有变化——
		 * 改的是一个没有被执行的字符串。
		 *
		 * 静态半边的正确做法（`dsh-client-modules` 的 lazy-CJS 契约）：**自己创建 `<style>` 标签**。
		 * 生命周期仍然是宿主代管的：
		 *  - `claimStyles(id)` 在物化时把「还没有 `data-plugin`」的标签认领给本插件；
		 *  - `removeOwnedStyles(id)` 在本条目被替换/卸载时移除 `style[data-plugin=id]`。
		 *
		 * 我**自己**打上 `data-plugin`：预打标记的标签不会被别的插件顺手认领
		 * （`claimStyles` 只挑没有该属性的），归属从一开始就是明确的；而宿主该做的清理照旧会做
		 * ——热重载时旧标签先被移除，新代码再注入一份，不会叠加。
		 *
		 * @returns {Function} 移除该标签的清理函数。
		 */
		function installStyles() {
			var tag = null
			try {
				if (typeof document === 'undefined' || document === null || document.head === null) {
					styleState.error = 'no-document'
					return function () { /* 没有文档就没有要清理的东西 */ }
				}
				tag = document.createElement('style')
				tag.setAttribute(STYLE_OWNER_ATTR, STYLE_PLUGIN_ID)
				tag.textContent = STYLES
				document.head.appendChild(tag)
			} catch (error) {
				tag = null
				styleState.error = error !== null && error !== undefined && error.message ? String(error.message) : String(error)
			}
			var report = probeStyles()
			logDebug(report.injected
				? `样式已注入（${report.tags} 个标签 / ${report.chars} 字符 / ${report.rules} 条规则）`
				: `样式注入失败（${report.error === null ? '标签未进入文档' : report.error}）`)
			return function () {
				try {
					if (tag !== null && tag.parentNode !== null) tag.parentNode.removeChild(tag)
				} catch (error) {
					// 卸载期间的失败无需上报。
				}
				probeStyles()
			}
		}

		/**
		 * 预览用的示例变量值。
		 *
		 * 为什么需要它：模板编辑器的价值在于「改完立刻看到效果」，而真实变量值来自
		 * 某个具体会话——编辑时并不存在。用一组有辨识度的假值，用户能一眼看出
		 * `{workspace}` 会填在哪个位置。
		 *
		 * 这些是**给眼睛看的**，不参与任何真实投递。
		 */
		function sampleVars(scenarioId) {
			return {
				workspace: '我的项目',
				session: '修复登录超时',
				summary: scenarioId === 'error' ? '连接被拒绝' : '要不要保留旧的迁移脚本？',
				tool: 'run_command',
				time: '14:32:07',
			}
		}

		/** 把一行内容拆成可读的片段，用于「预览」区域。 */
		function renderPreview(template, scenarioId) {
			if (typeof template !== 'string') return ''
			var vars = sampleVars(scenarioId)
			return template.replace(/\{([^{}]*)\}/g, function (_m, name) {
				var key = String(name).trim()
				var value = vars[key]
				return value === undefined || value === null ? '' : String(value)
			}).replace(/[{}]/g, '').replace(/\s+/g, ' ').trim()
		}

		/**
		 * 一行开关。
		 *
		 * 结构照 DSH 的 Checkbox 原语：`inline-flex` + `gap:6px`、16×16 的复选框、
		 * `accent-color` 取品牌色、禁用时整行降透明度。
		 *
		 * **标签与说明必须包在同一个 `.dsa-toggle-text` 里。** 第一版把 label 与 hint
		 * 平铺给 flex 容器，于是它们被排成同一行：长句说明会横着溢出去，与相邻字段糊在一起
		 * （用户截图里能看到这个现象）。包一层之后 label 与 hint 才是上下两行。
		 *
		 * 这里用原生 `input[type=checkbox]` 而不是自绘开关：浏览器已经给了它键盘可达性、
		 * 空格切换、`:focus-visible` 焦点环，这些都是用户依赖的行为。DSH 的 Checkbox
		 * 原语也是这么做的，所以观感一致且无需自己实现一遍交互。
		 *
		 * @param props.label - 开关文案。
		 * @param props.hint - 可选补充说明，渲染在文案下方。
		 * @param props.checked - 是否选中。
		 * @param props.disabled - 是否禁用。
		 * @param props.onChange - 选中状态变化回调。
		 */
		function Toggle(props) {
			var h = react.createElement
			var text = [h('span', { key: 'l' }, props.label)]
			if (props.hint !== undefined) {
				text.push(h('span', { key: 'h', className: 'dsa-hint' }, props.hint))
			}
			return h('label', { className: 'dsa-toggle' }, [
				h('input', {
					key: 'i',
					type: 'checkbox',
					// DSH 的可访问性约定是 `role="switch"` + `aria-checked`（见 practices 参考
					// 「keep the behavior that users rely on」）。原生 checkbox 自带的键盘可达性
					// 与空格切换照旧生效，这两个属性只是把语义补准确，供读屏软件使用。
					role: 'switch',
					'aria-checked': props.checked === true,
					checked: props.checked === true,
					disabled: props.disabled === true,
					onChange: function (event) { props.onChange(event.target.checked) },
				}),
				h('span', { key: 't', className: 'dsa-toggle-text' }, text),
			])
		}

		/**
		 * 通知模板编辑器。
		 *
		 * 结构（按设计决定）：**按事件类型分组 + 一个切换器选择当前编辑哪一套**，
		 * 而不是四套平铺——四套编辑器同时展开会把设置页挤爆，而用户一次只关心一套。
		 *
		 * 变量用「芯片」插入而不是让用户手打占位符：手打 `{session}` 容易打错成
		 * `{会话}`，而打错的表现是通知里少一段内容，不容易联想到是笔误。
		 * 插入走 textarea 的 selectionStart，因此变量落在光标处，顺序由用户自己定。
		 */
		function TemplateEditor(props) {
			var h = react.createElement
			var useState = react.useState
			var useRef = react.useRef
			// 本组件的全部界面文本都从这里取，组件内不出现裸字符串。
			var tx = textFor()

			var scenarios = props.scenarios
			var config = props.config
			var onChange = props.onChange

			var activePair = useState(scenarios.length > 0 ? scenarios[0].id : '')
			var active = activePair[0]
			var setActive = activePair[1]

			var textareaRef = useRef(null)

			var scenario = null
			for (var i = 0; i < scenarios.length; i++) {
				if (scenarios[i].id === active) { scenario = scenarios[i]; break }
			}
			if (scenario === null) return null

			var scenarioConfig = (config.scenarios || {})[active] || {}

			/** 把一个变量插入到光标处。 */
			function insertVariable(name) {
				var token = '{' + name + '}'
				var node = textareaRef.current
				var body = String(scenarioConfig.body || '')
				if (node === null || node === undefined || typeof node.selectionStart !== 'number') {
					// 拿不到光标位置时追加到末尾，仍然能用。
					onChange(active, { body: body + token })
					return
				}
				var start = node.selectionStart
				var end = node.selectionEnd
				var next = body.slice(0, start) + token + body.slice(end)
				onChange(active, { body: next })
				// 把光标移到插入内容之后，便于连续插入多个变量。
				//
				// 这里**同步**设置，不用 setTimeout。原因：`setTimeout` 在动态客户端半边里
				// 是被陷阱遮蔽的（见 DSH 的 DYNAMIC_CLIENT_REDIRECTS），调用它会抛
				// "setTimeout is not available in a dynamic client half"。而 ref 在渲染后
				// 已经指向真实 DOM 节点，同步设置选区即可，本来也不需要延迟。
				var caret = start + token.length
				try {
					node.focus()
					node.setSelectionRange(caret, caret)
				} catch (error) {
					// 极少数浏览器/节点状态下选区不可设，不影响插入结果。
				}
			}

			var tabs = scenarios.map(function (item) {
				var enabled = ((config.scenarios || {})[item.id] || {}).enabled !== false
				return h('button', {
					key: item.id,
					type: 'button',
					// 切换器是「选择当前编辑哪一套模板」，用 aria-selected 表达选中态，
					// 而不是让读屏软件只念出一串按钮。
					role: 'tab',
					'aria-selected': item.id === active,
					className: 'dsa-tab' + (item.id === active ? ' dsa-tab-active' : ''),
					onClick: function () { setActive(item.id) },
				}, [
					SCENARIO_LABELS[item.id] || item.label,
					enabled ? null : h('span', { key: 'off', className: 'dsa-tab-off' }, tx('disabledTag')),
				])
			})

			var chips = (scenario.placeholders || []).map(function (name) {
				var meta = null
				for (var j = 0; j < props.variables.length; j++) {
					if (props.variables[j].name === name) { meta = props.variables[j]; break }
				}
				return h('button', {
					key: name,
					type: 'button',
					className: 'dsa-chip',
					title: meta !== null ? meta.description : '',
					onClick: function () { insertVariable(name) },
				}, '{' + name + '}')
			})

			return h('div', { className: 'dsa-editor' }, [
				h('div', {
					key: 'tabs',
					className: 'dsa-tabs',
					role: 'tablist',
					'aria-label': tx('scenarioTabs'),
				}, tabs),

				h('div', { key: 'row1', className: 'dsa-inline' }, [
					h(Toggle, {
						key: 'sw',
						label: tx('scenarioOn'),
						checked: scenarioConfig.enabled !== false,
						onChange: function (v) { onChange(active, { enabled: v }) },
					}),
					h('label', { key: 'dur', className: 'dsa-field' }, [
						h('span', { key: 'l' }, tx('durationLabel')),
						h('input', {
							key: 'i',
							className: 'dsa-input dsa-input-num',
							type: 'number',
							min: 0,
							max: 60,
							value: String(scenarioConfig.durationSeconds === undefined ? 10 : scenarioConfig.durationSeconds),
							onChange: function (e) { onChange(active, { durationSeconds: Number(e.target.value) }) },
						}),
					]),
					h('label', { key: 'gap', className: 'dsa-field' }, [
						h('span', { key: 'l' }, tx('intervalLabel')),
						h('input', {
							key: 'i',
							className: 'dsa-input dsa-input-num',
							type: 'number',
							min: 0,
							max: 3600,
							value: String(scenarioConfig.minIntervalSeconds === undefined ? 0 : scenarioConfig.minIntervalSeconds),
							onChange: function (e) { onChange(active, { minIntervalSeconds: Number(e.target.value) }) },
						}),
					]),
				]),

				h('div', { key: 'desc', className: 'dsa-hint' }, SCENARIO_DESCRIPTIONS[scenario.id] || scenario.description),

				h('div', { key: 'chips', className: 'dsa-chips' }, [
					h('span', { key: 'l', className: 'dsa-chips-label' }, tx('insertVariable')),
					chips.length > 0 ? chips : h('span', { key: 'none', className: 'dsa-hint' }, tx('noVariables')),
				]),

				h('textarea', {
					key: 'ta',
					ref: textareaRef,
					className: 'dsa-textarea',
					rows: 3,
					value: String(scenarioConfig.body || ''),
					onChange: function (e) { onChange(active, { body: e.target.value }) },
				}),

				h('div', { key: 'pv', className: 'dsa-preview' }, [
					h('div', { key: 'l', className: 'dsa-preview-label' }, tx('previewLabel')),
					h('div', { key: 'v', className: 'dsa-preview-body' },
						renderPreview(scenarioConfig.body, active) || tx('previewEmpty')),
				]),

				h('button', {
					key: 'reset',
					type: 'button',
					className: 'dsa-btn dsa-btn-outline dsa-btn-sm',
					onClick: function () { onChange(active, { body: scenario.defaultBody }) },
				}, tx('resetTemplate')),
			])
		}

		/**
		 * 设置页内容。
		 *
		 * 输入方式：本地草稿 + 失焦/显式保存。不做「每次按键都提交」——那会让限流参数
		 * 在一半输入状态下被写盘（比如把 30 打成 3 的瞬间）。
		 */
		function SessionAlertSection() {
			var h = react.createElement
			var useState = react.useState
			var useEffect = react.useEffect
			// 本组件的全部界面文本都从这里取，组件内不出现裸字符串。
			var tx = textFor()

			var statePair = useState(null)
			var snapshot = statePair[0]
			var setSnapshot = statePair[1]

			var draftPair = useState(null)
			var draft = draftPair[0]
			var setDraft = draftPair[1]

			var noticePair = useState(null)
			var notice = noticePair[0]
			var setNotice = noticePair[1]

			var busyPair = useState(false)
			var busy = busyPair[0]
			var setBusy = busyPair[1]

			useEffect(function () {
				var cancelled = false
				try {
					fetch(STATE_ENDPOINT)
						.then(function (response) {
							if (!response.ok) throw new Error('HTTP ' + response.status)
							return response.json()
						})
						.then(function (body) {
							if (cancelled) return
							setSnapshot(body)
							// 只在首次加载时填草稿，之后不再覆盖用户正在编辑的内容。
							setDraft(function (previous) { return previous === null ? body.config : previous })
						})
						.catch(function (cause) {
							if (!cancelled) {
								setNotice({ kind: 'error', text: tx('loadFailed') + String(cause && cause.message ? cause.message : cause) })
							}
						})
				} catch (cause) {
					if (!cancelled) setNotice({ kind: 'error', text: String(cause) })
				}
				return function () { cancelled = true }
			}, [])

			var kind = detectClientKind()
			var contract = snapshot !== null && snapshot.contract !== undefined ? snapshot.contract : null

			/**
			 * 诊断区「样式注入」一行的读数。
			 *
			 * **每次渲染都重新探测**：它回答的是「此刻文档里是什么样」，而不是「挂载时那一次
			 * 是什么样」。探测本身是只读的（`querySelectorAll` + `getComputedStyle`），
			 * 唯一写入的是本模块自己的 `styleState`。
			 *
			 * @returns {string} 一行的文本。
			 */
			function styleSummary() {
				var probe = probeStyles()
				if (probe.injected !== true) {
					return tx('styleNotInjected') + (probe.error === null ? '' : '（' + String(probe.error) + '）')
				}
				return tx('styleInjected')
					+ ' · ' + String(probe.tags) + tx('styleTagsUnit')
					+ ' · ' + String(probe.chars) + tx('styleCharsUnit')
					+ ' · ' + (probe.rules < 0 ? tx('unknown') : String(probe.rules) + tx('styleRulesUnit'))
			}

			/**
			 * 诊断区「样式实测」一行的读数：从浏览器读回的计算值。
			 *
			 * 这一行与上一行的区别是本质性的：上一行说「样式表在文档里」，这一行说
			 * 「浏览器把 `.dsa-root` 算成了 `display:flex`」。本插件的样式表若没生效，
			 * 普通 `div` 的默认值是 `display:block; gap:normal`——因此这一行能区分
			 * 「标签在但没作用」与「真的生效了」，而那正是「算了半天没变化」的那类问题。
			 *
			 * @returns {string} 一行的文本。
			 */
			function styleAppliedSummary() {
				var applied = styleState.applied
				if (applied === null || applied === undefined) return tx('styleNotMeasured')
				return 'display=' + String(applied.display)
					+ ' gap=' + String(applied.gap)
					+ ' font-size=' + String(applied.fontSize)
			}

			/** 更新草稿里的一个顶层字段。 */
			function patchTop(field, value) {
				setDraft(function (previous) {
					if (previous === null) return previous
					var next = {}
					for (var k in previous) if (Object.prototype.hasOwnProperty.call(previous, k)) next[k] = previous[k]
					next[field] = value
					return next
				})
				setNotice(null)
			}

			/** 更新草稿里某个场景的字段。 */
			function patchScenario(scenarioId, changes) {
				setDraft(function (previous) {
					if (previous === null) return previous
					var next = {}
					for (var k in previous) if (Object.prototype.hasOwnProperty.call(previous, k)) next[k] = previous[k]
					var scenarios = {}
					for (var s in previous.scenarios) {
						if (Object.prototype.hasOwnProperty.call(previous.scenarios, s)) scenarios[s] = previous.scenarios[s]
					}
					var current = scenarios[scenarioId] || {}
					var merged = {}
					for (var c in current) if (Object.prototype.hasOwnProperty.call(current, c)) merged[c] = current[c]
					for (var f in changes) if (Object.prototype.hasOwnProperty.call(changes, f)) merged[f] = changes[f]
					scenarios[scenarioId] = merged
					next.scenarios = scenarios
					return next
				})
				setNotice(null)
			}

			/** 保存草稿。 */
			function save() {
				if (draft === null) return
				setBusy(true)
				setNotice(null)
				try {
					fetch(CONFIG_ENDPOINT, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(draft),
					})
						.then(function (response) {
							return response.json().then(function (body) { return { ok: response.ok, body: body } })
						})
						.then(function (result) {
							setBusy(false)
							if (result.body !== undefined && result.body !== null && result.body.config !== undefined) {
								// 用服务端归一化后的结果回填草稿：用户能看到自己的输入被钳制成了什么，
								// 而不是以为「我填了 999 却生效了 60」是插件坏了。
								setDraft(result.body.config)
								setSnapshot(function (previous) {
									if (previous === null) return previous
									var next = {}
									for (var k in previous) if (Object.prototype.hasOwnProperty.call(previous, k)) next[k] = previous[k]
									next.config = result.body.config
									return next
								})
							}
							if (result.body !== undefined && result.body !== null && result.body.persisted === false) {
								setNotice({ kind: 'warn', text: tx('savedNoPersist') })
							} else {
								setNotice({ kind: 'ok', text: tx('saved') })
							}
						})
						.catch(function (cause) {
							setBusy(false)
							setNotice({ kind: 'error', text: tx('saveFailed') + String(cause && cause.message ? cause.message : cause) })
						})
				} catch (cause) {
					setBusy(false)
					setNotice({ kind: 'error', text: String(cause) })
				}
			}

			/** 发一条测试通知。 */
			function sendTest() {
				setBusy(true)
				setNotice(null)
				try {
					fetch(TEST_ENDPOINT, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: '{}',
					})
						.then(function (r) { return r.json() })
						.then(function (body) {
							setBusy(false)
							var outcome = body !== undefined && body !== null ? body.outcome : undefined
							var note = outcome !== undefined && outcome !== null && outcome.note !== undefined
								? String(outcome.note)
								: tx('unknown')
							setNotice({ kind: outcome !== undefined && outcome !== null && outcome.ok === true ? 'ok' : 'error', text: tx('testPrefix') + note })
						})
						.catch(function (cause) {
							setBusy(false)
							setNotice({ kind: 'error', text: tx('sendFailed') + String(cause && cause.message ? cause.message : cause) })
						})
				} catch (cause) {
					setBusy(false)
					setNotice({ kind: 'error', text: String(cause) })
				}
			}

			// 还没拿到数据时先给出占位，避免闪烁出一个空卡片。
			if (snapshot === null || draft === null || contract === null) {
				return h('div', { className: 'dsa-root' }, [
					h('div', { key: 'h', className: 'dsa-head' }, [
						h('div', { key: 't', className: 'dsa-title' }, tx('title')),
						h('div', { key: 'd', className: 'dsa-desc' }, tx('loading')),
					]),
					notice !== null
						? h('div', { key: 'n', className: 'dsa-notice dsa-notice-error' }, notice.text)
						: null,
				])
			}

			var desktopOnline = snapshot.clients !== undefined && snapshot.clients.desktopOnline === true
			var aumid = snapshot.aumid || {}
			var chime = draft.chime || {}
			var rateLimit = draft.rateLimit || {}

			return h('div', { className: 'dsa-root' }, [
				h('div', { key: 'head', className: 'dsa-head' }, [
					h('div', { key: 't', className: 'dsa-title' }, tx('title')),
					h('div', { key: 'd', className: 'dsa-desc' },
						tx('desc')),
				]),

				// ---- 总开关与外观 ----
				h('section', { key: 'general', className: 'dsa-card' }, [
					h('div', { key: 'h', className: 'dsa-card-title' }, tx('sectionGeneral')),
					h(Toggle, {
						key: 'enabled',
						label: tx('enableNotifications'),
						checked: draft.enabled === true,
						onChange: function (v) { patchTop('enabled', v) },
					}),
					h('label', { key: 'title', className: 'dsa-field' }, [
						h('span', { key: 'l' }, tx('notifyTitle')),
						h('input', {
							key: 'i',
							className: 'dsa-input',
							type: 'text',
							value: String(draft.title || ''),
							onChange: function (e) { patchTop('title', e.target.value) },
						}),
					]),
					h(Toggle, {
						key: 'sound',
						label: tx('withSound'),
						checked: draft.sound === true,
						onChange: function (v) { patchTop('sound', v) },
					}),
					h(Toggle, {
						key: 'root',
						label: tx('rootOnly'),
						hint: tx('rootOnlyHint'),
						checked: draft.onlyRootSessions === true,
						onChange: function (v) { patchTop('onlyRootSessions', v) },
					}),
					h(Toggle, {
						key: 'aborted',
						label: tx('skipAborted'),
						checked: draft.skipAbortedTurns === true,
						onChange: function (v) { patchTop('skipAbortedTurns', v) },
					}),
				]),

				// ---- 抑制 ----
				h('section', { key: 'suppress', className: 'dsa-card' }, [
					h('div', { key: 'h', className: 'dsa-card-title' }, tx('sectionSuppress')),
					h(Toggle, {
						key: 'sw',
						label: tx('suppressToggle'),
						hint: tx('suppressHint'),
						checked: draft.suppressWhenFocused === true,
						disabled: !desktopOnline,
						onChange: function (v) { patchTop('suppressWhenFocused', v) },
					}),
					h('div', { key: 'state', className: 'dsa-hint' },
						desktopOnline
							? (snapshot.clients.suppressCardNow === true
								? tx('suppressOn')
								: tx('suppressOff'))
							: tx('suppressNoDesktop')),
				]),

				// ---- 模板 ----
				h('section', { key: 'tpl', className: 'dsa-card' }, [
					h('div', { key: 'h', className: 'dsa-card-title' }, tx('sectionTemplate')),
					h(TemplateEditor, {
						key: 'ed',
						scenarios: contract.scenarios,
						variables: contract.variables,
						config: draft,
						onChange: patchScenario,
					}),
				]),

				// ---- 铃声 ----
				h('section', { key: 'chime', className: 'dsa-card' }, [
					h('div', { key: 'h', className: 'dsa-card-title' }, tx('sectionChime')),
					h(Toggle, {
						key: 'en',
						label: tx('chimeEnable'),
						hint: tx('chimeEnableHint'),
						checked: chime.enabled === true,
						onChange: function (v) { patchTop('chime', Object.assign({}, chime, { enabled: v })) },
					}),
					h('label', { key: 'src', className: 'dsa-field' }, [
						h('span', { key: 'l' }, tx('chimeSource')),
						h('select', {
							key: 'i',
							className: 'dsa-select',
							value: String(chime.source || 'system'),
							disabled: chime.enabled !== true,
							onChange: function (e) { patchTop('chime', Object.assign({}, chime, { source: e.target.value })) },
						}, [
							h('option', { key: 'sys', value: 'system' }, tx('chimeSystem')),
							h('option', { key: 'file', value: 'file' }, tx('chimeFile')),
						]),
					]),
					chime.source === 'file'
						? h('label', { key: 'fp', className: 'dsa-field' }, [
							h('span', { key: 'l' }, tx('chimePath')),
							h('input', {
								key: 'i',
								className: 'dsa-input',
								type: 'text',
								placeholder: 'C:\\Windows\\Media\\notify.wav',
								value: String(chime.filePath || ''),
								disabled: chime.enabled !== true,
								onChange: function (e) { patchTop('chime', Object.assign({}, chime, { filePath: e.target.value })) },
							}),
						])
						: null,
				]),

				// ---- 限流 ----
				h('section', { key: 'rate', className: 'dsa-card' }, [
					h('div', { key: 'h', className: 'dsa-card-title' }, tx('sectionRate')),
					h(Toggle, {
						key: 'en',
						label: tx('rateEnable'),
						checked: rateLimit.enabled === true,
						onChange: function (v) { patchTop('rateLimit', Object.assign({}, rateLimit, { enabled: v })) },
					}),
					h('div', { key: 'row', className: 'dsa-inline' }, [
						h('label', { key: 'max', className: 'dsa-field' }, [
							h('span', { key: 'l' }, tx('rateMax')),
							h('input', {
								key: 'i', type: 'number', min: 1, max: 100,
								className: 'dsa-input dsa-input-num',
								value: String(rateLimit.max === undefined ? 3 : rateLimit.max),
								disabled: rateLimit.enabled !== true,
								onChange: function (e) { patchTop('rateLimit', Object.assign({}, rateLimit, { max: Number(e.target.value) })) },
							}),
						]),
						h('label', { key: 'win', className: 'dsa-field' }, [
							h('span', { key: 'l' }, tx('rateWindow')),
							h('input', {
								key: 'i', type: 'number', min: 1, max: 3600,
								className: 'dsa-input dsa-input-num',
								value: String(rateLimit.windowSeconds === undefined ? 10 : rateLimit.windowSeconds),
								disabled: rateLimit.enabled !== true,
								onChange: function (e) { patchTop('rateLimit', Object.assign({}, rateLimit, { windowSeconds: Number(e.target.value) })) },
							}),
						]),
					]),
					h(Toggle, {
						key: 'co',
						label: tx('rateCoalesce'),
						hint: tx('rateCoalesceHint'),
						checked: rateLimit.coalesce === true,
						disabled: rateLimit.enabled !== true,
						onChange: function (v) { patchTop('rateLimit', Object.assign({}, rateLimit, { coalesce: v })) },
					}),
					h('div', { key: 'stat', className: 'dsa-hint' },
						tx('rateUsage') + String(snapshot.dispatch.windowUsed)
						+ ' / ' + String(snapshot.dispatch.windowMax)
						+ '（' + String(snapshot.dispatch.windowSeconds) + tx('rateSecondsUnit')
						+ (snapshot.dispatch.pendingCoalesced > 0 ? tx('ratePending') + String(snapshot.dispatch.pendingCoalesced) + tx('ratePendingUnit') : '')),
				]),

				// ---- 操作 ----
				h('div', { key: 'actions', className: 'dsa-actions' }, [
					h('button', {
						key: 'save', type: 'button',
						className: 'dsa-btn dsa-btn-primary',
						disabled: busy,
						onClick: save,
					}, busy ? tx('saving') : tx('save')),
					h('button', {
						key: 'test', type: 'button',
						className: 'dsa-btn dsa-btn-outline',
						disabled: busy,
						onClick: sendTest,
					}, tx('sendTest')),
					notice !== null
						? h('span', {
							key: 'n',
							className: 'dsa-notice' + (notice.kind === 'error' ? ' dsa-notice-error' : (notice.kind === 'warn' ? 'dsa-notice-warn' : '')),
						}, notice.text)
						: null,
				]),

				// ---- 诊断 ----
				h('section', { key: 'diag', className: 'dsa-card' }, [
					h('div', { key: 'h', className: 'dsa-card-title' }, tx('sectionDiag')),
					h('div', { key: 'rows', className: 'dsa-rows' }, [
						h('div', { key: 'kind', className: 'dsa-row' }, [
							h('span', { key: 'l', className: 'dsa-label' }, tx('currentClient')),
							h('code', { key: 'v', className: 'dsa-value' },
								kind === KIND_DESKTOP ? tx('clientDesktop') : tx('clientWeb')),
						]),
						h('div', { key: 'online', className: 'dsa-row' }, [
							h('span', { key: 'l', className: 'dsa-label' }, tx('onlineClients')),
							h('code', { key: 'v', className: 'dsa-value' },
								(snapshot.clients.liveKinds || []).join('、') || tx('noneOnline')),
						]),
						h('div', { key: 'aumid', className: 'dsa-row' }, [
							h('span', { key: 'l', className: 'dsa-label' }, tx('aumid')),
							h('code', { key: 'v', className: 'dsa-value' },
								aumid.registered === true
									? String(aumid.primary) + tx('aumidRegistered')
									: tx('aumidFallback')),
						]),
						h('div', { key: 'path', className: 'dsa-row' }, [
							h('span', { key: 'l', className: 'dsa-label' }, tx('configPath')),
							h('code', { key: 'v', className: 'dsa-value' }, String(snapshot.configPath || '')),
						]),
						// 样式诊断。这两行的存在理由：样式失效时页面**不报任何错**——
						// 标签可能不在、也可能在但没被应用，从外面看都是「不好看」。
						// 把两层事实摆出来：标签层（在不在、浏览器认不认）与实测层（真的算到元素上没有）。
						h('div', { key: 'style', className: 'dsa-row' }, [
							h('span', { key: 'l', className: 'dsa-label' }, tx('styleState')),
							h('code', {
								key: 'v',
								className: 'dsa-value' + (styleState.injected === true ? '' : ' dsa-error'),
							}, styleSummary()),
						]),
						h('div', { key: 'style-applied', className: 'dsa-row' }, [
							h('span', { key: 'l', className: 'dsa-label' }, tx('styleApplied')),
							h('code', { key: 'v', className: 'dsa-value' }, styleAppliedSummary()),
						]),
					]),

					// 信号表：这是「为什么没收到通知」的唯一答案来源。
					// 信号根本没到达、与到达后被过滤掉，从外面看都是沉默。
					h('div', { key: 'sig-title', className: 'dsa-subtitle' },
						tx('recentSignals') + String((snapshot.signals || []).length) + tx('recentSignalsUnit')),
					(snapshot.signals || []).length === 0
						? h('div', { key: 'sig-none', className: 'dsa-hint' }, tx('noSignals'))
						: h('div', { key: 'sig', className: 'dsa-signals' },
							(snapshot.signals || []).slice(-12).reverse().map(function (s, index) {
								return h('div', { key: String(index), className: 'dsa-signal' }, [
									h('code', { key: 't', className: 'dsa-signal-time' }, String(s.time)),
									h('code', { key: 's', className: 'dsa-signal-source' }, String(s.source)),
									h('span', {
										key: 'v',
										className: 'dsa-signal-verdict'
											+ (String(s.verdict).indexOf('skipped') === 0 ? ' dsa-dim' : '')
											+ (String(s.verdict).indexOf('suppressed') === 0 ? ' dsa-warn' : ''),
									}, String(s.verdict)),
								])
							})),

					h('div', { key: 'act-title', className: 'dsa-subtitle' }, tx('recentToasts')),
					(snapshot.dispatch.recent || []).length === 0
						? h('div', { key: 'act-none', className: 'dsa-hint' }, tx('noToasts'))
						: h('div', { key: 'act', className: 'dsa-signals' },
							(snapshot.dispatch.recent || []).slice(0, 8).map(function (entry, index) {
								return h('div', {
									key: String(index),
									className: 'dsa-signal' + (entry.ok === false ? ' dsa-error' : ''),
								}, [
									h('code', { key: 't', className: 'dsa-signal-time' }, String(entry.time)),
									h('code', { key: 's', className: 'dsa-signal-source' }, String(entry.scenario)),
									h('span', { key: 'v', className: 'dsa-signal-verdict' },
										entry.ok === false
											? (tx('toastFailed') + String(entry.error || tx('unknown')))
											: (String(entry.via || entry.reason || ''))),
									h('span', { key: 'b', className: 'dsa-hint' }, String(entry.body || '')),
								])
							})),
				]),
			])
		}

		/**
		 * 挂载浏览器半边。
		 *
		 * @param {object} ctx - 客户端 cordis 上下文。
		 */
		function apply(ctx) {
			// 本地化：把文本注册进 DSH 的 locale 服务，使界面文本有一个唯一来源。
			//
			// 用**非类型化**形式 `register(ns, locale, dict)`：类型化形式要求
			// `LocaleNamespaceMap` 里有该命名空间的声明，而那是 DSH 自己编译期的合并表，
			// 外部插件加不进去。
			//
			// `zh` 与 `en` 都注册，因为 DSH 只有这两个内置语言且 `en` 是兜底语言：
			// 只注册 `zh` 的话，活动语言为 `en` 时所有键都会 miss 并退化成显示键名。
			// 两个字典内容相同，理由见 TEXTS 上方注释。
			try {
				var locale = ctx.get('locale')
				if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
					ctx.effect(function () {
						var disposers = []
						try {
							disposers.push(locale.register(LOCALE_NS, 'zh', TEXTS))
							disposers.push(locale.register(LOCALE_NS, 'en', TEXTS))
						} catch (error) {
							// 重复注册会抛（同 (ns, locale) 只允许一个占用者）。这在插件热重载时
							// 是预期情况：绑定仍然可用，因此不当失败处理。
						}
						return function () {
							for (var i = 0; i < disposers.length; i++) {
								try { disposers[i]() } catch (error) { /* 幂等，重复释放无害 */ }
							}
						}
					}, 'dsh-session-alert: locale dictionaries')

					// 绑定翻译函数。重复 bind 返回同一个引用，因此可以安全地放在这里。
					if (typeof locale.bind === 'function') {
						translateBound = locale.bind(LOCALE_NS)
					}
				}
			} catch (error) {
				// 本地化失败只影响文本来源，不影响功能：text() 会退到本地表。
			}

			// 样式：**静态半边必须自己建 `<style>` 标签**，`styles.insert` 在静态半边不存在。
			// 完整的原因写在 `installStyles()` 上方的注释里（那是本插件设置页「重启后完全没有
			// 变化」的根因），这里只留一句提醒：不要再改回 `styles.insert`。
			//
			// 生命周期仍由 `ctx.effect` 管：卸载时移除标签，热重载时旧标签先被移除、
			// 新代码再注入一份，因此不会叠加。
			ctx.effect(function () {
				return installStyles()
			}, 'dsh-session-alert: styles')

			// 上报放在注入之后：这样**第一条上报就带着样式状态**，不必等下一个心跳
			// （心跳 30 秒一次，验证时等它太慢）。
			startReporting(ctx)

			// 设置页入口：`settings.section` 是「一个设置页」。
			// 写法照 DSH 官方模板 `templates/decoration/client.js`：
			//   inject: ['slots']  ->  ctx.slots.inject(ownerKey, () => ctx.slots.register(...))
			// 回调里的注册**随宿主声明的收起而释放、恢复时重装**，因此不需要自己管生命周期。
			//
			// 仍然包一层 try：界面注册失败不该让整个客户端半边报错——通知功能不依赖设置界面。
			try {
				ctx.slots.inject('settings.section', function () {
					return ctx.slots.register({
						name: 'settings.section',
						id: 'session-alert',
						order: 130,
						label: function () { return text(translateBound, 'title') },
					}, SessionAlertSection)
				})
			} catch (error) {
				try {
					if (typeof console !== 'undefined' && typeof console.error === 'function') {
						console.error('[dsh-session-alert] 设置页注册失败：', error)
					}
				} catch (ignore) {
					// 连日志都不可用时不必再处理。
				}
			}
		}

		exports.apply = apply
		// `slots` 是硬依赖：它提供设置页的挂载点。
		// 声明在 inject 里而不是运行时用 ctx.get 探，是官方模板的做法——
		// 缺少该服务时插件保持未激活，而不是在挂载中途失败。
		exports.inject = ['slots']
		exports.detectClientKind = detectClientKind
		exports.isFocused = isFocused
		return module.exports
	},
})
