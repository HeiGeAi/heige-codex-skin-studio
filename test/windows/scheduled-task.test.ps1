param(
    [switch]$Integration,
    [string]$TaskName
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")
$script:RepositoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
. (Join-Path $script:RepositoryRoot "scripts\windows\lib\common.ps1")
. (Join-Path $script:RepositoryRoot "scripts\windows\lib\scheduled-task.ps1")

$script:ProductionTask = "HeiGe Codex Skin Studio Controller"
$script:TestTask = "HeiGe Codex Skin Studio Test 5f8a771e-4997-4c34-89d8-9e37c9f80211"
$script:Root = Join-Path ([System.IO.Path]::GetTempPath()) ("HeiGe Scheduled Task 中文 " + [guid]::NewGuid().ToString("N"))
$script:Node = Join-Path $script:Root "Node Runtime\node.exe"
$script:Controller = Join-Path $script:Root "Stable Install\scripts\windows\controller.ps1"
$script:State = Join-Path $script:Root "State Directory 中文"
$script:PowerShell = Join-Path $script:Root "Windows PowerShell\powershell.exe"
$script:CodexExe = Join-Path $script:Root "Codex App\Codex.exe"
$script:RequestNonce = "controller-transition-7"
foreach ($path in @($script:Node, $script:Controller, $script:PowerShell, $script:CodexExe)) {
    New-Item -ItemType Directory -Path (Split-Path $path -Parent) -Force | Out-Null
    New-Item -ItemType File -Path $path -Force | Out-Null
}
New-Item -ItemType Directory -Path $script:State -Force | Out-Null
$script:AppIdentityToken = ConvertTo-HeiGeCodexAppIdentityToken -App ([pscustomobject]@{
    Kind = "Win32"
    ExecutablePath = $script:CodexExe
    InstallPath = (Split-Path $script:CodexExe -Parent)
    ProductName = "Codex"
    PackageFullName = $null
    Aumid = $null
})

function New-TestDefinition {
    param([string]$Name = $script:ProductionTask)
    return New-HeiGeTaskDefinition -TaskName $Name -NodePath $script:Node `
        -ControllerPath $script:Controller -StateDirectory $script:State `
        -AppIdentityToken $script:AppIdentityToken `
        -CurrentUserId "TESTDOMAIN\HeiGe User" -PowerShellPath $script:PowerShell -Port 9341
}

function New-TestStoredDefinition {
    param(
        [string]$Name = $script:TestTask,
        [string]$State = "Ready"
    )
    $definition = New-TestDefinition -Name $Name
    $definition | Add-Member -NotePropertyName State -NotePropertyValue $State
    return $definition
}

function Remove-TestStartRequest {
    $path = Get-HeiGeStartRequestPath -StateDirectory $script:State -TaskName $script:TestTask
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
}

try {
    Test-Case "Production task is current user scoped and points to stable controller" {
        $definition = New-TestDefinition
        $expectedRunLevel = Get-HeiGeControllerTaskRunLevel
        Assert-Equal "InteractiveToken" $definition.Principal.LogonType
        Assert-Equal $expectedRunLevel $definition.Principal.RunLevel
        Assert-Equal ($expectedRunLevel -ne "Limited") $definition.RequiresElevation
        Assert-Equal "TESTDOMAIN\HeiGe User" $definition.Principal.UserId
        Assert-Match ([regex]::Escape($script:Controller)) $definition.Action.Arguments
        Assert-Match ([regex]::Escape($script:ProductionTask)) $definition.Action.Arguments
        Assert-Match '\-Action run' $definition.Action.Arguments
        Assert-Match '\-AppIdentityToken' $definition.Action.Arguments
        Assert-Match ([regex]::Escape($script:AppIdentityToken)) $definition.Action.Arguments
        Assert-Match '\-WindowStyle Hidden' $definition.Action.Arguments
    }

    Test-Case "Production task has exact current-user recovery settings" {
        $definition = New-TestDefinition
        Assert-Equal "AtLogOn" $definition.Trigger.Type
        Assert-Equal "TESTDOMAIN\HeiGe User" $definition.Trigger.UserId
        Assert-Equal "IgnoreNew" $definition.Settings.MultipleInstances
        Assert-True $definition.Settings.StartWhenAvailable
        Assert-Equal "PT0S" $definition.Settings.ExecutionTimeLimit
        Assert-Equal $script:State $definition.StateDirectory
        Assert-Equal $script:Node $definition.NodePath
    }

    Test-Case "Long-lived task definition is revision independent" {
        $first = New-TestDefinition -Name $script:TestTask
        $second = New-TestDefinition -Name $script:TestTask
        Assert-Equal ($first | ConvertTo-Json -Depth 12 -Compress) `
            ($second | ConvertTo-Json -Depth 12 -Compress)
        Assert-False ($first.Action.Arguments -match 'HandshakeRevision|HandshakeNonce|handshake-revision|handshake-nonce')
        Assert-False ($first.Action.Arguments -match [regex]::Escape($script:RequestNonce))
    }

    Test-Case "Stored principal rejects InteractiveOrPassword exactly" {
        $expected = New-TestDefinition
        $raw = [pscustomobject]@{
            TaskName = $script:ProductionTask
            TaskPath = "\"
            Actions = @([pscustomobject]@{
                Execute = $expected.Action.Execute
                Arguments = $expected.Action.Arguments
                WorkingDirectory = $expected.Action.WorkingDirectory
            })
            Triggers = @([pscustomobject]@{
                UserId = $expected.Trigger.UserId
                CimClass = [pscustomobject]@{ CimClassName = "MSFT_TaskLogonTrigger" }
            })
            Principal = [pscustomobject]@{
                UserId = $expected.Principal.UserId
                LogonType = "InteractiveOrPassword"
                RunLevel = "Limited"
            }
            Settings = [pscustomobject]@{
                MultipleInstances = "IgnoreNew"
                StartWhenAvailable = $true
                ExecutionTimeLimit = "PT0S"
            }
            State = "Ready"
        }
        $stored = ConvertFrom-DefaultHeiGeScheduledTask -Task $raw
        Assert-Equal "InteractiveOrPassword" $stored.Principal.LogonType
        Assert-Throws {
            Assert-HeiGeStoredTaskDefinition -Expected $expected -Stored $stored
        } "Principal.LogonType"
    }

    Test-Case "Stored task identity comparison preserves strict fallback behavior" {
        Assert-True (Test-HeiGeSameWindowsIdentity -Expected "TESTDOMAIN\HeiGe User" -Stored "testdomain\heige user")
        Assert-False (Test-HeiGeSameWindowsIdentity -Expected "TESTDOMAIN\HeiGe User" -Stored "FOREIGN\HeiGe User")
    }

    Test-Case "Stored action arguments reject case-only drift" {
        $expected = New-TestDefinition
        $stored = New-TestDefinition
        $stored.Action.Arguments = $stored.Action.Arguments.ToUpperInvariant()
        Assert-Throws {
            Assert-HeiGeStoredTaskDefinition -Expected $expected -Stored $stored
        } "Action.Arguments"
    }

    Test-Case "Test mode refuses production and malformed task names" {
        $script:RegisterInvoked = $false
        Assert-Throws {
            Register-HeiGeScheduledTask -TaskName $script:ProductionTask -NodePath $script:Node `
                -ControllerPath $script:Controller -StateDirectory $script:State -TestMode `
                -AppIdentityToken $script:AppIdentityToken `
                -CurrentUserId "TESTDOMAIN\HeiGe User" -PowerShellPath $script:PowerShell `
                -RegisterProvider { param($Definition) $script:RegisterInvoked = $true }
        } "production task"
        Assert-False $script:RegisterInvoked
        Assert-Throws {
            Assert-HeiGeTaskScope -TaskName "heige Codex Skin Studio Controller"
        } "精确生产名"
        Assert-Throws {
            Assert-HeiGeTaskScope `
                -TaskName "heige Codex Skin Studio Test 5f8a771e-4997-4c34-89d8-9e37c9f80211" `
                -TestMode
        } "精确生产名"
        Assert-Throws {
            Register-HeiGeScheduledTask -TaskName "HeiGe Codex Skin Studio Test not-a-guid" `
                -NodePath $script:Node -ControllerPath $script:Controller -StateDirectory $script:State `
                -AppIdentityToken $script:AppIdentityToken `
                -TestMode -CurrentUserId "TESTDOMAIN\HeiGe User" -PowerShellPath $script:PowerShell
        } "GUID"
    }

    Test-Case "Production registration cannot inject identity or state directory" {
        Assert-Throws {
            Register-HeiGeScheduledTask -TaskName $script:ProductionTask -NodePath $script:Node `
                -ControllerPath $script:Controller -StateDirectory $script:State `
                -AppIdentityToken $script:AppIdentityToken `
                -CurrentUserId "FOREIGN\User" -PowerShellPath $script:PowerShell `
                -RegisterProvider { param($Definition) throw "must not register" }
        } "current user identity cannot be injected"
        Assert-Throws {
            Register-HeiGeScheduledTask -TaskName $script:ProductionTask -NodePath $script:Node `
                -ControllerPath $script:Controller -StateDirectory $script:State `
                -AppIdentityToken $script:AppIdentityToken `
                -PowerShellPath $script:PowerShell `
                -RegisterProvider { param($Definition) throw "must not register" }
        } "default state directory"
    }

    Test-Case "State directory scope rejects missing production and filesystem roots" {
        Assert-Throws {
            Get-HeiGeScheduledTaskStatus -TaskName $script:TestTask -TestMode `
                -InspectProvider { param($Name) $null }
        } "isolated state directory"
        Assert-Throws {
            Get-HeiGeScheduledTaskStatus -TaskName $script:TestTask `
                -StateDirectory (Get-HeiGeDefaultStateDirectory) -TestMode `
                -InspectProvider { param($Name) $null }
        } "production state directory"
        Assert-Throws {
            Resolve-HeiGeScopedStateDirectory `
                -StateDirectory ([System.IO.Path]::GetPathRoot($script:State)) -TestMode
        } "文件系统根目录"
    }

    Test-Case "Registration re-reads and verifies the stored definition" {
        $script:StoredDefinition = $null
        $result = Register-HeiGeScheduledTask -TaskName $script:TestTask -NodePath $script:Node `
            -ControllerPath $script:Controller -StateDirectory $script:State -TestMode `
            -AppIdentityToken $script:AppIdentityToken `
            -CurrentUserId "TESTDOMAIN\HeiGe User" -PowerShellPath $script:PowerShell `
            -RegisterProvider { param($Definition) $script:StoredDefinition = $Definition } `
            -InspectProvider { param($Name) $script:StoredDefinition } `
            -UnregisterProvider { param($Name) $script:StoredDefinition = $null }
        Assert-True $result.Registered
        Assert-True $result.Verified
        Assert-False $result.ControllerReady
        Assert-Equal $script:TestTask $script:StoredDefinition.TaskName
        Assert-False ($script:StoredDefinition.Action.Arguments -match 'HandshakeRevision|HandshakeNonce')
    }

    Test-Case "Registration rolls back a stored definition that fails verification" {
        $script:BadStoredDefinition = New-TestDefinition -Name $script:TestTask
        $script:BadStoredDefinition.Action.Arguments = "-File C:\foreign.ps1"
        $script:RollbackInvoked = $false
        Assert-Throws {
            Register-HeiGeScheduledTask -TaskName $script:TestTask -NodePath $script:Node `
                -ControllerPath $script:Controller -StateDirectory $script:State -TestMode `
                -AppIdentityToken $script:AppIdentityToken `
                -CurrentUserId "TESTDOMAIN\HeiGe User" -PowerShellPath $script:PowerShell `
                -RegisterProvider { param($Definition) } `
                -InspectProvider { param($Name) $script:BadStoredDefinition } `
                -UnregisterProvider {
                    param($Name)
                    $script:RollbackInvoked = $true
                    $script:BadStoredDefinition = $null
                }
        } "stored task definition"
        Assert-True $script:RollbackInvoked
        Assert-Equal $null $script:BadStoredDefinition
    }

    Test-Case "Registration reports rollback failure when the bad task remains" {
        $script:BadStoredDefinition = New-TestDefinition -Name $script:TestTask
        $script:BadStoredDefinition.Action.Arguments = "-File C:\foreign.ps1"
        Assert-Throws {
            Register-HeiGeScheduledTask -TaskName $script:TestTask -NodePath $script:Node `
                -ControllerPath $script:Controller -StateDirectory $script:State -TestMode `
                -AppIdentityToken $script:AppIdentityToken `
                -CurrentUserId "TESTDOMAIN\HeiGe User" -PowerShellPath $script:PowerShell `
                -RegisterProvider { param($Definition) } `
                -InspectProvider { param($Name) $script:BadStoredDefinition } `
                -UnregisterProvider { param($Name) }
        } "rollback failed"
    }

    Test-Case "Task status reports scheduler facts but never claims controller readiness" {
        $ready = New-TestStoredDefinition -State "Ready"
        $readyStatus = Get-HeiGeScheduledTaskStatus -TaskName $script:TestTask `
            -StateDirectory $script:State -TestMode -InspectProvider { param($Name) $ready }
        Assert-True $readyStatus.Exists
        Assert-True $readyStatus.Registered
        Assert-False $readyStatus.TaskRunning
        Assert-False $readyStatus.ControllerReady
        Assert-Equal $null $readyStatus.ControllerRevision

        $running = New-TestStoredDefinition -State "Running"
        $runningStatus = Get-HeiGeScheduledTaskStatus -TaskName $script:TestTask `
            -StateDirectory $script:State -TestMode -InspectProvider { param($Name) $running }
        Assert-True $runningStatus.TaskRunning
        Assert-False $runningStatus.ControllerReady

        $absentStatus = Get-HeiGeScheduledTaskStatus -TaskName $script:TestTask `
            -StateDirectory $script:State -TestMode -InspectProvider { param($Name) $null }
        Assert-False $absentStatus.Exists
        Assert-Equal "Absent" $absentStatus.State
    }

    Test-Case "Start request helper accepts only a small regular file" {
        Remove-TestStartRequest
        $requestPath = Get-HeiGeStartRequestPath -StateDirectory $script:State -TaskName $script:TestTask
        Assert-False (Test-HeiGeSafeStartRequestFile -Path $requestPath)
        [System.IO.File]::WriteAllText($requestPath, '{"schemaVersion":1}')
        Assert-True (Test-HeiGeSafeStartRequestFile -Path $requestPath)
        [System.IO.File]::WriteAllText($requestPath, "")
        Assert-Throws { Test-HeiGeSafeStartRequestFile -Path $requestPath } "unsafe"
        Remove-TestStartRequest
    }

    Test-Case "Start validates request revision and nonce before task access" {
        Assert-Throws {
            Start-HeiGeScheduledTask -TaskName $script:TestTask -ExpectedRevision 9007199254740992 `
                -ExpectedTransitionNonce $script:RequestNonce -StateDirectory $script:State -TestMode `
                -RequestInspectorProvider { param($Path) throw "must not inspect" }
        } "safe integer"
        Assert-Throws {
            Start-HeiGeScheduledTask -TaskName $script:TestTask -ExpectedRevision 7 `
                -ExpectedTransitionNonce "bad nonce" -StateDirectory $script:State -TestMode `
                -RequestInspectorProvider { param($Path) throw "must not inspect" }
        } "nonce is invalid"
    }

    Test-Case "Start refuses a missing request without touching the task" {
        $script:StartInvoked = $false
        $script:StopInvoked = $false
        Assert-Throws {
            Start-HeiGeScheduledTask -TaskName $script:TestTask -ExpectedRevision 7 `
                -ExpectedTransitionNonce $script:RequestNonce -StateDirectory $script:State -TestMode `
                -RequestInspectorProvider { param($Path) $false } `
                -InspectProvider { param($Name) New-TestStoredDefinition -State "Running" } `
                -StopProvider { param($Name) $script:StopInvoked = $true } `
                -StartProvider { param($Name) $script:StartInvoked = $true }
        } "request is missing"
        Assert-False $script:StopInvoked
        Assert-False $script:StartInvoked
    }

    Test-Case "Start launches a ready task without an unnecessary stop" {
        $script:StartName = $null
        $script:StopInvoked = $false
        $script:OrphanInvoked = $false
        $ready = New-TestStoredDefinition -State "Ready"
        $result = Start-HeiGeScheduledTask -TaskName $script:TestTask -ExpectedRevision 7 `
            -ExpectedTransitionNonce $script:RequestNonce -StateDirectory $script:State -TestMode `
            -RequestInspectorProvider { param($Path) $true } `
            -InspectProvider { param($Name) $ready } `
            -StopProvider { param($Name) $script:StopInvoked = $true } `
            -OrphanStopProvider {
                param($Name, $Directory)
                $script:OrphanInvoked = $true
                Assert-Equal $script:TestTask $Name
            } `
            -StartProvider { param($Name) $script:StartName = $Name }
        Assert-Equal $script:TestTask $script:StartName
        Assert-False $script:StopInvoked
        Assert-True $script:OrphanInvoked
        Assert-False $result.Restarted
        Assert-True $result.RequestObserved
        Assert-False $result.ControllerReady
    }

    Test-Case "Start observes only the canonical fixed request path" {
        Remove-TestStartRequest
        $requestPath = Get-HeiGeStartRequestPath -StateDirectory $script:State -TaskName $script:TestTask
        [System.IO.File]::WriteAllText($requestPath, '{"schemaVersion":1}')
        try {
            $script:StartInvoked = $false
            $ready = New-TestStoredDefinition -State "Ready"
            $result = Start-HeiGeScheduledTask -TaskName $script:TestTask -ExpectedRevision 7 `
                -ExpectedTransitionNonce $script:RequestNonce -StateDirectory $script:State -TestMode `
                -InspectProvider { param($Name) $ready } `
                -StartProvider { param($Name) $script:StartInvoked = $true }
            Assert-True $script:StartInvoked
            Assert-True $result.RequestObserved
            Assert-True (Test-Path -LiteralPath $requestPath -PathType Leaf)
        } finally {
            Remove-TestStartRequest
        }
    }

    Test-Case "Start deterministically restarts an unhealthy running task" {
        $script:OperationOrder = @()
        $script:InspectReads = 0
        $running = New-TestStoredDefinition -State "Running"
        $ready = New-TestStoredDefinition -State "Ready"
        $result = Start-HeiGeScheduledTask -TaskName $script:TestTask -ExpectedRevision 7 `
            -ExpectedTransitionNonce $script:RequestNonce -StateDirectory $script:State -TestMode `
            -RequestInspectorProvider { param($Path) $true } `
            -InspectProvider {
                param($Name)
                $script:InspectReads++
                if ($script:InspectReads -lt 3) { return $running }
                return $ready
            } `
            -StopProvider { param($Name) $script:OperationOrder += "stop" } `
            -OrphanStopProvider { param($Name, $Directory) $script:OperationOrder += "orphan" } `
            -StartProvider { param($Name) $script:OperationOrder += "start" } `
            -SleepProvider { param($Milliseconds) }
        Assert-equal @("stop", "orphan", "start") $script:OperationOrder
        Assert-True $result.Restarted
        Assert-Equal "Running" $result.PreviousState
        Assert-Equal 3 $script:InspectReads
    }

    Test-Case "A running task is never stopped without a start request" {
        $script:StopInvoked = $false
        Assert-Throws {
            Start-HeiGeScheduledTask -TaskName $script:TestTask -ExpectedRevision 7 `
                -ExpectedTransitionNonce $script:RequestNonce -StateDirectory $script:State -TestMode `
                -RequestInspectorProvider { param($Path) $false } `
                -InspectProvider { param($Name) New-TestStoredDefinition -State "Running" } `
                -StopProvider { param($Name) $script:StopInvoked = $true }
        } "request is missing"
        Assert-False $script:StopInvoked
    }

    Test-Case "Start fails closed when a stopped task never settles" {
        $script:StartInvoked = $false
        $script:StopInvoked = $false
        $script:OrphanInvoked = $false
        $running = New-TestStoredDefinition -State "Running"
        Assert-Throws {
            Start-HeiGeScheduledTask -TaskName $script:TestTask -ExpectedRevision 7 `
                -ExpectedTransitionNonce $script:RequestNonce -TimeoutSeconds 1 `
                -StateDirectory $script:State -TestMode `
                -RequestInspectorProvider { param($Path) $true } `
                -InspectProvider { param($Name) $running } `
                -StopProvider { param($Name) $script:StopInvoked = $true } `
                -OrphanStopProvider { param($Name, $Directory) $script:OrphanInvoked = $true } `
                -StartProvider { param($Name) $script:StartInvoked = $true } `
                -SleepProvider { param($Milliseconds) }
        } "did not stop"
        Assert-True $script:StopInvoked
        Assert-False $script:OrphanInvoked
        Assert-False $script:StartInvoked
    }

    Test-Case "Start rejects ambiguous or non-boolean request inspection" {
        foreach ($provider in @(
            { param($Path) $true; $false },
            { param($Path) "true" }
        )) {
            Assert-Throws {
                Start-HeiGeScheduledTask -TaskName $script:TestTask -ExpectedRevision 7 `
                    -ExpectedTransitionNonce $script:RequestNonce -StateDirectory $script:State -TestMode `
                    -RequestInspectorProvider $provider
            } "inspection is invalid"
        }
    }

    Test-Case "Start refuses an absent scheduled task after observing a request" {
        $script:StartInvoked = $false
        Assert-Throws {
            Start-HeiGeScheduledTask -TaskName $script:TestTask -ExpectedRevision 7 `
                -ExpectedTransitionNonce $script:RequestNonce -StateDirectory $script:State -TestMode `
                -RequestInspectorProvider { param($Path) $true } `
                -InspectProvider { param($Name) $null } `
                -StartProvider { param($Name) $script:StartInvoked = $true }
        } "does not exist"
        Assert-False $script:StartInvoked
    }

    Test-Case "Background controller command-line matcher is exact" {
        $quoted = (
            '"C:\Program Files\nodejs\node.exe" "C:\repo\src\cli.mjs" controller --background ' +
            '--platform windows --task-name "' + $script:TestTask + '" --state-directory "' +
            $script:State + '" --port 9341'
        )
        Assert-True (Test-HeiGeBackgroundControllerCommandLine `
            -CommandLine $quoted -TaskName $script:TestTask -StateDirectory $script:State)
        Assert-False (Test-HeiGeBackgroundControllerCommandLine `
            -CommandLine $quoted -TaskName $script:ProductionTask -StateDirectory $script:State)
        Assert-False (Test-HeiGeBackgroundControllerCommandLine `
            -CommandLine ($quoted -replace '--background ', '') `
            -TaskName $script:TestTask -StateDirectory $script:State)
        Assert-False (Test-HeiGeBackgroundControllerCommandLine `
            -CommandLine $null -TaskName $script:TestTask -StateDirectory $script:State)
    }

    Test-Case "Orphan stopper kills only matching background Node processes" {
        $script:Stopped = @()
        $foreignState = Join-Path $script:Root "Foreign State"
        New-Item -ItemType Directory -Path $foreignState -Force | Out-Null
        $result = Stop-HeiGeBackgroundControllerProcesses -TaskName $script:TestTask `
            -StateDirectory $script:State -ExcludePid 42 `
            -ProcessEnumerator {
                @(
                    [pscustomobject]@{
                        ProcessId = 42
                        CommandLine = (
                            'node.exe "C:\repo\src\cli.mjs" controller --background --platform windows ' +
                            '--task-name "' + $script:TestTask + '" --state-directory "' +
                            $script:State + '" --port 9341'
                        )
                    },
                    [pscustomobject]@{
                        ProcessId = 1001
                        CommandLine = (
                            'node.exe "C:\repo\src\cli.mjs" controller --background --platform windows ' +
                            '--task-name "' + $script:TestTask + '" --state-directory "' +
                            $script:State + '" --port 9341'
                        )
                    },
                    [pscustomobject]@{
                        ProcessId = 1002
                        CommandLine = (
                            'node.exe "C:\repo\src\cli.mjs" controller --background --platform windows ' +
                            '--task-name "' + $script:ProductionTask + '" --state-directory "' +
                            $script:State + '" --port 9341'
                        )
                    },
                    [pscustomobject]@{
                        ProcessId = 1003
                        CommandLine = (
                            'node.exe "C:\repo\src\cli.mjs" controller --background --platform windows ' +
                            '--task-name "' + $script:TestTask + '" --state-directory "' +
                            $foreignState + '" --port 9341'
                        )
                    },
                    [pscustomobject]@{
                        ProcessId = 1004
                        CommandLine = 'node.exe C:\other\app.js'
                    }
                )
            } `
            -StopProcessProvider {
                param([int]$ProcessId)
                $script:Stopped += $ProcessId
            }
        Assert-equal @(1001) $result.StoppedPids
        Assert-equal 1 $result.StoppedCount
        Assert-equal @(1001) $script:Stopped
    }

    Test-Case "Node process wait failure invokes exact process cleanup" {
        $script:FakeProcess = [pscustomobject]@{ HasExited = $false; ExitCode = 0 }
        $script:ProcessStopped = $false
        $script:OrphanInvoked = $false
        $handshakePath = Get-HeiGeHandshakePath -StateDirectory $script:State -TaskName $script:TestTask
        [System.IO.File]::WriteAllText($handshakePath, '{}')
        Assert-Throws {
            Invoke-HeiGeNodeControllerProcess -NodePath $script:Node -CliPath $script:Controller `
                -TaskName $script:TestTask -Port 9341 -StateDirectory $script:State `
                -AppIdentityToken $script:AppIdentityToken `
                -OrphanStopProvider {
                    param($Name, $Directory)
                    $script:OrphanInvoked = $true
                } `
                -ProcessProvider { param($Spec) $script:FakeProcess } `
                -WaitProvider { param($Process) throw "wait failed after launch" } `
                -StopProvider {
                    param($Process)
                    $script:ProcessStopped = $true
                    $Process.HasExited = $true
                }
        } "wait failed after launch"
        Assert-True $script:OrphanInvoked
        Assert-True $script:ProcessStopped
        Assert-True $script:FakeProcess.HasExited
        Assert-True (Test-Path -LiteralPath $handshakePath -PathType Leaf)
        Remove-Item -LiteralPath $handshakePath -Force
    }

    Test-Case "Node process launch failure never returns fake readiness" {
        Assert-Throws {
            Invoke-HeiGeNodeControllerProcess -NodePath $script:Node -CliPath $script:Controller `
                -TaskName $script:TestTask -Port 9341 -StateDirectory $script:State `
                -AppIdentityToken $script:AppIdentityToken `
                -OrphanStopProvider { param($Name, $Directory) } `
                -ProcessProvider { param($Spec) throw "node launch failed" }
        } "node launch failed"
    }

    Test-Case "Node terminal result uses the stable Windows CLI invocation" {
        $script:FakeProcess = [pscustomobject]@{ HasExited = $true; ExitCode = 0 }
        $script:CapturedProcessSpec = $null
        $script:CapturedProcessIdentity = $null
        $result = Invoke-HeiGeNodeControllerProcess -NodePath $script:Node -CliPath $script:Controller `
            -TaskName $script:TestTask -Port 9341 -StateDirectory $script:State `
            -AppIdentityToken $script:AppIdentityToken `
            -OrphanStopProvider { param($Name, $Directory) } `
            -ProcessProvider {
                param($Spec)
                $script:CapturedProcessSpec = $Spec
                $script:CapturedProcessIdentity = $env:HEIGE_WINDOWS_APP_IDENTITY
                [System.IO.File]::WriteAllText($Spec.StandardOutputPath, '{"action":"unregister"}')
                $script:FakeProcess
            } -WaitProvider { param($Process) }
        Assert-Equal "unregister" $result.action
        Assert-Equal $script:AppIdentityToken $script:CapturedProcessSpec.AppIdentityToken
        Assert-Equal $script:AppIdentityToken $script:CapturedProcessIdentity
        foreach ($fragment in @(
            'controller', '--background', '--platform', 'windows', '--task-name',
            '--state-directory', '--port'
        )) {
            Assert-Match ([regex]::Escape($fragment)) $script:CapturedProcessSpec.Arguments
        }
        Assert-False ($script:CapturedProcessSpec.Arguments -match 'handshake-revision|handshake-nonce')
    }

    Test-Case "Ordinary unregister clears ACK and verifies exact task absence" {
        $script:StoredDefinition = New-TestDefinition -Name $script:TestTask
        $handshakePath = Get-HeiGeHandshakePath -StateDirectory $script:State -TaskName $script:TestTask
        [System.IO.File]::WriteAllText($handshakePath, '{}')
        $result = Unregister-HeiGeScheduledTask -TaskName $script:TestTask `
            -StateDirectory $script:State -TestMode `
            -UnregisterProvider { param($Name) $script:StoredDefinition = $null } `
            -InspectProvider { param($Name) $script:StoredDefinition }
        Assert-True $result.Removed
        Assert-True $result.VerifiedAbsent
        Assert-False (Test-Path -LiteralPath $handshakePath)
        Assert-Throws {
            Unregister-HeiGeScheduledTask -TaskName $script:ProductionTask -TestMode `
                -UnregisterProvider { param($Name) } -InspectProvider { param($Name) $null }
        } "production task"
    }

    Test-Case "Background self-unregister preserves its observable Node ACK" {
        $script:StoredDefinition = New-TestDefinition -Name $script:TestTask
        $handshakePath = Get-HeiGeHandshakePath -StateDirectory $script:State -TaskName $script:TestTask
        [System.IO.File]::WriteAllText($handshakePath, '{"outcome":"unregister"}')
        $result = Unregister-HeiGeScheduledTask -TaskName $script:TestTask `
            -StateDirectory $script:State -TestMode -PreserveHandshake `
            -UnregisterProvider { param($Name) $script:StoredDefinition = $null } `
            -InspectProvider { param($Name) $script:StoredDefinition }
        Assert-True $result.VerifiedAbsent
        Assert-True $result.HandshakePreserved
        Assert-True (Test-Path -LiteralPath $handshakePath -PathType Leaf)
        Remove-Item -LiteralPath $handshakePath -Force
    }

    Test-Case "Windows controller keeps Node as the unique request and ACK authority" {
        $controllerSource = [System.IO.File]::ReadAllText(
            (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) "scripts\windows\controller.ps1")
        )
        $librarySource = [System.IO.File]::ReadAllText(
            (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) "scripts\windows\lib\scheduled-task.ps1")
        )
        $source = $controllerSource + $librarySource
        Assert-Match 'ValidateSet\("run",\s*"register",\s*"start",\s*"unregister",\s*"status"\)' $controllerSource
        foreach ($argument in @(
            '"controller"', '"--background"', '"--platform"', '"windows"',
            '"--task-name"', '"--state-directory"', '"--port"'
        )) {
            Assert-Match ([regex]::Escape($argument)) $librarySource
        }
        Assert-Match 'controller-start-request\.json' $librarySource
        Assert-Match 'Start-HeiGeScheduledTask' $controllerSource
        Assert-Match 'Unregister-HeiGeScheduledTask' $controllerSource
        Assert-Match '\-PreserveHandshake' $controllerSource
        Assert-Match '安装目录缺失' $controllerSource
        Assert-Match 'schtasks\.exe' $controllerSource
        Assert-Match '无法自动注销' $controllerSource
        Assert-False ($source -match 'WaitForExit\(500\)|exitedDuringStartup')
        Assert-False ($source -match 'Write-HeiGeControllerHandshake|Read-HeiGeControllerHandshake|Assert-HeiGeControllerHandshake')
        Assert-False ($source -match 'Start-CodexWithCdp|taskkill')
        Assert-Match 'Stop-HeiGeBackgroundControllerProcesses' $librarySource
        Assert-Match 'Stop-Process -Id \$ProcessId -Force' $librarySource
    }

    if ($Integration) {
        Test-Case "Integration registers and runs only the supplied GUID inert task" {
            if ($env:OS -ne "Windows_NT") { throw "Windows integration requires Windows_NT" }
            if (-not $TaskName) { throw "-TaskName is required for integration" }
            Assert-Match '^HeiGe Codex Skin Studio Test [0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' $TaskName
            Assert-False ($TaskName -eq $script:ProductionTask)
            $integrationRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("HeiGe Task Integration " + [guid]::NewGuid().ToString("N"))
            $inertController = Join-Path $integrationRoot "inert-controller.ps1"
            $stateDirectory = Join-Path $integrationRoot "state"
            $nativePowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
            try {
                New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
                [System.IO.File]::WriteAllText(
                    $inertController,
                    'param([string]$Action, [string]$TaskName, [int]$Port, [string]$StateDirectory, [string]$AppIdentityToken); exit 0',
                    (New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $true)
                )
                $registered = Register-HeiGeScheduledTask -TaskName $TaskName -NodePath $nativePowerShell `
                    -ControllerPath $inertController -StateDirectory $stateDirectory -TestMode `
                    -AppIdentityToken $script:AppIdentityToken `
                    -PowerShellPath $nativePowerShell
                Assert-True $registered.Verified
                Start-ScheduledTask -TaskPath "\" -TaskName $TaskName
                $finished = $false
                for ($index = 0; $index -lt 100; $index++) {
                    Start-Sleep -Milliseconds 100
                    $task = Get-ScheduledTask -TaskPath "\" -TaskName $TaskName
                    $info = Get-ScheduledTaskInfo -TaskPath "\" -TaskName $TaskName
                    if ([string]$task.State -ne "Running" -and $info.LastRunTime -gt [datetime]::MinValue) {
                        $finished = $true
                        break
                    }
                }
                Assert-True $finished
                Assert-Equal 0 $info.LastTaskResult
            } finally {
                Unregister-ScheduledTask -TaskPath "\" -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
                Remove-Item -LiteralPath $integrationRoot -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
} finally {
    Remove-Item -LiteralPath $script:Root -Recurse -Force -ErrorAction SilentlyContinue
}

Complete-TestRun
