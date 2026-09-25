<#
    注册脚本**写入路径**的验证 —— 人工验收工具，破坏性，不参与 `npm test`。

    ## 用途

    `scripts/register-aumid.ps1` 平时跑到的都是「已就绪，未改动」的幂等分支，Create 分支
    不会被真正执行。本脚本刻意走一遍完整写入路径，确认它不是只会在纸上成立：

        -Unregister（退出码 0，两处都删净） → -Status（退出码 1） → 重新注册（退出码 0）
        → -Status（退出码 0，读回 'DSH Session Alert'） → 真机投递一条（退出码 0）
        → 再跑一次注册（文件 SHA256 不变，证明幂等）

    ## 破坏性

    它会**注销并重建**自有 AUMID 的开始菜单快捷方式与 HKCU 注册表键。重建件的字节与原件
    不同是正常的（target / description 由脚本写入），但外观与行为等价。脚本先把原件逐字节
    备份到 `%TEMP%\dsh-session-alert-drill\lnk-backup.lnk`，**任何一项不通过就还原备份**。

    ## 用法

        powershell -NoProfile -ExecutionPolicy Bypass -File experiments/notify-register-write-path.ps1

    ## 期望输出

        写入路径全部通过。

    本文件必须保持 CRLF 换行 + UTF-8 BOM（见 .gitattributes）。
#>

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$register = Join-Path $repo 'scripts\register-aumid.ps1'
$phases = Join-Path $PSScriptRoot 'notify-drill-phases.mjs'
$work = Join-Path $env:TEMP 'dsh-session-alert-drill'
if (-not (Test-Path $work)) { New-Item -Path $work -ItemType Directory -Force | Out-Null }
$lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\DSH Session Alert.lnk'
$backup = Join-Path $work 'lnk-backup.lnk'
$regKey = 'HKCU:\SOFTWARE\Classes\AppUserModelId\DSH Session Alert'
$ps5 = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$failed = @()
function Check {
    param([string]$Label, [bool]$Ok, [string]$Detail = '')
    $mark = if ($Ok) { 'PASS' } else { 'FAIL' }
    if (-not $Ok) { $script:failed += $Label }
    Write-Host "  [$mark] $Label$(if ($Detail) { " —— $Detail" })"
}

Copy-Item -LiteralPath $lnk -Destination $backup -Force
$beforeHash = (Get-FileHash -LiteralPath $lnk -Algorithm SHA256).Hash
Write-Host "备份现有 .lnk 到 $backup（SHA256=$beforeHash）"

try {
    Write-Host ''
    Write-Host '=== 1. -Unregister ==='
    & $ps5 -NoProfile -ExecutionPolicy Bypass -File $register -Unregister
    $unregisterCode = $LASTEXITCODE
    Write-Host "  退出码 = $unregisterCode"
    Check '-Unregister 退出码 0' ($unregisterCode -eq 0) "code=$unregisterCode"
    Check '-Unregister 后快捷方式已删除' (-not (Test-Path -LiteralPath $lnk))
    Check '-Unregister 后注册表键已删除' (-not (Test-Path $regKey))

    Write-Host ''
    Write-Host '=== 2. -Status 应当报未注册（退出码 1）==='
    & $ps5 -NoProfile -ExecutionPolicy Bypass -File $register -Status
    $statusAfterUnregister = $LASTEXITCODE
    Write-Host "  退出码 = $statusAfterUnregister"
    Check '-Status 退出码 1' ($statusAfterUnregister -eq 1) "code=$statusAfterUnregister"

    Write-Host ''
    Write-Host '=== 3. 重新注册（走 Create 分支）==='
    & $ps5 -NoProfile -ExecutionPolicy Bypass -File $register
    $recreateCode = $LASTEXITCODE
    Write-Host "  退出码 = $recreateCode"
    Check '注册脚本退出码 0' ($recreateCode -eq 0) "code=$recreateCode"
    Check '快捷方式已重建' (Test-Path -LiteralPath $lnk)
    Check '注册表键已重建' (Test-Path $regKey)

    Write-Host ''
    Write-Host '=== 4. 重建后 -Status ==='
    & $ps5 -NoProfile -ExecutionPolicy Bypass -File $register -Status
    $statusAfterRecreate = $LASTEXITCODE
    Write-Host "  退出码 = $statusAfterRecreate"
    Check '重建后 -Status 退出码 0' ($statusAfterRecreate -eq 0) "code=$statusAfterRecreate"

    Write-Host ''
    Write-Host '=== 5. 重建后真的能弹（回退到自有 AUMID）==='
    $output = & node $phases restored 2>&1
    $sendCode = $LASTEXITCODE
    $output | Write-Host
    Check '重建后真实投递退出码 0' ($sendCode -eq 0) "node exit=$sendCode"

    Write-Host ''
    Write-Host '=== 6. 再跑一次幂等（不应再改动文件）==='
    $hashAfterRecreate = (Get-FileHash -LiteralPath $lnk -Algorithm SHA256).Hash
    & $ps5 -NoProfile -ExecutionPolicy Bypass -File $register
    $secondCode = $LASTEXITCODE
    $hashAfterSecond = (Get-FileHash -LiteralPath $lnk -Algorithm SHA256).Hash
    Check '第二次注册退出码 0' ($secondCode -eq 0) "code=$secondCode"
    Check '幂等：文件未被再次改写' ($hashAfterRecreate -eq $hashAfterSecond) "$hashAfterRecreate vs $hashAfterSecond"
    Write-Host "  重建后 SHA256 = $hashAfterRecreate（与演练前的 $beforeHash 不同是正常的：重建会产生新的文件内容）"
} finally {
    if ($script:failed.Count -gt 0) {
        Write-Host ''
        Write-Host '未全部通过，正在从字节备份还原原有 .lnk' -ForegroundColor Yellow
        Copy-Item -LiteralPath $backup -Destination $lnk -Force
        & $ps5 -NoProfile -ExecutionPolicy Bypass -File $register -Status
        Write-Host ("还原后 -Status 退出码 = " + $LASTEXITCODE)
    }
}

Write-Host ''
if ($failed.Count -gt 0) {
    Write-Host ("未通过: " + ($failed -join ', ')) -ForegroundColor Red
    exit 1
}
Write-Host '写入路径全部通过。' -ForegroundColor Green
exit 0
