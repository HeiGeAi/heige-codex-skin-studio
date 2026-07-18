param(
    [ValidateRange(1024, 65535)][int]$Port = 9341,
    [string]$InstallRoot
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\entrypoints.ps1")
. (Join-Path $PSScriptRoot "lib\start-menu.ps1")
. (Join-Path $PSScriptRoot "lib\bat-exit.ps1")
[Console]::OutputEncoding = [Text.Encoding]::UTF8

if (-not $PSBoundParameters.ContainsKey("Port") -and $env:HEIGE_CODEX_SKIN_PORT) {
    $Port = [int]$env:HEIGE_CODEX_SKIN_PORT
}
$scriptTreeRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

Invoke-HeiGeBatEntrypoint {
    $result = Invoke-HeiGeUninstallFlow `
        -InstallRoot $InstallRoot `
        -ScriptTreeRoot $scriptTreeRoot `
        -Port $Port `
        -CallerScriptPath $PSCommandPath
    Write-Host "已注销登录常驻任务。"
    if ($result.Shortcut -and $result.Shortcut.Removed) {
        Write-Host "已移除开始菜单「HeiGe 皮肤启动器」。"
    }
    if ($result.State -and $result.State.Removed) {
        Write-Host "已清理 AppData 状态目录。"
    }
    if ($result.InstallTree -and $result.InstallTree.Deferred) {
        Write-Host "安装目录将在本窗口关闭后删除：$($result.InstallRoot)"
    } elseif ($result.InstallTree -and $result.InstallTree.Removed) {
        Write-Host "已删除安装目录：$($result.InstallRoot)"
    } elseif (-not (Test-Path -LiteralPath $result.InstallRoot)) {
        Write-Host "安装目录原本已不存在（已完成残留清理）。"
    }
    if ($result.SoftDisableAttempted -and -not $result.SoftDisableSucceeded) {
        Write-Host "提示：未能通过 CLI 关闭常驻（安装树可能已损坏），已改为强制清理。"
    }
}
