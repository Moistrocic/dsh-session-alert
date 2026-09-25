// 客户端组件的最小 React 替身（可复用模块）。
//
// `experiments/settings-render-check.mjs` 与 `scripts/client-behavior-audit.mjs` 都用它——
// **只有一份实现**。两份替身迟早漂移，而漂移的那份不会有人发现；这条在本项目的
// `listener-mode-audit` 与 `event-harness` 上已经写过两次，理由相同。
//
// ## 替身比生产代码更需要被怀疑（本项目的第 4 条前提）
//
// 已经栽过的四种形态都记在 `AGENTS.md` 里。就组件替身而言，最容易骗自己的三处是：
//
//  1. **状态格必须按组件隔离并跨渲染保留**。第一版用了一个全局数组，于是子组件读到
//     父组件的状态格，症状看起来像「子组件有 bug」——实际是替身串了线。
//  2. **`useRef` 也必须跨渲染保留**。React 的 ref 是「同一个盒子活到卸载」；
//     每次渲染返回一个新对象会让「写进 ref 的值下一次渲染就没了」，
//     而真实 React 上并不会——于是自动保存那类逻辑在替身里全错、在真机上是好的。
//  3. **效应要有依赖比较与清理**。只把 `useEffect` 排进队列、忽略依赖数组与返回的
//     清理函数，就测不到「卸载时该做什么」——而那恰恰是「切换/关闭设置页时保存」
//     这类需求的核心。
//
// 因此这个替身刻意做到：状态与 ref 跨渲染保留、效应按依赖数组决定是否重跑、
// 清理函数在重跑前与卸载时执行（逆序）、`unmount()` 显式暴露。

/** 一次渲染的产物：元素树 + 待提交的效应 + 是否请求了重渲染。 */
class RenderResult {
  constructor(tree, pending, store, isDirty, commit) {
    this.tree = tree
    this.effects = pending
    this.store = store
    this._isDirty = isDirty
    this._commit = commit
  }

  /** 本轮是否请求了重渲染。 */
  isDirty() { return this._isDirty() }

  /** 提交：按声明顺序处理效应（依赖未变的跳过，变了的先跑旧清理）。 */
  commit() { this._commit() }
}

/**
 * 造一个替身 React。
 *
 * @returns {{ react: object, render: Function, unmount: Function, mounted: Function }}
 */
export function makeReact() {
  /** 按组件类型隔离的状态格。用 WeakMap 而不是组件名，避免同名组件互相污染。 */
  const stores = new WeakMap()

  let currentStore = null
  let cellCursor = 0
  let refCursor = 0
  let pendingEffects = []
  let dirty = false

  function storeFor(Component) {
    let store = stores.get(Component)
    if (store === undefined) {
      // cells: useState 的格；refs: useRef 的盒子；slots: 效应槽（依赖 + 清理函数）
      store = { cells: [], refs: [], slots: [], alive: false }
      stores.set(Component, store)
    }
    return store
  }

  /** 依赖数组比较：长度相同且逐项 Object.is。没有依赖数组 = 每次都重跑。 */
  function depsEqual(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    if (left.length !== right.length) return false
    for (let i = 0; i < left.length; i += 1) {
      if (!Object.is(left[i], right[i])) return false
    }
    return true
  }

  /** 跑一个效应槽的清理函数。置空在前，因此重复卸载不会跑第二次。 */
  function runCleanup(store, index) {
    const slot = store.slots[index]
    if (slot === undefined || typeof slot.cleanup !== 'function') return
    const cleanup = slot.cleanup
    slot.cleanup = null
    cleanup()
  }

  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),

    useState: (init) => {
      const store = currentStore
      const index = cellCursor
      cellCursor += 1
      if (!(index in store.cells)) store.cells[index] = typeof init === 'function' ? init() : init
      const setter = (value) => {
        const next = typeof value === 'function' ? value(store.cells[index]) : value
        // Object.is 语义：相同则不重渲染，避免无限循环。
        if (!Object.is(next, store.cells[index])) {
          store.cells[index] = next
          dirty = true
        }
      }
      return [store.cells[index], setter]
    },

    useRef: (init) => {
      const store = currentStore
      const index = refCursor
      refCursor += 1
      if (!(index in store.refs)) store.refs[index] = { current: init === undefined ? null : init }
      return store.refs[index]
    },

    useEffect: (fn, deps) => {
      pendingEffects.push({ fn, deps })
    },
  }

  return {
    react,

    /**
     * 渲染一次并返回产物。效应**不会**在这里执行，要调 `result.commit()`——
     * 真实 React 也是「渲染 → 提交」两段，调用方显式提交才能表达这个次序。
     */
    render(Component, props) {
      currentStore = storeFor(Component)
      currentStore.alive = true
      cellCursor = 0
      refCursor = 0
      pendingEffects = []
      dirty = false

      const tree = Component(props)

      const store = currentStore
      const pending = pendingEffects
      let committed = false
      const commit = () => {
        if (committed) return
        committed = true
        // 按声明顺序对齐效应槽：组件里效应的声明顺序是固定的，因此槽位稳定。
        for (let i = 0; i < pending.length; i += 1) {
          const item = pending[i]
          const slot = store.slots[i]
          if (slot !== undefined && depsEqual(slot.deps, item.deps)) continue
          if (slot !== undefined) runCleanup(store, i)
          const cleanup = item.fn()
          store.slots[i] = {
            deps: item.deps,
            cleanup: typeof cleanup === 'function' ? cleanup : null,
          }
        }
        // 本轮没声明、而上一轮存在的槽（组件分支变了）要清理掉，否则会留下幽灵效应。
        for (let i = pending.length; i < store.slots.length; i += 1) {
          if (store.slots[i] !== undefined) runCleanup(store, i)
          delete store.slots[i]
        }
      }

      return new RenderResult(tree, pending, store, () => dirty, commit)
    },

    /** 卸载一个组件：逆序执行全部清理函数（React 的语义）。 */
    unmount(Component) {
      const store = stores.get(Component)
      if (store === undefined) return
      store.alive = false
      for (let i = store.slots.length - 1; i >= 0; i -= 1) runCleanup(store, i)
    },

    /** 该组件是否仍处于挂载状态。 */
    mounted(Component) {
      const store = stores.get(Component)
      return store !== undefined && store.alive === true
    },
  }
}

/**
 * 已经 resolve 的 thenable，`then` 同步执行。
 *
 * 这样「fetch 完成 → setState → 重渲染」在测试里一步到位，不必真的等一个事件循环。
 * 替身 `fetch` 用它，调用方才可能在一个 `render/commit` 循环里收敛。
 */
export function syncThenable(value) {
  const wrap = (v) => {
    if (v !== null && typeof v === 'object' && typeof v.then === 'function') return v
    return {
      then(onFulfilled) { return wrap(onFulfilled(v)) },
      catch() { return this },
    }
  }
  return wrap(value)
}
