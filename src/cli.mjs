#!/usr/bin/env node
import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, posix, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  claimBackgroundStartRequest,
  consumeBackgroundHandshake,
  publishBackgroundHandshake,
  publishBackgroundStartRequest,
  removeBackgroundHandshake,
  removeBackgroundStartRequest,
  removeLegacyBackgroundStartRequest,
  waitForBackgroundHandshake,
} from "./background-handshake.mjs";
import {
  classifyInjection,
  discoverCodex,
  listCodexProcesses,
  resolveCodexApp,
  runtimeDiagnostics,
  sameProcessIdentity,
} from "./codex-app.mjs";
import {
  DEFAULT_CDP_PORT,
  DEFAULT_THEME_ID,
  NATIVE_THEME_ID,
  resolveStudioPaths,
} from "./constants.mjs";
import { createSkinController } from "./controller.mjs";
import {
  applySkin,
  deliverThemeSelectionResult,
  deliverUpdateCheckResult,
  removeSkin,
  skinStatus,
} from "./injector.mjs";
import {
  spawnDetachedLifecycle,
  writeLifecycleActionFile,
} from "./lifecycle-helper.mjs";
import {
  CONTROLLER_LAUNCH_AGENT_LABEL,
  finalizeLegacyWatchdogMigration,
  inspectLaunchAgent,
  inspectLaunchAgentProcessIdentity,
  migrateLegacyWatchdog,
  recoverLegacyWatchdogMigration,
  registerControllerAgent,
  rollbackLegacyWatchdogMigration,
  unregisterControllerAgent,
  wakeControllerAgent,
} from "./macos-launch-agent.mjs";
import {
  macosInstallJournalPath,
  readMacosInstallJournal,
} from "./macos-install-journal.mjs";
import {
  clearLegacyMigrationCoordinator,
  createLegacyMigrationCoordinator,
  legacyMigrationJournalPath,
  readLegacyMigrationCoordinator,
  updateLegacyMigrationCoordinator,
} from "./legacy-migration-coordinator.mjs";
import { acquireOperationLock, withOperationLock } from "./operation-lock.mjs";
import { installPet } from "./pet-installer.mjs";
import {
  createCachedUpdateChecker,
  readCurrentPackageVersion,
} from "./update-check.mjs";
import {
  compareAndUpdateStudioState,
  createDefaultStudioState,
  migrateLegacyState,
  readTransitionJournal,
  readStudioState,
  recoverStateTransition,
  rollbackLegacyStateMigration,
  writeSessionState,
  writeStudioState,
} from "./state-store.mjs";
import { createStudioLogger } from "./studio-logger.mjs";
import { loadTheme } from "./theme-schema.mjs";
import { createSingleImageTheme, listThemes, resolveAndLoadTheme } from "./theme-store.mjs";
import {
  classifyWindowsPreflightSnapshot,
  queryWindowsRuntimeSnapshot,
  validateWindowsRuntimeSnapshot,
} from "./windows-runtime.mjs";
import {
  isolatedWindowsPowerShellEnvironment,
  trustedWindowsPowerShellPath,
} from "./windows-secure-fs.mjs";

const execFile = promisify(execFileCallback);
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const BOOLEAN_FLAGS = new Set(["background", "ephemeral", "once", "prefer-stored", "restart"]);
const COMMAND_OPTIONS = new Map([
  ["help", new Set()],
  ["list", new Set()],
  ["create", new Set(["image", "name"])],
  ["customize", new Set(["image", "name", "port"])],
  ["apply", new Set(["port", "prefer-stored", "restart", "theme"])],
  ["enable-skin", new Set(["port", "theme"])],
  ["set-persistence", new Set(["port", "revision"])],
  ["pause", new Set(["port"])],
  ["resume", new Set(["port"])],
  ["restore", new Set(["port"])],
  ["controller", new Set([
    "background",
    "ephemeral",
    "once",
    "platform",
    "port",
    "state-directory",
    "task-name",
  ])],
  ["status", new Set(["port"])],
  ["doctor", new Set(["port"])],
  ["install-pet", new Set(["source"])],
]);
const WINDOWS_PRODUCTION_TASK = "HeiGe Codex Skin Studio Controller";
const WINDOWS_TEST_TASK = /^HeiGe Codex Skin Studio Test [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseInvocation(argv) {
  const command = argv[0] ?? "help";
  const args = {};
  const positionals = [];
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      positionals.push(key);
      continue;
    }
    const name = key.slice(2);
    if (Object.hasOwn(args, name)) throw new Error(`重复参数：--${name}`);
    if (BOOLEAN_FLAGS.has(name)) {
      args[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} 缺少值`);
    args[name] = value;
    index += 1;
  }
  const allowed = COMMAND_OPTIONS.get(command);
  if (allowed !== undefined) {
    for (const name of Object.keys(args)) {
      if (!allowed.has(name)) throw new Error(`无法识别的参数：--${name}`);
    }
    if (command === "set-persistence") {
      if (positionals.length !== 1) throw new Error("set-persistence 需要且只能提供 true 或 false");
    } else if (positionals.length !== 0) {
      throw new Error(`无法识别的参数：${positionals[0]}`);
    }
  }
  return { args, command, positionals };
}

function assertNodeVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value));
  if (!match || Number(match[1]) < 22) {
    throw new Error(`运行命令需要 Node.js 22 或更高版本，实际为 ${String(value)}`);
  }
}

function controllerPlatform(value) {
  const selected = value ?? process.platform;
  if (selected === "windows") return "win32";
  if (selected === "win32" || selected === "darwin") return selected;
  throw new Error("controller --platform 只支持 darwin 或 windows");
}

function controllerBackgroundIdentity(platform, taskName) {
  if (platform === "darwin") {
    if (taskName !== undefined && taskName !== CONTROLLER_LAUNCH_AGENT_LABEL) {
      throw new Error("macOS controller 不接受 Windows TaskName");
    }
    return CONTROLLER_LAUNCH_AGENT_LABEL;
  }
  if (taskName === undefined) return WINDOWS_PRODUCTION_TASK;
  if (
    taskName !== WINDOWS_PRODUCTION_TASK &&
    (typeof taskName !== "string" || !WINDOWS_TEST_TASK.test(taskName))
  ) {
    throw new Error("Windows controller TaskName 不在允许范围内");
  }
  return taskName;
}

function pathsAtStateRoot(base, stateRoot) {
  return {
    ...base,
    stateRoot,
    statePath: join(stateRoot, "state.json"),
    sessionPath: join(stateRoot, "session.json"),
    transitionPath: join(stateRoot, "transition.json"),
    lockPath: join(stateRoot, "operation.lock"),
    logPath: join(stateRoot, "injector.log"),
    userThemesRoot: join(stateRoot, "themes"),
  };
}

function controllerPaths({ platform, stateDirectory, taskName }) {
  const base = resolveStudioPaths({ platform });
  if (stateDirectory === undefined) {
    if (platform === "win32" && typeof taskName === "string" && WINDOWS_TEST_TASK.test(taskName)) {
      throw new Error("Windows 隔离测试任务必须提供 --state-directory");
    }
    return base;
  }
  if (platform !== "win32") throw new Error("--state-directory 仅支持 Windows controller");
  if (
    typeof stateDirectory !== "string" ||
    !isAbsolute(stateDirectory) ||
    normalize(stateDirectory) !== stateDirectory ||
    stateDirectory.includes("\0")
  ) {
    throw new Error("--state-directory 必须是规范绝对路径");
  }
  const selected = resolve(stateDirectory);
  const production = resolve(base.stateRoot);
  if (taskName === WINDOWS_PRODUCTION_TASK && selected.toLowerCase() !== production.toLowerCase()) {
    throw new Error("Windows 生产任务只能使用默认 APPDATA 状态目录");
  }
  if (typeof taskName === "string" && WINDOWS_TEST_TASK.test(taskName) &&
      selected.toLowerCase() === production.toLowerCase()) {
    throw new Error("Windows 隔离测试任务不得使用生产状态目录");
  }
  return pathsAtStateRoot(base, selected);
}

function windowsCliTestContext(platform, env = process.env) {
  const keys = [
    "HEIGE_TEST_WINDOWS_RUNTIME_FIXTURE",
    "HEIGE_TEST_WINDOWS_STATE_ROOT",
    "HEIGE_TEST_WINDOWS_TASK_NAME",
  ];
  const present = keys.filter((key) => env[key] !== undefined);
  if (present.length === 0) return null;
  if (platform !== "win32" || env.NODE_ENV !== "test" || present.length !== keys.length) {
    throw new Error("Windows CLI test context requires win32, NODE_ENV=test, and all HEIGE_TEST fields");
  }
  const taskName = env.HEIGE_TEST_WINDOWS_TASK_NAME;
  if (!WINDOWS_TEST_TASK.test(taskName)) {
    throw new Error("Windows CLI test task name must contain an exact isolated GUID");
  }
  const paths = controllerPaths({
    platform,
    stateDirectory: env.HEIGE_TEST_WINDOWS_STATE_ROOT,
    taskName,
  });
  return Object.freeze({ paths, taskName });
}

function portFrom(value) {
  const port = value === undefined ? DEFAULT_CDP_PORT : Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("--port 必须是 1024 到 65535 的整数");
  }
  return port;
}

function revisionFrom(value, current) {
  if (value === undefined) return current;
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("--revision 必须是非负安全整数");
  }
  return revision;
}

function exactBoolean(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("set-persistence 只接受精确的 true 或 false");
}

function publicProcess(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.executablePath !== "string" ||
    value.executablePath.length === 0 ||
    typeof value.startedAt !== "string" ||
    value.startedAt.length === 0
  ) {
    throw new Error("Codex 进程身份无效");
  }
  return {
    pid: value.pid,
    executablePath: value.executablePath,
    startedAt: value.startedAt,
  };
}

export async function readProcessIdentity(pid, platform = process.platform) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("进程 PID 无效");
  if (platform === "win32") {
    const powershell = trustedWindowsPowerShellPath();
    try {
      const { stdout, stderr = "" } = await execFile(powershell, [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
          `if ($null -eq $p) { [Console]::Out.Write('null') } else { ` +
          `$result = [pscustomobject][ordered]@{ ` +
          `pid = [int]$p.Id; startedAt = $p.StartTime.ToUniversalTime().ToString('o') }; ` +
          `[Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress)) }`,
      ], {
        env: isolatedWindowsPowerShellEnvironment(),
        timeout: 15_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
      });
      if (String(stderr).trim().length !== 0) {
        throw new Error("Windows process identity query wrote unexpected stderr");
      }
      let value;
      try {
        value = JSON.parse(String(stdout));
      } catch (cause) {
        throw new Error("Windows process identity query stdout is not one JSON document", { cause });
      }
      if (value === null) return null;
      if (
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join("\0") !== ["pid", "startedAt"].sort().join("\0") ||
        value.pid !== pid ||
        typeof value.startedAt !== "string" ||
        !WINDOWS_PROCESS_STARTED_AT.test(value.startedAt)
      ) {
        throw new Error("Windows process identity query returned an invalid identity");
      }
      return { pid, startedAt: value.startedAt };
    } catch (error) {
      throw error;
    }
  }
  let stdout;
  try {
    ({ stdout } = await execFile("/bin/ps", ["-p", String(pid), "-o", "pid=,lstart="]));
  } catch (error) {
    if (error?.code === 1) return null;
    throw error;
  }
  const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(stdout);
  if (!match || Number(match[1]) !== pid || match[2].length === 0) return null;
  return { pid, startedAt: match[2] };
}

async function currentLockIdentity(platform = process.platform) {
  const identity = await readProcessIdentity(process.pid, platform);
  if (identity === null) throw new Error("无法读取当前 CLI 进程身份");
  return identity;
}

async function lockOptions(paths, platform = process.platform) {
  return {
    lockPath: paths.lockPath,
    stateRoot: paths.stateRoot,
    identity: await currentLockIdentity(platform),
    readProcessIdentity: (pid) => readProcessIdentity(pid, platform),
  };
}

export async function productionLockOptions(paths, platform = process.platform) {
  return {
    ...await lockOptions(paths, platform),
    compactionThreshold: 8,
  };
}

export async function acquireEphemeralControllerLease(paths, platform = process.platform) {
  const stateRoot = join(paths.stateRoot, "ephemeral-controller");
  const options = await lockOptions({
    stateRoot,
    lockPath: join(stateRoot, "operation.lock"),
  }, platform);
  try {
    return await acquireOperationLock({
      ...options,
      operation: "controller:ephemeral-singleton",
      platform,
    });
  } catch (error) {
    if (error?.code === "LOCK_HELD") return null;
    throw error;
  }
}

const WINDOWS_PROCESS_STARTED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,7}Z$/;
const WINDOWS_CODEX_PROCESS_NAMES = new Set(["chatgpt", "codex"]);

export async function probeWindowsCdpProcess(port, {
  execFileImpl = execFile,
  env = process.env,
  powershellPath = windowsPowerShellPath(env),
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Windows CDP port is invalid");
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$connections = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop)`,
    "$records = @($connections | ForEach-Object {",
    "  $owner = Get-Process -Id $_.OwningProcess -ErrorAction Stop",
    "  [pscustomobject][ordered]@{",
    "    pid = [int]$owner.Id",
    "    executablePath = [string]$owner.Path",
    "    startedAt = $owner.StartTime.ToUniversalTime().ToString('o')",
    "    processName = [string]$owner.ProcessName",
    "    localAddress = [string]$_.LocalAddress",
    "    localPort = [int]$_.LocalPort",
    "  }",
    "})",
    "[Console]::Out.Write((ConvertTo-Json -InputObject @($records) -Compress))",
  ].join("\n");
  const { stdout } = await execFileImpl(powershellPath, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], {
    env: isolatedWindowsPowerShellEnvironment(env),
  });
  let records;
  try {
    records = JSON.parse(String(stdout).trim());
  } catch (cause) {
    throw new Error("Windows CDP owner query returned invalid JSON", { cause });
  }
  if (!Array.isArray(records)) {
    throw new Error("Windows CDP owner query did not return an array");
  }
  if (records.length === 0) return null;
  if (records.length !== 1) {
    throw new Error("Windows CDP loopback owner is not unique");
  }
  const record = records[0];
  const exactKeys = [
    "executablePath",
    "localAddress",
    "localPort",
    "pid",
    "processName",
    "startedAt",
  ];
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(record).sort().join("\0") !== exactKeys.sort().join("\0")
  ) {
    throw new Error("Windows CDP owner record schema is invalid");
  }
  if (record.localAddress !== "127.0.0.1" || record.localPort !== port) {
    throw new Error("Windows CDP owner is not an exact IPv4 loopback listener");
  }
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) {
    throw new Error("Windows CDP owner PID is invalid");
  }
  if (
    typeof record.processName !== "string" ||
    !WINDOWS_CODEX_PROCESS_NAMES.has(record.processName.toLowerCase())
  ) {
    throw new Error("Windows CDP owner is not a Codex process");
  }
  if (
    typeof record.executablePath !== "string" ||
    !win32.isAbsolute(record.executablePath) ||
    record.executablePath.includes("\0") ||
    /[\r\n]/.test(record.executablePath)
  ) {
    throw new Error("Windows CDP owner executable path is invalid");
  }
  if (typeof record.startedAt !== "string" || !WINDOWS_PROCESS_STARTED_AT.test(record.startedAt)) {
    throw new Error("Windows CDP owner process start time is invalid");
  }
  return {
    pid: record.pid,
    executablePath: record.executablePath,
    startedAt: record.startedAt,
  };
}

export async function validatePortOwner(port, processIdentity, {
  platform = process.platform,
  execFileImpl = execFile,
  env = process.env,
  powershellPath,
} = {}) {
  if (platform === "win32") {
    try {
      const observed = await probeWindowsCdpProcess(port, {
        execFileImpl,
        env,
        ...(powershellPath === undefined ? {} : { powershellPath }),
      });
      return sameProcessIdentity(observed, processIdentity);
    } catch {
      return false;
    }
  }
  let stdout;
  try {
    ({ stdout } = await execFileImpl("/usr/sbin/lsof", [
      "-nP",
      "-a",
      "-p",
      String(processIdentity.pid),
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-t",
    ]));
  } catch {
    return false;
  }
  const pids = stdout.split(/\s+/).filter(Boolean);
  return pids.length === 1 && Number(pids[0]) === processIdentity.pid;
}

async function assertMacPortIsFree(port) {
  try {
    const { stdout } = await execFile("/usr/sbin/lsof", [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-t",
    ]);
    if (stdout.split(/\s+/).some(Boolean)) {
      const error = new Error(`CDP 端口 ${port} 已被其他进程占用`);
      error.code = "CDP_PORT_OCCUPIED";
      throw error;
    }
  } catch (error) {
    if (error?.code === 1) return true;
    throw error;
  }
  return true;
}

export async function productionPreflight({
  port,
  requirePort = true,
  platform = process.platform,
  dependencies = {},
} = {}) {
  if (platform === "win32") {
    const queryWindowsRuntime = dependencies.queryWindowsRuntime ?? ((input) =>
      queryWindowsRuntimeSnapshot({
        ...input,
        powershellPath: windowsPowerShellPath(),
        commonScriptPath: join(repositoryRoot, "scripts", "windows", "lib", "common.ps1"),
      }));
    const snapshot = await queryWindowsRuntime({ port });
    return classifyWindowsPreflightSnapshot(snapshot, { port, requirePort });
  }
  if (platform !== "darwin") throw new Error(`不支持的平台：${platform}`);
  const resolveMacApp = dependencies.resolveMacApp ?? resolveCodexApp;
  const listMacProcesses = dependencies.listMacProcesses ?? listCodexProcesses;
  const validateMacPortOwner = dependencies.validateMacPortOwner ?? validatePortOwner;
  const assertMacPortFree = dependencies.assertMacPortFree ?? assertMacPortIsFree;
  const app = await resolveMacApp({ platform });
  const processes = await listMacProcesses({ app });
  const candidates = requirePort
    ? processes.filter((entry) => entry.cdpPort === port)
    : processes;
  if ((requirePort && candidates.length !== 1) || (!requirePort && candidates.length > 1)) {
    const error = new Error(requirePort
      ? `端口不属于目标 Codex：${port}`
      : "无法唯一识别当前 Codex 进程");
    error.code = requirePort ? "CDP_NOT_OWNED" : "CODEX_PROCESS_AMBIGUOUS";
    throw error;
  }
  const processIdentity = candidates.length === 0 ? null : publicProcess(candidates[0]);
  if (requirePort && !(await validateMacPortOwner(port, processIdentity, { platform }))) {
    const error = new Error(`端口不属于目标 Codex：${port}`);
    error.code = "CDP_NOT_OWNED";
    throw error;
  }
  if (!requirePort) await assertMacPortFree(port);
  return {
    appPath: app.appPath,
    nodePath: process.execPath,
    process: processIdentity,
  };
}

export function createWindowsRuntimeProbe({ port, queryWindowsRuntime }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Windows controller port is invalid");
  }
  if (typeof queryWindowsRuntime !== "function") {
    throw new Error("Windows controller runtime query is required");
  }
  // 同一次 probe 结果可在紧随其后的 validatePortOwner 中单次复用，
  // 避免主题保存临界路径连续冷启动两次 PowerShell runtime snapshot。
  let reusable = null;
  const probe = async () => {
    const snapshot = await queryWindowsRuntime({ port });
    if (Array.isArray(snapshot?.listeners) && snapshot.listeners.length === 0) {
      classifyWindowsPreflightSnapshot(snapshot, {
        port,
        requirePort: false,
      });
      reusable = { process: null, portProven: false };
      return null;
    }
    const processIdentity = classifyWindowsPreflightSnapshot(snapshot, {
      port,
      requirePort: true,
    }).process;
    reusable = { process: processIdentity, portProven: true };
    return processIdentity;
  };
  probe.consumePortProof = (candidate) => {
    const current = reusable;
    reusable = null;
    if (current === null || current.portProven !== true) return false;
    return sameProcessIdentity(current.process, candidate);
  };
  // Healthy ticks probe again after renderer inspection and leave an unused
  // proof. Discard it so a later validatePortOwner cannot accept a stale claim.
  probe.discardPortProof = () => {
    reusable = null;
  };
  return probe;
}

export function createControllerPortOwnerValidator({
  platform,
  port,
  probe,
  windowsProbe = null,
  validatePortOwnerImpl = validatePortOwner,
}) {
  if (platform !== "win32" && platform !== "darwin") {
    throw new Error(`不支持的平台：${platform}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("controller port is invalid");
  }
  if (typeof probe !== "function") {
    throw new Error("controller process probe is required");
  }
  if (typeof validatePortOwnerImpl !== "function") {
    throw new Error("controller port owner validator is required");
  }

  return async (candidate, { reuseCurrentProcessSnapshot = false } = {}) => {
    if (platform === "win32") {
      if (
        typeof windowsProbe?.consumePortProof === "function" &&
        windowsProbe.consumePortProof(candidate) === true
      ) {
        return true;
      }
      const current = await probe();
      return sameProcessIdentity(current, candidate);
    }

    // A healthy tick supplies the process identity captured immediately before
    // this check and performs another exact probe after renderer inspection.
    // Reuse only in that bounded path; every mutation path still re-probes here.
    if (reuseCurrentProcessSnapshot !== true) {
      const current = await probe();
      if (!sameProcessIdentity(current, candidate)) return false;
    }
    // The process snapshot proves identity, not socket ownership. Keep lsof.
    return validatePortOwnerImpl(port, candidate, { platform });
  };
}

function migrationFenceError(operation) {
  const error = new Error(
    `legacy migration is in progress; ${operation} must wait for recovery or completion`,
  );
  error.code = "LEGACY_MIGRATION_IN_PROGRESS";
  return error;
}

function macosInstallFenceError(operation) {
  const error = new Error(
    `macOS install is in progress; ${operation} must wait for recovery or completion`,
  );
  error.code = "MACOS_INSTALL_IN_PROGRESS";
  return error;
}

function isCanonicalAuthorizationPath(pathValue) {
  if (typeof pathValue !== "string" || pathValue.includes("\0")) return false;
  // 生产仅在 macOS；单测也可能在 Windows 上用本机绝对路径构造 journalPath。
  if (posix.isAbsolute(pathValue) && posix.normalize(pathValue) === pathValue) return true;
  return process.platform === "win32" &&
    win32.isAbsolute(pathValue) &&
    win32.normalize(pathValue) === pathValue;
}

export function parseMacosInstallAuthorization(value) {
  if (value === undefined) return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new Error("HEIGE_MACOS_INSTALL_AUTHORIZATION is not valid JSON", { cause });
  }
  const keys = [
    "expectedControlToken",
    "expectedRevision",
    "journalPath",
    "role",
    "transactionId",
  ];
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join("\0") !== keys.sort().join("\0") ||
    parsed.role !== "macos-install-ready-foreground" ||
    typeof parsed.transactionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.transactionId) ||
    !isCanonicalAuthorizationPath(parsed.journalPath) ||
    !Number.isSafeInteger(parsed.expectedRevision) ||
    parsed.expectedRevision < 0 ||
    typeof parsed.expectedControlToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(parsed.expectedControlToken) ||
    Buffer.from(parsed.expectedControlToken, "base64url").length !== 32 ||
    Buffer.from(parsed.expectedControlToken, "base64url").toString("base64url") !==
      parsed.expectedControlToken
  ) {
    throw new Error("HEIGE_MACOS_INSTALL_AUTHORIZATION schema is invalid");
  }
  return Object.freeze({ ...parsed });
}

export async function enforceMacosInstallFence({
  journalPath,
  statePath,
  transitionPath,
  lease,
  operation,
  authorization = null,
  startupHandshake = null,
  backgroundIdentity = null,
  requestContext = {},
  dependencies = {},
}) {
  const readJournal = dependencies.readJournal ?? readMacosInstallJournal;
  const readState = dependencies.readState ?? readStudioState;
  const readTransition = dependencies.readTransition ?? readTransitionJournal;
  const journal = await readJournal(journalPath, { lease });
  const startupOuterTransaction = startupHandshake?.outerTransaction;
  if (journal === null) {
    if (authorization !== null || startupOuterTransaction != null) {
      throw macosInstallFenceError(operation);
    }
    return { allowed: true, transactionId: null };
  }
  const expectedState = journal.stateParticipant?.afterState;
  if (
    journal.decision !== "undecided" ||
    journal.phase !== "activation-planned" ||
    journal.activation !== "controller" ||
    expectedState?.persistenceEnabled !== true ||
    !sameStudioState(await readState(statePath), expectedState) ||
    await readTransition(transitionPath) !== null
  ) {
    throw macosInstallFenceError(operation);
  }
  const authorizationMatches =
    authorization !== null &&
    typeof authorization === "object" &&
    !Array.isArray(authorization) &&
    authorization.role === "macos-install-ready-foreground" &&
    authorization.transactionId === journal.transactionId &&
    authorization.journalPath === journalPath &&
    authorization.expectedRevision === expectedState.revision &&
    authorization.expectedControlToken === expectedState.controlToken;
  const foregroundOperationAllowed =
    operation === "controller:start" ||
    (
      ["controller:set-persistence", "controller:finalize-enable"].includes(operation) &&
      requestContext?.desiredPersistenceEnabled === true &&
      requestContext?.expectedRevision === expectedState.revision
    );
  if (authorizationMatches && foregroundOperationAllowed) {
    return { allowed: true, transactionId: journal.transactionId, role: authorization.role };
  }
  const requestCreatedAt = Date.parse(startupHandshake?.createdAt);
  const backgroundOuterMatches =
    startupOuterTransaction !== null &&
    typeof startupOuterTransaction === "object" &&
    !Array.isArray(startupOuterTransaction) &&
    Object.keys(startupOuterTransaction).sort().join("\0") ===
      ["journalPath", "transactionId"].join("\0") &&
    startupOuterTransaction.transactionId === journal.transactionId &&
    startupOuterTransaction.journalPath === journalPath;
  const backgroundAllowed =
    operation === "controller:start" &&
    startupHandshake !== null &&
    typeof startupHandshake === "object" &&
    startupHandshake.revision === expectedState.revision &&
    startupHandshake.platform === "darwin" &&
    startupHandshake.backgroundIdentity === CONTROLLER_LAUNCH_AGENT_LABEL &&
    backgroundIdentity === CONTROLLER_LAUNCH_AGENT_LABEL &&
    backgroundOuterMatches &&
    Number.isFinite(requestCreatedAt) &&
    requestCreatedAt >= Date.parse(journal.createdAt);
  if (backgroundAllowed) {
    return {
      allowed: true,
      transactionId: journal.transactionId,
      role: "macos-install-ready-background",
    };
  }
  throw macosInstallFenceError(operation);
}

export async function enforceLegacyMigrationFence({
  journalPath,
  statePath,
  transitionPath,
  lease,
  operation,
  authorization = null,
  startupHandshake = null,
  dependencies = {},
}) {
  const readCoordinator = dependencies.readCoordinator ?? readLegacyMigrationCoordinator;
  const readState = dependencies.readState ?? readStudioState;
  const readTransition = dependencies.readTransition ?? readTransitionJournal;
  const coordinator = await readCoordinator(journalPath, { lease });
  if (coordinator === null) {
    if (authorization !== null) throw migrationFenceError(operation);
    return { allowed: true, transactionId: null };
  }
  if (
    coordinator.decision !== "undecided" ||
    coordinator.phase !== "service-prepared" ||
    coordinator.serviceParticipant === null ||
    coordinator.stateParticipant.afterState === null
  ) {
    throw migrationFenceError(operation);
  }
  const expectedState = coordinator.stateParticipant.afterState;
  const currentState = await readState(statePath);
  if (!sameStudioState(currentState, expectedState)) {
    throw migrationFenceError(operation);
  }
  if (await readTransition(transitionPath) !== null) {
    throw migrationFenceError(operation);
  }

  const foregroundAllowed =
    authorization !== null &&
    typeof authorization === "object" &&
    !Array.isArray(authorization) &&
    authorization.role === "migration-ready-foreground" &&
    authorization.transactionId === coordinator.transactionId &&
    authorization.journalPath === journalPath &&
    authorization.expectedRevision === expectedState.revision &&
    authorization.expectedControlToken === expectedState.controlToken &&
    ["controller:set-persistence", "controller:finalize-enable"].includes(operation);
  if (foregroundAllowed) {
    return { allowed: true, transactionId: coordinator.transactionId, role: authorization.role };
  }

  const requestCreatedAt = Date.parse(startupHandshake?.createdAt);
  const backgroundAllowed =
    operation === "controller:start" &&
    startupHandshake !== null &&
    typeof startupHandshake === "object" &&
    startupHandshake.revision === expectedState.revision &&
    Number.isFinite(requestCreatedAt) &&
    requestCreatedAt >= Date.parse(coordinator.createdAt);
  if (backgroundAllowed) {
    return {
      allowed: true,
      transactionId: coordinator.transactionId,
      role: "migration-ready-background",
    };
  }
  throw migrationFenceError(operation);
}

const PRODUCTION_LEASE_RETRY_DELAYS_MS = Object.freeze([
  100, 200, 400, 800, 1600, 3200,
]);
const LOCK_HELD_ACTION_STARTED = Symbol("heige.lockHeldActionStarted");

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isLockHeldError(error) {
  try {
    return error?.code === "LOCK_HELD";
  } catch {
    return false;
  }
}

/**
 * Retry only while lock acquisition itself fails with LOCK_HELD.
 * Once the protected action has started, failures fail closed without retry.
 */
export async function withLockHeldRetry(
  run,
  {
    delaysMs = PRODUCTION_LEASE_RETRY_DELAYS_MS,
    wait = sleep,
  } = {},
) {
  if (typeof run !== "function") throw new TypeError("run must be a function");
  if (!Array.isArray(delaysMs) || delaysMs.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError("delaysMs must be an array of non-negative safe integers");
  }
  if (typeof wait !== "function") throw new TypeError("wait must be a function");

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (
        error?.[LOCK_HELD_ACTION_STARTED] === true ||
        !isLockHeldError(error) ||
        attempt >= delaysMs.length
      ) {
        throw error;
      }
      await wait(delaysMs[attempt]);
    }
  }
}

async function withProductionStateLease({
  paths,
  options,
  operation,
  authorization = null,
  installAuthorization = null,
  startupHandshake = null,
  backgroundIdentity = null,
  requestContext = {},
}, action) {
  return withLockHeldRetry(async () => {
    let actionStarted = false;
    try {
      return await withOperationLock({ ...options, operation }, async (lease) => {
        await enforceLegacyMigrationFence({
          journalPath: legacyMigrationJournalPath(paths.stateRoot),
          statePath: paths.statePath,
          transitionPath: paths.transitionPath,
          lease,
          operation,
          authorization,
          startupHandshake,
        });
        await enforceMacosInstallFence({
          journalPath: macosInstallJournalPath(paths.stateRoot),
          statePath: paths.statePath,
          transitionPath: paths.transitionPath,
          lease,
          operation,
          authorization: installAuthorization,
          startupHandshake,
          backgroundIdentity,
          requestContext,
        });
        actionStarted = true;
        return action(lease);
      });
    } catch (error) {
      if (actionStarted && error && typeof error === "object") {
        error[LOCK_HELD_ACTION_STARTED] = true;
      }
      throw error;
    }
  });
}

async function ensureProductionState({ paths, themeId, process: processIdentity, keepUntilProcessExit }) {
  const options = await productionLockOptions(paths);
  return withProductionStateLease({
    paths,
    options,
    operation: "cli:prepare-state",
  }, async (lease) => {
    let state = await readStudioState(paths.statePath);
    if (state === null) {
      state = createDefaultStudioState({
        themeId,
        token: randomBytes(32).toString("base64url"),
      });
      state = await writeStudioState(paths.statePath, state, { lease });
    } else if (state.selectedThemeId !== themeId || state.lastNonNativeThemeId !== themeId) {
      state = await compareAndUpdateStudioState(paths.statePath, {
        lease,
        expectedRevision: state.revision,
        mutate: (current) => ({
          ...current,
          selectedThemeId: themeId,
          lastNonNativeThemeId: themeId,
        }),
      });
    }
    if (processIdentity !== undefined) {
      await writeSessionState(paths.sessionPath, {
        schemaVersion: 1,
        mode: "active",
        process: processIdentity,
        activeThemeId: themeId,
        keepUntilProcessExit,
      }, { lease });
    }
    return state;
  });
}

async function themeBundle({ deps, roots, themeId }) {
  const themes = await deps.listThemes({ roots });
  const selected = themes.find((theme) => theme.id === themeId);
  if (!selected) throw new Error(`找不到主题：${themeId}`);
  const loadedTheme = await deps.loadTheme(selected.path);
  const menuThemes = [];
  for (const theme of themes) {
    if (theme.id === themeId) {
      menuThemes.push(loadedTheme);
      continue;
    }
    try {
      menuThemes.push(await deps.loadTheme(theme.path));
    } catch {
      // 坏主题不进入菜单，也不阻断一个已经完整验证的目标主题。
    }
  }
  return { loadedTheme, menuThemes, selected, themes };
}

export function controllerInjectionPreference({ ephemeral = false, preferStored } = {}) {
  if (preferStored !== undefined && typeof preferStored !== "boolean") {
    throw new TypeError("preferStored 必须是布尔值");
  }
  return preferStored ?? !ephemeral;
}

function windowsPowerShellPath(env = process.env) {
  return trustedWindowsPowerShellPath(env);
}

async function runWindowsControllerAction({
  action,
  taskName,
  port,
  stateRoot,
  revision,
  transitionNonce,
}) {
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(repositoryRoot, "scripts", "windows", "controller.ps1"),
    "-Action",
    action,
    "-TaskName",
    taskName,
    "-Port",
    String(port),
    "-StateDirectory",
    stateRoot,
  ];
  if (action === "start") {
    args.push(
      "-ExpectedRevision",
      String(revision),
      "-ExpectedTransitionNonce",
      transitionNonce,
    );
  }
  const { stdout } = await execFile(windowsPowerShellPath(), args, {
    env: isolatedWindowsPowerShellEnvironment(),
  });
  const text = stdout.trim();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error(`Windows controller ${action} 返回了无效 JSON`, { cause });
  }
}

export function normalizeWindowsBackgroundStatus(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { registered: false, running: false };
  }
  const registered = value.Exists === true;
  return {
    registered,
    running: registered && value.TaskRunning === true && value.State === "Running",
  };
}

export function createBackgroundReadinessVerifier({
  stateRoot,
  platform,
  backgroundIdentity,
  forbiddenPid = process.pid,
  readIdentity = (pid) => readProcessIdentity(pid, platform),
  wait = waitForBackgroundHandshake,
  consume = consumeBackgroundHandshake,
}) {
  let verified = null;
  const processIdentity = (value) => (
    Number.isSafeInteger(value?.pid) &&
    value.pid > 0 &&
    typeof value?.startedAt === "string" &&
    value.startedAt.length > 0
  ) ? { pid: value.pid, startedAt: value.startedAt } : null;
  const expected = ({ revision, transitionNonce }) => ({
    revision,
    transitionNonce,
    platform,
    backgroundIdentity,
    outcome: "ready",
  });
  return Object.freeze({
    async verify({ revision, transitionNonce, handshakeRequest }) {
      verified = null;
      const notBefore = handshakeRequest?.notBefore;
      const observed = await wait({
        stateRoot,
        expected: expected({ revision, transitionNonce }),
        forbiddenPid,
        notBefore,
        readProcessIdentity: readIdentity,
      });
      const identity = observed.outcome === "ready" ? processIdentity(observed) : null;
      if (identity === null) return null;
      verified = { revision, transitionNonce, notBefore, identity };
      return { ...identity };
    },
    async consume({ revision, transitionNonce } = {}) {
      if (
        verified === null ||
        verified.revision !== revision ||
        verified.transitionNonce !== transitionNonce
      ) {
        return null;
      }
      const claim = verified;
      verified = null;
      try {
        const observed = await consume({
          stateRoot,
          expected: expected(claim),
          forbiddenPid,
          notBefore: claim.notBefore,
          readProcessIdentity: readIdentity,
        });
        const identity = observed.outcome === "ready" ? processIdentity(observed) : null;
        return identity !== null &&
          identity.pid === claim.identity.pid &&
          identity.startedAt === claim.identity.startedAt
          ? { ...identity }
          : null;
      } catch {
        return null;
      }
    },
    discard() {
      verified = null;
    },
  });
}

export async function productionController({
  port,
  paths,
  roots,
  deps,
  ephemeral = false,
  preferStored,
  platform = process.platform,
  taskName,
  startupHandshake = null,
  background = false,
  migrationAuthorization = null,
  installAuthorization = null,
  preflight = null,
}) {
  const injectionPreferStored = controllerInjectionPreference({ ephemeral, preferStored });
  const backgroundIdentity = controllerBackgroundIdentity(
    platform,
    platform === "win32" ? (taskName ?? WINDOWS_PRODUCTION_TASK) : taskName,
  );
  const lock = await productionLockOptions(paths, platform);
  let deferredWindowsUnregister = false;
  const queryWindowsRuntime = deps.queryWindowsRuntime ?? ((input) =>
    queryWindowsRuntimeSnapshot({
      ...input,
      powershellPath: windowsPowerShellPath(),
      commonScriptPath: join(repositoryRoot, "scripts", "windows", "lib", "common.ps1"),
    }));
  const probeWindows = platform === "win32"
    ? createWindowsRuntimeProbe({ port, queryWindowsRuntime })
    : null;
  const probe = async () => {
    if (platform === "win32") return probeWindows();
    const app = await resolveCodexApp({ platform });
    const candidates = (await listCodexProcesses({ app })).filter((entry) => entry.cdpPort === port);
    if (candidates.length === 0) return null;
    if (candidates.length !== 1) throw new Error("Codex 进程身份不唯一");
    return publicProcess(candidates[0]);
  };
  const controllerPortOwnerValidator = createControllerPortOwnerValidator({
    platform,
    port,
    probe,
    windowsProbe: probeWindows,
  });
  // 用户正常启动的 Codex 不带任何 CDP 端口，这正是常驻要接管的那一个。
  const probeNative = async () => {
    const app = await resolveCodexApp({ platform });
    const candidates = (await listCodexProcesses({ app }))
      .filter((entry) => entry.cdpPort === null);
    if (candidates.length === 0) return null;
    if (candidates.length !== 1) throw new Error("Codex 原生进程身份不唯一");
    return publicProcess(candidates[0]);
  };
  if (preflight?.process !== undefined && preflight.process !== null) {
    const current = await probe();
    if (!sameProcessIdentity(current, preflight.process)) {
      throw new Error("Codex 进程在 controller 创建前已变化");
    }
  }
  const initial = await readStudioState(paths.statePath);
  const currentVersion = await deps.readCurrentPackageVersion();
  const checkForUpdate = deps.createCachedUpdateChecker({ currentVersion });
  const logger = createStudioLogger({
    path: paths.logPath,
    token: initial?.controlToken ?? "",
  });
  const readiness = createBackgroundReadinessVerifier({
    stateRoot: paths.stateRoot,
    platform,
    backgroundIdentity,
  });
  return createSkinController({
    backgroundProcess: background,
    allowInternalPersistenceEnable:
      migrationAuthorization !== null || installAuthorization !== null,
    currentVersion,
    checkForUpdate,
    deliverUpdateCheckResult: (payload) => deps.deliverUpdateCheckResult({
      port,
      ...payload,
    }),
    deliverThemeSelectionResult: (payload) => deps.deliverThemeSelectionResult({
      port,
      ...payload,
    }),
    statePath: paths.statePath,
    sessionPath: paths.sessionPath,
    transitionPath: paths.transitionPath,
    withLease: (operation, action, context = {}) => withProductionStateLease({
      paths,
      options: lock,
      operation,
      authorization: migrationAuthorization,
      installAuthorization,
      startupHandshake: context.startupHandshake ?? null,
      backgroundIdentity,
      requestContext: context,
    }, action),
    probeCurrentProcess: probe,
    // Windows 的重启必须走 scripts/windows 包装器，这条直连生命周期路径只在 macOS 成立。
    ...(platform === "darwin"
      ? {
        probeNativeProcess: probeNative,
        restartIntoCdp: async ({ process: nativeProcess }) => {
          const app = await resolveCodexApp({ platform });
          // 不带 afterLaunch：本控制器就在运行，Codex 一带着 CDP 回来它自己会注入。
          return productionRestartDetached({
            paths,
            preflight: {
              appPath: app.appPath,
              nodePath: process.execPath,
              process: nativeProcess,
            },
            launchMode: "cdp",
            port,
            platform,
          });
        },
      }
      : {}),
    validatePortOwner: controllerPortOwnerValidator,
    ...(typeof probeWindows?.discardPortProof === "function"
      ? { discardPortProof: () => probeWindows.discardPortProof() }
      : {}),
    inspectSkin: (options = {}) => deps.skinStatus({
      port,
      includeControlRequest: options?.purpose === "renderer-control-request",
    }),
    validateThemeSelection: async (themeId) => {
      try {
        const resolve = deps.resolveAndLoadTheme ?? resolveAndLoadTheme;
        await resolve({ roots, id: themeId });
        return true;
      } catch {
        return false;
      }
    },
    injectSkin: async ({ themeId, control, targetIds, preferStored: requestPreference }) => {
      const state = await readStudioState(paths.statePath);
      const effectiveThemeId = themeId === NATIVE_THEME_ID
        ? state?.lastNonNativeThemeId ?? DEFAULT_THEME_ID
        : themeId;
      const bundle = await themeBundle({ deps, roots, themeId: effectiveThemeId });
      return deps.applySkin({
        loadedTheme: bundle.loadedTheme,
        themes: bundle.menuThemes,
        activeId: themeId === NATIVE_THEME_ID ? null : effectiveThemeId,
        port,
        currentVersion,
        preferStored: requestPreference ?? injectionPreferStored,
        control,
        targetIds,
      });
    },
    removeSkin: () => deps.removeSkin({ port }),
    prepareBackgroundHandshake: async ({ revision, transitionNonce }) => {
      readiness.discard();
      await removeBackgroundHandshake({ stateRoot: paths.stateRoot });
      await removeLegacyBackgroundStartRequest({ stateRoot: paths.stateRoot });
      const request = await publishBackgroundStartRequest({
        stateRoot: paths.stateRoot,
        revision,
        transitionNonce,
        platform,
        backgroundIdentity,
        outerTransaction: installAuthorization === null
          ? null
          : {
            transactionId: installAuthorization.transactionId,
            journalPath: installAuthorization.journalPath,
          },
      });
      return { notBefore: Date.parse(request.createdAt) };
    },
    registerBackground: () => platform === "darwin"
      ? registerControllerAgent().then((value) => ({
        ...value,
        registered: value.loaded === true,
      }))
      : runWindowsControllerAction({
        action: "register",
        taskName: backgroundIdentity,
        port,
        stateRoot: paths.stateRoot,
      }).then((value) => ({
        ...value,
        registered: value.Registered === true || value.Exists === true,
      })),
    unregisterBackground: async () => {
      readiness.discard();
      if (platform === "darwin") {
        const value = await unregisterControllerAgent({
          deferIfCurrentProcess: background,
        });
        await removeBackgroundStartRequest({ stateRoot: paths.stateRoot }).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
        await removeBackgroundHandshake({ stateRoot: paths.stateRoot }).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
        return { ...value, registered: false };
      }
      if (startupHandshake !== null) {
        deferredWindowsUnregister = true;
        return { registered: false, loaded: false, deferred: true };
      }
      const value = await runWindowsControllerAction({
        action: "unregister",
        taskName: backgroundIdentity,
        port,
        stateRoot: paths.stateRoot,
      });
      await removeBackgroundStartRequest({ stateRoot: paths.stateRoot }).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      await removeBackgroundHandshake({ stateRoot: paths.stateRoot }).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      return { ...value, registered: false, loaded: false };
    },
    inspectBackground: async (expected) => {
      let status;
      if (platform === "darwin") {
        const value = await inspectLaunchAgent();
        status = {
          ...value,
          registered: value.plistExists === true && value.loaded === true,
          running: value.loaded === true,
        };
      } else {
        if (deferredWindowsUnregister) {
          return { registered: false, running: false, loaded: false, deferred: true };
        }
        const value = await runWindowsControllerAction({
          action: "status",
          taskName: backgroundIdentity,
          port,
          stateRoot: paths.stateRoot,
        });
        status = { ...value, ...normalizeWindowsBackgroundStatus(value) };
      }
      const processIdentity = status.registered === true && status.running === true
        ? await readiness.consume(expected)
        : null;
      return {
        ...status,
        loaded: processIdentity !== null,
        processIdentity,
      };
    },
    wakeBackground: (request) => platform === "darwin"
      ? wakeControllerAgent()
      : runWindowsControllerAction({
        action: "start",
        taskName: backgroundIdentity,
        port,
        stateRoot: paths.stateRoot,
        revision: request.revision,
        transitionNonce: request.transitionNonce,
      }),
    verifyBackgroundHandshake: (input) => readiness.verify(input),
    preflightEnable: async () => true,
    logger,
  });
}

export async function runControllerProcess(controller, {
  once = false,
  ephemeralRuntime = false,
  startupHandshake = null,
  backgroundRuntime = null,
  paths,
  claimStartRequest = claimBackgroundStartRequest,
  publishHandshake = publishBackgroundHandshake,
  readCurrentIdentity,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (startupHandshake !== null && backgroundRuntime !== null) {
    throw new Error("background controller cannot combine inline and one-shot handshake requests");
  }
  let activeHandshake = startupHandshake;
  if (backgroundRuntime !== null) {
    if (
      backgroundRuntime === null ||
      typeof backgroundRuntime !== "object" ||
      !["darwin", "win32"].includes(backgroundRuntime.platform) ||
      typeof backgroundRuntime.backgroundIdentity !== "string" ||
      backgroundRuntime.backgroundIdentity.length === 0
    ) {
      throw new Error("background runtime identity is invalid");
    }
    activeHandshake = await claimStartRequest({
      stateRoot: paths.stateRoot,
      platform: backgroundRuntime.platform,
      backgroundIdentity: backgroundRuntime.backgroundIdentity,
    });
  }
  let result = await controller.start({ startupHandshake: activeHandshake });
  if (activeHandshake !== null) {
    try {
      if (result?.action === "error" || result?.mode === "error") {
        throw new Error("controller start failed before background handshake");
      }
      if (result?.revision !== activeHandshake.revision) {
        throw new Error("controller start revision does not match the handshake request");
      }
      const outcome = result.action === "unregister" ? "unregister" : "ready";
      if (
        (outcome === "ready" && result.persistenceEnabled !== true) ||
        (outcome === "unregister" && result.persistenceEnabled !== false)
      ) {
        throw new Error("controller start outcome does not match authoritative persistence state");
      }
      const identity = await (readCurrentIdentity ?? (() =>
        readProcessIdentity(process.pid, activeHandshake.platform)))();
      if (
        identity === null ||
        identity?.pid !== process.pid ||
        typeof identity?.startedAt !== "string" ||
        identity.startedAt.length === 0
      ) {
        throw new Error("controller process identity is unavailable for background handshake");
      }
      await publishHandshake({
        stateRoot: paths.stateRoot,
        revision: activeHandshake.revision,
        transitionNonce: activeHandshake.transitionNonce,
        platform: activeHandshake.platform,
        backgroundIdentity: activeHandshake.backgroundIdentity,
        pid: identity.pid,
        startedAt: identity.startedAt,
        outcome,
      });
    } catch (error) {
      await controller.stop();
      throw error;
    }
  }
  const handoffEphemeral = async (current) => {
    let handedOff;
    try {
      handedOff = await controller.setPersistence({
        expectedRevision: current.revision,
        enabled: true,
      });
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      await controller.stop();
    }
    return {
      action: "handoff",
      mode: current.mode,
      persistenceEnabled: handedOff.persistenceEnabled,
      revision: handedOff.revision,
    };
  };
  if (ephemeralRuntime && result?.persistenceEnabled === true) {
    return handoffEphemeral(result);
  }
  if (once || result.action === "unregister" || result.action === "error") {
    await controller.stop();
    return result;
  }
  while (true) {
    await wait(1000);
    result = await controller.tick();
    if (result.action === "unregister" || result.action === "handoff") {
      await controller.stop();
      return result;
    }
    if (ephemeralRuntime && result.persistenceEnabled === true) {
      return handoffEphemeral(result);
    }
  }
}

export async function waitForAppliedSkin({
  deps,
  port,
  themeId,
  // Store/cold-start Codex can take >20s before the main renderer answers CDP.
  attempts = 160,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  progress = (message) => {
    try {
      process.stderr.write(`${message}\n`);
    } catch {}
  },
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const status = await deps.skinStatus({ port });
      const statuses = status?.statuses;
      const failed = status?.failed;
      const succeededResults = status?.results?.succeeded;
      const failedResults = status?.results?.failed;
      if (
        Array.isArray(statuses) && statuses.length > 0 &&
        Array.isArray(failed) && failed.length === 0 &&
        Array.isArray(succeededResults) && succeededResults.length === statuses.length &&
        Array.isArray(failedResults) && failedResults.length === 0 &&
        statuses.every((entry) => (
          entry?.installed === true && entry?.mode === "active" && entry?.themeId === themeId
        ))
      ) {
        return true;
      }
    } catch {}
    if (attempt === 0 || (attempt + 1) % 20 === 0) {
      progress(
        `确认：仍在等待皮肤生效… ${attempt + 1}/${attempts}（无需点击）`,
      );
    }
    await wait(250);
  }
  throw new Error("ephemeral controller 未确认皮肤已应用");
}

async function productionRegisterEphemeral({ deps, paths, port, preflight, themeId }) {
  await ensureProductionState({
    paths,
    themeId,
    process: preflight.process,
    keepUntilProcessExit: true,
  });
  const child = spawn(process.execPath, [
    fileURLToPath(import.meta.url),
    "controller",
    "--ephemeral",
    "--port",
    String(port),
  ], { detached: true, stdio: "ignore" });
  child.unref();
  await waitForAppliedSkin({ deps, port, themeId });
  return { mode: "active" };
}

function windowsLifecycleWrapperRequired(command) {
  const wrapper = command;
  const error = new Error(
    `Windows 上 ${wrapper} 需要启动或重启 Codex 时，必须使用 ` +
    `scripts/windows/${wrapper}.ps1 或 scripts/windows/${wrapper}.bat；` +
    "直接运行 Node CLI 不会调用 macOS 生命周期助手",
  );
  error.code = "WINDOWS_LIFECYCLE_WRAPPER_REQUIRED";
  return error;
}

function assertDirectLifecycleRestartSupported(platform, command) {
  if (platform === "win32") throw windowsLifecycleWrapperRequired(command);
}

async function productionRestartDetached({
  paths,
  preflight,
  launchMode,
  port,
  afterLaunch = null,
  platform = process.platform,
}) {
  if (platform === "win32") {
    const command = launchMode === "native"
      ? "restore"
      : (afterLaunch?.command ?? "apply");
    throw windowsLifecycleWrapperRequired(command);
  }
  const actionPath = join(paths.stateRoot, `lifecycle-${randomUUID()}.json`);
  await writeLifecycleActionFile(actionPath, {
    process: preflight.process,
    appPath: preflight.appPath,
    launchMode,
    port: launchMode === "cdp" ? port : null,
    verifyPort: launchMode === "native" ? port : null,
    afterLaunch: afterLaunch === null
      ? null
      : {
        command: afterLaunch.command,
        cliPath: fileURLToPath(import.meta.url),
        nodePath: preflight.nodePath,
        port,
        themeId: afterLaunch.themeId,
      },
  });
  return spawnDetachedLifecycle({
    nodePath: preflight.nodePath,
    helperPath: join(repositoryRoot, "src", "lifecycle-helper.mjs"),
    actionPath,
  });
}

async function legacyLoaded() {
  if (typeof process.getuid !== "function") throw new Error("migrate-legacy 只支持 macOS 当前用户");
  try {
    await execFile("/bin/launchctl", [
      "print",
      `gui/${process.getuid()}/com.heige.codex-skin-watchdog`,
    ]);
    return true;
  } catch (error) {
    if (error?.code === 3 || error?.code === 113) return false;
    throw error;
  }
}

function sameStudioState(left, right) {
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  return [
    "schemaVersion",
    "persistenceEnabled",
    "selectedThemeId",
    "lastNonNativeThemeId",
    "controlToken",
    "lastTransitionNonce",
    "revision",
  ].every((key) => left[key] === right[key]);
}

function publicMigrationResult(state, migratedFrom = null) {
  return {
    migratedFrom,
    persistenceEnabled: state.persistenceEnabled,
  };
}

function exactMigrationReadyAck(ready, expectedState) {
  if (
    ready?.persistenceEnabled !== true ||
    ready?.revision !== expectedState.revision ||
    !Number.isSafeInteger(ready?.processIdentity?.pid) ||
    ready.processIdentity.pid <= 0 ||
    typeof ready.processIdentity.startedAt !== "string" ||
    ready.processIdentity.startedAt.length === 0
  ) {
    throw new Error("legacy migration did not receive the exact background readiness ACK");
  }
  return {
    persistenceEnabled: true,
    revision: ready.revision,
    processIdentity: { ...ready.processIdentity },
  };
}

async function recoverLegacyLifecycle({ journalPath, dependencies }) {
  let coordinator = await dependencies.withStateLease(
    "cli:migrate-legacy:inspect-recovery",
    (lease) => dependencies.readCoordinator(journalPath, { lease }),
  );
  if (coordinator === null) return { recovered: false };

  if (coordinator.decision === "undecided") {
    coordinator = await dependencies.withStateLease(
      "cli:migrate-legacy:decide-rollback",
      (lease) => dependencies.updateCoordinator(
        journalPath,
        coordinator,
        { decision: "rollback", phase: "rollback-decided" },
        { lease },
      ),
    );
  }

  const recoveryErrors = [];
  try {
    await dependencies.recoverService();
  } catch (error) {
    recoveryErrors.push(error);
  }

  if (coordinator.decision === "rollback") {
    try {
      await dependencies.withStateLease(
        "cli:migrate-legacy:rollback-state",
        async (lease) => {
          await dependencies.rollbackState({
            ...coordinator.stateParticipant,
            lease,
          });
          const restored = await dependencies.readState(
            coordinator.stateParticipant.statePath,
          );
          const before = coordinator.stateParticipant.beforeState;
          if (
            (before === null && restored !== null) ||
            (before !== null && !sameStudioState(restored, before))
          ) {
            throw new Error("legacy migration rollback did not restore the exact state precondition");
          }
        },
      );
    } catch (error) {
      recoveryErrors.push(error);
    }
  } else if (coordinator.decision === "commit") {
    try {
      await dependencies.withStateLease(
        "cli:migrate-legacy:verify-committed-state",
        async () => {
          const committed = await dependencies.readState(
            coordinator.stateParticipant.statePath,
          );
          if (!sameStudioState(committed, coordinator.stateParticipant.afterState)) {
            throw new Error("legacy migration committed state is missing or changed");
          }
        },
      );
    } catch (error) {
      recoveryErrors.push(error);
    }
  }

  if (recoveryErrors.length > 0) {
    const error = new AggregateError(
      recoveryErrors,
      `legacy migration ${coordinator.decision} recovery did not finish`,
    );
    error.code = "LEGACY_MIGRATION_RECOVERY_FAILED";
    throw error;
  }

  await dependencies.withStateLease(
    "cli:migrate-legacy:clear-recovery",
    async (lease) => {
      const observed = await dependencies.readCoordinator(journalPath, { lease });
      if (observed === null || observed.transactionId !== coordinator.transactionId) {
        throw new Error("legacy migration coordinator changed before recovery cleanup");
      }
      await dependencies.clearCoordinator(journalPath, observed, { lease });
    },
  );
  return { recovered: true, decision: coordinator.decision };
}

export async function migrateLegacyLifecycle({
  port,
  statePath,
  journalPath,
  legacyThemePath,
  dependencies,
}) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("legacy migration port is invalid");
  }
  return dependencies.withCoordinatorLease(async () => {
    await recoverLegacyLifecycle({ journalPath, dependencies });
    const existing = await dependencies.readState(statePath);
    if (existing !== null) return publicMigrationResult(existing);

    const legacyAgentLoaded = await dependencies.legacyLoaded();
    const transactionId = dependencies.randomUUID();
    const tokenBytes = dependencies.randomBytes(32);
    const expectedControlToken = Buffer.from(tokenBytes).toString("base64url");
    let coordinator = null;
    let migrated = null;
    try {
      let racedState = null;
      await dependencies.withStateLease(
        "cli:migrate-legacy:prepare-state",
        async (lease) => {
          const beforeState = await dependencies.readState(statePath);
          if (beforeState !== null) {
            racedState = beforeState;
            return;
          }
          coordinator = await dependencies.createCoordinator({
            journalPath,
            transactionId,
            lease,
            stateParticipant: {
              statePath,
              beforeState,
              afterState: null,
              expectedControlToken,
            },
          });
          migrated = await dependencies.migrateState({
            statePath,
            lease,
            legacyThemePath,
            legacyAgentLoaded,
            themeExists: dependencies.themeExists,
            randomBytes: (size) => {
              if (size !== 32) throw new Error("legacy migration requested an invalid token size");
              return Buffer.from(tokenBytes);
            },
          });
          coordinator = await dependencies.updateCoordinator(
            journalPath,
            coordinator,
            {
              phase: "state-prepared",
              stateParticipant: {
                ...coordinator.stateParticipant,
                afterState: migrated.state,
              },
            },
            { lease },
          );
        },
      );
      if (racedState !== null) return publicMigrationResult(racedState);

      if (!legacyAgentLoaded) {
        await dependencies.withStateLease(
          "cli:migrate-legacy:commit-state-only",
          async (lease) => {
            const authoritative = await dependencies.readState(statePath);
            if (!sameStudioState(authoritative, migrated.state)) {
              throw new Error("legacy migration state changed before commit");
            }
            coordinator = await dependencies.updateCoordinator(
              journalPath,
              coordinator,
              { decision: "commit", phase: "commit-decided" },
              { lease },
            );
          },
        );
      } else {
        const service = await dependencies.migrateService({
          deferCommit: true,
          outerTransaction: { journalPath, transactionId },
        });
        if (
          service?.legacyFound !== true ||
          service?.controllerRegistered !== true ||
          service?.transaction === null ||
          typeof service?.transaction !== "object"
        ) {
          throw new Error("legacy watchdog changed before its service participant was prepared");
        }
        await dependencies.withStateLease(
          "cli:migrate-legacy:record-service",
          async (lease) => {
            coordinator = await dependencies.updateCoordinator(
              journalPath,
              coordinator,
              {
                phase: "service-prepared",
                serviceParticipant: service.transaction,
              },
              { lease },
            );
          },
        );

        const ready = await dependencies.awaitExactReady({
          port,
          expectedState: migrated.state,
          outerTransaction: { journalPath, transactionId },
        });
        const ack = exactMigrationReadyAck(ready, migrated.state);

        await dependencies.withStateLease(
          "cli:migrate-legacy:decide-commit",
          async (lease) => {
            const authoritative = await dependencies.readState(statePath);
            if (!sameStudioState(authoritative, migrated.state)) {
              throw new Error("legacy migration state changed after readiness ACK");
            }
            coordinator = await dependencies.updateCoordinator(
              journalPath,
              coordinator,
              { ack, phase: "ready-acked" },
              { lease },
            );
            if (!await dependencies.verifyAckIdentity(ack.processIdentity)) {
              throw new Error("legacy migration controller ACK changed before commit");
            }
            coordinator = await dependencies.updateCoordinator(
              journalPath,
              coordinator,
              { decision: "commit", phase: "commit-decided" },
              { lease },
            );
          },
        );
        await dependencies.finalizeService(service.transaction);
      }

      await dependencies.withStateLease(
        "cli:migrate-legacy:clear-commit",
        async (lease) => dependencies.clearCoordinator(journalPath, coordinator, { lease }),
      );
      return publicMigrationResult(migrated.state, migrated.migratedFrom);
    } catch (primaryError) {
      if (primaryError?.simulatedHardCrash === true) throw primaryError;
      if (coordinator === null) throw primaryError;
      const recoveryErrors = [];
      try {
        await recoverLegacyLifecycle({ journalPath, dependencies });
      } catch (error) {
        recoveryErrors.push(error);
      }
      if (recoveryErrors.length === 0) throw primaryError;
      const error = new AggregateError(
        [primaryError, ...recoveryErrors],
        `legacy migration failed and rollback did not finish: ${primaryError.message}`,
      );
      error.code = "LEGACY_MIGRATION_ROLLBACK_FAILED";
      throw error;
    }
  });
}

async function productionMigrateLegacy({ deps, paths, roots, port }) {
  const stateLock = await productionLockOptions(paths);
  const coordinatorStateRoot = join(paths.stateRoot, "legacy-migration-operation");
  const coordinatorLock = {
    ...stateLock,
    stateRoot: coordinatorStateRoot,
    lockPath: join(coordinatorStateRoot, "operation.lock"),
  };
  const journalPath = legacyMigrationJournalPath(paths.stateRoot);
  const dependencies = {
    randomBytes,
    randomUUID,
    legacyLoaded,
    readState: readStudioState,
    withCoordinatorLease: (action) => withOperationLock({
      ...coordinatorLock,
      operation: "cli:migrate-legacy-coordinator",
    }, action),
    withStateLease: (operation, action) => withOperationLock({
      ...stateLock,
      operation,
    }, action),
    readCoordinator: readLegacyMigrationCoordinator,
    createCoordinator: createLegacyMigrationCoordinator,
    updateCoordinator: updateLegacyMigrationCoordinator,
    clearCoordinator: clearLegacyMigrationCoordinator,
    migrateState: migrateLegacyState,
    rollbackState: rollbackLegacyStateMigration,
    migrateService: migrateLegacyWatchdog,
    finalizeService: finalizeLegacyWatchdogMigration,
    recoverService: recoverLegacyWatchdogMigration,
    verifyAckIdentity: async (expected) => {
      const observed = await inspectLaunchAgentProcessIdentity();
      return observed?.pid === expected?.pid && observed?.startedAt === expected?.startedAt;
    },
    themeExists: async (themeId) => {
      const themes = await deps.listThemes({ roots });
      return themes.some((theme) => theme.id === themeId);
    },
    awaitExactReady: async ({ port: selectedPort, expectedState, outerTransaction }) => {
      const controller = await lifecycleController(deps, {
        port: selectedPort,
        preferStored: true,
        migrationAuthorization: {
          role: "migration-ready-foreground",
          transactionId: outerTransaction.transactionId,
          journalPath: outerTransaction.journalPath,
          expectedRevision: expectedState.revision,
          expectedControlToken: expectedState.controlToken,
        },
      });
      return withStoppedController(controller, () => controller.setPersistence({
        expectedRevision: expectedState.revision,
        enabled: true,
        includeProcessIdentity: true,
      }));
    },
  };
  return migrateLegacyLifecycle({
    port,
    statePath: paths.statePath,
    journalPath,
    legacyThemePath: join(process.env.HOME, ".codex", "heige-codex-skin-persist", "theme"),
    dependencies,
  });
}

export async function offlineDisablePersistence({
  statePath,
  sessionPath,
  transitionPath,
  expectedRevision,
  dependencies,
}) {
  if (
    expectedRevision !== undefined &&
    (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
  ) {
    throw new Error("expectedRevision must be a non-negative safe integer");
  }
  return dependencies.withStateLease(
    "cli:disable-persistence-offline",
    async (lease) => {
      await dependencies.recoverTransition({
        statePath,
        sessionPath,
        transitionPath,
        lease,
        currentProcess: null,
      });
      let state = await dependencies.readState(statePath);
      // 装了但从未 apply 过时本来就是原生外观，还原应当幂等成功并落下「已关闭」，
      // 不该反过来要求用户先去 apply 才能还原。
      if (state === null) state = await dependencies.createDisabledState(statePath, { lease });
      if (state.persistenceEnabled === true) {
        const revision = expectedRevision ?? state.revision;
        state = await dependencies.compareState(statePath, {
          lease,
          expectedRevision: revision,
          mutate: (current) => ({
            ...current,
            persistenceEnabled: false,
            lastTransitionNonce: dependencies.newTransitionNonce(),
          }),
        });
      }
      await dependencies.writeSession(sessionPath, {
        schemaVersion: 1,
        mode: "native",
        process: null,
        activeThemeId: null,
        keepUntilProcessExit: false,
      }, { lease });
      await dependencies.unregisterBackground();
      const background = await dependencies.inspectBackground();
      if (background?.registered !== false) {
        throw new Error("常驻已关闭，但后台控制器仍保持注册");
      }
      return {
        persistenceEnabled: false,
        revision: state.revision,
      };
    },
  );
}

async function productionUnregisterBackground({
  paths,
  platform,
  port,
  taskName = WINDOWS_PRODUCTION_TASK,
}) {
  if (platform === "darwin") {
    await unregisterControllerAgent();
  } else if (platform === "win32") {
    await runWindowsControllerAction({
      action: "unregister",
      taskName,
      port,
      stateRoot: paths.stateRoot,
    });
  } else {
    throw new Error(`不支持的平台：${platform}`);
  }
  await removeBackgroundStartRequest({ stateRoot: paths.stateRoot }).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  await removeBackgroundHandshake({ stateRoot: paths.stateRoot }).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function productionInspectBackground({
  platform,
  paths,
  port,
  taskName = WINDOWS_PRODUCTION_TASK,
}) {
  if (platform === "darwin") {
    const value = await inspectLaunchAgent();
    return {
      ...value,
      registered: value.plistExists === true && value.loaded === true,
    };
  }
  if (platform === "win32") {
    const value = await runWindowsControllerAction({
      action: "status",
      taskName,
      port,
      stateRoot: paths.stateRoot,
    });
    return { ...value, ...normalizeWindowsBackgroundStatus(value) };
  }
  throw new Error(`不支持的平台：${platform}`);
}

async function productionOfflineDisable({ paths, platform, port, expectedRevision, taskName }) {
  const stateLock = await productionLockOptions(paths, platform);
  return offlineDisablePersistence({
    statePath: paths.statePath,
    sessionPath: paths.sessionPath,
    transitionPath: paths.transitionPath,
    expectedRevision,
    dependencies: {
      withStateLease: (operation, action) => withProductionStateLease({
        paths,
        options: stateLock,
        operation,
      }, action),
      readState: readStudioState,
      createDisabledState: (path, { lease }) => writeStudioState(path, createDefaultStudioState({
        themeId: DEFAULT_THEME_ID,
        token: randomBytes(32).toString("base64url"),
      }), { lease }),
      compareState: compareAndUpdateStudioState,
      writeSession: writeSessionState,
      recoverTransition: recoverStateTransition,
      newTransitionNonce: randomUUID,
      unregisterBackground: () => productionUnregisterBackground({ paths, platform, port, taskName }),
      inspectBackground: () => productionInspectBackground({ paths, platform, port, taskName }),
    },
  });
}

async function productionChooseThemeInputs() {
  try {
    const image = await execFile("/usr/bin/osascript", [
      "-e",
      'POSIX path of (choose file with prompt "选择一张皮肤主图" of type {"public.image"})',
    ]);
    const name = await execFile("/usr/bin/osascript", [
      "-e",
      'text returned of (display dialog "给皮肤起个名字" default answer "我的 Codex 皮肤")',
    ]);
    return {
      imagePath: image.stdout.trim(),
      name: name.stdout.trim(),
    };
  } catch (error) {
    if (/\(-128\)|User canceled/i.test(String(error?.stderr ?? error?.message ?? ""))) return null;
    throw error;
  }
}

function defaults(overrides, {
  paths: selectedPaths,
  platform = process.platform,
  taskName,
  installAuthorization = null,
} = {}) {
  const paths = overrides.paths ?? selectedPaths ?? resolveStudioPaths({ platform });
  const bundledThemesRoot = join(repositoryRoot, "themes");
  const roots = [bundledThemesRoot, paths.userThemesRoot];
  const queryWindowsRuntime = overrides.queryWindowsRuntime ?? ((input) =>
    queryWindowsRuntimeSnapshot({
      ...input,
      powershellPath: windowsPowerShellPath(),
      commonScriptPath: join(repositoryRoot, "scripts", "windows", "lib", "common.ps1"),
    }));
  const base = {
    bundledThemesRoot,
    userThemesRoot: paths.userThemesRoot,
    paths,
    platform,
    roots,
    home: process.env.HOME,
    nodeVersion: process.versions.node,
    loadTheme,
    listThemes,
    resolveAndLoadTheme,
    createSingleImageTheme,
    installPet,
    applySkin,
    removeSkin,
    skinStatus,
    deliverUpdateCheckResult,
    deliverThemeSelectionResult,
    readCurrentPackageVersion,
    createCachedUpdateChecker,
    readState: () => readStudioState(paths.statePath),
    preflightLifecycle: (input) => productionPreflight({
      ...input,
      platform,
      dependencies: { queryWindowsRuntime },
    }),
    queryWindowsRuntime,
    chooseThemeInputs: productionChooseThemeInputs,
  };
  const merged = { ...base, ...overrides };
  merged.roots = [merged.bundledThemesRoot, merged.userThemesRoot];
  merged.ensureState = overrides.ensureState ?? (overrides.readState
    ? async () => overrides.readState()
    : ({ themeId, preflight, keepUntilProcessExit = true }) => ensureProductionState({
      paths: merged.paths,
      themeId,
      process: preflight?.process,
      keepUntilProcessExit,
    }));
  merged.registerEphemeralController = overrides.registerEphemeralController ?? ((input) =>
    productionRegisterEphemeral({ ...input, deps: merged, paths: merged.paths }));
  merged.createController = overrides.createController ?? ((input) =>
    productionController({
      ...input,
      deps: merged,
      paths: merged.paths,
      roots: merged.roots,
      taskName: input.taskName ?? taskName,
      installAuthorization: input.installAuthorization ?? installAuthorization,
    }));
  merged.runController = overrides.runController ?? (overrides.createController
    ? (controller) => controller.start()
    : ((controller, options) => runControllerProcess(controller, {
      ...options,
      paths: merged.paths,
    })));
  merged.restartDetached = overrides.restartDetached ?? ((input) =>
    productionRestartDetached({ ...input, paths: merged.paths, platform }));
  merged.offlineDisablePersistence = overrides.offlineDisablePersistence ?? ((input) =>
    productionOfflineDisable({
      ...input,
      paths: merged.paths,
      platform,
      taskName,
    }));
  merged.migrateLegacy = overrides.migrateLegacy ?? ((input) =>
    productionMigrateLegacy({ ...input, deps: merged, paths: merged.paths, roots: merged.roots }));
  return merged;
}

async function lifecycleController(deps, input) {
  const controller = await deps.createController(input);
  if (!controller || typeof controller !== "object") throw new Error("controller 创建失败");
  return controller;
}

async function preflightWithNativeFallback(deps, input) {
  try {
    return {
      preflight: await deps.preflightLifecycle({ ...input, requirePort: true }),
      restartRequired: false,
    };
  } catch (error) {
    if (error?.code !== "CDP_NOT_OWNED") throw error;
    return {
      preflight: await deps.preflightLifecycle({ ...input, requirePort: false }),
      restartRequired: true,
    };
  }
}

async function applySelectedTheme({ deps, roots, command, port, preferStored, themeId, forceRestart = false }) {
  const bundle = await themeBundle({ deps, roots, themeId });
  const fallback = await preflightWithNativeFallback(deps, {
    command,
    port,
    themeId,
  });
  const preflight = fallback.preflight;
  // 强制重启是合成器卡死（整窗低帧率）等疑难场景的恢复入口：
  // 健康 CDP 会话下 apply 幂等不重启进程，救不了这种病，必须先退出再拉起。
  const restartRequired = forceRestart || fallback.restartRequired;
  const before = await deps.readState();
  if (restartRequired) {
    assertDirectLifecycleRestartSupported(deps.platform, command);
    const queued = await deps.restartDetached({
      launchMode: "cdp",
      port,
      preflight,
      themeId,
      afterLaunch: { command: "apply", themeId },
    });
    return {
      mode: "restarting",
      persistenceEnabled: before?.persistenceEnabled === true,
      queued: queued?.queued === true,
    };
  }
  const applied = await deps.registerEphemeralController({
    loadedTheme: bundle.loadedTheme,
    themes: bundle.menuThemes,
    port,
    preferStored,
    preflight,
    themeId,
  });
  return {
    ...applied,
    persistenceEnabled: before?.persistenceEnabled === true,
  };
}

async function withStoppedController(controller, action) {
  try {
    return await action();
  } finally {
    await controller.stop?.();
  }
}

export async function runCli(argv, overrides = {}) {
  const { args, command, positionals } = parseInvocation(argv);
  const selectedControllerPlatform = command === "controller"
    ? controllerPlatform(args.platform)
    : process.platform;
  const installAuthorization = command === "controller"
    ? null
    : parseMacosInstallAuthorization(process.env.HEIGE_MACOS_INSTALL_AUTHORIZATION);
  if (
    installAuthorization !== null &&
    (
      selectedControllerPlatform !== "darwin" ||
      command !== "set-persistence" ||
      positionals[0] !== "true"
    )
  ) {
    throw new Error("macOS install authorization is restricted to set-persistence true");
  }
  const testContext = command === "controller"
    ? null
    : windowsCliTestContext(selectedControllerPlatform);
  const selectedTaskName = command === "controller"
    ? args["task-name"]
    : testContext?.taskName;
  const selectedBackgroundIdentity = command === "controller"
    ? controllerBackgroundIdentity(selectedControllerPlatform, selectedTaskName)
    : undefined;
  const selectedPaths = command === "controller"
    ? controllerPaths({
      platform: selectedControllerPlatform,
      stateDirectory: args["state-directory"],
      taskName: selectedTaskName,
    })
    : testContext?.paths;
  const deps = defaults(overrides, {
    paths: selectedPaths,
    platform: selectedControllerPlatform,
    taskName: selectedTaskName,
    installAuthorization,
  });
  if (command === "help") {
    return {
      platform: deps.platform,
      lifecycleContract: deps.platform === "win32"
        ? "Windows 生命周期请使用 scripts/windows/apply.ps1 或 scripts/windows/apply.bat、" +
          "scripts/windows/enable-skin.ps1 或 scripts/windows/enable-skin.bat、" +
          "scripts/windows/pause.ps1、scripts/windows/resume.ps1、" +
          "scripts/windows/restore.ps1 或 scripts/windows/restore.bat，以及 " +
          "scripts/windows/close-codex.ps1 或 scripts/windows/close-codex.bat；完整卸载请使用 " +
          "scripts/windows/uninstall.ps1 或 scripts/windows/uninstall.bat"
        : "macOS 生命周期请优先使用 scripts 下对应的 .command 稳定入口",
      commands: [
        "list",
        "create --image PATH --name NAME",
        "customize [--image PATH --name NAME]",
        "apply [--theme ID] [--port 9341]",
        "enable-skin [--theme ID] [--port 9341]",
        "set-persistence false [--revision N]",
        "pause",
        "resume",
        "restore",
        "controller",
        "status",
        "doctor",
        "install-pet [--source PATH]",
      ],
    };
  }
  assertNodeVersion(deps.nodeVersion);
  const roots = deps.roots;

  if (command === "list") return deps.listThemes({ roots });
  if (command === "create") {
    if (!args.image) throw new Error("create 需要 --image");
    if (!args.name) throw new Error("create 需要 --name");
    return deps.createSingleImageTheme({
      imagePath: args.image,
      name: args.name,
      storeRoot: deps.userThemesRoot,
    });
  }
  if (command === "customize") {
    if (Boolean(args.image) !== Boolean(args.name)) {
      throw new Error("customize 的 --image 和 --name 必须同时提供");
    }
    const input = args.image
      ? { imagePath: args.image, name: args.name }
      : await deps.chooseThemeInputs();
    if (input === null) return { cancelled: true };
    const created = await deps.createSingleImageTheme({
      imagePath: input.imagePath,
      name: input.name,
      storeRoot: deps.userThemesRoot,
    });
    if (typeof created?.id !== "string") throw new Error("新主题未返回有效 ID");
    const applied = await applySelectedTheme({
      deps,
      roots,
      command: "customize",
      port: portFrom(args.port),
      preferStored: false,
      themeId: created.id,
    });
    return { created, applied };
  }
  if (command === "apply") {
    const preferStored = Boolean(args["prefer-stored"]);
    const stored = preferStored && args.theme === undefined
      ? await deps.readState()
      : null;
    const themeId = args.theme ?? stored?.lastNonNativeThemeId ?? DEFAULT_THEME_ID;
    const port = portFrom(args.port);
    return applySelectedTheme({
      deps,
      roots,
      command,
      port,
      preferStored,
      themeId,
      forceRestart: Boolean(args.restart),
    });
  }
  if (command === "enable-skin") {
    const stored = args.theme === undefined ? await deps.readState() : null;
    const themeId = args.theme ?? stored?.lastNonNativeThemeId ?? DEFAULT_THEME_ID;
    const port = portFrom(args.port);
    return applySelectedTheme({
      deps,
      roots,
      command,
      port,
      preferStored: args.theme === undefined,
      themeId,
    });
  }
  if (command === "set-persistence") {
    const enabled = exactBoolean(positionals[0]);
    if (enabled && installAuthorization === null) {
      throw new Error("常驻只能在 Codex 顶部菜单的「皮肤常驻」开关中开启；此命令仅支持 false");
    }
    const port = portFrom(args.port);
    const state = await deps.readState();
    if (state === null) {
      if (enabled) throw new Error("状态文件不存在，请先运行 apply");
      // 从未 apply 过的安装本来就是原生外观：关闭常驻应当幂等落盘，
      // 而不是要求用户先 apply 一次才准关闭。Windows 的还原流程走的正是这条路径。
      return deps.offlineDisablePersistence({ port });
    }
    const expectedRevision = revisionFrom(args.revision, state.revision);
    const { preflight, restartRequired } = enabled
      ? {
        preflight: await deps.preflightLifecycle({ command, port, requirePort: true }),
        restartRequired: false,
      }
      : await preflightWithNativeFallback(deps, { command, port });
    if (restartRequired) {
      return deps.offlineDisablePersistence({ port, expectedRevision });
    }
    const controller = await lifecycleController(deps, { port, preflight });
    return withStoppedController(controller, () => controller.setPersistence({
      expectedRevision,
      enabled,
      includeProcessIdentity: installAuthorization !== null,
    }));
  }
  if (command === "restore") {
    const port = portFrom(args.port);
    const { preflight, restartRequired } = await preflightWithNativeFallback(deps, {
      command,
      port,
    });
    if (restartRequired) {
      await deps.offlineDisablePersistence({ port });
      return {
        mode: preflight.process === null ? "closed" : "native",
        persistenceEnabled: false,
      };
    }
    assertDirectLifecycleRestartSupported(deps.platform, command);
    const controller = await lifecycleController(deps, { port, preflight });
    const result = await withStoppedController(controller, () => controller.restore());
    await deps.restartDetached({ launchMode: "native", port, preflight });
    return result;
  }
  if (command === "pause" || command === "resume") {
    const port = portFrom(args.port);
    const preflight = await deps.preflightLifecycle({ command, port, requirePort: true });
    const controller = await lifecycleController(deps, { port, preflight });
    const result = await withStoppedController(controller, () => controller[command]());
    return result;
  }
  if (command === "controller") {
    if (args.background && args.ephemeral) {
      throw new Error("controller cannot be both background and ephemeral");
    }
    const port = portFrom(args.port);
    const startupHandshake = null;
    const ephemeralLease = args.ephemeral
      ? await acquireEphemeralControllerLease(deps.paths, selectedControllerPlatform)
      : undefined;
    if (args.ephemeral && ephemeralLease === null) {
      return { action: "already-running", mode: "active" };
    }
    try {
      const controller = await lifecycleController(deps, {
        background: Boolean(args.background),
        ephemeral: Boolean(args.ephemeral),
        platform: selectedControllerPlatform,
        port,
        taskName: selectedTaskName,
        startupHandshake,
      });
      const result = await deps.runController(controller, {
        backgroundRuntime: args.background
          ? {
            platform: selectedControllerPlatform,
            backgroundIdentity: selectedBackgroundIdentity,
          }
          : null,
        ephemeralRuntime: Boolean(args.ephemeral),
        once: Boolean(args.once),
        startupHandshake,
      });
      if (result?.action === "error" || result?.mode === "error") {
        throw new Error("控制器启动或巡检失败");
      }
      return result;
    } finally {
      await ephemeralLease?.release();
    }
  }
  if (command === "status") return deps.skinStatus({ port: portFrom(args.port) });
  if (command === "install-pet") {
    return deps.installPet({
      sourceRoot: args.source ?? join(repositoryRoot, "custom-pet/miku-future"),
      home: deps.home,
    });
  }
  if (command === "doctor") {
    const selectedPort = portFrom(args.port);
    if (selectedControllerPlatform === "win32") {
      const snapshot = validateWindowsRuntimeSnapshot(
        await deps.queryWindowsRuntime({ port: selectedPort }),
      );
      const offline = snapshot.listeners.length === 0
        ? classifyWindowsPreflightSnapshot(snapshot, {
          port: selectedPort,
          requirePort: false,
        })
        : null;
      const exact = snapshot.listeners.length === 0
        ? null
        : classifyWindowsPreflightSnapshot(snapshot, {
          port: selectedPort,
          requirePort: true,
        });
      const runtime = {
        appVersion: null,
        processRunning: (offline?.process ?? exact?.process ?? null) !== null,
        processHasDebugFlag: exact !== null,
        portOpen: exact !== null,
        portBrowser: null,
      };
      return {
        platform: "win32",
        app: snapshot.app.launchTarget,
        appFound: true,
        candidates: [snapshot.app.launchTarget],
        bundledNode: snapshot.nodePath,
        bundledNodeFound: true,
        cdpPort: selectedPort,
        ...runtime,
        diagnosis: classifyInjection(runtime),
      };
    }
    const discovery = await (deps.discoverCodex ?? discoverCodex)();
    const runtime = await (deps.runtimeDiagnostics ?? runtimeDiagnostics)({
      appPath: discovery.app,
      port: selectedPort,
    });
    return {
      ...discovery,
      cdpPort: selectedPort,
      ...runtime,
      diagnosis: classifyInjection(runtime),
    };
  }
  throw new Error(`未知命令：${command}`);
}

// argv[1] 保留符号链接原路径，import.meta.url 是 realpath。先解真实路径再比较。
function isMainEntry() {
  const entry = process.argv[1];
  if (!entry) return false;
  let real = entry;
  try {
    real = realpathSync(entry);
  } catch {}
  return pathToFileURL(real).href === import.meta.url;
}

if (isMainEntry()) {
  runCli(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`HeiGe Codex Skin Studio：${error.message}\n`);
      process.exitCode = 1;
    });
}
