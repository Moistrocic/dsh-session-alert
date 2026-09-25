<#
    通知降级链演练 —— **人工验收工具，破坏性，不参与 `npm test`**。

    ## 用途

    按验收标准刻意演练整条降级链，确认退出码约定真的成立：

        phase       做了什么                                  期望
        ---------   ---------------------------------------   -----------------------------
        baseline    自有 AUMID 下真实投递 / 铃声 / 控制台判据  全部 PASS，code=0，NO_CONSOLE
        fallback    **把自有 AUMID 的开始菜单快捷方式改名**    投递计划只剩后备 AUMID，code=5
        balloon     保持未注册 + 解释器强制为 pwsh 7            code=6（托盘气泡）
        restored    恢复快捷方式后重跑                         code=0
        cleanup     清空自有 AUMID 的操作中心历史              不留测试通知

    ## 为什么是破坏性的、为什么必须显式调用

    第 2 阶段会**临时把 `%APPDATA%\...\Start Menu\Programs\DSH Session Alert.lnk` 改名**。
    在此期间本插件的通知会以「Windows PowerShell」的身份出现（横幅仍会弹，署名不同）。
    这类操作绝不能挂在 `npm test` 的旗标下——迟早有人在 CI 上或手滑时触发它。

    ## 恢复与自证

    改名与恢复放在**同一个 `try/finally`** 里，无论中间哪一步失败（包括 node 非零退出、
    甚至 node 崩溃）都会还原；末段再用 **SHA256** 比对演练前后的字节，证明恢复到位。
    若 finally 里发现备份与目标都不见了，会用 `scripts/register-aumid.ps1` 重建并如实报告。

    ## 用法

        powershell -NoProfile -ExecutionPolicy Bypass -File experiments/notify-degradation-drill.ps1

    会先后弹出若干条通知（其中一条是托盘气泡，约 5 秒），请提前知悉。

    ## 期望输出

        Phase    NodeExit
        baseline        0
        fallback        0
        balloon         0
        restored        0
        cleanup         0
        快捷方式指纹前后一致: True
        全部通过。

    本文件必须保持 CRLF 换行 + UTF-8 BOM（见 .gitattributes）。
#>

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$phases = Join-Path $PSScriptRoot 'notify-drill-phases.mjs'
$register = Join-Path $repo 'scripts\register-aumid.ps1'
$lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\DSH Session Alert.lnk'
$bak = "$lnk.drill-bak"
$ps5 = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$script:phaseResults = @()

function Invoke-Phase {
    param([string]$Name)
    Write-Host ''
    Write-Host ('#' * 72)
    Write-Host "### phase: $Name"
    Write-Host ('#' * 72)
    # 必须先接住输出再打印：否则原生命令的 stdout 会混进函数的输出流，
    # 于是「退出码」变成一个字符串数组，后面所有判定跟着全错。
    $output = & node $phases $Name 2>&1
    $code = $LASTEXITCODE
    $output | Write-Host
    $script:phaseResults += [pscustomobject]@{ Phase = $Name; NodeExit = $code }
    Write-Host "### phase $Name 结束：node 退出码 $code"
    return $code
}

Write-Host '=== 前置：注册状态与快捷方式指纹 ==='
& $ps5 -NoProfile -ExecutionPolicy Bypass -File $register -Status
$statusCode = $LASTEXITCODE
Write-Host "register-aumid.ps1 -Status 退出码 = $statusCode"
if ($statusCode -ne 0) { throw '前置检查失败：AUMID 未注册，请先运行 scripts/register-aumid.ps1' }
if (-not (Test-Path $lnk)) { throw "找不到快捷方式：$lnk" }
$beforeHash = (Get-FileHash -LiteralPath $lnk -Algorithm SHA256).Hash
$beforeStamp = (Get-Item -LiteralPath $lnk).LastWriteTimeUtc.ToString('o')
Write-Host "演练前 .lnk SHA256 = $beforeHash"
Write-Host "演练前 .lnk 写入时间 = $beforeStamp"

Write-Host ''
Write-Host '=== 幂等性检查：再运行两次 register-aumid.ps1，文件不应被改动 ==='
& $ps5 -NoProfile -ExecutionPolicy Bypass -File $register
Write-Host "第一次退出码 = $LASTEXITCODE"
& $ps5 -NoProfile -ExecutionPolicy Bypass -File $register
Write-Host "第二次退出码 = $LASTEXITCODE"
$afterIdempotentHash = (Get-FileHash -LiteralPath $lnk -Algorithm SHA256).Hash
Write-Host "幂等检查后 .lnk SHA256 = $afterIdempotentHash"
Write-Host ("幂等: " + $(if ($afterIdempotentHash -eq $beforeHash) { '未改动文件（通过）' } else { '文件被改写（不通过）' }))

$baselineCode = Invoke-Phase -Name 'baseline'

try {
    Write-Host ''
    Write-Host '=== 演练第 1 级：把自有 AUMID 的开始菜单快捷方式改名 ==='
    if (Test-Path $bak) { Remove-Item -LiteralPath $bak -Force }
    Move-Item -LiteralPath $lnk -Destination $bak -Force
    Write-Host "已改名：$lnk  ->  $bak"
    Write-Host ("此刻快捷方式存在: " + (Test-Path $lnk))
    $fallbackCode = Invoke-Phase -Name 'fallback'

    Write-Host ''
    Write-Host '=== 演练第 2 级：保持未注册，并把解释器强制为 PowerShell 7（toast 必然失败）==='
    $balloonCode = Invoke-Phase -Name 'balloon'
} finally {
    Write-Host ''
    Write-Host '=== 恢复 ==='
    if (Test-Path $bak) {
        Move-Item -LiteralPath $bak -Destination $lnk -Force
        Write-Host "已还原：$bak  ->  $lnk"
    } elseif (Test-Path $lnk) {
        Write-Host '备份不存在且目标存在：无需还原。'
    } else {
        Write-Host '！！备份与目标都不存在，正在用注册脚本重建 ！！' -ForegroundColor Red
        & $ps5 -NoProfile -ExecutionPolicy Bypass -File $register
    }
}

Start-Sleep -Seconds 2
Write-Host ''
Write-Host '=== 恢复校验 ==='
& $ps5 -NoProfile -ExecutionPolicy Bypass -File $register -Status
$restoreStatusCode = $LASTEXITCODE
Write-Host "恢复后 -Status 退出码 = $restoreStatusCode"
$afterHash = (Get-FileHash -LiteralPath $lnk -Algorithm SHA256).Hash
Write-Host "恢复后 .lnk SHA256 = $afterHash"
Write-Host ("指纹一致: " + $(if ($afterHash -eq $beforeHash) { '是（通过）' } else { '否（不通过）' }))

$restoredCode = Invoke-Phase -Name 'restored'
$cleanupCode = Invoke-Phase -Name 'cleanup'

Write-Host ''
Write-Host '==================== 汇总 ===================='
$script:phaseResults | Format-Table -AutoSize | Out-String | Write-Host
Write-Host "baseline=$baselineCode fallback=$fallbackCode balloon=$balloonCode restored=$restoredCode cleanup=$cleanupCode"
Write-Host "preStatus=$statusCode postStatus=$restoreStatusCode"
Write-Host ("快捷方式指纹前后一致: " + ($afterHash -eq $beforeHash))

$failed = @()
if ($baselineCode -ne 0) { $failed += 'baseline' }
if ($fallbackCode -ne 0) { $failed += 'fallback' }
if ($balloonCode -ne 0) { $failed += 'balloon' }
if ($restoredCode -ne 0) { $failed += 'restored' }
if ($cleanupCode -ne 0) { $failed += 'cleanup' }
if ($afterHash -ne $beforeHash) { $failed += 'shortcut-fingerprint' }
if ($restoreStatusCode -ne 0) { $failed += 'register-status' }
if ($failed.Count -gt 0) {
    Write-Host ("未通过: " + ($failed -join ', ')) -ForegroundColor Red
    exit 1
}
Write-Host '全部通过。' -ForegroundColor Green
exit 0
