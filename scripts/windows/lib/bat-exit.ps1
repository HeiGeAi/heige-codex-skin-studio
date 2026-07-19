# Dot-source helper：把入口脚本的未捕获异常变成明确 exit code，
# 否则 Windows PowerShell 5.1 对 throw 常返回 ERRORLEVEL=0，双击 .bat 不会 pause。
# 约定：入口 .ps1 仅通过 powershell -File 或独立子进程调用（install 对 apply 已用 Start-Process）。
#
# 中文提示必须走 PowerShell（UTF-8），禁止写进 .bat：
# cmd.exe 默认用系统 ANSI 代码页读 bat，UTF-8 中文会变成 ?????。

function Invoke-HeiGeBatEntrypoint {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Action
    )
    $ErrorActionPreference = "Stop"
    try {
        & $Action
        Write-HeiGeInteractivePauseHint
        exit 0
    } catch {
        $message = if ($_.Exception -and $_.Exception.Message) {
            [string]$_.Exception.Message
        } else {
            [string]$_
        }
        [Console]::Error.WriteLine($message)
        Write-HeiGeInteractivePauseHint -Failed
        exit 1
    }
}

function Write-HeiGeInteractivePauseHint {
    param([switch]$Failed)
    # 仅双击 .bat 时显示（bat 会 set HEIGE_SHOW_PAUSE_HINT=1）；嵌套子进程/自动化不刷屏。
    if ($env:HEIGE_NO_PAUSE -eq "1") { return }
    if ($env:HEIGE_SHOW_PAUSE_HINT -ne "1") { return }
    Write-Host ""
    if ($Failed.IsPresent) {
        Write-Host "失败。请阅读上方报错；按任意键关闭本窗口。"
    } elseif ($env:HEIGE_PAUSE_HINT_STYLE -eq "uninstall") {
        Write-Host "卸载完成。按任意键关闭本窗口。"
    } elseif ($env:HEIGE_PAUSE_HINT_STYLE -eq "close") {
        Write-Host "Codex 已保持关闭。按任意键关闭本窗口。"
    } else {
        Write-Host "完成。若看不到 Codex，请到任务栏/系统托盘打开，或使用开始菜单「HeiGe 皮肤启动器」。"
        Write-Host "按任意键关闭本窗口。"
    }
}
