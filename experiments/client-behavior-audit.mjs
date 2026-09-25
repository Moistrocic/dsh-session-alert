// 独立入口：审计客户端半边的**行为**（自动保存 + 标签名本地化）。
//
// **复用 `scripts/client-behavior-audit.mjs`，不在这里做第二份实现**——两份逻辑迟早漂移，
// 而漂移的那份不会有人发现。它和 `npm test` 里那几条断言用的是同一个模块、同一份快照。
//
// 用法：
//
//   node experiments/client-behavior-audit.mjs            # 只审计
//   node experiments/client-behavior-audit.mjs --mutate   # 顺带做变异检查
//
// `--mutate` 会依次破坏三样东西，并**要求审计把它们抓出来**：
//   1. 去掉「卸载时保存」——那正是「切换/关闭设置页」那一刻；
//   2. 给一个按钮的文案里塞上「保存」——检测「界面上不该再有保存按钮」的那条；
//   3. 把标签名改回去（zh 与 en 都改）——检测本地化那条。
// **一个不会失败的检查等于没有检查**，因此这三条必须能报错。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { auditClientAutosave, sampleState } from '../scripts/client-behavior-audit.mjs'

const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const source = readFileSync(clientPath, 'utf8')

async function run(label, mutated) {
  const result = await auditClientAutosave({ source: mutated, snapshot: sampleState() })
  return { label, result }
}

const main = await run('未变异', source)
const { evidence } = main.result

console.log('证据：')
console.log(`  写配置次数        ${evidence.postsAfterLoad}`)
console.log(`  排过的定时器      ${JSON.stringify(evidence.debounceMs)}（毫秒）`)
console.log(`  界面上有保存按钮  ${evidence.saveButtonSeen}`)
console.log(`  自动保存说明      已渲染=${evidence.hintSeen}`)
console.log(`  标签名            zh=${JSON.stringify(evidence.titleZh)} en=${JSON.stringify(evidence.titleEn)}`)
console.log(`  发送按钮          ${JSON.stringify(evidence.sendButtonText)}`)
console.log(`  预览那一行        ${JSON.stringify(evidence.previewText)}`)
console.log(`  页面上的按钮      ${evidence.buttonTexts.join(' / ')}`)

let failures = 0
if (main.result.problems.length === 0) {
  console.log('\n✔ 自动保存行为审计通过（防抖一次 + 卸载一次，全程无自咬循环）')
} else {
  failures += main.result.problems.length
  console.log('\n✘ 自动保存行为审计失败：')
  for (const problem of main.result.problems) console.log(`  - ${problem}`)
}

if (process.argv.includes('--mutate')) {
  console.log('\n--- 变异检查 ---')

  const mutations = [
    {
      label: '去掉「卸载时保存」',
      source: source.split('flushSave({ ui: false })').join('void 0'),
      expect: /卸载/,
    },
    {
      label: '给按钮文案塞上「保存」',
      source: source.replace("sendPreview: '发送这条通知',", "sendPreview: '保存',"),
      expect: /保存.*按钮/,
    },
    {
      label: '把「发送这条通知」按钮降级成普通按钮',
      source: source.replace("className: 'dsa-btn dsa-btn-primary dsa-btn-sm',", "className: 'dsa-btn dsa-btn-sm',"),
      expect: /找不到「发送这条通知」按钮/,
    },
    {
      label: '把标签名改回去',
      source: source.replace("title: '会话通知',", "title: 'SessionAlert',")
        .replace("title: 'Session Alert',", "title: 'SessionAlert',"),
      expect: /会话通知|Session Alert/,
    },
  ]

  for (const mutation of mutations) {
    if (mutation.source === source) {
      failures += 1
      console.log(`  ✘ ${mutation.label}：变异没能构造出来（找不到原文）——变异检查自身失效了`)
      continue
    }
    const mutated = await auditClientAutosave({ source: mutation.source, snapshot: sampleState() })
    const caught = mutated.problems.some((p) => mutation.expect.test(p))
    console.log(`  ${caught ? '✔' : '✘'} ${mutation.label} 必须被抓出来${caught ? '' : `：实际 ${JSON.stringify(mutated.problems)}`}`)
    if (!caught) failures += 1
  }
}

process.exit(failures === 0 ? 0 : 1)
