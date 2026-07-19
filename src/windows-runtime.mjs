import { execFile as execFileCallback } from "node:child_process";
import { lstat, open } from "node:fs/promises";
import { win32 } from "node:path";
import { promisify } from "node:util";

import { isolatedWindowsPowerShellEnvironment } from "./windows-secure-fs.mjs";

const execFile = promisify(execFileCallback);
const PROCESS_STARTED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,7}Z$/;
const PROCESS_NAMES = new Set(["chatgpt", "codex"]);
const APP_KINDS = new Set(["Win32", "StoreAlias", "StoreAumid"]);
const TEST_FIXTURE_MAX_BYTES = 256 * 1024;
const APP_IDENTITY_ENV = "HEIGE_WINDOWS_APP_IDENTITY";
const APP_IDENTITY_PRODUCT = "heige-codex-skin-studio";
const APP_IDENTITY_MAX_BYTES = 8 * 1024;
const APP_IDENTITY_KEYS = [
  "aumid",
  "executablePath",
  "installPath",
  "kind",
  "packageFullName",
  "product",
  "productName",
  "schemaVersion",
];

const WINDOWS_RUNTIME_SCRIPT = String.raw`& {
param([string]$CommonScriptPath, [string]$PortText, [string]$AppIdentityToken)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$port = 0
if (-not [int]::TryParse($PortText, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
  throw 'invalid runtime snapshot port'
}
. $CommonScriptPath
$app = if ($AppIdentityToken) {
  Resolve-HeiGeBoundCodexApp -IdentityToken $AppIdentityToken
} else {
  Resolve-CodexApp
}
$runtime = Get-NodeRuntime -App $app
$rawProcesses = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='ChatGPT.exe' OR Name='Codex.exe'" -ErrorAction Stop)
$processes = @()
foreach ($record in $rawProcesses) {
  $pidValue = [int]$record.ProcessId
  $parentPid = [int]$record.ParentProcessId
  $path = [string]$record.ExecutablePath
  # Store/MSIX 子进程偶发 ExecutablePath 为空；跳过而不是整次快照失败。
  if ($pidValue -le 0 -or $parentPid -lt 0 -or [string]::IsNullOrWhiteSpace($path)) {
    continue
  }
  # Editor extensions and the desktop app's own headless backend are not UI
  # installations. Exclude them before enforcing the immutable desktop identity.
  if (Test-HeiGeCodexInternalBackendPath -Path $path) {
    continue
  }
  $owner = [pscustomobject]@{ Id = $pidValue; Path = $path; ProcessName = [string]$record.Name }
  if (-not (Test-CdpOwnerMatchesApp -Owner $owner -App $app)) {
    if ($AppIdentityToken) { throw 'foreign Windows Codex process conflicts with the immutable app identity' }
    continue
  }
  $live = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  if ($null -eq $live -or [int]$live.Id -ne $pidValue -or [string]::IsNullOrWhiteSpace([string]$live.Path)) {
    continue
  }
  $processes += [pscustomobject][ordered]@{
    pid = $pidValue
    parentProcessId = $parentPid
    executablePath = [System.IO.Path]::GetFullPath([string]$live.Path)
    startedAt = $live.StartTime.ToUniversalTime().ToString('o')
  }
}
$listeners = @()
$connections = @()
try {
  Import-Module NetTCPIP -ErrorAction SilentlyContinue | Out-Null
  $connections = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { [int]$_.LocalPort -eq $port })
} catch {
  foreach ($line in @(netstat -ano -p tcp 2>$null)) {
    if ($line -notmatch '^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') { continue }
    if ([int]$Matches[2] -ne $port) { continue }
    $connections += [pscustomobject]@{
      OwningProcess = [int]$Matches[3]
      LocalAddress = [string]$Matches[1]
      LocalPort = [int]$port
    }
  }
}
foreach ($connection in $connections) {
  $owner = Get-Process -Id ([int]$connection.OwningProcess) -ErrorAction SilentlyContinue
  if ($null -eq $owner -or [string]::IsNullOrWhiteSpace([string]$owner.Path)) { continue }
  $listeners += [pscustomobject][ordered]@{
    pid = [int]$owner.Id
    executablePath = [System.IO.Path]::GetFullPath([string]$owner.Path)
    startedAt = $owner.StartTime.ToUniversalTime().ToString('o')
    processName = [string]$owner.ProcessName
    localAddress = [string]$connection.LocalAddress
    localPort = [int]$connection.LocalPort
  }
}
$launchTarget = if ([string]$app.Kind -ceq 'StoreAumid') {
  'aumid:' + [string]$app.Aumid
} else {
  [string]$app.ExecutablePath
}
$snapshot = [pscustomobject][ordered]@{
  schemaVersion = 1
  app = [pscustomobject][ordered]@{
    kind = [string]$app.Kind
    executablePath = if ($null -eq $app.ExecutablePath) { $null } else { [string]$app.ExecutablePath }
    installPath = [string]$app.InstallPath
    productName = [string]$app.ProductName
    packageFullName = if ($null -eq $app.PackageFullName) { $null } else { [string]$app.PackageFullName }
    aumid = if ($null -eq $app.Aumid) { $null } else { [string]$app.Aumid }
    launchTarget = $launchTarget
  }
  nodePath = [string]$runtime.Path
  processes = [object[]]$processes
  listeners = [object[]]$listeners
}
[Console]::Out.Write((ConvertTo-Json -InputObject $snapshot -Depth 8 -Compress))
}`;

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} schema contains missing or unknown fields`);
  }
}

function absoluteWindowsPath(value, label) {
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

function nullableString(value, label) {
  if (value !== null && (typeof value !== "string" || value.length === 0 || /[\0\r\n]/.test(value))) {
    throw new Error(`${label} must be null or a non-empty string`);
  }
  return value;
}

function validateApp(value) {
  exactKeys(value, [
    "aumid",
    "executablePath",
    "installPath",
    "kind",
    "launchTarget",
    "packageFullName",
    "productName",
  ], "Windows app snapshot");
  if (!APP_KINDS.has(value.kind)) throw new Error("Windows app kind is invalid");
  absoluteWindowsPath(value.installPath, "Windows app installPath");
  if (!new Set(["Codex", "ChatGPT"]).has(value.productName)) {
    throw new Error("Windows app productName is invalid");
  }
  nullableString(value.packageFullName, "Windows app packageFullName");
  nullableString(value.aumid, "Windows app aumid");
  if (value.kind === "StoreAumid") {
    if (value.executablePath !== null || value.aumid === null || value.packageFullName === null) {
      throw new Error("StoreAumid app attribution is incomplete");
    }
    if (value.launchTarget !== `aumid:${value.aumid}`) {
      throw new Error("StoreAumid launchTarget is invalid");
    }
  } else {
    absoluteWindowsPath(value.executablePath, "Windows app executablePath");
    if (value.launchTarget !== value.executablePath) {
      throw new Error("Windows app launchTarget does not match executablePath");
    }
    if (value.kind === "StoreAlias" && (value.aumid === null || value.packageFullName === null)) {
      throw new Error("StoreAlias app attribution is incomplete");
    }
    if (value.kind === "Win32" && (value.aumid !== null || value.packageFullName !== null)) {
      throw new Error("Win32 app must not claim Store attribution");
    }
  }
  return Object.freeze({ ...value });
}

function appIdentityDocument(app) {
  return {
    schemaVersion: 1,
    product: APP_IDENTITY_PRODUCT,
    kind: app.kind,
    executablePath: app.executablePath,
    installPath: app.installPath,
    productName: app.productName,
    packageFullName: app.packageFullName,
    aumid: app.aumid,
  };
}

export function decodeWindowsAppIdentityToken(token) {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > APP_IDENTITY_MAX_BYTES * 2 ||
    !/^[A-Za-z0-9_-]+$/.test(token)
  ) {
    throw new Error("Windows app identity token is not canonical base64url");
  }
  let bytes;
  let document;
  try {
    bytes = Buffer.from(token, "base64url");
    if (bytes.length === 0 || bytes.length > APP_IDENTITY_MAX_BYTES) {
      throw new Error("identity size is invalid");
    }
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    document = JSON.parse(decoded);
  } catch (cause) {
    throw new Error("Windows app identity token is invalid", { cause });
  }
  exactKeys(document, APP_IDENTITY_KEYS, "Windows app identity");
  if (document.schemaVersion !== 1 || document.product !== APP_IDENTITY_PRODUCT) {
    throw new Error("Windows app identity schema is unsupported");
  }
  const app = validateApp({
    kind: document.kind,
    executablePath: document.executablePath,
    installPath: document.installPath,
    productName: document.productName,
    packageFullName: document.packageFullName,
    aumid: document.aumid,
    launchTarget: document.kind === "StoreAumid"
      ? `aumid:${document.aumid}`
      : document.executablePath,
  });
  const canonical = Buffer.from(JSON.stringify(appIdentityDocument(app)), "utf8").toString("base64url");
  if (canonical !== token) {
    throw new Error("Windows app identity token is not canonical");
  }
  return app;
}

function sameAppIdentity(left, right) {
  return left.kind === right.kind &&
    left.productName === right.productName &&
    left.packageFullName === right.packageFullName &&
    left.aumid === right.aumid &&
    sameWindowsPath(left.installPath, right.installPath) &&
    (
      left.executablePath === null
        ? right.executablePath === null
        : right.executablePath !== null && sameWindowsPath(left.executablePath, right.executablePath)
    );
}

function assertExpectedAppIdentity(snapshot, expectedApp) {
  if (expectedApp !== null && !sameAppIdentity(snapshot.app, expectedApp)) {
    throw new Error("Windows runtime app attribution does not match the immutable identity");
  }
  return snapshot;
}

function processIdentity(value, { parent = true, listener = false } = {}) {
  exactKeys(value, parent
    ? ["executablePath", "parentProcessId", "pid", "startedAt"]
    : ["executablePath", "localAddress", "localPort", "pid", "processName", "startedAt"],
  listener ? "Windows listener snapshot" : "Windows process snapshot");
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new Error("Windows process PID is invalid");
  }
  if (parent && (!Number.isSafeInteger(value.parentProcessId) || value.parentProcessId < 0)) {
    throw new Error("Windows process parent PID is invalid");
  }
  absoluteWindowsPath(value.executablePath, "Windows process executablePath");
  if (typeof value.startedAt !== "string" || !PROCESS_STARTED_AT.test(value.startedAt)) {
    throw new Error("Windows process startedAt is invalid");
  }
  if (listener) {
    if (typeof value.processName !== "string" || !PROCESS_NAMES.has(value.processName.toLowerCase())) {
      throw new Error("Windows listener processName is invalid");
    }
    if (typeof value.localAddress !== "string" || value.localAddress.length === 0) {
      throw new Error("Windows listener localAddress is invalid");
    }
    if (!Number.isInteger(value.localPort) || value.localPort < 1 || value.localPort > 65535) {
      throw new Error("Windows listener localPort is invalid");
    }
  }
  return Object.freeze({ ...value });
}

function sameWindowsPath(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function pathWithin(root, candidate) {
  const relative = win32.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${win32.sep}`) &&
    !win32.isAbsolute(relative)
  );
}

function belongsToApp(path, app) {
  if (app.kind === "Win32") return sameWindowsPath(path, app.executablePath);
  return pathWithin(app.installPath, path);
}

export function validateWindowsRuntimeSnapshot(value) {
  exactKeys(value, ["app", "listeners", "nodePath", "processes", "schemaVersion"], "Windows runtime snapshot");
  if (value.schemaVersion !== 1) throw new Error("Windows runtime snapshot schemaVersion is unsupported");
  const app = validateApp(value.app);
  const nodePath = absoluteWindowsPath(value.nodePath, "Windows runtime nodePath");
  if (!Array.isArray(value.processes) || !Array.isArray(value.listeners)) {
    throw new Error("Windows runtime processes and listeners must be arrays");
  }
  const processes = value.processes.map((entry) => processIdentity(entry));
  const listeners = value.listeners.map((entry) => processIdentity(entry, {
    parent: false,
    listener: true,
  }));
  if (processes.some((entry) => !belongsToApp(entry.executablePath, app))) {
    throw new Error("Windows process path does not belong to the resolved app");
  }
  return Object.freeze({
    schemaVersion: 1,
    app,
    nodePath,
    processes: Object.freeze(processes),
    listeners: Object.freeze(listeners),
  });
}

export async function queryWindowsRuntimeSnapshot({
  port,
  execFileImpl = execFile,
  powershellPath,
  commonScriptPath,
  env = process.env,
  nodeEnv = process.env.NODE_ENV,
}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Windows runtime snapshot port is invalid");
  }
  const identityToken = env[APP_IDENTITY_ENV];
  const expectedApp = identityToken === undefined
    ? null
    : decodeWindowsAppIdentityToken(identityToken);
  const fixturePath = env.HEIGE_TEST_WINDOWS_RUNTIME_FIXTURE;
  if (fixturePath !== undefined) {
    if (nodeEnv !== "test") {
      throw new Error("Windows runtime fixture is forbidden outside NODE_ENV=test");
    }
    const stateRoot = absoluteWindowsPath(
      env.HEIGE_TEST_WINDOWS_STATE_ROOT,
      "Windows test state root",
    );
    absoluteWindowsPath(fixturePath, "Windows runtime fixture path");
    if (!pathWithin(stateRoot, fixturePath) || fixturePath === stateRoot) {
      throw new Error("Windows runtime fixture must be below the isolated test state root");
    }
    const before = await lstat(fixturePath);
    if (before.isSymbolicLink() || !before.isFile() || before.size <= 0 || before.size > TEST_FIXTURE_MAX_BYTES) {
      throw new Error("Windows runtime fixture must be one bounded regular file");
    }
    const handle = await open(fixturePath, "r");
    let raw;
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
        throw new Error("Windows runtime fixture changed while opening");
      }
      raw = await handle.readFile("utf8");
      const after = await handle.stat();
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
        throw new Error("Windows runtime fixture changed while reading");
      }
    } finally {
      await handle.close();
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch (cause) {
      throw new Error("Windows runtime fixture is not one JSON document", { cause });
    }
    return assertExpectedAppIdentity(validateWindowsRuntimeSnapshot(value), expectedApp);
  }
  absoluteWindowsPath(powershellPath, "trusted Windows PowerShell path");
  absoluteWindowsPath(commonScriptPath, "trusted Windows resolver path");
  const { stdout, stderr = "" } = await execFileImpl(powershellPath, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    WINDOWS_RUNTIME_SCRIPT,
    commonScriptPath,
    String(port),
    identityToken ?? "",
  ], {
    env: isolatedWindowsPowerShellEnvironment(env),
    timeout: 15_000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
  if (String(stderr).trim().length !== 0) {
    throw new Error("Windows runtime snapshot wrote unexpected stderr");
  }
  let value;
  try {
    value = JSON.parse(String(stdout));
  } catch (cause) {
    throw new Error("Windows runtime snapshot stdout is not one JSON document", { cause });
  }
  return assertExpectedAppIdentity(validateWindowsRuntimeSnapshot(value), expectedApp);
}

function uniqueProcesses(processes) {
  const byPid = new Map();
  for (const entry of processes) {
    const existing = byPid.get(entry.pid);
    if (existing !== undefined) {
      if (
        existing.parentProcessId !== entry.parentProcessId ||
        !sameWindowsPath(existing.executablePath, entry.executablePath) ||
        existing.startedAt !== entry.startedAt
      ) {
        throw new Error("Windows process PID has conflicting identity records");
      }
      continue;
    }
    byPid.set(entry.pid, entry);
  }
  return byPid;
}

function publicProcess(value) {
  return {
    pid: value.pid,
    executablePath: value.executablePath,
    startedAt: value.startedAt,
  };
}

function uniqueRoot(processes) {
  if (processes.size === 0) return null;
  const roots = [...processes.values()].filter((entry) => !processes.has(entry.parentProcessId));
  if (roots.length !== 1) {
    throw new Error("Windows Codex process graph does not have one unique root");
  }
  const root = roots[0];
  for (const entry of processes.values()) {
    const visited = new Set();
    let current = entry;
    while (processes.has(current.parentProcessId)) {
      if (visited.has(current.pid)) {
        throw new Error("Windows Codex process graph contains an ownership cycle");
      }
      visited.add(current.pid);
      current = processes.get(current.parentProcessId);
    }
    if (current.pid !== root.pid) {
      throw new Error("Windows Codex process graph contains an orphan component");
    }
  }
  return root;
}

export function classifyWindowsPreflightSnapshot(input, { port, requirePort = true } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Windows preflight port is invalid");
  }
  const snapshot = validateWindowsRuntimeSnapshot(input);
  const processes = uniqueProcesses(snapshot.processes);
  const root = uniqueRoot(processes);

  if (!requirePort) {
    if (snapshot.listeners.length !== 0) {
      throw new Error(`Windows CDP port ${port} is occupied while offline preflight was requested`);
    }
    return {
      appPath: snapshot.app.launchTarget,
      nodePath: snapshot.nodePath,
      process: root === null ? null : publicProcess(root),
    };
  }

  if (snapshot.listeners.length === 0) {
    const error = new Error(`Windows CDP port ${port} is not owned by the resolved Codex app`);
    error.code = "CDP_NOT_OWNED";
    throw error;
  }
  if (root === null || snapshot.listeners.length !== 1) {
    throw new Error("Windows CDP owner is not one unique Codex main process");
  }
  const listener = snapshot.listeners[0];
  if (listener.localAddress !== "127.0.0.1" || listener.localPort !== port) {
    throw new Error("Windows CDP owner is not an exact IPv4 loopback listener");
  }
  if (
    listener.pid !== root.pid ||
    !sameWindowsPath(listener.executablePath, root.executablePath) ||
    listener.startedAt !== root.startedAt ||
    !belongsToApp(listener.executablePath, snapshot.app)
  ) {
    throw new Error("Windows CDP listener owner identity does not match the unique Codex root");
  }
  return {
    appPath: snapshot.app.launchTarget,
    nodePath: snapshot.nodePath,
    process: publicProcess(root),
  };
}

export const windowsRuntimePowerShellScript = WINDOWS_RUNTIME_SCRIPT;
