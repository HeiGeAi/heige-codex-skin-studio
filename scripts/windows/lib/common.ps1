# HeiGe Codex Skin Studio 公共函数（Windows）
$ErrorActionPreference = "Stop"

function Get-ProgramFiles64 {
    param([System.Collections.IDictionary]$Environment)
    if ($null -eq $Environment) {
        $Environment = @{
            ProgramW6432 = $env:ProgramW6432
            ProgramFiles = $env:ProgramFiles
        }
    }
    if ($Environment["ProgramW6432"]) { return [string]$Environment["ProgramW6432"] }
    return [string]$Environment["ProgramFiles"]
}

$script:ProgramFiles64 = Get-ProgramFiles64

function Get-HeiGeFullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [System.IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
}

function Test-HeiGePathWithin {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Path
    )
    try {
        $rootPath = Get-HeiGeFullPath -Path $Root
        $candidate = Get-HeiGeFullPath -Path $Path
    } catch {
        return $false
    }
    if ($candidate.Equals($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    $prefix = $rootPath + [System.IO.Path]::DirectorySeparatorChar
    return $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-CodexPackageName {
    param($Package, [string]$ProductName)
    if ($Package.IsFramework) { return $false }
    $name = [string]$Package.Name
    if ($name -notmatch '^OpenAI\.(Codex|ChatGPT)([-\.]Desktop)?$') { return $false }
    if ($Package.PSObject.Properties.Name -notcontains "SignatureKind") { return $false }
    if ([string]$Package.SignatureKind -ne "Store") { return $false }
    if ($ProductName -and $name -notmatch [regex]::Escape($ProductName)) { return $false }
    return $true
}

function Select-CodexStorePackage {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Packages,
        [AllowNull()][string]$InstallPath,
        [AllowNull()][string]$ProductName
    )
    $plausible = @($Packages | Where-Object { Test-CodexPackageName -Package $_ -ProductName $ProductName })
    if ($InstallPath) {
        $matches = @($plausible | Where-Object {
            $_.InstallLocation -and (Test-HeiGePathWithin -Root ([string]$_.InstallLocation) -Path $InstallPath)
        })
        if ($matches.Count -eq 1) { return $matches[0] }
        if ($matches.Count -gt 1) { throw "Windows Store 包选择不唯一：同一进程路径命中多个安装根。" }
        throw "Windows Store 包与进程路径不匹配：$InstallPath"
    }
    if ($plausible.Count -eq 1) { return $plausible[0] }
    if ($plausible.Count -gt 1) { throw "Windows Store 包选择不唯一：需要精确进程路径作为归属证据。" }
    throw "未找到可信的 Windows Store 包。"
}

function Get-CodexStorePackages {
    return @(Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object {
        Test-CodexPackageName -Package $_ -ProductName $null
    })
}

function Get-CodexStorePackage {
    param(
        [object[]]$Packages,
        [string]$InstallPath,
        [string]$ProductName
    )
    if (-not $PSBoundParameters.ContainsKey("Packages")) { $Packages = Get-CodexStorePackages }
    return Select-CodexStorePackage -Packages @($Packages) -InstallPath $InstallPath -ProductName $ProductName
}

function Get-CodexAumid {
    param([Parameter(Mandatory = $true)]$Package)
    $app = Select-CodexPackageApplication -Package $Package -ProcessPath $null
    return "$($Package.PackageFamilyName)!$($app.Id)"
}

function Get-CodexPackageApplications {
    param([Parameter(Mandatory = $true)]$Package)
    $apps = @()
    if ($Package.PSObject.Properties.Name -contains "Applications" -and $Package.Applications) {
        $apps = @($Package.Applications)
    } else {
        $manifest = Get-AppxPackageManifest -Package $Package.PackageFullName
        $apps = @($manifest.Package.Applications.Application)
    }
    return @($apps)
}

function Select-CodexPackageApplication {
    param(
        [Parameter(Mandatory = $true)]$Package,
        [AllowNull()][string]$ProcessPath
    )
    $candidates = @(Get-CodexPackageApplications -Package $Package | Where-Object {
        $_.Id -eq "App" -or $_.Executable -match '(^|[\\/])(ChatGPT|Codex)\.exe$'
    } | Sort-Object Id, Executable)
    if ($candidates.Count -eq 0) { throw "Windows Store 包没有可归属的 Codex 应用入口。" }
    if ($ProcessPath) {
        $processFullPath = Get-HeiGeFullPath -Path $ProcessPath
        $candidates = @($candidates | Where-Object {
            if (-not $_.Executable) { return $false }
            $entryPath = Get-HeiGeFullPath -Path (Join-Path ([string]$Package.InstallLocation) ([string]$_.Executable))
            return $entryPath.Equals($processFullPath, [System.StringComparison]::OrdinalIgnoreCase)
        })
        if ($candidates.Count -eq 0) { throw "Windows Store 进程路径与包内应用入口不匹配：$ProcessPath" }
    }
    if ($candidates.Count -gt 1) { throw "Windows Store 应用入口选择不唯一。" }
    return $candidates[0]
}

function Invoke-SkinCli {
    # 统一调 node cli：只把 stdout 当 JSON 结果；stderr 进度/诊断直接印到控制台。
    # 退出码非零即抛（PS 对原生命令非零码不会自动抛）。
    param([string]$Node, [string[]]$CliArgs)
    # Windows PowerShell 5.1 strips unescaped " when calling native executables.
    # PowerShell 7.3+ passes arguments correctly; only Desktop edition needs \" escaping.
    if ($PSVersionTable.PSEdition -eq "Desktop") {
        $CliArgs = @(
            foreach ($argument in @($CliArgs)) {
                if ($null -eq $argument) { $argument }
                else { ([string]$argument) -replace '"', '\"' }
            }
        )
    }
    # ErrorAction Stop 下，原生命令 stderr 经 2>&1 会变成可终止 ErrorRecord；
    # 进度日志必须先用 Continue 收进变量，再自行分流。
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $merged = & $Node @CliArgs 2>&1
        $exitCode = [int]$LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    $stdoutLines = New-Object System.Collections.Generic.List[string]
    foreach ($item in @($merged)) {
        if ($item -is [System.Management.Automation.ErrorRecord]) {
            $text = [string]$item
            if (-not [string]::IsNullOrWhiteSpace($text)) {
                Write-Host $text
            }
            continue
        }
        $stdoutLines.Add([string]$item) | Out-Null
    }
    if ($exitCode -ne 0) {
        throw "皮肤命令执行失败（退出码 $exitCode）：`n$($merged -join "`n")"
    }
    return ($stdoutLines -join "`n")
}

function Start-CodexViaActivation {
    param([string]$Aumid, [string]$Arguments)
    # IApplicationActivationManager：系统给打包应用传命令行参数的官方通道，
    # 不依赖「应用执行别名」（部分 Store 包根本没声明别名，设置页里不会出现开关）
    if (-not ("HeiGe.AppActivation" -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace HeiGe {
    [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IApplicationActivationManager {
        [PreserveSig]
        int ActivateApplication([In, MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [In, MarshalAs(UnmanagedType.LPWStr)] string arguments,
            [In] int options, [Out] out uint processId);
        [PreserveSig]
        int ActivateForFile([In, MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [In] IntPtr itemArray, [In, MarshalAs(UnmanagedType.LPWStr)] string verb,
            [Out] out uint processId);
        [PreserveSig]
        int ActivateForProtocol([In, MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [In] IntPtr itemArray, [Out] out uint processId);
    }

    [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    public class ApplicationActivationManager { }

    public static class AppActivation {
        // AO_NOERRORUI = 0x2：避免激活失败时弹出需手动关掉的系统错误框，卡住控制台。
        public const int ActivateNoErrorUi = 0x2;

        public static uint Launch(string aumid, string arguments) {
            var manager = (IApplicationActivationManager)new ApplicationActivationManager();
            uint pid;
            int hr = manager.ActivateApplication(aumid, arguments, ActivateNoErrorUi, out pid);
            if (hr != 0) {
                Marshal.ThrowExceptionForHR(hr);
            }
            return pid;
        }
    }
}
"@
    }
    return [HeiGe.AppActivation]::Launch($Aumid, $Arguments)
}

function Get-CodexProductName {
    param([string]$Path, $Package)
    $text = if ($Package) { [string]$Package.Name } else { [System.IO.Path]::GetFileNameWithoutExtension($Path) }
    if ($text -match "ChatGPT") { return "ChatGPT" }
    return "Codex"
}

function New-CodexAppResult {
    param(
        [string]$Kind,
        [AllowNull()][object]$ExecutablePath,
        [string]$InstallPath,
        [string]$ProductName,
        [AllowNull()][object]$PackageFullName,
        [AllowNull()][object]$Aumid
    )
    if ($null -ne $ExecutablePath -and $ExecutablePath -isnot [string]) {
        throw "ExecutablePath must be a string or null."
    }
    if ($null -ne $PackageFullName -and $PackageFullName -isnot [string]) {
        throw "PackageFullName must be a string or null."
    }
    if ($null -ne $Aumid -and $Aumid -isnot [string]) {
        throw "Aumid must be a string or null."
    }
    return [pscustomobject][ordered]@{
        Kind = $Kind
        ExecutablePath = $ExecutablePath
        InstallPath = $InstallPath
        ProductName = $ProductName
        PackageFullName = $PackageFullName
        Aumid = $Aumid
    }
}

function Get-CodexExecutionAliases {
    param(
        [Parameter(Mandatory = $true)]$Package,
        [Parameter(Mandatory = $true)]$Application
    )
    if ($Application.PSObject.Properties.Name -contains "ExecutionAliases") {
        return @($Application.ExecutionAliases | ForEach-Object { [string]$_ } | Where-Object { $_ })
    }
    if ($Application -is [System.Xml.XmlNode]) {
        $nodes = @($Application.SelectNodes(
            "./*[local-name()='Extensions']/*[local-name()='Extension' and @Category='windows.appExecutionAlias']/*[local-name()='AppExecutionAlias']/*[local-name()='ExecutionAlias']"
        ))
        return @($nodes | ForEach-Object { [string]$_.Alias } | Where-Object { $_ })
    }
    return @()
}

function Get-CodexAliasPath {
    param(
        [Parameter(Mandatory = $true)]$Package,
        [Parameter(Mandatory = $true)]$Application
    )
    if (-not $env:LOCALAPPDATA) { return $null }
    $names = @(Get-CodexExecutionAliases -Package $Package -Application $Application | Where-Object {
        (Split-Path $_ -Leaf) -match '^(Codex|ChatGPT)\.exe$'
    } | ForEach-Object { Split-Path $_ -Leaf } | Sort-Object -Unique)
    $aliasRoot = Join-Path $env:LOCALAPPDATA ("Microsoft\WindowsApps\" + [string]$Package.PackageFamilyName)
    foreach ($name in $names) {
        $candidate = Join-Path $aliasRoot $name
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return (Get-HeiGeFullPath -Path $candidate) }
    }
    return $null
}

function New-CodexStoreApp {
    param($Package, [string]$ProcessPath)
    $product = Get-CodexProductName -Path $ProcessPath -Package $Package
    $application = Select-CodexPackageApplication -Package $Package -ProcessPath $ProcessPath
    $aumid = "$($Package.PackageFamilyName)!$($application.Id)"
    $alias = Get-CodexAliasPath -Package $Package -Application $application
    $kind = if ($alias) { "StoreAlias" } else { "StoreAumid" }
    return New-CodexAppResult -Kind $kind -ExecutablePath $alias `
        -InstallPath (Get-HeiGeFullPath -Path ([string]$Package.InstallLocation)) `
        -ProductName $product -PackageFullName ([string]$Package.PackageFullName) -Aumid $aumid
}

function Get-CodexVersionFromDirectory {
    param([string]$Path)
    $parent = Split-Path $Path -Parent
    $name = Split-Path $parent -Leaf
    $value = [version]"0.0"
    if ($name -match '^app-(.+)$') {
        [version]::TryParse($Matches[1], [ref]$value) | Out-Null
    }
    return $value
}

function Select-CodexWin32Path {
    param([string[]]$Paths)
    $valid = @($Paths | Where-Object {
        $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) -and
        (Split-Path $_ -Leaf) -match '^(Codex|ChatGPT)\.exe$' -and
        -not (Test-HeiGeCodexInternalBackendPath -Path $_)
    } | ForEach-Object { Get-HeiGeFullPath -Path $_ } | Select-Object -Unique)
    return $valid | Sort-Object @{ Expression = { Get-CodexVersionFromDirectory -Path $_ }; Descending = $true }, @{ Expression = { $_ }; Descending = $false } | Select-Object -First 1
}

function Get-CodexWin32Candidates {
    $roots = @()
    if ($env:LOCALAPPDATA) {
        foreach ($relative in @("Programs\ChatGPT", "Programs\Codex", "ChatGPT", "Codex")) {
            $roots += (Join-Path $env:LOCALAPPDATA $relative)
        }
    }
    foreach ($programRoot in (@($script:ProgramFiles64, ${env:ProgramFiles(x86)}) | Where-Object { $_ })) {
        $roots += (Join-Path $programRoot "ChatGPT")
        $roots += (Join-Path $programRoot "Codex")
    }
    $paths = @()
    foreach ($root in @($roots | Select-Object -Unique)) {
        foreach ($name in @("ChatGPT.exe", "Codex.exe")) {
            $paths += (Join-Path $root $name)
        }
        if (Test-Path -LiteralPath $root -PathType Container) {
            foreach ($directory in @(Get-ChildItem -LiteralPath $root -Directory -Filter "app-*" -ErrorAction SilentlyContinue)) {
                foreach ($name in @("ChatGPT.exe", "Codex.exe")) {
                    $paths += (Join-Path $directory.FullName $name)
                }
            }
        }
    }
    return @($paths | Where-Object { -not (Test-HeiGeCodexInternalBackendPath -Path $_) })
}

function Test-HeiGeCodexInternalBackendPath {
    param([AllowNull()][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    try {
        $full = Get-HeiGeFullPath -Path $Path
    } catch {
        return $false
    }
    if ((Split-Path $full -Leaf) -notmatch '^(?i)codex\.exe$') { return $false }
    # Desktop task backend unpacked under the user profile; not a second UI install.
    if ($env:LOCALAPPDATA) {
        $binRoot = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
        if (Test-HeiGePathWithin -Root $binRoot -Path $full) { return $true }
    }
    # Editor extensions ship a headless Codex CLI beside the extension. It is
    # not a second Codex desktop installation and must not create mixed evidence.
    if ($full -match '(?i)[\\/]\.(?:cursor|vscode|antigravity)[\\/]extensions[\\/]openai\.chatgpt-[^\\/]+[\\/]bin[\\/](?:windows-x86_64[\\/])?codex\.exe$') {
        return $true
    }
    return $false
}

function Resolve-CodexApp {
    param(
        [AllowNull()][string]$OverridePath = $env:HEIGE_CODEX_APP,
        [object[]]$Packages,
        [scriptblock]$ProcessProvider,
        [AllowNull()][string]$ProductName
    )
    $packagesProvided = $PSBoundParameters.ContainsKey("Packages")
    if ($OverridePath) {
        if (-not (Test-Path -LiteralPath $OverridePath -PathType Leaf)) {
            throw "环境变量 HEIGE_CODEX_APP 指向的文件不存在：$OverridePath"
        }
        $fullOverride = Get-HeiGeFullPath -Path $OverridePath
        if ((Split-Path $fullOverride -Leaf) -notmatch '^(Codex|ChatGPT)\.exe$') {
            throw "HEIGE_CODEX_APP 不是可归属的 Codex 可执行文件：$fullOverride"
        }
        if (-not $packagesProvided) { $Packages = Get-CodexStorePackages }
        $Packages = @($Packages)
        $packageMatches = @($Packages | Where-Object {
            (Test-CodexPackageName -Package $_ -ProductName $ProductName) -and $_.InstallLocation -and
            (Test-HeiGePathWithin -Root ([string]$_.InstallLocation) -Path $fullOverride)
        })
        if ($packageMatches.Count -eq 1) { return New-CodexStoreApp -Package $packageMatches[0] -ProcessPath $fullOverride }
        if ($packageMatches.Count -gt 1) { throw "Windows Store 包选择不唯一：HEIGE_CODEX_APP 同时命中多个安装根。" }
        return New-CodexAppResult -Kind "Win32" -ExecutablePath $fullOverride `
            -InstallPath (Split-Path $fullOverride -Parent) `
            -ProductName (Get-CodexProductName -Path $fullOverride -Package $null) `
            -PackageFullName $null -Aumid $null
    }

    if (-not $packagesProvided) { $Packages = Get-CodexStorePackages }
    $Packages = @($Packages)
    if (-not $ProcessProvider) {
        $ProcessProvider = { @(Get-Process -Name "ChatGPT", "Codex" -ErrorAction SilentlyContinue) }
    }

    $processes = @(& $ProcessProvider)
    $storeEvidence = @()
    $win32Evidence = @()
    foreach ($process in $processes) {
        try {
            $path = [string]$process.Path
        } catch {
            continue
        }
        if (-not $path -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        $fullPath = Get-HeiGeFullPath -Path $path
        if (Test-HeiGeCodexInternalBackendPath -Path $fullPath) { continue }
        $matches = @($Packages | Where-Object {
            (Test-CodexPackageName -Package $_ -ProductName $ProductName) -and $_.InstallLocation -and
            (Test-HeiGePathWithin -Root ([string]$_.InstallLocation) -Path $fullPath)
        })
        if ($matches.Count -gt 1) { throw "Windows Store 包选择不唯一：进程路径命中多个安装根。" }
        if ($matches.Count -eq 1) {
            $storeEvidence += [pscustomobject]@{ Package = $matches[0]; Path = $fullPath }
        } else {
            $win32Evidence += $fullPath
        }
    }
    $runningWin32 = Select-CodexWin32Path -Paths $win32Evidence
    if ($storeEvidence.Count -gt 0 -and $runningWin32) {
        throw "Codex 运行进程归属不唯一：同时存在 Store 和 Win32 实例。"
    }
    $storeNames = @($storeEvidence | ForEach-Object { $_.Package.PackageFullName } | Select-Object -Unique)
    if ($storeNames.Count -gt 1) { throw "Windows Store 包选择不唯一：存在多个运行中包。" }
    if ($storeEvidence.Count -gt 0) {
        $selected = $storeEvidence | Sort-Object { $_.Package.PackageFullName }, Path | Select-Object -First 1
        return New-CodexStoreApp -Package $selected.Package -ProcessPath $selected.Path
    }
    if ($runningWin32) {
        return New-CodexAppResult -Kind "Win32" -ExecutablePath $runningWin32 `
            -InstallPath (Split-Path $runningWin32 -Parent) `
            -ProductName (Get-CodexProductName -Path $runningWin32 -Package $null) `
            -PackageFullName $null -Aumid $null
    }

    $installedWin32 = Select-CodexWin32Path -Paths (Get-CodexWin32Candidates)
    if ($installedWin32) {
        return New-CodexAppResult -Kind "Win32" -ExecutablePath $installedWin32 `
            -InstallPath (Split-Path $installedWin32 -Parent) `
            -ProductName (Get-CodexProductName -Path $installedWin32 -Package $null) `
            -PackageFullName $null -Aumid $null
    }

    $package = Select-CodexStorePackage -Packages $Packages -InstallPath $null -ProductName $ProductName
    return New-CodexStoreApp -Package $package -ProcessPath $null
}

function ConvertTo-HeiGeCodexAppIdentityDocument {
    param([Parameter(Mandatory = $true)]$App)
    $expectedProperties = @("Aumid", "ExecutablePath", "InstallPath", "Kind", "PackageFullName", "ProductName")
    $actualProperties = @($App.PSObject.Properties.Name | Sort-Object)
    if (($actualProperties -join "`0") -cne (($expectedProperties | Sort-Object) -join "`0")) {
        throw "Codex app identity must contain the exact resolver tuple."
    }
    $kind = [string]$App.Kind
    if (@("Win32", "StoreAlias", "StoreAumid") -cnotcontains $kind) {
        throw "Codex app identity kind is invalid."
    }
    $productName = [string]$App.ProductName
    if (@("Codex", "ChatGPT") -cnotcontains $productName) {
        throw "Codex app identity product is invalid."
    }
    if (-not $App.InstallPath -or -not [System.IO.Path]::IsPathRooted([string]$App.InstallPath)) {
        throw "Codex app identity install path is invalid."
    }
    $installPath = Get-HeiGeFullPath -Path ([string]$App.InstallPath)
    $executablePath = if ($null -eq $App.ExecutablePath) {
        $null
    } else {
        if (-not [System.IO.Path]::IsPathRooted([string]$App.ExecutablePath)) {
            throw "Codex app identity executable path is invalid."
        }
        Get-HeiGeFullPath -Path ([string]$App.ExecutablePath)
    }
    $packageFullName = if ($null -eq $App.PackageFullName) { $null } else { [string]$App.PackageFullName }
    $aumid = if ($null -eq $App.Aumid) { $null } else { [string]$App.Aumid }
    foreach ($value in @($kind, $productName, $installPath, $executablePath, $packageFullName, $aumid)) {
        if ($null -ne $value -and ([string]$value).IndexOfAny([char[]]@([char]0, "`r", "`n")) -ge 0) {
            throw "Codex app identity contains an invalid control character."
        }
    }
    if ($kind -ceq "Win32" -and
        ($null -eq $executablePath -or $null -ne $packageFullName -or $null -ne $aumid)) {
        throw "Win32 app identity is incomplete."
    }
    if ($kind -ceq "StoreAlias" -and
        ($null -eq $executablePath -or -not $packageFullName -or -not $aumid)) {
        throw "StoreAlias app identity is incomplete."
    }
    if ($kind -ceq "StoreAumid" -and
        ($null -ne $executablePath -or -not $packageFullName -or -not $aumid)) {
        throw "StoreAumid app identity is incomplete."
    }
    return [pscustomobject][ordered]@{
        schemaVersion = 1
        product = "heige-codex-skin-studio"
        kind = $kind
        executablePath = $executablePath
        installPath = $installPath
        productName = $productName
        packageFullName = $packageFullName
        aumid = $aumid
    }
}

function ConvertTo-HeiGeCodexAppIdentityToken {
    param([Parameter(Mandatory = $true)]$App)
    $document = ConvertTo-HeiGeCodexAppIdentityDocument -App $App
    $json = $document | ConvertTo-Json -Depth 4 -Compress
    $utf8 = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false, $true
    $base64 = [System.Convert]::ToBase64String($utf8.GetBytes($json))
    return $base64.TrimEnd([char[]]@('=')).Replace("+", "-").Replace("/", "_")
}

function ConvertFrom-HeiGeCodexAppIdentityToken {
    param([Parameter(Mandatory = $true)][string]$IdentityToken)
    if ($IdentityToken.Length -le 0 -or $IdentityToken.Length -gt 16384 -or
        $IdentityToken -cnotmatch '^[A-Za-z0-9_-]+$') {
        throw "Codex app 身份 token 不是规范 base64url。"
    }
    $base64 = $IdentityToken.Replace("-", "+").Replace("_", "/")
    switch ($base64.Length % 4) {
        0 { }
        2 { $base64 += "==" }
        3 { $base64 += "=" }
        default { throw "Codex app 身份 token 长度无效。" }
    }
    try {
        $bytes = [System.Convert]::FromBase64String($base64)
        if ($bytes.Length -le 0 -or $bytes.Length -gt 8192) {
            throw "Codex app 身份 token 大小无效。"
        }
        $utf8 = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false, $true
        $document = $utf8.GetString($bytes) | ConvertFrom-Json -ErrorAction Stop
    } catch {
        throw "Codex app 身份 token 无效：$($_.Exception.Message)"
    }
    $expectedProperties = @(
        "aumid", "executablePath", "installPath", "kind", "packageFullName", "product",
        "productName", "schemaVersion"
    )
    $actualProperties = @($document.PSObject.Properties.Name | Sort-Object)
    if (($actualProperties -join "`0") -cne (($expectedProperties | Sort-Object) -join "`0") -or
        [int]$document.schemaVersion -ne 1 -or
        [string]$document.product -cne "heige-codex-skin-studio") {
        throw "Codex app 身份 token schema 无效。"
    }
    $app = New-CodexAppResult -Kind ([string]$document.kind) `
        -ExecutablePath $(if ($null -eq $document.executablePath) { $null } else { [string]$document.executablePath }) `
        -InstallPath ([string]$document.installPath) -ProductName ([string]$document.productName) `
        -PackageFullName $(if ($null -eq $document.packageFullName) { $null } else { [string]$document.packageFullName }) `
        -Aumid $(if ($null -eq $document.aumid) { $null } else { [string]$document.aumid })
    $canonical = ConvertTo-HeiGeCodexAppIdentityToken -App $app
    if ($canonical -cne $IdentityToken) {
        throw "Codex app 身份 token 不是规范编码。"
    }
    return $app
}

function Test-HeiGeCodexAppIdentityEqual {
    param(
        [Parameter(Mandatory = $true)]$Left,
        [Parameter(Mandatory = $true)]$Right
    )
    $leftDocument = ConvertTo-HeiGeCodexAppIdentityDocument -App $Left
    $rightDocument = ConvertTo-HeiGeCodexAppIdentityDocument -App $Right
    foreach ($name in @("kind", "productName", "packageFullName", "aumid")) {
        if ($leftDocument.$name -cne $rightDocument.$name) { return $false }
    }
    if (-not ([string]$leftDocument.installPath).Equals(
        [string]$rightDocument.installPath,
        [System.StringComparison]::OrdinalIgnoreCase
    )) { return $false }
    if (($null -eq $leftDocument.executablePath) -ne
        ($null -eq $rightDocument.executablePath)) { return $false }
    if ($null -ne $leftDocument.executablePath -and
        -not ([string]$leftDocument.executablePath).Equals(
            [string]$rightDocument.executablePath,
            [System.StringComparison]::OrdinalIgnoreCase
        )) { return $false }
    return $true
}

function Resolve-HeiGeExactStoreCodexApp {
    param(
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Packages
    )
    $packageMatches = @($Packages | Where-Object {
        (Test-CodexPackageName -Package $_ -ProductName ([string]$Expected.ProductName)) -and
        ([string]$_.PackageFullName -ceq [string]$Expected.PackageFullName)
    })
    if ($packageMatches.Count -ne 1) {
        throw "已绑定 Store 包的不可变身份已消失或不唯一。"
    }
    $package = $packageMatches[0]
    if (-not $package.InstallLocation) {
        throw "已绑定 Store 包缺少不可变安装根。"
    }
    $observedInstallPath = Get-HeiGeFullPath -Path ([string]$package.InstallLocation)
    if (-not $observedInstallPath.Equals(
        [string]$Expected.InstallPath,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "已绑定 Store 包的不可变安装根已变化。"
    }
    $packageFamilyName = [string]$package.PackageFamilyName
    if (-not $packageFamilyName) {
        throw "已绑定 Store 包缺少不可变包家族。"
    }
    $expectedAumid = [string]$Expected.Aumid
    $applications = @(Get-CodexPackageApplications -Package $package | Where-Object {
        $eligible = $_.Id -eq "App" -or $_.Executable -match '(^|[\\/])(ChatGPT|Codex)\.exe$'
        $eligible -and ("$packageFamilyName!$([string]$_.Id)" -ceq $expectedAumid)
    })
    if ($applications.Count -ne 1) {
        throw "已绑定 Store AUMID 的不可变应用入口已消失或不唯一。"
    }
    $application = $applications[0]
    $alias = Get-CodexAliasPath -Package $package -Application $application
    $kind = if ($alias) { "StoreAlias" } else { "StoreAumid" }
    $observed = New-CodexAppResult -Kind $kind -ExecutablePath $alias `
        -InstallPath $observedInstallPath `
        -ProductName (Get-CodexProductName -Path $null -Package $package) `
        -PackageFullName ([string]$package.PackageFullName) -Aumid $expectedAumid
    if (-not (Test-HeiGeCodexAppIdentityEqual -Left $Expected -Right $observed)) {
        throw "当前 Store Codex 与已绑定的不可变身份不一致。"
    }
    return $observed
}

function Resolve-HeiGeBoundCodexApp {
    param(
        [Parameter(Mandatory = $true)][string]$IdentityToken,
        [object[]]$Packages
    )
    $expected = ConvertFrom-HeiGeCodexAppIdentityToken -IdentityToken $IdentityToken
    if ([string]$expected.Kind -ceq "Win32") {
        $observed = if ($PSBoundParameters.ContainsKey("Packages")) {
            Resolve-CodexApp -OverridePath ([string]$expected.ExecutablePath) `
                -Packages @($Packages) -ProductName ([string]$expected.ProductName)
        } else {
            Resolve-CodexApp -OverridePath ([string]$expected.ExecutablePath) `
                -ProductName ([string]$expected.ProductName)
        }
    } else {
        $currentPackages = if ($PSBoundParameters.ContainsKey("Packages")) {
            @($Packages)
        } else {
            @(Get-CodexStorePackages)
        }
        $observed = Resolve-HeiGeExactStoreCodexApp -Expected $expected -Packages $currentPackages
    }
    if (-not (Test-HeiGeCodexAppIdentityEqual -Left $expected -Right $observed)) {
        throw "当前 Codex 归属与已绑定的不可变身份不一致。"
    }
    return $observed
}

function Resolve-CodexLaunchTarget {
    param([Parameter(Mandatory = $true)][string]$AppPath)
    $app = Resolve-CodexApp -OverridePath $AppPath
    if ($app.Kind -eq "StoreAumid") { return "aumid:$($app.Aumid)" }
    return $app.ExecutablePath
}

function Get-CodexApp {
    $app = Resolve-CodexApp
    if ($app.Kind -eq "StoreAumid") { return "aumid:$($app.Aumid)" }
    return $app.ExecutablePath
}

function Get-NodeRuntime {
    param(
        $App,
        [AllowNull()][string]$AppPath,
        [ValidateRange(22, 2147483647)][int]$MinimumSystemMajor = 22,
        [scriptblock]$VersionReader,
        [scriptblock]$SystemNodeProvider
    )
    $legacyResult = $PSBoundParameters.ContainsKey("AppPath")
    if (-not $App) {
        if (-not $AppPath) { throw "Get-NodeRuntime 需要结构化 App 或 AppPath。" }
        if ($AppPath -like "aumid:*") {
            $App = New-CodexAppResult -Kind "StoreAumid" -ExecutablePath $null -InstallPath "" `
                -ProductName "Codex" -PackageFullName $null -Aumid $AppPath.Substring(6)
        } else {
            $fullAppPath = Get-HeiGeFullPath -Path $AppPath
            $App = New-CodexAppResult -Kind "Win32" -ExecutablePath $fullAppPath `
                -InstallPath (Split-Path $fullAppPath -Parent) `
                -ProductName (Get-CodexProductName -Path $fullAppPath -Package $null) `
                -PackageFullName $null -Aumid $null
        }
    }
    if (-not $VersionReader) {
        $VersionReader = {
            param($Path)
            $output = & $Path --version 2>&1
            if ($LASTEXITCODE -ne 0) { throw "Node.js 版本检测失败：$Path" }
            return ([string]($output -join "")).Trim()
        }
    }

    $candidates = @()
    if ($App.Kind -eq "Win32") {
        $root = if ($App.InstallPath) { [string]$App.InstallPath } else { Split-Path $App.ExecutablePath -Parent }
        $candidates += [pscustomobject]@{ Path = (Join-Path $root "resources\cua_node\node.exe"); Source = "Bundled" }
        $candidates += [pscustomobject]@{ Path = (Join-Path $root "resources\cua_node\bin\node.exe"); Source = "Bundled" }
    }
    if (-not $SystemNodeProvider) {
        $SystemNodeProvider = {
            $command = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($command) { return [string]$command.Source }
            return $null
        }
    }
    $systemNodePath = [string](& $SystemNodeProvider)
    if ($systemNodePath) { $candidates += [pscustomobject]@{ Path = $systemNodePath; Source = "System" } }

    $foundCandidate = $false
    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate.Path -PathType Leaf)) { continue }
        $foundCandidate = $true
        try {
            $versionText = [string](& $VersionReader $candidate.Path)
        } catch {
            continue
        }
        $versionText = $versionText.Trim()
        if ($versionText -notmatch '^v(\d+)\.(\d+)\.(\d+)(?:[-+].+)?$') { continue }
        if ([int]$Matches[1] -lt $MinimumSystemMajor) { continue }
        $runtime = [pscustomobject][ordered]@{
            Path = Get-HeiGeFullPath -Path ([string]$candidate.Path)
            Source = [string]$candidate.Source
            Version = $versionText
        }
        if ($legacyResult) { return $runtime.Path }
        return $runtime
    }
    if (-not $foundCandidate) {
        throw "未找到 Node.js 运行时。请安装 Node.js 22 或更高版本。"
    }
    throw "Node.js 22 或更高版本才能运行控制器。"
}

function New-HeiGePrivateDirectoryAcl {
    param([Parameter(Mandatory = $true)][string]$UserSid)
    $sid = New-Object -TypeName System.Security.Principal.SecurityIdentifier -ArgumentList $UserSid
    $acl = New-Object -TypeName System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($sid)
    $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $rule = New-Object -TypeName System.Security.AccessControl.FileSystemAccessRule `
        -ArgumentList $sid, $rights, $inheritance, $propagation, $allow
    $acl.AddAccessRule($rule) | Out-Null
    return $acl
}

function New-HeiGePrivateFileAcl {
    param([Parameter(Mandatory = $true)][string]$UserSid)
    $sid = New-Object -TypeName System.Security.Principal.SecurityIdentifier -ArgumentList $UserSid
    $acl = New-Object -TypeName System.Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($sid)
    $rule = New-Object -TypeName System.Security.AccessControl.FileSystemAccessRule -ArgumentList @(
        $sid,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($rule) | Out-Null
    return $acl
}

function Set-HeiGePrivatePathAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$AclObject,
        [Parameter(Mandatory = $true)][string]$UserSid,
        [Parameter(Mandatory = $true)][bool]$IsDirectory,
        [scriptblock]$SetAclProvider
    )
    try {
        if ($SetAclProvider) {
            & $SetAclProvider $Path $AclObject | Out-Null
        } else {
            Set-Acl -LiteralPath $Path -AclObject $AclObject -ErrorAction Stop
        }
        return [pscustomobject][ordered]@{ Method = "Set-Acl"; Path = $Path }
    } catch {
        $detail = [string]$_.Exception.Message
        $current = $_.Exception
        $privilegeHeld = $false
        while ($null -ne $current) {
            $name = $current.GetType().FullName
            if (
                $name -eq "System.Security.AccessControl.PrivilegeNotHeldException" -or
                $name -eq "System.UnauthorizedAccessException" -or
                $name -eq "System.Security.SecurityException" -or
                $detail -match 'SeSecurityPrivilege|PrivilegeNotHeld|特权'
            ) {
                $privilegeHeld = $true
                break
            }
            $current = $current.InnerException
        }
        if (-not $privilegeHeld) { throw }

        $icacls = Join-Path $env:SystemRoot "System32\icacls.exe"
        if (-not (Test-Path -LiteralPath $icacls -PathType Leaf)) {
            throw "状态目录 ACL 保护失败：Set-Acl 需要 SeSecurityPrivilege，且找不到 icacls：$Path；$detail"
        }
        $grant = if ($IsDirectory) {
            "*${UserSid}:(OI)(CI)F"
        } else {
            "*${UserSid}:F"
        }
        $output = & $icacls $Path /inheritance:r /grant:r $grant 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "状态目录 ACL 保护失败（Set-Acl 与 icacls 均失败）：$Path；Set-Acl：$detail；icacls：$($output -join ' ')"
        }
        return [pscustomobject][ordered]@{ Method = "icacls"; Path = $Path }
    }
}

function Protect-HeiGeStateDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$CurrentUserSid,
        [scriptblock]$ChildItemProvider,
        [scriptblock]$SetAclProvider
    )
    if (-not $CurrentUserSid) {
        $CurrentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    }
    [System.IO.Directory]::CreateDirectory($Path) | Out-Null
    $root = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (($root.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "状态目录不能是 reparse point：$Path"
    }
    $directoryAcl = New-HeiGePrivateDirectoryAcl -UserSid $CurrentUserSid
    Set-HeiGePrivatePathAcl -Path $Path -AclObject $directoryAcl `
        -UserSid $CurrentUserSid -IsDirectory $true -SetAclProvider $SetAclProvider | Out-Null

    if (-not $ChildItemProvider) {
        $ChildItemProvider = {
            param($Directory)
            @(Get-ChildItem -LiteralPath $Directory -Force -ErrorAction Stop)
        }
    }
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($root.FullName)
    $items = @()
    while ($queue.Count -gt 0) {
        $directory = [string]$queue.Dequeue()
        foreach ($item in @(& $ChildItemProvider $directory)) {
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "状态目录内不能包含 reparse point：$($item.FullName)"
            }
            $items += $item
            if ($item.PSIsContainer) { $queue.Enqueue([string]$item.FullName) }
        }
    }
    foreach ($item in $items) {
        $itemAcl = if ($item.PSIsContainer) {
            New-HeiGePrivateDirectoryAcl -UserSid $CurrentUserSid
        } else {
            New-HeiGePrivateFileAcl -UserSid $CurrentUserSid
        }
        Set-HeiGePrivatePathAcl -Path $item.FullName -AclObject $itemAcl `
            -UserSid $CurrentUserSid -IsDirectory ([bool]$item.PSIsContainer) `
            -SetAclProvider $SetAclProvider | Out-Null
    }
    return (Get-Acl -LiteralPath $Path)
}

function Get-DefaultCdpOwners {
    param([int]$Port)
    $connections = @()
    try {
        Import-Module NetTCPIP -ErrorAction SilentlyContinue | Out-Null
        $connections = @(Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $Port -State Listen -ErrorAction Stop)
    } catch {
        # 部分会话无法自动加载 NetTCPIP；回退解析 netstat，避免端口已开却误判失败。
        $connections = @()
        foreach ($line in @(netstat -ano -p tcp 2>$null)) {
            if ($line -notmatch '^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') { continue }
            if ([int]$Matches[1] -ne [int]$Port) { continue }
            $connections += [pscustomobject]@{
                OwningProcess = [int]$Matches[2]
                LocalPort = [int]$Port
            }
        }
    }
    $owners = @()
    foreach ($connection in $connections) {
        try {
            $process = Get-Process -Id $connection.OwningProcess -ErrorAction Stop
            $owners += [pscustomobject]@{
                Id = [int]$process.Id
                Path = [string]$process.Path
                ProcessName = [string]$process.ProcessName
                LocalPort = [int]$connection.LocalPort
            }
        } catch {
            $owners += [pscustomobject]@{
                Id = [int]$connection.OwningProcess
                Path = $null
                ProcessName = $null
                LocalPort = [int]$connection.LocalPort
            }
        }
    }
    return @($owners)
}

function Test-CdpOwnerMatchesApp {
    param($Owner, $App)
    if (-not $Owner.Path) { return $false }
    if ($App.Kind -eq "Win32") {
        try {
            return (Get-HeiGeFullPath -Path ([string]$Owner.Path)).Equals(
                (Get-HeiGeFullPath -Path ([string]$App.ExecutablePath)),
                [System.StringComparison]::OrdinalIgnoreCase
            )
        } catch {
            return $false
        }
    }
    if ($App.Kind -eq "StoreAlias" -or $App.Kind -eq "StoreAumid") {
        return Test-HeiGePathWithin -Root ([string]$App.InstallPath) -Path ([string]$Owner.Path)
    }
    return $false
}

function Get-CdpOwner {
    param(
        [Parameter(Mandatory = $true)][ValidateRange(1, 65535)][int]$Port,
        $App,
        [scriptblock]$ProcessProvider
    )
    $rawOwners = if ($ProcessProvider) { @(& $ProcessProvider $Port) } else { @(Get-DefaultCdpOwners -Port $Port) }
    $owners = @()
    foreach ($owner in $rawOwners) {
        if ($owner.PSObject.Properties.Name -contains "LocalPort" -and [int]$owner.LocalPort -ne $Port) { continue }
        $pidValue = if ($owner.PSObject.Properties.Name -contains "Id") { $owner.Id } else { $owner.OwningProcess }
        if (-not $pidValue) { continue }
        $owners += [pscustomobject][ordered]@{
            Id = [int]$pidValue
            Path = [string]$owner.Path
            ProcessName = [string]$owner.ProcessName
            LocalPort = $Port
        }
    }
    if ($owners.Count -eq 0) { throw "未找到 CDP 端口 $Port 的本机监听进程。" }
    $ownerGroups = @($owners | Group-Object Id)
    if ($ownerGroups.Count -gt 1) { throw "CDP 端口 $Port 的监听进程不唯一。" }
    $paths = @($ownerGroups[0].Group | ForEach-Object {
        if ($_.Path) { Get-HeiGeFullPath -Path ([string]$_.Path) } else { "<null>" }
    } | Sort-Object -Unique)
    if ($paths.Count -ne 1) { throw "CDP 端口 $Port 的同一 PID 存在冲突路径记录。" }
    $owner = $ownerGroups[0].Group | Sort-Object Path, ProcessName | Select-Object -First 1
    if (-not $App) { $App = Resolve-CodexApp }
    if (-not (Test-CdpOwnerMatchesApp -Owner $owner -App $App)) {
        throw "CDP 端口不属于已解析的 Codex：$Port"
    }
    return $owner
}

function Test-CdpEndpoint {
    param([int]$Port)
    # 禁止走 Invoke-RestMethod：系统代理可能弹出凭据/确认框，双击安装时表现为
    # 「卡在商店版激活后，不按回车就不继续」。本机 CDP 必须直连、无代理、短超时。
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        try {
            $async = $tcp.BeginConnect("127.0.0.1", [int]$Port, $null, $null)
            if (-not $async.AsyncWaitHandle.WaitOne(400, $false)) {
                return $false
            }
            $tcp.EndConnect($async)
        } finally {
            $tcp.Close()
        }
    } catch {
        return $false
    }

    $request = $null
    $response = $null
    try {
        $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/json/version")
        $request.Method = "GET"
        $request.Timeout = 800
        $request.ReadWriteTimeout = 800
        $request.Proxy = [System.Net.GlobalProxySelection]::GetEmptyWebProxy()
        $request.KeepAlive = $false
        $response = $request.GetResponse()
        return $true
    } catch {
        return $false
    } finally {
        if ($null -ne $response) { $response.Close() }
        if ($null -ne $request) { $request.Abort() }
    }
}

function Test-Cdp {
    param([int]$Port, $App)
    if (-not (Test-CdpEndpoint -Port $Port)) { return $false }
    try {
        if (-not $App) { $App = Resolve-CodexApp }
        Get-CdpOwner -Port $Port -App $App | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Get-RunningCodex {
    param(
        $AppInfo,
        [AllowNull()][string]$AppPath,
        [scriptblock]$ProcessProvider
    )
    if (-not $AppInfo) {
        if (-not $AppPath) { throw "Get-RunningCodex 需要结构化 AppInfo 或 AppPath。" }
        if ($AppPath -like "aumid:*") {
            $AppInfo = Resolve-CodexApp
            if ($AppInfo.Kind -ne "StoreAumid" -or $AppInfo.Aumid -cne $AppPath.Substring(6)) {
                throw "AppPath 与当前解析的 Windows Store 应用不匹配。"
            }
        } else {
            $AppInfo = Resolve-CodexApp -OverridePath $AppPath
        }
    }
    if (-not $ProcessProvider) {
        $ProcessProvider = { @(Get-Process -Name "ChatGPT", "Codex" -ErrorAction SilentlyContinue) }
    }
    $matches = @()
    foreach ($process in @(& $ProcessProvider)) {
        try {
            $path = [string]$process.Path
        } catch {
            continue
        }
        if (-not $path) { continue }
        $owner = [pscustomobject]@{
            Id = [int]$process.Id
            Path = $path
            ProcessName = [string]$process.ProcessName
        }
        if (Test-CdpOwnerMatchesApp -Owner $owner -App $AppInfo) { $matches += $process }
    }
    return @($matches | Sort-Object Id -Unique)
}

function Get-HeiGeOwnedCodexMainProcesses {
    param(
        [Parameter(Mandatory = $true)]$AppInfo,
        [scriptblock]$ProcessProvider
    )
    $running = @(Get-RunningCodex -AppInfo $AppInfo -ProcessProvider $ProcessProvider)
    if ($running.Count -eq 0) { return @() }
    $byId = @{}
    foreach ($process in $running) { $byId[[int]$process.Id] = $process }
    $records = @(Get-CimInstance -ClassName Win32_Process `
        -Filter "Name='ChatGPT.exe' OR Name='Codex.exe'" -ErrorAction Stop)
    $mains = @()
    foreach ($record in $records) {
        $processId = [int]$record.ProcessId
        if (-not $byId.ContainsKey($processId)) { continue }
        $parentId = [int]$record.ParentProcessId
        if (-not $byId.ContainsKey($parentId)) {
            $mains += $byId[$processId]
        }
    }
    if ($mains.Count -eq 0) { $mains = @($running) }
    return @($mains | Sort-Object Id -Unique)
}

function Initialize-HeiGeWindowActivationType {
    if ("HeiGe.WindowActivation" -as [type]) { return }
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace HeiGe {
  public static class WindowActivation {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int dwProcessId);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    public const int SW_RESTORE = 9;
    public const int SW_SHOW = 5;
    public const int ASFW_ANY = -1;

    public static List<IntPtr> FindVisibleWindows(int[] processIds) {
      var wanted = new HashSet<uint>();
      if (processIds != null) {
        foreach (var id in processIds) {
          if (id > 0) wanted.Add((uint)id);
        }
      }
      var found = new List<IntPtr>();
      if (wanted.Count == 0) return found;
      EnumWindows((hWnd, lParam) => {
        if (!IsWindowVisible(hWnd)) return true;
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        if (wanted.Contains(pid)) found.Add(hWnd);
        return true;
      }, IntPtr.Zero);
      return found;
    }

    public static bool ForceForeground(IntPtr hWnd) {
      if (hWnd == IntPtr.Zero) return false;
      AllowSetForegroundWindow(ASFW_ANY);
      ShowWindowAsync(hWnd, SW_RESTORE);
      ShowWindow(hWnd, SW_SHOW);
      if (SetForegroundWindow(hWnd)) return true;
      var foreground = GetForegroundWindow();
      if (foreground == IntPtr.Zero) return SetForegroundWindow(hWnd);
      uint ignoredPid;
      uint foregroundThread = GetWindowThreadProcessId(foreground, out ignoredPid);
      uint targetThread = GetWindowThreadProcessId(hWnd, out ignoredPid);
      uint currentThread = GetCurrentThreadId();
      bool attachedFront = false;
      bool attachedTarget = false;
      try {
        if (foregroundThread != 0 && foregroundThread != currentThread) {
          attachedFront = AttachThreadInput(currentThread, foregroundThread, true);
        }
        if (targetThread != 0 && targetThread != currentThread && targetThread != foregroundThread) {
          attachedTarget = AttachThreadInput(currentThread, targetThread, true);
        }
        return SetForegroundWindow(hWnd);
      } finally {
        if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
        if (attachedFront) AttachThreadInput(currentThread, foregroundThread, false);
      }
    }
  }
}
"@ | Out-Null
}

function Show-HeiGeCodexWindow {
    # Best-effort：把已在跑的 Codex 主窗口拉到前台。商店版冷启动常在后台，
    # 不点任务栏时注入会长时间静默，看起来像「要点一下才继续」。
    # 注意：不要对已带 CDP 参数的商店实例再发无参 ActivateApplication，
    # 否则可能被无调试会话接管，反而把换肤打挂。
    param(
        [Parameter(Mandatory = $true)]$AppInfo,
        [scriptblock]$ProcessProvider
    )
    Initialize-HeiGeWindowActivationType
    $mains = @(Get-HeiGeOwnedCodexMainProcesses -AppInfo $AppInfo -ProcessProvider $ProcessProvider)
    $processIds = @($mains | ForEach-Object { [int]$_.Id } | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
    $handles = New-Object System.Collections.Generic.List[IntPtr]
    foreach ($process in $mains) {
        try {
            $handle = [IntPtr]$process.MainWindowHandle
            if ($handle -ne [IntPtr]::Zero) { $handles.Add($handle) | Out-Null }
        } catch {}
    }
    try {
        foreach ($handle in @([HeiGe.WindowActivation]::FindVisibleWindows([int[]]$processIds))) {
            if (-not $handles.Contains($handle)) { $handles.Add($handle) | Out-Null }
        }
    } catch {}

    $shown = $false
    foreach ($handle in $handles) {
        try {
            if ([HeiGe.WindowActivation]::ForceForeground($handle)) { $shown = $true }
        } catch {}
    }
    return $shown
}

function Test-HeiGeCodexMainRenderer {
    param([ValidateRange(1024, 65535)][int]$Port = 9341)
    $request = $null
    $response = $null
    try {
        $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/json/list")
        $request.Method = "GET"
        $request.Timeout = 800
        $request.ReadWriteTimeout = 800
        $request.Proxy = [System.Net.GlobalProxySelection]::GetEmptyWebProxy()
        $request.KeepAlive = $false
        $response = $request.GetResponse()
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        try {
            $json = $reader.ReadToEnd()
        } finally {
            $reader.Close()
        }
        $targets = @(ConvertFrom-Json -InputObject $json)
        return @($targets | Where-Object {
            [string]$_.type -ceq "page" -and [string]$_.url -ceq "app://-/index.html"
        }).Count -gt 0
    } catch {
        return $false
    } finally {
        if ($null -ne $response) { $response.Close() }
        if ($null -ne $request) { $request.Abort() }
    }
}

function Wait-HeiGeCodexMainRenderer {
    # CDP 端口先开、主窗口 renderer 后到。等待期间主动拉前台，避免用户手工点任务栏。
    param(
        [ValidateRange(1024, 65535)][int]$Port = 9341,
        [Parameter(Mandatory = $true)]$AppInfo,
        [ValidateRange(1, 180)][int]$TimeoutSeconds = 45,
        [scriptblock]$ProcessProvider,
        [scriptblock]$SleepProvider,
        [scriptblock]$MainRendererProvider,
        [scriptblock]$ShowWindowProvider
    )
    if (-not $SleepProvider) {
        $SleepProvider = { param($Milliseconds) Start-Sleep -Milliseconds $Milliseconds }
    }
    if (-not $MainRendererProvider) {
        $MainRendererProvider = { param($RendererPort) Test-HeiGeCodexMainRenderer -Port $RendererPort }
    }
    if (-not $ShowWindowProvider) {
        $ShowWindowProvider = {
            param($Info)
            Show-HeiGeCodexWindow -AppInfo $Info -ProcessProvider $ProcessProvider
        }
    }

    $attempts = [Math]::Max(1, $TimeoutSeconds * 4)
    Write-Host "等待 Codex 主窗口就绪（无需点击，请稍候）……"
    for ($i = 0; $i -lt $attempts; $i++) {
        if ([bool](& $MainRendererProvider $Port)) {
            & $ShowWindowProvider $AppInfo | Out-Null
            Write-Host "Codex 主窗口已就绪。"
            return [pscustomobject][ordered]@{
                Ready = $true
                Attempts = ($i + 1)
            }
        }
        if (($i % 8) -eq 0) {
            & $ShowWindowProvider $AppInfo | Out-Null
        }
        if (($i + 1) % 8 -eq 0) {
            Write-Host ("仍在等待主窗口… {0}/{1}（约 {2} 秒）" -f `
                ($i + 1), $attempts, [int](($i + 1) * 0.25))
        }
        & $SleepProvider 250 | Out-Null
    }
    throw @"
调试端口 $Port 已开放，但等不到 Codex 主窗口 renderer（app://-/index.html）。
请确认 Codex 主界面已出现（不是仅托盘图标）；若窗口在后台，可点任务栏 Codex 一次后重试。
"@
}

function Stop-CodexNormally {
    param(
        [Parameter(Mandatory = $true)]$AppInfo,
        [ValidateRange(1, 120)][int]$TimeoutSeconds = 15,
        [scriptblock]$ProcessProvider,
        [scriptblock]$CloseProvider,
        [scriptblock]$StopProvider,
        [scriptblock]$SleepProvider
    )
    if (-not $CloseProvider) {
        $CloseProvider = { param($Process) $Process.CloseMainWindow() | Out-Null }
    }
    if (-not $StopProvider) {
        $StopProvider = {
            param($Process)
            Stop-Process -Id ([int]$Process.Id) -Force -ErrorAction Stop
        }
    }
    if (-not $SleepProvider) {
        $SleepProvider = { param($Milliseconds) Start-Sleep -Milliseconds $Milliseconds }
    }
    $running = @(Get-RunningCodex -AppInfo $AppInfo -ProcessProvider $ProcessProvider)
    if ($running.Count -eq 0) {
        return [pscustomobject][ordered]@{
            Closed = $false
            AlreadyStopped = $true
            VerifiedStopped = $true
            Escalated = $false
        }
    }

    # Prefer CloseMainWindow when a real HWND exists. Store/Electron Codex often has
    # MainWindowHandle=0 (tray-only), so that path is a no-op and must escalate.
    $windowed = @($running | Where-Object {
        $null -ne $_.MainWindowHandle -and $_.MainWindowHandle -ne [IntPtr]::Zero
    })
    foreach ($process in $windowed) { & $CloseProvider $process | Out-Null }

    # No HWND means CloseMainWindow cannot succeed; only wait briefly before escalate.
    $gracefulAttempts = if ($windowed.Count -eq 0) {
        [Math]::Min($TimeoutSeconds * 4, 8)
    } else {
        $TimeoutSeconds * 4
    }
    for ($attempt = 0; $attempt -lt $gracefulAttempts; $attempt++) {
        if (@(Get-RunningCodex -AppInfo $AppInfo -ProcessProvider $ProcessProvider).Count -eq 0) {
            return [pscustomobject][ordered]@{
                Closed = $true
                AlreadyStopped = $false
                VerifiedStopped = $true
                Escalated = $false
            }
        }
        if ($attempt -lt ($gracefulAttempts - 1)) { & $SleepProvider 250 | Out-Null }
    }

    Write-Host "Codex 未响应窗口关闭（商店版托盘常见），改为结束已归属主进程……"
    $mains = @(Get-HeiGeOwnedCodexMainProcesses -AppInfo $AppInfo -ProcessProvider $ProcessProvider)
    foreach ($process in $mains) { & $StopProvider $process | Out-Null }

    $attempts = $TimeoutSeconds * 4
    for ($attempt = 0; $attempt -lt $attempts; $attempt++) {
        if (@(Get-RunningCodex -AppInfo $AppInfo -ProcessProvider $ProcessProvider).Count -eq 0) {
            return [pscustomobject][ordered]@{
                Closed = $true
                AlreadyStopped = $false
                VerifiedStopped = $true
                Escalated = $true
            }
        }
        if ($attempt -lt ($attempts - 1)) { & $SleepProvider 250 | Out-Null }
    }
    throw @"
Codex 仍在运行，无法自动正常退出（可能最小化到了托盘，或有任务正在进行）。
请手动彻底退出 Codex（托盘图标右键退出，或任务管理器结束已归属的 ChatGPT/Codex 进程），再重试。
"@
}

function Start-CodexNative {
    param(
        [Parameter(Mandatory = $true)]$AppInfo,
        [scriptblock]$StartProvider,
        [scriptblock]$ActivationProvider
    )
    if ($AppInfo.Kind -eq "StoreAumid") {
        if (-not $AppInfo.Aumid) { throw "Windows Store 应用缺少 AUMID。" }
        if ($ActivationProvider) { return & $ActivationProvider $AppInfo.Aumid "" }
        return Start-CodexViaActivation -Aumid $AppInfo.Aumid -Arguments ""
    }
    if ($AppInfo.Kind -ne "Win32" -and $AppInfo.Kind -ne "StoreAlias") {
        throw "不支持的 Codex 启动类型：$($AppInfo.Kind)"
    }
    if (-not $AppInfo.ExecutablePath -or
        -not (Test-Path -LiteralPath $AppInfo.ExecutablePath -PathType Leaf)) {
        throw "Codex 启动文件不存在：$($AppInfo.ExecutablePath)"
    }
    if ($StartProvider) { return & $StartProvider $AppInfo.ExecutablePath @() }
    return Start-Process -FilePath $AppInfo.ExecutablePath -PassThru
}

function Start-CodexWithCdp {
    param(
        [ValidateRange(1024, 65535)][int]$Port = 9341,
        $AppInfo,
        [scriptblock]$SleepProvider,
        [scriptblock]$MainRendererProvider,
        [scriptblock]$ShowWindowProvider
    )
    $ProgressPreference = "SilentlyContinue"
    if (-not $AppInfo) { $AppInfo = Resolve-CodexApp }
    $app = if ($AppInfo.Kind -eq "StoreAumid") { "aumid:$($AppInfo.Aumid)" } else { $AppInfo.ExecutablePath }
    $finish = {
        Wait-HeiGeCodexMainRenderer -Port $Port -AppInfo $AppInfo `
            -SleepProvider $SleepProvider `
            -MainRendererProvider $MainRendererProvider `
            -ShowWindowProvider $ShowWindowProvider | Out-Null
    }
    if (Test-CdpEndpoint -Port $Port) {
        Get-CdpOwner -Port $Port -App $AppInfo | Out-Null
        Write-Host ("调试端口 {0} 已就绪。" -f $Port)
        & $finish
        return
    }
    $running = @(Get-RunningCodex -AppInfo $AppInfo)
    if ($running) {
        Write-Host "正在正常退出 Codex，以调试端口重新打开……"
        Stop-CodexNormally -AppInfo $AppInfo | Out-Null
    }

    $isStore = $app -like "aumid:*"
    $launchAttempts = if ($isStore) { 2 } else { 1 }
    for ($launch = 1; $launch -le $launchAttempts; $launch++) {
        try {
            if ($isStore) {
                Write-Host "商店版没有执行别名，改用系统激活接口带参启动……"
                Write-Host "正在激活 Codex（无需按键，请稍候）……"
                $activatedPid = Start-CodexViaActivation -Aumid $app.Substring(6) `
                    -Arguments "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$Port"
                Write-Host ("已发出激活请求（PID {0}），等待调试端口 {1} 开放……" -f $activatedPid, $Port)
            } else {
                Start-Process -FilePath $app -ArgumentList @(
                    "--remote-debugging-address=127.0.0.1",
                    "--remote-debugging-port=$Port"
                )
                Write-Host ("已启动 Codex，等待调试端口 {0} 开放……" -f $Port)
            }
        } catch {
            throw @"
启动 Codex 失败：$app
系统报错：$($_.Exception.Message)
常见原因与解法：
1. 正在用内置 Administrator 账户：系统默认禁止该账户启动商店版应用，请换普通用户账户运行。
2. 安装位置特殊：命令行执行 setx HEIGE_CODEX_APP "完整exe路径"，关掉窗口重开再试。
3. 商店版反复失败：改装官方独立版（非商店版）客户端最稳。
本脚本不需要管理员权限，用普通权限的命令行运行即可。
"@
        }
        $waitAttempts = 80
        for ($i = 0; $i -lt $waitAttempts; $i++) {
            if (Test-CdpEndpoint -Port $Port) {
                Get-CdpOwner -Port $Port -App $AppInfo | Out-Null
                Write-Host ("调试端口 {0} 已就绪。" -f $Port)
                & $finish
                return
            }
            if (($i + 1) % 8 -eq 0) {
                Write-Host ("仍在等待调试端口 {0}… {1}/{2}（约 {3} 秒）" -f `
                    $Port, ($i + 1), $waitAttempts, [int](($i + 1) * 0.25))
            }
            Start-Sleep -Milliseconds 250
        }

        $flagged = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe' or Name='Codex.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.CommandLine -match "remote-debugging-port" -and
                -not (Test-HeiGeCodexInternalBackendPath -Path ([string]$_.ExecutablePath))
            })
        if ($flagged.Count -gt 0) {
            throw @"
Codex 已带调试参数启动，但端口 $Port 未开放：当前 Codex 版本或本机 MSIX 会话可能禁用了本机调试端口。
建议：改装官方独立版（非 Microsoft Store）客户端后重试；若必须使用商店版，请附 doctor 输出与 Codex 版本号到 https://github.com/HeiGeAi/heige-codex-skin-studio/issues 反馈。
"@
        }
        if ($launch -lt $launchAttempts) {
            Write-Host "商店版激活未带上调试参数，正在再次退出并重试……"
            Stop-CodexNormally -AppInfo $AppInfo | Out-Null
            continue
        }
        throw @"
调试参数未生效：可能被残留的旧实例接管，或商店版激活没把参数传进应用。
请彻底退出 Codex（任务管理器确认无 ChatGPT/Codex 进程）后重试；商店版反复失败请改装官方独立版，或开 Issue 附报错原文。
"@
    }
}

function Restart-CodexWithoutCdp {
    param(
        [Parameter(Mandatory = $true)]$AppInfo,
        [ValidateRange(1024, 65535)][int]$Port = 9341,
        [scriptblock]$SleepProvider
    )
    if (-not $SleepProvider) {
        $SleepProvider = { param($Milliseconds) Start-Sleep -Milliseconds $Milliseconds }
    }
    Get-CdpOwner -Port $Port -App $AppInfo | Out-Null
    Stop-CodexNormally -AppInfo $AppInfo | Out-Null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        if (-not (Test-CdpEndpoint -Port $Port)) { break }
        if ($attempt -lt 19) { & $SleepProvider 250 | Out-Null }
    }
    if (Test-CdpEndpoint -Port $Port) {
        throw "Codex 正常退出后 CDP 端口仍未释放：$Port"
    }
    Start-CodexNative -AppInfo $AppInfo | Out-Null
    for ($attempt = 0; $attempt -lt 80; $attempt++) {
        if (@(Get-RunningCodex -AppInfo $AppInfo).Count -gt 0) {
            if (Test-CdpEndpoint -Port $Port) {
                throw "Codex 未以默认前端模式启动：CDP 端口 $Port 仍然开放。"
            }
            return [pscustomobject][ordered]@{
                Restarted = $true
                NativeMode = $true
                CdpReleased = $true
            }
        }
        if ($attempt -lt 79) { & $SleepProvider 250 | Out-Null }
    }
    throw "Codex 已发起默认前端启动，但未在 20 秒内看到精确归属的运行进程。"
}

function Invoke-HeiGeRestartCodexIntoCdp {
    param(
        [ValidateRange(1024, 65535)][int]$Port = 9341,
        [Parameter(Mandatory = $true)][ValidateRange(1, [int]::MaxValue)][int]$ExpectedPid,
        [Parameter(Mandatory = $true)][string]$ExpectedExecutablePath,
        [Parameter(Mandatory = $true)][string]$ExpectedStartedAt,
        [Parameter(Mandatory = $true)]$AppInfo,
        [scriptblock]$ProcessProvider,
        [scriptblock]$StopProvider,
        [scriptblock]$CloseProvider,
        [scriptblock]$SleepProvider,
        [scriptblock]$StartCdpProvider
    )
    if ([string]::IsNullOrWhiteSpace($ExpectedExecutablePath)) {
        throw "restart-into-cdp 缺少期望的可执行路径。"
    }
    if ([string]::IsNullOrWhiteSpace($ExpectedStartedAt)) {
        throw "restart-into-cdp 缺少期望的进程启动时间。"
    }
    $expectedPath = Get-HeiGeFullPath -Path $ExpectedExecutablePath
    $running = @(Get-RunningCodex -AppInfo $AppInfo -ProcessProvider $ProcessProvider)
    $matched = @($running | Where-Object { [int]$_.Id -eq $ExpectedPid })
    if ($matched.Count -ne 1) {
        throw "期望的原生 Codex 进程已不存在，拒绝 restart-into-cdp。"
    }
    $live = $matched[0]
    $livePath = Get-HeiGeFullPath -Path ([string]$live.Path)
    if ($livePath.ToLowerInvariant() -cne $expectedPath.ToLowerInvariant()) {
        throw "期望的原生 Codex 进程路径已变化，拒绝 restart-into-cdp。"
    }
    $liveStarted = $live.StartTime.ToUniversalTime().ToString("o")
    if ($liveStarted -cne $ExpectedStartedAt) {
        throw "期望的原生 Codex 进程启动时间已变化，拒绝 restart-into-cdp。"
    }
    if (Test-CdpEndpoint -Port $Port) {
        $alreadyOwned = $false
        try {
            Get-CdpOwner -Port $Port -App $AppInfo | Out-Null
            $alreadyOwned = $true
        } catch {
            $alreadyOwned = $false
        }
        if ($alreadyOwned) {
            throw "Codex 已占用调试端口，拒绝对原生进程执行 restart-into-cdp。"
        }
    }
    $stopArgs = @{ AppInfo = $AppInfo }
    if ($ProcessProvider) { $stopArgs.ProcessProvider = $ProcessProvider }
    if ($StopProvider) { $stopArgs.StopProvider = $StopProvider }
    if ($CloseProvider) { $stopArgs.CloseProvider = $CloseProvider }
    if ($SleepProvider) { $stopArgs.SleepProvider = $SleepProvider }
    Stop-CodexNormally @stopArgs | Out-Null
    if ($StartCdpProvider) {
        & $StartCdpProvider $AppInfo $Port | Out-Null
    } else {
        $startArgs = @{ Port = $Port; AppInfo = $AppInfo }
        if ($SleepProvider) { $startArgs.SleepProvider = $SleepProvider }
        Start-CodexWithCdp @startArgs | Out-Null
    }
    return [pscustomobject][ordered]@{
        Restarted = $true
        CdpMode = $true
        Port = $Port
    }
}
