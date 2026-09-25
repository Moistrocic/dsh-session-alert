// 待决审批的令牌表：把「通知上的一个按钮」绑定到**恰好一个**审批请求上。
//
// ## 它存在的理由
//
// 通知卡片上的「批准 / 拒绝」要真的能放行一次工具调用，因此决定必须从通知那侧
// 回到审批应答者的手里。回来这条路是：toast 按钮 → 协议激活 → 启动器（本机进程）
// → `POST /api/dsh-session-alert/decide`。**这条通道是本地无凭据的**（本插件的路由
// 本来就不需要凭据），所以决定不能只靠「一个 id」——那等于给本机任何进程一个
// 「放行任意待批工具调用」的入口。
//
// 令牌就是这道关：128 位随机、**只发进那条通知**、一次性、有期限。拿不到令牌就
// 提交不了决定，而令牌只出现在用户点得到的那张卡片里。
//
// ## 三条不变式（沿用 ADR 0003 的约束，ADR 0006 之后重新启用）
//
// 1. **一个令牌只绑定一个请求**，且**只能用一次**。用完即删；重复提交一律拒绝，
//    绝不落到「另一个恰好待批的请求」上。
// 2. **过期即失效（fail closed）**。请求结算、用户中止、卡片没发出去、超时——
//    任何一种情况下令牌都不再可用，而**默认永远是「没有决定」**：
//    拿不到决定就把决定权交回界面（`next()`），沉默绝不是同意。
// 3. **不落盘、不进 `/state`**。令牌只在内存里，也只出现在那张通知的按钮参数里；
//    诊断接口只暴露「有几个待决」与它们的会话/工具，绝不暴露令牌本身。

/** 决定的有效期上限。到期后按钮失效，但审批本身照旧可以界面里作答。 */
export const DECISION_TTL_MS = 10 * 60 * 1000

/** 按钮参数里的决定词 → 审批结果词汇。 */
export const DECISION_OUTCOMES = {
  allow: 'allowed-once',
  deny: 'rejected',
}

/**
 * 生成一个令牌。
 *
 * 用 `crypto.randomUUID()`（128 位随机）而不是计数器或时间戳：能被猜到的令牌
 * 等于没有令牌。
 *
 * @returns 32 位十六进制字符串（去掉连字符）。
 */
function defaultToken() {
  return globalThis.crypto.randomUUID().replace(/-/g, '')
}

/**
 * 待决审批的令牌表。**永不抛异常**：审批链上的任何失败都必须退化成「没有决定」。
 */
export class DecisionStore {
  /**
   * @param options - `ttlMs` 有效期；`now` 取时刻（测试可注入）；`randomToken` 生成令牌。
   */
  constructor(options = {}) {
    this.ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DECISION_TTL_MS
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.randomToken = typeof options.randomToken === 'function' ? options.randomToken : defaultToken
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {}
    /** token → { token, sessionId, toolName, callId, openedAt, resolve, settled } */
    this.pending = new Map()
  }

  /**
   * 开一个待决项。
   *
   * @param request - 会话 id、工具名、调用 id。
   * @returns `{ token, promise, dispose }`；`promise` 解析为 DSH 的结果词汇
   *   （`'allowed-once'` / `'rejected'`），**永远不会 reject**。
   */
  open(request = {}) {
    const token = String(this.randomToken())
    let resolve = () => {}
    const promise = new Promise((settle) => { resolve = settle })
    const entry = {
      token,
      sessionId: typeof request.sessionId === 'string' ? request.sessionId : '',
      toolName: typeof request.toolName === 'string' ? request.toolName : '',
      callId: typeof request.callId === 'string' ? request.callId : '',
      openedAt: this.now(),
      resolve,
    }
    this.pending.set(token, entry)
    return {
      token,
      promise,
      /**
       * 作废这个令牌（请求已结算／中止／卡片没发出去时调用）。
       *
       * 只删令牌，**不去 resolve** —— 决定权仍在界面那侧，插件不替用户下结论。
       */
      dispose: () => { this.pending.delete(token) },
    }
  }

  /**
   * 提交一个决定。
   *
   * @param token - 卡片按钮带回来的令牌。
   * @param decision - `'allow'` 或 `'deny'`。
   * @returns `{ ok: true, outcome }` 或 `{ ok: false, reason }`（reason 是给人看的原因）。
   */
  decide(token, decision) {
    const key = typeof token === 'string' ? token.trim() : ''
    const outcome = DECISION_OUTCOMES[typeof decision === 'string' ? decision.trim() : '']
    if (key.length === 0) return { ok: false, reason: '缺少令牌' }
    if (outcome === undefined) return { ok: false, reason: `不认识的决定：${String(decision)}` }

    const entry = this.pending.get(key)
    if (entry === undefined) {
      // 三种成因都归到这里，且**都不可重试**：已用过、已过期、或从来没发出去过。
      return { ok: false, reason: '这个决定已经失效（可能已用过、已过期，或这张卡片对应的请求已经结束）' }
    }
    if (this.now() - entry.openedAt > this.ttlMs) {
      this.pending.delete(key)
      return { ok: false, reason: '这个决定已经过期，请在界面里作答' }
    }

    // **先删再兑现**：即使兑现过程抛错，令牌也不会留在表里被二次使用。
    this.pending.delete(key)
    try {
      entry.resolve(outcome)
    } catch (error) {
      this.onEvent('warn', `提交决定时出错：${error && error.message ? error.message : String(error)}`)
      return { ok: false, reason: '提交失败，请在界面里作答' }
    }
    this.onEvent('info', `已从通知提交决定：${decision} → ${outcome}（${entry.toolName || '未知工具'}）`)
    return { ok: true, outcome }
  }

  /** 清理过期令牌。返回清掉的条数。 */
  sweep() {
    const now = this.now()
    let removed = 0
    for (const [token, entry] of this.pending) {
      if (now - entry.openedAt > this.ttlMs) { this.pending.delete(token); removed += 1 }
    }
    return removed
  }

  /** 诊断用：**绝不包含令牌**。 */
  snapshot() {
    return {
      pending: this.pending.size,
      requests: [...this.pending.values()].map((entry) => ({
        sessionId: entry.sessionId,
        toolName: entry.toolName,
        openedAt: entry.openedAt,
      })),
    }
  }
}
