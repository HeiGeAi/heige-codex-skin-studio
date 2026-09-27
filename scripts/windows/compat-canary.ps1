param(
    [ValidateRange(1024, 65535)][int]$Port = 9341,
    [switch]$Json
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\common.ps1")
[Console]::OutputEncoding = [Text.Encoding]::UTF8

try {
    if (-not $PSBoundParameters.ContainsKey("Port") -and $env:HEIGE_CODEX_SKIN_PORT) {
        $Port = [int]$env:HEIGE_CODEX_SKIN_PORT
    }
    if ($Port -lt 1024 -or $Port -gt 65535) { throw "调试端口必须在 1024 至 65535 之间。" }
    $root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $app = Resolve-CodexApp
    $runtime = Get-NodeRuntime -App $app
    $cliArguments = @((Join-Path $root "src\cli.mjs"), "compat", "--app", "codex", "--port", [string]$Port)
    if ($Json.IsPresent) { $cliArguments += "--json" }
    # 直接保留 CLI 的 stdout 和非零退出码，缺失锚点时仍能保存完整 JSON。
    & $runtime.Path @cliArguments
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine([string]$_.Exception.Message)
    exit 1
}
