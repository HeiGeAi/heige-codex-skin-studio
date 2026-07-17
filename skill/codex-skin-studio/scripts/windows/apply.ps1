param(
    [Parameter(Mandatory = $true)]
    [string]$ThemeDir,
    [int]$Port = 9341,
    [switch]$Persist,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$skillRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$applyScript = Join-Path $skillRoot "scripts\apply.mjs"
$persistScript = Join-Path $skillRoot "scripts\persist.mjs"
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw "Node.js was not found in PATH" }
$node = $nodeCommand.Source

function Invoke-Node {
    param([string[]]$Arguments)
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $node
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    if ($startInfo.ArgumentList) {
        foreach ($argument in $Arguments) {
            $null = $startInfo.ArgumentList.Add($argument)
        }
    } else {
        $quotedArguments = foreach ($argument in $Arguments) {
            if ($argument -notmatch '[\s"]') {
                $argument
                continue
            }
            '"' + (($argument -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
        }
        $startInfo.Arguments = $quotedArguments -join ' '
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Node process could not be started"
    }
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        $diagnostics = @($stdout.Trim(), $stderr.Trim()) | Where-Object { $_ }
        $diagnostics = $diagnostics -join "`n"
        throw "Node command failed with exit code $($process.ExitCode)`n$diagnostics"
    }
    return $stdout.Trim()
}

function Test-Cdp {
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 1 | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Get-CdpTargets {
    try {
        return @(Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 2)
    } catch {
        return @()
    }
}

function Wait-CdpPageTarget {
    for ($index = 0; $index -lt 120; $index++) {
        $targets = @(Get-CdpTargets | Where-Object { $_ -and $_.type -eq "page" -and $_.webSocketDebuggerUrl })
        if ($targets.Count -gt 0) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Get-CdpTargetSummary {
    try {
        $targets = @(Get-CdpTargets | Where-Object { $_ })
        $summary = @($targets | ForEach-Object {
            [ordered]@{
                type = $_.type
                title = $_.title
                url = $_.url
                hasWebSocket = [bool]$_.webSocketDebuggerUrl
            }
        })
        if ($summary.Count -eq 0) { return "[]" }
        return ($summary | ConvertTo-Json -Depth 4 -Compress)
    } catch {
        return "unavailable: $($_.Exception.Message)"
    }
}

function Get-StorePackage {
    Get-AppxPackage -ErrorAction SilentlyContinue |
        Where-Object { -not $_.IsFramework -and ($_.Name -match "^OpenAI\." -or $_.Name -match "ChatGPT|Codex") } |
        Sort-Object @{ Expression = { if ($_.Name -match "^OpenAI\.Codex") { 0 } elseif ($_.Name -match "Codex") { 1 } else { 2 } } }, @{ Expression = { $_.Publisher -match "OpenAI" }; Descending = $true } |
        Select-Object -First 1
}

function Get-StoreAumid {
    param($Package)
    $manifest = Get-AppxPackageManifest -Package $Package.PackageFullName
    $applications = @($manifest.Package.Applications.Application)
    $application = $applications |
        Where-Object { $_.Id -eq "App" -or $_.Executable -match "ChatGPT|Codex" } |
        Select-Object -First 1
    if (-not $application) { $application = $applications[0] }
    return "$($Package.PackageFamilyName)!$($application.Id)"
}

function Get-StoreExecutable {
    param($Package)
    $manifest = Get-AppxPackageManifest -Package $Package.PackageFullName
    $applications = @($manifest.Package.Applications.Application)
    $application = $applications |
        Where-Object { $_.Id -eq "App" -or $_.Executable -match "ChatGPT|Codex" } |
        Select-Object -First 1
    if ($application -and $application.Executable) {
        $candidate = Join-Path $Package.InstallLocation ([string]$application.Executable)
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    foreach ($name in @("app\Codex.exe", "Codex.exe", "app\ChatGPT.exe", "ChatGPT.exe")) {
        $candidate = Join-Path $Package.InstallLocation $name
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

function Get-LaunchTarget {
    $running = Get-Process -Name ChatGPT, Codex -ErrorAction SilentlyContinue |
        Where-Object { $_.Path } |
        Select-Object -First 1
    if ($running.Path -match "\\WindowsApps\\") {
        $package = Get-StorePackage
        if ($package) {
            $executable = Get-StoreExecutable -Package $package
            if ($executable) { return $executable }
            return "aumid:$(Get-StoreAumid -Package $package)"
        }
    }
    if ($running.Path) { return $running.Path }

    $local = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME "AppData\Local" }
    $programFiles = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
    $candidates = @(
        (Join-Path $local "Programs\ChatGPT\ChatGPT.exe"),
        (Join-Path $local "Programs\Codex\Codex.exe"),
        (Join-Path $local "ChatGPT\ChatGPT.exe"),
        (Join-Path $local "Codex\Codex.exe"),
        (Join-Path $programFiles "ChatGPT\ChatGPT.exe"),
        (Join-Path $programFiles "Codex\Codex.exe")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }

    $package = Get-StorePackage
    if ($package) {
        $executable = Get-StoreExecutable -Package $package
        if ($executable) { return $executable }
        return "aumid:$(Get-StoreAumid -Package $package)"
    }
    throw "Codex Desktop was not found"
}

function Close-Codex {
    $running = @(Get-Process -Name ChatGPT, Codex -ErrorAction SilentlyContinue)
    if (-not $running) { return }
    $running | ForEach-Object { $_.CloseMainWindow() | Out-Null }
    for ($index = 0; $index -lt 60; $index++) {
        if (-not (Get-Process -Name ChatGPT, Codex -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Milliseconds 250
    }
    if ($Force) {
        Get-Process -Name ChatGPT, Codex -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
        if (-not (Get-Process -Name ChatGPT, Codex -ErrorAction SilentlyContinue)) { return }
    }
    throw "Codex is still running. Close it from the taskbar or Task Manager and rerun this script."
}

function Start-StoreCodex {
    param([string]$Aumid)
    if (-not ("CodexSkinStudio.ExternalActivation" -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace CodexSkinStudio {
    [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IApplicationActivationManager {
        [PreserveSig]
        int ActivateApplication([In, MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [In, MarshalAs(UnmanagedType.LPWStr)] string arguments, [In] int options, [Out] out uint processId);
    }
    [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    public class ApplicationActivationManager { }
    public static class ExternalActivation {
        public static uint Launch(string aumid, string arguments) {
            var manager = (IApplicationActivationManager)new ApplicationActivationManager();
            uint processId;
            int hr = manager.ActivateApplication(aumid, arguments, 0, out processId);
            if (hr != 0) Marshal.ThrowExceptionForHR(hr);
            return processId;
        }
    }
}
"@
    }
    return [CodexSkinStudio.ExternalActivation]::Launch($Aumid, "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$Port")
}

try {
    if (-not (Test-Path -LiteralPath $ThemeDir)) { throw "Theme directory was not found: $ThemeDir" }
    $null = Invoke-Node @($applyScript, "validate", $ThemeDir, "--json")

    if (-not (Test-Cdp)) {
        $target = Get-LaunchTarget
        Close-Codex
        if ($target -like "aumid:*") {
            $processId = Start-StoreCodex -Aumid $target.Substring(6)
        } else {
            Start-Process -FilePath $target -ArgumentList @(
                "--remote-debugging-address=127.0.0.1",
                "--remote-debugging-port=$Port"
            ) -WindowStyle Hidden | Out-Null
        }
        $ready = $false
        for ($index = 0; $index -lt 80; $index++) {
            if (Test-Cdp) { $ready = $true; break }
            Start-Sleep -Milliseconds 250
        }
        if (-not $ready) {
            $flagged = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -in @("ChatGPT.exe", "Codex.exe", "codex.exe") -and $_.CommandLine -match "remote-debugging-port" }
            if ($flagged) { throw "Codex received the remote-debugging flag but did not open port $Port" }
            throw "Codex did not preserve the remote-debugging arguments"
        }
    }

    if ($Persist) {
        $persistStatus = Invoke-Node @($persistScript, "status", "--json") | ConvertFrom-Json
        if ($persistStatus.status -eq "disabled") { $null = Invoke-Node @($persistScript, "install", "--json") }
    }

    if (-not (Wait-CdpPageTarget)) {
        throw "Codex Desktop opened CDP port $Port but did not expose a page target within 60 seconds. Targets: $(Get-CdpTargetSummary)"
    }
    Write-Output ("CDP targets before apply: " + (Get-CdpTargetSummary))
    $result = Invoke-Node @($applyScript, "apply", $ThemeDir, "--port", "$Port", "--json")
    Write-Output $result
} catch {
    Write-Error ($_.Exception.ToString() + "`nCDP target summary:`n" + (Get-CdpTargetSummary))
    exit 1
}
