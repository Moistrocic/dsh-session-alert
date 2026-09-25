# 按钮点击的最小诊断
#
# 目的：判定「点击 toast 按钮」到底有没有到达处理程序，以及 %1 的实际内容。
# 做法：处理程序一进脚本就把入口参数与当前时间写进日志，不做任何其他事——
# 排除掉置顶逻辑本身可能抛异常造成的干扰。
#
# 输出：$env:TEMP\click-probe.log
#
# 注意：本文件必须保持 CRLF 换行 + UTF-8 BOM（见 .gitattributes）。

param(
  [string]$Url = '(未传入)',
  [string]$LogPath = "$env:TEMP\click-probe.log"
)

$stamp = (Get-Date).ToString('HH:mm:ss.fff')
$line = "$stamp`tinvoked`tUrl=$Url"
Add-Content -LiteralPath $LogPath -Value $line -Encoding utf8

# 同时把「参数有没有被正确绑定」写清楚：若 %1 没被替换，这里会看到字面量
if ($Url -eq '(未传入)') {
  Add-Content -LiteralPath $LogPath -Value "$stamp`tWARN`t-Url 未绑定，参数没传进来" -Encoding utf8
}
