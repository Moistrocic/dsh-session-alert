// 形状选择自检：确认「无 actions」时生成的脚本**在运行时不会创建按钮**。
//
// 判据不是「脚本文本里有没有 CreateElement('actions')」——脚本是模板化的，那几个
// 字符串总是存在。真正的判据是：建按钮的代码是否被条件守卫住，以及传入的数组
// 在空情况下是否真的为空。
//
// 这一条值得独立守着：ADR 0001 规定「为仅 web 受众发出的卡片绝不能携带控件」。
// 边界一旦破了，表现是 web 用户看到一个点了没反应的按钮——不报错，只让人以为插件坏了。
import { buildToastScript, normaliseActions } from '../lib/notify.js'

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures += 1
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${condition ? '' : '  ' + (detail || '')}`)
}

const action = { content: '知道了', arguments: 'dsh-session-alert://open/?session=x', activationType: 'protocol' }
const withBtn = buildToastScript({ title: 'T', body: 'B', actions: [action] })
const noBtn = buildToastScript({ title: 'T', body: 'B', actions: [] })

// 断言一：建按钮的代码被条件守卫住（变量名是 $Actions，首字母大写）。
check('生成脚本含 Count -gt 0 守卫', /\$Actions\.Count\s+-gt\s+0/.test(noBtn), '未找到守卫')

// 断言二：actions 数据的注入形态。用 indexOf 定位而不是正则，避免转义层数过多出错。
// 空情况下数组字面量必须真的为空——否则守卫虽然写着 Count -gt 0，却仍会建出按钮。
function actionsArrayLines(script) {
  const lines = script.split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('$actions = @(') >= 0) { start = i; break }
  }
  if (start < 0) return null
  const body = []
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed === ')') break
    if (trimmed.length > 0) body.push(trimmed)
  }
  return body
}

const emptyBody = actionsArrayLines(noBtn)
const filledBody = actionsArrayLines(withBtn)

check('空 actions：能定位到数组构造', emptyBody !== null)
check('空 actions：数组体内为空（不会建出按钮）', emptyBody !== null && emptyBody.length === 0,
  emptyBody === null ? '' : '实际有 ' + emptyBody.length + ' 项')
check('非空 actions：数组体内有按钮项', filledBody !== null && filledBody.length === 1,
  filledBody === null ? '' : '实际有 ' + filledBody.length + ' 项')

// 断言三：按钮内容也走 base64，因此标题/参数的引号与尖括号进不了脚本语法。
check('按钮内容经 base64 编码而非直插', filledBody !== null && filledBody.join('').indexOf('ConvertFrom-B64Text') >= 0)

// 断言四：正文与标题始终走 base64 通道（不受 actions 影响）。
check('无按钮时正文/标题仍以 base64 传递',
  (noBtn.match(/ConvertFrom-B64Text/g) || []).length >= 2)

// 断言五：归一化边界。
check('normaliseActions(undefined) 为空', normaliseActions(undefined).length === 0)
check('normaliseActions([]) 为空', normaliseActions([]).length === 0)
check('normaliseActions 截断到 5 个', normaliseActions(Array.from({ length: 7 }, (_, i) => ({ content: 'c' + i }))).length === 5)

console.log('')
console.log(failures === 0 ? '形状选择全部通过。' : `${failures} 项失败。`)
process.exit(failures === 0 ? 0 : 1)
