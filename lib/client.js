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
		 * 设置页内容。
		 *
		 * 现阶段聚焦于「让看不见的机制变可见」：端别自报是否生效、通知署名走的是哪条
		 * 路径、配置文件在哪。完整的模板编辑器与开关随后补齐。
		 */
		function SessionAlertSection() {
			var h = react.createElement
			var useState = react.useState
			var useEffect = react.useEffect

			var statePair = useState(null)
			var snapshot = statePair[0]
			var setSnapshot = statePair[1]

			var errorPair = useState(null)
			var error = errorPair[0]
			var setError = errorPair[1]

			useEffect(function () {
				var cancelled = false
				function load() {
					try {
						fetch(STATE_ENDPOINT)
							.then(function (response) {
								if (!response.ok) throw new Error('HTTP ' + response.status)
								return response.json()
							})
							.then(function (body) {
								if (!cancelled) { setSnapshot(body); setError(null) }
							})
							.catch(function (cause) {
								if (!cancelled) {
									setError(String(cause && cause.message ? cause.message : cause))
								}
							})
					} catch (cause) {
						if (!cancelled) setError(String(cause))
					}
				}
				load()
				var timer = setInterval(load, 5000)
				return function () {
					cancelled = true
					clearInterval(timer)
				}
			}, [])

			var kind = detectClientKind()
			var rows = []

			rows.push(h('div', { key: 'kind', className: 'dsa-row' }, [
				h('span', { key: 'l', className: 'dsa-label' }, '当前端'),
				h('code', { key: 'v', className: 'dsa-value' },
					kind === KIND_DESKTOP ? 'desktop（桌面应用）' : 'web（浏览器）'),
			]))

			if (error !== null) {
				rows.push(h('div', { key: 'err', className: 'dsa-note dsa-error' },
					'读取插件状态失败：' + error + '（若插件刚启用，稍候会自动恢复）'))
			} else if (snapshot === null) {
				rows.push(h('div', { key: 'loading', className: 'dsa-note' }, '正在读取插件状态…'))
			} else {
				var aumid = snapshot.aumid || {}
				rows.push(h('div', { key: 'aumid', className: 'dsa-row' }, [
					h('span', { key: 'l', className: 'dsa-label' }, '通知署名'),
					h('code', { key: 'v', className: 'dsa-value' },
						aumid.registered === true
							? String(aumid.primary) + '（已注册）'
							: 'Windows PowerShell（后备 AUMID）'),
				]))
				rows.push(h('div', { key: 'path', className: 'dsa-row' }, [
					h('span', { key: 'l', className: 'dsa-label' }, '配置文件'),
					h('code', { key: 'v', className: 'dsa-value' }, String(snapshot.configPath || '')),
				]))
			}

			return h('div', { className: 'dsa-root' }, [
				h('div', { key: 'head', className: 'dsa-head' }, [
					h('div', { key: 't', className: 'dsa-title' }, 'SessionAlert'),
					h('div', { key: 'd', className: 'dsa-desc' },
						'会话需要你介入时发一条 Windows 通知；点击通知可把 DSH 窗口显示到最上层。'),
				]),
				h('div', { key: 'body', className: 'dsa-body' }, rows),
			])
		}

		/**
		 * 挂载浏览器半边。
		 *
		 * @param {object} ctx - 客户端 cordis 上下文。
		 */
		function apply(ctx) {
			startReporting(ctx)

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
