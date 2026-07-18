[CmdletBinding(PositionalBinding = $false)]
param(
    [ValidateNotNullOrEmpty()]
    [string]$InstallRoot,
    [ValidateNotNullOrEmpty()]
    [string]$StartMenuRoot,
    [switch]$SkipApply
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot "lib\common.ps1")
. (Join-Path $PSScriptRoot "lib\start-menu.ps1")
. (Join-Path $PSScriptRoot "lib\bat-exit.ps1")

$script:HeiGeInstallProduct = "heige-codex-skin-studio"
$script:HeiGeInstallJournalLimit = 131072

if (-not ("HeiGeInstallNativeMethodsV1" -as [type])) {
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;

public static class HeiGeInstallNativeMethodsV1
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReplaceFileW(
        string replacedFileName,
        string replacementFileName,
        string backupFileName,
        uint replaceFlags,
        System.IntPtr exclude,
        System.IntPtr reserved
    );

    public static bool ReplaceFileWithoutBackup(
        string replacedFileName,
        string replacementFileName,
        uint replaceFlags
    )
    {
        return ReplaceFileW(
            replacedFileName,
            replacementFileName,
            null,
            replaceFlags,
            System.IntPtr.Zero,
            System.IntPtr.Zero
        );
    }
}
'@ | Out-Null
}

function Replace-HeiGeInstallJournalAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    $flags = [uint32]0x00000000
    if (-not [HeiGeInstallNativeMethodsV1]::ReplaceFileWithoutBackup(
        $Destination,
        $Source,
        $flags
    )) {
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        $message = (New-Object System.ComponentModel.Win32Exception -ArgumentList $code).Message
        throw "Windows install journal atomic replacement failed with Win32 error $code`: $message"
    }
}

function Get-HeiGeInstallAbsolutePath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Description
    )
    if (-not [System.IO.Path]::IsPathRooted($Path)) {
        throw "$Description 必须是绝对路径。"
    }
    $resolved = [System.IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
    if ($resolved -ieq [System.IO.Path]::GetPathRoot($resolved)) {
        throw "$Description 不能是文件系统根目录。"
    }
    return $resolved
}

function ConvertTo-HeiGeCompactJson {
    param([Parameter(Mandatory = $true)]$Value)
    return ($Value | ConvertTo-Json -Depth 32 -Compress)
}

function Assert-HeiGeExactProperties {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string[]]$Names,
        [Parameter(Mandatory = $true)][string]$Description
    )
    if ($null -eq $Value -or $Value -is [System.Array]) {
        throw "$Description must be an object"
    }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $expected = @($Names | Sort-Object)
    if ($actual.Count -ne $expected.Count) { throw "$Description schema is invalid" }
    for ($index = 0; $index -lt $expected.Count; $index++) {
        if ([string]$actual[$index] -cne [string]$expected[$index]) {
            throw "$Description contains unknown or missing fields"
        }
    }
}

function Write-HeiGeInstallJournal {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Document,
        [switch]$Exclusive
    )
    $json = (ConvertTo-HeiGeCompactJson -Value $Document) + "`n"
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($json)
    if ($bytes.Length -le 0 -or $bytes.Length -gt $script:HeiGeInstallJournalLimit) {
        throw "Windows install journal exceeds its bounded size"
    }
    $parent = Split-Path $Path -Parent
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Assert-HeiGeNoReparsePathComponents -Path $parent -Description "install journal parent" | Out-Null
    $temporary = "$Path.next.$PID.$([guid]::NewGuid().ToString('D'))"
    $stream = $null
    try {
        $stream = New-Object -TypeName System.IO.FileStream -ArgumentList @(
            $temporary,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None,
            4096,
            [System.IO.FileOptions]::WriteThrough
        )
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        if ($Exclusive) {
            if ([System.IO.File]::Exists($Path)) { throw "Windows install journal already exists" }
            [System.IO.File]::Move($temporary, $Path)
        } else {
            if (-not [System.IO.File]::Exists($Path)) {
                throw "Windows install journal disappeared before atomic update"
            }
            Replace-HeiGeInstallJournalAtomic -Source $temporary -Destination $Path
        }
    } finally {
        if ($stream) { $stream.Dispose() }
        if ([System.IO.File]::Exists($temporary)) { [System.IO.File]::Delete($temporary) }
    }
}

function Read-HeiGeInstallJournal {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or
        ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        [long]$item.Length -le 0 -or
        [long]$item.Length -gt $script:HeiGeInstallJournalLimit) {
        throw "Windows install journal is not a bounded regular file"
    }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
    try { $text = $utf8.GetString($bytes) } catch { throw "Windows install journal is not valid UTF-8" }
    try { $document = $text | ConvertFrom-Json } catch { throw "Windows install journal is not valid JSON" }
    $expectedKeys = @(
        "CreatedAt", "Decision", "InstallRoot", "Intents", "Operation", "Participants",
        "Phase", "Product", "Revision", "SchemaVersion", "SourceRoot", "StartMenuRoot",
        "TransactionId"
    ) | Sort-Object
    $actualKeys = @($document.PSObject.Properties.Name | Sort-Object)
    if ($actualKeys.Count -ne $expectedKeys.Count) { throw "Windows install journal schema is invalid" }
    for ($index = 0; $index -lt $expectedKeys.Count; $index++) {
        if ([string]$actualKeys[$index] -cne [string]$expectedKeys[$index]) {
            throw "Windows install journal contains unknown or missing fields"
        }
    }
    $transaction = [guid]::Empty
    if ([int]$document.SchemaVersion -ne 1 -or
        [string]$document.Product -cne $script:HeiGeInstallProduct -or
        [string]$document.Operation -cne "install-artifacts" -or
        -not [guid]::TryParseExact([string]$document.TransactionId, "D", [ref]$transaction) -or
        $transaction.ToString("D") -cne [string]$document.TransactionId -or
        @("undecided", "rollback", "commit") -cnotcontains [string]$document.Decision -or
        [long]$document.Revision -lt 0) {
        throw "Windows install journal identity is invalid"
    }
    if (([string]$document.Decision -eq "commit") -ne ([string]$document.Phase -eq "commit-decided") -or
        ([string]$document.Decision -eq "rollback") -ne ([string]$document.Phase -eq "rollback-decided")) {
        throw "Windows install journal decision and phase disagree"
    }
    Assert-HeiGeInstallJournalBindings -Path $Path -Document $document
    return $document
}

function Update-HeiGeInstallJournal {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Document,
        [Parameter(Mandatory = $true)][string]$Phase,
        [ValidateSet("undecided", "rollback", "commit")][string]$Decision
    )
    $observed = Read-HeiGeInstallJournal -Path $Path
    if ($null -eq $observed -or
        [string]$observed.TransactionId -cne [string]$Document.TransactionId -or
        [long]$observed.Revision -ne [long]$Document.Revision) {
        throw "Windows install journal CAS conflict"
    }
    if (-not $PSBoundParameters.ContainsKey("Decision")) { $Decision = [string]$Document.Decision }
    if ([string]$Document.Decision -cne "undecided" -and $Decision -cne [string]$Document.Decision) {
        throw "Windows install decision is already durable"
    }
    $Document.Phase = $Phase
    $Document.Decision = $Decision
    $Document.Revision = [long]$Document.Revision + 1
    Write-HeiGeInstallJournal -Path $Path -Document $Document
    return $Document
}

function Invoke-HeiGeTreeParticipant {
    param(
        [Parameter(Mandatory = $true)]$Node,
        [Parameter(Mandatory = $true)][string]$TransactionScript,
        [Parameter(Mandatory = $true)][ValidateSet("publish", "rollback", "finalize")][string]$Action,
        [Parameter(Mandatory = $true)]$Participant
    )
    $json = ConvertTo-HeiGeCompactJson -Value $Participant
    $result = Invoke-SkinCli -Node $Node.Path -CliArgs @(
        $TransactionScript,
        "participant-$Action",
        "--participant-json", $json
    )
    if ($result) { return ($result | ConvertFrom-Json) }
    throw "Node tree participant $Action returned no result"
}

function New-HeiGeStartMenuIntent {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$StartMenuRoot,
        [Parameter(Mandatory = $true)][string]$TransactionId
    )
    $shortcutPath = Get-HeiGeStartMenuShortcutPath -StartMenuRoot $StartMenuRoot
    $folderPath = Split-Path $shortcutPath -Parent
    $paths = Get-HeiGeStartMenuTransactionPaths -ShortcutPath $shortcutPath -TransactionId $TransactionId
    $targetPath = Join-Path $InstallRoot "scripts\windows\apply.bat"
    return [pscustomobject][ordered]@{
        StartMenuRoot = $StartMenuRoot
        StartMenuRootPriorExisted = [bool](Test-Path -LiteralPath $StartMenuRoot)
        FolderPath = $folderPath
        FolderPriorExisted = [bool](Test-Path -LiteralPath $folderPath)
        ShortcutPath = $shortcutPath
        ShortcutPriorExisted = [bool](Test-Path -LiteralPath $shortcutPath)
        StagePath = $paths.StagePath
        BackupPath = $paths.BackupPath
        TargetPath = $targetPath
        WorkingDirectory = Split-Path $targetPath -Parent
        TransactionId = $TransactionId
    }
}

function Assert-HeiGeInstallJournalBindings {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Document
    )
    Assert-HeiGeExactProperties -Value $Document.Intents -Names @("Tree", "StartMenu") `
        -Description "Windows install intents"
    Assert-HeiGeExactProperties -Value $Document.Participants -Names @("Tree", "StartMenu") `
        -Description "Windows install participants"
    Assert-HeiGeExactProperties -Value $Document.Intents.Tree `
        -Names @("TargetRoot", "StagePath", "BackupPath", "TransactionId") `
        -Description "Windows tree intent"
    Assert-HeiGeExactProperties -Value $Document.Intents.StartMenu -Names @(
        "StartMenuRoot", "StartMenuRootPriorExisted", "FolderPath", "FolderPriorExisted",
        "ShortcutPath", "ShortcutPriorExisted", "StagePath", "BackupPath", "TargetPath",
        "WorkingDirectory", "TransactionId"
    ) -Description "Windows Start Menu intent"
    $source = Get-HeiGeInstallAbsolutePath -Path ([string]$Document.SourceRoot) `
        -Description "journal SourceRoot"
    $target = Get-HeiGeInstallAbsolutePath -Path ([string]$Document.InstallRoot) `
        -Description "journal InstallRoot"
    $menuRoot = Get-HeiGeStartMenuFullPath -Path ([string]$Document.StartMenuRoot) `
        -Description "journal StartMenuRoot"
    if (-not $Path.Equals("$target.install-artifacts.json", [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $source.Equals([string]$Document.SourceRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $target.Equals([string]$Document.InstallRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $menuRoot.Equals([string]$Document.StartMenuRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Windows install journal canonical roots are invalid"
    }
    $transactionId = [string]$Document.TransactionId
    $tree = $Document.Intents.Tree
    if ([string]$tree.TransactionId -cne $transactionId -or
        -not ([string]$tree.TargetRoot).Equals($target, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not ([string]$tree.StagePath).Equals("$target.staged.$transactionId", [System.StringComparison]::OrdinalIgnoreCase) -or
        -not ([string]$tree.BackupPath).Equals("$target.backup.$transactionId", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Windows tree intent paths are invalid"
    }
    $menu = $Document.Intents.StartMenu
    $shortcutPath = Get-HeiGeStartMenuShortcutPath -StartMenuRoot $menuRoot
    $menuPaths = Get-HeiGeStartMenuTransactionPaths -ShortcutPath $shortcutPath `
        -TransactionId $transactionId
    $currentTargetPath = Join-Path $target "scripts\windows\apply.bat"
    $legacyTargetPath = Join-Path $target "scripts\windows\enable-skin.bat"
    $targetPath = [string]$menu.TargetPath
    $folderPath = Split-Path $shortcutPath -Parent
    if ([string]$menu.TransactionId -cne $transactionId -or
        -not ([string]$menu.StartMenuRoot).Equals($menuRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not ([string]$menu.FolderPath).Equals($folderPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not ([string]$menu.ShortcutPath).Equals($shortcutPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not ([string]$menu.StagePath).Equals($menuPaths.StagePath, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not ([string]$menu.BackupPath).Equals($menuPaths.BackupPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        (-not $targetPath.Equals($currentTargetPath, [System.StringComparison]::OrdinalIgnoreCase) -and
            -not $targetPath.Equals($legacyTargetPath, [System.StringComparison]::OrdinalIgnoreCase)) -or
        -not ([string]$menu.WorkingDirectory).Equals((Split-Path $targetPath -Parent), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Windows Start Menu intent paths are invalid"
    }
    foreach ($name in @("StartMenuRootPriorExisted", "FolderPriorExisted", "ShortcutPriorExisted")) {
        if ($menu.$name -isnot [bool]) { throw "Windows Start Menu intent $name is invalid" }
    }
}

function Remove-HeiGeStartMenuPreparation {
    param([Parameter(Mandatory = $true)]$Intent)
    if (Test-Path -LiteralPath $Intent.BackupPath) {
        throw "Start Menu prepare unexpectedly created a backup"
    }
    if (Test-Path -LiteralPath $Intent.StagePath) {
        Get-HeiGeShortcutObservation -Path $Intent.StagePath `
            -ExpectedTarget $Intent.TargetPath `
            -ExpectedWorkingDirectory $Intent.WorkingDirectory | Out-Null
        Remove-Item -LiteralPath $Intent.StagePath -Force
    }
    if (-not [bool]$Intent.ShortcutPriorExisted -and (Test-Path -LiteralPath $Intent.ShortcutPath)) {
        throw "Start Menu destination appeared before its participant was recorded"
    }
    Remove-HeiGePreparedStartMenuFolders -FolderPath $Intent.FolderPath `
        -FolderPriorExisted ([bool]$Intent.FolderPriorExisted) `
        -StartMenuRoot $Intent.StartMenuRoot `
        -StartMenuRootPriorExisted ([bool]$Intent.StartMenuRootPriorExisted)
}

function Assert-HeiGePreparedParticipants {
    param([Parameter(Mandatory = $true)]$Journal)
    $tree = $Journal.Participants.Tree
    $menu = $Journal.Participants.StartMenu
    if ($tree -and (
        [string]$tree.TransactionId -cne [string]$Journal.TransactionId -or
        [string]$tree.TargetRoot -cne [string]$Journal.InstallRoot -or
        [string]$tree.StagePath -cne [string]$Journal.Intents.Tree.StagePath -or
        [string]$tree.BackupPath -cne [string]$Journal.Intents.Tree.BackupPath)) {
        throw "tree participant does not match the global install intent"
    }
    if ($menu -and (
        [string]$menu.TransactionId -cne [string]$Journal.TransactionId -or
        [string]$menu.ShortcutPath -cne [string]$Journal.Intents.StartMenu.ShortcutPath -or
        [string]$menu.StagePath -cne [string]$Journal.Intents.StartMenu.StagePath -or
        [string]$menu.BackupPath -cne [string]$Journal.Intents.StartMenu.BackupPath)) {
        throw "Start Menu participant does not match the global install intent"
    }
}

function Undo-HeiGeWindowsInstall {
    param(
        [Parameter(Mandatory = $true)]$Journal,
        [Parameter(Mandatory = $true)]$Node,
        [Parameter(Mandatory = $true)][string]$TransactionScript
    )
    Assert-HeiGePreparedParticipants -Journal $Journal
    if ($Journal.Participants.StartMenu) {
        Rollback-HeiGeStartMenuShortcut -Participant $Journal.Participants.StartMenu | Out-Null
    } else {
        Remove-HeiGeStartMenuPreparation -Intent $Journal.Intents.StartMenu
    }
    if ($Journal.Participants.Tree) {
        Invoke-HeiGeTreeParticipant -Node $Node -TransactionScript $TransactionScript `
            -Action rollback -Participant $Journal.Participants.Tree | Out-Null
    } else {
        Invoke-SkinCli -Node $Node.Path -CliArgs @(
            $TransactionScript,
            "participant-recover-prepare",
            "--target", [string]$Journal.InstallRoot
        ) | Out-Null
    }
}

function Complete-HeiGeWindowsInstall {
    param(
        [Parameter(Mandatory = $true)]$Journal,
        [Parameter(Mandatory = $true)]$Node,
        [Parameter(Mandatory = $true)][string]$TransactionScript
    )
    Assert-HeiGePreparedParticipants -Journal $Journal
    if (-not $Journal.Participants.Tree -or -not $Journal.Participants.StartMenu) {
        throw "committed Windows install is missing a participant"
    }
    Finalize-HeiGeStartMenuShortcut -Participant $Journal.Participants.StartMenu | Out-Null
    Invoke-HeiGeTreeParticipant -Node $Node -TransactionScript $TransactionScript `
        -Action finalize -Participant $Journal.Participants.Tree | Out-Null
}

function Recover-HeiGeWindowsInstall {
    param(
        [Parameter(Mandatory = $true)][string]$JournalPath,
        [Parameter(Mandatory = $true)]$Node,
        [Parameter(Mandatory = $true)][string]$TransactionScript
    )
    $journal = Read-HeiGeInstallJournal -Path $JournalPath
    if ($null -eq $journal) { return $null }
    if ([string]$journal.Decision -eq "undecided") {
        $journal = Update-HeiGeInstallJournal -Path $JournalPath -Document $journal `
            -Phase "rollback-decided" -Decision "rollback"
    }
    if ([string]$journal.Decision -eq "commit") {
        Complete-HeiGeWindowsInstall -Journal $journal -Node $Node -TransactionScript $TransactionScript
    } else {
        Undo-HeiGeWindowsInstall -Journal $journal -Node $Node -TransactionScript $TransactionScript
    }
    [System.IO.File]::Delete($JournalPath)
    return [pscustomobject][ordered]@{ Recovered = $true; Decision = [string]$journal.Decision }
}

function Get-HeiGeInstallMutex {
    param([Parameter(Mandatory = $true)][string]$InstallRoot)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($InstallRoot.ToUpperInvariant())
        $digest = -join @($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") })
    } finally {
        $sha.Dispose()
    }
    return New-Object System.Threading.Mutex($false, "Local\HeiGeSkinInstall-$digest")
}

function Enter-HeiGeInstallMutex {
    param([Parameter(Mandatory = $true)]$Mutex)
    try {
        return [bool]$Mutex.WaitOne(0)
    } catch {
        $currentException = $_.Exception
        while ($null -ne $currentException) {
            if ($currentException -is [System.Threading.AbandonedMutexException]) {
                # WaitOne transfers ownership before reporting that the prior owner died.
                return $true
            }
            $currentException = $currentException.InnerException
        }
        throw
    }
}

function Invoke-HeiGePostCommitApply {
    param([Parameter(Mandatory = $true)][string]$ApplyScript)
    if (-not (Test-Path -LiteralPath $ApplyScript -PathType Leaf)) {
        throw "安装已完成，但找不到首次应用脚本：$ApplyScript"
    }
    # 子进程执行 apply：apply.ps1 会 exit，不可 & 进当前安装进程，否则会跳过 mutex finally。
    # 嵌套时关掉暂停提示，避免与外层 install 页脚重复。
    $powershell = Join-Path $PSHOME "powershell.exe"
    $previousNoPause = $env:HEIGE_NO_PAUSE
    $previousHint = $env:HEIGE_SHOW_PAUSE_HINT
    $env:HEIGE_NO_PAUSE = "1"
    Remove-Item Env:HEIGE_SHOW_PAUSE_HINT -ErrorAction SilentlyContinue
    try {
        $process = Start-Process -FilePath $powershell -ArgumentList @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", $ApplyScript
        ) -Wait -PassThru -NoNewWindow
    } finally {
        if ($null -eq $previousNoPause -or $previousNoPause -eq "") {
            Remove-Item Env:HEIGE_NO_PAUSE -ErrorAction SilentlyContinue
        } else {
            $env:HEIGE_NO_PAUSE = $previousNoPause
        }
        if ($null -eq $previousHint -or $previousHint -eq "") {
            Remove-Item Env:HEIGE_SHOW_PAUSE_HINT -ErrorAction SilentlyContinue
        } else {
            $env:HEIGE_SHOW_PAUSE_HINT = $previousHint
        }
    }
    if ($null -eq $process) {
        throw "安装已完成，但首次应用未能启动，可重试 scripts\windows\apply.ps1"
    }
    if ([int]$process.ExitCode -ne 0) {
        throw "安装已完成，但首次应用失败，可重试 scripts\windows\apply.ps1（退出码 $($process.ExitCode)）"
    }
}

function Invoke-HeiGeWindowsInstall {
    [CmdletBinding(PositionalBinding = $false)]
    param(
        [ValidateNotNullOrEmpty()]
        [string]$InstallRoot,
        [ValidateNotNullOrEmpty()]
        [string]$StartMenuRoot,
        [switch]$SkipApply
    )
    $source = Get-HeiGeInstallAbsolutePath `
        -Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Description "source root"
    $target = if ($PSBoundParameters.ContainsKey("InstallRoot")) {
        Get-HeiGeInstallAbsolutePath -Path $InstallRoot -Description "InstallRoot"
    } else {
        Get-HeiGeInstallAbsolutePath `
            -Path (Join-Path $env:USERPROFILE ".codex\heige-codex-skin-studio") `
            -Description "default InstallRoot"
    }
    $menuRoot = if ($PSBoundParameters.ContainsKey("StartMenuRoot")) {
        Get-HeiGeStartMenuFullPath -Path $StartMenuRoot -Description "StartMenuRoot"
    } else {
        Get-HeiGeDefaultStartMenuRoot
    }
    $skipRequested = $SkipApply.IsPresent -or $env:HEIGE_SKIP_APPLY -eq "1"
    $app = Resolve-CodexApp
    $node = Get-NodeRuntime -App $app
    $transactionScript = Join-Path $source "src\install-transaction.mjs"
    $journalPath = "$target.install-artifacts.json"
    $mutex = Get-HeiGeInstallMutex -InstallRoot $target
    $ownsMutex = $false
    try {
        $ownsMutex = Enter-HeiGeInstallMutex -Mutex $mutex
        if (-not $ownsMutex) { throw "another Windows artifact installation is still running" }
        Recover-HeiGeWindowsInstall -JournalPath $journalPath -Node $node `
            -TransactionScript $transactionScript | Out-Null

        $transactionId = [guid]::NewGuid().ToString("D")
        $startMenuIntent = New-HeiGeStartMenuIntent -InstallRoot $target `
            -StartMenuRoot $menuRoot -TransactionId $transactionId
        $journal = [pscustomobject][ordered]@{
            SchemaVersion = 1
            Product = $script:HeiGeInstallProduct
            Operation = "install-artifacts"
            TransactionId = $transactionId
            Revision = 0
            Decision = "undecided"
            Phase = "skeleton"
            CreatedAt = [DateTime]::UtcNow.ToString("o")
            SourceRoot = $source
            InstallRoot = $target
            StartMenuRoot = $menuRoot
            Intents = [pscustomobject][ordered]@{
                Tree = [pscustomobject][ordered]@{
                    TargetRoot = $target
                    StagePath = "$target.staged.$transactionId"
                    BackupPath = "$target.backup.$transactionId"
                    TransactionId = $transactionId
                }
                StartMenu = $startMenuIntent
            }
            Participants = [pscustomobject][ordered]@{ Tree = $null; StartMenu = $null }
        }
        Write-HeiGeInstallJournal -Path $journalPath -Document $journal -Exclusive

        $primaryError = $null
        try {
            $treeJson = Invoke-SkinCli -Node $node.Path -CliArgs @(
                $transactionScript,
                "participant-prepare",
                "--source", $source,
                "--target", $target,
                "--transaction-id", $transactionId
            )
            $journal.Participants.Tree = $treeJson | ConvertFrom-Json
            Assert-HeiGePreparedParticipants -Journal $journal
            $journal = Update-HeiGeInstallJournal -Path $journalPath -Document $journal `
                -Phase "tree-prepared"

            $journal.Participants.StartMenu = Prepare-HeiGeStartMenuShortcut `
                -InstallRoot $target -ValidationRoot $source -StartMenuRoot $menuRoot `
                -TransactionId $transactionId
            Assert-HeiGePreparedParticipants -Journal $journal
            $journal = Update-HeiGeInstallJournal -Path $journalPath -Document $journal `
                -Phase "participants-prepared"

            Invoke-HeiGeTreeParticipant -Node $node -TransactionScript $transactionScript `
                -Action publish -Participant $journal.Participants.Tree | Out-Null
            $journal = Update-HeiGeInstallJournal -Path $journalPath -Document $journal `
                -Phase "tree-published"
            Publish-HeiGeStartMenuShortcut -Participant $journal.Participants.StartMenu | Out-Null
            $journal = Update-HeiGeInstallJournal -Path $journalPath -Document $journal `
                -Phase "artifacts-published"

            $journal = Update-HeiGeInstallJournal -Path $journalPath -Document $journal `
                -Phase "commit-decided" -Decision "commit"
            Complete-HeiGeWindowsInstall -Journal $journal -Node $node `
                -TransactionScript $transactionScript
            [System.IO.File]::Delete($journalPath)
        } catch {
            $primaryError = $_
            $observed = Read-HeiGeInstallJournal -Path $journalPath
            if ($null -ne $observed -and [string]$observed.Decision -eq "undecided") {
                $observed = Update-HeiGeInstallJournal -Path $journalPath -Document $observed `
                    -Phase "rollback-decided" -Decision "rollback"
            }
            if ($null -ne $observed -and [string]$observed.Decision -eq "commit") {
                throw $primaryError
            }
            try {
                if ($null -ne $observed) {
                    Undo-HeiGeWindowsInstall -Journal $observed -Node $node `
                        -TransactionScript $transactionScript
                    [System.IO.File]::Delete($journalPath)
                }
            } catch {
                throw "Windows install failed: $($primaryError.Exception.Message); rollback failed: $($_.Exception.Message)"
            }
            throw $primaryError
        }

        Write-Host "HeiGe Codex Skin Studio 已安装到：$target"
        if (-not $skipRequested) {
            Invoke-HeiGePostCommitApply `
                -ApplyScript (Join-Path $target "scripts\windows\apply.ps1")
        }
    } finally {
        if ($ownsMutex) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

if ($MyInvocation.InvocationName -ne ".") {
    $boundParameters = $PSBoundParameters
    Invoke-HeiGeBatEntrypoint {
        Invoke-HeiGeWindowsInstall @boundParameters
    }
}
