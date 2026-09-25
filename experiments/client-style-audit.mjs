// 独立入口：审计客户端半边的样式注入。
//
// **复用 `scripts/client-style-audit.mjs`，不在这里做第二份实现。**
// 两份逻辑迟早漂移，而漂移的那份不会有人发现——这条在 listener-mode-audit 上
// 已经写过一次，理由相同。
//
// 它和 `npm test` 里那三条断言用的是同一个模块，因此这里跑出「通过」时，
// 与 `npm test` 通过是同一件事，不是第二份独立证据。
//
// 用法：
//
//   node experiments/client-style-audit.mjs            # 审计 lib/client.js
//   node experiments/client-style-audit.mjs --mutate   # 顺带做变异检查
//
// `--mutate` 会：去掉注入效应 → 必须报「没有标签」；改回 `styles.insert` → 必须报死路。
// **一个不会失败的检查等于没有检查**，所以这两条必须能报错，否则本审计本身不可信。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { auditClientStyleInjection } from '../scripts/client-style-audit.mjs'

const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const source = readFileSync(clientPath, 'utf8')

const result = await auditClientStyleInjection({ source })

console.log('证据：')
console.log(`  标签数      ${result.evidence.tags}`)
console.log(`  CSS 字符数  ${result.evidence.chars}`)
console.log(`  解析出的规则 ${result.evidence.rules}`)
console.log(`  实测读数    ${JSON.stringify(result.evidence.report === null ? null : result.evidence.report.applied)}`)
console.log(`  登记的效应  ${JSON.stringify(result.evidence.effectLabels)}`)

let failures = 0
if (result.problems.length === 0) {
  console.log('\n✔ 样式注入审计通过')
} else {
  failures += result.problems.length
  console.log('\n✘ 样式注入审计失败：')
  for (const problem of result.problems) console.log(`  - ${problem}`)
}

if (process.argv.includes('--mutate')) {
  console.log('\n--- 变异检查 ---')

  // 变异一：去掉注入效应（等价于「CSS 根本没有进入文档」）。
  const withoutInjection = source.replace(
    /ctx\.effect\(function \(\) \{\s*return installStyles\(\)\s*\}, 'dsh-session-alert: styles'\)/,
    '/* 变异：注入被移除 */',
  )
  if (withoutInjection === source) {
    failures += 1
    console.log('  ✘ 变异一无法构造（找不到注入效应的原文）——变异检查自身失效了')
  } else {
    const mutated = await auditClientStyleInjection({ source: withoutInjection })
    const caught = mutated.problems.some((p) => p.includes('恰好有 1 个'))
    console.log(`  ${caught ? '✔' : '✘'} 去掉注入必须被抓出来${caught ? '' : '：实际 ' + JSON.stringify(mutated.problems)}`)
    if (!caught) failures += 1
  }

  // 变异二：改回 `styles.insert`（真机上永不执行的那条路）。
  const withDeadApi = source.replace(
    /ctx\.effect\(function \(\) \{\s*return installStyles\(\)\s*\}, 'dsh-session-alert: styles'\)/,
    "ctx.effect(function () { return styles.insert(STYLES) }, 'dsh-session-alert: styles')",
  )
  if (withDeadApi === source) {
    failures += 1
    console.log('  ✘ 变异二无法构造——变异检查自身失效了')
  } else {
    const mutated = await auditClientStyleInjection({ source: withDeadApi })
    const caught = mutated.problems.some((p) => p.includes('styles.insert'))
    console.log(`  ${caught ? '✔' : '✘'} 改回 styles.insert 必须被抓出来${caught ? '' : '：实际 ' + JSON.stringify(mutated.problems)}`)
    if (!caught) failures += 1
  }
}

process.exit(failures === 0 ? 0 : 1)
