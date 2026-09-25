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

		/**
		 * 设置页样式。
		 *
		 * 只使用主题令牌（`--dsw-alias-*`）而不是硬编码颜色，这样跟随 DSH 的明暗主题；
		 * 令牌缺失时有回退值，因此在主题换版时不会变成不可读的裸文本。
		 */
		var STYLES = [
			'.dsa-root{display:flex;flex-direction:column;gap:14px;font-size:13px}',
			'.dsa-head{display:flex;flex-direction:column;gap:4px}',
			'.dsa-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}',
			'.dsa-desc{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
			'.dsa-card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}',
			'.dsa-card-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
			'.dsa-toggle{display:flex;align-items:baseline;gap:8px;cursor:pointer}',
			'.dsa-toggle input{cursor:pointer;flex:none}',
			'.dsa-toggle-label{color:var(--dsw-alias-label-primary)}',
			'.dsa-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
			'.dsa-field{display:flex;flex-direction:column;gap:4px}',
			'.dsa-field>span{font-size:12px;color:var(--dsw-alias-label-secondary)}',
			'.dsa-field input,.dsa-field select,.dsa-textarea,.dsa-inline-field input{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:5px 8px}',
			'.dsa-textarea{width:100%;box-sizing:border-box;resize:vertical;line-height:1.6;font-family:inherit}',
			'.dsa-inline-field{display:flex;align-items:center;gap:6px}',
			'.dsa-inline-field>span{font-size:12px;color:var(--dsw-alias-label-secondary)}',
			'.dsa-inline-field input{width:72px}',
			'.dsa-editor{display:flex;flex-direction:column;gap:10px}',
			'.dsa-editor-row{display:flex;flex-wrap:wrap;gap:14px;align-items:center}',
			'.dsa-tabs{display:flex;flex-wrap:wrap;gap:6px}',
			'.dsa-tab{font:inherit;font-size:12px;display:inline-flex;align-items:center;gap:5px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:3px 11px}',
			'.dsa-tab-active{color:var(--dsw-alias-brand-primary,#2b7cd9);border-color:var(--dsw-alias-brand-primary,#2b7cd9);background:var(--dsw-alias-button-primary-dimmed,#e8f1fc)}',
			'.dsa-tab-off{font-size:10px;color:var(--dsw-alias-label-tertiary)}',
			'.dsa-chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px}',
			'.dsa-chips-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
			'.dsa-chip{font:inherit;font-size:12px;font-family:ui-monospace,Consolas,monospace;cursor:pointer;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:2px 7px}',
			'.dsa-chip:hover{border-color:var(--dsw-alias-brand-primary,#2b7cd9)}',
			'.dsa-preview{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px dashed var(--dsw-alias-border-l2)}',
			'.dsa-preview-label{font-size:11px;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary)}',
			'.dsa-preview-body{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);word-break:break-word}',
			'.dsa-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px}',
			'.dsa-btn{font:inherit;font-size:13px;cursor:pointer;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:5px 14px}',
			'.dsa-btn:disabled{opacity:.5;cursor:default}',
			'.dsa-btn-primary{color:#fff;background:var(--dsw-alias-brand-primary,#2b7cd9);border-color:transparent}',
			'.dsa-btn-quiet{align-self:flex-start;font-size:12px;padding:3px 10px}',
			'.dsa-notice{font-size:12px;color:var(--dsw-alias-label-secondary)}',
			'.dsa-rows{display:flex;flex-direction:column;gap:6px}',
			'.dsa-row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
			'.dsa-label{font-size:12px;color:var(--dsw-alias-label-secondary);min-width:72px;flex:none}',
			'.dsa-value{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-primary);word-break:break-all}',
			'.dsa-subtitle{margin-top:6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
			'.dsa-signals{display:flex;flex-direction:column;gap:3px;max-height:240px;overflow:auto}',
			'.dsa-signal{display:flex;align-items:baseline;gap:8px;font-size:12px}',
			'.dsa-signal-time{flex:none;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Consolas,monospace}',
			'.dsa-signal-source{flex:none;min-width:190px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,Consolas,monospace}',
			'.dsa-signal-verdict{color:var(--dsw-alias-label-primary)}',
			'.dsa-dim{color:var(--dsw-alias-label-tertiary)}',
			'.dsa-warn{color:var(--dsw-alias-label-warning,#b7791f)}',
			'.dsa-error{color:var(--dsw-alias-label-error,#c53030)}',
		].join('')

		/** 焦点轮询间隔（毫秒）。 */
		var FOCUS_POLL_MS = 2000

		/** 心跳间隔（毫秒）。Host 据此判断该端是否仍在线。 */
		var HEARTBEAT_MS = 30000

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
				fetch(CLIENT_STATE_ENDPOINT, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ kind: kind, focused: focused, at: Date.now() }),
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

		/** 一行开关。 */
		function Toggle(props) {
			var h = react.createElement
			return h('label', { className: 'dsa-toggle' }, [
				h('input', {
					key: 'i',
					type: 'checkbox',
					checked: props.checked === true,
					disabled: props.disabled === true,
					onChange: function (event) { props.onChange(event.target.checked) },
				}),
				h('span', { key: 'l', className: 'dsa-toggle-label' }, props.label),
				props.hint !== undefined
					? h('span', { key: 'h', className: 'dsa-hint' }, props.hint)
					: null,
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
				var caret = start + token.length
				setTimeout(function () {
					try {
						node.focus()
						node.setSelectionRange(caret, caret)
					} catch (error) {
						// 元素可能已卸载。
					}
				}, 0)
			}

			var tabs = scenarios.map(function (item) {
				var enabled = ((config.scenarios || {})[item.id] || {}).enabled !== false
				return h('button', {
					key: item.id,
					type: 'button',
					className: 'dsa-tab' + (item.id === active ? ' dsa-tab-active' : ''),
					onClick: function () { setActive(item.id) },
				}, [
					item.label,
					enabled ? null : h('span', { key: 'off', className: 'dsa-tab-off' }, '已关'),
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
				h('div', { key: 'tabs', className: 'dsa-tabs' }, tabs),

				h('div', { key: 'row1', className: 'dsa-editor-row' }, [
					h(Toggle, {
						key: 'sw',
						label: '启用这个场景',
						checked: scenarioConfig.enabled !== false,
						onChange: function (v) { onChange(active, { enabled: v }) },
					}),
					h('label', { key: 'dur', className: 'dsa-inline-field' }, [
						h('span', { key: 'l' }, '显示时长（秒，0 = 常驻）'),
						h('input', {
							key: 'i',
							type: 'number',
							min: 0,
							max: 60,
							value: String(scenarioConfig.durationSeconds === undefined ? 10 : scenarioConfig.durationSeconds),
							onChange: function (e) { onChange(active, { durationSeconds: Number(e.target.value) }) },
						}),
					]),
					h('label', { key: 'gap', className: 'dsa-inline-field' }, [
						h('span', { key: 'l' }, '最短间隔（秒）'),
						h('input', {
							key: 'i',
							type: 'number',
							min: 0,
							max: 3600,
							value: String(scenarioConfig.minIntervalSeconds === undefined ? 0 : scenarioConfig.minIntervalSeconds),
							onChange: function (e) { onChange(active, { minIntervalSeconds: Number(e.target.value) }) },
						}),
					]),
				]),

				h('div', { key: 'desc', className: 'dsa-hint' }, scenario.description),

				h('div', { key: 'chips', className: 'dsa-chips' }, [
					h('span', { key: 'l', className: 'dsa-chips-label' }, '插入变量：'),
					chips.length > 0 ? chips : h('span', { key: 'none', className: 'dsa-hint' }, '（本场景无可用变量）'),
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
					h('div', { key: 'l', className: 'dsa-preview-label' }, '预览（示例数据）'),
					h('div', { key: 'v', className: 'dsa-preview-body' },
						renderPreview(scenarioConfig.body, active) || '（模板为空，不会发出通知）'),
				]),

				h('button', {
					key: 'reset',
					type: 'button',
					className: 'dsa-btn dsa-btn-quiet',
					onClick: function () { onChange(active, { body: scenario.defaultBody }) },
				}, '恢复本场景默认模板'),
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
								setNotice({ kind: 'error', text: '读取状态失败：' + String(cause && cause.message ? cause.message : cause) })
							}
						})
				} catch (cause) {
					if (!cancelled) setNotice({ kind: 'error', text: String(cause) })
				}
				return function () { cancelled = true }
			}, [])

			var kind = detectClientKind()
			var contract = snapshot !== null && snapshot.contract !== undefined ? snapshot.contract : null

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
								setNotice({ kind: 'warn', text: '改动已生效，但写入配置文件失败——重启后会丢失。' })
							} else {
								setNotice({ kind: 'ok', text: '已保存。' })
							}
						})
						.catch(function (cause) {
							setBusy(false)
							setNotice({ kind: 'error', text: '保存失败：' + String(cause && cause.message ? cause.message : cause) })
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
								: '未知结果'
							setNotice({ kind: outcome !== undefined && outcome !== null && outcome.ok === true ? 'ok' : 'error', text: '测试通知：' + note })
						})
						.catch(function (cause) {
							setBusy(false)
							setNotice({ kind: 'error', text: '发送失败：' + String(cause && cause.message ? cause.message : cause) })
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
						h('div', { key: 't', className: 'dsa-title' }, 'SessionAlert'),
						h('div', { key: 'd', className: 'dsa-desc' }, '正在读取插件状态…'),
					]),
					notice !== null
						? h('div', { key: 'n', className: 'dsa-note dsa-error' }, notice.text)
						: null,
				])
			}

			var desktopOnline = snapshot.clients !== undefined && snapshot.clients.desktopOnline === true
			var aumid = snapshot.aumid || {}
			var chime = draft.chime || {}
			var rateLimit = draft.rateLimit || {}

			return h('div', { className: 'dsa-root' }, [
				h('div', { key: 'head', className: 'dsa-head' }, [
					h('div', { key: 't', className: 'dsa-title' }, 'SessionAlert'),
					h('div', { key: 'd', className: 'dsa-desc' },
						'会话需要你介入时发一条 Windows 通知；点击通知可把 DSH 窗口显示到最上层。'),
				]),

				// ---- 总开关与外观 ----
				h('section', { key: 'general', className: 'dsa-card' }, [
					h('div', { key: 'h', className: 'dsa-card-title' }, '通用'),
					h(Toggle, {
						key: 'enabled',
						label: '启用通知',
						checked: draft.enabled === true,
						onChange: function (v) { patchTop('enabled', v) },
					}),
					h('label', { key: 'title', className: 'dsa-field' }, [
						h('span', { key: 'l' }, '通知标题'),
						h('input', {
							key: 'i',
							type: 'text',
							value: String(draft.title || ''),
							onChange: function (e) { patchTop('title', e.target.value) },
						}),
					]),
					h(Toggle, {
						key: 'sound',
						label: '通知带声音',
						checked: draft.sound === true,
						onChange: function (v) { patchTop('sound', v) },
					}),
					h(Toggle, {
						key: 'root',
						label: '只提醒根会话',
						hint: '子代理与 workflow 子会话不打扰你',
						checked: draft.onlyRootSessions === true,
						onChange: function (v) { patchTop('onlyRootSessions', v) },
					}),
					h(Toggle, {
						key: 'aborted',
						label: '你手动打断的轮次不提醒',
						checked: draft.skipAbortedTurns === true,
						onChange: function (v) { patchTop('skipAbortedTurns', v) },
					}),
				]),

				// ---- 抑制 ----
				h('section', { key: 'suppress', className: 'dsa-card' }, [
					h('div', { key: 'h', className: 'dsa-card-title' }, '专注时抑制'),
					h(Toggle, {
						key: 'sw',
						label: '你正在看 DSH 时不弹卡片，但仍响铃声',
						hint: '仅对 desktop 端生效；web 端不做抑制',
						checked: draft.suppressWhenFocused === true,
						disabled: !desktopOnline,
						onChange: function (v) { patchTop('suppressWhenFocused', v) },
					}),
					h('div', { key: 'state', className: 'dsa-hint' },
						desktopOnline
							? (snapshot.clients.suppressCardNow === true
								? '当前：desktop 端在线且在焦点，卡片正被抑制。'
								: '当前：desktop 端在线；此刻不会抑制。')
							: '当前：未检测到 desktop 端（该项仅对 desktop 端生效）。'),
				]),

				// ---- 模板 ----
				h('section', { key: 'tpl', className: 'dsa-card' }, [
					h('div', { key: 'h', className: 'dsa-card-title' }, '通知内容'),
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
					h('div', { key: 'h', className: 'dsa-card-title' }, '铃声'),
					h(Toggle, {
						key: 'en',
						label: '启用铃声',
						hint: '卡片被抑制时铃声照响——「看着界面」不等于「注意力在这条通知上」',
						checked: chime.enabled === true,
						onChange: function (v) { patchTop('chime', Object.assign({}, chime, { enabled: v })) },
					}),
					h('label', { key: 'src', className: 'dsa-field' }, [
						h('span', { key: 'l' }, '铃声来源'),
						h('select', {
							key: 'i',
							value: String(chime.source || 'system'),
							disabled: chime.enabled !== true,
							onChange: function (e) { patchTop('chime', Object.assign({}, chime, { source: e.target.value })) },
						}, [
							h('option', { key: 'sys', value: 'system' }, 'Windows 系统声音'),
							h('option', { key: 'file', value: 'file' }, '自定义音频文件'),
						]),
					]),
					chime.source === 'file'
						? h('label', { key: 'fp', className: 'dsa-field' }, [
							h('span', { key: 'l' }, '音频文件路径（.wav）'),
							h('input', {
								key: 'i',
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
					h('div', { key: 'h', className: 'dsa-card-title' }, '限流'),
					h(Toggle, {
						key: 'en',
						label: '启用限流',
						checked: rateLimit.enabled === true,
						onChange: function (v) { patchTop('rateLimit', Object.assign({}, rateLimit, { enabled: v })) },
					}),
					h('div', { key: 'row', className: 'dsa-editor-row' }, [
						h('label', { key: 'max', className: 'dsa-inline-field' }, [
							h('span', { key: 'l' }, '最多条数'),
							h('input', {
								key: 'i', type: 'number', min: 1, max: 100,
								value: String(rateLimit.max === undefined ? 3 : rateLimit.max),
								disabled: rateLimit.enabled !== true,
								onChange: function (e) { patchTop('rateLimit', Object.assign({}, rateLimit, { max: Number(e.target.value) })) },
							}),
						]),
						h('label', { key: 'win', className: 'dsa-inline-field' }, [
							h('span', { key: 'l' }, '窗口（秒）'),
							h('input', {
								key: 'i', type: 'number', min: 1, max: 3600,
								value: String(rateLimit.windowSeconds === undefined ? 10 : rateLimit.windowSeconds),
								disabled: rateLimit.enabled !== true,
								onChange: function (e) { patchTop('rateLimit', Object.assign({}, rateLimit, { windowSeconds: Number(e.target.value) })) },
							}),
						]),
					]),
					h(Toggle, {
						key: 'co',
						label: '超出窗口时合并成一条稍后发出',
						hint: '关闭则超出的被丢弃',
						checked: rateLimit.coalesce === true,
						disabled: rateLimit.enabled !== true,
						onChange: function (v) { patchTop('rateLimit', Object.assign({}, rateLimit, { coalesce: v })) },
					}),
					h('div', { key: 'stat', className: 'dsa-hint' },
						'当前窗口用量：' + String(snapshot.dispatch.windowUsed)
						+ ' / ' + String(snapshot.dispatch.windowMax)
						+ '（' + String(snapshot.dispatch.windowSeconds) + ' 秒）'
						+ (snapshot.dispatch.pendingCoalesced > 0 ? '，待合并 ' + String(snapshot.dispatch.pendingCoalesced) + ' 条' : '')),
				]),

				// ---- 操作 ----
				h('div', { key: 'actions', className: 'dsa-actions' }, [
					h('button', {
						key: 'save', type: 'button',
						className: 'dsa-btn dsa-btn-primary',
						disabled: busy,
						onClick: save,
					}, busy ? '处理中…' : '保存'),
					h('button', {
						key: 'test', type: 'button',
						className: 'dsa-btn',
						disabled: busy,
						onClick: sendTest,
					}, '发一条测试通知'),
					notice !== null
						? h('span', {
							key: 'n',
							className: 'dsa-notice' + (notice.kind === 'error' ? ' dsa-error' : (notice.kind === 'warn' ? ' dsa-warn' : '')),
						}, notice.text)
						: null,
				]),

				// ---- 诊断 ----
				h('section', { key: 'diag', className: 'dsa-card' }, [
					h('div', { key: 'h', className: 'dsa-card-title' }, '诊断'),
					h('div', { key: 'rows', className: 'dsa-rows' }, [
						h('div', { key: 'kind', className: 'dsa-row' }, [
							h('span', { key: 'l', className: 'dsa-label' }, '当前端'),
							h('code', { key: 'v', className: 'dsa-value' },
								kind === KIND_DESKTOP ? 'desktop（桌面应用）' : 'web（浏览器）'),
						]),
						h('div', { key: 'online', className: 'dsa-row' }, [
							h('span', { key: 'l', className: 'dsa-label' }, '在线的端'),
							h('code', { key: 'v', className: 'dsa-value' },
								(snapshot.clients.liveKinds || []).join('、') || '（无）'),
						]),
						h('div', { key: 'aumid', className: 'dsa-row' }, [
							h('span', { key: 'l', className: 'dsa-label' }, '通知署名'),
							h('code', { key: 'v', className: 'dsa-value' },
								aumid.registered === true
									? String(aumid.primary) + '（已注册）'
									: 'Windows PowerShell（后备 AUMID）'),
						]),
						h('div', { key: 'path', className: 'dsa-row' }, [
							h('span', { key: 'l', className: 'dsa-label' }, '配置文件'),
							h('code', { key: 'v', className: 'dsa-value' }, String(snapshot.configPath || '')),
						]),
					]),

					// 信号表：这是「为什么没收到通知」的唯一答案来源。
					// 信号根本没到达、与到达后被过滤掉，从外面看都是沉默。
					h('div', { key: 'sig-title', className: 'dsa-subtitle' },
						'最近的信号（' + String((snapshot.signals || []).length) + ' 条）'),
					(snapshot.signals || []).length === 0
						? h('div', { key: 'sig-none', className: 'dsa-hint' }, '还没有任何信号到达。')
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

					h('div', { key: 'act-title', className: 'dsa-subtitle' }, '最近发出的通知'),
					(snapshot.dispatch.recent || []).length === 0
						? h('div', { key: 'act-none', className: 'dsa-hint' }, '还没有发出过通知。可点上方「发一条测试通知」验证投递链。')
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
											? ('失败：' + String(entry.error || '未知'))
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
			startReporting(ctx)

			// 样式由宿主代管：`styles.insert` 返回的清理函数会随本客户端半边一起卸载，
			// 因此不需要自己管理 <style> 的生命周期，也不会在插件卸载后留下孤儿样式。
			try {
				if (typeof styles !== 'undefined' && styles !== null && typeof styles.insert === 'function') {
					ctx.effect(function () {
						return styles.insert(STYLES)
					}, 'dsh-session-alert: styles')
				}
			} catch (error) {
				// 样式失败只影响观感，不应阻断设置页注册。
			}

			// 设置页入口：`settings.section` 是「一个设置页」。
			// 拿不到 slots 服务时静默跳过 —— 通知功能不依赖设置界面，
			// 不该因为界面注册失败而让整个半边报错。
			try {
				var slots = ctx.get('slots')
				if (slots !== undefined && slots !== null && typeof slots.inject === 'function') {
					ctx.effect(function () {
						return slots.inject('settings.section', function () {
							try {
								return slots.register({
									name: 'settings.section',
									id: 'session-alert',
									order: 130,
									label: function () { return 'SessionAlert' },
								}, SessionAlertSection)
							} catch (error) {
								return function () {}
							}
						})
					}, 'dsh-session-alert: settings section')
				}
			} catch (error) {
				// 同上。
			}
		}

		exports.apply = apply
		exports.inject = []
		exports.detectClientKind = detectClientKind
		exports.isFocused = isFocused
		return module.exports
	},
})
