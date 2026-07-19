$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")

$script:RepositoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
. (Join-Path $script:RepositoryRoot "scripts\windows\lib\entrypoints.ps1")
. (Join-Path $script:RepositoryRoot "scripts\windows\lib\start-menu.ps1")

$script:Root = Join-Path ([System.IO.Path]::GetTempPath()) ("HeiGe Entrypoints 中文 " + [guid]::NewGuid().ToString("N"))
$script:InstallRoot = Join-Path $script:Root "Stable Install 中文"
$script:StateRoot = Join-Path $script:Root "State 目录"
$script:StartMenuRoot = Join-Path $script:Root "Start Menu Programs"
$script:FakeNode = Join-Path $script:InstallRoot "runtime\node.exe"
$script:FakeCli = Join-Path $script:InstallRoot "src\cli.mjs"
$script:FakeController = Join-Path $script:InstallRoot "scripts\windows\controller.ps1"
$script:ApplyHidden = Join-Path $script:InstallRoot "scripts\windows\apply-hidden.vbs"
$script:ApplyBat = Join-Path $script:InstallRoot "scripts\windows\apply.bat"
$script:EnableBat = Join-Path $script:InstallRoot "scripts\windows\enable-skin.bat"
$script:SkillRoot = Join-Path $script:RepositoryRoot "skill\heige-codex-skin-studio"
$script:SkillInstallPs1 = Join-Path $script:SkillRoot "scripts\install.ps1"
$script:SkillInstallBat = Join-Path $script:SkillRoot "scripts\install.bat"
$script:SkillInstructions = Join-Path $script:SkillRoot "SKILL.md"
$script:SkillReadme = Join-Path $script:SkillRoot "README.md"
foreach ($path in @(
    $script:FakeNode, $script:FakeCli, $script:FakeController,
    $script:ApplyHidden, $script:ApplyBat, $script:EnableBat
)) {
    New-Item -ItemType Directory -Path (Split-Path $path -Parent) -Force | Out-Null
    New-Item -ItemType File -Path $path -Force | Out-Null
}
New-Item -ItemType Directory -Path $script:StateRoot -Force | Out-Null

function New-TestOwnedInstallMarker {
    param([Parameter(Mandatory = $true)][string]$InstallRoot)
    New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
    $marker = [ordered]@{
        kind = "stable-tree"
        manifestSha256 = ("a" * 64)
        product = "heige-codex-skin-studio"
        schemaVersion = 1
    }
    [System.IO.File]::WriteAllText(
        (Join-Path $InstallRoot ".heige-install.json"),
        ($marker | ConvertTo-Json -Compress),
        (New-Object System.Text.UTF8Encoding($false))
    )
}

function New-TestEntrypointContext {
    return [pscustomobject][ordered]@{
        App = [pscustomobject]@{
            Kind = "Win32"
            ExecutablePath = "C:\Program Files\Codex\Codex.exe"
            InstallPath = "C:\Program Files\Codex"
            ProductName = "Codex"
            PackageFullName = $null
            Aumid = $null
        }
        NodePath = $script:FakeNode
        CliPath = $script:FakeCli
        ControllerPath = $script:FakeController
        StateDirectory = $script:StateRoot
        TaskName = "HeiGe Codex Skin Studio Controller"
    }
}

function New-TestCodexProcess {
    param(
        [Parameter(Mandatory = $true)][int]$Id,
        [int]$ParentProcessId = 0,
        [string]$Path = "C:\Program Files\Codex\Codex.exe"
    )
    return [pscustomobject][ordered]@{
        ProcessId = $Id
        ParentProcessId = $ParentProcessId
        ExecutablePath = $Path
        Name = "Codex.exe"
    }
}

function Assert-ExactCliCall {
    param(
        [Parameter(Mandatory = $true)][string[]]$Actual,
        [Parameter(Mandatory = $true)][string[]]$Expected
    )
    Assert-Equal $Expected $Actual
}

$script:ShortcutDescription = "HeiGe Codex Skin Studio launcher v1 | current-user | re-enable skin"

function New-TestShortcutObservation {
    param(
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [string]$Description = $script:ShortcutDescription,
        [string]$Arguments = "",
        [int]$WindowStyle = 1,
        [string]$Hotkey = "",
        [string]$IconLocation = ""
    )
    return [pscustomobject][ordered]@{
        TargetPath = $TargetPath
        WorkingDirectory = $WorkingDirectory
        Description = $Description
        Arguments = $Arguments
        WindowStyle = $WindowStyle
        Hotkey = $Hotkey
        IconLocation = $IconLocation
    }
}

try {
    Test-Case "Exact result cardinality ignores a singleton payload Count property" {
        $context = New-TestEntrypointContext
        $context | Add-Member -NotePropertyName Count -NotePropertyValue 7
        $observedContext = Get-HeiGeFlowContext -Root $script:InstallRoot `
            -ContextProvider { $context }
        Assert-Equal 7 $observedContext.Count

        $portableContext = New-TestEntrypointContext
        $portableContext.App.ExecutablePath = $script:ApplyBat
        $portableContext.App.InstallPath = $script:InstallRoot
        $cliResult = Invoke-HeiGeContextCli -Context $portableContext `
            -Arguments @("status") -CliProvider {
                [pscustomobject]@{ mode = "active"; Count = 8 }
            }
        Assert-Equal 8 $cliResult.Count

        $unregisterResult = Unregister-HeiGeEntrypointTask -Context $portableContext `
            -UnregisterProvider {
                [pscustomobject]@{ VerifiedAbsent = $true; Count = 9 }
            }
        Assert-Equal 9 $unregisterResult.Count

        $compensationResult = Invoke-HeiGeApplyCompensation -Context $portableContext `
            -Port 9341 -Mode "native" -CompensateProvider {
                [pscustomobject]@{ Restored = $true; Mode = "native"; Count = 10 }
            }
        Assert-Equal 10 $compensationResult.Count
    }

    Test-Case "Context CLI carries the exact app identity only for the child invocation" {
        $originalIdentity = $env:HEIGE_WINDOWS_APP_IDENTITY
        $env:HEIGE_WINDOWS_APP_IDENTITY = "previous-test-value"
        try {
            $script:CapturedIdentity = $null
            $result = Invoke-HeiGeContextCli -Context (New-TestEntrypointContext) `
                -Arguments @("status") -CliProvider {
                    param($Context, $Arguments)
                    $script:CapturedIdentity = $env:HEIGE_WINDOWS_APP_IDENTITY
                    [pscustomobject]@{ mode = "active" }
                }
            $decoded = ConvertFrom-HeiGeCodexAppIdentityToken `
                -IdentityToken $script:CapturedIdentity
            Assert-Equal "Win32" $decoded.Kind
            Assert-Equal "C:\Program Files\Codex\Codex.exe" $decoded.ExecutablePath
            Assert-Equal "previous-test-value" $env:HEIGE_WINDOWS_APP_IDENTITY
            Assert-Equal "active" $result.mode
        } finally {
            $env:HEIGE_WINDOWS_APP_IDENTITY = $originalIdentity
        }
    }

    Test-Case "Apply validates first and never enables persistence" {
        $script:Events = @()
        $script:CliCalls = @()
        $result = Invoke-HeiGeApplyFlow -Root $script:InstallRoot -Theme "miku-488137" -Port 9341 `
            -ContextProvider { $script:Events += "preflight"; New-TestEntrypointContext } `
            -CdpStatusProvider { param($Context, $Port) $true } `
            -StartCdpProvider { param($Context, $Port) $script:Events += "start-cdp" } `
            -CliProvider {
                param($Context, $Arguments)
                $script:Events += "cli"
                $script:CliCalls += ,@($Arguments)
                [pscustomobject]@{ mode = "active"; persistenceEnabled = $false }
            }
        Assert-Equal @("preflight", "start-cdp", "cli") $script:Events
        Assert-ExactCliCall -Actual $script:CliCalls[0] `
            -Expected @("apply", "--theme", "miku-488137", "--port", "9341")
        Assert-False ($script:CliCalls[0] -contains "set-persistence")
        Assert-Equal "active" $result.Mode
        Assert-False $result.PersistenceEnabled
        Assert-False $result.PersistenceChanged
    }

    Test-Case "Launcher apply restores the stored theme without changing persistence" {
        $script:CliCalls = @()
        $result = Invoke-HeiGeApplyFlow -Root $script:InstallRoot -Port 9341 `
            -ContextProvider { New-TestEntrypointContext } `
            -CdpStatusProvider { param($Context, $Port) $true } `
            -StartCdpProvider { param($Context, $Port) } `
            -CliProvider {
                param($Context, $Arguments)
                $script:CliCalls += ,@($Arguments)
                [pscustomobject]@{ mode = "active"; persistenceEnabled = $false }
            }
        Assert-ExactCliCall -Actual $script:CliCalls[0] `
            -Expected @("apply", "--prefer-stored", "--port", "9341")
        Assert-False $result.PersistenceEnabled
        Assert-False $result.PersistenceChanged
        Assert-Equal "stored-or-default" $result.ThemeSelection
    }

    Test-Case "Apply retries transient LOCK_HELD before succeeding" {
        $script:Events = @()
        $script:ApplyAttempts = 0
        $result = Invoke-HeiGeApplyFlow -Root $script:InstallRoot -Theme "miku-488137" -Port 9341 `
            -ContextProvider { New-TestEntrypointContext } `
            -CdpStatusProvider { param($Context, $Port) $true } `
            -StartCdpProvider { param($Context, $Port) $script:Events += "start-cdp" } `
            -SleepProvider { param($Milliseconds) $script:Events += "sleep:$Milliseconds" } `
            -CliProvider {
                param($Context, $Arguments)
                $script:ApplyAttempts += 1
                $script:Events += "apply:$script:ApplyAttempts"
                Assert-ExactCliCall -Actual $Arguments `
                    -Expected @("apply", "--theme", "miku-488137", "--port", "9341")
                if ($script:ApplyAttempts -lt 3) {
                    throw "HeiGe Codex Skin Studio：LOCK_HELD: operation controller:start is held by live pid 31060"
                }
                return [pscustomobject]@{ mode = "active"; persistenceEnabled = $false }
            }
        Assert-Equal "active" $result.Mode
        Assert-Equal @(
            "start-cdp", "apply:1", "sleep:1000", "apply:2", "sleep:2000", "apply:3"
        ) $script:Events
    }

    Test-Case "Apply does not retry non-LOCK_HELD failures" {
        $script:Events = @()
        Assert-Throws {
            Invoke-HeiGeApplyFlow -Root $script:InstallRoot -Port 9341 `
                -ContextProvider { New-TestEntrypointContext } `
                -CdpStatusProvider { param($Context, $Port) $true } `
                -StartCdpProvider { param($Context, $Port) } `
                -SleepProvider { param($Milliseconds) $script:Events += "sleep" } `
                -CliProvider {
                    param($Context, $Arguments)
                    $script:Events += "apply"
                    throw "apply failed visibly"
                }
        } "apply failed visibly"
        Assert-Equal @("apply") $script:Events
    }

    Test-Case "Bootstrap aborts when doctor reports flag-present-port-closed" {
        Assert-Throws {
            Invoke-HeiGeApplyFlow -Root $script:InstallRoot -Theme "miku-488137" -Port 9341 `
                -ContextProvider { New-TestEntrypointContext } `
                -DoctorProvider {
                    param($Context, $Port)
                    [pscustomobject]@{
                        diagnosis = "flag-present-port-closed：进程已带调试参数但端口未开放"
                    }
                } `
                -HygieneProvider { param($Context, $Port) } `
                -CdpStatusProvider { param($Context, $Port) $false } `
                -CliProvider { param($Context, $Arguments) throw "should not apply" } `
                -StatusProvider { param($Context, $Port) throw "should not status" }
        } "abort-incompatible"
    }

    Test-Case "Bootstrap aborts CDP-disabled launch errors without endless retry" {
        Assert-Throws {
            Invoke-HeiGeApplyFlow -Root $script:InstallRoot -Theme "miku-488137" -Port 9341 `
                -MaxApplyAttempts 2 `
                -ContextProvider { New-TestEntrypointContext } `
                -SkipDoctor `
                -HygieneProvider { param($Context, $Port) } `
                -CdpStatusProvider { param($Context, $Port) $false } `
                -ProcessProvider { param($Context) @() } `
                -StartCdpProvider {
                    param($Context, $Port)
                    throw "Codex 已带调试参数启动，但端口 9341 未开放：当前 Codex 版本或本机 MSIX 会话可能禁用了本机调试端口。"
                } `
                -SleepProvider { param($Milliseconds) throw "should not whole-chain retry incompatible CDP" } `
                -CliProvider { param($Context, $Arguments) throw "should not apply" }
        } "abort-incompatible"
    }

    Test-Case "Process mode ignores LOCALAPPDATA Codex bin backend under a Store app" {
        $backend = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin\unit-test\codex.exe"
        if (-not $env:LOCALAPPDATA) { throw "LOCALAPPDATA required" }
        New-Item -ItemType Directory -Path (Split-Path $backend -Parent) -Force | Out-Null
        New-Item -ItemType File -Path $backend -Force | Out-Null
        try {
            $context = New-TestEntrypointContext
            $context.App = [pscustomobject]@{
                Kind = "StoreAumid"
                ExecutablePath = $null
                InstallPath = "C:\Program Files\WindowsApps\OpenAI.Codex_1.0.0.0_x64__2p2nqsd0c76g0"
                ProductName = "Codex"
                PackageFullName = "OpenAI.Codex_1.0.0.0_x64__2p2nqsd0c76g0"
                Aumid = "OpenAI.Codex_2p2nqsd0c76g0!App"
            }
            $mode = Get-HeiGeEntrypointProcessMode -Context $context -ProcessProvider {
                param($Context)
                @(
                    (New-TestCodexProcess -Id 41 -Path "C:\Program Files\WindowsApps\OpenAI.Codex_1.0.0.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe"),
                    (New-TestCodexProcess -Id 51 -Path $backend)
                )
            }
            Assert-Equal "native" $mode
        } finally {
            Remove-Item -LiteralPath (Split-Path (Split-Path $backend -Parent) -Parent) -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    Test-Case "Bootstrap runs doctor hygiene apply verify then succeeds" {
        $script:Events = @()
        $result = Invoke-HeiGeApplyFlow -Root $script:InstallRoot -Theme "miku-488137" -Port 9341 `
            -ContextProvider { New-TestEntrypointContext } `
            -DoctorProvider {
                param($Context, $Port)
                $script:Events += "doctor"
                [pscustomobject]@{ diagnosis = "running-no-flag：实例未带调试参数" }
            } `
            -HygieneProvider { param($Context, $Port) $script:Events += "hygiene" } `
            -CdpStatusProvider { param($Context, $Port) $false } `
            -ProcessProvider { param($Context) @() } `
            -StartCdpProvider { param($Context, $Port) $script:Events += "start-cdp" } `
            -SleepProvider { param($Milliseconds) $script:Events += "sleep:$Milliseconds" } `
            -CliProvider {
                param($Context, $Arguments)
                $script:Events += ("cli:" + $Arguments[0])
                Assert-ExactCliCall -Actual $Arguments `
                    -Expected @("apply", "--theme", "miku-488137", "--port", "9341")
                [pscustomobject]@{ mode = "active"; persistenceEnabled = $false }
            } `
            -StatusProvider {
                param($Context, $Port)
                $script:Events += "status"
                [pscustomobject]@{
                    statuses = @(
                        [pscustomobject]@{
                            installed = $true
                            mode = "active"
                            themeId = "miku-488137"
                            persistenceEnabled = $false
                        }
                    )
                    failed = @()
                }
            } `
            -CompensateProvider { param($Context, $Port, $Mode) throw "should not compensate" }
        Assert-Equal "active" $result.Mode
        Assert-False $result.BootstrapIdempotent
        Assert-Equal @("doctor", "hygiene", "start-cdp", "cli:apply", "status") $script:Events
        Assert-True ($result.BootstrapSteps -contains "doctor")
        Assert-True ($result.BootstrapSteps -contains "apply:1")
        Assert-True ($result.BootstrapSteps -contains "verify:1")
    }

    Test-Case "Bootstrap retries a whole apply attempt after ephemeral timeout" {
        $script:Events = @()
        $script:ApplyAttempts = 0
        $result = Invoke-HeiGeApplyFlow -Root $script:InstallRoot -Port 9341 -MaxApplyAttempts 2 `
            -ContextProvider { New-TestEntrypointContext } `
            -SkipDoctor `
            -HygieneProvider { param($Context, $Port) $script:Events += "hygiene" } `
            -CdpStatusProvider { param($Context, $Port) $true } `
            -StartCdpProvider { param($Context, $Port) $script:Events += "start-cdp" } `
            -SleepProvider { param($Milliseconds) $script:Events += "sleep:$Milliseconds" } `
            -CliProvider {
                param($Context, $Arguments)
                $script:ApplyAttempts += 1
                $script:Events += "apply:$script:ApplyAttempts"
                if ($script:ApplyAttempts -eq 1) {
                    throw "HeiGe Codex Skin Studio：ephemeral controller 未确认皮肤已应用"
                }
                [pscustomobject]@{ mode = "active"; persistenceEnabled = $false }
            } `
            -StatusProvider {
                param($Context, $Port)
                $script:Events += "status"
                if ($script:ApplyAttempts -ge 2) {
                    return [pscustomobject]@{
                        statuses = @(
                            [pscustomobject]@{
                                installed = $true
                                mode = "active"
                                themeId = "miku-488137"
                                persistenceEnabled = $false
                            }
                        )
                        failed = @()
                    }
                }
                return [pscustomobject]@{ statuses = @(); failed = @() }
            }
        Assert-Equal "active" $result.Mode
        Assert-Equal @(
            "hygiene", "status", "start-cdp", "apply:1", "sleep:1000", "start-cdp", "apply:2", "status"
        ) $script:Events
        Assert-True ($result.BootstrapSteps -contains "retry:1")
    }

    Test-Case "Bootstrap returns idempotent success when skin is already active" {
        $script:Events = @()
        $result = Invoke-HeiGeApplyFlow -Root $script:InstallRoot -Theme "miku-488137" -Port 9341 `
            -ContextProvider { New-TestEntrypointContext } `
            -SkipDoctor `
            -HygieneProvider { param($Context, $Port) $script:Events += "hygiene" } `
            -CdpStatusProvider { param($Context, $Port) $true } `
            -StartCdpProvider { param($Context, $Port) $script:Events += "start-cdp" } `
            -CliProvider { param($Context, $Arguments) throw "should not apply" } `
            -StatusProvider {
                param($Context, $Port)
                $script:Events += "status"
                [pscustomobject]@{
                    statuses = @(
                        [pscustomobject]@{
                            installed = $true
                            mode = "active"
                            themeId = "miku-488137"
                            persistenceEnabled = $true
                        }
                    )
                    failed = @()
                }
            }
        Assert-equal "active" $result.Mode
        Assert-True $result.BootstrapIdempotent
        Assert-True $result.PersistenceEnabled
        Assert-Equal @("hygiene", "status") $script:Events
        Assert-False ($script:Events -contains "start-cdp")
    }

    Test-Case "Apply failure restores the exact native prestate and remains visible" {
        $script:Events = @()
        Assert-Throws {
            Invoke-HeiGeApplyFlow -Root $script:InstallRoot -Theme "miku-488137" -Port 9341 `
                -ContextProvider { $script:Events += "preflight"; New-TestEntrypointContext } `
                -CdpStatusProvider {
                    param($Context, $Port)
                    $script:Events += "cdp-prestate"
                    $false
                } `
                -ProcessProvider {
                    param($Context)
                    $script:Events += "native-prestate"
                    @(New-TestCodexProcess -Id 41)
                } `
                -StartCdpProvider { param($Context, $Port) $script:Events += "start-cdp" } `
                -CliProvider {
                    param($Context, $Arguments)
                    $script:Events += "apply"
                    throw "apply failed visibly"
                } `
                -CompensateProvider {
                    param($Context, $Port, $Mode)
                    $script:Events += "compensate:$Mode"
                    [pscustomobject]@{ Restored = $true; Mode = "native" }
                }
        } "apply failed visibly"
        Assert-Equal @(
            "preflight", "cdp-prestate", "native-prestate", "start-cdp", "apply", "compensate:native"
        ) $script:Events
    }

    Test-Case "Apply failure restores the exact closed prestate and remains visible" {
        $script:Events = @()
        Assert-Throws {
            Invoke-HeiGeApplyFlow -Root $script:InstallRoot -Port 9341 `
                -ContextProvider { New-TestEntrypointContext } `
                -CdpStatusProvider {
                    param($Context, $Port)
                    $script:Events += "cdp-prestate"
                    $false
                } `
                -ProcessProvider {
                    param($Context)
                    $script:Events += "closed-prestate"
                    @()
                } `
                -StartCdpProvider { param($Context, $Port) $script:Events += "start-cdp" } `
                -CliProvider {
                    param($Context, $Arguments)
                    $script:Events += "apply"
                    throw "closed apply failed visibly"
                } `
                -CompensateProvider {
                    param($Context, $Port, $Mode)
                    $script:Events += "compensate:$Mode"
                    [pscustomobject]@{ Restored = $true; Mode = "closed" }
                }
        } "closed apply failed visibly"
        Assert-Equal @(
            "cdp-prestate", "closed-prestate", "start-cdp", "apply", "compensate:closed"
        ) $script:Events
    }

    Test-Case "Apply reports both the original and compensation errors" {
        Assert-Throws {
            Invoke-HeiGeApplyFlow -Root $script:InstallRoot -Port 9341 `
                -ContextProvider { New-TestEntrypointContext } `
                -CdpStatusProvider { param($Context, $Port) $false } `
                -ProcessProvider { param($Context) @() } `
                -StartCdpProvider { param($Context, $Port) } `
                -CliProvider { param($Context, $Arguments) throw "original apply failure" } `
                -CompensateProvider { param($Context, $Port, $Mode) throw "closed restore failure" }
        } "原始错误：original apply failure；补偿错误：closed restore failure"
    }

    Test-Case "Enable compatibility name applies only this session" {
        $script:Events = @()
        $script:CliCalls = @()
        $result = Invoke-HeiGeEnableSkinFlow -Root $script:InstallRoot -Theme "miku-488137" -Port 9341 `
            -ContextProvider { $script:Events += "preflight"; New-TestEntrypointContext } `
            -CdpStatusProvider { param($Context, $Port) $true } `
            -StartCdpProvider { param($Context, $Port) $script:Events += "start-cdp" } `
            -CliProvider {
                param($Context, $Arguments)
                $script:CliCalls += ,@($Arguments)
                $script:Events += "apply"
                return [pscustomobject]@{ mode = "active"; persistenceEnabled = $false }
            }
        Assert-Equal @("preflight", "start-cdp", "apply") $script:Events
        Assert-Equal 1 $script:CliCalls.Count
        Assert-ExactCliCall -Actual $script:CliCalls[0] `
            -Expected @("apply", "--theme", "miku-488137", "--port", "9341")
        Assert-False $result.PersistenceEnabled
        Assert-False $result.PersistenceChanged
        Assert-Equal "complete" $result.Completion
    }

    Test-Case "Enable compatibility name restores stored selection without changing persistence" {
        $script:CliCalls = @()
        $result = Invoke-HeiGeEnableSkinFlow -Root $script:InstallRoot -Port 9341 `
            -ContextProvider { New-TestEntrypointContext } `
            -CdpStatusProvider { param($Context, $Port) $true } `
            -StartCdpProvider { param($Context, $Port) } `
            -CliProvider {
                param($Context, $Arguments)
                $script:CliCalls += ,@($Arguments)
                return [pscustomobject]@{ mode = "active"; persistenceEnabled = $true }
            }
        Assert-ExactCliCall -Actual $script:CliCalls[0] `
            -Expected @("apply", "--prefer-stored", "--port", "9341")
        Assert-Equal 1 $script:CliCalls.Count
        Assert-True $result.PersistenceEnabled
        Assert-False $result.PersistenceChanged
        Assert-Equal "stored-or-default" $result.ThemeSelection
    }

    Test-Case "Pause is a clean no-op without an exact current CDP process" {
        $script:CliCalled = $false
        $result = Invoke-HeiGePauseFlow -Root $script:InstallRoot -Port 9341 `
            -ContextProvider { New-TestEntrypointContext } `
            -CdpStatusProvider { param($Context, $Port) $false } `
            -CliProvider { param($Context, $Arguments) $script:CliCalled = $true }
        Assert-False $script:CliCalled
        Assert-Equal "noop" $result.Mode
    }

    Test-Case "Pause mutates only after an exact current CDP process is confirmed" {
        $script:Events = @()
        $script:Arguments = $null
        $result = Invoke-HeiGePauseFlow -Root $script:InstallRoot -Port 9341 `
            -ContextProvider { New-TestEntrypointContext } `
            -CdpStatusProvider { param($Context, $Port) $script:Events += "owner"; $true } `
            -CliProvider {
                param($Context, $Arguments)
                $script:Events += "pause"
                $script:Arguments = @($Arguments)
                [pscustomobject]@{ mode = "paused"; persistenceEnabled = $false }
            }
        Assert-Equal @("owner", "pause") $script:Events
        Assert-ExactCliCall -Actual $script:Arguments -Expected @("pause", "--port", "9341")
        Assert-Equal "paused" $result.Mode
    }

    Test-Case "Resume requires an exact current CDP process before mutation" {
        $script:CliCalled = $false
        Assert-Throws {
            Invoke-HeiGeResumeFlow -Root $script:InstallRoot -Port 9341 `
                -ContextProvider { New-TestEntrypointContext } `
                -RequireCdpProvider { param($Context, $Port) throw "exact owner missing" } `
                -CliProvider { param($Context, $Arguments) $script:CliCalled = $true }
        } "exact owner missing"
        Assert-False $script:CliCalled
    }

    Test-Case "Resume uses the frozen CLI operation after exact ownership" {
        $script:Events = @()
        $script:Arguments = $null
        $result = Invoke-HeiGeResumeFlow -Root $script:InstallRoot -Port 9341 `
            -ContextProvider { New-TestEntrypointContext } `
            -RequireCdpProvider { param($Context, $Port) $script:Events += "owner" } `
            -CliProvider {
                param($Context, $Arguments)
                $script:Events += "resume"
                $script:Arguments = @($Arguments)
                [pscustomobject]@{ mode = "active"; persistenceEnabled = $true }
            }
        Assert-Equal @("owner", "resume") $script:Events
        Assert-ExactCliCall -Actual $script:Arguments -Expected @("resume", "--port", "9341")
        Assert-Equal "active" $result.Mode
        Assert-True $result.PersistenceEnabled
    }

    Test-Case "Restore disables unregisters then normally restarts native Codex" {
        $script:Events = @()
        $script:CdpChecks = 0
        $result = Invoke-HeiGeRestoreFlow -Root $script:InstallRoot -Port 9341 `
            -ContextProvider { $script:Events += "preflight"; New-TestEntrypointContext } `
            -CdpStatusProvider {
                param($Context, $Port)
                $script:CdpChecks++
                $script:Events += "owner:$($script:CdpChecks)"
                $true
            } `
            -ProcessProvider { param($Context) throw "active CDP already proves the process" } `
            -CliProvider {
                param($Context, $Arguments)
                if ($Arguments[0] -eq "set-persistence") {
                    $script:Events += "disable"
                    return [pscustomobject]@{ persistenceEnabled = $false; revision = 8 }
                }
                $script:Events += "pause"
                return [pscustomobject]@{ mode = "paused" }
            } `
            -UnregisterProvider {
                param($Context)
                $script:Events += "unregister"
                [pscustomobject]@{ VerifiedAbsent = $true }
            } `
            -RestartNativeProvider { param($Context, $Port) $script:Events += "restart-native" }
        Assert-Equal @(
            "preflight", "owner:1", "disable", "owner:2", "pause", "unregister", "restart-native"
        ) $script:Events
        Assert-False $result.PersistenceEnabled
        Assert-Equal "restoring" $result.Mode
    }

    Test-Case "Restore disables persistence while Codex is closed and keeps it closed" {
        $script:Events = @()
        $script:CdpChecks = 0
        $script:ProcessChecks = 0
        $result = Invoke-HeiGeRestoreFlow -Root $script:InstallRoot -Port 9341 `
            -ContextProvider { $script:Events += "preflight"; New-TestEntrypointContext } `
            -CdpStatusProvider {
                param($Context, $Port)
                $script:CdpChecks++
                $script:Events += "no-cdp:$($script:CdpChecks)"
                $false
            } `
            -ProcessProvider {
                param($Context)
                $script:ProcessChecks++
                $script:Events += "closed:$($script:ProcessChecks)"
                @()
            } `
            -CliProvider {
                param($Context, $Arguments)
                $script:Events += ($Arguments -join " ")
                [pscustomobject]@{ persistenceEnabled = $false; revision = 10 }
            } `
            -UnregisterProvider {
                param($Context)
                $script:Events += "unregister"
                [pscustomobject]@{ VerifiedAbsent = $true }
            } `
            -RestartNativeProvider { param($Context, $Port) throw "closed Codex must stay closed" }
        Assert-Equal @(
            "preflight", "no-cdp:1", "closed:1", "set-persistence false --port 9341",
            "no-cdp:2", "unregister", "closed:2"
        ) $script:Events
        Assert-Equal "closed" $result.Mode
        Assert-False $result.PersistenceEnabled
    }

    Test-Case "Restore disables persistence for native or CDP-unavailable Codex without starting it" {
        $script:Events = @()
        $script:CdpChecks = 0
        $script:ProcessChecks = 0
        $result = Invoke-HeiGeRestoreFlow -Root $script:InstallRoot -Port 9341 `
            -ContextProvider { New-TestEntrypointContext } `
            -CdpStatusProvider {
                param($Context, $Port)
                $script:CdpChecks++
                $script:Events += "cdp-unavailable:$($script:CdpChecks)"
                $false
            } `
            -ProcessProvider {
                param($Context)
                $script:ProcessChecks++
                $script:Events += "native-process:$($script:ProcessChecks)"
                @(
                    (New-TestCodexProcess -Id 41),
                    (New-TestCodexProcess -Id 42 -ParentProcessId 41)
                )
            } `
            -CliProvider {
                param($Context, $Arguments)
                $script:Events += ($Arguments -join " ")
                [pscustomobject]@{ persistenceEnabled = $false; revision = 12 }
            } `
            -UnregisterProvider {
                param($Context)
                $script:Events += "unregister"
                [pscustomobject]@{ VerifiedAbsent = $true }
            } `
            -RestartNativeProvider { param($Context, $Port) throw "native Codex must not restart" }
        Assert-Equal @(
            "cdp-unavailable:1", "native-process:1", "set-persistence false --port 9341",
            "cdp-unavailable:2", "unregister", "native-process:2"
        ) $script:Events
        Assert-Equal "native" $result.Mode
        Assert-False $result.PersistenceEnabled
    }

    Test-Case "Restore handles an exact CDP process exiting after persistence is disabled" {
        $script:Events = @()
        $script:CdpChecks = 0
        $result = Invoke-HeiGeRestoreFlow -Root $script:InstallRoot -Port 9341 `
            -ContextProvider { New-TestEntrypointContext } `
            -CdpStatusProvider {
                param($Context, $Port)
                $script:CdpChecks++
                $script:Events += "owner:$($script:CdpChecks)"
                return ($script:CdpChecks -eq 1)
            } `
            -ProcessProvider {
                param($Context)
                $script:Events += "closed-after-exit"
                @()
            } `
            -CliProvider {
                param($Context, $Arguments)
                $script:Events += ($Arguments -join " ")
                [pscustomobject]@{ persistenceEnabled = $false; revision = 13 }
            } `
            -UnregisterProvider {
                param($Context)
                $script:Events += "unregister"
                [pscustomobject]@{ VerifiedAbsent = $true }
            } `
            -RestartNativeProvider { param($Context, $Port) throw "exited Codex must not restart" }
        Assert-Equal @(
            "owner:1", "set-persistence false --port 9341", "owner:2", "unregister", "closed-after-exit"
        ) $script:Events
        Assert-Equal "closed" $result.Mode
        Assert-False $result.PersistenceEnabled
    }

    Test-Case "Restore rejects multiple exact main processes before mutating state" {
        $script:Events = @()
        Assert-Throws {
            Invoke-HeiGeRestoreFlow -Root $script:InstallRoot -Port 9341 `
                -ContextProvider { New-TestEntrypointContext } `
                -CdpStatusProvider { param($Context, $Port) $script:Events += "no-cdp"; $false } `
                -ProcessProvider {
                    param($Context)
                    $script:Events += "ambiguous-processes"
                    @(
                        (New-TestCodexProcess -Id 41),
                        (New-TestCodexProcess -Id 51)
                    )
                } `
                -CliProvider { param($Context, $Arguments) $script:Events += "cli" } `
                -UnregisterProvider { param($Context) $script:Events += "unregister" } `
                -RestartNativeProvider { param($Context, $Port) $script:Events += "restart" }
        } "主进程归属不唯一"
        Assert-Equal @("no-cdp", "ambiguous-processes") $script:Events
    }

    Test-Case "Restore rejects a unique root plus a detached ownership cycle" {
        $script:Events = @()
        Assert-Throws {
            Invoke-HeiGeRestoreFlow -Root $script:InstallRoot -Port 9341 `
                -ContextProvider { New-TestEntrypointContext } `
                -CdpStatusProvider { param($Context, $Port) $script:Events += "no-cdp"; $false } `
                -ProcessProvider {
                    param($Context)
                    $script:Events += "root-plus-cycle"
                    @(
                        (New-TestCodexProcess -Id 41),
                        (New-TestCodexProcess -Id 51 -ParentProcessId 61),
                        (New-TestCodexProcess -Id 61 -ParentProcessId 51)
                    )
                } `
                -CliProvider { param($Context, $Arguments) $script:Events += "cli" } `
                -UnregisterProvider { param($Context) $script:Events += "unregister" } `
                -RestartNativeProvider { param($Context, $Port) $script:Events += "restart" }
        } "进程图包含归属环"
        Assert-Equal @("no-cdp", "root-plus-cycle") $script:Events
    }

    Test-Case "Restore rejects a foreign Codex candidate before mutating state" {
        $script:Events = @()
        Assert-Throws {
            Invoke-HeiGeRestoreFlow -Root $script:InstallRoot -Port 9341 `
                -ContextProvider { New-TestEntrypointContext } `
                -CdpStatusProvider { param($Context, $Port) $script:Events += "no-cdp"; $false } `
                -ProcessProvider {
                    param($Context)
                    $script:Events += "foreign-process"
                    @(
                        (New-TestCodexProcess -Id 41),
                        (New-TestCodexProcess -Id 51 `
                            -Path "C:\Program Files\ChatGPT\ChatGPT.exe")
                    )
                } `
                -CliProvider { param($Context, $Arguments) $script:Events += "cli" } `
                -UnregisterProvider { param($Context) $script:Events += "unregister" } `
                -RestartNativeProvider { param($Context, $Port) $script:Events += "restart" }
        } "不属于已绑定"
        Assert-Equal @("no-cdp", "foreign-process") $script:Events
    }

    Test-Case "Restore rejects an unreadable candidate process before mutating state" {
        $script:Events = @()
        Assert-Throws {
            Invoke-HeiGeRestoreFlow -Root $script:InstallRoot -Port 9341 `
                -ContextProvider { New-TestEntrypointContext } `
                -CdpStatusProvider { param($Context, $Port) $script:Events += "no-cdp"; $false } `
                -ProcessProvider {
                    param($Context)
                    $script:Events += "unreadable-process"
                    [pscustomobject]@{
                        ProcessId = 41
                        ParentProcessId = 0
                        ExecutablePath = $null
                        Name = "Codex.exe"
                    }
                } `
                -CliProvider { param($Context, $Arguments) $script:Events += "cli" } `
                -UnregisterProvider { param($Context) $script:Events += "unregister" } `
                -RestartNativeProvider { param($Context, $Port) $script:Events += "restart" }
        } "无法唯一归属"
        Assert-Equal @("no-cdp", "unreadable-process") $script:Events
    }

    Test-Case "Restore preflight failure cannot quit restart or mutate state" {
        $script:Events = @()
        Assert-Throws {
            Invoke-HeiGeRestoreFlow -Root $script:InstallRoot -Port 9341 `
                -ContextProvider { $script:Events += "preflight"; throw "dependency failed" } `
                -CdpStatusProvider { param($Context, $Port) $script:Events += "owner"; $true } `
                -CliProvider { param($Context, $Arguments) $script:Events += "cli" } `
                -UnregisterProvider { param($Context) $script:Events += "unregister" } `
                -RestartNativeProvider { param($Context, $Port) $script:Events += "restart" }
        } "dependency failed"
        Assert-Equal @("preflight") $script:Events
    }

    Test-Case "Start Menu launcher targets the hidden session-only apply entrypoint" {
        $script:ShortcutTarget = $null
        $result = Install-HeiGeStartMenuShortcut -InstallRoot $script:InstallRoot `
            -StartMenuRoot $script:StartMenuRoot `
            -CreateShortcutProvider {
                param($Path, $Target, $WorkingDirectory, $Description)
                $script:ShortcutTarget = $Target
                [System.IO.File]::WriteAllText($Path, "shortcut")
            } `
            -ReadShortcutProvider {
                param($Path)
                New-TestShortcutObservation -TargetPath $script:ShortcutTarget `
                    -WorkingDirectory (Split-Path $script:ShortcutTarget -Parent)
            }
        Assert-Equal $script:ApplyHidden $script:ShortcutTarget
        Assert-Equal (Join-Path $script:StartMenuRoot "HeiGe Codex Skin Studio\HeiGe 皮肤启动器.lnk") $result.ShortcutPath
        Assert-True $result.Verified
    }

    Test-Case "Start Menu safely migrates the owned legacy enable launcher to session-only apply" {
        $migrationRoot = Join-Path $script:Root "Legacy Launcher Start Menu"
        $shortcutPath = Get-HeiGeStartMenuShortcutPath -StartMenuRoot $migrationRoot
        New-Item -ItemType Directory -Path (Split-Path $shortcutPath -Parent) -Force | Out-Null
        [System.IO.File]::WriteAllText($shortcutPath, "legacy launcher")
        $readProvider = {
            param($Path)
            $content = [System.IO.File]::ReadAllText($Path)
            $target = if ($content -ceq "legacy launcher") {
                $script:EnableBat
            } else {
                $script:ApplyHidden
            }
            New-TestShortcutObservation -TargetPath $target `
                -WorkingDirectory (Split-Path $target -Parent)
        }
        $result = Install-HeiGeStartMenuShortcut -InstallRoot $script:InstallRoot `
            -StartMenuRoot $migrationRoot `
            -CreateShortcutProvider {
                param($Path, $Target, $WorkingDirectory, $Description)
                Assert-Equal $script:ApplyHidden $Target
                [System.IO.File]::WriteAllText($Path, "session launcher")
            } `
            -ReadShortcutProvider $readProvider
        Assert-True $result.Verified
        Assert-Equal "session launcher" ([System.IO.File]::ReadAllText($shortcutPath))
    }

    Test-Case "Shell link no-icon serialization normalizes without hiding a custom icon" {
        Assert-Equal "" (ConvertFrom-HeiGeWshIconLocation -IconLocation "")
        Assert-Equal "" (ConvertFrom-HeiGeWshIconLocation -IconLocation ", 0")
        Assert-Equal "" (ConvertFrom-HeiGeWshIconLocation -IconLocation "  ,0  ")
        Assert-Equal "C:\Windows\custom.ico, 0" `
            (ConvertFrom-HeiGeWshIconLocation -IconLocation "C:\Windows\custom.ico, 0")
        Assert-Equal ", 1" (ConvertFrom-HeiGeWshIconLocation -IconLocation ", 1")
    }

    Test-Case "Default Unicode shortcut round-trips the complete generated schema" {
        $shortcutPath = Join-Path $script:Root "Unicode Schema\HeiGe 皮肤启动器.lnk"
        New-Item -ItemType Directory -Path (Split-Path $shortcutPath -Parent) -Force | Out-Null
        try {
            New-DefaultHeiGeShortcut -Path $shortcutPath -Target $script:ApplyBat `
                -WorkingDirectory (Split-Path $script:ApplyBat -Parent) `
                -Description $script:ShortcutDescription
        } catch {
            $creationError = $_
            $hresult = "0x{0:X8}" -f $creationError.Exception.HResult
            throw "Unicode shortcut creation failed：$($creationError.Exception.Message)；HRESULT=$hresult`n$($creationError.InvocationInfo.PositionMessage)`n$($creationError.ScriptStackTrace)"
        }
        try {
            $observed = Read-DefaultHeiGeShortcut -Path $shortcutPath
        } catch {
            throw "Unicode shortcut inspection failed：$($_.Exception.Message)"
        }
        Assert-Equal $script:ApplyBat $observed.TargetPath
        Assert-Equal (Split-Path $script:ApplyBat -Parent) $observed.WorkingDirectory
        Assert-Equal $script:ShortcutDescription $observed.Description
        Assert-Equal "" $observed.Arguments
        Assert-Equal 1 $observed.WindowStyle
        Assert-Equal "" $observed.Hotkey
        Assert-Equal "" $observed.IconLocation
    }

    Test-Case "Default Unicode shortcut preserves an exact future target" {
        $shortcutPath = Join-Path $script:Root "Future Unicode Schema\HeiGe 皮肤启动器.lnk"
        $futureTarget = Join-Path $script:Root "尚未发布的安装目录\scripts\windows\apply.bat"
        $futureWorking = Split-Path $futureTarget -Parent
        New-Item -ItemType Directory -Path (Split-Path $shortcutPath -Parent) -Force | Out-Null
        Assert-False (Test-Path -LiteralPath $futureTarget)
        Assert-False (Test-Path -LiteralPath $futureWorking)
        New-DefaultHeiGeShortcut -Path $shortcutPath -Target $futureTarget `
            -WorkingDirectory $futureWorking -Description $script:ShortcutDescription
        $observed = Read-DefaultHeiGeShortcut -Path $shortcutPath
        Assert-Equal $futureTarget $observed.TargetPath
        Assert-Equal $futureWorking $observed.WorkingDirectory
        Assert-Equal $script:ShortcutDescription $observed.Description
        Assert-Equal "" $observed.Arguments
        Assert-Equal 1 $observed.WindowStyle
        Assert-Equal "" $observed.Hotkey
        Assert-Equal "" $observed.IconLocation
    }

    Test-Case "Start Menu verification failure removes the untrusted shortcut" {
        $untrustedMenuRoot = Join-Path $script:Root "Untrusted Start Menu"
        $shortcutPath = Join-Path $untrustedMenuRoot "HeiGe Codex Skin Studio\HeiGe 皮肤启动器.lnk"
        Assert-Throws {
            Install-HeiGeStartMenuShortcut -InstallRoot $script:InstallRoot `
                -StartMenuRoot $untrustedMenuRoot `
                -CreateShortcutProvider {
                    param($Path, $Target, $WorkingDirectory, $Description)
                    [System.IO.File]::WriteAllText($Path, "shortcut")
                } `
                -ReadShortcutProvider {
                    param($Path)
                    New-TestShortcutObservation -TargetPath "C:\foreign.bat" -WorkingDirectory "C:\"
                }
        } "shortcut verification failed"
        Assert-False (Test-Path -LiteralPath $shortcutPath)
        $stagedArtifacts = @(Get-ChildItem -LiteralPath (Split-Path $shortcutPath -Parent) `
            -Filter "*.staged.*.lnk" -ErrorAction SilentlyContinue)
        Assert-Equal 0 $stagedArtifacts.Count
    }

    Test-Case "Start Menu participant round-trips through JSON and restores exact prior bytes" {
        $transactionMenuRoot = Join-Path $script:Root "Transactional Start Menu"
        $shortcutPath = Get-HeiGeStartMenuShortcutPath -StartMenuRoot $transactionMenuRoot
        New-Item -ItemType Directory -Path (Split-Path $shortcutPath -Parent) -Force | Out-Null
        [System.IO.File]::WriteAllText($shortcutPath, "old shortcut bytes")
        $script:TransactionalTarget = $script:ApplyHidden
        $script:TransactionalWorking = Split-Path $script:ApplyHidden -Parent
        $readProvider = {
            param($Path)
            New-TestShortcutObservation -TargetPath $script:TransactionalTarget `
                -WorkingDirectory $script:TransactionalWorking
        }
        $participant = Prepare-HeiGeStartMenuShortcut -InstallRoot $script:InstallRoot `
            -StartMenuRoot $transactionMenuRoot `
            -CreateShortcutProvider {
                param($Path, $Target, $WorkingDirectory, $Description)
                [System.IO.File]::WriteAllText($Path, "new shortcut bytes")
            } `
            -ReadShortcutProvider $readProvider
        $serialized = $participant | ConvertTo-Json -Depth 8 | ConvertFrom-Json
        Publish-HeiGeStartMenuShortcut -Participant $serialized `
            -ReadShortcutProvider $readProvider | Out-Null
        Assert-Equal "new shortcut bytes" ([System.IO.File]::ReadAllText($shortcutPath))
        Assert-Equal "old shortcut bytes" ([System.IO.File]::ReadAllText($participant.BackupPath))
        Rollback-HeiGeStartMenuShortcut -Participant $serialized `
            -ReadShortcutProvider $readProvider | Out-Null
        Assert-Equal "old shortcut bytes" ([System.IO.File]::ReadAllText($shortcutPath))
        Assert-False (Test-Path -LiteralPath $participant.StagePath)
        Assert-False (Test-Path -LiteralPath $participant.BackupPath)
    }

    Test-Case "Start Menu participant retains the prior shortcut until final commit" {
        $finalizeMenuRoot = Join-Path $script:Root "Finalize Start Menu"
        $shortcutPath = Get-HeiGeStartMenuShortcutPath -StartMenuRoot $finalizeMenuRoot
        New-Item -ItemType Directory -Path (Split-Path $shortcutPath -Parent) -Force | Out-Null
        [System.IO.File]::WriteAllText($shortcutPath, "prior version")
        $script:TransactionalTarget = $script:ApplyHidden
        $script:TransactionalWorking = Split-Path $script:ApplyHidden -Parent
        $readProvider = {
            param($Path)
            New-TestShortcutObservation -TargetPath $script:TransactionalTarget `
                -WorkingDirectory $script:TransactionalWorking
        }
        $participant = Prepare-HeiGeStartMenuShortcut -InstallRoot $script:InstallRoot `
            -StartMenuRoot $finalizeMenuRoot `
            -CreateShortcutProvider {
                param($Path, $Target, $WorkingDirectory, $Description)
                [System.IO.File]::WriteAllText($Path, "committed version")
            } `
            -ReadShortcutProvider $readProvider
        Publish-HeiGeStartMenuShortcut -Participant $participant `
            -ReadShortcutProvider $readProvider | Out-Null
        Assert-True (Test-Path -LiteralPath $participant.BackupPath -PathType Leaf)
        Finalize-HeiGeStartMenuShortcut -Participant $participant `
            -ReadShortcutProvider $readProvider | Out-Null
        Assert-Equal "committed version" ([System.IO.File]::ReadAllText($shortcutPath))
        Assert-False (Test-Path -LiteralPath $participant.BackupPath)
    }

    Test-Case "Fresh Start Menu participant rollback restores folder absence" {
        $freshMenuRoot = Join-Path $script:Root "Fresh Rollback Start Menu"
        $script:TransactionalTarget = $script:ApplyHidden
        $script:TransactionalWorking = Split-Path $script:ApplyHidden -Parent
        $readProvider = {
            param($Path)
            New-TestShortcutObservation -TargetPath $script:TransactionalTarget `
                -WorkingDirectory $script:TransactionalWorking
        }
        $participant = Prepare-HeiGeStartMenuShortcut -InstallRoot $script:InstallRoot `
            -StartMenuRoot $freshMenuRoot `
            -CreateShortcutProvider {
                param($Path, $Target, $WorkingDirectory, $Description)
                [System.IO.File]::WriteAllText($Path, "fresh shortcut")
            } `
            -ReadShortcutProvider $readProvider
        $serialized = $participant | ConvertTo-Json -Depth 8 | ConvertFrom-Json
        Publish-HeiGeStartMenuShortcut -Participant $serialized `
            -ReadShortcutProvider $readProvider | Out-Null
        Rollback-HeiGeStartMenuShortcut -Participant $serialized `
            -ReadShortcutProvider $readProvider | Out-Null
        Assert-False (Test-Path -LiteralPath $freshMenuRoot)
    }

    Test-Case "Start Menu prepare refuses a foreign existing shortcut without changing it" {
        $foreignMenuRoot = Join-Path $script:Root "Foreign Start Menu"
        $shortcutPath = Get-HeiGeStartMenuShortcutPath -StartMenuRoot $foreignMenuRoot
        New-Item -ItemType Directory -Path (Split-Path $shortcutPath -Parent) -Force | Out-Null
        [System.IO.File]::WriteAllText($shortcutPath, "foreign sentinel")
        Assert-Throws {
            Prepare-HeiGeStartMenuShortcut -InstallRoot $script:InstallRoot `
                -StartMenuRoot $foreignMenuRoot `
                -CreateShortcutProvider {
                    param($Path, $Target, $WorkingDirectory, $Description)
                    [System.IO.File]::WriteAllText($Path, "must not be created")
                } `
                -ReadShortcutProvider {
                    param($Path)
                    New-TestShortcutObservation -TargetPath "C:\foreign.bat" -WorkingDirectory "C:\"
                } | Out-Null
        } "shortcut target path mismatch"
        Assert-Equal "foreign sentinel" ([System.IO.File]::ReadAllText($shortcutPath))
        $stagedArtifacts = @(Get-ChildItem -LiteralPath (Split-Path $shortcutPath -Parent) `
            -Filter "*.staged.*.lnk" -ErrorAction SilentlyContinue)
        Assert-Equal 0 $stagedArtifacts.Count
    }

    Test-Case "Start Menu prepare keeps a foreign same-target shortcut with a different marker" {
        $foreignMenuRoot = Join-Path $script:Root "Foreign Marker Start Menu"
        $shortcutPath = Get-HeiGeStartMenuShortcutPath -StartMenuRoot $foreignMenuRoot
        New-Item -ItemType Directory -Path (Split-Path $shortcutPath -Parent) -Force | Out-Null
        [System.IO.File]::WriteAllText($shortcutPath, "foreign marker sentinel")
        Assert-Throws {
            Prepare-HeiGeStartMenuShortcut -InstallRoot $script:InstallRoot `
                -StartMenuRoot $foreignMenuRoot `
                -ReadShortcutProvider {
                    param($Path)
                    New-TestShortcutObservation -TargetPath $script:ApplyHidden `
                        -WorkingDirectory (Split-Path $script:ApplyHidden -Parent) `
                        -Description "Foreign launcher"
                } | Out-Null
        } "shortcut description marker mismatch"
        Assert-Equal "foreign marker sentinel" ([System.IO.File]::ReadAllText($shortcutPath))
    }

    Test-Case "Start Menu prepare keeps a foreign same-target shortcut with injected arguments" {
        $foreignMenuRoot = Join-Path $script:Root "Foreign Arguments Start Menu"
        $shortcutPath = Get-HeiGeStartMenuShortcutPath -StartMenuRoot $foreignMenuRoot
        New-Item -ItemType Directory -Path (Split-Path $shortcutPath -Parent) -Force | Out-Null
        [System.IO.File]::WriteAllText($shortcutPath, "foreign arguments sentinel")
        Assert-Throws {
            Prepare-HeiGeStartMenuShortcut -InstallRoot $script:InstallRoot `
                -StartMenuRoot $foreignMenuRoot `
                -ReadShortcutProvider {
                    param($Path)
                    New-TestShortcutObservation -TargetPath $script:ApplyHidden `
                        -WorkingDirectory (Split-Path $script:ApplyHidden -Parent) `
                        -Arguments "--theme foreign"
                } | Out-Null
        } "shortcut arguments mismatch"
        Assert-Equal "foreign arguments sentinel" ([System.IO.File]::ReadAllText($shortcutPath))
    }

    Test-Case "Start Menu rejects a reparse ancestor before creating a shortcut" {
        $path = "C:\Users\Alice\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\HeiGe Codex Skin Studio"
        Assert-Throws {
            Assert-HeiGeNoReparsePathComponents -Path $path -Description "test path" `
                -ItemProvider {
                    param($Candidate)
                    $attributes = if ($Candidate -ieq "C:\Users\Alice\AppData\Roaming") {
                        [System.IO.FileAttributes]::Directory -bor [System.IO.FileAttributes]::ReparsePoint
                    } else {
                        [System.IO.FileAttributes]::Directory
                    }
                    [pscustomobject]@{ PSIsContainer = $true; Attributes = $attributes }
                }
        } "reparse point"
    }

    Test-Case "Start Menu can validate a staged tree while targeting the final install root" {
        $futureInstallRoot = Join-Path $script:Root "Future Published Install"
        $validationMenuRoot = Join-Path $script:Root "Validation Root Start Menu"
        $script:ShortcutTarget = $null
        $script:ShortcutWorking = $null
        $participant = Prepare-HeiGeStartMenuShortcut -InstallRoot $futureInstallRoot `
            -ValidationRoot $script:InstallRoot -StartMenuRoot $validationMenuRoot `
            -CreateShortcutProvider {
                param($Path, $Target, $WorkingDirectory, $Description)
                $script:ShortcutTarget = $Target
                $script:ShortcutWorking = $WorkingDirectory
                [System.IO.File]::WriteAllText($Path, "staged validation shortcut")
            } `
            -ReadShortcutProvider {
                param($Path)
                New-TestShortcutObservation -TargetPath $script:ShortcutTarget `
                    -WorkingDirectory $script:ShortcutWorking
            }
        Assert-Equal (Join-Path $futureInstallRoot "scripts\windows\apply-hidden.vbs") $participant.TargetPath
        Assert-Equal $futureInstallRoot $participant.InstallRoot
        Assert-False (Test-Path -LiteralPath $futureInstallRoot)
        Rollback-HeiGeStartMenuShortcut -Participant $participant `
            -ReadShortcutProvider {
                param($Path)
                New-TestShortcutObservation -TargetPath $script:ShortcutTarget `
                    -WorkingDirectory $script:ShortcutWorking
            } | Out-Null
    }

    Test-Case "Default Start Menu shortcut writes the complete generated schema" {
        $source = [System.IO.File]::ReadAllText(
            (Join-Path $script:RepositoryRoot "scripts\windows\lib\start-menu.ps1")
        )
        Assert-Match 'launcher v1 \| current-user \| re-enable skin' $source
        Assert-Match 'IShellLinkW' $source
        Assert-Match 'IPersistFile' $source
        Assert-Match 'UnmanagedType\.LPWStr' $source
        Assert-Match 'UnicodeShellLinkV1.*::Create' $source
        Assert-Match 'UnicodeShellLinkV1.*::Read' $source
        Assert-Match 'FinalReleaseComObject' $source
        Assert-Match 'SHSimpleIDListFromPath' $source
        Assert-Match 'SetIDList\(simpleIdList\)' $source
        Assert-Match 'FreeCoTaskMem\(simpleIdList\)' $source
        Assert-Match 'persistence\.Save\(path, false\)' $source
        Assert-False ($source -match 'persistence\.SaveCompleted\(')
        Assert-False ($source -match 'WScript\.Shell')
        Assert-Match 'Arguments\s*=\s*\[string\]\$shortcut\.Arguments' $source
        Assert-Match 'WindowStyle\s*=\s*\[int\]\$shortcut\.WindowStyle' $source
        Assert-Match 'Hotkey\s*=\s*\[string\]\$shortcut\.Hotkey' $source
        Assert-Match 'ConvertFrom-HeiGeWshIconLocation' $source
    }

    Test-Case "Exact process filtering cannot close a foreign Codex lookalike" {
        $ownedPath = $script:EnableBat
        $foreignPath = Join-Path $script:Root "Foreign\Codex.exe"
        $app = [pscustomobject]@{
            Kind = "Win32"
            ExecutablePath = $ownedPath
            InstallPath = Split-Path $ownedPath -Parent
        }
        $running = @(Get-RunningCodex -AppInfo $app -ProcessProvider {
            @(
                [pscustomobject]@{ Id = 41; Path = $ownedPath; ProcessName = "Codex" },
                [pscustomobject]@{ Id = 42; Path = $foreignPath; ProcessName = "Codex" }
            )
        })
        Assert-Equal @(41) @($running.Id)
    }

    Test-Case "Native launch never forwards CDP arguments" {
        $script:NativeLaunch = $null
        $app = [pscustomobject]@{
            Kind = "Win32"
            ExecutablePath = $script:EnableBat
            InstallPath = Split-Path $script:EnableBat -Parent
        }
        Start-CodexNative -AppInfo $app -StartProvider {
            param($Path, $Arguments)
            $script:NativeLaunch = [pscustomobject]@{ Path = $Path; Arguments = @($Arguments) }
        } | Out-Null
        Assert-Equal $script:EnableBat $script:NativeLaunch.Path
        Assert-Equal @() $script:NativeLaunch.Arguments

        $script:ActivationArguments = $null
        Start-CodexNative -AppInfo ([pscustomobject]@{
            Kind = "StoreAumid"
            ExecutablePath = $null
            InstallPath = $script:InstallRoot
            Aumid = "OpenAI.Codex_test!App"
        }) -ActivationProvider {
            param($Aumid, $Arguments)
            $script:ActivationArguments = $Arguments
        } | Out-Null
        Assert-Equal "" $script:ActivationArguments
    }

    Test-Case "Windows entrypoints never invoke the macOS lifecycle helper defaults" {
        $source = [System.IO.File]::ReadAllText(
            (Join-Path $script:RepositoryRoot "scripts\windows\lib\entrypoints.ps1")
        )
        Assert-False ($source -match '/bin/ps|/usr/bin/open|osascript|/usr/sbin/lsof')
        Assert-False ($source -match '"enable-skin"|"restore"')
        Assert-False ($source -match '"set-persistence",\s*"true"')
        Assert-Match '"set-persistence",\s*"false"' $source
        Assert-Match 'Get-CimInstance[^\r\n]*Win32_Process' $source
        Assert-Match 'ParentProcessId' $source
    }

    Test-Case "Windows launcher preserves an omitted theme for authoritative selection" {
        $source = [System.IO.File]::ReadAllText(
            (Join-Path $script:RepositoryRoot "scripts\windows\enable-skin.ps1")
        )
        Assert-False ($source -match '\$Theme\s*=\s*"miku-488137"')
        Assert-Match 'PSBoundParameters\.ContainsKey\("Theme"\)' $source
        Assert-Match 'ThemeSelection' $source
    }

    Test-Case "Windows Start Menu and legacy enable wrappers remain session-only" {
        $applySource = [System.IO.File]::ReadAllText(
            (Join-Path $script:RepositoryRoot "scripts\windows\apply.ps1")
        )
        $enableSource = [System.IO.File]::ReadAllText(
            (Join-Path $script:RepositoryRoot "scripts\windows\enable-skin.ps1")
        )
        Assert-False ($applySource -match '\$Theme\s*=\s*"miku-488137"')
        Assert-Match 'PSBoundParameters\.ContainsKey\("Theme"\)' $applySource
        Assert-Match 'Invoke-HeiGeApplyFlow\s+@arguments' $applySource
        Assert-Match 'Invoke-HeiGeEnableSkinFlow' $enableSource
        Assert-Match '当前会话' $enableSource
        Assert-Match 'Codex 顶部.*皮肤常驻.*开关' $enableSource
        Assert-False ($enableSource -match '已.*开启常驻')
    }

    Test-Case "Windows restore has an offline path and truthful closed native messages" {
        $flow = [System.IO.File]::ReadAllText(
            (Join-Path $script:RepositoryRoot "scripts\windows\lib\entrypoints.ps1")
        )
        $wrapper = [System.IO.File]::ReadAllText(
            (Join-Path $script:RepositoryRoot "scripts\windows\restore.ps1")
        )
        Assert-Match 'CdpStatusProvider' $flow
        Assert-Match '"closed"' $flow
        Assert-Match '"native"' $flow
        Assert-Match 'Codex 保持关闭' $wrapper
        Assert-Match 'Codex 保持原生界面运行' $wrapper
    }

    Test-Case "Close Codex reports AlreadyStopped without calling Close or Stop" {
        $script:Events = @()
        $result = Invoke-HeiGeCloseCodexFlow -Root $script:InstallRoot `
            -ContextProvider { New-TestEntrypointContext } `
            -ProcessProvider { param($Context) @() } `
            -CloseProvider {
                param($Process)
                $script:Events += "close"
            } `
            -StopProvider {
                param($Process)
                $script:Events += "stop"
            } `
            -StopCodexProvider {
                param($Context)
                $script:Events += "stop-codex"
                throw "should not stop when already closed"
            }
        Assert-True $result.AlreadyStopped
        Assert-False $result.Closed
        Assert-False $result.Escalated
        Assert-True $result.VerifiedStopped
        Assert-equal @() $script:Events
    }

    Test-Case "Close Codex gracefully closes a windowed owned process" {
        $path = "C:\Program Files\Codex\Codex.exe"
        $script:ModeRecords = @(New-TestCodexProcess -Id 4101 -ParentProcessId 1 -Path $path)
        $script:Running = @([pscustomobject]@{
            Id = 4101
            Path = $path
            ProcessName = "Codex"
            MainWindowHandle = [IntPtr]42
        })
        $script:Events = @()
        $result = Invoke-HeiGeCloseCodexFlow -Root $script:InstallRoot `
            -ContextProvider { New-TestEntrypointContext } `
            -ProcessProvider {
                param($Context)
                @($script:ModeRecords)
            } `
            -StopProcessProvider {
                @($script:Running)
            } `
            -CloseProvider {
                param($Process)
                $script:Events += ("close:" + [int]$Process.Id)
                $script:Running = @()
                $script:ModeRecords = @()
            } `
            -StopProvider {
                param($Process)
                $script:Events += ("stop:" + [int]$Process.Id)
            } `
            -SleepProvider { param($Milliseconds) }
        Assert-True $result.Closed
        Assert-False $result.AlreadyStopped
        Assert-False $result.Escalated
        Assert-True $result.VerifiedStopped
        Assert-equal @("close:4101") $script:Events
    }

    Test-Case "Close Codex escalates only owned main processes without HWND" {
        $path = "C:\Program Files\Codex\Codex.exe"
        # Mode graph includes a child; stop provider only exposes the main process so
        # escalate cannot target foreign/backend PIDs or the owned child renderer.
        $script:ModeRecords = @(
            (New-TestCodexProcess -Id 4201 -ParentProcessId 1 -Path $path),
            (New-TestCodexProcess -Id 4202 -ParentProcessId 4201 -Path $path)
        )
        $script:Running = @(
            [pscustomobject]@{
                Id = 4201
                Path = $path
                ProcessName = "Codex"
                MainWindowHandle = [IntPtr]::Zero
            }
        )
        $script:Events = @()
        $result = Invoke-HeiGeCloseCodexFlow -Root $script:InstallRoot `
            -ContextProvider { New-TestEntrypointContext } `
            -ProcessProvider {
                param($Context)
                @($script:ModeRecords)
            } `
            -StopProcessProvider {
                @($script:Running)
            } `
            -CloseProvider {
                param($Process)
                $script:Events += ("close:" + [int]$Process.Id)
            } `
            -StopProvider {
                param($Process)
                $script:Events += ("stop:" + [int]$Process.Id)
                $script:Running = @($script:Running | Where-Object { [int]$_.Id -ne [int]$Process.Id })
                $script:ModeRecords = @()
            } `
            -SleepProvider { param($Milliseconds) }
        Assert-True $result.Closed
        Assert-True $result.Escalated
        Assert-True $result.VerifiedStopped
        Assert-equal @("stop:4201") $script:Events
    }

    Test-Case "Close Codex refuses ambiguous multi-main ownership" {
        $path = "C:\Program Files\Codex\Codex.exe"
        Assert-Throws {
            Invoke-HeiGeCloseCodexFlow -Root $script:InstallRoot `
                -ContextProvider { New-TestEntrypointContext } `
                -ProcessProvider {
                    param($Context)
                    @(
                        (New-TestCodexProcess -Id 4301 -ParentProcessId 1 -Path $path),
                        (New-TestCodexProcess -Id 4302 -ParentProcessId 1 -Path $path)
                    )
                } `
                -StopCodexProvider {
                    param($Context)
                    throw "should not stop ambiguous ownership"
                }
        } "归属不唯一"
    }

    Test-Case "Close Codex ignores foreign and internal backend processes" {
        $backend = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin\unit-test-close\codex.exe"
        if (-not $env:LOCALAPPDATA) { throw "LOCALAPPDATA required" }
        New-Item -ItemType Directory -Path (Split-Path $backend -Parent) -Force | Out-Null
        New-Item -ItemType File -Path $backend -Force | Out-Null
        try {
            $context = New-TestEntrypointContext
            $context.App = [pscustomobject]@{
                Kind = "StoreAumid"
                ExecutablePath = $null
                InstallPath = "C:\Program Files\WindowsApps\OpenAI.Codex_1.0.0.0_x64__2p2nqsd0c76g0"
                ProductName = "Codex"
                PackageFullName = "OpenAI.Codex_1.0.0.0_x64__2p2nqsd0c76g0"
                Aumid = "OpenAI.Codex_2p2nqsd0c76g0!App"
            }
            $mode = Get-HeiGeEntrypointProcessMode -Context $context -ProcessProvider {
                param($Context)
                @(
                    [pscustomobject]@{
                        ProcessId = 4401
                        ParentProcessId = 1
                        ExecutablePath = $backend
                        Name = "codex.exe"
                    }
                )
            }
            Assert-equal "closed" $mode
            Assert-Throws {
                Get-HeiGeEntrypointProcessMode -Context $context -ProcessProvider {
                    param($Context)
                    @(
                        [pscustomobject]@{
                            ProcessId = 4402
                            ParentProcessId = 1
                            ExecutablePath = "C:\Foreign\ChatGPT.exe"
                            Name = "ChatGPT.exe"
                        }
                    )
                }
            } "不属于已绑定"
        } finally {
            Remove-Item -LiteralPath (Split-Path $backend -Parent) -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    Test-Case "Close Codex flow source contract forbids relaunch and taskkill" {
        $flow = [System.IO.File]::ReadAllText(
            (Join-Path $script:RepositoryRoot "scripts\windows\lib\entrypoints.ps1")
        )
        $match = [regex]::Match(
            $flow,
            'function Invoke-HeiGeCloseCodexFlow[\s\S]*?(?=\r?\nfunction )'
        )
        Assert-True $match.Success
        $body = $match.Value
        Assert-Match 'Stop-CodexNormally' $body
        Assert-False ($body -match 'Start-Codex')
        Assert-False ($body -match 'Restart-Codex')
        Assert-False ($body -match 'taskkill')
        Assert-False ($body -match 'set-persistence')
        $wrapper = [System.IO.File]::ReadAllText(
            (Join-Path $script:RepositoryRoot "scripts\windows\close-codex.ps1")
        )
        Assert-Match 'Invoke-HeiGeCloseCodexFlow' $wrapper
        Assert-Match '本来就未运行' $wrapper
        Assert-Match '保持关闭' $wrapper
        $abort = Resolve-HeiGeBootstrapAbortClass -Doctor ([pscustomobject]@{
            diagnosis = "flag-present-port-closed：进程已带调试参数但端口未开放"
        })
        Assert-equal "abort-incompatible" $abort.Class
        Assert-Match 'close-codex\.bat' $abort.Guidance
    }

    Test-Case "Restart into CDP verifies identity then stops and starts with CDP" {
        $path = "C:\Program Files\Codex\Codex.exe"
        $startedAt = [datetime]::Parse("2026-07-19T09:00:00Z").ToUniversalTime().ToString("o")
        $script:Running = @([pscustomobject]@{
            Id = 7070
            Path = $path
            ProcessName = "Codex"
            MainWindowHandle = [IntPtr]::Zero
            StartTime = [datetime]::Parse("2026-07-19T09:00:00Z")
        })
        $script:Events = @()
        $app = (New-TestEntrypointContext).App
        $result = Invoke-HeiGeRestartCodexIntoCdp `
            -Port 9341 `
            -ExpectedPid 7070 `
            -ExpectedExecutablePath $path `
            -ExpectedStartedAt $startedAt `
            -AppInfo $app `
            -ProcessProvider { @($script:Running) } `
            -CloseProvider {
                param($Process)
                $script:Events += ("close:" + [int]$Process.Id)
            } `
            -StopProvider {
                param($Process)
                $script:Events += ("stop:" + [int]$Process.Id)
                $script:Running = @()
            } `
            -SleepProvider { param($Milliseconds) } `
            -StartCdpProvider {
                param($AppInfo, $Port)
                $script:Events += ("start-cdp:" + $Port)
            }
        Assert-True $result.Restarted
        Assert-True $result.CdpMode
        Assert-equal 9341 $result.Port
        Assert-True ($script:Events -contains "stop:7070" -or $script:Events -contains "close:7070")
        Assert-True ($script:Events -contains "start-cdp:9341")
        Assert-Throws {
            Invoke-HeiGeRestartCodexIntoCdp `
                -Port 9341 `
                -ExpectedPid 7070 `
                -ExpectedExecutablePath $path `
                -ExpectedStartedAt $startedAt `
                -AppInfo $app `
                -ProcessProvider { @() } `
                -StartCdpProvider { param($AppInfo, $Port) throw "should not start" }
        } "已不存在"
        $restartScript = [System.IO.File]::ReadAllText(
            (Join-Path $script:RepositoryRoot "scripts\windows\lib\restart-into-cdp.ps1")
        )
        Assert-Match 'Invoke-HeiGeRestartCodexIntoCdp' $restartScript
        Assert-Match 'HEIGE_WINDOWS_APP_IDENTITY' $restartScript
        $cli = [System.IO.File]::ReadAllText(
            (Join-Path $script:RepositoryRoot "src\cli.mjs")
        )
        Assert-Match 'probeWindowsNativeProcess' $cli
        Assert-Match 'spawnWindowsRestartIntoCdp' $cli
        Assert-Match 'platform === "win32"' $cli
    }

    Test-Case "Uninstall cleans task shortcut state and install tree even when soft disable fails" {
        $uninstallRoot = Join-Path $script:Root ("heige-codex-skin-studio-" + [guid]::NewGuid().ToString("N"))
        $installTree = Join-Path $uninstallRoot "heige-codex-skin-studio"
        $scriptTree = Join-Path $uninstallRoot "source-checkout"
        New-Item -ItemType Directory -Path (Join-Path $installTree "src") -Force | Out-Null
        New-TestOwnedInstallMarker -InstallRoot $installTree
        Set-Content -LiteralPath (Join-Path $installTree "src\cli.mjs") -Value "export {}" -Encoding UTF8
        $script:Events = @()
        $result = Invoke-HeiGeUninstallFlow `
            -InstallRoot $installTree `
            -ScriptTreeRoot $scriptTree `
            -Port 9341 `
            -SoftDisableProvider {
                param($Root, $Port)
                $script:Events += "soft-disable"
                throw "cli broken"
            } `
            -UnregisterProvider {
                param($Root, $TaskName, $StateDirectory)
                $script:Events += "unregister:$TaskName"
                [pscustomobject]@{ VerifiedAbsent = $true; Removed = $true }
            } `
            -ShortcutProvider {
                param($Root, $StartMenuRoot)
                $script:Events += "shortcut"
                [pscustomobject]@{
                    PriorExisted = $true
                    Removed = $true
                    VerifiedAbsent = $true
                    FolderRemoved = $true
                }
            } `
            -ResidueProvider {
                param($Root)
                $script:Events += "residue"
                [pscustomobject]@{ StoppedProcessIds = @(42) }
            } `
            -StateRemoveProvider {
                param($StateDirectory)
                $script:Events += "state"
                [pscustomobject]@{
                    Path = "state"
                    PriorExisted = $true
                    Removed = $true
                    VerifiedAbsent = $true
                }
            } `
            -InstallRemoveProvider {
                param($Root, $CallerScriptPath)
                $script:Events += "install-tree"
                [pscustomobject]@{
                    Path = $Root
                    PriorExisted = $true
                    Removed = $true
                    Deferred = $false
                    VerifiedAbsent = $true
                }
            }
        Assert-Equal @(
            "soft-disable", "unregister:HeiGe Codex Skin Studio Controller",
            "shortcut", "residue", "state", "install-tree"
        ) $script:Events
        Assert-True $result.SoftDisableAttempted
        Assert-False $result.SoftDisableSucceeded
        Assert-True $result.TaskUnregistered
        Assert-equal "complete" $result.Completion
    }

    Test-Case "Uninstall still cleans orphans when the install tree is already gone" {
        $missingInstall = Join-Path $script:Root ("missing\heige-codex-skin-studio")
        $scriptTree = Join-Path $script:Root "source-checkout-orphan"
        $script:Events = @()
        $result = Invoke-HeiGeUninstallFlow `
            -InstallRoot $missingInstall `
            -ScriptTreeRoot $scriptTree `
            -Port 9341 `
            -SoftDisableProvider { param($Root, $Port) throw "must not soft-disable missing install" } `
            -UnregisterProvider {
                param($Root, $TaskName, $StateDirectory)
                $script:Events += "unregister"
                [pscustomobject]@{ VerifiedAbsent = $true }
            } `
            -ShortcutProvider {
                param($Root, $StartMenuRoot)
                $script:Events += "shortcut"
                [pscustomobject]@{
                    PriorExisted = $false
                    Removed = $false
                    VerifiedAbsent = $true
                    FolderRemoved = $false
                }
            } `
            -ResidueProvider {
                param($Root)
                $script:Events += "residue"
                [pscustomobject]@{ StoppedProcessIds = @() }
            } `
            -StateRemoveProvider {
                param($StateDirectory)
                $script:Events += "state"
                [pscustomobject]@{
                    Path = "state"
                    PriorExisted = $true
                    Removed = $true
                    VerifiedAbsent = $true
                }
            } `
            -InstallRemoveProvider {
                param($Root, $CallerScriptPath)
                $script:Events += "install-tree"
                [pscustomobject]@{
                    Path = $Root
                    PriorExisted = $false
                    Removed = $false
                    Deferred = $false
                    VerifiedAbsent = $true
                }
            }
        Assert-equal @("unregister", "shortcut", "residue", "state", "install-tree") $script:Events
        Assert-False $result.SoftDisableAttempted
        Assert-True $result.TaskUnregistered
    }

    Test-Case "Uninstall refuses to delete a non-standard install directory name" {
        Assert-Throws {
            Invoke-HeiGeUninstallFlow `
                -InstallRoot (Join-Path $script:Root "not-heige") `
                -ScriptTreeRoot (Join-Path $script:Root "source") `
                -UnregisterProvider { param($a, $b, $c) [pscustomobject]@{ VerifiedAbsent = $true } }
        } "heige-codex-skin-studio"
    }

    Test-Case "Uninstall recognizes an owned custom install and rejects an unowned one" {
        $ownedParent = Join-Path $script:Root ("owned-custom-" + [guid]::NewGuid().ToString("N"))
        $ownedInstall = Join-Path $ownedParent "heige-codex-skin-studio"
        New-TestOwnedInstallMarker -InstallRoot $ownedInstall
        $resolved = Resolve-HeiGeUninstallInstallRoot `
            -ScriptTreeRoot $ownedInstall
        Assert-Equal $ownedInstall $resolved
        Assert-Equal $ownedInstall (Assert-HeiGeRemovableInstallRoot -InstallRoot $ownedInstall)

        $unownedParent = Join-Path $script:Root ("unowned-custom-" + [guid]::NewGuid().ToString("N"))
        $unownedInstall = Join-Path $unownedParent "heige-codex-skin-studio"
        New-Item -ItemType Directory -Path $unownedInstall -Force | Out-Null
        Assert-Throws {
            Assert-HeiGeRemovableInstallRoot -InstallRoot $unownedInstall
        } "ownership marker"
    }

    Test-Case "Uninstall stops only processes carrying the exact install paths" {
        $installTree = Join-Path $script:Root ("process-owner\heige-codex-skin-studio")
        $exactCli = Join-Path $installTree "src\cli.mjs"
        $script:StoppedIds = @()
        $result = Stop-HeiGeControllerResidue `
            -InstallRoot $installTree `
            -ProcessProvider {
                @(
                    [pscustomobject]@{
                        ProcessId = 41001
                        CommandLine = "node other-cli.mjs controller --background --platform windows"
                    },
                    [pscustomobject]@{
                        ProcessId = 41002
                        CommandLine = "node `"$exactCli`" controller --background --platform windows"
                    }
                )
            } `
            -StopProvider { param($Process) $script:StoppedIds += [int]$Process.ProcessId }
        Assert-Equal @(41002) $script:StoppedIds
        Assert-Equal @(41002) $result.StoppedProcessIds
    }

    Test-Case "Uninstall removes a real isolated install tree immediately from outside it" {
        $parent = Join-Path $script:Root ("real-remove-" + [guid]::NewGuid().ToString("N"))
        $installTree = Join-Path $parent "heige-codex-skin-studio"
        $nestedFile = Join-Path $installTree "src\nested\payload.txt"
        New-Item -ItemType Directory -Path (Split-Path $nestedFile -Parent) -Force | Out-Null
        New-TestOwnedInstallMarker -InstallRoot $installTree
        Set-Content -LiteralPath $nestedFile -Value "remove me" -Encoding UTF8

        $result = Remove-HeiGeInstallTreeForUninstall `
            -InstallRoot $installTree `
            -CallerScriptPath (Join-Path $script:Root "outside\uninstall.ps1")

        Assert-True $result.PriorExisted
        Assert-True $result.Removed
        Assert-False $result.Deferred
        Assert-True $result.VerifiedAbsent
        Assert-False (Test-Path -LiteralPath $installTree)
    }

    Test-Case "Uninstall defers self-removal when launched from the install tree" {
        $parent = Join-Path $script:Root ("deferred-remove-" + [guid]::NewGuid().ToString("N"))
        $installTree = Join-Path $parent "heige-codex-skin-studio"
        $caller = Join-Path $installTree "scripts\windows\uninstall.ps1"
        New-Item -ItemType Directory -Path (Split-Path $caller -Parent) -Force | Out-Null
        New-TestOwnedInstallMarker -InstallRoot $installTree
        New-Item -ItemType File -Path $caller -Force | Out-Null
        $script:DeferredRoot = $null

        $result = Remove-HeiGeInstallTreeForUninstall `
            -InstallRoot $installTree `
            -CallerScriptPath $caller `
            -DeferProvider { param($Root) $script:DeferredRoot = $Root }

        Assert-True $result.PriorExisted
        Assert-False $result.Removed
        Assert-True $result.Deferred
        Assert-False $result.VerifiedAbsent
        Assert-Equal $installTree $script:DeferredRoot
        Assert-True (Test-Path -LiteralPath $installTree -PathType Container)
        Remove-Item -LiteralPath $installTree -Recurse -Force
    }

    Test-Case "Uninstall wrapper and controller self-heal missing install trees" {
        $uninstall = [System.IO.File]::ReadAllText(
            (Join-Path $script:RepositoryRoot "scripts\windows\uninstall.ps1")
        )
        $controller = [System.IO.File]::ReadAllText(
            (Join-Path $script:RepositoryRoot "scripts\windows\controller.ps1")
        )
        $flow = [System.IO.File]::ReadAllText(
            (Join-Path $script:RepositoryRoot "scripts\windows\lib\entrypoints.ps1")
        )
        Assert-Match 'Invoke-HeiGeUninstallFlow' $uninstall
        Assert-Match 'Invoke-HeiGeUninstallFlow' $flow
        Assert-Match 'Stop-HeiGeControllerResidue' $flow
        Assert-Match '安装目录缺失' $controller
        Assert-Match 'exit 0' $controller
    }

    Test-Case "BAT wrappers preserve the captured PowerShell failure code" {
        foreach ($name in @(
            "apply.bat", "customize.bat", "close-codex.bat", "enable-skin.bat", "install.bat", "pause.bat", "resume.bat", "restore.bat", "uninstall.bat"
        )) {
            $source = [System.IO.File]::ReadAllText(
                (Join-Path $script:RepositoryRoot ("scripts\windows\" + $name))
            )
            Assert-Match 'set "HEIGE_EXIT=%ERRORLEVEL%"' $source
            Assert-Match 'if not "%HEIGE_EXIT%"=="0"' $source
            Assert-Match 'pause' $source
            Assert-Match 'HEIGE_NO_PAUSE' $source
            Assert-Match 'exit /b %HEIGE_EXIT%' $source
            # cmd.exe mis-decodes UTF-8 CJK; keep bat ASCII-only.
            Assert-False ([regex]::IsMatch($source, '[\u4e00-\u9fff]'))
        }
        $batExit = [System.IO.File]::ReadAllText(
            (Join-Path $script:RepositoryRoot "scripts\windows\lib\bat-exit.ps1")
        )
        Assert-Match 'Write-HeiGeInteractivePauseHint' $batExit
        Assert-Match '任务栏' $batExit
        Assert-Match 'HEIGE_PAUSE_HINT_STYLE' $batExit
        Assert-Match 'HEIGE_PAUSE_HINT_STYLE -eq "close"' $batExit
        $uninstallBat = [System.IO.File]::ReadAllText(
            (Join-Path $script:RepositoryRoot "scripts\windows\uninstall.bat")
        )
        Assert-Match 'HEIGE_PAUSE_HINT_STYLE=uninstall' $uninstallBat
        $closeBat = [System.IO.File]::ReadAllText(
            (Join-Path $script:RepositoryRoot "scripts\windows\close-codex.bat")
        )
        Assert-Match 'HEIGE_PAUSE_HINT_STYLE=close' $closeBat
    }

    Test-Case "PowerShell entrypoints retain BOM and BAT wrappers retain CRLF" {
        foreach ($name in @(
            "apply.ps1", "close-codex.ps1", "customize.ps1", "enable-skin.ps1", "pause.ps1", "resume.ps1", "restore.ps1", "uninstall.ps1"
        )) {
            $bytes = [System.IO.File]::ReadAllBytes(
                (Join-Path $script:RepositoryRoot ("scripts\windows\" + $name))
            )
            Assert-equal @(0xef, 0xbb, 0xbf) @($bytes[0], $bytes[1], $bytes[2])
        }
        foreach ($name in @(
            "apply.bat", "close-codex.bat", "customize.bat", "enable-skin.bat", "install.bat", "pause.bat", "resume.bat", "restore.bat", "uninstall.bat"
        )) {
            $text = [System.IO.File]::ReadAllText(
                (Join-Path $script:RepositoryRoot ("scripts\windows\" + $name))
            )
            Assert-False ($text -match '(?<!\r)\n')
        }
    }

    Test-Case "Packaged Skill routes macOS and Windows to platform-specific installers" {
        $skill = [System.IO.File]::ReadAllText($script:SkillInstructions)
        $readme = [System.IO.File]::ReadAllText($script:SkillReadme)
        foreach ($text in @($skill, $readme)) {
            Assert-Match 'macOS' $text
            Assert-Match 'Windows' $text
            Assert-Match 'install\.command' $text
            Assert-Match 'install\.ps1' $text
            Assert-Match 'install\.bat' $text
            Assert-Match '正常重启' $text
            Assert-Match 'status[^\r\n]*只读|只读[^\r\n]*status' $text
            Assert-Match 'HeiGe 皮肤启动器' $text
            Assert-Match 'uninstall\.(ps1|bat)' $text
            Assert-Match 'close-codex\.(ps1|bat)' $text
            Assert-Match '计划任务' $text
        }
    }

    Test-Case "Packaged Skill keeps only the non-actionable legacy persistence notice" {
        $combined = [System.IO.File]::ReadAllText($script:SkillInstructions) + "`n" +
            [System.IO.File]::ReadAllText($script:SkillReadme)
        $deprecatedNotice = 'enable-persist\.command`?\s*是(?:已)?(?:弃用|废弃)的非零退出入口'
        Assert-Match $deprecatedNotice $combined
        $withoutDeprecatedNotice = [regex]::Replace($combined, $deprecatedNotice, '')
        Assert-False ($withoutDeprecatedNotice -match 'enable-persist|disable-persist|10\s*分钟冷却|看门狗')
        Assert-False ($combined -match '当前只支持\s*macOS|不处理\s*Windows')
        Assert-False ($combined -match '重启即成功|重启后绝对不要重试')
    }

    Test-Case "Skill documents automated Windows evidence separately from Store validation" {
        $skill = [System.IO.File]::ReadAllText($script:SkillInstructions)
        Assert-Match 'Windows PowerShell 5\.1' $skill
        Assert-Match 'PowerShell 7' $skill
        Assert-Match 'Microsoft Store 真机待验证' $skill
        Assert-Match 'GUID' $skill
    }

    Test-Case "Packaged Skill retains preset and custom-image capabilities" {
        $skill = [System.IO.File]::ReadAllText($script:SkillInstructions)
        foreach ($theme in @(
            "miku-488137", "genshin-dawn", "genshin-night", "wuthering-tide",
            "wuthering-echo", "naruto-hokage", "naruto-sasuke", "deepspace-dawn",
            "deepspace-star", "dalao-dianyan"
        )) {
            Assert-Match ([regex]::Escape($theme)) $skill
        }
        Assert-Match '自定义图片' $skill
        Assert-Match '覆盖' $skill
        Assert-Match '删除' $skill
        Assert-Match '正式主题' $skill
    }

    Test-Case "Skill routes create results to real macOS and Windows apply parameters" {
        $skill = [System.IO.File]::ReadAllText($script:SkillInstructions)
        Assert-Match 'create --image' $skill
        Assert-Match '返回[^\r\n]*`id`' $skill
        Assert-Match 'apply\.command[^\r\n]*\$id' $skill
        Assert-Match 'apply\.ps1[^\r\n]*-Theme[^\r\n]*\$id[^\r\n]*-Port 9341' $skill
    }

    Test-Case "Skill keeps pet installation explicit and lifecycle intents distinct" {
        $skill = [System.IO.File]::ReadAllText($script:SkillInstructions)
        Assert-Match '仅当用户明确要求[^\r\n]*Miku Future' $skill
        Assert-Match 'install-pet' $skill
        Assert-Match '`pause`[^\r\n]*当前会话' $skill
        Assert-Match '`resume`[^\r\n]*同一[^\r\n]*进程' $skill
        Assert-Match '`restore`[^\r\n]*关闭常驻' $skill
        Assert-Match '`close-codex`[^\r\n]*保持关闭' $skill
        Assert-Match '明确允许关闭' $skill
        Assert-Match '不要关闭 Codex' $skill
    }

    Test-Case "Windows Skill installer forwards only to the packaged Windows payload" {
        Assert-True (Test-Path -LiteralPath $script:SkillInstallPs1 -PathType Leaf)
        $source = [System.IO.File]::ReadAllText($script:SkillInstallPs1)
        Assert-False ($source -match '/Applications|/usr/bin/open|osascript|launchctl')
        Assert-Match 'payload' $source
        Assert-Match 'scripts\\windows\\install\.ps1' $source
        Assert-Match '\[string\]\$InstallRoot' $source
        Assert-Match '\[string\]\$StartMenuRoot' $source
        Assert-Match '\[switch\]\$SkipApply' $source
        Assert-Match '@PSBoundParameters' $source
    }

    Test-Case "Packaged Windows installers retain Windows-compatible encoding and exit status" {
        $psBytes = [System.IO.File]::ReadAllBytes($script:SkillInstallPs1)
        Assert-Equal @(0xef, 0xbb, 0xbf) @($psBytes[0], $psBytes[1], $psBytes[2])
        $bat = [System.IO.File]::ReadAllText($script:SkillInstallBat)
        Assert-False ($bat -match '(?<!\r)\n')
        Assert-Match 'set "HEIGE_EXIT=%ERRORLEVEL%"' $bat
        Assert-Match 'exit /b %HEIGE_EXIT%' $bat
    }

    Test-Case "Wait-HeiGeCodexMainRenderer nudges the window until the main renderer appears" {
        $context = New-TestEntrypointContext
        $sleeps = New-Object System.Collections.Generic.List[int]
        $shows = New-Object System.Collections.Generic.List[object]
        $state = [pscustomobject]@{ Checks = 0 }
        $result = Wait-HeiGeCodexMainRenderer -Port 9341 -AppInfo $context.App -TimeoutSeconds 5 `
            -MainRendererProvider {
                param($Port)
                Assert-Equal 9341 $Port
                $state.Checks += 1
                return ($state.Checks -ge 3)
            } `
            -ShowWindowProvider {
                param($Info)
                $shows.Add($Info) | Out-Null
                return $true
            } `
            -SleepProvider {
                param($Milliseconds)
                $sleeps.Add([int]$Milliseconds) | Out-Null
            }
        Assert-True $result.Ready
        Assert-equal 3 $result.Attempts
        Assert-True ($shows.Count -ge 1)
        Assert-True ($sleeps.Count -ge 2)
        Assert-True (@($sleeps | Where-Object { $_ -eq 250 }).Count -ge 1)
    }
} finally {
    Remove-Item -LiteralPath $script:Root -Recurse -Force -ErrorAction SilentlyContinue
}

Complete-TestRun
