param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string]$ArgumentsJson
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\common.ps1")

$parsed = ConvertFrom-Json -InputObject $ArgumentsJson
$argumentList = @($parsed)
if ($argumentList.Count -eq 1 -and $argumentList[0] -is [System.Array]) {
    $argumentList = @($argumentList[0])
}
$argumentList = @($argumentList | ForEach-Object { [string]$_ })
if ($argumentList.Count -lt 3) {
    throw "session controller ArgumentsJson 无效"
}
$result = Start-HeiGeBreakawayNodeProcess -FilePath $FilePath -ArgumentList $argumentList
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Compress))