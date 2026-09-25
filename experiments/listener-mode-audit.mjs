// 事件监听器 dispatch-mode 审计的独立入口。
//
// 逻辑在 `scripts/listener-mode-audit.mjs` 里，并被 `scripts/selftest.mjs` 以断言形式
// 纳入 `npm test`。这个文件只是让人能单独跑一次、看清逐条结果——
// **不做第二份实现**，否则两份逻辑迟早漂移，而漂移的那份不会有人发现。
import { auditPackageListeners, EVENT_MODES } from '../scripts/listener-mode-audit.mjs'

const packageRoot = new URL('..', import.meta.url)
const { registrations, problems } = auditPackageListeners(packageRoot)

console.log('事件监听器 dispatch-mode 审计')
console.log('（mode 表来源：cordis_inspect_query 的 Host Event 目录）\n')

for (const reg of registrations) {
  const mode = EVENT_MODES[reg.event] ?? '(未登记)'
  const modeOk = EVENT_MODES[reg.event] !== undefined
  const hasNext = /return\s+next\s*\(/.test(reg.handler)
  const appropriate = modeOk && (mode === 'waterfall' ? hasNext : !hasNext)
  console.log(`  ${appropriate ? 'ok  ' : 'FAIL'} ${reg.event}（${mode}，第 ${reg.line} 行）` +
    (mode === 'waterfall' ? `return next()=${hasNext}` : ''))
}

console.log('')
if (problems.length === 0) {
  console.log(`审计通过（${registrations.length} 个监听器）。`)
  process.exit(0)
}
console.log('发现问题：')
for (const p of problems) console.log('  - ' + p)
console.log('')
console.log('瀑布监听器不交出决定权会否决后续链，包括内建行为——这会阻断用户的提问与审批。')
process.exit(1)
