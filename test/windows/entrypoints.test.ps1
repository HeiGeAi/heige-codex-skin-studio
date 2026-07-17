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
$script:ApplyBat = Join-Path $script:InstallRoot "scripts\windows\apply.bat"
$script:EnableBat = Join-Path $script:InstallRoot "scripts\windows\enable-skin.bat"
$script:SkillRoot = Join-Path $script:RepositoryRoot "skill\heige-codex-skin-studio"
$script:SkillInstallPs1 = Join-Path $script:SkillRoot "scripts\install.ps1"
$script:SkillInstallBat = Join-Path $script:SkillRoot "scripts\install.bat"
$script:SkillInstructions = Join-Path $script:SkillRoot "SKILL.md"
$script:SkillReadme = Join-Path $script:SkillRoot "README.md"
foreach ($path in @(
    $script:FakeNode, $script:FakeCli, $script:FakeController,
    $script:ApplyBat, $script:EnableBat
)) {
    New-Item -ItemType Directory -Path (Split-Path $path -Parent) -Force | Out-Null
    New-Item -ItemType File -Path $path -Force | Out-Null
}
New-Item -ItemType Directory -Path $script:StateRoot -Force | Out-Null

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

    Test-Case "Start Menu launcher targets session-only apply BAT" {
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
        Assert-Equal $script:ApplyBat $script:ShortcutTarget
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
                $script:ApplyBat
            }
            New-TestShortcutObservation -TargetPath $target `
                -WorkingDirectory (Split-Path $target -Parent)
        }
        $result = Install-HeiGeStartMenuShortcut -InstallRoot $script:InstallRoot `
            -StartMenuRoot $migrationRoot `
            -CreateShortcutProvider {
                param($Path, $Target, $WorkingDirectory, $Description)
                Assert-Equal $script:ApplyBat $Target
                [System.IO.File]::WriteAllText($Path, "session launcher")
            } `
            -ReadShortcutProvider $readProvider
        Assert-True $result.Verified
        Assert-Equal "session launcher" ([System.IO.File]::ReadAllText($shortcutPath))
    }

    Test-Case "WScript no-icon serialization normalizes without hiding a custom icon" {
        Assert-Equal "" (ConvertFrom-HeiGeWshIconLocation -IconLocation "")
        Assert-Equal "" (ConvertFrom-HeiGeWshIconLocation -IconLocation ", 0")
        Assert-Equal "" (ConvertFrom-HeiGeWshIconLocation -IconLocation "  ,0  ")
        Assert-Equal "C:\Windows\custom.ico, 0" `
            (ConvertFrom-HeiGeWshIconLocation -IconLocation "C:\Windows\custom.ico, 0")
        Assert-Equal ", 1" (ConvertFrom-HeiGeWshIconLocation -IconLocation ", 1")
    }

    Test-Case "Default WScript shortcut round-trips the complete generated schema" {
        $shortcutPath = Join-Path $script:Root "WScript Schema\HeiGe 皮肤启动器.lnk"
        New-Item -ItemType Directory -Path (Split-Path $shortcutPath -Parent) -Force | Out-Null
        try {
            New-DefaultHeiGeShortcut -Path $shortcutPath -Target $script:ApplyBat `
                -WorkingDirectory (Split-Path $script:ApplyBat -Parent) `
                -Description $script:ShortcutDescription
        } catch {
            $creationError = $_
            $hresult = "0x{0:X8}" -f $creationError.Exception.HResult
            $matrixRoot = Join-Path $env:RUNNER_TEMP ("heige-wsh-matrix-" + [guid]::NewGuid().ToString("N"))
            $matrixResults = @()
            try {
                $unicodeRoot = Join-Path $matrixRoot "目标目录"
                New-Item -ItemType Directory -Path $unicodeRoot -Force | Out-Null
                $asciiEmpty = Join-Path $matrixRoot "ascii-empty.bat"
                $asciiContent = Join-Path $matrixRoot "ascii-content.bat"
                $unicodeEmpty = Join-Path $unicodeRoot "empty.bat"
                $unicodeContent = Join-Path $unicodeRoot "content.bat"
                New-Item -ItemType File -Path $asciiEmpty, $unicodeEmpty -Force | Out-Null
                [System.IO.File]::WriteAllText($asciiContent, "@echo off`r`nexit /b 0`r`n")
                [System.IO.File]::WriteAllText($unicodeContent, "@echo off`r`nexit /b 0`r`n")
                $cases = [ordered]@{
                    CmdExe = (Join-Path $env:SystemRoot "System32\cmd.exe")
                    AsciiEmpty = $asciiEmpty
                    AsciiContent = $asciiContent
                    UnicodeEmpty = $unicodeEmpty
                    UnicodeContent = $unicodeContent
                }
                foreach ($case in $cases.GetEnumerator()) {
                    try {
                        $matrixShell = New-Object -ComObject WScript.Shell
                        $matrixShortcut = $matrixShell.CreateShortcut(
                            (Join-Path $matrixRoot ($case.Key + ".lnk"))
                        )
                        $matrixShortcut.TargetPath = [string]$case.Value
                        $matrixResults += "$($case.Key)=PASS"
                    } catch {
                        $caseHresult = "0x{0:X8}" -f $_.Exception.HResult
                        $matrixResults += "$($case.Key)=FAIL:$caseHresult"
                    }
                }
            } catch {
                $matrixResults += "MatrixSetup=FAIL:$($_.Exception.GetType().FullName):$($_.Exception.Message)"
            } finally {
                Remove-Item -LiteralPath $matrixRoot -Recurse -Force -ErrorAction SilentlyContinue
            }
            throw "WScript shortcut creation failed：$($creationError.Exception.Message)；HRESULT=$hresult；matrix=$($matrixResults -join ',')`n$($creationError.InvocationInfo.PositionMessage)`n$($creationError.ScriptStackTrace)"
        }
        try {
            $observed = Read-DefaultHeiGeShortcut -Path $shortcutPath
        } catch {
            throw "WScript shortcut inspection failed：$($_.Exception.Message)"
        }
        Assert-Equal $script:ApplyBat $observed.TargetPath
        Assert-Equal (Split-Path $script:ApplyBat -Parent) $observed.WorkingDirectory
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
        $script:TransactionalTarget = $script:ApplyBat
        $script:TransactionalWorking = Split-Path $script:ApplyBat -Parent
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
        $script:TransactionalTarget = $script:ApplyBat
        $script:TransactionalWorking = Split-Path $script:ApplyBat -Parent
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
        $script:TransactionalTarget = $script:ApplyBat
        $script:TransactionalWorking = Split-Path $script:ApplyBat -Parent
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
                    New-TestShortcutObservation -TargetPath $script:ApplyBat `
                        -WorkingDirectory (Split-Path $script:ApplyBat -Parent) `
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
                    New-TestShortcutObservation -TargetPath $script:ApplyBat `
                        -WorkingDirectory (Split-Path $script:ApplyBat -Parent) `
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
        Assert-Equal (Join-Path $futureInstallRoot "scripts\windows\apply.bat") $participant.TargetPath
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
        Assert-False ($source -match '\$shortcut\.(?:Arguments|WindowStyle|Hotkey|IconLocation)\s*=')
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

    Test-Case "BAT wrappers preserve the captured PowerShell failure code" {
        foreach ($name in @(
            "apply.bat", "customize.bat", "enable-skin.bat", "install.bat", "pause.bat", "resume.bat", "restore.bat"
        )) {
            $source = [System.IO.File]::ReadAllText(
                (Join-Path $script:RepositoryRoot ("scripts\windows\" + $name))
            )
            Assert-Match 'set "HEIGE_EXIT=%ERRORLEVEL%"' $source
            Assert-Match 'exit /b %HEIGE_EXIT%' $source
        }
    }

    Test-Case "PowerShell entrypoints retain BOM and BAT wrappers retain CRLF" {
        foreach ($name in @(
            "apply.ps1", "customize.ps1", "enable-skin.ps1", "pause.ps1", "resume.ps1", "restore.ps1"
        )) {
            $bytes = [System.IO.File]::ReadAllBytes(
                (Join-Path $script:RepositoryRoot ("scripts\windows\" + $name))
            )
            Assert-Equal @(0xef, 0xbb, 0xbf) @($bytes[0], $bytes[1], $bytes[2])
        }
        foreach ($name in @(
            "apply.bat", "customize.bat", "enable-skin.bat", "install.bat", "pause.bat", "resume.bat", "restore.bat"
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
} finally {
    Remove-Item -LiteralPath $script:Root -Recurse -Force -ErrorAction SilentlyContinue
}

Complete-TestRun
