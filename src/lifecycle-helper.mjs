#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import { link, lstat, mkdir, open, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";

import {
  listCodexProcesses,
  parseMacPsLstartRow,
  parseMacPsTreeTable,
  sameProcessIdentity,
} from "./codex-app.mjs";
import { DEFAULT_PRODUCT_ID, productCdpLaunchSpec, profileForAppPath } from "./products.mjs";

// 生命周期动作文件里不存产品字段，一律从 appPath 反推，避免动落盘 schema
function hostProfile(appPath) {
  return profileForAppPath(appPath, { platform: "darwin" });
}

function hostExecutable(appPath) {
  return join(appPath, "Contents", "MacOS", hostProfile(appPath).macExecutableName);
}

const execFile = promisify(execFileCallback);
const ACTION_BYTES = 16 * 1024;
const ACTION_MAX_AGE_MS = 5 * 60 * 1000;
const ACTION_FUTURE_SKEW_MS = 30 * 1000;
const ACTION_KEYS = Object.freeze([
  "afterLaunch",
  "appPath",
  "createdAt",
  "launchMode",
  "nonce",
  "operation",
  "port",
  "process",
  "schemaVersion",
  "verifyPort",
]);
const PROCESS_KEYS = Object.freeze(["executablePath", "pid", "startedAt"]);
const CONTINUATION_KEYS = Object.freeze(["cliPath", "command", "nodePath", "port", "themeId"]);
const LAUNCHER_CONTINUATION_KEYS = Object.freeze([...CONTINUATION_KEYS, "launcherVersion"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const THEME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTINUATION_COMMANDS = new Set(["apply", "launcher-apply"]);
const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const LIFECYCLE_FAILURE = Symbol("heige.lifecycle.failure");
const SAFE_FAILURES = Object.freeze({
  CONTINUATION_FAILED_COMPENSATED: Object.freeze({
    code: "CONTINUATION_FAILED_COMPENSATED",
    message: "皮肤应用失败，已恢复启动前状态。",
  }),
  CONTINUATION_COMPENSATION_FAILED: Object.freeze({
    code: "CONTINUATION_COMPENSATION_FAILED",
    message: "皮肤应用失败，且未能确认已恢复启动前状态。",
  }),
  LIFECYCLE_FAILED: Object.freeze({
    code: "LIFECYCLE_FAILED",
    message: "皮肤启动流程失败。",
  }),
  RESULT_WRITE_FAILED: Object.freeze({
    code: "RESULT_WRITE_FAILED",
    message: "皮肤启动流程失败，且无法写入安全结果回执。",
  }),
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function markLifecycleFailure(error, code, compensated, details = {}) {
  const failure = SAFE_FAILURES[code] ?? SAFE_FAILURES.LIFECYCLE_FAILED;
  const target = error instanceof Error ? error : new Error(failure.message, { cause: error });
  Object.defineProperty(target, LIFECYCLE_FAILURE, {
    configurable: true,
    value: Object.freeze({
      ...failure,
      compensated: compensated === true,
      ...(typeof details.stage === "string" ? { stage: details.stage } : {}),
      ...(isRecord(details.diagnostics)
        ? { diagnostics: Object.freeze({ ...details.diagnostics }) }
        : {}),
    }),
  });
  return target;
}

function safeLifecycleFailure(error) {
  return error?.[LIFECYCLE_FAILURE] ?? Object.freeze({
    ...SAFE_FAILURES.LIFECYCLE_FAILED,
    compensated: false,
  });
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) throw new TypeError(`${label}必须是对象`);
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new TypeError(`${label}字段不完整或含未知字段`);
  }
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new TypeError(`${label}必须是绝对路径`);
  }
  const normalized = normalize(value);
  if (normalized !== value) throw new TypeError(`${label}必须是规范绝对路径`);
  return value;
}

function processIdentity(value) {
  exactKeys(value, PROCESS_KEYS, "进程身份");
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new TypeError("进程身份 pid 必须是正整数");
  }
  absolutePath(value.executablePath, "进程身份 executablePath");
  if (typeof value.startedAt !== "string" || value.startedAt.length === 0 || value.startedAt.length > 256) {
    throw new TypeError("进程身份 startedAt 无效");
  }
  return {
    pid: value.pid,
    executablePath: value.executablePath,
    startedAt: value.startedAt,
  };
}

function parseCreatedAt(value, now) {
  if (typeof value !== "string" || value.length > 64) throw new TypeError("action createdAt 无效");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError("action createdAt 无效");
  const current = now().getTime();
  if (timestamp < current - ACTION_MAX_AGE_MS || timestamp > current + ACTION_FUTURE_SKEW_MS) {
    throw new Error("lifecycle action 已过期或来自未来");
  }
  return value;
}

function continuation(value, { launchMode, port }) {
  if (value === null) return null;
  if (launchMode !== "cdp") throw new TypeError("native 重启不得携带 continuation");
  if (!isRecord(value)) throw new TypeError("afterLaunch必须是对象");
  exactKeys(
    value,
    value.command === "launcher-apply" ? LAUNCHER_CONTINUATION_KEYS : CONTINUATION_KEYS,
    "afterLaunch",
  );
  if (!CONTINUATION_COMMANDS.has(value.command)) {
    throw new TypeError("afterLaunch command 不在允许列表中");
  }
  if (
    value.command === "launcher-apply"
    && (typeof value.launcherVersion !== "string" || !STABLE_VERSION.test(value.launcherVersion))
  ) throw new TypeError("afterLaunch launcherVersion 格式无效");
  if (typeof value.themeId !== "string" || !THEME_ID.test(value.themeId)) {
    throw new TypeError("afterLaunch themeId 格式无效");
  }
  if (value.port !== port) throw new TypeError("afterLaunch 端口必须与重启端口一致");
  return Object.freeze({
    command: value.command,
    ...(value.command === "launcher-apply" ? { launcherVersion: value.launcherVersion } : {}),
    cliPath: absolutePath(value.cliPath, "afterLaunch cliPath"),
    nodePath: absolutePath(value.nodePath, "afterLaunch nodePath"),
    port: value.port,
    themeId: value.themeId,
  });
}

export function validateLifecycleAction(value, { now = () => new Date() } = {}) {
  exactKeys(value, ACTION_KEYS, "lifecycle action");
  if (value.schemaVersion !== 1 || value.operation !== "restart") {
    throw new TypeError("lifecycle action 版本或操作无效");
  }
  if (value.launchMode !== "cdp" && value.launchMode !== "native") {
    throw new TypeError("launchMode 只能是 cdp 或 native");
  }
  const identity = value.process === null ? null : processIdentity(value.process);
  const appPath = absolutePath(value.appPath, "appPath");
  if (!appPath.endsWith(".app")) throw new TypeError("appPath 必须指向 macOS 应用包");
  const expectedExecutable = hostExecutable(appPath);
  if (identity !== null && identity.executablePath !== expectedExecutable) {
    throw new TypeError(`进程身份不属于已解析的 ${hostProfile(appPath).label} 应用`);
  }
  if (value.launchMode === "cdp") {
    if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) {
      throw new TypeError("CDP 端口必须是 1024 到 65535 的整数");
    }
  } else if (value.port !== null) {
    throw new TypeError("native 重启不得携带 CDP 端口");
  }
  if (value.verifyPort !== null && (
    !Number.isInteger(value.verifyPort) || value.verifyPort < 1024 || value.verifyPort > 65535
  )) {
    throw new TypeError("verifyPort 必须是 null 或 1024 到 65535 的整数");
  }
  if (value.launchMode === "cdp" && value.verifyPort !== null) {
    throw new TypeError("CDP 重启不得携带 verifyPort");
  }
  if (typeof value.nonce !== "string" || !UUID.test(value.nonce)) {
    throw new TypeError("action nonce 必须是 UUID");
  }
  const afterLaunch = continuation(value.afterLaunch, {
    launchMode: value.launchMode,
    port: value.port,
  });
  if (identity === null && (value.launchMode !== "cdp" || afterLaunch === null)) {
    throw new TypeError("无进程身份时只允许启动 CDP 并执行经过允许的 continuation");
  }
  return Object.freeze({
    schemaVersion: 1,
    operation: "restart",
    process: identity === null ? null : Object.freeze(identity),
    appPath,
    launchMode: value.launchMode,
    port: value.port,
    verifyPort: value.verifyPort,
    createdAt: parseCreatedAt(value.createdAt, now),
    nonce: value.nonce,
    afterLaunch,
  });
}

function actionDocument(input, { now = () => new Date(), nonce = randomUUID } = {}) {
  return validateLifecycleAction({
    schemaVersion: 1,
    operation: "restart",
    process: input.process,
    appPath: input.appPath,
    launchMode: input.launchMode,
    port: input.port,
    verifyPort: input.verifyPort ?? null,
    createdAt: now().toISOString(),
    nonce: nonce(),
    afterLaunch: input.afterLaunch ?? null,
  }, { now });
}

async function syncDirectory(path) {
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertPrivateResultDirectory(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("lifecycle 结果目录必须是真实目录");
  }
  if ((info.mode & 0o700) !== 0o700 || (info.mode & 0o077) !== 0) {
    throw new Error("lifecycle 结果目录必须仅当前用户可访问");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("lifecycle 结果目录不属于当前用户");
  }
}

async function writeLifecycleResult(actionPath, action, input, { now = () => new Date() } = {}) {
  const parent = dirname(actionPath);
  await assertPrivateResultDirectory(parent);
  const resultPath = `${actionPath}.result.json`;
  const temporaryPath = `${resultPath}.${randomUUID()}.tmp`;
  const document = {
    schemaVersion: 1,
    action: {
      createdAt: action.createdAt,
      nonce: action.nonce,
      operation: action.operation,
    },
    outcome: input.outcome,
    compensated: input.compensated === true,
    error: input.error,
    ...(typeof input.stage === "string" ? { stage: input.stage } : {}),
    ...(isRecord(input.diagnostics) ? { diagnostics: input.diagnostics } : {}),
    completedAt: now().toISOString(),
  };
  const handle = await open(
    temporaryPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, resultPath);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  await syncDirectory(parent);
  return resultPath;
}

export async function writeLifecycleActionFile(actionPath, input, options = {}) {
  absolutePath(actionPath, "actionPath");
  const action = actionDocument(input, options);
  const parent = dirname(actionPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const handle = await open(
    actionPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(action)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(parent);
  return { actionPath, action };
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

async function readActionFile(actionPath, options) {
  absolutePath(actionPath, "actionPath");
  const before = await lstat(actionPath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("lifecycle action 必须是普通文件且不得是符号链接");
  }
  if ((before.mode & 0o777) !== 0o600) throw new Error("lifecycle action 权限必须是 0600");
  if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
    throw new Error("lifecycle action 不属于当前用户");
  }
  if (before.size <= 0 || before.size > ACTION_BYTES) {
    throw new Error(`lifecycle action 必须小于 ${ACTION_BYTES} bytes`);
  }
  const handle = await open(actionPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const opened = await handle.stat();
    if (!sameFile(before, opened)) throw new Error("lifecycle action 在打开期间发生变化");
    bytes = await handle.readFile();
    const afterRead = await handle.stat();
    if (!sameFile(opened, afterRead) || bytes.byteLength !== opened.size) {
      throw new Error("lifecycle action 在读取期间发生变化");
    }
  } finally {
    await handle.close();
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new Error("lifecycle action 不是有效 JSON", { cause });
  }
  const action = validateLifecycleAction(parsed, options);
  const beforeUnlink = await lstat(actionPath);
  if (!sameFile(before, beforeUnlink)) throw new Error("lifecycle action 在执行前被替换");
  await unlink(actionPath);
  await syncDirectory(dirname(actionPath));
  return action;
}

async function defaultReadProcessIdentity(pid, expected, { run = execFile } = {}) {
  let stdout;
  try {
    ({ stdout } = await run("/bin/ps", ["-p", String(pid), "-o", "pid=,lstart=,command="]));
  } catch (error) {
    if (error?.code === 1) return null;
    throw error;
  }
  const row = parseMacPsLstartRow(String(stdout).split(/\r?\n/).find(Boolean) ?? "");
  if (!row || row.pid !== pid) return null;
  const command = row.commandLine;
  const executableMatches = command === expected.executablePath ||
    command.startsWith(`${expected.executablePath} `);
  if (!executableMatches) {
    return { pid, executablePath: command.split(" ")[0], startedAt: row.startedAt };
  }
  return { pid, executablePath: expected.executablePath, startedAt: row.startedAt };
}

export async function requestNormalQuit({ process: identity }, { execFile: run = execFile } = {}) {
  const target = processIdentity(identity);
  const source = `ObjC.import("AppKit");
function run(argv) {
  const pid = Number(argv[0]);
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (!app) throw new Error("target process disappeared");
  if (!app.terminate) throw new Error("target process refused normal termination");
  return true;
}`;
  await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", source, "--", String(target.pid)]);
}

export async function launchMacosAppExecutable({ appPath, args, env = null }, {
  spawnImpl = spawn,
  baseEnv = process.env,
} = {}) {
  absolutePath(appPath, "appPath");
  const invalidValue = (value) => typeof value !== "string" || value.includes("\0") || /[\r\n]/.test(value);
  if (!Array.isArray(args) || args.some(invalidValue)) {
    throw new TypeError(`${hostProfile(appPath).label} 启动参数无效`);
  }
  // 环境变量式调试开关（WorkBuddy）：键名和值同样按参数标准过一遍，不许夹换行和空字节
  if (env !== null && (
    !isRecord(env) ||
    Object.entries(env).some(([key, value]) => invalidValue(key) || invalidValue(value) || !/^[A-Z][A-Z0-9_]*$/.test(key))
  )) {
    throw new TypeError(`${hostProfile(appPath).label} 启动环境变量无效`);
  }
  if (typeof spawnImpl !== "function") throw new TypeError("spawnImpl 必须是函数");
  const executablePath = hostExecutable(appPath);
  const child = spawnImpl(executablePath, args, {
    detached: true,
    shell: false,
    stdio: "ignore",
    ...(env === null ? {} : { env: { ...baseEnv, ...env } }),
  });
  if (!child || typeof child.once !== "function" || typeof child.unref !== "function") {
    throw new Error(`无法创建 ${hostProfile(appPath).label} 启动进程`);
  }
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    throw new Error(`${hostProfile(appPath).label} 启动进程没有有效 PID`);
  }
  child.unref();
  return { pid: child.pid };
}

async function defaultLaunchApp(input) {
  return launchMacosAppExecutable(input);
}

async function defaultWaitForPort(port) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        redirect: "error",
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return true;
    } catch {}
    await defaultWait(250);
  }
  throw new Error(`CDP 端口 ${port} 未在限定时间内就绪`);
}

async function defaultVerifyPortReleased(port) {
  try {
    const { stdout } = await execFile("/usr/sbin/lsof", [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-t",
    ]);
    return !stdout.split(/\s+/).some(Boolean);
  } catch (error) {
    if (error?.code === 1) return true;
    throw error;
  }
}

export async function verifyMacProcessOwnerTree({ rootProcess, ownerPids, run = execFile } = {}) {
  const root = processIdentity({
    pid: rootProcess?.pid,
    executablePath: rootProcess?.executablePath,
    startedAt: rootProcess?.startedAt,
  });
  if (!Array.isArray(ownerPids) || typeof run !== "function") {
    throw new TypeError("CDP listener owner verification input is invalid");
  }
  const owners = [...new Set(ownerPids)];
  if (!owners.includes(root.pid) || owners.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
    throw new Error("CDP listener owners do not include the exact Codex root process");
  }
  const { stdout } = await run("/bin/ps", ["-axo", "pid=,ppid=,lstart=,command="]);
  const rows = new Map(parseMacPsTreeTable(stdout).map((row) => [row.pid, row]));
  const rootRow = rows.get(root.pid);
  if (
    rootRow?.startedAt !== root.startedAt
    || !(rootRow.commandLine === root.executablePath || rootRow.commandLine.startsWith(`${root.executablePath} `))
  ) throw new Error("CDP root process identity changed during global owner verification");
  for (const owner of owners) {
    let pid = owner;
    const visited = new Set();
    while (pid !== root.pid) {
      if (visited.has(pid) || visited.size > 64) {
        throw new Error("CDP listener owner ancestry is cyclic or too deep");
      }
      visited.add(pid);
      const row = rows.get(pid);
      if (row === undefined || row.ppid <= 0) {
        throw new Error("CDP listener has a foreign owner outside the exact Codex process tree");
      }
      pid = row.ppid;
    }
  }
  return { exactRoot: true, ownerCount: owners.length };
}

export async function readMacCdpProcess({ appPath, port } = {}, {
  run = execFile,
  listProcesses = listCodexProcesses,
  readIdentity = null,
} = {}) {
  absolutePath(appPath, "appPath");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new TypeError("CDP 端口必须是 1024 到 65535 的整数");
  }
  const identityReader = readIdentity ?? ((pid, expected) => defaultReadProcessIdentity(pid, expected, { run }));
  if (![run, listProcesses, identityReader].every((value) => typeof value === "function")) {
    throw new TypeError("CDP 进程读取依赖必须是函数");
  }
  const { stdout } = await run("/usr/sbin/lsof", [
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-t",
  ]);
  const tokens = String(stdout).split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.some((token) => !/^[1-9]\d*$/.test(token))) {
    throw new Error(`CDP 端口 ${port} 的监听进程无效`);
  }
  const ownerPids = [...new Set(tokens.map(Number))];
  if (ownerPids.some((pid) => !Number.isSafeInteger(pid))) {
    throw new Error(`CDP 端口 ${port} 的监听进程无效`);
  }
  const profile = hostProfile(appPath);
  const executablePath = hostExecutable(appPath);
  const processes = await listProcesses({ app: { executablePath }, exec: run, product: profile.id });
  if (!Array.isArray(processes)) throw new Error(`${profile.label} 进程列表无效`);
  const candidates = processes.filter((candidate) => (
    candidate?.executablePath === executablePath
    // 端口在命令行里看得见就必须对上；看不见的产品（WorkBuddy 走环境变量）
    // 由 lsof 的端口归属认人，此时 cdpPort 只能是 null，不接受任何其他值
    && (profile.cdpPortVisibleInArgs ? candidate.cdpPort === port : candidate.cdpPort === null)
    && ownerPids.includes(candidate.pid)
  ));
  if (candidates.length !== 1) {
    throw new Error(`CDP 端口 ${port} 的 ${hostProfile(appPath).label} 根进程不唯一`);
  }
  const expected = processIdentity({
    pid: candidates[0].pid,
    executablePath,
    startedAt: candidates[0].startedAt,
  });
  await verifyMacProcessOwnerTree({ rootProcess: expected, ownerPids, run });
  const observed = await identityReader(expected.pid, expected);
  if (!sameProcessIdentity(observed, expected)) {
    throw new Error(`CDP 端口 ${port} 的 ${hostProfile(appPath).label} 根进程身份已变化`);
  }
  return processIdentity({
    pid: observed.pid,
    executablePath: observed.executablePath,
    startedAt: observed.startedAt,
  });
}

async function defaultReadAppProcesses({ appPath }) {
  return listCodexProcesses({
    app: { executablePath: hostExecutable(appPath) },
    product: hostProfile(appPath).id,
  });
}

async function restoreContinuationPrestate(action, {
  readProcessIdentity,
  requestQuit,
  launchApp,
  wait,
  readCdpProcess,
  readAppProcesses,
  verifyPortReleased,
  maxWaitAttempts,
  waitIntervalMs,
}) {
  const launched = processIdentity(await readCdpProcess({
    appPath: action.appPath,
    port: action.port,
  }));
  const expectedExecutable = hostExecutable(action.appPath);
  if (launched.executablePath !== expectedExecutable) {
    throw new Error(`新启动的 CDP 进程不属于已解析的 ${hostProfile(action.appPath).label} 应用`);
  }
  const beforeQuit = await readProcessIdentity(launched.pid, launched);
  if (!sameProcessIdentity(beforeQuit, launched)) {
    throw new Error("新启动的 CDP 进程身份在退出前已变化");
  }
  await requestQuit({ appPath: action.appPath, process: launched });
  let disappeared = false;
  for (let attempt = 0; attempt < maxWaitAttempts; attempt += 1) {
    const current = await readProcessIdentity(launched.pid, launched);
    if (!sameProcessIdentity(current, launched)) {
      disappeared = true;
      break;
    }
    await wait(waitIntervalMs);
  }
  if (!disappeared) throw new Error("补偿失败：Codex CDP 进程未正常退出");
  let portReleased = false;
  for (let attempt = 0; attempt < maxWaitAttempts; attempt += 1) {
    portReleased = await verifyPortReleased(action.port);
    if (portReleased) break;
    await wait(waitIntervalMs);
  }
  if (!portReleased) {
    throw new Error(`补偿失败：CDP 端口 ${action.port} 仍被占用`);
  }
  if (action.process !== null) await launchApp({ appPath: action.appPath, args: [] });

  let restored = false;
  for (let attempt = 0; attempt < maxWaitAttempts; attempt += 1) {
    const processes = await readAppProcesses({ appPath: action.appPath });
    if (!Array.isArray(processes)) throw new Error("补偿进程查询结果无效");
    restored = action.process === null
      ? processes.length === 0
      : processes.length === 1 &&
        processes[0]?.executablePath === expectedExecutable &&
        processes[0]?.hasCdp === false &&
        processes[0]?.cdpPort === null;
    if (restored) break;
    await wait(waitIntervalMs);
  }
  if (!restored || !(await verifyPortReleased(action.port))) {
    const mode = action.process === null ? "closed" : "native";
    throw new Error(`补偿失败：未能确认恢复 ${mode} 前态`);
  }
}

async function defaultRunAfterLaunch(input) {
  const localCli = join(dirname(fileURLToPath(import.meta.url)), "cli.mjs");
  const [realNode, currentNode, realCli, currentCli] = [
    input.nodePath,
    process.execPath,
    input.cliPath,
    localCli,
  ].map((path) => realpathSync(path));
  if (realNode !== currentNode || realCli !== currentCli) {
    throw new Error("afterLaunch 运行时或 CLI 不属于当前稳定安装");
  }
  // 产品从 appPath 反推（动作文件不存产品字段）。不带 --app 的话续作按 Codex
  // 跑 preflight，WorkBuddy 重启后的 apply 会因「端口不属于目标 Codex」失败并触发补偿回滚。
  const productId = hostProfile(input.appPath).id;
  await execFile(input.nodePath, [
    input.cliPath,
    input.command,
    ...(productId === DEFAULT_PRODUCT_ID ? [] : ["--app", productId]),
    ...(input.command === "launcher-apply"
      ? ["--launcher-version", input.launcherVersion]
      : []),
    "--theme",
    input.themeId,
    "--port",
    String(input.port),
  ]);
  return true;
}

function defaultWait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function executeLifecycleActionCore(action, deps, progress) {
  const readProcessIdentity = deps.readProcessIdentity ?? defaultReadProcessIdentity;
  const requestQuit = deps.requestQuit ?? requestNormalQuit;
  const launchApp = deps.launchApp ?? defaultLaunchApp;
  const wait = deps.wait ?? defaultWait;
  const waitForPort = deps.waitForPort ?? defaultWaitForPort;
  const runAfterLaunch = deps.runAfterLaunch ?? defaultRunAfterLaunch;
  const verifyPortReleased = deps.verifyPortReleased ?? defaultVerifyPortReleased;
  const readCdpProcess = deps.readCdpProcess ?? readMacCdpProcess;
  const readAppProcesses = deps.readAppProcesses ?? defaultReadAppProcesses;
  const maxWaitAttempts = deps.maxWaitAttempts ?? 120;
  const waitIntervalMs = deps.waitIntervalMs ?? 250;
  if (![readProcessIdentity, requestQuit, launchApp, wait, waitForPort, runAfterLaunch,
    verifyPortReleased, readCdpProcess, readAppProcesses]
    .every((value) => typeof value === "function")) {
    throw new TypeError("lifecycle helper dependencies must be functions");
  }
  if (!Number.isInteger(maxWaitAttempts) || maxWaitAttempts < 1 || maxWaitAttempts > 1200) {
    throw new TypeError("maxWaitAttempts 无效");
  }

  if (action.process !== null) {
    const observed = await readProcessIdentity(action.process.pid, action.process);
    if (!sameProcessIdentity(observed, action.process)) {
      throw new Error(`记录的 ${hostProfile(action.appPath).label} 进程身份已变化，拒绝退出或启动`);
    }
    progress.stage = "quit-requested";
    await requestQuit({ appPath: action.appPath, process: action.process });
    let disappeared = false;
    for (let attempt = 0; attempt < maxWaitAttempts; attempt += 1) {
      const current = await readProcessIdentity(action.process.pid, action.process);
      if (!sameProcessIdentity(current, action.process)) {
        disappeared = true;
        break;
      }
      await wait(waitIntervalMs);
    }
    if (!disappeared) {
      throw new Error(`${hostProfile(action.appPath).label} 未正常退出，拒绝强制终止或启动第二个实例`);
    }
    progress.oldProcessExited = true;
    progress.stage = "old-process-exited";
  }

  // Codex 走命令行参数开调试端口，WorkBuddy 走环境变量，具体由产品档案决定
  const launchSpec = action.launchMode === "cdp"
    ? productCdpLaunchSpec(hostProfile(action.appPath).id, action.port)
    : { args: [], env: {} };
  progress.stage = "launch-starting";
  await launchApp({
    appPath: action.appPath,
    args: launchSpec.args,
    // 没有环境变量要设就整个字段不带，Codex 侧的启动调用保持原样
    ...(Object.keys(launchSpec.env).length > 0 ? { env: launchSpec.env } : {}),
  });
  progress.launchStarted = true;
  progress.stage = "launch-started";
  const result = {
    launchMode: action.launchMode,
    port: action.port,
    restarted: true,
  };
  if (action.launchMode === "cdp") {
    await waitForPort(action.port);
    progress.portReady = true;
    progress.stage = "port-ready";
    const launched = processIdentity(await readCdpProcess({
      appPath: action.appPath,
      port: action.port,
    }));
    const expectedExecutable = hostExecutable(action.appPath);
    if (launched.executablePath !== expectedExecutable) {
      throw new Error(`新启动的 CDP 进程不属于已解析的 ${hostProfile(action.appPath).label} 应用`);
    }
    progress.processVerified = true;
    progress.stage = "process-verified";
  }
  if (action.afterLaunch !== null) {
    try {
      progress.continuationStarted = true;
      progress.stage = "renderer-applying";
      // appPath 随动作传入而非落盘在 afterLaunch 里：产品身份由它反推
      await runAfterLaunch({ ...action.afterLaunch, appPath: action.appPath });
      progress.stage = "renderer-applied";
    } catch (continuationError) {
      try {
        progress.compensationAttempted = true;
        progress.stage = "compensating";
        await restoreContinuationPrestate(action, {
          readProcessIdentity,
          requestQuit,
          launchApp,
          wait,
          readCdpProcess,
          readAppProcesses,
          verifyPortReleased,
          maxWaitAttempts,
          waitIntervalMs,
        });
        progress.stage = "compensated";
      } catch (compensationError) {
        throw markLifecycleFailure(new AggregateError(
          [continuationError, compensationError],
          `afterLaunch 失败且未能恢复启动前状态：${continuationError.message}；补偿错误：${compensationError.message}`,
        ), "CONTINUATION_COMPENSATION_FAILED", false);
      }
      throw markLifecycleFailure(continuationError, "CONTINUATION_FAILED_COMPENSATED", true);
    }
    result.continuation = action.afterLaunch.command;
  }
  if (action.verifyPort !== null) {
    if (!(await verifyPortReleased(action.verifyPort))) {
      throw new Error(`CDP 端口 ${action.verifyPort} 仍被占用`);
    }
    result.verifiedPortReleased = action.verifyPort;
    progress.stage = "port-released";
  }
  progress.stage = "completed";
  return result;
}

function boundedLifecycleDiagnostics(progress) {
  return {
    launchMode: progress.launchMode,
    hadOriginalProcess: progress.hadOriginalProcess,
    oldProcessExited: progress.oldProcessExited,
    launchStarted: progress.launchStarted,
    portReady: progress.portReady,
    processVerified: progress.processVerified,
    continuationStarted: progress.continuationStarted,
    compensationAttempted: progress.compensationAttempted,
  };
}

async function executeLifecycleAction(action, deps = {}) {
  const progress = {
    stage: "preflight",
    launchMode: action.launchMode,
    hadOriginalProcess: action.process !== null,
    oldProcessExited: action.process === null,
    launchStarted: false,
    portReady: false,
    processVerified: false,
    continuationStarted: false,
    compensationAttempted: false,
  };
  try {
    return await executeLifecycleActionCore(action, deps, progress);
  } catch (error) {
    const failure = safeLifecycleFailure(error);
    throw markLifecycleFailure(error, failure.code, failure.compensated, {
      stage: progress.stage,
      diagnostics: boundedLifecycleDiagnostics(progress),
    });
  }
}

export async function runLifecycleActionFile(actionPath, deps = {}) {
  const now = deps.now ?? (() => new Date());
  const action = await readActionFile(actionPath, { now });
  try {
    const result = await executeLifecycleAction(action, deps);
    await writeLifecycleResult(actionPath, action, {
      outcome: "succeeded",
      compensated: false,
      error: null,
    }, { now });
    return result;
  } catch (error) {
    const lifecycleError = error?.[LIFECYCLE_FAILURE]
      ? error
      : markLifecycleFailure(error, "LIFECYCLE_FAILED", false);
    const failure = safeLifecycleFailure(lifecycleError);
    try {
      await writeLifecycleResult(actionPath, action, {
        outcome: "failed",
        compensated: failure.compensated,
        error: { code: failure.code, message: failure.message },
        stage: failure.stage,
        diagnostics: failure.diagnostics,
      }, { now });
    } catch (resultError) {
      throw markLifecycleFailure(new AggregateError(
        [lifecycleError, resultError],
        "lifecycle 失败且无法写入安全结果回执",
      ), "RESULT_WRITE_FAILED", failure.compensated);
    }
    throw lifecycleError;
  }
}

export async function spawnDetachedLifecycle({
  nodePath,
  helperPath,
  actionPath,
  spawnImpl = spawn,
} = {}) {
  absolutePath(nodePath, "nodePath");
  absolutePath(helperPath, "helperPath");
  absolutePath(actionPath, "actionPath");
  if (typeof spawnImpl !== "function") throw new TypeError("spawnImpl 必须是函数");
  const child = spawnImpl(nodePath, [helperPath, actionPath], {
    detached: true,
    stdio: "ignore",
  });
  if (!child || typeof child.once !== "function" || typeof child.unref !== "function") {
    throw new Error("无法创建 detached lifecycle helper");
  }
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    throw new Error("无法创建 detached lifecycle helper");
  }
  child.unref();
  return { queued: true };
}

export async function showLifecycleFailureDialog(error, { execFile: run = execFile } = {}) {
  if (typeof run !== "function") throw new TypeError("dialog execFile 必须是函数");
  const failure = safeLifecycleFailure(error);
  const source = `function run(argv) {
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  app.displayDialog(argv[0], {
    withTitle: argv[1],
    buttons: ["好"],
    defaultButton: "好"
  });
}`;
  await run("/usr/bin/osascript", [
    "-l",
    "JavaScript",
    "-e",
    source,
    "--",
    failure.message,
    "HeiGe 皮肤启动器",
  ]);
}

export async function runLifecycleMain(actionPath, {
  runAction = runLifecycleActionFile,
  showDialog = showLifecycleFailureDialog,
} = {}) {
  if (typeof runAction !== "function" || typeof showDialog !== "function") {
    throw new TypeError("lifecycle main dependencies must be functions");
  }
  try {
    return await runAction(actionPath);
  } catch (error) {
    await showDialog(error).catch(() => {});
    throw error;
  }
}

function isMainEntry() {
  return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isMainEntry()) {
  if (process.argv.length !== 3) {
    process.stderr.write("用法：lifecycle-helper.mjs /absolute/path/to/action.json\n");
    process.exitCode = 64;
  } else {
    runLifecycleMain(process.argv[2]).catch((error) => {
      const failure = safeLifecycleFailure(error);
      process.stderr.write(`HeiGe lifecycle helper [${failure.code}]：${failure.message}\n`);
      process.exitCode = 1;
    });
  }
}
