# 测量「插件发通知时」子进程看到的控制台状态。
#
# 这是最要紧的一条：通知每触发一次就 spawn 一次 PowerShell，
# 如果那条路径分配了控制台，用户会被告警本身打扰到。
#
# 走与真实插件完全相同的 spawn 参数：stdio 全部 'ignore'（不用管道），
# windowsHide: true，短命子进程，退出码即结果。

$PS5 = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$probe = Join-Path $PSScriptRoot 'conprobe.ps1'
$out = Join-Path $env:TEMP 'conprobe-out.txt'

$js = @'
const { spawn } = require('node:child_process')
const [exe, probe, out, mode] = process.argv.slice(2)

const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe]
const opts = { windowsHide: true, stdio: 'ignore', detached: false }

// mode 只影响是否额外加 -WindowStyle Hidden，其余完全一致
if (mode === 'hidden') args.splice(args.length - 2, 0, '-WindowStyle', 'Hidden')

const child = spawn(exe, args, opts)
child.on('error', (e) => { console.log('SPAWN_ERROR ' + e.message); process.exit(9) })
child.on('close', (code) => { console.log('child exit=' + code); process.exit(0) })
'@

$jsPath = Join-Path $env:TEMP 'spawn-probe.cjs'
[IO.File]::WriteAllText($jsPath, $js, (New-Object Text.UTF8Encoding($false)))

foreach ($mode in @('plain','hidden')) {
  if (Test-Path $out) { Remove-Item $out -Force }
  Write-Host "--- mode=$mode ---"
  & node $jsPath $PS5 $probe $out $mode
  Start-Sleep -Milliseconds 400
  $state = if (Test-Path $out) { (Get-Content $out -Raw).ToString().Trim() } else { '<探针未执行>' }
  Write-Host ("    console state: {0}" -f $state)
}

Remove-Item $out, $jsPath -Force -ErrorAction SilentlyContinue
