import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  sep,
} from "node:path";
import { promisify } from "node:util";

import { resolveCodexApp } from "./codex-app.mjs";
import { readMacCdpProcess, requestNormalQuit } from "./lifecycle-helper.mjs";
import { inspectLaunchAgent } from "./macos-launch-agent.mjs";
import { ensureMacosStateRoot } from "./macos-state-root.mjs";
import { acquireOperationLock } from "./operation-lock.mjs";
import {
  readProcessIdentity as readExactProcessIdentity,
  sameProcessIdentity,
} from "./process-identity.mjs";
import { readStudioState } from "./state-store.mjs";
import { loadTheme } from "./theme-schema.mjs";

const execFile = promisify(execFileCallback);
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const MAX_LOCK_BYTES = 64 * 1024;
const MAX_QUIESCE_ATTEMPTS = 120;
const LOCK_RETRY_DELAYS_MS = [100, 200, 400, 800, 1600, 3200];
const TRANSIENT_LOCK_CODES = new Set([
  "LOCK_HELD",
  "LOCK_MALFORMED",
  "LOCK_PERMISSIONS",
  "LOCK_DISAPPEARED",
]);
const THEME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NONCE = /^[A-Za-z0-9_-]{1,128}$/;
const OWNER_KEYS = [
  "createdAt",
  "heartbeat",
  "nonce",
  "operation",
  "pid",
  "predecessor",
  "schemaVersion",
  "startedAt",
].sort();

function recoveryError(code, message, cause = undefined) {
  const error = new Error(
    `${code}: ${message}`,
    cause === undefined ? undefined : { cause },
  );
  error.code = code;
  return error;
}

function canonicalAbsolute(path, label) {
  if (
    typeof path !== "string"
    || !isAbsolute(path)
    || normalize(path) !== path
    || path.includes("\0")
  ) throw recoveryError("LOCK_RECOVERY_PATH_INVALID", `${label} 必须是规范绝对路径`);
  return path;
}

function pathSegments(path) {
  const root = parse(path).root;
  const output = [];
  let current = root;
  for (const component of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    output.push(current);
  }
  return output;
}

function currentUid() {
  if (typeof process.getuid !== "function") {
    throw recoveryError("LOCK_RECOVERY_PLATFORM_UNSUPPORTED", "锁链恢复只支持 macOS 当前用户");
  }
  const uid = process.getuid();
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw recoveryError("LOCK_RECOVERY_OWNER_INVALID", "无法读取当前用户 UID");
  }
  return uid;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertNoSymlinkAncestors(path) {
  for (const current of pathSegments(path)) {
    const info = await lstat(current, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw recoveryError(
        "LOCK_RECOVERY_PATH_UNTRUSTED",
        `恢复路径祖先必须是真实目录且不得是符号链接：${current}`,
      );
    }
  }
}

async function requireOwnedDirectory(path, label) {
  path = canonicalAbsolute(path, label);
  await assertNoSymlinkAncestors(dirname(path));
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw recoveryError("LOCK_RECOVERY_PATH_UNTRUSTED", `${label} 必须是真实目录`);
  }
  if (info.uid !== BigInt(currentUid())) {
    throw recoveryError("LOCK_RECOVERY_OWNER_INVALID", `${label} 不属于当前用户`);
  }
  if (await realpath(path) !== path) {
    throw recoveryError("LOCK_RECOVERY_PATH_UNTRUSTED", `${label} 不是规范真实路径`);
  }
  return info;
}

async function pathInfo(path) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

async function readPrivateJson(path, label) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile()
      || before.uid !== BigInt(currentUid())
      || (Number(before.mode) & 0o777) !== PRIVATE_FILE_MODE
      || before.size <= 0n
      || before.size > BigInt(MAX_LOCK_BYTES)
    ) throw recoveryError("LOCK_RECOVERY_ARTIFACT_UNTRUSTED", `${label} 不是 mode 0600 私有文件`);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameFile(before, after) || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw recoveryError("LOCK_RECOVERY_ARTIFACT_CHANGED", `${label} 在读取期间发生变化`);
    }
    let value;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch (cause) {
      throw recoveryError("LOCK_RECOVERY_ARTIFACT_UNTRUSTED", `${label} JSON 无效`, cause);
    }
    return value;
  } finally {
    await handle.close();
  }
}

function validateClaim(value, label) {
  if (
    !exactKeys(value, OWNER_KEYS)
    || value.schemaVersion !== 2
    || typeof value.nonce !== "string"
    || !NONCE.test(value.nonce)
    || !Number.isSafeInteger(value.pid)
    || value.pid <= 0
    || typeof value.startedAt !== "string"
    || value.startedAt.length === 0
    || value.startedAt.length > 256
    || typeof value.operation !== "string"
    || value.operation.length === 0
  ) throw recoveryError("LOCK_RECOVERY_ARTIFACT_UNTRUSTED", `${label} claim schema 无效`);
  if (value.predecessor !== null && (
    !exactKeys(value.predecessor, ["dev", "ino", "nonce"])
    || typeof value.predecessor.dev !== "string"
    || value.predecessor.dev.length === 0
    || typeof value.predecessor.ino !== "string"
    || value.predecessor.ino.length === 0
    || typeof value.predecessor.nonce !== "string"
    || !NONCE.test(value.predecessor.nonce)
  )) throw recoveryError("LOCK_RECOVERY_ARTIFACT_UNTRUSTED", `${label} predecessor schema 无效`);
  return value;
}

async function assertLockClaimsAreDead(stateRoot, lockPath, readProcessIdentity) {
  const base = lockPath.slice(stateRoot.length + 1);
  const names = (await readdir(stateRoot)).filter((name) => (
    name === base
    || name.startsWith(`${base}.successor.`)
    || name.startsWith(`${base}.staging.`)
    || name.startsWith(`${base}.checkpoint.`)
  ));
  if (names.length === 0) {
    throw recoveryError("LOCK_RECOVERY_ARTIFACT_UNTRUSTED", "损坏状态根中没有 owner claim");
  }
  for (const name of names.sort()) {
    const path = join(stateRoot, name);
    const info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink() || !info.isFile()) {
      throw recoveryError("LOCK_RECOVERY_ARTIFACT_UNTRUSTED", `${name} 不是 regular file`);
    }
    const owner = validateClaim(await readPrivateJson(path, name), name);
    const observed = await readProcessIdentity(owner.pid);
    if (sameProcessIdentity(observed, owner)) {
      throw recoveryError(
        "LOCK_RECOVERY_ACTIVE_OWNER",
        `operation ${owner.operation} 仍由活动 PID ${owner.pid} 持有`,
      );
    }
  }
}

async function defaultInspectPort({ port }) {
  let stdout;
  try {
    ({ stdout } = await execFile("/usr/sbin/lsof", [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-t",
    ], { timeout: 5_000, maxBuffer: 64 * 1024 }));
  } catch (error) {
    if (error?.code === 1) return { kind: "free" };
    throw recoveryError("LOCK_RECOVERY_PORT_PROBE_FAILED", `无法检查 CDP 端口 ${port}`, error);
  }
  const pids = [...new Set(String(stdout).split(/\s+/).filter(Boolean).map(Number))];
  if (pids.length === 0) return { kind: "free" };
  try {
    const app = await resolveCodexApp({ platform: "darwin", product: "codex" });
    const processIdentity = await readMacCdpProcess({ appPath: app.appPath, port });
    return { kind: "official", process: processIdentity, pids };
  } catch {
    return { kind: "foreign", pids };
  }
}

async function defaultListRelatedProcesses() {
  const { stdout } = await execFile("/bin/ps", ["-axo", "pid=,command="], {
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const output = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const commandLine = match[2];
    if (pid === process.pid) continue;
    if (
      commandLine.includes("src/lifecycle-helper.mjs")
      || /src\/cli\.mjs\s+controller(?:\s|$)/.test(commandLine)
    ) output.push({ pid, commandLine });
  }
  return output;
}

function normalizedDependencies(overrides = {}) {
  const dependencies = {
    acquireLock: overrides.acquireLock,
    inspectLaunchAgent: overrides.inspectLaunchAgent ?? inspectLaunchAgent,
    inspectPort: overrides.inspectPort ?? defaultInspectPort,
    listRelatedProcesses: overrides.listRelatedProcesses ?? defaultListRelatedProcesses,
    loadTheme: overrides.loadTheme ?? loadTheme,
    now: overrides.now ?? (() => new Date()),
    randomUUID: overrides.randomUUID ?? randomUUID,
    readProcessIdentity: overrides.readProcessIdentity
      ?? ((pid) => readExactProcessIdentity(pid, { platform: "darwin" })),
    readState: overrides.readState ?? readStudioState,
    requestQuit: overrides.requestQuit ?? requestNormalQuit,
    wait: overrides.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  };
  for (const name of [
    "inspectLaunchAgent",
    "inspectPort",
    "listRelatedProcesses",
    "loadTheme",
    "now",
    "randomUUID",
    "readProcessIdentity",
    "readState",
    "requestQuit",
    "wait",
  ]) {
    if (typeof dependencies[name] !== "function") {
      throw new TypeError(`launcher recovery dependency ${name} must be a function`);
    }
  }
  if (dependencies.acquireLock !== undefined && typeof dependencies.acquireLock !== "function") {
    throw new TypeError("launcher recovery dependency acquireLock must be a function");
  }
  return dependencies;
}

async function assertAgentInactive(deps) {
  const agent = await deps.inspectLaunchAgent();
  if (agent?.loaded === true) {
    throw recoveryError("LOCK_RECOVERY_ACTIVE_AGENT", "皮肤常驻 LaunchAgent 仍在运行");
  }
}

async function assertRelatedProcessesInactive(deps, context) {
  const related = await deps.listRelatedProcesses(context);
  if (!Array.isArray(related)) {
    throw recoveryError("LOCK_RECOVERY_PROCESS_PROBE_FAILED", "相关进程检查结果无效");
  }
  if (related.length > 0) {
    const pids = related
      .map((entry) => entry?.pid)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
      .slice(0, 8)
      .join(", ");
    throw recoveryError(
      "LOCK_RECOVERY_ACTIVE_PROCESS",
      `仍有 lifecycle helper 或 controller 运行${pids ? `：${pids}` : ""}`,
    );
  }
}

async function quiesceOfficialPort(deps, { port }) {
  const observed = await deps.inspectPort({ port });
  if (observed?.kind === "free") return;
  if (observed?.kind !== "official" || observed.process === null || observed.process === undefined) {
    throw recoveryError(
      "LOCK_RECOVERY_FOREIGN_LISTENER",
      `CDP 端口 ${port} 由非官方 Codex 进程占用`,
    );
  }
  const processIdentity = observed.process;
  await deps.requestQuit({ process: processIdentity });
  for (let attempt = 0; attempt < MAX_QUIESCE_ATTEMPTS; attempt += 1) {
    const [current, portState] = await Promise.all([
      deps.readProcessIdentity(processIdentity.pid),
      deps.inspectPort({ port }),
    ]);
    if (!sameProcessIdentity(current, processIdentity) && portState?.kind === "free") return;
    if (portState?.kind === "foreign") {
      throw recoveryError(
        "LOCK_RECOVERY_FOREIGN_LISTENER",
        `Codex 退出后 CDP 端口 ${port} 被其他进程占用`,
      );
    }
    await deps.wait(250);
  }
  throw recoveryError("LOCK_RECOVERY_QUIESCE_TIMEOUT", "官方 Codex 或 CDP 端口未在 30 秒内退出");
}

async function assertPortFree(deps, port) {
  const state = await deps.inspectPort({ port });
  if (state?.kind === "free") return;
  throw recoveryError(
    state?.kind === "official"
      ? "LOCK_RECOVERY_ACTIVE_PROCESS"
      : "LOCK_RECOVERY_FOREIGN_LISTENER",
    `恢复提交前 CDP 端口 ${port} 不再空闲`,
  );
}

async function inspectTopLevelForSymlinks(stateRoot) {
  for (const entry of await readdir(stateRoot, { withFileTypes: true })) {
    const info = await lstat(join(stateRoot, entry.name), { bigint: true });
    if (info.isSymbolicLink()) {
      throw recoveryError(
        "LOCK_RECOVERY_PATH_UNTRUSTED",
        `状态根含有符号链接，拒绝恢复：${entry.name}`,
      );
    }
    if (info.uid !== BigInt(currentUid())) {
      throw recoveryError(
        "LOCK_RECOVERY_OWNER_INVALID",
        `状态根条目不属于当前用户：${entry.name}`,
      );
    }
  }
}

async function themeTree(root) {
  const files = new Set();
  const directories = new Set();
  async function walk(current, prefix = "") {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const relativePath = prefix ? join(prefix, entry.name) : entry.name;
      const info = await lstat(path, { bigint: true });
      if (info.isSymbolicLink() || info.uid !== BigInt(currentUid())) {
        throw recoveryError("LOCK_RECOVERY_THEME_INVALID", `用户主题路径不可信：${relativePath}`);
      }
      if (info.isDirectory()) {
        directories.add(relativePath);
        await walk(path, relativePath);
      } else if (info.isFile()) {
        files.add(relativePath);
      } else {
        throw recoveryError("LOCK_RECOVERY_THEME_INVALID", `用户主题含不支持的条目：${relativePath}`);
      }
    }
  }
  await walk(root);
  return { directories, files };
}

function expectedThemeTree(manifest) {
  const files = new Set(["theme.json", manifest.hero]);
  if (manifest.logo) files.add(manifest.logo);
  if (manifest.polaroid) files.add(manifest.polaroid);
  const directories = new Set();
  for (const file of files) {
    let parent = dirname(file);
    while (parent !== ".") {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  return { directories, files };
}

function sameStringSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

async function validateUserThemes(userThemesRoot, deps) {
  const info = await pathInfo(userThemesRoot);
  if (info === null) return [];
  await requireOwnedDirectory(userThemesRoot, "用户主题目录");
  const themes = [];
  for (const entry of await readdir(userThemesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !THEME_ID.test(entry.name)) {
      throw recoveryError("LOCK_RECOVERY_THEME_INVALID", `用户主题目录项无效：${entry.name}`);
    }
    const root = join(userThemesRoot, entry.name);
    await requireOwnedDirectory(root, `用户主题 ${entry.name}`);
    let loaded;
    try {
      loaded = await deps.loadTheme(root);
    } catch (cause) {
      throw recoveryError("LOCK_RECOVERY_THEME_INVALID", `用户主题 ${entry.name} 校验失败`, cause);
    }
    if (loaded.manifest.id !== entry.name) {
      throw recoveryError("LOCK_RECOVERY_THEME_INVALID", `用户主题 ${entry.name} 身份不匹配`);
    }
    const actual = await themeTree(root);
    const expected = expectedThemeTree(loaded.manifest);
    if (
      !sameStringSet(actual.files, expected.files)
      || !sameStringSet(actual.directories, expected.directories)
    ) throw recoveryError("LOCK_RECOVERY_THEME_INVALID", `用户主题 ${entry.name} 含额外内容`);
    themes.push(loaded);
  }
  return themes;
}

async function syncDirectory(path) {
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writePrivateFile(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const handle = await open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
    PRIVATE_FILE_MODE,
  );
  try {
    await handle.writeFile(bytes);
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function restoreValidatedState(stateRoot, state, themes, deps) {
  if (state !== null) {
    await writePrivateFile(
      join(stateRoot, "state.json"),
      Buffer.from(`${JSON.stringify(state)}\n`, "utf8"),
    );
  }
  if (themes.length > 0) {
    const themesRoot = join(stateRoot, "themes");
    await mkdir(themesRoot, { mode: PRIVATE_DIRECTORY_MODE });
    await chmod(themesRoot, PRIVATE_DIRECTORY_MODE);
    for (const theme of themes) {
      const target = join(themesRoot, theme.manifest.id);
      await mkdir(target, { mode: PRIVATE_DIRECTORY_MODE });
      await chmod(target, PRIVATE_DIRECTORY_MODE);
      await writePrivateFile(
        join(target, "theme.json"),
        Buffer.from(`${JSON.stringify(theme.manifest, null, 2)}\n`, "utf8"),
      );
      for (const [field, buffer] of [
        ["hero", theme.assetBuffers.hero],
        ["logo", theme.assetBuffers.logo],
        ["polaroid", theme.assetBuffers.polaroid],
      ]) {
        const relativePath = theme.manifest[field];
        if (relativePath === undefined || relativePath === null) continue;
        await writePrivateFile(join(target, relativePath), buffer);
      }
      for (const path of pathSegments(target).filter((path) => path.startsWith(target))) {
        await chmod(path, PRIVATE_DIRECTORY_MODE);
      }
      await syncDirectory(target);
      const copied = await deps.loadTheme(target);
      if (
        JSON.stringify(copied.manifest) !== JSON.stringify(theme.manifest)
        || !copied.assetBuffers.hero.equals(theme.assetBuffers.hero)
        || Boolean(copied.assetBuffers.logo) !== Boolean(theme.assetBuffers.logo)
        || (copied.assetBuffers.logo && !copied.assetBuffers.logo.equals(theme.assetBuffers.logo))
        || Boolean(copied.assetBuffers.polaroid) !== Boolean(theme.assetBuffers.polaroid)
        || (copied.assetBuffers.polaroid
          && !copied.assetBuffers.polaroid.equals(theme.assetBuffers.polaroid))
      ) throw recoveryError("LOCK_RECOVERY_COPY_VERIFY_FAILED", `用户主题 ${theme.manifest.id} 回读不一致`);
    }
    await syncDirectory(themesRoot);
  }
  if (state !== null) {
    const copiedState = await deps.readState(join(stateRoot, "state.json"));
    if (JSON.stringify(copiedState) !== JSON.stringify(state)) {
      throw recoveryError("LOCK_RECOVERY_COPY_VERIFY_FAILED", "state.json 回读不一致");
    }
  }
  await syncDirectory(stateRoot);
}

function backupTimestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw recoveryError("LOCK_RECOVERY_CLOCK_INVALID", "恢复时间无效");
  }
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function uniqueBackupPath(stateRoot, deps) {
  const base = `${stateRoot}.corrupt-lock-backup-${backupTimestamp(deps.now)}`;
  if (await pathInfo(base) === null) return base;
  const nonce = deps.randomUUID();
  if (typeof nonce !== "string" || !/^[0-9a-f-]{36}$/i.test(nonce)) {
    throw recoveryError("LOCK_RECOVERY_NONCE_INVALID", "恢复备份 nonce 无效");
  }
  const candidate = `${base}.${nonce}`;
  if (await pathInfo(candidate) !== null) {
    throw recoveryError("LOCK_RECOVERY_BACKUP_EXISTS", "恢复备份路径已存在");
  }
  return candidate;
}

async function rollbackMovedRoot({ stateRoot, backupPath, createdIdentity }) {
  const current = await pathInfo(stateRoot);
  if (current !== null) {
    if (!sameFile(current, createdIdentity) || current.isSymbolicLink() || !current.isDirectory()) {
      throw recoveryError("LOCK_RECOVERY_ROLLBACK_UNSAFE", "新状态根身份已变化，拒绝递归删除");
    }
    await rm(stateRoot, { recursive: true, force: false });
  }
  if (await pathInfo(backupPath) === null) {
    throw recoveryError("LOCK_RECOVERY_ROLLBACK_UNSAFE", "原状态根备份已消失");
  }
  await rename(backupPath, stateRoot);
  await syncDirectory(dirname(stateRoot));
}

export async function recoverStaticLauncherStateRoot({
  stateRoot,
  installRoot,
  port,
  triggerCode = "LOCK_CHAIN_CORRUPT",
  dependencies = {},
} = {}) {
  if (triggerCode !== "LOCK_CHAIN_CORRUPT") {
    throw recoveryError(
      "LOCK_RECOVERY_TRIGGER_INVALID",
      "自动恢复只接受精确的 LOCK_CHAIN_CORRUPT",
    );
  }
  stateRoot = canonicalAbsolute(stateRoot, "stateRoot");
  installRoot = canonicalAbsolute(installRoot, "installRoot");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw recoveryError("LOCK_RECOVERY_PORT_INVALID", "CDP 端口无效");
  }
  const deps = normalizedDependencies(dependencies);
  const lockPath = join(stateRoot, "operation.lock");
  await requireOwnedDirectory(stateRoot, "stateRoot");
  await inspectTopLevelForSymlinks(stateRoot);
  await assertAgentInactive(deps);
  await quiesceOfficialPort(deps, { port });
  await assertRelatedProcessesInactive(deps, { installRoot, stateRoot });
  await assertLockClaimsAreDead(stateRoot, lockPath, deps.readProcessIdentity);

  const state = await deps.readState(join(stateRoot, "state.json"));
  const themes = await validateUserThemes(join(stateRoot, "themes"), deps);

  await assertAgentInactive(deps);
  await assertPortFree(deps, port);
  await assertRelatedProcessesInactive(deps, { installRoot, stateRoot });
  await assertLockClaimsAreDead(stateRoot, lockPath, deps.readProcessIdentity);

  const backupPath = await uniqueBackupPath(stateRoot, deps);
  await rename(stateRoot, backupPath);
  await syncDirectory(dirname(stateRoot));
  let createdIdentity = null;
  try {
    await ensureMacosStateRoot(stateRoot);
    createdIdentity = await lstat(stateRoot, { bigint: true });
    await restoreValidatedState(stateRoot, state, themes, deps);
    return {
      action: "state-root-rebuilt",
      backupPath,
      recovered: true,
      restoredState: state !== null,
      restoredThemes: themes.length,
    };
  } catch (error) {
    if (createdIdentity === null) {
      try {
        await rename(backupPath, stateRoot);
        await syncDirectory(dirname(stateRoot));
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "LOCK_RECOVERY_ROLLBACK_FAILED: 状态根创建与原位恢复同时失败",
        );
      }
      throw error;
    }
    try {
      await rollbackMovedRoot({ stateRoot, backupPath, createdIdentity });
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "LOCK_RECOVERY_ROLLBACK_FAILED: 状态根恢复与回滚同时失败",
      );
    }
    throw error;
  }
}

async function defaultAcquireLock(paths, deps) {
  const identity = await deps.readProcessIdentity(process.pid);
  if (identity?.pid !== process.pid || typeof identity.startedAt !== "string") {
    throw recoveryError("LOCK_RECOVERY_IDENTITY_INVALID", "无法读取当前 launcher CLI 进程身份");
  }
  return acquireOperationLock({
    lockPath: paths.lockPath,
    stateRoot: paths.stateRoot,
    identity,
    readProcessIdentity: deps.readProcessIdentity,
    operation: "launcher:preflight",
    compactionThreshold: 8,
  });
}

async function acquireAndRelease(paths, deps) {
  const acquire = deps.acquireLock ?? (() => defaultAcquireLock(paths, deps));
  let lease;
  for (let attempt = 0; ; attempt += 1) {
    try {
      lease = await acquire();
      break;
    } catch (error) {
      if (!TRANSIENT_LOCK_CODES.has(error?.code) || attempt >= LOCK_RETRY_DELAYS_MS.length) {
        throw error;
      }
      await deps.wait(LOCK_RETRY_DELAYS_MS[attempt]);
    }
  }
  if (lease === null || typeof lease !== "object" || typeof lease.release !== "function") {
    throw recoveryError("LOCK_RECOVERY_LEASE_INVALID", "launcher lock probe 未返回有效 lease");
  }
  const released = await lease.release();
  if (released !== true) {
    throw recoveryError("LOCK_RECOVERY_RELEASE_FAILED", "launcher lock probe 无法确认安全释放");
  }
}

export async function ensureLauncherOperationLock({
  paths,
  port,
  dependencies = {},
} = {}) {
  if (paths === null || typeof paths !== "object" || Array.isArray(paths)) {
    throw new TypeError("launcher paths must be an object");
  }
  const stateRoot = canonicalAbsolute(paths.stateRoot, "paths.stateRoot");
  const lockPath = canonicalAbsolute(paths.lockPath, "paths.lockPath");
  const installRoot = canonicalAbsolute(paths.installRoot, "paths.installRoot");
  if (lockPath !== join(stateRoot, "operation.lock")) {
    throw recoveryError("LOCK_RECOVERY_PATH_INVALID", "lockPath 必须位于 stateRoot 直属位置");
  }
  const deps = normalizedDependencies(dependencies);
  try {
    await acquireAndRelease({ stateRoot, lockPath }, deps);
    return { recovered: false };
  } catch (error) {
    if (error?.code !== "LOCK_CHAIN_CORRUPT") throw error;
    const recovery = await recoverStaticLauncherStateRoot({
      stateRoot,
      installRoot,
      port,
      triggerCode: error.code,
      dependencies: deps,
    });
    await acquireAndRelease({ stateRoot, lockPath }, deps);
    return recovery;
  }
}
