#Requires -Version 5.1
<#
    为 dsh-session-alert 注册自有 AUMID。

    为什么需要这一步：非打包应用调用 ToastNotificationManager 时，如果 AUMID 没有在
    系统里注册过，Windows 的行为是「接受进通知中心，但不显示横幅」——Show() 不报错、
    退出码是 0，从代码侧完全看不出来。要让横幅真的出现并且署名是本插件，AUMID 必须有
    一个带 System.AppUserModel.ID 属性的开始菜单快捷方式。

    本脚本做两件幂等的事：
      1. 写 HKCU\SOFTWARE\Classes\AppUserModelId\<AUMID>（显示名、出现在设置里）；
      2. 在开始菜单建一个带该 AUMID 的 .lnk —— 这一步才是让横幅生效的关键。

    幂等的判据是「读回」而不是「写过」：注册表值先比对再写，快捷方式先用属性存储读回
    它当前携带的 AUMID，一致就一个字节都不动。因此重复运行不会刷新文件时间戳，也不会
    在开始菜单索引里制造无谓的变动。

    用法：
      powershell -NoProfile -ExecutionPolicy Bypass -File register-aumid.ps1
      powershell -NoProfile -ExecutionPolicy Bypass -File register-aumid.ps1 -Status
      powershell -NoProfile -ExecutionPolicy Bypass -File register-aumid.ps1 -Unregister
      powershell -NoProfile -ExecutionPolicy Bypass -File register-aumid.ps1 -Force

    退出码：0 = 已注册且校验通过；1 = 未能注册或校验失败。

    编码硬要求：本文件必须是 UTF-8 BOM + CRLF。PowerShell 5.1 读无 BOM 的 .ps1 会按
    系统 ANSI（中文机器上是 GBK）解码，脚本内的中文变乱码后会破坏引号配对并报出与真实
    原因无关的语法错误；LF 换行会让 param(...) 块解析失败。
#>

[CmdletBinding()]
param(
    [string]$Aumid = 'DSH Session Alert',
    # 通知最上方那一行的显示名。留空表示沿用 AUMID（历史行为）。
    # **加这个参数是为了让 -Force 重建不冲掉用户设的署名**：以前这里硬写 $Aumid，
    # 于是一次「换个图标」的重建会把署名改回注册名，用户看到的是「改名没生效」。
    [string]$DisplayName = '',
    [switch]$Unregister,
    [switch]$Status,
    [switch]$Force,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$programsDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$shortcutPath = Join-Path $programsDir "$Aumid.lnk"
$registryPath = "HKCU:\SOFTWARE\Classes\AppUserModelId\$Aumid"
# 通知/任务栏上的应用图标。取自 DeepSeek Harness 自己的图标，由
# scripts/build-notification-icon.ps1 生成（多尺寸 ICO）。**不要退回 shell32.dll**：
# 那是 Windows 的通用图标，通知里会出现一个与 DSH 无关的图案。
$iconPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'assets\notification-icon.ico'
if (-not (Test-Path -LiteralPath $iconPath)) {
    $iconPath = Join-Path $env:SystemRoot 'System32\shell32.dll'
}
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Write-Line {
    param([string]$Message, [string]$Color = 'Gray')
    if (-not $Quiet) { Write-Host $Message -ForegroundColor $Color }
}

# --- 快捷方式写入：ShellLink COM + 属性存储 -------------------------------------
# 只有通过 IPropertyStore 写 PKEY_AppUserModel_ID，快捷方式才会携带 AUMID；
# 普通的 .lnk 写入 API 碰不到这个属性，这也是「建了快捷方式却仍然没有横幅」的常见原因。
#
# 读回**不走** IPropertyStore：实测同一个刚写好的 .lnk，ShellLink 的属性存储把它读成
# VT_EMPTY（vt=0），而 shell 自己的扩展属性读得出正确值。「文件存在」与「属性读得到」
# 是两件事，校验必须用后者，否则幂等判断会永远认为快捷方式不对而反复重建。
if (-not ('AumidShortcut' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
internal class ShellLinkComObject { }

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
internal interface IShellLinkW
{
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, int fFlags);
    void GetIDList(out IntPtr ppidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
    void GetHotkey(out short pwHotkey);
    void SetHotkey(short wHotkey);
    void GetShowCmd(out int piShowCmd);
    void SetShowCmd(int iShowCmd);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, int dwReserved);
    void Resolve(IntPtr hwnd, int fFlags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
}

[ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IPersistFile
{
    void GetClassID(out Guid pClassID);
    void IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
}

[StructLayout(LayoutKind.Sequential, Pack = 4)]
internal struct PROPERTYKEY { public Guid fmtid; public uint pid; }

// PROPVARIANT 的联合体在两个位数下都从偏移 8 开始（DECIMAL 成员的对齐要求），
// 因此这个显式布局在 x86 与 x64 上都成立。
[StructLayout(LayoutKind.Explicit)]
internal struct PROPVARIANT
{
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pointerValue;
}

[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IPropertyStore
{
    void GetCount(out uint cProps);
    void GetAt(uint iProp, out PROPERTYKEY pkey);
    void GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    void SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
    void Commit();
}

public static class AumidShortcut
{
    private const ushort VT_LPWSTR = 31;

    /// <summary>建一个携带指定 AUMID 的快捷方式。</summary>
    public static void Create(string shortcutPath, string targetPath, string arguments, string aumid)
    {
        var link = (IShellLinkW)new ShellLinkComObject();
        try
        {
            link.SetPath(targetPath);
            link.SetArguments(arguments);
            link.SetDescription(aumid);
            link.SetIconLocation(targetPath, 0);

            var store = (IPropertyStore)link;
            // 必须用局部副本：C# 不允许把 static readonly 字段按 ref 传出去。
            var key = new PROPERTYKEY
            {
                fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
                pid = 5
            };
            var value = new PROPVARIANT();
            value.vt = VT_LPWSTR;
            value.pointerValue = Marshal.StringToCoTaskMemUni(aumid);
            try
            {
                store.SetValue(ref key, ref value);
                store.Commit();
            }
            finally
            {
                Marshal.FreeCoTaskMem(value.pointerValue);
            }

            ((IPersistFile)link).Save(shortcutPath, true);
        }
        finally
        {
            Marshal.ReleaseComObject(link);
        }
    }
}
'@
}

# --- 快捷方式 AUMID 的读回（走 shell 的扩展属性，见上面的说明） ------------------
$script:shellApp = $null

function Get-ShortcutAumid {
    param([string]$Path)
    try {
        if ($null -eq $script:shellApp) { $script:shellApp = New-Object -ComObject Shell.Application }
        $folder = $script:shellApp.Namespace((Split-Path -Parent $Path))
        if ($null -eq $folder) { return '' }
        $item = $folder.ParseName((Split-Path -Leaf $Path))
        if ($null -eq $item) { return '' }
        $value = $item.ExtendedProperty('System.AppUserModel.ID')
        if ($null -eq $value) { return '' }
        return [string]$value
    } catch {
        return ''
    }
}

# --- 现状探测 ------------------------------------------------------------------
function Test-RegistryState {
    if (-not (Test-Path $registryPath)) { return $false }
    try {
        $display = (Get-ItemProperty -Path $registryPath -Name 'DisplayName' -ErrorAction Stop).DisplayName
        $showInSettings = (Get-ItemProperty -Path $registryPath -Name 'ShowInSettings' -ErrorAction Stop).ShowInSettings
        $icon = (Get-ItemProperty -Path $registryPath -Name 'IconUri' -ErrorAction Stop).IconUri
    } catch {
        return $false
    }
    # **显示名不再要求等于 AUMID。** 它是用户的通知署名（插件会同步它），
    # 早先这里写死 `$display -eq $Aumid`，于是用户一改署名，自检就永远报「不符」，
    # 连 `-Force` 也会以退出码 1 收场——看起来像注册坏了，其实是判据错了。
    if ([string]::IsNullOrWhiteSpace($display)) { return $false }
    if (-not [string]::IsNullOrWhiteSpace($DisplayName) -and $display -ne $DisplayName.Trim()) { return $false }
    if ([int]$showInSettings -ne 1) { return $false }
    # 图标也要对得上：否则「换了图标」不会被识别为需要重建（幂等优化反而挡住了更新）。
    if ($icon -ne $iconPath) { return $false }
    return $true
}

function Test-ShortcutState {
    if (-not (Test-Path $shortcutPath)) { return $false }
    return ((Get-ShortcutAumid -Path $shortcutPath) -eq $Aumid)
}

# --- 注销 ----------------------------------------------------------------------
if ($Unregister) {
    $removed = @()
    if (Test-Path $shortcutPath) {
        Remove-Item -LiteralPath $shortcutPath -Force
        $removed += "快捷方式 $shortcutPath"
    }
    if (Test-Path $registryPath) {
        Remove-Item -LiteralPath $registryPath -Recurse -Force
        $removed += "注册表键 $registryPath"
    }
    if ($removed.Count -eq 0) { Write-Line '原本就没有注册，无需注销。' 'Yellow' }
    else { Write-Line ('已注销：' + ($removed -join '；')) 'Green' }
    exit 0
}

# --- 只读探测 ------------------------------------------------------------------
if ($Status) {
    $registryOk = Test-RegistryState
    $shortcutOk = Test-ShortcutState
    $stored = if (Test-Path $shortcutPath) { Get-ShortcutAumid -Path $shortcutPath } else { '' }
    Write-Line "AUMID：$Aumid"
    Write-Line ("  注册表键 {0}：{1}" -f $registryPath, $(if ($registryOk) { '已注册' } else { '缺失或不符' })) $(if ($registryOk) { 'Green' } else { 'Red' })
    Write-Line ("  开始菜单快捷方式 {0}：{1}（读回 '${stored}'）" -f $shortcutPath, $(if ($shortcutOk) { '已注册' } else { '缺失或不符' })) $(if ($shortcutOk) { 'Green' } else { 'Red' })
    if ($registryOk -and $shortcutOk) { exit 0 }
    exit 1
}

# --- 注册 ----------------------------------------------------------------------
Write-Line "注册 AUMID：$Aumid"

# 1. 注册表：显示信息（让它在「设置 → 通知」里有一个可辨认的条目）
if ((Test-RegistryState) -and (-not $Force)) {
    Write-Line "  注册表键已就绪，未改动：$registryPath" 'DarkGray'
} else {
    New-Item -Path $registryPath -Force | Out-Null
    Set-ItemProperty -Path $registryPath -Name 'DisplayName' -Value $(if ([string]::IsNullOrWhiteSpace($DisplayName)) { $Aumid } else { $DisplayName.Trim() })
    Set-ItemProperty -Path $registryPath -Name 'ShowInSettings' -Value 1 -Type DWord
    Set-ItemProperty -Path $registryPath -Name 'IconUri' -Value $iconPath
    Write-Line "  已写注册表键：$registryPath" 'Green'
}

# 2. 开始菜单快捷方式：这一步才让横幅真的出现
$created = $false
if ((Test-ShortcutState) -and (-not $Force)) {
    Write-Line "  快捷方式已就绪，未改动：$shortcutPath" 'DarkGray'
} else {
    if (-not (Test-Path $programsDir)) { New-Item -Path $programsDir -ItemType Directory -Force | Out-Null }
    # 快捷方式指向一个惰性命令：它存在的意义只是携带 AUMID，被点到也不该做任何事。
    [AumidShortcut]::Create($shortcutPath, $powershellExe, '-NoProfile -NonInteractive -WindowStyle Hidden -Command exit', $Aumid)
    Write-Line "  已写开始菜单快捷方式：$shortcutPath" 'Green'
    $created = $true
}

# --- 校验 ----------------------------------------------------------------------
# 校验读回的是「shell 解析出的 AUMID」与「注册表键」，而不是「文件存在」——
# 后者在快捷方式没带 AUMID 时同样为真，正是最容易被误判成成功的情形。
$registryOk = Test-RegistryState
$shortcutOk = Test-ShortcutState
Write-Line "  校验：注册表键 $(if ($registryOk) { '通过' } else { '失败' })；快捷方式 AUMID $(if ($shortcutOk) { '通过' } else { '失败' })" $(if ($registryOk -and $shortcutOk) { 'Green' } else { 'Red' })

if ($created -or $Force) {
    # 让 shell 索引到新快捷方式；通知平台是在发送时读注册状态的。
    Start-Sleep -Seconds 2
}

if ($registryOk -and $shortcutOk) { exit 0 }
exit 1
