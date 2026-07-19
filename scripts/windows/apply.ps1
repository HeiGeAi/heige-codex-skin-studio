param(
    [ValidateNotNullOrEmpty()][string]$Theme,
    [ValidateRange(1024, 65535)][int]$Port = 9341
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\entrypoints.ps1")
. (Join-Path $PSScriptRoot "lib\bat-exit.ps1")
[Console]::OutputEncoding = [Text.Encoding]::UTF8

if (-not $PSBoundParameters.ContainsKey("Port") -and $env:HEIGE_CODEX_SKIN_PORT) {
    $Port = [int]$env:HEIGE_CODEX_SKIN_PORT
}
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$arguments = @{ Root = $root; Port = $Port }
if ($PSBoundParameters.ContainsKey("Theme")) { $arguments.Theme = $Theme }

Invoke-HeiGeBatEntrypoint {
    $result = Invoke-HeiGeApplyFlow @arguments
    if ($result.ThemeSelection -ceq "explicit") {
        if ($result.BootstrapIdempotent) {
            Write-Host "皮肤已在当前会话生效：$($result.Theme)。当前操作不改变常驻开关。"
        } else {
            Write-Host "皮肤已应用：$($result.Theme)。当前操作不改变常驻开关。"
        }
    } else {
        if ($result.BootstrapIdempotent) {
            Write-Host "上次使用的皮肤已在当前会话生效。当前操作不改变常驻开关。"
        } else {
            Write-Host "上次使用的皮肤已恢复到当前会话。当前操作不改变常驻开关。"
        }
    }
    if ($result.BootstrapIdempotent) {
        Write-Host "提示：Codex 已在运行。若看不到窗口，请到任务栏/系统托盘打开 Codex。"
        Show-HeiGeCodexWindow -AppInfo $result.AppInfo | Out-Null
    }
}
