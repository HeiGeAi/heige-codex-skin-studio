# HeiGe Codex Skin Studio 公共函数（Windows）
$ErrorActionPreference = "Stop"

function Get-CodexApp {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\ChatGPT\ChatGPT.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Codex\Codex.exe"),
        (Join-Path $env:ProgramFiles "ChatGPT\ChatGPT.exe"),
        (Join-Path $env:ProgramFiles "Codex\Codex.exe")
    )

    # Microsoft Store/MSIX installs Codex under a versioned WindowsApps
    # directory, and the desktop entry point is currently named ChatGPT.exe.
    # Resolve the package location dynamically so app updates do not break
    # discovery when the versioned directory changes.
    try {
        $package = Get-AppxPackage -Name "OpenAI.Codex" -ErrorAction Stop |
            Sort-Object Version -Descending |
            Select-Object -First 1
        if ($package -and $package.InstallLocation) {
            $candidates += @(
                (Join-Path $package.InstallLocation "app\ChatGPT.exe"),
                (Join-Path $package.InstallLocation "app\Codex.exe")
            )
        }
    } catch {
        # Get-AppxPackage may be unavailable in restricted PowerShell hosts;
        # the conventional install locations above remain valid fallbacks.
    }

    foreach ($path in $candidates) {
        if (Test-Path $path) { return $path }
    }
    throw "未找到 Codex Desktop，请确认已安装官方客户端。已探测：$($candidates -join '; ')"
}

function Get-NodeRuntime {
    param([string]$AppPath)
    $appDir = Split-Path $AppPath -Parent
    $candidates = @(
        (Join-Path $appDir "resources\cua_node\node.exe"),
        (Join-Path $appDir "resources\cua_node\bin\node.exe")
    )

    # Windows blocks direct execution of helper binaries inside an MSIX
    # package for normal desktop processes. Prefer a system Node runtime for
    # Store installs even though the bundled node.exe is visible on disk.
    $isMsix = $AppPath -like "*\WindowsApps\OpenAI.Codex_*"
    if (-not $isMsix) {
        foreach ($path in $candidates) {
            if (Test-Path $path) { return $path }
        }
    }
    $systemNode = Get-Command node -ErrorAction SilentlyContinue
    if ($systemNode) { return $systemNode.Source }
    if ($isMsix) {
        throw "当前是 Microsoft Store 版 Codex，Windows 不允许直接运行包内 Node.js。请安装 Node.js 并确保 node 在 PATH 中。"
    }
    throw "未找到 Node.js 运行时：Codex 自带 Node 不在预期位置，系统 PATH 里也没有 node。请安装 Node.js 后重试。"
}

function Start-PackagedCodex {
    param(
        [string]$AppUserModelId,
        [string]$Arguments
    )

    if (-not ("HeiGe.ApplicationActivation" -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace HeiGe {
    [ComImport]
    [Guid("2e941141-7f97-4756-ba1d-9decde894a3d")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IApplicationActivationManager {
        [PreserveSig]
        int ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            uint options,
            out uint processId);
    }

    [ComImport]
    [Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    class ApplicationActivationManager { }

    public static class ApplicationActivation {
        public static uint Activate(string appUserModelId, string arguments) {
            var manager = (IApplicationActivationManager)new ApplicationActivationManager();
            uint processId;
            int result = manager.ActivateApplication(appUserModelId, arguments, 0, out processId);
            if (result < 0) Marshal.ThrowExceptionForHR(result);
            return processId;
        }
    }
}
"@
    }

    [HeiGe.ApplicationActivation]::Activate($AppUserModelId, $Arguments) | Out-Null
}

function Test-Cdp {
    param([int]$Port)
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 1 | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Start-CodexWithCdp {
    param([int]$Port = 9341)
    if (Test-Cdp -Port $Port) { return }

    $app = Get-CodexApp
    $running = Get-Process | Where-Object { $_.Path -eq $app } -ErrorAction SilentlyContinue
    if ($running) {
        Write-Host "正在正常退出 Codex，以调试端口重新打开……"
        $running | ForEach-Object { $_.CloseMainWindow() | Out-Null }
        for ($i = 0; $i -lt 60; $i++) {
            if (-not (Get-Process | Where-Object { $_.Path -eq $app } -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 250
        }
    }

    $launchArguments = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$Port"
    $package = Get-AppxPackage -Name "OpenAI.Codex" -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if ($package -and $app.StartsWith($package.InstallLocation, [System.StringComparison]::OrdinalIgnoreCase)) {
        $manifest = Get-AppxPackageManifest -Package $package
        $applicationId = @($manifest.Package.Applications.Application)[0].Id
        $appUserModelId = "$($package.PackageFamilyName)!$applicationId"
        Start-PackagedCodex -AppUserModelId $appUserModelId -Arguments $launchArguments
    } else {
        Start-Process -FilePath $app -ArgumentList @(
            "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=$Port"
        )
    }
    for ($i = 0; $i -lt 80; $i++) {
        if (Test-Cdp -Port $Port) { return }
        Start-Sleep -Milliseconds 250
    }
    throw "Codex 未在 $Port 端口就绪。请彻底退出 Codex 后重试。"
}
