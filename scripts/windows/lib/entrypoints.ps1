# HeiGe Codex Skin Studio Windows entrypoint orchestration
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")
. (Join-Path $PSScriptRoot "scheduled-task.ps1")

function New-HeiGeWindowsEntrypointContext {
    param([Parameter(Mandatory = $true)][string]$Root)
    $resolvedRoot = Get-HeiGeComparablePath -Path $Root
    if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
        throw "安装目录不存在：$resolvedRoot"
    }
    $rootItem = Get-Item -LiteralPath $resolvedRoot -Force -ErrorAction Stop
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "安装目录不能是 reparse point：$resolvedRoot"
    }

    $cliPath = Join-Path $resolvedRoot "src\cli.mjs"
    $controllerPath = Join-Path $resolvedRoot "scripts\windows\controller.ps1"
    foreach ($path in @($cliPath, $controllerPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Windows 入口依赖文件不存在：$path"
        }
    }
    $app = Resolve-CodexApp
    $runtime = Get-NodeRuntime -App $app
    if (-not $runtime -or -not $runtime.Path -or -not (Test-Path -LiteralPath $runtime.Path -PathType Leaf)) {
        throw "Windows 入口无法验证 Node.js 运行时。"
    }
    $stateDirectory = Resolve-HeiGeScopedStateDirectory -StateDirectory $null
    Protect-HeiGeStateDirectory -Path $stateDirectory | Out-Null
    return [pscustomobject][ordered]@{
        App = $app
        NodePath = [string]$runtime.Path
        CliPath = $cliPath
        ControllerPath = $controllerPath
        StateDirectory = $stateDirectory
        TaskName = $script:HeiGeProductionTaskName
    }
}

function Get-HeiGeFlowContext {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [scriptblock]$ContextProvider
    )
    $values = @(
        if ($ContextProvider) {
            & $ContextProvider $Root
        } else {
            New-HeiGeWindowsEntrypointContext -Root $Root
        }
    )
    if ($values.Count -ne 1 -or $null -eq $values[0]) {
        throw "Windows 入口预检结果不唯一。"
    }
    $context = $values[0]
    foreach ($name in @("App", "NodePath", "CliPath", "ControllerPath", "StateDirectory", "TaskName")) {
        if ($context.PSObject.Properties.Name -notcontains $name -or $null -eq $context.$name) {
            throw "Windows 入口预检缺少字段：$name"
        }
    }
    return $context
}

function Invoke-HeiGeContextCli {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [scriptblock]$CliProvider
    )
    $identityToken = ConvertTo-HeiGeCodexAppIdentityToken -App $Context.App
    $environmentName = "HEIGE_WINDOWS_APP_IDENTITY"
    $previousIdentity = [System.Environment]::GetEnvironmentVariable(
        $environmentName,
        [System.EnvironmentVariableTarget]::Process
    )
    [System.Environment]::SetEnvironmentVariable(
        $environmentName,
        $identityToken,
        [System.EnvironmentVariableTarget]::Process
    )
    try {
        $values = @(
            if ($CliProvider) {
                & $CliProvider $Context $Arguments
            } else {
                $cliArguments = @([string]$Context.CliPath) + @($Arguments)
                $json = Invoke-SkinCli -Node ([string]$Context.NodePath) -CliArgs $cliArguments
                try {
                    $json | ConvertFrom-Json
                } catch {
                    throw "皮肤命令返回了无效 JSON：$($_.Exception.Message)"
                }
            }
        )
    } finally {
        [System.Environment]::SetEnvironmentVariable(
            $environmentName,
            $previousIdentity,
            [System.EnvironmentVariableTarget]::Process
        )
    }
    if ($values.Count -ne 1 -or $null -eq $values[0]) {
        throw "皮肤命令返回结果不唯一。"
    }
    return $values[0]
}

function Assert-HeiGeModeResult {
    param(
        [Parameter(Mandatory = $true)]$Result,
        [Parameter(Mandatory = $true)][string]$Expected
    )
    if ($Result.PSObject.Properties.Name -notcontains "mode" -or [string]$Result.mode -cne $Expected) {
        throw "皮肤命令状态验证失败：期望 $Expected。"
    }
}

function Assert-HeiGePersistenceResult {
    param(
        [Parameter(Mandatory = $true)]$Result,
        [Parameter(Mandatory = $true)][bool]$Expected
    )
    if ($Result.PSObject.Properties.Name -notcontains "persistenceEnabled" -or
        $Result.persistenceEnabled -isnot [System.Boolean] -or
        [bool]$Result.persistenceEnabled -ne $Expected) {
        throw "常驻状态验证失败：期望 $Expected。"
    }
}

function Start-HeiGeEntrypointCdp {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][int]$Port,
        [scriptblock]$StartCdpProvider
    )
    if ($StartCdpProvider) {
        & $StartCdpProvider $Context $Port | Out-Null
    } else {
        Start-CodexWithCdp -Port $Port -AppInfo $Context.App
    }
}

function Require-HeiGeEntrypointCdp {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][int]$Port,
        [scriptblock]$RequireCdpProvider
    )
    if ($RequireCdpProvider) {
        & $RequireCdpProvider $Context $Port | Out-Null
        return
    }
    if (-not (Test-CdpEndpoint -Port $Port)) {
        throw "当前 Codex 未开启可归属的 CDP 端口：$Port"
    }
    Get-CdpOwner -Port $Port -App $Context.App | Out-Null
}

function Unregister-HeiGeEntrypointTask {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [scriptblock]$UnregisterProvider
    )
    $values = @(
        if ($UnregisterProvider) {
            & $UnregisterProvider $Context
        } else {
            Unregister-HeiGeScheduledTask -TaskName ([string]$Context.TaskName) `
                -StateDirectory ([string]$Context.StateDirectory)
        }
    )
    if ($values.Count -ne 1 -or $null -eq $values[0] -or
        $values[0].PSObject.Properties.Name -notcontains "VerifiedAbsent" -or
        $values[0].VerifiedAbsent -isnot [System.Boolean] -or
        -not [bool]$values[0].VerifiedAbsent) {
        throw "Scheduled Task 注销后未能验证任务已消失。"
    }
    return $values[0]
}

function Get-HeiGeEntrypointProcessMode {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [scriptblock]$ProcessProvider
    )
    $records = if ($ProcessProvider) {
        @(& $ProcessProvider $Context)
    } else {
        @(Get-CimInstance -ClassName Win32_Process `
            -Filter "Name='ChatGPT.exe' OR Name='Codex.exe'" -ErrorAction Stop)
    }
    $owned = @()
    foreach ($record in $records) {
        if ($null -eq $record) {
            throw "Codex 进程记录为空，无法唯一归属。"
        }
        $propertyNames = @($record.PSObject.Properties.Name)
        $processIdName = if ($propertyNames -contains "ProcessId") {
            "ProcessId"
        } elseif ($propertyNames -contains "Id") {
            "Id"
        } else {
            $null
        }
        $pathName = if ($propertyNames -contains "ExecutablePath") {
            "ExecutablePath"
        } elseif ($propertyNames -contains "Path") {
            "Path"
        } else {
            $null
        }
        if (-not $processIdName -or -not $pathName -or
            $propertyNames -notcontains "ParentProcessId") {
            throw "Codex 进程记录缺少 PID、父 PID 或可执行路径，无法唯一归属。"
        }
        try {
            $path = [string]$record.$pathName
            $processId = 0
            $parentProcessId = 0
            $validProcessId = [int]::TryParse([string]$record.$processIdName, [ref]$processId)
            $validParentId = [int]::TryParse([string]$record.ParentProcessId, [ref]$parentProcessId)
        } catch {
            throw "Codex 进程记录无法安全读取，无法唯一归属。"
        }
        if (-not $path -or -not $validProcessId -or $processId -le 0 -or
            -not $validParentId -or $parentProcessId -lt 0) {
            throw "Codex 进程记录无效，无法唯一归属。"
        }
        $owner = [pscustomobject]@{
            Id = $processId
            Path = $path
            ProcessName = if ($propertyNames -contains "Name") {
                [string]$record.Name
            } elseif ($propertyNames -contains "ProcessName") {
                [string]$record.ProcessName
            } else {
                ""
            }
        }
        if (Test-CdpOwnerMatchesApp -Owner $owner -App $Context.App) {
            $owned += [pscustomobject][ordered]@{
                Id = $processId
                ParentProcessId = $parentProcessId
                Path = Get-HeiGeFullPath -Path $path
            }
        } elseif (Test-HeiGeCodexInternalBackendPath -Path $path) {
            # Ignore the Desktop task backend under %LOCALAPPDATA%\OpenAI\Codex\bin.
            continue
        } else {
            throw "Codex 候选进程不属于已绑定的不可变应用身份。"
        }
    }
    if ($owned.Count -eq 0) { return "closed" }

    $normalized = @()
    foreach ($group in @($owned | Group-Object Id)) {
        $parents = @($group.Group | ForEach-Object { [int]$_.ParentProcessId } | Sort-Object -Unique)
        $paths = @($group.Group | ForEach-Object { [string]$_.Path } | Sort-Object -Unique)
        if ($parents.Count -ne 1 -or $paths.Count -ne 1) {
            throw "同一 Codex PID 存在冲突记录，无法唯一归属。"
        }
        $normalized += [pscustomobject][ordered]@{
            Id = [int]$group.Name
            ParentProcessId = [int]$parents[0]
            Path = [string]$paths[0]
        }
    }
    $ownedIds = @{}
    foreach ($process in $normalized) { $ownedIds[[int]$process.Id] = $process }
    $mainProcesses = @($normalized | Where-Object {
        -not $ownedIds.ContainsKey([int]$_.ParentProcessId)
    })
    if ($mainProcesses.Count -ne 1) {
        throw "Codex 主进程归属不唯一，拒绝判断 closed/native。"
    }
    $rootProcess = $mainProcesses[0]
    foreach ($process in $normalized) {
        $visited = @{}
        $current = $process
        while ($ownedIds.ContainsKey([int]$current.ParentProcessId)) {
            if ($visited.ContainsKey([int]$current.Id)) {
                throw "Codex 进程图包含归属环，拒绝判断 closed/native。"
            }
            $visited[[int]$current.Id] = $true
            $current = $ownedIds[[int]$current.ParentProcessId]
        }
        if ([int]$current.Id -ne [int]$rootProcess.Id) {
            throw "Codex 进程图包含孤立归属组件，拒绝判断 closed/native。"
        }
    }
    return "native"
}

function Restore-HeiGeApplyPrestate {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][ValidateSet("native", "closed")][string]$Mode
    )
    if ($Mode -ceq "native") {
        Restart-CodexWithoutCdp -AppInfo $Context.App -Port $Port | Out-Null
    } else {
        Get-CdpOwner -Port $Port -App $Context.App | Out-Null
        Stop-CodexNormally -AppInfo $Context.App | Out-Null
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            if (-not (Test-CdpEndpoint -Port $Port)) { break }
            if ($attempt -lt 19) { Start-Sleep -Milliseconds 250 }
        }
        if (Test-CdpEndpoint -Port $Port) {
            throw "closed 补偿后 CDP 端口仍未释放：$Port"
        }
        if (@(Get-RunningCodex -AppInfo $Context.App).Count -ne 0) {
            throw "closed 补偿后仍存在已归属的 Codex 进程。"
        }
    }
    return [pscustomobject][ordered]@{ Restored = $true; Mode = $Mode }
}

function Invoke-HeiGeApplyCompensation {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][ValidateSet("native", "closed")][string]$Mode,
        [scriptblock]$CompensateProvider
    )
    $values = @(
        if ($CompensateProvider) {
            & $CompensateProvider $Context $Port $Mode
        } else {
            Restore-HeiGeApplyPrestate -Context $Context -Port $Port -Mode $Mode
        }
    )
    if ($values.Count -ne 1 -or $null -eq $values[0] -or
        $values[0].PSObject.Properties.Name -notcontains "Restored" -or
        $values[0].Restored -isnot [System.Boolean] -or
        -not [bool]$values[0].Restored -or
        $values[0].PSObject.Properties.Name -notcontains "Mode" -or
        [string]$values[0].Mode -cne $Mode) {
        throw "apply 补偿未能验证已恢复 $Mode 前态。"
    }
    return $values[0]
}

function Test-HeiGeLockHeldError {
    param($ErrorObject)
    $text = if ($null -eq $ErrorObject) {
        ""
    } elseif ($ErrorObject -is [System.Management.Automation.ErrorRecord]) {
        [string]$ErrorObject.Exception.Message
    } elseif ($ErrorObject -is [System.Exception]) {
        [string]$ErrorObject.Message
    } else {
        [string]$ErrorObject
    }
    return $text -match '(^|[^\w])LOCK_HELD([^\w]|$)'
}

function Get-HeiGeErrorText {
    param($ErrorObject)
    if ($null -eq $ErrorObject) { return "" }
    if ($ErrorObject -is [System.Management.Automation.ErrorRecord]) {
        return [string]$ErrorObject.Exception.Message
    }
    if ($ErrorObject -is [System.Exception]) {
        return [string]$ErrorObject.Message
    }
    return [string]$ErrorObject
}

function Test-HeiGePrivateAclExact {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][bool]$IsDirectory
    )
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
        if ([bool]$item.PSIsContainer -ne $IsDirectory) { return $false }
        $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
        $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        try {
            $ownerSid = ([System.Security.Principal.NTAccount]$acl.Owner).Translate(
                [System.Security.Principal.SecurityIdentifier]
            )
        } catch {
            $ownerSid = New-Object System.Security.Principal.SecurityIdentifier -ArgumentList ([string]$acl.Owner)
        }
        if (-not $acl.AreAccessRulesProtected) { return $false }
        if ($ownerSid.Value -cne $currentSid.Value) { return $false }
        $rules = @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))
        if ($rules.Count -ne 1) { return $false }
        $rule = $rules[0]
        if ($rule.IdentityReference.Value -cne $currentSid.Value) { return $false }
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { return $false }
        $full = [System.Security.AccessControl.FileSystemRights]::FullControl
        if (($rule.FileSystemRights -band $full) -ne $full) { return $false }
        if ($IsDirectory) {
            $required = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
                [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
            if ($rule.InheritanceFlags -ne $required) { return $false }
            if ($rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) { return $false }
        } elseif ($rule.InheritanceFlags -ne [System.Security.AccessControl.InheritanceFlags]::None) {
            return $false
        }
        return $true
    } catch {
        return $false
    }
}

function Clear-HeiGeStaleLockArtifacts {
    param(
        [ValidateNotNullOrEmpty()][string]$StateRoot = (Join-Path $env:APPDATA "HeiGeCodexSkinStudio")
    )
    if (-not (Test-Path -LiteralPath $StateRoot -PathType Container)) {
        return [pscustomobject][ordered]@{ Removed = 0; StateRoot = $StateRoot }
    }
    $removed = 0
    $items = @(Get-ChildItem -LiteralPath $StateRoot -Force -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -like ".operation-lock*" -and (
                $_.Name -match '\.released\.' -or
                $_.Name -match '\.staging\.' -or
                $_.Name -match '\.stale\.'
            )
        })
    foreach ($item in $items) {
        try {
            Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction Stop
            $removed += 1
        } catch {
            # Best-effort hygiene only; acquire path remains fail-closed.
        }
    }

    # 坏掉的 operation.lock（ACL 不私有）会让 apply 直接 LOCK_PERMISSIONS；
    # 活锁在正常路径下 ACL 必为私有，因此这里只清不可验证的残留。
    $operationLock = Join-Path $StateRoot "operation.lock"
    if (Test-Path -LiteralPath $operationLock -PathType Container) {
        $ownerFile = Join-Path $operationLock "owner.json"
        $healthy = (Test-HeiGePrivateAclExact -Path $operationLock -IsDirectory $true) -and `
            (Test-Path -LiteralPath $ownerFile -PathType Leaf) -and `
            (Test-HeiGePrivateAclExact -Path $ownerFile -IsDirectory $false)
        if (-not $healthy) {
            try {
                Remove-Item -LiteralPath $operationLock -Recurse -Force -ErrorAction Stop
                $removed += 1
            } catch {}
        }
    }
    return [pscustomobject][ordered]@{ Removed = $removed; StateRoot = $StateRoot }
}

function Test-HeiGeBootstrapRetryableError {
    param($ErrorObject)
    $text = Get-HeiGeErrorText -ErrorObject $ErrorObject
    if ([string]::IsNullOrWhiteSpace($text)) { return $false }
    if (Test-HeiGeLockHeldError -ErrorObject $ErrorObject) { return $true }
    if ($text -match 'ephemeral controller 未确认皮肤已应用') { return $true }
    if ($text -match '未响应窗口关闭|改为结束已归属主进程') { return $true }
    if ($text -match '调试参数未生效|可能被残留的旧实例接管') { return $true }
    if ($text -match 'LOCK_PERMISSIONS') { return $true }
    return $false
}

function Resolve-HeiGeBootstrapAbortClass {
    param(
        [AllowNull()]$Doctor,
        [AllowNull()]$ErrorObject
    )
    $text = Get-HeiGeErrorText -ErrorObject $ErrorObject
    $diagnosis = if ($null -ne $Doctor -and $Doctor.PSObject.Properties.Name -contains "diagnosis") {
        [string]$Doctor.diagnosis
    } else {
        ""
    }

    if ($diagnosis -match '^flag-present-port-closed' -or
        $text -match '已带调试参数启动，但端口.*未开放|可能禁用了本机调试端口') {
        return [pscustomobject][ordered]@{
            Class = "abort-incompatible"
            Retryable = $false
            Title = "Codex 调试端口不可用"
            Guidance = "当前 Codex 已带调试参数但本机调试端口未开放（常见于部分 Microsoft Store/MSIX 会话）。可先完整退出 Codex：运行 scripts\windows\close-codex.bat（保持关闭），再决定是否允许重启或改装官方独立版（非商店版）后重试；若必须使用商店版，请附 doctor 输出与 Codex 版本号开 GitHub Issue。"
        }
    }
    if ($text -match '内置 Administrator|禁止该账户启动商店版') {
        return [pscustomobject][ordered]@{
            Class = "abort-environment"
            Retryable = $false
            Title = "账户环境不支持商店版 Codex"
            Guidance = "请改用普通用户账户（非内置 Administrator）再运行安装/启动器。"
        }
    }
    if ($text -match '归属不唯一|冲突记录|孤立归属|归属环|foreign|不匹配|多个安装根|包选择不唯一') {
        return [pscustomobject][ordered]@{
            Class = "abort-ambiguous"
            Retryable = $false
            Title = "Codex 进程归属不唯一"
            Guidance = "请只保留一个 Codex/ChatGPT 实例后重试；若同时安装了商店版与独立版，请先退出多余进程，或设置环境变量 HEIGE_CODEX_APP 指向目标 exe。"
        }
    }
    if ($text -match 'CDP 端口不属于|foreign Windows Codex|loopback owner is not unique') {
        return [pscustomobject][ordered]@{
            Class = "abort-port-conflict"
            Retryable = $false
            Title = "调试端口被其他进程占用"
            Guidance = "请关闭占用 127.0.0.1 调试端口的其他应用，或设置 HEIGE_CODEX_SKIN_PORT 换一个端口后重试。"
        }
    }
    if ($text -match '找不到可信的 Windows Store 包|HEIGE_CODEX_APP 指向的文件不存在|未找到|安装目录不存在|Node\.js|node ') {
        return [pscustomobject][ordered]@{
            Class = "abort-missing-deps"
            Retryable = $false
            Title = "缺少 Codex 或 Node 运行时"
            Guidance = "请先安装 Microsoft Store 的 ChatGPT/Codex Desktop，并确保系统 Node.js 为 22 或更新版本。"
        }
    }
    if (Test-HeiGeBootstrapRetryableError -ErrorObject $ErrorObject) {
        return [pscustomobject][ordered]@{
            Class = "retryable"
            Retryable = $true
            Title = "可自动重试的瞬时故障"
            Guidance = "正在自动重试；若仍失败，请彻底退出 Codex 后再次运行启动器。"
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($text)) {
        return [pscustomobject][ordered]@{
            Class = "abort-unknown"
            Retryable = $false
            Title = "皮肤启动失败"
            Guidance = "请彻底退出 Codex（托盘右键退出）后重试。仍失败请附完整报错开 Issue。"
        }
    }
    return [pscustomobject][ordered]@{
        Class = "continue"
        Retryable = $true
        Title = "继续"
        Guidance = ""
    }
}

function Format-HeiGeBootstrapFailure {
    param(
        [Parameter(Mandatory = $true)]$Abort,
        [Parameter(Mandatory = $true)]$ErrorObject
    )
    $detail = Get-HeiGeErrorText -ErrorObject $ErrorObject
    return @"
[$($Abort.Class)] $($Abort.Title)
$($Abort.Guidance)
详情：$detail
"@
}

function Invoke-HeiGeApplyWithLockRetry {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Action,
        [int[]]$DelayMilliseconds = @(1000, 2000, 3000),
        [scriptblock]$SleepProvider
    )
    if (-not $SleepProvider) {
        $SleepProvider = { param($Milliseconds) Start-Sleep -Milliseconds $Milliseconds }
    }
    $attempt = 0
    while ($true) {
        try {
            return & $Action
        } catch {
            $lockHeld = Test-HeiGeLockHeldError -ErrorObject $_
            if (-not $lockHeld -or $attempt -ge $DelayMilliseconds.Count) { throw }
            Write-Host ("检测到瞬时锁冲突（LOCK_HELD），{0} ms 后自动重试（{1}/{2}）……" -f `
                $DelayMilliseconds[$attempt], ($attempt + 1), $DelayMilliseconds.Count)
            & $SleepProvider $DelayMilliseconds[$attempt] | Out-Null
            $attempt += 1
        }
    }
}

function Invoke-HeiGeBootstrapDoctor {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][int]$Port,
        [scriptblock]$DoctorProvider
    )
    if ($DoctorProvider) {
        $values = @(& $DoctorProvider $Context $Port)
        if ($values.Count -ne 1 -or $null -eq $values[0]) {
            throw "doctor 预检结果不唯一。"
        }
        return $values[0]
    }
    return Invoke-HeiGeContextCli -Context $Context `
        -Arguments @("doctor", "--port", [string]$Port)
}

function Test-HeiGeBootstrapSkinActive {
    param(
        [Parameter(Mandatory = $true)]$Status,
        [AllowNull()][string]$Theme
    )
    if ($null -eq $Status) { return $false }
    $statuses = @($Status.statuses)
    if ($statuses.Count -le 0) { return $false }
    if ($Status.PSObject.Properties.Name -contains "failed" -and @($Status.failed).Count -gt 0) {
        return $false
    }
    foreach ($entry in $statuses) {
        if ($null -eq $entry) { return $false }
        if ($entry.PSObject.Properties.Name -notcontains "installed" -or $entry.installed -ne $true) {
            return $false
        }
        if ($entry.PSObject.Properties.Name -notcontains "mode" -or [string]$entry.mode -cne "active") {
            return $false
        }
        if (-not [string]::IsNullOrWhiteSpace($Theme)) {
            if ($entry.PSObject.Properties.Name -notcontains "themeId" -or
                [string]$entry.themeId -cne $Theme) {
                return $false
            }
        }
    }
    return $true
}

function Invoke-HeiGeBootstrapHygiene {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][int]$Port,
        [scriptblock]$ProcessProvider,
        [scriptblock]$CdpStatusProvider
    )
    Clear-HeiGeStaleLockArtifacts | Out-Null

    # Ambiguous ownership must fail closed before we touch lifecycle.
    $mode = Get-HeiGeEntrypointProcessMode -Context $Context -ProcessProvider $ProcessProvider
    if (@("closed", "native") -cnotcontains $mode) {
        throw "Codex 进程模式无效：$mode"
    }

    $hasExactCdp = if ($CdpStatusProvider) {
        [bool](& $CdpStatusProvider $Context $Port)
    } else {
        Test-Cdp -Port $Port -App $Context.App
    }
    if ($hasExactCdp) {
        return [pscustomobject][ordered]@{ Mode = $mode; HasExactCdp = $true }
    }

    if (-not $CdpStatusProvider -and (Test-CdpEndpoint -Port $Port)) {
        try {
            Get-CdpOwner -Port $Port -App $Context.App | Out-Null
        } catch {
            throw "CDP 端口不属于已解析的 Codex：$Port。$($_.Exception.Message)"
        }
    }
    return [pscustomobject][ordered]@{ Mode = $mode; HasExactCdp = $false }
}

function Invoke-HeiGeBootstrapVerify {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][int]$Port,
        [AllowNull()][string]$Theme,
        [scriptblock]$CliProvider,
        [scriptblock]$StatusProvider
    )
    $status = if ($StatusProvider) {
        $values = @(& $StatusProvider $Context $Port)
        if ($values.Count -ne 1) { throw "status 校验结果不唯一。" }
        $values[0]
    } else {
        Invoke-HeiGeContextCli -Context $Context `
            -Arguments @("status", "--port", [string]$Port) -CliProvider $CliProvider
    }
    if (-not (Test-HeiGeBootstrapSkinActive -Status $status -Theme $Theme)) {
        throw "皮肤启动后校验失败：主题未处于 active 状态。"
    }
    return $status
}

function Invoke-HeiGeBootstrapAndApply {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [AllowNull()][string]$Theme,
        [Parameter(Mandatory = $true)][int]$Port,
        [ValidateRange(1, 5)][int]$MaxApplyAttempts = 2,
        [switch]$SkipDoctor,
        [scriptblock]$DoctorProvider,
        [scriptblock]$StartCdpProvider,
        [scriptblock]$CliProvider,
        [scriptblock]$CdpStatusProvider,
        [scriptblock]$ProcessProvider,
        [scriptblock]$CompensateProvider,
        [scriptblock]$SleepProvider,
        [scriptblock]$StatusProvider,
        [scriptblock]$HygieneProvider
    )
    if (-not $SleepProvider) {
        $SleepProvider = { param($Milliseconds) Start-Sleep -Milliseconds $Milliseconds }
    }

    $steps = New-Object System.Collections.Generic.List[string]
    $doctor = $null
    $runDoctor = -not $SkipDoctor.IsPresent -and (
        $PSBoundParameters.ContainsKey("DoctorProvider") -or
        -not $PSBoundParameters.ContainsKey("CliProvider")
    )
    if ($runDoctor) {
        Write-Host "自检：检查 Codex / CDP 环境……"
        $steps.Add("doctor") | Out-Null
        try {
            $doctor = Invoke-HeiGeBootstrapDoctor -Context $Context -Port $Port `
                -DoctorProvider $DoctorProvider
        } catch {
            $abort = Resolve-HeiGeBootstrapAbortClass -Doctor $null -ErrorObject $_
            throw (Format-HeiGeBootstrapFailure -Abort $abort -ErrorObject $_)
        }
        $doctorAbort = Resolve-HeiGeBootstrapAbortClass -Doctor $doctor -ErrorObject $null
        if ($doctorAbort.Class -ceq "abort-incompatible") {
            throw (Format-HeiGeBootstrapFailure -Abort $doctorAbort -ErrorObject ([string]$doctor.diagnosis))
        }
        Write-Host ("自检结果：{0}" -f [string]$doctor.diagnosis)
    } else {
        $steps.Add("doctor-skipped") | Out-Null
    }

    Write-Host "自愈：检查进程归属与端口……"
    $steps.Add("hygiene") | Out-Null
    try {
        if ($HygieneProvider) {
            & $HygieneProvider $Context $Port | Out-Null
        } else {
            Invoke-HeiGeBootstrapHygiene -Context $Context -Port $Port `
                -ProcessProvider $ProcessProvider -CdpStatusProvider $CdpStatusProvider | Out-Null
        }
    } catch {
        $abort = Resolve-HeiGeBootstrapAbortClass -Doctor $doctor -ErrorObject $_
        throw (Format-HeiGeBootstrapFailure -Abort $abort -ErrorObject $_)
    }

    # Idempotent fast path: exact CDP + already-active skin.
    $alreadyCdp = if ($CdpStatusProvider) {
        [bool](& $CdpStatusProvider $Context $Port)
    } else {
        Test-Cdp -Port $Port -App $Context.App
    }
    if ($alreadyCdp) {
        try {
            $status = if ($StatusProvider) {
                $values = @(& $StatusProvider $Context $Port)
                if ($values.Count -eq 1) { $values[0] } else { $null }
            } else {
                Invoke-HeiGeContextCli -Context $Context `
                    -Arguments @("status", "--port", [string]$Port) -CliProvider $CliProvider
            }
            if (Test-HeiGeBootstrapSkinActive -Status $status -Theme $Theme) {
                Write-Host "自检：皮肤已处于 active，跳过重复注入。"
                $steps.Add("idempotent-active") | Out-Null
                return [pscustomobject][ordered]@{
                    mode = "active"
                    persistenceEnabled = if (
                        $null -ne $status.statuses -and
                        @($status.statuses).Count -gt 0 -and
                        $status.statuses[0].PSObject.Properties.Name -contains "persistenceEnabled"
                    ) {
                        [bool]$status.statuses[0].persistenceEnabled
                    } else {
                        $false
                    }
                    BootstrapSteps = @($steps)
                    BootstrapIdempotent = $true
                }
            }
        } catch {
            # Status probe failures fall through to full apply.
        }
    }

    $lastError = $null
    for ($attempt = 1; $attempt -le $MaxApplyAttempts; $attempt++) {
        try {
            Write-Host ("启动：确保调试模式并应用皮肤（第 {0}/{1} 次）……" -f $attempt, $MaxApplyAttempts)
            $steps.Add("apply:$attempt") | Out-Null
            $applied = Invoke-HeiGeApplyWithContext -Context $Context -Theme $Theme -Port $Port `
                -StartCdpProvider $StartCdpProvider -CliProvider $CliProvider `
                -CdpStatusProvider $CdpStatusProvider -ProcessProvider $ProcessProvider `
                -CompensateProvider $CompensateProvider -SleepProvider $SleepProvider
            Write-Host "校验：确认皮肤已生效……"
            $steps.Add("verify:$attempt") | Out-Null
            Invoke-HeiGeBootstrapVerify -Context $Context -Port $Port -Theme $Theme `
                -CliProvider $CliProvider -StatusProvider $StatusProvider | Out-Null
            $applied | Add-Member -NotePropertyName BootstrapSteps -NotePropertyValue @($steps) -Force
            $applied | Add-Member -NotePropertyName BootstrapIdempotent -NotePropertyValue $false -Force
            return $applied
        } catch {
            $lastError = $_
            $abort = Resolve-HeiGeBootstrapAbortClass -Doctor $doctor -ErrorObject $_
            $canRetry = $abort.Retryable -and ($attempt -lt $MaxApplyAttempts)
            if (-not $canRetry) {
                throw (Format-HeiGeBootstrapFailure -Abort $abort -ErrorObject $_)
            }
            Write-Host ("自愈：第 {0} 次未成功（{1}），准备再次尝试……" -f $attempt, $abort.Title)
            $steps.Add("retry:$attempt") | Out-Null
            if ((Get-HeiGeErrorText -ErrorObject $_) -match 'LOCK_PERMISSIONS') {
                Clear-HeiGeStaleLockArtifacts | Out-Null
            }
            & $SleepProvider (1000 * $attempt) | Out-Null
        }
    }
    $finalAbort = Resolve-HeiGeBootstrapAbortClass -Doctor $doctor -ErrorObject $lastError
    throw (Format-HeiGeBootstrapFailure -Abort $finalAbort -ErrorObject $lastError)
}

function Invoke-HeiGeApplyWithContext {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [AllowNull()][string]$Theme,
        [Parameter(Mandatory = $true)][int]$Port,
        [scriptblock]$StartCdpProvider,
        [scriptblock]$CliProvider,
        [scriptblock]$CdpStatusProvider,
        [scriptblock]$ProcessProvider,
        [scriptblock]$CompensateProvider,
        [scriptblock]$SleepProvider
    )
    $hasExactCdp = if ($CdpStatusProvider) {
        [bool](& $CdpStatusProvider $Context $Port)
    } else {
        Test-Cdp -Port $Port -App $Context.App
    }
    $prestate = if ($hasExactCdp) {
        "cdp"
    } else {
        Get-HeiGeEntrypointProcessMode -Context $Context -ProcessProvider $ProcessProvider
    }
    Start-HeiGeEntrypointCdp -Context $Context -Port $Port -StartCdpProvider $StartCdpProvider
    Write-Host "注入：正在向 Codex 应用皮肤（无需点击，请稍候）……"
    if (-not $StartCdpProvider) {
        # StartCdp 路径已尝试拉前台；这里再推一次，覆盖「端口早已就绪」的快路径。
        Show-HeiGeCodexWindow -AppInfo $Context.App -ProcessProvider $ProcessProvider | Out-Null
    }
    $arguments = @("apply")
    if ([string]::IsNullOrWhiteSpace($Theme)) {
        $arguments += "--prefer-stored"
    } else {
        $arguments += @("--theme", $Theme)
    }
    $arguments += @("--port", [string]$Port)
    try {
        $result = Invoke-HeiGeApplyWithLockRetry -SleepProvider $SleepProvider -Action {
            Invoke-HeiGeContextCli -Context $Context `
                -Arguments $arguments -CliProvider $CliProvider
        }
        Assert-HeiGeModeResult -Result $result -Expected "active"
        return $result
    } catch {
        $applyError = $_.Exception
        if ($prestate -ceq "cdp") { throw $applyError }
        try {
            Invoke-HeiGeApplyCompensation -Context $Context -Port $Port -Mode $prestate `
                -CompensateProvider $CompensateProvider | Out-Null
        } catch {
            throw "皮肤应用失败且未能恢复启动前状态。原始错误：$($applyError.Message)；补偿错误：$($_.Exception.Message)"
        }
        throw $applyError
    }
}

function Invoke-HeiGeApplyFlow {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [AllowNull()][string]$Theme,
        [ValidateRange(1024, 65535)][int]$Port = 9341,
        [ValidateRange(1, 5)][int]$MaxApplyAttempts = 2,
        [switch]$SkipDoctor,
        [switch]$SkipBootstrap,
        [scriptblock]$ContextProvider,
        [scriptblock]$DoctorProvider,
        [scriptblock]$StartCdpProvider,
        [scriptblock]$CliProvider,
        [scriptblock]$CdpStatusProvider,
        [scriptblock]$ProcessProvider,
        [scriptblock]$CompensateProvider,
        [scriptblock]$SleepProvider,
        [scriptblock]$StatusProvider,
        [scriptblock]$HygieneProvider
    )
    if ($PSBoundParameters.ContainsKey("Theme") -and [string]::IsNullOrWhiteSpace($Theme)) {
        throw "Theme 显式传入时不能为空。"
    }
    $context = Get-HeiGeFlowContext -Root $Root -ContextProvider $ContextProvider

    # Unit tests inject CliProvider without bootstrap providers; keep the legacy
    # direct apply path so they do not hit real doctor/status/CIM.
    $autoSkipBootstrap = $PSBoundParameters.ContainsKey("CliProvider") -and
        -not $PSBoundParameters.ContainsKey("DoctorProvider") -and
        -not $PSBoundParameters.ContainsKey("StatusProvider") -and
        -not $PSBoundParameters.ContainsKey("HygieneProvider")

    $applied = if ($SkipBootstrap.IsPresent -or $autoSkipBootstrap) {
        Invoke-HeiGeApplyWithContext -Context $context -Theme $Theme -Port $Port `
            -StartCdpProvider $StartCdpProvider -CliProvider $CliProvider `
            -CdpStatusProvider $CdpStatusProvider -ProcessProvider $ProcessProvider `
            -CompensateProvider $CompensateProvider -SleepProvider $SleepProvider
    } else {
        $bootstrapArgs = @{
            Context = $context
            Theme = $Theme
            Port = $Port
            MaxApplyAttempts = $MaxApplyAttempts
        }
        if ($SkipDoctor.IsPresent) { $bootstrapArgs.SkipDoctor = $true }
        foreach ($name in @(
            "DoctorProvider", "StartCdpProvider", "CliProvider", "CdpStatusProvider",
            "ProcessProvider", "CompensateProvider", "SleepProvider", "StatusProvider",
            "HygieneProvider"
        )) {
            if ($PSBoundParameters.ContainsKey($name)) {
                $bootstrapArgs[$name] = $PSBoundParameters[$name]
            }
        }
        Invoke-HeiGeBootstrapAndApply @bootstrapArgs
    }

    if ($applied.PSObject.Properties.Name -notcontains "persistenceEnabled" -or
        $applied.persistenceEnabled -isnot [System.Boolean]) {
        throw "apply 未返回可验证的常驻状态。"
    }
    return [pscustomobject][ordered]@{
        Mode = "active"
        PersistenceEnabled = [bool]$applied.persistenceEnabled
        PersistenceChanged = $false
        Theme = $Theme
        ThemeSelection = if ($PSBoundParameters.ContainsKey("Theme")) {
            "explicit"
        } else {
            "stored-or-default"
        }
        Completion = "complete"
        BootstrapIdempotent = if (
            $applied.PSObject.Properties.Name -contains "BootstrapIdempotent"
        ) {
            [bool]$applied.BootstrapIdempotent
        } else {
            $false
        }
        BootstrapSteps = if (
            $applied.PSObject.Properties.Name -contains "BootstrapSteps"
        ) {
            @($applied.BootstrapSteps)
        } else {
            @()
        }
    }
}

function Invoke-HeiGeEnableSkinFlow {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [AllowNull()][string]$Theme,
        [ValidateRange(1024, 65535)][int]$Port = 9341,
        [scriptblock]$ContextProvider,
        [scriptblock]$StartCdpProvider,
        [scriptblock]$CliProvider,
        [scriptblock]$CdpStatusProvider,
        [scriptblock]$ProcessProvider,
        [scriptblock]$CompensateProvider,
        [scriptblock]$SleepProvider,
        [scriptblock]$DoctorProvider,
        [scriptblock]$StatusProvider,
        [scriptblock]$HygieneProvider
    )
    if ($PSBoundParameters.ContainsKey("Theme") -and [string]::IsNullOrWhiteSpace($Theme)) {
        throw "Theme 显式传入时不能为空。"
    }
    $arguments = @{ Root = $Root; Port = $Port }
    foreach ($name in @(
        "Theme", "ContextProvider", "StartCdpProvider", "CliProvider", "CdpStatusProvider",
        "ProcessProvider", "CompensateProvider", "SleepProvider", "DoctorProvider",
        "StatusProvider", "HygieneProvider"
    )) {
        if ($PSBoundParameters.ContainsKey($name)) {
            $arguments[$name] = $PSBoundParameters[$name]
        }
    }
    return Invoke-HeiGeApplyFlow @arguments
}

function Get-HeiGePersistenceEnabledHint {
    param([AllowNull()][string]$StateDirectory)
    if (-not $StateDirectory) { return $null }
    try {
        $path = Join-Path $StateDirectory "state.json"
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
        $doc = Get-Content -LiteralPath $path -Raw -ErrorAction Stop | ConvertFrom-Json
        if ($doc.PSObject.Properties.Name -contains "persistenceEnabled" -and
            $doc.persistenceEnabled -is [bool]) {
            return [bool]$doc.persistenceEnabled
        }
    } catch {
        return $null
    }
    return $null
}

function Invoke-HeiGeCloseCodexFlow {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [scriptblock]$ContextProvider,
        [scriptblock]$ProcessProvider,
        [scriptblock]$StopProcessProvider,
        [scriptblock]$CloseProvider,
        [scriptblock]$StopProvider,
        [scriptblock]$SleepProvider,
        [scriptblock]$StopCodexProvider,
        [scriptblock]$PersistenceHintProvider,
        [ValidateRange(1, 120)][int]$TimeoutSeconds = 15
    )
    $context = Get-HeiGeFlowContext -Root $Root -ContextProvider $ContextProvider
    $mode = Get-HeiGeEntrypointProcessMode -Context $context -ProcessProvider $ProcessProvider
    $persistenceEnabled = if ($PersistenceHintProvider) {
        & $PersistenceHintProvider $context
    } else {
        Get-HeiGePersistenceEnabledHint -StateDirectory ([string]$context.StateDirectory)
    }

    if ($mode -ceq "closed") {
        return [pscustomobject][ordered]@{
            AlreadyStopped = $true
            Closed = $false
            Escalated = $false
            VerifiedStopped = $true
            PersistenceEnabled = $persistenceEnabled
            Completion = "complete"
        }
    }

    $stopResult = if ($StopCodexProvider) {
        & $StopCodexProvider $context
    } else {
        $stopArgs = @{
            AppInfo = $context.App
            TimeoutSeconds = $TimeoutSeconds
        }
        if ($StopProcessProvider) { $stopArgs.ProcessProvider = $StopProcessProvider }
        if ($CloseProvider) { $stopArgs.CloseProvider = $CloseProvider }
        if ($StopProvider) { $stopArgs.StopProvider = $StopProvider }
        if ($SleepProvider) { $stopArgs.SleepProvider = $SleepProvider }
        Stop-CodexNormally @stopArgs
    }

    $remaining = @(Get-RunningCodex -AppInfo $context.App -ProcessProvider $StopProcessProvider)
    if ($remaining.Count -ne 0) {
        throw "Codex 关闭后仍检测到已归属主进程，请手动彻底退出后再试。"
    }

    return [pscustomobject][ordered]@{
        AlreadyStopped = [bool]$stopResult.AlreadyStopped
        Closed = [bool]$stopResult.Closed
        Escalated = [bool]$stopResult.Escalated
        VerifiedStopped = [bool]$stopResult.VerifiedStopped
        PersistenceEnabled = $persistenceEnabled
        Completion = "complete"
    }
}

function Invoke-HeiGePauseFlow {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [ValidateRange(1024, 65535)][int]$Port = 9341,
        [scriptblock]$ContextProvider,
        [scriptblock]$CdpStatusProvider,
        [scriptblock]$CliProvider
    )
    $context = Get-HeiGeFlowContext -Root $Root -ContextProvider $ContextProvider
    $hasCdp = if ($CdpStatusProvider) {
        [bool](& $CdpStatusProvider $context $Port)
    } else {
        Test-Cdp -Port $Port -App $context.App
    }
    if (-not $hasCdp) {
        return [pscustomobject][ordered]@{
            Mode = "noop"
            PersistenceEnabled = $null
            Completion = "complete"
        }
    }
    $result = Invoke-HeiGeContextCli -Context $context `
        -Arguments @("pause", "--port", [string]$Port) -CliProvider $CliProvider
    Assert-HeiGeModeResult -Result $result -Expected "paused"
    return [pscustomobject][ordered]@{
        Mode = "paused"
        PersistenceEnabled = if ($result.PSObject.Properties.Name -contains "persistenceEnabled") {
            [bool]$result.persistenceEnabled
        } else { $null }
        Completion = "complete"
    }
}

function Invoke-HeiGeResumeFlow {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [ValidateRange(1024, 65535)][int]$Port = 9341,
        [scriptblock]$ContextProvider,
        [scriptblock]$RequireCdpProvider,
        [scriptblock]$CliProvider
    )
    $context = Get-HeiGeFlowContext -Root $Root -ContextProvider $ContextProvider
    Require-HeiGeEntrypointCdp -Context $context -Port $Port -RequireCdpProvider $RequireCdpProvider
    $result = Invoke-HeiGeContextCli -Context $context `
        -Arguments @("resume", "--port", [string]$Port) -CliProvider $CliProvider
    Assert-HeiGeModeResult -Result $result -Expected "active"
    return [pscustomobject][ordered]@{
        Mode = "active"
        PersistenceEnabled = if ($result.PSObject.Properties.Name -contains "persistenceEnabled") {
            [bool]$result.persistenceEnabled
        } else { $null }
        Completion = "complete"
    }
}

function Invoke-HeiGeRestoreFlow {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [ValidateRange(1024, 65535)][int]$Port = 9341,
        [scriptblock]$ContextProvider,
        [scriptblock]$CdpStatusProvider,
        [scriptblock]$ProcessProvider,
        [scriptblock]$CliProvider,
        [scriptblock]$UnregisterProvider,
        [scriptblock]$RestartNativeProvider
    )
    $context = Get-HeiGeFlowContext -Root $Root -ContextProvider $ContextProvider
    $hasExactCdp = if ($CdpStatusProvider) {
        [bool](& $CdpStatusProvider $context $Port)
    } else {
        Test-Cdp -Port $Port -App $context.App
    }
    if (-not $hasExactCdp) {
        Get-HeiGeEntrypointProcessMode -Context $context `
            -ProcessProvider $ProcessProvider | Out-Null
    }
    $disabled = Invoke-HeiGeContextCli -Context $context `
        -Arguments @("set-persistence", "false", "--port", [string]$Port) -CliProvider $CliProvider
    Assert-HeiGePersistenceResult -Result $disabled -Expected $false
    $hasExactCdp = if ($CdpStatusProvider) {
        [bool](& $CdpStatusProvider $context $Port)
    } else {
        Test-Cdp -Port $Port -App $context.App
    }
    if ($hasExactCdp) {
        $paused = Invoke-HeiGeContextCli -Context $context `
            -Arguments @("pause", "--port", [string]$Port) -CliProvider $CliProvider
        Assert-HeiGeModeResult -Result $paused -Expected "paused"
    }
    Unregister-HeiGeEntrypointTask -Context $context -UnregisterProvider $UnregisterProvider | Out-Null
    $offlineMode = if ($hasExactCdp) {
        $null
    } else {
        Get-HeiGeEntrypointProcessMode -Context $context -ProcessProvider $ProcessProvider
    }
    if ($hasExactCdp) {
        if ($RestartNativeProvider) {
            & $RestartNativeProvider $context $Port | Out-Null
        } else {
            Restart-CodexWithoutCdp -AppInfo $context.App -Port $Port
        }
    }
    return [pscustomobject][ordered]@{
        Mode = if ($hasExactCdp) { "restoring" } else { $offlineMode }
        PersistenceEnabled = $false
        Completion = "complete"
    }
}

function Get-HeiGeDefaultInstallRoot {
    if (-not $env:USERPROFILE) {
        throw "无法解析当前用户的默认安装目录。"
    }
    return (Join-Path $env:USERPROFILE ".codex\heige-codex-skin-studio")
}

function Assert-HeiGeUninstallNoReparseComponents {
    param([Parameter(Mandatory = $true)][string]$Path)
    $resolved = Get-HeiGeComparablePath -Path $Path
    $root = [System.IO.Path]::GetPathRoot($resolved)
    $relative = $resolved.Substring($root.Length)
    $current = $root
    foreach ($segment in @($relative -split '[\\/]')) {
        if (-not $segment) { continue }
        $current = Join-Path $current $segment
        if (-not (Test-Path -LiteralPath $current)) { break }
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "卸载路径不能包含 reparse point：$current"
        }
    }
    return $resolved
}

function Test-HeiGeOwnedInstallMarker {
    param([Parameter(Mandatory = $true)][string]$InstallRoot)
    $markerPath = Join-Path $InstallRoot ".heige-install.json"
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { return $false }
    try {
        $markerItem = Get-Item -LiteralPath $markerPath -Force -ErrorAction Stop
        if (($markerItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            $markerItem.Length -le 0 -or $markerItem.Length -gt 65536) {
            return $false
        }
        $marker = [System.IO.File]::ReadAllText($markerPath) | ConvertFrom-Json
        $names = @($marker.PSObject.Properties.Name | Sort-Object)
        $expected = @("kind", "manifestSha256", "product", "schemaVersion" | Sort-Object)
        if ($names.Count -ne $expected.Count) { return $false }
        for ($index = 0; $index -lt $expected.Count; $index++) {
            if ([string]$names[$index] -cne [string]$expected[$index]) { return $false }
        }
        return (
            $marker.schemaVersion -is [int] -and
            [int]$marker.schemaVersion -eq 1 -and
            [string]$marker.product -ceq "heige-codex-skin-studio" -and
            [string]$marker.kind -ceq "stable-tree" -and
            [string]$marker.manifestSha256 -cmatch '^[a-f0-9]{64}$'
        )
    } catch {
        return $false
    }
}

function Resolve-HeiGeUninstallInstallRoot {
    param(
        [AllowNull()][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$ScriptTreeRoot
    )
    $defaultInstall = Get-HeiGeComparablePath -Path (Get-HeiGeDefaultInstallRoot)
    if ($InstallRoot) {
        return (Get-HeiGeComparablePath -Path $InstallRoot)
    }
    $scriptRoot = Get-HeiGeComparablePath -Path $ScriptTreeRoot
    if ($scriptRoot -ieq $defaultInstall -or
        (Test-HeiGeOwnedInstallMarker -InstallRoot $scriptRoot)) {
        return $scriptRoot
    }
    return $defaultInstall
}

function Assert-HeiGeRemovableInstallRoot {
    param([Parameter(Mandatory = $true)][string]$InstallRoot)
    $resolved = Get-HeiGeComparablePath -Path $InstallRoot
    if ((Split-Path $resolved -Leaf) -cne "heige-codex-skin-studio") {
        throw "卸载拒绝删除目录名不是 heige-codex-skin-studio 的路径：$resolved"
    }
    if (Test-Path -LiteralPath $resolved) {
        Assert-HeiGeUninstallNoReparseComponents -Path $resolved | Out-Null
        $defaultInstall = Get-HeiGeComparablePath -Path (Get-HeiGeDefaultInstallRoot)
        if ($resolved -ine $defaultInstall -and
            -not (Test-HeiGeOwnedInstallMarker -InstallRoot $resolved)) {
            throw "非默认安装目录缺少有效 HeiGe ownership marker，拒绝删除：$resolved"
        }
    }
    return $resolved
}

function Stop-HeiGeControllerResidue {
    param(
        [AllowNull()][string]$InstallRoot,
        [scriptblock]$ProcessProvider,
        [scriptblock]$StopProvider
    )
    $currentPid = $PID
    $records = if ($ProcessProvider) {
        @(& $ProcessProvider)
    } else {
        @(Get-CimInstance -ClassName Win32_Process `
            -Filter "Name='node.exe' OR Name='powershell.exe' OR Name='pwsh.exe'" `
            -ErrorAction SilentlyContinue)
    }

    $cliNeedle = $null
    $controllerNeedle = $null
    if ($InstallRoot) {
        $resolvedInstall = Get-HeiGeComparablePath -Path $InstallRoot
        $cliNeedle = Join-Path $resolvedInstall "src\cli.mjs"
        $controllerNeedle = Join-Path $resolvedInstall "scripts\windows\controller.ps1"
    }

    $stopped = New-Object System.Collections.Generic.List[int]
    foreach ($record in $records) {
        if ($null -eq $record) { continue }
        $processId = 0
        if (-not [int]::TryParse([string]$record.ProcessId, [ref]$processId) -or
            $processId -le 0 -or $processId -eq $currentPid) {
            continue
        }
        $commandLine = [string]$record.CommandLine
        if (-not $commandLine) { continue }

        $isHeige = $false
        if ($cliNeedle -and
            $commandLine.IndexOf($cliNeedle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $isHeige = $true
        }
        if ($controllerNeedle -and
            $commandLine.IndexOf($controllerNeedle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $isHeige = $true
        }
        if (-not $isHeige) { continue }

        if ($StopProvider) {
            & $StopProvider $record | Out-Null
        } else {
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        }
        $stopped.Add($processId) | Out-Null
    }

    return [pscustomobject][ordered]@{
        StoppedProcessIds = @($stopped)
    }
}

function Remove-HeiGeStateDirectoryForUninstall {
    param(
        [AllowNull()][string]$StateDirectory,
        [scriptblock]$RemoveProvider
    )
    $resolved = Resolve-HeiGeScopedStateDirectory -StateDirectory $StateDirectory
    if (-not (Test-Path -LiteralPath $resolved)) {
        return [pscustomobject][ordered]@{
            Path = $resolved
            PriorExisted = $false
            Removed = $false
            VerifiedAbsent = $true
        }
    }
    Assert-HeiGeUninstallNoReparseComponents -Path $resolved | Out-Null
    Protect-HeiGeStateDirectory -Path $resolved | Out-Null
    if ($RemoveProvider) {
        & $RemoveProvider $resolved | Out-Null
    } else {
        Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
    }
    if (Test-Path -LiteralPath $resolved) {
        throw "状态目录删除后仍存在：$resolved"
    }
    return [pscustomobject][ordered]@{
        Path = $resolved
        PriorExisted = $true
        Removed = $true
        VerifiedAbsent = $true
    }
}

function Remove-HeiGeInstallTreeForUninstall {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [AllowNull()][string]$CallerScriptPath,
        [scriptblock]$RemoveProvider,
        [scriptblock]$DeferProvider
    )
    $resolved = Assert-HeiGeRemovableInstallRoot -InstallRoot $InstallRoot
    if (-not (Test-Path -LiteralPath $resolved)) {
        return [pscustomobject][ordered]@{
            Path = $resolved
            PriorExisted = $false
            Removed = $false
            Deferred = $false
            VerifiedAbsent = $true
        }
    }

    $callerInside = $false
    if ($CallerScriptPath) {
        $callerFull = Get-HeiGeComparablePath -Path (Split-Path -Parent $CallerScriptPath)
        $prefix = $resolved + [System.IO.Path]::DirectorySeparatorChar
        if ($callerFull -ieq $resolved -or
            $callerFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            $callerInside = $true
        }
    }

    if ($callerInside) {
        if ($DeferProvider) {
            & $DeferProvider $resolved | Out-Null
        } else {
            $quoted = $resolved.Replace('"', '""')
            Start-Process -FilePath "cmd.exe" `
                -ArgumentList @("/c", "ping 127.0.0.1 -n 3 >nul & rmdir /s /q `"$quoted`"") `
                -WindowStyle Hidden | Out-Null
        }
        return [pscustomobject][ordered]@{
            Path = $resolved
            PriorExisted = $true
            Removed = $false
            Deferred = $true
            VerifiedAbsent = $false
        }
    }

    if ($RemoveProvider) {
        & $RemoveProvider $resolved | Out-Null
    } else {
        Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
    }
    if (Test-Path -LiteralPath $resolved) {
        throw "安装目录删除后仍存在：$resolved"
    }
    return [pscustomobject][ordered]@{
        Path = $resolved
        PriorExisted = $true
        Removed = $true
        Deferred = $false
        VerifiedAbsent = $true
    }
}

function Invoke-HeiGeUninstallFlow {
    param(
        [AllowNull()][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$ScriptTreeRoot,
        [ValidateRange(1024, 65535)][int]$Port = 9341,
        [AllowNull()][string]$StartMenuRoot,
        [AllowNull()][string]$StateDirectory,
        [string]$TaskName = $script:HeiGeProductionTaskName,
        [AllowNull()][string]$CallerScriptPath,
        [scriptblock]$SoftDisableProvider,
        [scriptblock]$UnregisterProvider,
        [scriptblock]$ShortcutProvider,
        [scriptblock]$ResidueProvider,
        [scriptblock]$StateRemoveProvider,
        [scriptblock]$InstallRemoveProvider
    )
    $resolvedInstall = Resolve-HeiGeUninstallInstallRoot `
        -InstallRoot $InstallRoot -ScriptTreeRoot $ScriptTreeRoot
    Assert-HeiGeRemovableInstallRoot -InstallRoot $resolvedInstall | Out-Null
    Assert-HeiGeKnownTaskName -TaskName $TaskName

    $softDisableAttempted = $false
    $softDisableSucceeded = $false
    $cliPath = Join-Path $resolvedInstall "src\cli.mjs"
    if (Test-Path -LiteralPath $cliPath -PathType Leaf) {
        $softDisableAttempted = $true
        try {
            if ($SoftDisableProvider) {
                & $SoftDisableProvider $resolvedInstall $Port | Out-Null
            } else {
                $context = New-HeiGeWindowsEntrypointContext -Root $resolvedInstall
                $disabled = Invoke-HeiGeContextCli -Context $context `
                    -Arguments @("set-persistence", "false", "--port", [string]$Port)
                Assert-HeiGePersistenceResult -Result $disabled -Expected $false
                if (Test-Cdp -Port $Port -App $context.App) {
                    $paused = Invoke-HeiGeContextCli -Context $context `
                        -Arguments @("pause", "--port", [string]$Port)
                    Assert-HeiGeModeResult -Result $paused -Expected "paused"
                }
            }
            $softDisableSucceeded = $true
        } catch {
            $softDisableSucceeded = $false
        }
    }

    $unregisterResult = if ($UnregisterProvider) {
        & $UnregisterProvider $resolvedInstall $TaskName $StateDirectory
    } else {
        Unregister-HeiGeScheduledTask -TaskName $TaskName -StateDirectory $StateDirectory
    }
    if ($null -eq $unregisterResult -or
        $unregisterResult.PSObject.Properties.Name -notcontains "VerifiedAbsent" -or
        -not [bool]$unregisterResult.VerifiedAbsent) {
        throw "Scheduled Task 注销后未能验证任务已消失。"
    }

    $shortcutResult = if ($ShortcutProvider) {
        & $ShortcutProvider $resolvedInstall $StartMenuRoot
    } else {
        if (Get-Command Remove-HeiGeStartMenuShortcutForUninstall -ErrorAction SilentlyContinue) {
            Remove-HeiGeStartMenuShortcutForUninstall -InstallRoot $resolvedInstall `
                -StartMenuRoot $StartMenuRoot
        } else {
            [pscustomobject][ordered]@{
                PriorExisted = $false
                Removed = $false
                VerifiedAbsent = $true
                FolderRemoved = $false
            }
        }
    }

    $residueResult = if ($ResidueProvider) {
        & $ResidueProvider $resolvedInstall
    } else {
        Stop-HeiGeControllerResidue -InstallRoot $resolvedInstall
    }

    $stateResult = if ($StateRemoveProvider) {
        & $StateRemoveProvider $StateDirectory
    } else {
        Remove-HeiGeStateDirectoryForUninstall -StateDirectory $StateDirectory
    }

    $installResult = if ($InstallRemoveProvider) {
        & $InstallRemoveProvider $resolvedInstall $CallerScriptPath
    } else {
        Remove-HeiGeInstallTreeForUninstall -InstallRoot $resolvedInstall `
            -CallerScriptPath $CallerScriptPath
    }

    return [pscustomobject][ordered]@{
        InstallRoot = $resolvedInstall
        SoftDisableAttempted = $softDisableAttempted
        SoftDisableSucceeded = $softDisableSucceeded
        TaskUnregistered = [bool]$unregisterResult.VerifiedAbsent
        Shortcut = $shortcutResult
        Residue = $residueResult
        State = $stateResult
        InstallTree = $installResult
        Completion = "complete"
    }
}
