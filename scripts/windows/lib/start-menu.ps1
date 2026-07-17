# HeiGe Codex Skin Studio current-user Start Menu shortcut
$ErrorActionPreference = "Stop"
$script:HeiGeStartMenuProduct = "heige-codex-skin-studio"
$script:HeiGeStartMenuDescription = "HeiGe Codex Skin Studio launcher v1 | current-user | re-enable skin"
$script:HeiGeStartMenuArguments = ""
$script:HeiGeStartMenuWindowStyle = 1
$script:HeiGeStartMenuHotkey = ""
$script:HeiGeStartMenuIconLocation = ""
$script:HeiGeStartMenuParticipantKeys = @(
    "AfterSha256",
    "BackupPath",
    "BeforeSha256",
    "FolderPath",
    "FolderPriorExisted",
    "InstallRoot",
    "PriorExisted",
    "Product",
    "SchemaVersion",
    "ShortcutPath",
    "StagePath",
    "StartMenuRoot",
    "StartMenuRootPriorExisted",
    "TargetPath",
    "TransactionId",
    "WorkingDirectory"
)

function Initialize-HeiGeUnicodeShellLink {
    if ($null -ne ("HeiGe.CodexSkinStudio.Windows.UnicodeShellLinkV1" -as [type])) {
        return
    }
    Add-Type -Language CSharp -ErrorAction Stop -TypeDefinition @'
using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace HeiGe.CodexSkinStudio.Windows
{
    [ComImport]
    [Guid("000214F9-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellLinkW
    {
        [PreserveSig]
        int GetPath(
            [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file,
            int maxPath,
            IntPtr findData,
            uint flags);

        [PreserveSig]
        int GetIDList(out IntPtr itemIdList);

        [PreserveSig]
        int SetIDList(IntPtr itemIdList);

        [PreserveSig]
        int GetDescription(
            [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name,
            int maxName);

        [PreserveSig]
        int SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);

        [PreserveSig]
        int GetWorkingDirectory(
            [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory,
            int maxPath);

        [PreserveSig]
        int SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);

        [PreserveSig]
        int GetArguments(
            [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments,
            int maxPath);

        [PreserveSig]
        int SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);

        [PreserveSig]
        int GetHotkey(out short hotkey);

        [PreserveSig]
        int SetHotkey(short hotkey);

        [PreserveSig]
        int GetShowCmd(out int showCommand);

        [PreserveSig]
        int SetShowCmd(int showCommand);

        [PreserveSig]
        int GetIconLocation(
            [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder iconPath,
            int maxPath,
            out int iconIndex);

        [PreserveSig]
        int SetIconLocation(
            [MarshalAs(UnmanagedType.LPWStr)] string iconPath,
            int iconIndex);

        [PreserveSig]
        int SetRelativePath(
            [MarshalAs(UnmanagedType.LPWStr)] string relativePath,
            uint reserved);

        [PreserveSig]
        int Resolve(IntPtr window, uint flags);

        [PreserveSig]
        int SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
    }

    [ComImport]
    [Guid("0000010B-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPersistFile
    {
        [PreserveSig]
        int GetClassID(out Guid classId);

        [PreserveSig]
        int IsDirty();

        [PreserveSig]
        int Load(
            [MarshalAs(UnmanagedType.LPWStr)] string fileName,
            uint mode);

        [PreserveSig]
        int Save(
            [MarshalAs(UnmanagedType.LPWStr)] string fileName,
            [MarshalAs(UnmanagedType.Bool)] bool remember);

        [PreserveSig]
        int SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string fileName);

        [PreserveSig]
        int GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string fileName);
    }

    public sealed class ShellLinkDataV1
    {
        public string TargetPath { get; set; }
        public string WorkingDirectory { get; set; }
        public string Description { get; set; }
        public string Arguments { get; set; }
        public int WindowStyle { get; set; }
        public string Hotkey { get; set; }
        public string IconLocation { get; set; }
    }

    public static class UnicodeShellLinkV1
    {
        private const int PathCharacters = 32768;
        private const int DescriptionCharacters = 1024;
        private const uint RawPath = 0x00000004;
        private static readonly Guid ShellLinkClassId =
            new Guid("00021401-0000-0000-C000-000000000046");

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern IntPtr SHSimpleIDListFromPath(
            [MarshalAs(UnmanagedType.LPWStr)] string path);

        private static object CreateInstance()
        {
            Type type = Type.GetTypeFromCLSID(ShellLinkClassId, true);
            object instance = Activator.CreateInstance(type);
            if (instance == null)
            {
                throw new InvalidOperationException("ShellLink COM activation returned null");
            }
            return instance;
        }

        private static void RequireSuccess(int result, string operation)
        {
            if (result < 0)
            {
                throw new COMException(operation + " failed", result);
            }
            if (result != 0)
            {
                throw new COMException(operation + " did not return S_OK", result);
            }
        }

        private static void ThrowIfFailed(int result, string operation)
        {
            if (result < 0)
            {
                throw new COMException(operation + " failed", result);
            }
        }

        private static void Release(object instance)
        {
            if (instance != null && Marshal.IsComObject(instance))
            {
                Marshal.FinalReleaseComObject(instance);
            }
        }

        private static void SetTarget(IShellLinkW link, string target)
        {
            if (File.Exists(target))
            {
                RequireSuccess(link.SetPath(target), "IShellLinkW.SetPath");
                return;
            }
            IntPtr simpleIdList = SHSimpleIDListFromPath(target);
            if (simpleIdList == IntPtr.Zero)
            {
                throw new InvalidOperationException(
                    "SHSimpleIDListFromPath could not represent the future target");
            }
            try
            {
                RequireSuccess(
                    link.SetIDList(simpleIdList),
                    "IShellLinkW.SetIDList");
            }
            finally
            {
                Marshal.FreeCoTaskMem(simpleIdList);
            }
        }

        public static void Create(
            string path,
            string target,
            string workingDirectory,
            string description)
        {
            if (String.IsNullOrEmpty(path) ||
                String.IsNullOrEmpty(target) ||
                String.IsNullOrEmpty(workingDirectory) ||
                description == null)
            {
                throw new ArgumentException("ShellLink arguments must be non-empty");
            }
            object instance = CreateInstance();
            try
            {
                IShellLinkW link = (IShellLinkW)instance;
                IPersistFile persistence = (IPersistFile)instance;
                SetTarget(link, target);
                RequireSuccess(
                    link.SetWorkingDirectory(workingDirectory),
                    "IShellLinkW.SetWorkingDirectory");
                RequireSuccess(
                    link.SetDescription(description),
                    "IShellLinkW.SetDescription");
                RequireSuccess(persistence.Save(path, false), "IPersistFile.Save");
            }
            finally
            {
                Release(instance);
            }
        }

        public static ShellLinkDataV1 Read(string path)
        {
            if (String.IsNullOrEmpty(path))
            {
                throw new ArgumentException("ShellLink path must be non-empty");
            }
            object instance = CreateInstance();
            try
            {
                IShellLinkW link = (IShellLinkW)instance;
                IPersistFile persistence = (IPersistFile)instance;
                RequireSuccess(persistence.Load(path, 0), "IPersistFile.Load");

                StringBuilder target = new StringBuilder(PathCharacters);
                StringBuilder workingDirectory = new StringBuilder(PathCharacters);
                StringBuilder description = new StringBuilder(DescriptionCharacters);
                StringBuilder arguments = new StringBuilder(PathCharacters);
                StringBuilder iconPath = new StringBuilder(PathCharacters);
                short hotkey;
                int showCommand;
                int iconIndex;

                ThrowIfFailed(
                    link.GetPath(target, target.Capacity, IntPtr.Zero, RawPath),
                    "IShellLinkW.GetPath");
                ThrowIfFailed(
                    link.GetWorkingDirectory(
                        workingDirectory,
                        workingDirectory.Capacity),
                    "IShellLinkW.GetWorkingDirectory");
                ThrowIfFailed(
                    link.GetDescription(description, description.Capacity),
                    "IShellLinkW.GetDescription");
                ThrowIfFailed(
                    link.GetArguments(arguments, arguments.Capacity),
                    "IShellLinkW.GetArguments");
                ThrowIfFailed(link.GetShowCmd(out showCommand), "IShellLinkW.GetShowCmd");
                ThrowIfFailed(link.GetHotkey(out hotkey), "IShellLinkW.GetHotkey");
                ThrowIfFailed(
                    link.GetIconLocation(iconPath, iconPath.Capacity, out iconIndex),
                    "IShellLinkW.GetIconLocation");

                string hotkeyText = hotkey == 0
                    ? String.Empty
                    : "0x" + ((ushort)hotkey).ToString("X4", CultureInfo.InvariantCulture);
                string iconText = iconPath.Length == 0 && iconIndex == 0
                    ? String.Empty
                    : iconPath.ToString() + ", " +
                        iconIndex.ToString(CultureInfo.InvariantCulture);
                return new ShellLinkDataV1
                {
                    TargetPath = target.ToString(),
                    WorkingDirectory = workingDirectory.ToString(),
                    Description = description.ToString(),
                    Arguments = arguments.ToString(),
                    WindowStyle = showCommand,
                    Hotkey = hotkeyText,
                    IconLocation = iconText
                };
            }
            finally
            {
                Release(instance);
            }
        }
    }
}
'@
}

function Get-HeiGeStartMenuFullPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Description
    )
    if (-not [System.IO.Path]::IsPathRooted($Path)) {
        throw "$Description 必须是绝对路径。"
    }
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $rootPath = [System.IO.Path]::GetPathRoot($fullPath)
    if ($fullPath -ieq $rootPath) {
        throw "$Description 不能是文件系统根目录。"
    }
    $separators = [char[]]@(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    return $fullPath.TrimEnd($separators)
}

function Get-HeiGeDefaultStartMenuRoot {
    $path = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
    if ([string]::IsNullOrWhiteSpace($path)) {
        throw "无法解析当前用户的开始菜单目录。"
    }
    return Get-HeiGeStartMenuFullPath -Path $path -Description "开始菜单目录"
}

function Assert-HeiGeNoReparsePathComponents {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Description,
        [scriptblock]$ItemProvider
    )
    $fullPath = Get-HeiGeStartMenuFullPath -Path $Path -Description $Description
    $rootPath = [System.IO.Path]::GetPathRoot($fullPath)
    if (-not $rootPath) { throw "$Description 无法解析文件系统根目录。" }
    if (-not $ItemProvider) {
        $ItemProvider = {
            param($Candidate)
            try {
                Get-Item -LiteralPath $Candidate -Force -ErrorAction Stop
            } catch [System.Management.Automation.ItemNotFoundException] {
                return
            }
        }
    }
    $paths = @($rootPath)
    $relative = $fullPath.Substring($rootPath.Length)
    $current = $rootPath
    foreach ($segment in @($relative -split '[\\/]' | Where-Object { $_ -ne "" })) {
        $current = Join-Path $current $segment
        $paths += $current
    }
    for ($index = 0; $index -lt $paths.Count; $index++) {
        $candidate = [string]$paths[$index]
        $items = @(& $ItemProvider $candidate)
        if ($items.Count -eq 0) { break }
        if ($items.Count -ne 1 -or $null -eq $items[0]) {
            throw "$Description 路径组件检查结果不唯一：$candidate"
        }
        $item = $items[0]
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "$Description 不得经过 reparse point：$candidate"
        }
        if ($index -lt ($paths.Count - 1) -and -not [bool]$item.PSIsContainer) {
            throw "$Description 的祖先路径不是目录：$candidate"
        }
    }
    return $fullPath
}

function Get-HeiGeStartMenuShortcutPath {
    param([AllowNull()][string]$StartMenuRoot)
    if (-not $StartMenuRoot) { $StartMenuRoot = Get-HeiGeDefaultStartMenuRoot }
    $root = Get-HeiGeStartMenuFullPath -Path $StartMenuRoot -Description "开始菜单目录"
    return (Join-Path $root "HeiGe Codex Skin Studio\HeiGe 皮肤启动器.lnk")
}

function ConvertFrom-HeiGeWshIconLocation {
    param([AllowNull()][string]$IconLocation)
    if ([string]::IsNullOrEmpty($IconLocation) -or
        $IconLocation -match '^\s*,\s*0\s*$') {
        return ""
    }
    return $IconLocation
}

function New-DefaultHeiGeShortcut {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$Description
    )
    Initialize-HeiGeUnicodeShellLink
    [HeiGe.CodexSkinStudio.Windows.UnicodeShellLinkV1]::Create(
        $Path,
        $Target,
        $WorkingDirectory,
        $Description
    )
}

function Read-DefaultHeiGeShortcut {
    param([Parameter(Mandatory = $true)][string]$Path)
    Initialize-HeiGeUnicodeShellLink
    $shortcut = [HeiGe.CodexSkinStudio.Windows.UnicodeShellLinkV1]::Read($Path)
    return [pscustomobject][ordered]@{
        TargetPath = [string]$shortcut.TargetPath
        WorkingDirectory = [string]$shortcut.WorkingDirectory
        Description = [string]$shortcut.Description
        Arguments = [string]$shortcut.Arguments
        WindowStyle = [int]$shortcut.WindowStyle
        Hotkey = [string]$shortcut.Hotkey
        IconLocation = (ConvertFrom-HeiGeWshIconLocation `
            -IconLocation ([string]$shortcut.IconLocation))
    }
}

function Test-HeiGeSamePath {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )
    try {
        $leftPath = [System.IO.Path]::GetFullPath($Left)
        $rightPath = [System.IO.Path]::GetFullPath($Right)
        return $leftPath.Equals($rightPath, [System.StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

function Test-HeiGePathAtOrWithin {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Path
    )
    try {
        $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
        $candidate = [System.IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
        if ($candidate.Equals($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
        return $candidate.StartsWith(
            $rootPath + [System.IO.Path]::DirectorySeparatorChar,
            [System.StringComparison]::OrdinalIgnoreCase
        )
    } catch {
        return $false
    }
}

function Get-HeiGeShortcutHash {
    param([Parameter(Mandatory = $true)][string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or
        ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        [long]$item.Length -le 0 -or [long]$item.Length -gt 1048576) {
        throw "快捷方式文件不安全：$Path"
    }
    $stream = [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha256.ComputeHash($stream)
        return (-join @($digest | ForEach-Object { $_.ToString("x2") }))
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

function Get-HeiGeShortcutObservation {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedTarget,
        [Parameter(Mandatory = $true)][string]$ExpectedWorkingDirectory,
        [scriptblock]$ReadShortcutProvider
    )
    if (-not $ReadShortcutProvider) {
        $ReadShortcutProvider = { param($Value) Read-DefaultHeiGeShortcut -Path $Value }
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "快捷方式文件不存在：$Path"
    }
    $beforeHash = Get-HeiGeShortcutHash -Path $Path
    $observed = @(& $ReadShortcutProvider $Path)
    $afterHash = Get-HeiGeShortcutHash -Path $Path
    if ($beforeHash -cne $afterHash) {
        throw "快捷方式在验证期间发生了变化：$Path"
    }
    if ($observed.Count -ne 1 -or $null -eq $observed[0]) {
        throw "shortcut inspection result is not unique"
    }
    foreach ($name in @(
        "TargetPath", "WorkingDirectory", "Description", "Arguments",
        "WindowStyle", "Hotkey", "IconLocation"
    )) {
        if ($observed[0].PSObject.Properties.Name -notcontains $name) {
            throw "shortcut inspection result is missing $name"
        }
    }
    if (-not (Test-HeiGeSamePath -Left ([string]$observed[0].TargetPath) -Right $ExpectedTarget)) {
        throw "shortcut target path mismatch"
    }
    if (-not (Test-HeiGeSamePath `
        -Left ([string]$observed[0].WorkingDirectory) -Right $ExpectedWorkingDirectory)) {
        throw "shortcut working directory mismatch"
    }
    if ([string]$observed[0].Description -cne $script:HeiGeStartMenuDescription) {
        throw "shortcut description marker mismatch"
    }
    if ([string]$observed[0].Arguments -cne $script:HeiGeStartMenuArguments) {
        throw "shortcut arguments mismatch"
    }
    if ([int]$observed[0].WindowStyle -ne $script:HeiGeStartMenuWindowStyle) {
        throw "shortcut window style mismatch"
    }
    if ([string]$observed[0].Hotkey -cne $script:HeiGeStartMenuHotkey) {
        throw "shortcut hotkey mismatch"
    }
    if ([string]$observed[0].IconLocation -cne $script:HeiGeStartMenuIconLocation) {
        throw "shortcut icon location mismatch"
    }
    return [pscustomobject][ordered]@{
        Path = $Path
        Sha256 = $beforeHash
        TargetPath = [string]$observed[0].TargetPath
        WorkingDirectory = [string]$observed[0].WorkingDirectory
        Description = [string]$observed[0].Description
        Arguments = [string]$observed[0].Arguments
        WindowStyle = [int]$observed[0].WindowStyle
        Hotkey = [string]$observed[0].Hotkey
        IconLocation = [string]$observed[0].IconLocation
    }
}

function Get-HeiGeOwnedStartMenuShortcutObservation {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [scriptblock]$ReadShortcutProvider
    )
    $workingDirectory = Join-Path $InstallRoot "scripts\windows"
    $currentTarget = Join-Path $workingDirectory "apply.bat"
    try {
        return Get-HeiGeShortcutObservation -Path $Path -ExpectedTarget $currentTarget `
            -ExpectedWorkingDirectory $workingDirectory `
            -ReadShortcutProvider $ReadShortcutProvider
    } catch {
        if ($_.Exception.Message -cnotmatch "shortcut target path mismatch") { throw }
    }
    $legacyTarget = Join-Path $workingDirectory "enable-skin.bat"
    return Get-HeiGeShortcutObservation -Path $Path -ExpectedTarget $legacyTarget `
        -ExpectedWorkingDirectory $workingDirectory `
        -ReadShortcutProvider $ReadShortcutProvider
}

function Get-HeiGeStartMenuTransactionPaths {
    param(
        [Parameter(Mandatory = $true)][string]$ShortcutPath,
        [Parameter(Mandatory = $true)][string]$TransactionId
    )
    $folder = Split-Path $ShortcutPath -Parent
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($ShortcutPath)
    return [pscustomobject][ordered]@{
        StagePath = Join-Path $folder "$baseName.staged.$TransactionId.lnk"
        BackupPath = Join-Path $folder "$baseName.backup.$TransactionId.lnk"
    }
}

function Assert-HeiGeStartMenuParticipant {
    param([Parameter(Mandatory = $true)]$Participant)
    if ($null -eq $Participant -or $Participant -is [System.Array]) {
        throw "Start Menu participant 无效。"
    }
    $actualKeys = @($Participant.PSObject.Properties.Name | Sort-Object)
    $expectedKeys = @($script:HeiGeStartMenuParticipantKeys | Sort-Object)
    if ($actualKeys.Count -ne $expectedKeys.Count) {
        throw "Start Menu participant 字段不完整。"
    }
    for ($index = 0; $index -lt $expectedKeys.Count; $index++) {
        if ([string]$actualKeys[$index] -cne [string]$expectedKeys[$index]) {
            throw "Start Menu participant 包含未知或缺失字段。"
        }
    }
    if ([int]$Participant.SchemaVersion -ne 1 -or
        [string]$Participant.Product -cne $script:HeiGeStartMenuProduct) {
        throw "Start Menu participant 产品归属无效。"
    }
    $transactionGuid = [guid]::Empty
    $validTransactionId = [guid]::TryParseExact(
        [string]$Participant.TransactionId,
        "D",
        [ref]$transactionGuid
    )
    if (-not $validTransactionId -or
        $transactionGuid.ToString("D") -cne [string]$Participant.TransactionId) {
        throw "Start Menu participant transaction ID 无效。"
    }
    foreach ($name in @("PriorExisted", "FolderPriorExisted", "StartMenuRootPriorExisted")) {
        if ($Participant.$name -isnot [System.Boolean]) {
            throw "Start Menu participant $name 必须是布尔值。"
        }
    }
    $installRoot = Get-HeiGeStartMenuFullPath `
        -Path ([string]$Participant.InstallRoot) -Description "安装目录"
    $startMenuRoot = Get-HeiGeStartMenuFullPath `
        -Path ([string]$Participant.StartMenuRoot) -Description "开始菜单目录"
    Assert-HeiGeNoReparsePathComponents -Path $installRoot -Description "安装目录" | Out-Null
    Assert-HeiGeNoReparsePathComponents -Path $startMenuRoot -Description "开始菜单目录" | Out-Null
    $commonPrograms = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonPrograms)
    if ($commonPrograms -and
        (Test-HeiGePathAtOrWithin -Root $commonPrograms -Path $startMenuRoot)) {
        throw "Start Menu participant 不得指向机器级开始菜单。"
    }
    $shortcutPath = Join-Path $startMenuRoot "HeiGe Codex Skin Studio\HeiGe 皮肤启动器.lnk"
    $folderPath = Split-Path $shortcutPath -Parent
    $currentTargetPath = Join-Path $installRoot "scripts\windows\apply.bat"
    $legacyTargetPath = Join-Path $installRoot "scripts\windows\enable-skin.bat"
    $targetPath = [string]$Participant.TargetPath
    if (-not (Test-HeiGeSamePath -Left $targetPath -Right $currentTargetPath) -and
        -not (Test-HeiGeSamePath -Left $targetPath -Right $legacyTargetPath)) {
        throw "Start Menu participant 目标不是当前或受信旧版启动器。"
    }
    $workingDirectory = Split-Path $targetPath -Parent
    $transactionPaths = Get-HeiGeStartMenuTransactionPaths `
        -ShortcutPath $shortcutPath -TransactionId ($transactionGuid.ToString("D"))
    foreach ($path in @(
        $shortcutPath, $folderPath, $targetPath, $workingDirectory,
        $transactionPaths.StagePath, $transactionPaths.BackupPath
    )) {
        Assert-HeiGeNoReparsePathComponents -Path $path -Description "Start Menu participant 路径" | Out-Null
    }
    foreach ($check in @(
        @("ShortcutPath", $shortcutPath, [string]$Participant.ShortcutPath),
        @("FolderPath", $folderPath, [string]$Participant.FolderPath),
        @("TargetPath", $targetPath, [string]$Participant.TargetPath),
        @("WorkingDirectory", $workingDirectory, [string]$Participant.WorkingDirectory),
        @("StagePath", $transactionPaths.StagePath, [string]$Participant.StagePath),
        @("BackupPath", $transactionPaths.BackupPath, [string]$Participant.BackupPath)
    )) {
        if (-not (Test-HeiGeSamePath -Left ([string]$check[1]) -Right ([string]$check[2]))) {
            throw "Start Menu participant 路径归属无效：$($check[0])"
        }
    }
    if ($Participant.PriorExisted) {
        if (-not $Participant.FolderPriorExisted -or -not $Participant.StartMenuRootPriorExisted) {
            throw "Start Menu participant 旧快捷方式与目录前置状态矛盾。"
        }
        if ([string]$Participant.BeforeSha256 -notmatch '^[a-f0-9]{64}$') {
            throw "Start Menu participant 旧快捷方式摘要无效。"
        }
    } elseif ($null -ne $Participant.BeforeSha256) {
        throw "Start Menu participant 不存在旧快捷方式时不得带摘要。"
    }
    if ([string]$Participant.AfterSha256 -notmatch '^[a-f0-9]{64}$') {
        throw "Start Menu participant 新快捷方式摘要无效。"
    }
    if ($Participant.FolderPriorExisted -and -not $Participant.StartMenuRootPriorExisted) {
        throw "Start Menu participant 目录前置状态矛盾。"
    }
    return $Participant
}

function Assert-HeiGeStartMenuFolder {
    param([Parameter(Mandatory = $true)][string]$StartMenuRoot)
    Assert-HeiGeNoReparsePathComponents -Path $StartMenuRoot -Description "开始菜单目录" | Out-Null
    $commonPrograms = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonPrograms)
    if ($commonPrograms -and
        (Test-HeiGePathAtOrWithin -Root $commonPrograms -Path $StartMenuRoot)) {
        throw "禁止写入机器级开始菜单：$StartMenuRoot"
    }
    [System.IO.Directory]::CreateDirectory($StartMenuRoot) | Out-Null
    Assert-HeiGeNoReparsePathComponents -Path $StartMenuRoot -Description "开始菜单目录" | Out-Null
    $startMenuItem = Get-Item -LiteralPath $StartMenuRoot -Force -ErrorAction Stop
    if (($startMenuItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "开始菜单目录不能是 reparse point：$StartMenuRoot"
    }
    $folder = Join-Path $StartMenuRoot "HeiGe Codex Skin Studio"
    [System.IO.Directory]::CreateDirectory($folder) | Out-Null
    Assert-HeiGeNoReparsePathComponents -Path $folder -Description "开始菜单快捷方式目录" | Out-Null
    $folderItem = Get-Item -LiteralPath $folder -Force -ErrorAction Stop
    if (($folderItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "开始菜单快捷方式目录不能是 reparse point：$folder"
    }
    return $folder
}

function Remove-HeiGePreparedStartMenuFolders {
    param(
        [Parameter(Mandatory = $true)][string]$FolderPath,
        [Parameter(Mandatory = $true)][bool]$FolderPriorExisted,
        [Parameter(Mandatory = $true)][string]$StartMenuRoot,
        [Parameter(Mandatory = $true)][bool]$StartMenuRootPriorExisted
    )
    if (-not $FolderPriorExisted -and (Test-Path -LiteralPath $FolderPath)) {
        $folder = Get-Item -LiteralPath $FolderPath -Force -ErrorAction Stop
        if (-not $folder.PSIsContainer -or
            ($folder.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Start Menu rollback refuses an unsafe prepared folder"
        }
        $folderChildren = @(Get-ChildItem -LiteralPath $FolderPath -Force -ErrorAction Stop)
        if ($folderChildren.Count -ne 0) {
            throw "Start Menu rollback refuses a nonempty prepared folder"
        }
        Remove-Item -LiteralPath $FolderPath -Force
    }
    if (-not $StartMenuRootPriorExisted -and (Test-Path -LiteralPath $StartMenuRoot)) {
        $root = Get-Item -LiteralPath $StartMenuRoot -Force -ErrorAction Stop
        if (-not $root.PSIsContainer -or
            ($root.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Start Menu rollback refuses an unsafe prepared root"
        }
        $rootChildren = @(Get-ChildItem -LiteralPath $StartMenuRoot -Force -ErrorAction Stop)
        if ($rootChildren.Count -ne 0) {
            throw "Start Menu rollback refuses a nonempty prepared root"
        }
        Remove-Item -LiteralPath $StartMenuRoot -Force
    }
}

function Prepare-HeiGeStartMenuShortcut {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [AllowNull()][string]$ValidationRoot,
        [AllowNull()][string]$StartMenuRoot,
        [AllowNull()][string]$TransactionId,
        [scriptblock]$CreateShortcutProvider,
        [scriptblock]$ReadShortcutProvider
    )
    $resolvedInstallRoot = Get-HeiGeStartMenuFullPath -Path $InstallRoot -Description "安装目录"
    Assert-HeiGeNoReparsePathComponents -Path $resolvedInstallRoot -Description "安装目录" | Out-Null
    if (Test-Path -LiteralPath $resolvedInstallRoot) {
        $installItem = Get-Item -LiteralPath $resolvedInstallRoot -Force -ErrorAction Stop
        if (-not $installItem.PSIsContainer -or
            ($installItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "安装目录不安全：$resolvedInstallRoot"
        }
    }
    if (-not $ValidationRoot) { $ValidationRoot = $resolvedInstallRoot }
    $resolvedValidationRoot = Get-HeiGeStartMenuFullPath `
        -Path $ValidationRoot -Description "验证目录"
    Assert-HeiGeNoReparsePathComponents -Path $resolvedValidationRoot -Description "验证目录" | Out-Null
    if (-not (Test-Path -LiteralPath $resolvedValidationRoot -PathType Container)) {
        throw "验证目录不存在：$resolvedValidationRoot"
    }
    $validationTarget = Join-Path $resolvedValidationRoot "scripts\windows\apply.bat"
    Assert-HeiGeNoReparsePathComponents -Path $validationTarget -Description "快捷方式验证目标" | Out-Null
    if (-not (Test-Path -LiteralPath $validationTarget -PathType Leaf)) {
        throw "快捷方式验证目标不存在：$validationTarget"
    }
    $validationTargetItem = Get-Item -LiteralPath $validationTarget -Force -ErrorAction Stop
    if (($validationTargetItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "快捷方式验证目标不能是 reparse point：$validationTarget"
    }
    $target = Join-Path $resolvedInstallRoot "scripts\windows\apply.bat"
    Assert-HeiGeNoReparsePathComponents -Path $target -Description "快捷方式最终目标" | Out-Null

    if (-not $TransactionId) { $TransactionId = [guid]::NewGuid().ToString("D") }
    $guidValue = [guid]::Empty
    $validTransactionId = [guid]::TryParseExact($TransactionId, "D", [ref]$guidValue)
    if (-not $validTransactionId -or
        $guidValue.ToString("D") -cne $TransactionId) {
        throw "Start Menu transaction ID 必须是规范小写 GUID。"
    }
    if (-not $StartMenuRoot) { $StartMenuRoot = Get-HeiGeDefaultStartMenuRoot }
    $resolvedStartMenuRoot = Get-HeiGeStartMenuFullPath -Path $StartMenuRoot -Description "开始菜单目录"
    Assert-HeiGeNoReparsePathComponents -Path $resolvedStartMenuRoot -Description "开始菜单目录" | Out-Null
    $startMenuRootPriorExisted = Test-Path -LiteralPath $resolvedStartMenuRoot
    $folderPath = Join-Path $resolvedStartMenuRoot "HeiGe Codex Skin Studio"
    $folderPriorExisted = Test-Path -LiteralPath $folderPath
    $commonPrograms = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonPrograms)
    if ($commonPrograms -and
        (Test-HeiGePathAtOrWithin -Root $commonPrograms -Path $resolvedStartMenuRoot)) {
        throw "禁止写入机器级开始菜单：$resolvedStartMenuRoot"
    }
    if ($startMenuRootPriorExisted) {
        $existingRoot = Get-Item -LiteralPath $resolvedStartMenuRoot -Force -ErrorAction Stop
        if (-not $existingRoot.PSIsContainer -or
            ($existingRoot.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "开始菜单目录不安全：$resolvedStartMenuRoot"
        }
    }
    if ($folderPriorExisted) {
        $existingFolder = Get-Item -LiteralPath $folderPath -Force -ErrorAction Stop
        if (-not $existingFolder.PSIsContainer -or
            ($existingFolder.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "开始菜单快捷方式目录不安全：$folderPath"
        }
    }
    $shortcutPath = Get-HeiGeStartMenuShortcutPath -StartMenuRoot $resolvedStartMenuRoot
    $workingDirectory = Split-Path $target -Parent
    $priorExisted = Test-Path -LiteralPath $shortcutPath
    $beforeSha256 = $null
    if ($priorExisted) {
        $before = Get-HeiGeOwnedStartMenuShortcutObservation -Path $shortcutPath `
            -InstallRoot $resolvedInstallRoot -ReadShortcutProvider $ReadShortcutProvider
        $beforeSha256 = $before.Sha256
    }

    $transactionPaths = Get-HeiGeStartMenuTransactionPaths `
        -ShortcutPath $shortcutPath -TransactionId $TransactionId
    foreach ($path in @($transactionPaths.StagePath, $transactionPaths.BackupPath)) {
        if (Test-Path -LiteralPath $path) {
            throw "Start Menu transaction 路径已存在：$path"
        }
    }

    $description = $script:HeiGeStartMenuDescription
    if (-not $CreateShortcutProvider) {
        $CreateShortcutProvider = {
            param($Path, $Target, $WorkingDirectory, $Description)
            New-DefaultHeiGeShortcut -Path $Path -Target $Target `
                -WorkingDirectory $WorkingDirectory -Description $Description
        }
    }
    try {
        Assert-HeiGeStartMenuFolder -StartMenuRoot $resolvedStartMenuRoot | Out-Null
        & $CreateShortcutProvider $transactionPaths.StagePath $target $workingDirectory $description | Out-Null
        $staged = Get-HeiGeShortcutObservation -Path $transactionPaths.StagePath `
            -ExpectedTarget $target -ExpectedWorkingDirectory $workingDirectory `
            -ReadShortcutProvider $ReadShortcutProvider
    } catch {
        $verificationError = $_.Exception.Message
        $cleanupError = $null
        if (Test-Path -LiteralPath $transactionPaths.StagePath) {
            try {
                Get-HeiGeShortcutHash -Path $transactionPaths.StagePath | Out-Null
                Remove-Item -LiteralPath $transactionPaths.StagePath -Force -ErrorAction Stop
            } catch {
                $cleanupError = $_.Exception.Message
            }
        }
        if ($cleanupError) {
            throw "shortcut verification failed: $verificationError; staged cleanup failed: $cleanupError"
        }
        try {
            Remove-HeiGePreparedStartMenuFolders -FolderPath $folderPath `
                -FolderPriorExisted ([bool]$folderPriorExisted) `
                -StartMenuRoot $resolvedStartMenuRoot `
                -StartMenuRootPriorExisted ([bool]$startMenuRootPriorExisted)
        } catch {
            throw "shortcut verification failed: $verificationError; folder cleanup failed: $($_.Exception.Message)"
        }
        throw "shortcut verification failed: $verificationError"
    }
    return [pscustomobject][ordered]@{
        SchemaVersion = 1
        Product = $script:HeiGeStartMenuProduct
        TransactionId = $TransactionId
        InstallRoot = $resolvedInstallRoot
        StartMenuRoot = $resolvedStartMenuRoot
        StartMenuRootPriorExisted = [bool]$startMenuRootPriorExisted
        FolderPath = $folderPath
        FolderPriorExisted = [bool]$folderPriorExisted
        ShortcutPath = $shortcutPath
        TargetPath = $target
        WorkingDirectory = $workingDirectory
        StagePath = $transactionPaths.StagePath
        BackupPath = $transactionPaths.BackupPath
        PriorExisted = [bool]$priorExisted
        BeforeSha256 = $beforeSha256
        AfterSha256 = $staged.Sha256
    }
}

function Publish-HeiGeStartMenuShortcut {
    param(
        [Parameter(Mandatory = $true)]$Participant,
        [scriptblock]$ReadShortcutProvider
    )
    $participant = Assert-HeiGeStartMenuParticipant -Participant $Participant
    Assert-HeiGeStartMenuFolder -StartMenuRoot $participant.StartMenuRoot | Out-Null
    $staged = Get-HeiGeShortcutObservation -Path $participant.StagePath `
        -ExpectedTarget $participant.TargetPath `
        -ExpectedWorkingDirectory $participant.WorkingDirectory `
        -ReadShortcutProvider $ReadShortcutProvider
    if ($staged.Sha256 -cne [string]$participant.AfterSha256) {
        throw "Start Menu staged shortcut digest mismatch"
    }
    if (Test-Path -LiteralPath $participant.BackupPath) {
        throw "Start Menu backup path already exists"
    }
    if ($participant.PriorExisted) {
        $before = Get-HeiGeOwnedStartMenuShortcutObservation -Path $participant.ShortcutPath `
            -InstallRoot $participant.InstallRoot -ReadShortcutProvider $ReadShortcutProvider
        if ($before.Sha256 -cne [string]$participant.BeforeSha256) {
            throw "Start Menu existing shortcut changed after prepare"
        }
        Move-Item -LiteralPath $participant.ShortcutPath -Destination $participant.BackupPath
        $backedUp = Get-HeiGeOwnedStartMenuShortcutObservation -Path $participant.BackupPath `
            -InstallRoot $participant.InstallRoot -ReadShortcutProvider $ReadShortcutProvider
        if ($backedUp.Sha256 -cne [string]$participant.BeforeSha256) {
            throw "Start Menu backup changed during publication"
        }
    } elseif (Test-Path -LiteralPath $participant.ShortcutPath) {
        throw "Start Menu destination appeared after prepare"
    }
    Move-Item -LiteralPath $participant.StagePath -Destination $participant.ShortcutPath
    $published = Get-HeiGeShortcutObservation -Path $participant.ShortcutPath `
        -ExpectedTarget $participant.TargetPath `
        -ExpectedWorkingDirectory $participant.WorkingDirectory `
        -ReadShortcutProvider $ReadShortcutProvider
    if ($published.Sha256 -cne [string]$participant.AfterSha256) {
        throw "Start Menu published shortcut digest mismatch"
    }
    return [pscustomobject][ordered]@{
        Participant = $participant
        Published = $true
        Verified = $true
    }
}

function Rollback-HeiGeStartMenuShortcut {
    param(
        [Parameter(Mandatory = $true)]$Participant,
        [scriptblock]$ReadShortcutProvider
    )
    $participant = Assert-HeiGeStartMenuParticipant -Participant $Participant
    $destinationExists = Test-Path -LiteralPath $participant.ShortcutPath
    $backupExists = Test-Path -LiteralPath $participant.BackupPath
    $stageExists = Test-Path -LiteralPath $participant.StagePath

    if ($backupExists) {
        if (-not $participant.PriorExisted) {
            throw "Start Menu rollback found an impossible backup"
        }
        $backup = Get-HeiGeOwnedStartMenuShortcutObservation -Path $participant.BackupPath `
            -InstallRoot $participant.InstallRoot -ReadShortcutProvider $ReadShortcutProvider
        if ($backup.Sha256 -cne [string]$participant.BeforeSha256) {
            throw "Start Menu rollback backup digest mismatch"
        }
        if ($destinationExists) {
            $destination = Get-HeiGeShortcutObservation -Path $participant.ShortcutPath `
                -ExpectedTarget $participant.TargetPath `
                -ExpectedWorkingDirectory $participant.WorkingDirectory `
                -ReadShortcutProvider $ReadShortcutProvider
            if ($destination.Sha256 -cne [string]$participant.AfterSha256) {
                throw "Start Menu rollback refuses a foreign destination"
            }
            Remove-Item -LiteralPath $participant.ShortcutPath -Force
        }
        Move-Item -LiteralPath $participant.BackupPath -Destination $participant.ShortcutPath
        $restored = Get-HeiGeOwnedStartMenuShortcutObservation -Path $participant.ShortcutPath `
            -InstallRoot $participant.InstallRoot -ReadShortcutProvider $ReadShortcutProvider
        if ($restored.Sha256 -cne [string]$participant.BeforeSha256) {
            throw "Start Menu rollback could not restore the prior shortcut"
        }
    } elseif ($participant.PriorExisted) {
        if (-not $destinationExists) {
            throw "Start Menu rollback cannot find the prior shortcut or its backup"
        }
        $untouched = Get-HeiGeOwnedStartMenuShortcutObservation -Path $participant.ShortcutPath `
            -InstallRoot $participant.InstallRoot -ReadShortcutProvider $ReadShortcutProvider
        if ($untouched.Sha256 -cne [string]$participant.BeforeSha256) {
            throw "Start Menu rollback refuses a changed prior shortcut"
        }
    } elseif ($destinationExists) {
        $published = Get-HeiGeShortcutObservation -Path $participant.ShortcutPath `
            -ExpectedTarget $participant.TargetPath `
            -ExpectedWorkingDirectory $participant.WorkingDirectory `
            -ReadShortcutProvider $ReadShortcutProvider
        if ($published.Sha256 -cne [string]$participant.AfterSha256) {
            throw "Start Menu rollback refuses a foreign destination"
        }
        Remove-Item -LiteralPath $participant.ShortcutPath -Force
    }

    if ($stageExists) {
        $staged = Get-HeiGeShortcutObservation -Path $participant.StagePath `
            -ExpectedTarget $participant.TargetPath `
            -ExpectedWorkingDirectory $participant.WorkingDirectory `
            -ReadShortcutProvider $ReadShortcutProvider
        if ($staged.Sha256 -cne [string]$participant.AfterSha256) {
            throw "Start Menu rollback refuses a foreign staged shortcut"
        }
        Remove-Item -LiteralPath $participant.StagePath -Force
    }
    foreach ($path in @($participant.StagePath, $participant.BackupPath)) {
        if (Test-Path -LiteralPath $path) {
            throw "Start Menu rollback left a transaction artifact: $path"
        }
    }
    Remove-HeiGePreparedStartMenuFolders -FolderPath $participant.FolderPath `
        -FolderPriorExisted ([bool]$participant.FolderPriorExisted) `
        -StartMenuRoot $participant.StartMenuRoot `
        -StartMenuRootPriorExisted ([bool]$participant.StartMenuRootPriorExisted)
    return [pscustomobject][ordered]@{
        RolledBack = $true
        PriorExisted = [bool]$participant.PriorExisted
        Verified = $true
    }
}

function Finalize-HeiGeStartMenuShortcut {
    param(
        [Parameter(Mandatory = $true)]$Participant,
        [scriptblock]$ReadShortcutProvider
    )
    $participant = Assert-HeiGeStartMenuParticipant -Participant $Participant
    $published = Get-HeiGeShortcutObservation -Path $participant.ShortcutPath `
        -ExpectedTarget $participant.TargetPath `
        -ExpectedWorkingDirectory $participant.WorkingDirectory `
        -ReadShortcutProvider $ReadShortcutProvider
    if ($published.Sha256 -cne [string]$participant.AfterSha256) {
        throw "Start Menu finalize refuses a changed destination"
    }
    if (Test-Path -LiteralPath $participant.StagePath) {
        $staged = Get-HeiGeShortcutObservation -Path $participant.StagePath `
            -ExpectedTarget $participant.TargetPath `
            -ExpectedWorkingDirectory $participant.WorkingDirectory `
            -ReadShortcutProvider $ReadShortcutProvider
        if ($staged.Sha256 -cne [string]$participant.AfterSha256) {
            throw "Start Menu finalize refuses a foreign staged shortcut"
        }
        Remove-Item -LiteralPath $participant.StagePath -Force
    }
    if (Test-Path -LiteralPath $participant.BackupPath) {
        if (-not $participant.PriorExisted) { throw "Start Menu finalize found an impossible backup" }
        $backup = Get-HeiGeOwnedStartMenuShortcutObservation -Path $participant.BackupPath `
            -InstallRoot $participant.InstallRoot -ReadShortcutProvider $ReadShortcutProvider
        if ($backup.Sha256 -cne [string]$participant.BeforeSha256) {
            throw "Start Menu finalize refuses a foreign backup shortcut"
        }
        Remove-Item -LiteralPath $participant.BackupPath -Force
    }
    return [pscustomobject][ordered]@{
        Finalized = $true
        ShortcutPath = [string]$participant.ShortcutPath
        Verified = $true
    }
}

function Remove-HeiGeStartMenuShortcut {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [AllowNull()][string]$StartMenuRoot,
        [scriptblock]$ReadShortcutProvider
    )
    $resolvedInstallRoot = Get-HeiGeStartMenuFullPath -Path $InstallRoot -Description "安装目录"
    Assert-HeiGeNoReparsePathComponents -Path $resolvedInstallRoot -Description "安装目录" | Out-Null
    if (-not $StartMenuRoot) { $StartMenuRoot = Get-HeiGeDefaultStartMenuRoot }
    $resolvedStartMenuRoot = Get-HeiGeStartMenuFullPath -Path $StartMenuRoot -Description "开始菜单目录"
    Assert-HeiGeNoReparsePathComponents -Path $resolvedStartMenuRoot -Description "开始菜单目录" | Out-Null
    $shortcutPath = Get-HeiGeStartMenuShortcutPath -StartMenuRoot $resolvedStartMenuRoot
    if (-not (Test-Path -LiteralPath $shortcutPath)) {
        return [pscustomobject][ordered]@{ PriorExisted = $false; Removed = $false; VerifiedAbsent = $true }
    }
    Assert-HeiGeNoReparsePathComponents -Path $shortcutPath -Description "开始菜单快捷方式" | Out-Null
    Get-HeiGeOwnedStartMenuShortcutObservation -Path $shortcutPath `
        -InstallRoot $resolvedInstallRoot -ReadShortcutProvider $ReadShortcutProvider | Out-Null
    Remove-Item -LiteralPath $shortcutPath -Force
    if (Test-Path -LiteralPath $shortcutPath) { throw "快捷方式删除后仍存在：$shortcutPath" }
    return [pscustomobject][ordered]@{ PriorExisted = $true; Removed = $true; VerifiedAbsent = $true }
}

function Install-HeiGeStartMenuShortcut {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [AllowNull()][string]$ValidationRoot,
        [AllowNull()][string]$StartMenuRoot,
        [scriptblock]$CreateShortcutProvider,
        [scriptblock]$ReadShortcutProvider
    )
    $participant = Prepare-HeiGeStartMenuShortcut -InstallRoot $InstallRoot `
        -ValidationRoot $ValidationRoot -StartMenuRoot $StartMenuRoot `
        -CreateShortcutProvider $CreateShortcutProvider `
        -ReadShortcutProvider $ReadShortcutProvider
    try {
        Publish-HeiGeStartMenuShortcut -Participant $participant `
            -ReadShortcutProvider $ReadShortcutProvider | Out-Null
        Finalize-HeiGeStartMenuShortcut -Participant $participant `
            -ReadShortcutProvider $ReadShortcutProvider | Out-Null
    } catch {
        $primaryError = $_.Exception.Message
        try {
            Rollback-HeiGeStartMenuShortcut -Participant $participant `
                -ReadShortcutProvider $ReadShortcutProvider | Out-Null
        } catch {
            throw "shortcut publication failed: $primaryError; rollback failed: $($_.Exception.Message)"
        }
        throw "shortcut publication failed: $primaryError"
    }

    return [pscustomobject][ordered]@{
        ShortcutPath = $participant.ShortcutPath
        TargetPath = $participant.TargetPath
        Verified = $true
        CurrentUserOnly = $true
    }
}
