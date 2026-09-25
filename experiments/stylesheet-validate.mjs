// 校验 `lib/client.js` 里那张样式表：它是否真的是一段合法 CSS。
//
// ## 为什么需要它
//
// 样式由 `styles.insert(STYLES)` 注入，而 `STYLES` 是**一个由上百个字符串片段
// `.join('')` 拼出来的长字符串**。这种写法下，任何一处漏写分号或括号都会让
// 相邻规则粘在一起、被浏览器整条丢弃——**而页面不会报错，只是没样式**。
//
// 用户两次反馈「样式糟」之后，我一直在改数值；真正该先做的是**确认注入的这段文本
// 本身合法**。这个脚本就是那一步，而且可以反复跑。
import { readFileSync } from 'node:fs'

const path = new URL('../lib/client.js', import.meta.url)
const src = readFileSync(path, 'utf8')

// 抽出 STYLES 的数组字面量。
//
// 注意两个坑：
//  1. 必须在 `var STYLES = [` **之后**开始找 `].join('')`——文件前面还有别的短数组，
//     从文件头找会截到错误的位置（第一次写就踩了这个，报「Unexpected token ']'」）。
//  2. 求值时要把 `var STYLES = ` 换成 `(`…`)` 包起来，而不是替换成空串——
//     替换成空串会留下一个多余的 `[`，同样解析失败。
const startMarker = 'var STYLES = ['
const start = src.indexOf(startMarker)
if (start < 0) { console.error('找不到 STYLES 定义'); process.exit(2) }
const endMarker = "].join('')"
const end = src.indexOf(endMarker, start + startMarker.length)
if (end < 0) { console.error("找不到 ].join('') 结尾"); process.exit(2) }

const arrayLiteral = src.slice(start + 'var STYLES = '.length, end + 1)
let styles
try {
  // 这段是纯字面量数组（没有函数调用、没有外部引用），求值是安全的。
  styles = eval(`(${arrayLiteral}).join('')`) // eslint-disable-line no-eval
} catch (error) {
  console.error('STYLES 求值失败（说明定义本身有问题）：', error.message)
  console.error('片段开头：', JSON.stringify(arrayLiteral.slice(0, 80)))
  process.exit(1)
}

let bad = 0
const check = (label, ok, detail) => {
  if (!ok) bad++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : '  ' + (detail || '')}`)
}

check('STYLES 是字符串', typeof styles === 'string', `实际 ${typeof styles}`)
check('长度合理（> 2000）', styles.length > 2000, `实际 ${styles.length}`)

const opens = (styles.match(/\{/g) || []).length
const closes = (styles.match(/\}/g) || []).length
check('花括号配平', opens === closes, `{ ${opens} 个，} ${closes} 个`)

const parens = (styles.match(/\(/g) || []).length
const parensClose = (styles.match(/\)/g) || []).length
check('圆括号配平', parens === parensClose, `( ${parens} 个，) ${parensClose} 个`)

// 相邻规则粘连：`}` 后面若直接跟选择器而没有分隔，是合法 CSS；
// 但 `}` 后面若跟的是 `;` 或另一个 `}` 之外的东西且没有 `.`/`@`/空格，就可能是漏了分隔。
const glued = styles.match(/\}[^\s.@}][^{]*\{/g)
check('规则之间没有粘连（`}` 后紧跟非选择器字符）', glued === null,
  glued === null ? '' : `可疑片段：${JSON.stringify(glued.slice(0, 3))}`)

// 每条规则都应有选择器与声明块
const rules = styles.split('}').filter((r) => r.trim().length > 0)
const malformed = rules.filter((r) => !r.includes('{'))
check('每条规则都有声明块', malformed.length === 0,
  malformed.length === 0 ? '' : `缺 { 的片段：${JSON.stringify(malformed.slice(0, 3))}`)

// 关键规则是否在里面
for (const key of ['box-sizing:border-box', 'auto-fit', 'bg-layer-3', '.dsa-input']) {
  check(`包含关键规则 ${key}`, styles.includes(key))
}

// 声明里不该出现空值（例如 `color:;`）
const emptyDecl = styles.match(/[a-z-]+:\s*[;}]/g)
check('没有空声明值', emptyDecl === null, emptyDecl === null ? '' : `${JSON.stringify(emptyDecl.slice(0, 3))}`)

console.log('')
console.log(`共 ${rules.length} 条规则`)
console.log(bad === 0 ? '样式表合法。' : `${bad} 项失败——注入的 CSS 可能被浏览器整条丢弃。`)
process.exit(bad === 0 ? 0 : 1)
