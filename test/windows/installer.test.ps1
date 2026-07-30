$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")

$script:RepositoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$script:InstallerPath = Join-Path $script:RepositoryRoot "scripts\windows\install.ps1"
$script:InstallerSource = [System.IO.File]::ReadAllText($script:InstallerPath)
. $script:InstallerPath

try {
    Test-Case "Installer parses in the active PowerShell runtime" {
        $tokens = $null
        $errors = $null
        [System.Management.Automation.Language.Parser]::ParseFile(
            $script:InstallerPath,
            [ref]$tokens,
            [ref]$errors
        ) | Out-Null
        Assert-Equal 0 @($errors).Count
    }

    Test-Case "Installer exposes the supported named parameters" {
        $command = Get-Command -Name $script:InstallerPath -ErrorAction Stop
        $names = @($command.Parameters.Keys)
        Assert-True ($names -contains "InstallRoot")
        Assert-True ($names -contains "StartMenuRoot")
        Assert-True ($names -contains "SkipApply")
    }

    Test-Case "Installer rejects an unknown parameter before executing its body" {
        $hostPath = (Get-Process -Id $PID).Path
        $suffix = [guid]::NewGuid().ToString("N")
        $stdout = Join-Path ([System.IO.Path]::GetTempPath()) "heige-installer-$suffix.out"
        $stderr = Join-Path ([System.IO.Path]::GetTempPath()) "heige-installer-$suffix.err"
        $arguments = @("-NoLogo", "-NoProfile")
        if ($PSVersionTable.PSEdition -eq "Desktop") {
            $arguments += @("-ExecutionPolicy", "Bypass")
        }
        $arguments += @("-File", $script:InstallerPath, "-DefinitelyUnknownParameter")
        try {
            $process = Start-Process -FilePath $hostPath -ArgumentList $arguments `
                -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
            $output = ""
            if (Test-Path -LiteralPath $stdout) {
                $output += [System.IO.File]::ReadAllText($stdout)
            }
            if (Test-Path -LiteralPath $stderr) {
                $output += [System.IO.File]::ReadAllText($stderr)
            }
            Assert-True ($process.ExitCode -ne 0) "unknown parameter unexpectedly succeeded"
            Assert-Match "DefinitelyUnknownParameter" $output
        } finally {
            Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
        }
    }

    Test-Case "Durable skeleton precedes participant preparation" {
        $skeleton = $script:InstallerSource.IndexOf(
            'Write-HeiGeInstallJournal -Path $journalPath -Document $journal -Exclusive',
            [System.StringComparison]::Ordinal
        )
        $prepare = $script:InstallerSource.IndexOf(
            '"participant-prepare"',
            [System.StringComparison]::Ordinal
        )
        Assert-True ($skeleton -ge 0) "durable skeleton write is missing"
        Assert-True ($prepare -gt $skeleton) "participant preparation precedes the durable skeleton"
    }

    Test-Case "Installer has one artifact commit decision, write-through staging, and native replacement" {
        $commits = [regex]::Matches($script:InstallerSource, '-Decision\s+"commit"')
        Assert-Equal 1 $commits.Count
        Assert-Match '\$stream\.Flush\(\$true\)' $script:InstallerSource
        Assert-Match '\[System\.IO\.FileOptions\]::WriteThrough' $script:InstallerSource
        Assert-Match 'ReplaceFileW' $script:InstallerSource
        Assert-Match 'ReplaceFileWithoutBackup' $script:InstallerSource
        Assert-Match '0x00000000' $script:InstallerSource
        Assert-False ($script:InstallerSource -match 'MoveFileExW')
        Assert-False ($script:InstallerSource -match '\[System\.IO\.File\]::Replace\([^)]*\$null')
    }

    Test-Case "Journal replacement works without an empty backup path" {
        $root = Join-Path ([System.IO.Path]::GetTempPath()) `
            ("heige journal 替换 " + [guid]::NewGuid().ToString("N"))
        $path = Join-Path $root "install.json"
        try {
            New-Item -ItemType Directory -Path $root -Force | Out-Null
            Write-HeiGeInstallJournal -Path $path -Document ([ordered]@{ Revision = 1 }) -Exclusive
            Write-HeiGeInstallJournal -Path $path -Document ([ordered]@{ Revision = 2 })
            Write-HeiGeInstallJournal -Path $path -Document ([ordered]@{ Revision = 3 })
            $document = [System.IO.File]::ReadAllText($path) | ConvertFrom-Json
            Assert-Equal 3 ([int]$document.Revision)
            Assert-Equal 0 @(Get-ChildItem -LiteralPath $root -Filter "*.next.*").Count

            $source = Join-Path $root "missing-destination.next"
            $missing = Join-Path $root "missing-destination.json"
            [System.IO.File]::WriteAllText($source, "{}")
            Assert-Throws {
                Replace-HeiGeInstallJournalAtomic -Source $source -Destination $missing
            } "Win32 error"
        } finally {
            Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    Test-Case "Abandoned mutex notification retains acquired ownership" {
        $fakeMutex = New-Object PSObject
        $fakeMutex | Add-Member -MemberType ScriptMethod -Name WaitOne -Value {
            throw (New-Object System.Threading.AbandonedMutexException)
        }
        Assert-True (Enter-HeiGeInstallMutex -Mutex $fakeMutex)
    }

    Test-Case "Real abandoned mutex remains owned and releasable" {
        $suffix = [guid]::NewGuid().ToString("N")
        $mutexName = "Local\HeiGeSkinInstallTest-$suffix"
        $childScript = Join-Path ([System.IO.Path]::GetTempPath()) "heige-abandon-mutex-$suffix.ps1"
        $mutex = $null
        $process = $null
        $ownsMutex = $false
        try {
            [System.IO.File]::WriteAllText($childScript, @'
param([Parameter(Mandatory = $true)][string]$Name)
$ErrorActionPreference = "Stop"
$mutex = New-Object System.Threading.Mutex($false, $Name)
if (-not $mutex.WaitOne(5000)) { exit 2 }
exit 0
'@)
            $mutex = New-Object System.Threading.Mutex($false, $mutexName)
            $hostPath = (Get-Process -Id $PID).Path
            $arguments = @("-NoLogo", "-NoProfile")
            if ($PSVersionTable.PSEdition -eq "Desktop") {
                $arguments += @("-ExecutionPolicy", "Bypass")
            }
            $quotedChildScript = '"' + $childScript + '"'
            $arguments += @("-File", $quotedChildScript, "-Name", $mutexName)
            $process = Start-Process -FilePath $hostPath -ArgumentList $arguments -Wait -PassThru
            Assert-Equal 0 $process.ExitCode

            $ownsMutex = Enter-HeiGeInstallMutex -Mutex $mutex
            Assert-True $ownsMutex
            $mutex.ReleaseMutex()
            $ownsMutex = $false
        } finally {
            if ($ownsMutex -and $null -ne $mutex) {
                try { $mutex.ReleaseMutex() } catch { }
            }
            if ($null -ne $mutex) { $mutex.Dispose() }
            if ($null -ne $process) { $process.Dispose() }
            Remove-Item -LiteralPath $childScript -Force -ErrorAction SilentlyContinue
        }
    }

    Test-Case "Non-abandoned mutex failures remain visible" {
        $fakeMutex = New-Object PSObject
        $fakeMutex | Add-Member -MemberType ScriptMethod -Name WaitOne -Value {
            throw (New-Object System.InvalidOperationException("mutex probe failure"))
        }
        Assert-Throws {
            Enter-HeiGeInstallMutex -Mutex $fakeMutex
        } "mutex probe failure"
    }

    Test-Case "First apply follows commit finalization and journal deletion" {
        $commit = $script:InstallerSource.IndexOf(
            '-Phase "commit-decided" -Decision "commit"',
            [System.StringComparison]::Ordinal
        )
        $finalize = $script:InstallerSource.IndexOf(
            "Complete-HeiGeWindowsInstall",
            $commit,
            [System.StringComparison]::Ordinal
        )
        $clear = $script:InstallerSource.IndexOf(
            '[System.IO.File]::Delete($journalPath)',
            $finalize,
            [System.StringComparison]::Ordinal
        )
        $apply = $script:InstallerSource.IndexOf(
            "Invoke-HeiGePostCommitApply",
            $clear,
            [System.StringComparison]::Ordinal
        )
        Assert-True ($commit -ge 0 -and $finalize -gt $commit)
        Assert-True ($clear -gt $finalize -and $apply -gt $clear)
        Assert-Match "安装已完成，但首次应用失败，可重试" $script:InstallerSource
    }

    Test-Case "Postcommit apply preserves a spaced install root and reports the failure exit code" {
        $installRoot = Join-Path ([System.IO.Path]::GetTempPath()) `
            ("HeiGe InstallRoot 中文 " + [guid]::NewGuid().ToString("N"))
        $applyScript = Join-Path $installRoot "scripts\windows\apply.ps1"
        $successMarker = Join-Path (Split-Path $applyScript -Parent) "postinstall-ok.txt"
        $utf8Bom = New-Object System.Text.UTF8Encoding($true)
        try {
            New-Item -ItemType Directory -Path (Split-Path $applyScript -Parent) -Force | Out-Null
            [System.IO.File]::WriteAllText(
                $applyScript,
                '[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot "postinstall-ok.txt"), "ok"); exit 0',
                $utf8Bom
            )
            Invoke-HeiGePostCommitApply -ApplyScript $applyScript
            Assert-Equal "ok" ([System.IO.File]::ReadAllText($successMarker))

            [System.IO.File]::WriteAllText($applyScript, 'exit 37', $utf8Bom)
            Assert-Throws {
                Invoke-HeiGePostCommitApply -ApplyScript $applyScript
            } "退出码 37"
        } finally {
            Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    Test-Case "Precommit compensation reverses Start Menu before tree" {
        $undo = $script:InstallerSource.IndexOf(
            "function Undo-HeiGeWindowsInstall",
            [System.StringComparison]::Ordinal
        )
        $menu = $script:InstallerSource.IndexOf(
            "Rollback-HeiGeStartMenuShortcut",
            $undo,
            [System.StringComparison]::Ordinal
        )
        $tree = $script:InstallerSource.IndexOf(
            "-Action rollback",
            $menu,
            [System.StringComparison]::Ordinal
        )
        Assert-True ($undo -ge 0 -and $menu -gt $undo -and $tree -gt $menu)
    }

    Test-Case "Publish stops stable-tree holders before renaming the install root" {
        Assert-Match "function Stop-HeiGeInstallTreeHolders" $script:InstallerSource
        Assert-Match "Stop-HeiGeBackgroundControllerProcesses" $script:InstallerSource
        Assert-Match "Stop-HeiGeControllerResidue" $script:InstallerSource
        $holders = $script:InstallerSource.IndexOf(
            "Stop-HeiGeInstallTreeHolders -InstallRoot `$target",
            [System.StringComparison]::Ordinal
        )
        $publish = $script:InstallerSource.IndexOf(
            '-Action publish -Participant $journal.Participants.Tree',
            $holders,
            [System.StringComparison]::Ordinal
        )
        Assert-True ($holders -ge 0 -and $publish -gt $holders)
    }

    Complete-TestRun
} catch {
    throw
}
