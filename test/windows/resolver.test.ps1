$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "TestHelpers.ps1")
$script:RepositoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
. (Join-Path $script:RepositoryRoot "scripts\windows\lib\common.ps1")

$script:OriginalLocalAppData = $env:LOCALAPPDATA
$script:Root = Join-Path ([System.IO.Path]::GetTempPath()) ("HeiGe Windows 中文 " + [guid]::NewGuid().ToString("N"))
$script:LocalAppData = Join-Path $script:Root "Local App Data 中文"
$env:LOCALAPPDATA = $script:LocalAppData
New-Item -ItemType Directory -Path $script:LocalAppData -Force | Out-Null

$script:Package1Root = Join-Path $script:Root "WindowsApps\OpenAI.Codex_1.9.0.0_x64__8wekyb3d8bbwe"
$script:Package2Root = Join-Path $script:Root "WindowsApps\OpenAI.Codex_2.0.0.0_x64__8wekyb3d8bbwe"
$script:CodexExe = Join-Path $script:Package2Root "app\Codex.exe"
New-Item -ItemType Directory -Path (Split-Path $script:CodexExe -Parent) -Force | Out-Null
New-Item -ItemType File -Path $script:CodexExe -Force | Out-Null

$script:Packages = @(
    [pscustomobject]@{
        Name = "OpenAI.Codex"
        Publisher = "CN=OpenAI"
        IsFramework = $false
        SignatureKind = "Store"
        Version = [version]"1.9.0.0"
        PackageFullName = "OpenAI.Codex_1.9.0.0_x64__8wekyb3d8bbwe"
        PackageFamilyName = "OpenAI.Codex_8wekyb3d8bbwe"
        InstallLocation = $script:Package1Root
        Applications = @([pscustomobject]@{
            Id = "App"
            Executable = "app\Codex.exe"
            ExecutionAliases = @("Codex.exe")
        })
    },
    [pscustomobject]@{
        Name = "OpenAI.Codex"
        Publisher = "CN=OpenAI"
        IsFramework = $false
        SignatureKind = "Store"
        Version = [version]"2.0.0.0"
        PackageFullName = "OpenAI.Codex_2.0.0.0_x64__8wekyb3d8bbwe"
        PackageFamilyName = "OpenAI.Codex_8wekyb3d8bbwe"
        InstallLocation = $script:Package2Root
        Applications = @([pscustomobject]@{
            Id = "App"
            Executable = "app\Codex.exe"
            ExecutionAliases = @("Codex.exe")
        })
    }
)

$script:StoreApp = [pscustomobject]@{
    Kind = "StoreAumid"
    ExecutablePath = $null
    InstallPath = $script:Package2Root
    ProductName = "Codex"
    PackageFullName = $script:Packages[1].PackageFullName
    Aumid = "$($script:Packages[1].PackageFamilyName)!App"
}

$script:Win32Root = Join-Path $script:LocalAppData "Programs\Codex\app-1.10.0"
$script:Win32Exe = Join-Path $script:Win32Root "Codex.exe"
New-Item -ItemType Directory -Path $script:Win32Root -Force | Out-Null
New-Item -ItemType File -Path $script:Win32Exe -Force | Out-Null
$script:Win32App = [pscustomobject]@{
    Kind = "Win32"
    ExecutablePath = $script:Win32Exe
    InstallPath = $script:Win32Root
    ProductName = "Codex"
    PackageFullName = $null
    Aumid = $null
}
$script:SystemNode = Join-Path $script:Root "System Node 中文\node.exe"
New-Item -ItemType Directory -Path (Split-Path $script:SystemNode -Parent) -Force | Out-Null
New-Item -ItemType File -Path $script:SystemNode -Force | Out-Null

try {
    Test-Case "Store selection is independent of enumeration order" {
        $forward = Select-CodexStorePackage -Packages $script:Packages -InstallPath $script:CodexExe
        $reverse = Select-CodexStorePackage -Packages @($script:Packages[1], $script:Packages[0]) -InstallPath $script:CodexExe
        Assert-Equal $forward.PackageFullName $reverse.PackageFullName
        Assert-Equal "OpenAI.Codex_2.0.0.0_x64__8wekyb3d8bbwe" $forward.PackageFullName
    }

    Test-Case "Dual Store packages without path evidence fail" {
        Assert-Throws { Select-CodexStorePackage -Packages $script:Packages -InstallPath $null } "Windows Store 包选择不唯一"
    }

    Test-Case "Store package containment uses a path boundary" {
        $outside = "$($script:Package2Root)-foreign\app\Codex.exe"
        Assert-Throws { Select-CodexStorePackage -Packages $script:Packages -InstallPath $outside } "Windows Store 包"
    }

    Test-Case "Side loaded lookalike packages are not trusted" {
        $lookalike = [pscustomobject]@{
            Name = "OpenAI.Codex"
            IsFramework = $false
            SignatureKind = "Developer"
            InstallLocation = (Join-Path $script:Root "Lookalike")
        }
        Assert-Throws { Select-CodexStorePackage -Packages @($lookalike) -InstallPath $null } "未找到可信"
    }

    Test-Case "Explicit Win32 override returns a structured app" {
        $app = Resolve-CodexApp -OverridePath $script:Win32Exe -Packages @() -ProcessProvider { @() }
        Assert-Equal "Win32" $app.Kind
        Assert-Equal $script:Win32Exe $app.ExecutablePath
        Assert-Equal $script:Win32Root $app.InstallPath
        Assert-Equal @("Kind", "ExecutablePath", "InstallPath", "ProductName", "PackageFullName", "Aumid") @($app.PSObject.Properties.Name)
    }

    Test-Case "Structured app result rejects non-string nullable identity fields" {
        foreach ($case in @(
            [pscustomobject]@{ Name = "ExecutablePath"; ExecutablePath = 7; PackageFullName = $null; Aumid = $null },
            [pscustomobject]@{ Name = "PackageFullName"; ExecutablePath = $script:Win32Exe; PackageFullName = 7; Aumid = $null },
            [pscustomobject]@{ Name = "Aumid"; ExecutablePath = $script:Win32Exe; PackageFullName = $null; Aumid = 7 }
        )) {
            Assert-Throws {
                New-CodexAppResult -Kind "Win32" -ExecutablePath $case.ExecutablePath `
                    -InstallPath $script:Win32Root -ProductName "Codex" `
                    -PackageFullName $case.PackageFullName -Aumid $case.Aumid
            } "$($case.Name) must be a string or null"
        }
    }

    Test-Case "Immutable app identity round-trips and rebinds the same closed Win32 install" {
        $app = Resolve-CodexApp -OverridePath $script:Win32Exe -Packages @() -ProcessProvider { @() }
        $token = ConvertTo-HeiGeCodexAppIdentityToken -App $app
        $decoded = ConvertFrom-HeiGeCodexAppIdentityToken -IdentityToken $token
        Assert-Equal ($app | ConvertTo-Json -Depth 8 -Compress) `
            ($decoded | ConvertTo-Json -Depth 8 -Compress)
        $bound = Resolve-HeiGeBoundCodexApp -IdentityToken $token -Packages @()
        Assert-Equal $app.ExecutablePath $bound.ExecutablePath
    }

    Test-Case "PowerShell and Node share one canonical identity token for non-ASCII user paths" {
        $unicodeExe = Join-Path $script:Root "用户 空格\Codex.exe"
        New-Item -ItemType Directory -Path (Split-Path $unicodeExe -Parent) -Force | Out-Null
        New-Item -ItemType File -Path $unicodeExe -Force | Out-Null
        $app = Resolve-CodexApp -OverridePath $unicodeExe -Packages @() -ProcessProvider { @() }
        $token = ConvertTo-HeiGeCodexAppIdentityToken -App $app
        $nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
        $nodePath = [string]$nodeCommand.Path
        $runtimeModule = Join-Path $script:RepositoryRoot "src\windows-runtime.mjs"
        $nodeHelper = Join-Path $script:Root "identity-token-helper.mjs"
        $nodeScript = @'
import { pathToFileURL } from "node:url";
const { decodeWindowsAppIdentityToken } = await import(pathToFileURL(process.argv[2]).href);
const app = decodeWindowsAppIdentityToken(process.argv[3]);
process.stdout.write(JSON.stringify(app));
'@
        [System.IO.File]::WriteAllText($nodeHelper, $nodeScript, [System.Text.UTF8Encoding]::new($false))
        $json = & $nodePath $nodeHelper $runtimeModule $token 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Node rejected the canonical PowerShell identity token: $($json -join "`n")"
        }
        $decoded = ($json -join "`n") | ConvertFrom-Json
        Assert-Equal "Win32" $decoded.kind
        Assert-Equal $unicodeExe $decoded.executablePath
        Assert-Equal (Split-Path $unicodeExe -Parent) $decoded.installPath
    }

    Test-Case "Immutable app identity rebinds an exact custom closed Win32 install" {
        $customExe = Join-Path $script:Root "Portable Custom Codex\Codex.exe"
        New-Item -ItemType Directory -Path (Split-Path $customExe -Parent) -Force | Out-Null
        New-Item -ItemType File -Path $customExe -Force | Out-Null
        $custom = Resolve-CodexApp -OverridePath $customExe -Packages $script:Packages `
            -ProcessProvider { @() }
        $token = ConvertTo-HeiGeCodexAppIdentityToken -App $custom
        $bound = Resolve-HeiGeBoundCodexApp -IdentityToken $token `
            -Packages $script:Packages
        Assert-Equal "Win32" $bound.Kind
        Assert-Equal $customExe $bound.ExecutablePath
    }

    Test-Case "Immutable Store identity selects its exact closed package despite Win32 and another Store install" {
        $token = ConvertTo-HeiGeCodexAppIdentityToken -App $script:StoreApp
        $bound = Resolve-HeiGeBoundCodexApp -IdentityToken $token `
            -Packages $script:Packages
        Assert-Equal "StoreAumid" $bound.Kind
        Assert-Equal $script:Packages[1].PackageFullName $bound.PackageFullName
        Assert-Equal $script:Package2Root $bound.InstallPath
        Assert-Equal "$($script:Packages[1].PackageFamilyName)!App" $bound.Aumid
    }

    Test-Case "Immutable Store identity fails closed after its exact package disappears or updates" {
        $token = ConvertTo-HeiGeCodexAppIdentityToken -App $script:StoreApp
        Assert-Throws {
            Resolve-HeiGeBoundCodexApp -IdentityToken $token `
                -Packages @($script:Packages[0])
        } "不可变身份"

        $updatedRoot = Join-Path $script:Root "WindowsApps\OpenAI.Codex_2.1.0.0_x64__8wekyb3d8bbwe"
        $updatedPackage = [pscustomobject]@{
            Name = "OpenAI.Codex"
            Publisher = "CN=OpenAI"
            IsFramework = $false
            SignatureKind = "Store"
            Version = [version]"2.1.0.0"
            PackageFullName = "OpenAI.Codex_2.1.0.0_x64__8wekyb3d8bbwe"
            PackageFamilyName = $script:Packages[1].PackageFamilyName
            InstallLocation = $updatedRoot
            Applications = $script:Packages[1].Applications
        }
        Assert-Throws {
            Resolve-HeiGeBoundCodexApp -IdentityToken $token `
                -Packages @($updatedPackage)
        } "不可变身份"
    }

    Test-Case "Immutable Win32 selector does not drift to another installed Store package" {
        $win32 = Resolve-CodexApp -OverridePath $script:Win32Exe -Packages @() -ProcessProvider { @() }
        $token = ConvertTo-HeiGeCodexAppIdentityToken -App $win32
        $bound = Resolve-HeiGeBoundCodexApp -IdentityToken $token `
            -Packages @($script:Packages[1])
        Assert-Equal "Win32" $bound.Kind
        Assert-Equal $script:Win32Exe $bound.ExecutablePath
    }

    Test-Case "Immutable app identity rejects malformed and noncanonical tokens" {
        Assert-Throws {
            ConvertFrom-HeiGeCodexAppIdentityToken -IdentityToken "not-canonical+base64"
        } "身份 token"
    }

    Test-Case "Invalid explicit override fails without fallback" {
        $script:ProcessProviderCalled = $false
        Assert-Throws {
            Resolve-CodexApp -OverridePath (Join-Path $script:Root "missing.exe") -Packages $script:Packages -ProcessProvider {
                $script:ProcessProviderCalled = $true
                @([pscustomobject]@{ Path = $script:CodexExe; Id = 1 })
            }
        } "HEIGE_CODEX_APP"
        Assert-False $script:ProcessProviderCalled
    }

    Test-Case "Win32 app directory selection uses semantic version order" {
        $older = Join-Path $script:LocalAppData "Programs\Codex\app-1.9.0\Codex.exe"
        New-Item -ItemType Directory -Path (Split-Path $older -Parent) -Force | Out-Null
        New-Item -ItemType File -Path $older -Force | Out-Null
        $app = Resolve-CodexApp -OverridePath $null -Packages @() -ProcessProvider { @() }
        Assert-Equal $script:Win32Exe $app.ExecutablePath
    }

    Test-Case "Store process path selects one exact package regardless of order" {
        $app = Resolve-CodexApp -OverridePath $null -Packages @($script:Packages[1], $script:Packages[0]) -ProcessProvider {
            @([pscustomobject]@{ Path = $script:CodexExe; Id = 42; ProcessName = "Codex" })
        }
        Assert-Equal $script:Packages[1].PackageFullName $app.PackageFullName
        Assert-Equal "$($script:Packages[1].PackageFamilyName)!App" $app.Aumid
    }

    Test-Case "Store process path selects one exact application entry" {
        $package = [pscustomobject]@{
            Name = "OpenAI.Codex"
            Publisher = "CN=OpenAI"
            IsFramework = $false
            SignatureKind = "Store"
            PackageFullName = "OpenAI.Codex_multi_x64__8wekyb3d8bbwe"
            PackageFamilyName = "OpenAI.Codex_8wekyb3d8bbwe"
            InstallLocation = $script:Package2Root
            Applications = @(
                [pscustomobject]@{ Id = "Helper"; Executable = "helper\Codex.exe"; ExecutionAliases = @() },
                [pscustomobject]@{ Id = "Desktop"; Executable = "app\Codex.exe"; ExecutionAliases = @() }
            )
        }
        $app = Resolve-CodexApp -OverridePath $null -Packages @($package) -ProcessProvider {
            @([pscustomobject]@{ Path = $script:CodexExe; Id = 43; ProcessName = "Codex" })
        }
        Assert-Equal "OpenAI.Codex_8wekyb3d8bbwe!Desktop" $app.Aumid
        Assert-Throws { Select-CodexPackageApplication -Package $package -ProcessPath $null } "应用入口选择不唯一"
    }

    Test-Case "Mixed Store and Win32 process evidence fails regardless of order" {
        $forward = @(
            [pscustomobject]@{ Path = $script:CodexExe; Id = 44; ProcessName = "Codex" },
            [pscustomobject]@{ Path = $script:Win32Exe; Id = 45; ProcessName = "Codex" }
        )
        $reverse = @($forward[1], $forward[0])
        Assert-Throws { Resolve-CodexApp -OverridePath $null -Packages $script:Packages -ProcessProvider { $forward } } "进程归属不唯一"
        Assert-Throws { Resolve-CodexApp -OverridePath $null -Packages $script:Packages -ProcessProvider { $reverse } } "进程归属不唯一"
    }

    Test-Case "Store UI plus LOCALAPPDATA Codex bin backend is not treated as mixed installs" {
        $backend = Join-Path $script:LocalAppData "OpenAI\Codex\bin\deadbeef\codex.exe"
        New-Item -ItemType Directory -Path (Split-Path $backend -Parent) -Force | Out-Null
        New-Item -ItemType File -Path $backend -Force | Out-Null
        Assert-True (Test-HeiGeCodexInternalBackendPath -Path $backend)
        $processes = @(
            [pscustomobject]@{ Path = $script:CodexExe; Id = 44; ProcessName = "Codex" },
            [pscustomobject]@{ Path = $backend; Id = 45; ProcessName = "codex" }
        )
        $app = Resolve-CodexApp -OverridePath $null -Packages $script:Packages -ProcessProvider { $processes }
        Assert-Equal "StoreAumid" $app.Kind
        Assert-Equal $script:Package2Root $app.InstallPath
        Assert-False (Test-HeiGeCodexInternalBackendPath -Path $script:CodexExe)
        Assert-False (Test-HeiGeCodexInternalBackendPath -Path $script:Win32Exe)
    }

    Test-Case "Store alias is preferred when it exists" {
        $alias = Join-Path $script:LocalAppData ("Microsoft\WindowsApps\" + $script:Packages[1].PackageFamilyName + "\Codex.exe")
        New-Item -ItemType Directory -Path (Split-Path $alias -Parent) -Force | Out-Null
        New-Item -ItemType File -Path $alias -Force | Out-Null
        $app = Resolve-CodexApp -OverridePath $null -Packages $script:Packages -ProcessProvider {
            @([pscustomobject]@{ Path = $script:CodexExe; Id = 42; ProcessName = "Codex" })
        }
        Assert-Equal "StoreAlias" $app.Kind
        Assert-Equal $alias $app.ExecutablePath
        Remove-Item -LiteralPath $alias -Force
    }

    Test-Case "A root alias without selected package ownership is ignored" {
        $alias = Join-Path $script:LocalAppData "Microsoft\WindowsApps\Codex.exe"
        New-Item -ItemType Directory -Path (Split-Path $alias -Parent) -Force | Out-Null
        New-Item -ItemType File -Path $alias -Force | Out-Null
        $app = Resolve-CodexApp -OverridePath $null -Packages @($script:Packages[1]) -ProcessProvider {
            @([pscustomobject]@{ Path = $script:CodexExe; Id = 42; ProcessName = "Codex" })
        }
        Assert-Equal "StoreAumid" $app.Kind
        Assert-Equal $null $app.ExecutablePath
        Remove-Item -LiteralPath $alias -Force
    }

    Test-Case "Manifest aliases are namespace independent" {
        [xml]$uap3Manifest = @'
<Package xmlns="urn:schemas-microsoft-com:foundation/windows10" xmlns:uap3="http://schemas.microsoft.com/appx/manifest/uap/windows10/3" xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10">
  <Applications><Application Id="App" Executable="app\Codex.exe"><Extensions>
    <uap3:Extension Category="windows.appExecutionAlias"><uap3:AppExecutionAlias><desktop:ExecutionAlias Alias="Codex.exe" /></uap3:AppExecutionAlias></uap3:Extension>
  </Extensions></Application></Applications>
</Package>
'@
        [xml]$uap5Manifest = @'
<Package xmlns="urn:schemas-microsoft-com:foundation/windows10" xmlns:uap5="http://schemas.microsoft.com/appx/manifest/uap/windows10/5">
  <Applications><Application Id="App" Executable="app\Codex.exe"><Extensions>
    <uap5:Extension Category="windows.appExecutionAlias"><uap5:AppExecutionAlias><uap5:ExecutionAlias Alias="ChatGPT.exe" /></uap5:AppExecutionAlias></uap5:Extension>
  </Extensions></Application></Applications>
</Package>
'@
        $uap3Aliases = Get-CodexExecutionAliases -Package $script:Packages[1] -Application $uap3Manifest.Package.Applications.Application
        $uap5Aliases = Get-CodexExecutionAliases -Package $script:Packages[1] -Application $uap5Manifest.Package.Applications.Application
        Assert-Equal @("Codex.exe") @($uap3Aliases)
        Assert-Equal @("ChatGPT.exe") @($uap5Aliases)
    }

    Test-Case "Store package without an alias returns StoreAumid" {
        $app = Resolve-CodexApp -OverridePath $null -Packages @($script:Packages[1]) -ProcessProvider {
            @([pscustomobject]@{ Path = $script:CodexExe; Id = 42; ProcessName = "Codex" })
        }
        Assert-Equal "StoreAumid" $app.Kind
        Assert-Equal $null $app.ExecutablePath
        Assert-Equal "$($script:Packages[1].PackageFamilyName)!App" $app.Aumid
    }

    Test-Case "System Node below 22 is rejected" {
        $script:NodeVersionReadCount = 0
        Assert-Throws {
            Get-NodeRuntime -App $script:StoreApp -SystemNodeProvider { $script:SystemNode } -VersionReader {
                param($Path)
                $script:NodeVersionReadCount++
                "v20.19.0"
            }
        } "Node.js 22"
        Assert-Equal 1 $script:NodeVersionReadCount
    }

    Test-Case "Node minimum cannot be lowered below 22" {
        Assert-Throws {
            Get-NodeRuntime -App $script:StoreApp -MinimumSystemMajor 20 -SystemNodeProvider { $script:SystemNode } -VersionReader { param($Path) "v20.19.0" }
        } "MinimumSystemMajor"
    }

    Test-Case "System Node 22 returns a structured runtime" {
        $runtime = Get-NodeRuntime -App $script:StoreApp -SystemNodeProvider { $script:SystemNode } -VersionReader { param($Path) "v22.17.0" }
        Assert-Equal "System" $runtime.Source
        Assert-Equal "v22.17.0" $runtime.Version
        Assert-Equal $script:SystemNode $runtime.Path
    }

    Test-Case "Bundled Node is preferred and version checked" {
        $bundled = Join-Path $script:Win32Root "resources\cua_node\bin\node.exe"
        New-Item -ItemType Directory -Path (Split-Path $bundled -Parent) -Force | Out-Null
        New-Item -ItemType File -Path $bundled -Force | Out-Null
        $runtime = Get-NodeRuntime -App $script:Win32App -SystemNodeProvider { $null } -VersionReader { param($Path) "v24.1.0" }
        Assert-Equal $bundled $runtime.Path
        Assert-Equal "Bundled" $runtime.Source
        Assert-Equal "v24.1.0" $runtime.Version
    }

    Test-Case "Malformed Node version is rejected" {
        $script:NodeVersionReadCount = 0
        Assert-Throws {
            Get-NodeRuntime -App $script:StoreApp -SystemNodeProvider { $script:SystemNode } -VersionReader {
                param($Path)
                $script:NodeVersionReadCount++
                "Node version unknown"
            }
        } "Node.js 22"
        Assert-Equal 1 $script:NodeVersionReadCount
    }

    Test-Case "32 bit host resolves native Program Files" {
        $path = Get-ProgramFiles64 -Environment @{ ProgramW6432 = "C:\Program Files"; ProgramFiles = "C:\Program Files (x86)" }
        Assert-Equal "C:\Program Files" $path
    }

    Test-Case "State directory grants access only to the current user" {
        $acl = New-HeiGePrivateDirectoryAcl -UserSid "S-1-5-21-1000"
        $accessSids = @($acl.GetAccessRules(
            $true,
            $false,
            [System.Security.Principal.SecurityIdentifier]
        ) | ForEach-Object { $_.IdentityReference.Value })
        Assert-True $acl.AreAccessRulesProtected
        Assert-Equal @("S-1-5-21-1000") $accessSids
    }

    Test-Case "Private state directory applies the protected ACL" {
        $state = Join-Path $script:Root "State 中文"
        New-Item -ItemType Directory -Path $state -Force | Out-Null
        $stateFile = Join-Path $state "state.json"
        New-Item -ItemType File -Path $stateFile -Force | Out-Null
        $everyone = New-Object -TypeName System.Security.Principal.SecurityIdentifier -ArgumentList "S-1-1-0"
        $existingAcl = Get-Acl -LiteralPath $stateFile
        $existingRule = New-Object -TypeName System.Security.AccessControl.FileSystemAccessRule -ArgumentList @(
            $everyone,
            [System.Security.AccessControl.FileSystemRights]::Read,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        $existingAcl.AddAccessRule($existingRule) | Out-Null
        Set-Acl -LiteralPath $stateFile -AclObject $existingAcl
        $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        Protect-HeiGeStateDirectory -Path $state -CurrentUserSid $currentSid | Out-Null
        $acl = Get-Acl -LiteralPath $state
        $fileAcl = Get-Acl -LiteralPath $stateFile
        $directorySids = @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
            $_.IdentityReference.Value
        })
        $fileSids = @($fileAcl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
            $_.IdentityReference.Value
        })
        Assert-True (Test-Path -LiteralPath $state -PathType Container)
        Assert-True $acl.AreAccessRulesProtected
        Assert-True $fileAcl.AreAccessRulesProtected
        Assert-Equal @($currentSid) $directorySids
        Assert-Equal @($currentSid) $fileSids
    }

    Test-Case "Private state directory falls back to icacls when Set-Acl lacks privilege" {
        $state = Join-Path $script:Root "State Icacls Fallback"
        New-Item -ItemType Directory -Path $state -Force | Out-Null
        $stateFile = Join-Path $state "state.json"
        New-Item -ItemType File -Path $stateFile -Force | Out-Null
        $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        Protect-HeiGeStateDirectory -Path $state -CurrentUserSid $currentSid -SetAclProvider {
            param($Path, $AclObject)
            throw (New-Object -TypeName System.Security.AccessControl.PrivilegeNotHeldException -ArgumentList "SeSecurityPrivilege")
        } | Out-Null
        $acl = Get-Acl -LiteralPath $state
        $fileAcl = Get-Acl -LiteralPath $stateFile
        $directorySids = @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
            $_.IdentityReference.Value
        })
        $fileSids = @($fileAcl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
            $_.IdentityReference.Value
        })
        Assert-True ($directorySids -contains $currentSid)
        Assert-True ($fileSids -contains $currentSid)
    }

    Test-Case "Private state directory refuses reparse points" {
        $state = Join-Path $script:Root "Reparse State"
        New-Item -ItemType Directory -Path $state -Force | Out-Null
        $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        Assert-Throws {
            Protect-HeiGeStateDirectory -Path $state -CurrentUserSid $currentSid -ChildItemProvider {
                param($Directory)
                @([pscustomobject]@{
                    FullName = (Join-Path $Directory "outside-link")
                    PSIsContainer = $true
                    Attributes = [System.IO.FileAttributes]::Directory -bor [System.IO.FileAttributes]::ReparsePoint
                })
            }
        } "reparse point"
    }

    Test-Case "CDP owner must match the resolved Win32 app" {
        $owner = Get-CdpOwner -Port 9341 -App $script:Win32App -ProcessProvider {
            param($Port)
            @([pscustomobject]@{ Id = 77; Path = $script:Win32Exe; ProcessName = "Codex"; LocalPort = $Port })
        }
        Assert-Equal 77 $owner.Id
        Assert-Equal $script:Win32Exe $owner.Path
    }

    Test-Case "Wrong CDP port owner is rejected" {
        $foreign = Join-Path $script:Root "Foreign\server.exe"
        Assert-Throws {
            Get-CdpOwner -Port 9341 -App $script:Win32App -ProcessProvider {
                param($Port)
                @([pscustomobject]@{ Id = 88; Path = $foreign; ProcessName = "foreign"; LocalPort = $Port })
            }
        } "CDP 端口不属于已解析的 Codex"
    }

    Test-Case "Conflicting paths for one CDP PID are rejected regardless of order" {
        $foreign = Join-Path $script:Root "Foreign\server.exe"
        $forward = @(
            [pscustomobject]@{ Id = 99; Path = $script:Win32Exe; ProcessName = "Codex"; LocalPort = 9341 },
            [pscustomobject]@{ Id = 99; Path = $foreign; ProcessName = "foreign"; LocalPort = 9341 }
        )
        $reverse = @($forward[1], $forward[0])
        Assert-Throws { Get-CdpOwner -Port 9341 -App $script:Win32App -ProcessProvider { param($Port) $forward } } "冲突路径记录"
        Assert-Throws { Get-CdpOwner -Port 9341 -App $script:Win32App -ProcessProvider { param($Port) $reverse } } "冲突路径记录"
    }
} finally {
    $env:LOCALAPPDATA = $script:OriginalLocalAppData
    Remove-Item -LiteralPath $script:Root -Recurse -Force -ErrorAction SilentlyContinue
}

Complete-TestRun
