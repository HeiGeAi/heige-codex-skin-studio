import { execFile as execFileCallback } from "node:child_process";
import { win32 } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const MAX_BATCH_OPERATIONS = 16;
const MAX_BATCH_INPUT_BYTES = 32 * 1024;
const MAX_BATCH_OUTPUT_BYTES = 256 * 1024;

const ACL_ACTIONS = Object.freeze([
  "protect-directory",
  "protect-file",
  "migrate-directory",
  "migrate-file",
  "verify-directory",
  "verify-file",
]);

const ACL_SCRIPT = String.raw`& {
param([string]$PayloadBase64)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
if ([string]::IsNullOrWhiteSpace($PayloadBase64)) { throw 'ACL batch payload is missing' }
try {
  $PayloadJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($PayloadBase64))
} catch {
  throw 'ACL batch payload is not valid base64'
}
$payload = $PayloadJson | ConvertFrom-Json -ErrorAction Stop
if ($null -eq $payload -or $null -eq $payload.operations) { throw 'ACL batch payload is invalid' }
$operations = @($payload.operations)
if ($operations.Count -lt 1 -or $operations.Count -gt 16) { throw 'ACL batch size is out of bounds' }
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$results = New-Object System.Collections.Generic.List[object]
foreach ($entry in $operations) {
  $Action = [string]$entry.action
  $TargetPath = [string]$entry.path
  $isDirectory = $Action.EndsWith('-directory', [System.StringComparison]::Ordinal)
  $protect = $Action.StartsWith('protect-', [System.StringComparison]::Ordinal) -or $Action.StartsWith('migrate-', [System.StringComparison]::Ordinal)
  $migrate = $Action.StartsWith('migrate-', [System.StringComparison]::Ordinal)
  $item = Get-Item -LiteralPath $TargetPath -Force -ErrorAction Stop
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'private path is a reparse point'
  }
  if ($isDirectory -ne [bool]$item.PSIsContainer) {
    throw 'private path type mismatch'
  }
  if ($migrate) {
    $beforeAcl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $TargetPath -ErrorAction Stop
    try {
      $beforeOwnerSid = ([System.Security.Principal.NTAccount]$beforeAcl.Owner).Translate([System.Security.Principal.SecurityIdentifier])
    } catch {
      $beforeOwnerSid = New-Object System.Security.Principal.SecurityIdentifier -ArgumentList ([string]$beforeAcl.Owner)
    }
    if ($beforeOwnerSid.Value -cne $currentSid.Value) {
      throw 'legacy private path is not owned by the current user'
    }
    $trustedWriterSids = @(
      $currentSid.Value,
      'S-1-5-18',
      'S-1-5-32-544'
    )
    $writeMask = [int64](
      [System.Security.AccessControl.FileSystemRights]::WriteData -bor
      [System.Security.AccessControl.FileSystemRights]::CreateFiles -bor
      [System.Security.AccessControl.FileSystemRights]::AppendData -bor
      [System.Security.AccessControl.FileSystemRights]::CreateDirectories -bor
      [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
      [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor
      [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
      [System.Security.AccessControl.FileSystemRights]::Delete -bor
      [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
      [System.Security.AccessControl.FileSystemRights]::TakeOwnership -bor
      [System.Security.AccessControl.FileSystemRights]::Modify -bor
      [System.Security.AccessControl.FileSystemRights]::FullControl
    )
    $beforeRules = @($beforeAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    foreach ($beforeRule in $beforeRules) {
      $isUntrustedWriter = $beforeRule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
        $trustedWriterSids -cnotcontains $beforeRule.IdentityReference.Value -and
        (([int64]$beforeRule.FileSystemRights -band $writeMask) -ne 0)
      if ($isUntrustedWriter) {
        throw 'legacy private path grants write access to an untrusted identity'
      }
    }
  }
  if ($protect) {
    $acl = if ($isDirectory) {
      New-Object System.Security.AccessControl.DirectorySecurity
    } else {
      New-Object System.Security.AccessControl.FileSecurity
    }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($currentSid)
    $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    if ($isDirectory) {
      $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule -ArgumentList @(
        $currentSid, $rights, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, $allow
      )
    } else {
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule -ArgumentList @($currentSid, $rights, $allow)
    }
    $acl.AddAccessRule($rule) | Out-Null
    try {
      Microsoft.PowerShell.Security\Set-Acl -LiteralPath $TargetPath -AclObject $acl -ErrorAction Stop
    } catch {
      # 部分账户/会话没有 SeSecurityPrivilege；与 Windows 安装脚本一致，回退 icacls。
      # fallback 与安装脚本保持一致：移除继承并重置为当前 SID，
      # 随后的 exact verify 仍会验证 owner，不能靠 icacls 输出宣称成功。
      $detail = [string]$_.Exception.Message
      $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
      if (-not (Test-Path -LiteralPath $icacls -PathType Leaf)) {
        throw "Set-Acl failed and icacls is unavailable: $detail"
      }
      $sidText = [string]$currentSid.Value
      $grant = if ($isDirectory) { '*{0}:(OI)(CI)F' -f $sidText } else { '*{0}:F' -f $sidText }
      $output = & $icacls $TargetPath /inheritance:r /grant:r $grant 2>&1
      if ($LASTEXITCODE -ne 0) {
        throw ("Set-Acl failed and icacls fallback failed: {0}; icacls: {1}" -f $detail, (($output | ForEach-Object { [string]$_ }) -join ' '))
      }
    }
  }
  $observed = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $TargetPath -ErrorAction Stop
  try {
    $ownerSid = ([System.Security.Principal.NTAccount]$observed.Owner).Translate([System.Security.Principal.SecurityIdentifier])
  } catch {
    $ownerSid = New-Object System.Security.Principal.SecurityIdentifier -ArgumentList ([string]$observed.Owner)
  }
  $rules = @($observed.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))
  $private = $observed.AreAccessRulesProtected -and $ownerSid.Value -ceq $currentSid.Value -and $rules.Count -eq 1
  if ($private) {
    $rule = $rules[0]
    $private = $rule.IdentityReference.Value -ceq $currentSid.Value -and
      $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
      (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)
    if ($isDirectory) {
      $requiredInheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
      $private = $private -and $rule.InheritanceFlags -eq $requiredInheritance -and $rule.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None
    } else {
      $private = $private -and $rule.InheritanceFlags -eq [System.Security.AccessControl.InheritanceFlags]::None
    }
  }
  if (-not $private) { throw 'private path ACL is not exact current-user only' }
  $results.Add([pscustomobject][ordered]@{
    schemaVersion = 1
    action = $Action
    path = $TargetPath
    ownerSid = $ownerSid.Value
    private = $true
  }) | Out-Null
}
$result = [pscustomobject][ordered]@{
  schemaVersion = 1
  results = $results
}
[Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress -Depth 6))
}`;

function canonicalWindowsPath(value, label) {
  if (
    typeof value !== "string" ||
    !win32.isAbsolute(value) ||
    win32.normalize(value) !== value ||
    value.includes("\0") ||
    /[\r\n]/.test(value)
  ) {
    throw new Error(`${label} must be a canonical absolute Windows path`);
  }
  return value;
}

export function trustedWindowsPowerShellPath(env = process.env) {
  const systemRoot = env.SystemRoot;
  canonicalWindowsPath(systemRoot, "Windows SystemRoot");
  return win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function isolatedWindowsPowerShellEnvironment(env = process.env) {
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    throw new TypeError("Windows PowerShell environment must be an object");
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toLowerCase() !== "psmodulepath"),
  ));
}

function exactAclResult(value, { action, path }) {
  const expectedKeys = ["action", "ownerSid", "path", "private", "schemaVersion"];
  const mismatches = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    mismatches.push("document");
  } else {
    if (Object.keys(value).sort().join("\0") !== expectedKeys.sort().join("\0")) mismatches.push("keys");
    if (value.schemaVersion !== 1) mismatches.push("schemaVersion");
    if (value.action !== action) mismatches.push("action");
    if (value.private !== true) mismatches.push("private");
    if (typeof value.ownerSid !== "string" || !/^S-1-(?:\d+-)+\d+$/.test(value.ownerSid)) {
      mismatches.push("ownerSid");
    }
    if (typeof value.path !== "string" || value.path.toLowerCase() !== path.toLowerCase()) {
      mismatches.push("path");
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Windows private ACL verifier returned an invalid result: ${mismatches.join(",")}`);
  }
  return value;
}

function normalizeBatchOperations(operations) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error("Windows ACL batch requires one or more operations");
  }
  if (operations.length > MAX_BATCH_OPERATIONS) {
    throw new Error(`Windows ACL batch supports at most ${MAX_BATCH_OPERATIONS} operations`);
  }
  return operations.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Windows ACL batch operation ${index} is invalid`);
    }
    const keys = Object.keys(entry).sort();
    if (keys.length !== 2 || keys[0] !== "action" || keys[1] !== "path") {
      throw new Error(`Windows ACL batch operation ${index} has invalid keys`);
    }
    if (!ACL_ACTIONS.includes(entry.action)) {
      throw new Error(`Windows ACL batch operation ${index} has unsupported action`);
    }
    return {
      action: entry.action,
      path: canonicalWindowsPath(entry.path, `Windows ACL batch path[${index}]`),
    };
  });
}

export function createWindowsSecurityAdapter({
  execFileImpl = execFile,
  env = process.env,
  powershellPath = trustedWindowsPowerShellPath(env),
} = {}) {
  canonicalWindowsPath(powershellPath, "trusted Windows PowerShell path");
  const childEnv = isolatedWindowsPowerShellEnvironment(env);
  const batch = async (operations) => {
    const normalized = normalizeBatchOperations(operations);
    const payload = JSON.stringify({ schemaVersion: 1, operations: normalized });
    if (Buffer.byteLength(payload, "utf8") > MAX_BATCH_INPUT_BYTES) {
      throw new Error("Windows ACL batch payload exceeds the input bound");
    }
    // Base64 避免 PowerShell -Command 把 JSON 花括号/引号解析进脚本本体。
    const payloadBase64 = Buffer.from(payload, "utf8").toString("base64");
    const { stdout, stderr = "" } = await execFileImpl(powershellPath, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      ACL_SCRIPT,
      payloadBase64,
    ], {
      env: childEnv,
      timeout: 15_000,
      maxBuffer: MAX_BATCH_OUTPUT_BYTES,
      windowsHide: true,
    });
    if (String(stderr).trim().length !== 0) {
      throw new Error("Windows private ACL verifier wrote unexpected stderr");
    }
    let value;
    try {
      value = JSON.parse(String(stdout));
    } catch (cause) {
      throw new Error("Windows private ACL verifier stdout is not one JSON document", { cause });
    }
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.schemaVersion !== 1 ||
      !Array.isArray(value.results) ||
      value.results.length !== normalized.length
    ) {
      throw new Error("Windows private ACL verifier returned an invalid batch result");
    }
    return value.results.map((entry, index) => exactAclResult(entry, normalized[index]));
  };
  const run = async (action, path) => {
    const [result] = await batch([{ action, path }]);
    return result;
  };
  return Object.freeze({
    batch,
    protectDirectory: (path) => run("protect-directory", path),
    protectFile: (path) => run("protect-file", path),
    migrateDirectory: (path) => run("migrate-directory", path),
    migrateFile: (path) => run("migrate-file", path),
    verifyDirectory: (path) => run("verify-directory", path),
    verifyFile: (path) => run("verify-file", path),
  });
}

let defaultAdapter;

export function windowsSecurityAdapter() {
  defaultAdapter ??= createWindowsSecurityAdapter();
  return defaultAdapter;
}

export const windowsAclPowerShellScript = ACL_SCRIPT;
export const WINDOWS_ACL_ACTIONS = ACL_ACTIONS;
export const WINDOWS_ACL_MAX_BATCH_OPERATIONS = MAX_BATCH_OPERATIONS;
