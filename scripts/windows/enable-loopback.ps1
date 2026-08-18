param(
    [switch]$Add,
    [switch]$Status
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\entrypoints.ps1")
. (Join-Path $PSScriptRoot "lib\bat-exit.ps1")
[Console]::OutputEncoding = [Text.Encoding]::UTF8

if (-not $Add.IsPresent -and -not $Status.IsPresent) {
    $Add = $true
}

Invoke-HeiGeBatEntrypoint {
    $result = Invoke-HeiGeEnableLoopbackFlow -Add:$Add
    Write-Host ("Package Family Name：$($result.PackageFamilyName)")
    if ($result.Exempt) {
        if ($result.Changed) {
            Write-Host "已添加 AppContainer 回环豁免。请重新运行 scripts\windows\apply.ps1，不必再次申请管理员权限。"
        } elseif ($Add.IsPresent) {
            Write-Host "回环豁免已经存在。请直接重新运行 scripts\windows\apply.ps1。"
        } else {
            Write-Host "回环豁免已经存在。"
        }
    } else {
        Write-Host "当前尚未豁免。请双击 scripts\windows\enable-loopback.bat（会申请一次管理员权限）。"
    }
}