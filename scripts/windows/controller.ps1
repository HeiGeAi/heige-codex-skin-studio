param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("run", "register", "start", "unregister", "status")]
    [string]$Action,
    [string]$TaskName = "HeiGe Codex Skin Studio Controller",
    [ValidateRange(1024, 65535)]
    [int]$Port = 9341,
    [string]$NodePath,
    [string]$StateDirectory,
    [string]$AppIdentityToken,
    [Nullable[long]]$ExpectedRevision,
    [string]$ExpectedTransitionNonce,
    [switch]$PreserveHandshake
)

$ErrorActionPreference = "Stop"
$script:WindowsRoot = $PSScriptRoot
$script:RepositoryRoot = Split-Path (Split-Path $script:WindowsRoot -Parent) -Parent
. (Join-Path $script:WindowsRoot "lib\common.ps1")
. (Join-Path $script:WindowsRoot "lib\scheduled-task.ps1")

try {
    $testMode = Test-HeiGeTestTaskName -TaskName $TaskName
    Assert-HeiGeTaskScope -TaskName $TaskName -TestMode:$testMode
    $StateDirectory = Resolve-HeiGeScopedStateDirectory `
        -StateDirectory $StateDirectory -TestMode:$testMode
    $hasExpectedRevision = $PSBoundParameters.ContainsKey("ExpectedRevision")
    $hasExpectedNonce = $PSBoundParameters.ContainsKey("ExpectedTransitionNonce")
    if (($Action -eq "run" -or $Action -eq "register") -and ($hasExpectedRevision -or $hasExpectedNonce)) {
        throw "$Action does not accept expected handshake parameters"
    }
    if (($Action -eq "status" -or $Action -eq "unregister") -and
        ($hasExpectedRevision -or $hasExpectedNonce)) {
        throw "$Action does not accept handshake parameters"
    }
    if ($PreserveHandshake -and $Action -ne "unregister") {
        throw "$Action does not accept PreserveHandshake"
    }

    if ($Action -eq "status") {
        Get-HeiGeScheduledTaskStatus -TaskName $TaskName -StateDirectory $StateDirectory `
            -TestMode:$testMode | ConvertTo-Json -Depth 8
        exit 0
    }

    if ($Action -eq "unregister") {
        Unregister-HeiGeScheduledTask -TaskName $TaskName -StateDirectory $StateDirectory `
            -TestMode:$testMode -PreserveHandshake:$PreserveHandshake | ConvertTo-Json -Depth 8
        exit 0
    }

    # 安装树被手删/半删后，登录任务仍会反复拉起 controller；缺失 CLI 时自注销并安静退出。
    if ($Action -eq "run" -or $Action -eq "register" -or $Action -eq "start") {
        $cliPath = Join-Path $script:RepositoryRoot "src\cli.mjs"
        if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
            $unregistered = $false
            try {
                Unregister-HeiGeScheduledTask -TaskName $TaskName -StateDirectory $StateDirectory `
                    -TestMode:$testMode -PreserveHandshake | Out-Null
                $unregistered = $true
            } catch {
                try {
                    & (Join-Path $env:SystemRoot "System32\schtasks.exe") `
                        /Delete /TN $TaskName /F 2>$null | Out-Null
                    $unregistered = $null -eq (
                        Get-ScheduledTask -TaskPath "\" -TaskName $TaskName -ErrorAction SilentlyContinue
                    )
                } catch {
                    $unregistered = $false
                }
            }
            if ($unregistered) {
                [Console]::Error.WriteLine(
                    "HeiGe Codex Skin Studio：安装目录缺失（找不到 $cliPath），已注销常驻任务。"
                )
            } else {
                [Console]::Error.WriteLine(
                    "HeiGe Codex Skin Studio：安装目录缺失，常驻任务无法自动注销；请从源码目录运行 scripts\windows\uninstall.bat。"
                )
            }
            exit 0
        }
    }

    if ($Action -eq "start") {
        if ($null -eq $ExpectedRevision -or -not $ExpectedTransitionNonce) {
            throw "start requires ExpectedRevision and ExpectedTransitionNonce"
        }
        Protect-HeiGeStateDirectory -Path $StateDirectory | Out-Null
        Start-HeiGeScheduledTask -TaskName $TaskName -StateDirectory $StateDirectory `
            -ExpectedRevision ([long]$ExpectedRevision) `
            -ExpectedTransitionNonce $ExpectedTransitionNonce -TestMode:$testMode | ConvertTo-Json -Depth 8
        exit 0
    }

    Protect-HeiGeStateDirectory -Path $StateDirectory | Out-Null
    $inheritedIdentityToken = [System.Environment]::GetEnvironmentVariable(
        "HEIGE_WINDOWS_APP_IDENTITY",
        [System.EnvironmentVariableTarget]::Process
    )
    if ($AppIdentityToken -and $inheritedIdentityToken -and
        $AppIdentityToken -cne $inheritedIdentityToken) {
        throw "controller app identity token conflicts with the inherited identity"
    }
    $boundIdentityToken = if ($AppIdentityToken) { $AppIdentityToken } else { $inheritedIdentityToken }
    if (-not $boundIdentityToken) {
        throw "$Action requires an immutable app identity token"
    }
    $app = Resolve-HeiGeBoundCodexApp -IdentityToken $boundIdentityToken
    [System.Environment]::SetEnvironmentVariable(
        "HEIGE_WINDOWS_APP_IDENTITY",
        $boundIdentityToken,
        [System.EnvironmentVariableTarget]::Process
    )
    if ($NodePath) {
        if (-not [System.IO.Path]::IsPathRooted($NodePath) -or
            -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
            throw "NodePath must identify one absolute executable file"
        }
        $NodePath = [System.IO.Path]::GetFullPath($NodePath)
        $versionText = [string]((& $NodePath --version 2>&1) -join "")
        if ($LASTEXITCODE -ne 0 -or $versionText.Trim() -notmatch '^v(\d+)\.(\d+)\.(\d+)(?:[-+].+)?$' -or
            [int]$Matches[1] -lt 22) {
            throw "NodePath must provide Node.js 22 or newer"
        }
        $node = [pscustomobject]@{ Path = $NodePath }
    } else {
        $node = Get-NodeRuntime -App $app
    }

    if ($Action -eq "register") {
        Register-HeiGeScheduledTask -TaskName $TaskName -NodePath $node.Path `
            -ControllerPath $PSCommandPath -StateDirectory $StateDirectory -Port $Port `
            -AppIdentityToken $boundIdentityToken `
            -TestMode:$testMode | ConvertTo-Json -Depth 8
        exit 0
    }

    $cliPath = Join-Path $script:RepositoryRoot "src\cli.mjs"
    if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
        throw "Node controller CLI 不存在：$cliPath"
    }
    $result = Invoke-HeiGeNodeControllerProcess -NodePath $node.Path -CliPath $cliPath `
        -TaskName $TaskName -Port $Port -StateDirectory $StateDirectory `
        -AppIdentityToken $boundIdentityToken
    if ([string]$result.action -ceq "unregister") {
        & $PSCommandPath -Action "unregister" -TaskName $TaskName -Port $Port `
            -StateDirectory $StateDirectory -PreserveHandshake | Out-Null
        exit 0
    }
    if ([string]$result.action -ceq "error") {
        throw "Node controller 返回 error action。"
    }
    throw "Node controller 以未知 action 退出：$([string]$result.action)"
} catch {
    [Console]::Error.WriteLine("HeiGe Codex Skin Studio Windows controller：$($_.Exception.Message)")
    exit 1
}
