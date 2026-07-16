import { randomBytes as cryptoRandomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, parse, sep } from "node:path";

import {
  DEFAULT_THEME_ID,
  NATIVE_THEME_ID,
  STATE_SCHEMA_VERSION,
} from "./constants.mjs";
import { sameProcessIdentity } from "./codex-app.mjs";
import {
  assertOperationLeaseCapability,
  commitWithOperationLease,
  guardOperationLease,
} from "./operation-lock.mjs";
import { readBoundedFile } from "./resource-limits.mjs";

const STATE_KEYS = [
  "schemaVersion",
  "persistenceEnabled",
  "selectedThemeId",
  "lastNonNativeThemeId",
  "controlToken",
  "lastTransitionNonce",
  "revision",
];
const SESSION_KEYS = [
  "schemaVersion",
  "mode",
  "process",
  "activeThemeId",
  "keepUntilProcessExit",
];
const TRANSITION_KEYS = [
  "schemaVersion",
  "operation",
  "expectedRevision",
  "process",
  "desiredPersistenceEnabled",
  "nonce",
  "stage",
];
const SESSION_MODES = new Set(["active", "native", "paused", "restoring", "error"]);
const TRANSITION_OPERATIONS = new Map([
  ["disable-persistence", false],
  ["enable-persistence", true],
]);
const TRANSITION_STAGES = new Set(["prepared", "state-committed", "session-committed"]);
const THEME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTROL_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const TRANSITION_NONCE = /^[A-Za-z0-9_-]{1,256}$/;
const STATE_FILE_NAME = "state.json";
const SESSION_FILE_NAME = "session.json";
const TRANSITION_FILE_NAME = "transition.json";
const MAX_PRIVATE_JSON_BYTES = 64 * 1024;
const MAX_LEGACY_THEME_BYTES = 256;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, keys, label) {
  if (!isRecord(value)) throw new Error(`${label}必须是对象`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label}字段不完整或包含未知字段`);
  }
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

async function mutationPath(lease, path, fileName) {
  const capability = assertOperationLeaseCapability(lease);
  if (process.platform === "win32") {
    throw statePathError(
      "STATE_MUTATION_UNSUPPORTED",
      "Windows durability and ACL enforcement are not implemented; refusing before filesystem access",
    );
  }
  const expectedPath = join(capability.stateRoot, fileName);
  if (path !== expectedPath) {
    throw statePathError(
      "STATE_PATH_INVALID",
      `state mutation path must be the canonical ${fileName} below the leased stateRoot`,
    );
  }
  await guardOperationLease(lease);
  return expectedPath;
}

function validateThemeId(value, { allowNative = false, field = "主题 ID" } = {}) {
  if (allowNative && value === NATIVE_THEME_ID) return value;
  if (typeof value !== "string" || !THEME_ID.test(value)) {
    throw new Error(`${field}格式无效`);
  }
  return value;
}

function validateControlToken(value) {
  if (
    typeof value !== "string" ||
    !CONTROL_TOKEN.test(value) ||
    Buffer.from(value, "base64url").length !== 32 ||
    Buffer.from(value, "base64url").toString("base64url") !== value
  ) {
    throw new Error("controlToken 必须是 32 字节无填充 base64url");
  }
  return value;
}

function validateNonce(value, { allowNull = false } = {}) {
  if (allowNull && value === null) return null;
  if (typeof value !== "string" || !TRANSITION_NONCE.test(value)) {
    throw new Error("transition nonce 必须是安全的非空标识符");
  }
  return value;
}

function validateProcessIdentity(value, { allowNull = false } = {}) {
  if (allowNull && value === null) return null;
  assertExactKeys(value, ["pid", "executablePath", "startedAt"], "进程身份");
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new Error("进程 pid 必须是正整数");
  }
  if (typeof value.executablePath !== "string" || !value.executablePath) {
    throw new Error("进程 executablePath 必须是非空字符串");
  }
  if (typeof value.startedAt !== "string" || !value.startedAt) {
    throw new Error("进程 startedAt 必须是非空字符串");
  }
  return {
    pid: value.pid,
    executablePath: value.executablePath,
    startedAt: value.startedAt,
  };
}

function statePathError(code, message, cause = undefined) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function enforcePosixFileSecurity(stats, kind) {
  // Windows mode bits are not ACL evidence. Its platform adapter must protect and
  // verify the state directory ACL before Node starts; this reader still checks
  // link, file type, and opened-inode identity on every platform.
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  if (stats.uid !== process.getuid()) {
    throw statePathError(
      kind === "file" ? "STATE_FILE_OWNER_INVALID" : "STATE_PARENT_OWNER_INVALID",
      `${kind === "file" ? "状态文件" : "状态目录"}不属于当前用户`,
    );
  }
  const expectedMode = kind === "file" ? 0o600 : 0o700;
  if ((stats.mode & 0o7777) !== expectedMode) {
    throw statePathError(
      kind === "file" ? "STATE_FILE_MODE_INVALID" : "STATE_PARENT_MODE_INVALID",
      `${kind === "file" ? "状态文件" : "状态目录"}权限必须是 ${expectedMode.toString(8)}`,
    );
  }
}

function ancestorPaths(path) {
  const root = parse(path).root;
  const components = path.slice(root.length).split(sep).filter(Boolean);
  const paths = [];
  let current = root;
  for (const component of components) {
    current = join(current, component);
    paths.push(current);
  }
  return paths;
}

async function verifyDirectoryAncestors(path) {
  for (const current of ancestorPaths(path)) {
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw statePathError(
        "STATE_PARENT_SYMLINK",
        `状态路径祖先不得是符号链接：${current}`,
      );
    }
    if (!stats.isDirectory()) {
      throw statePathError(
        "STATE_PARENT_TYPE_INVALID",
        `状态路径祖先必须是目录：${current}`,
      );
    }
  }
}

async function inspectPrivateJsonPath(path) {
  await verifyDirectoryAncestors(dirname(path));
  let fileStats;
  try {
    fileStats = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (fileStats.isSymbolicLink()) {
    throw statePathError("STATE_PATH_SYMLINK", "状态文件不得是符号链接");
  }
  if (!fileStats.isFile()) {
    throw statePathError("STATE_FILE_TYPE_INVALID", "状态路径必须是普通文件");
  }

  const parentStats = await lstat(dirname(path));
  if (parentStats.isSymbolicLink()) {
    throw statePathError("STATE_PARENT_SYMLINK", "状态目录不得是符号链接");
  }
  if (!parentStats.isDirectory()) {
    throw statePathError("STATE_PARENT_TYPE_INVALID", "状态文件父路径必须是目录");
  }
  enforcePosixFileSecurity(parentStats, "parent");
  enforcePosixFileSecurity(fileStats, "file");
  return fileStats;
}

async function ensurePrivateParent(path) {
  const parent = dirname(path);
  await verifyDirectoryAncestors(parent);
  const missing = [];
  let existing = parent;

  while (true) {
    try {
      const stats = await lstat(existing);
      if (stats.isSymbolicLink()) {
        throw statePathError("STATE_PARENT_SYMLINK", "状态目录不得是符号链接");
      }
      if (!stats.isDirectory()) {
        throw statePathError("STATE_PARENT_TYPE_INVALID", "状态文件父路径必须是目录");
      }
      if (
        process.platform !== "win32" &&
        typeof process.getuid === "function" &&
        stats.uid !== process.getuid()
      ) {
        throw statePathError("STATE_PARENT_OWNER_INVALID", "状态目录不属于当前用户");
      }
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing.push(existing);
      const next = dirname(existing);
      if (next === existing) throw error;
      existing = next;
    }
  }

  for (const directory of missing.reverse()) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stats = await lstat(directory);
    if (stats.isSymbolicLink()) {
      throw statePathError("STATE_PARENT_SYMLINK", "状态目录不得是符号链接");
    }
    if (!stats.isDirectory()) {
      throw statePathError("STATE_PARENT_TYPE_INVALID", "状态文件父路径必须是目录");
    }
    if (
      process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      stats.uid !== process.getuid()
    ) {
      throw statePathError("STATE_PARENT_OWNER_INVALID", "状态目录不属于当前用户");
    }
    await chmod(directory, 0o700);
    await syncDirectory(directory);
    await syncDirectory(dirname(directory));
  }

  await chmod(parent, 0o700);
  await syncDirectory(parent);
  return parent;
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWriteJson(path, value, { faultAt } = {}) {
  if (faultAt !== undefined && faultAt !== "after-temp-sync") {
    throw new Error("unknown state write fault injection point");
  }
  const parent = await ensurePrivateParent(path);
  const temporary = join(
    parent,
    `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let handle = null;
  let renamed = false;

  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;

    if (faultAt === "after-temp-sync") {
      throw statePathError(
        "FAULT_AFTER_TEMP_SYNC",
        "injected crash after temporary state file sync",
      );
    }
    await rename(temporary, path);
    renamed = true;
    await syncDirectory(parent);
    return value;
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => {});
    if (!renamed) await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readJson(path, { damagedMessage, validate }) {
  const inspected = await inspectPrivateJsonPath(path);
  if (inspected === null) return null;

  let handle;
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ELOOP") {
      throw statePathError("STATE_FILE_CHANGED", "状态文件在安全检查后发生变化", error);
    }
    throw error;
  }

  let raw;
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== inspected.dev ||
      opened.ino !== inspected.ino
    ) {
      throw statePathError("STATE_FILE_CHANGED", "状态文件在安全检查后发生变化");
    }
    enforcePosixFileSecurity(opened, "file");
    if (!Number.isSafeInteger(opened.size) || opened.size < 0) {
      throw statePathError("STATE_FILE_SIZE_INVALID", "状态文件大小无效");
    }
    if (opened.size > MAX_PRIVATE_JSON_BYTES) {
      throw statePathError(
        "STATE_FILE_TOO_LARGE",
        `状态文件超过 ${MAX_PRIVATE_JSON_BYTES} bytes`,
      );
    }
    const buffer = Buffer.allocUnsafe(MAX_PRIVATE_JSON_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_PRIVATE_JSON_BYTES) {
      throw statePathError(
        "STATE_FILE_TOO_LARGE",
        `状态文件超过 ${MAX_PRIVATE_JSON_BYTES} bytes`,
      );
    }
    const after = await handle.stat();
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
      || offset !== opened.size
    ) {
      throw statePathError("STATE_FILE_CHANGED", "状态文件在读取期间发生变化");
    }
    raw = UTF8_DECODER.decode(buffer.subarray(0, offset));
  } finally {
    await handle.close();
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(damagedMessage, { cause });
  }
  return validate(parsed);
}

export function validateStudioState(value) {
  if (!isRecord(value)) throw new Error("状态文件必须是对象");
  if (value.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error(`不支持的状态 schemaVersion：${value.schemaVersion}`);
  }
  assertExactKeys(value, STATE_KEYS, "状态文件");
  if (typeof value.persistenceEnabled !== "boolean") {
    throw new Error("persistenceEnabled 必须是布尔值");
  }
  const selectedThemeId = validateThemeId(value.selectedThemeId, {
    allowNative: true,
    field: "selectedThemeId",
  });
  const lastNonNativeThemeId = validateThemeId(value.lastNonNativeThemeId, {
    field: "lastNonNativeThemeId",
  });
  const controlToken = validateControlToken(value.controlToken);
  const lastTransitionNonce = validateNonce(value.lastTransitionNonce, { allowNull: true });
  if (!isNonNegativeInteger(value.revision)) {
    throw new Error("revision 必须是非负安全整数");
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    persistenceEnabled: value.persistenceEnabled,
    selectedThemeId,
    lastNonNativeThemeId,
    controlToken,
    lastTransitionNonce,
    revision: value.revision,
  };
}

export function createDefaultStudioState({ themeId, token }) {
  return validateStudioState({
    schemaVersion: STATE_SCHEMA_VERSION,
    persistenceEnabled: false,
    selectedThemeId: themeId,
    lastNonNativeThemeId: themeId,
    controlToken: token,
    lastTransitionNonce: null,
    revision: 0,
  });
}

export async function readStudioState(path) {
  return readJson(path, {
    damagedMessage: "状态文件损坏：不是有效 JSON",
    validate: validateStudioState,
  });
}

export async function writeStudioState(path, value, { lease, faultAt } = {}) {
  const state = validateStudioState(value);
  if (state.revision !== 0) {
    throw new Error("state initialization requires revision 0");
  }
  path = await mutationPath(lease, path, STATE_FILE_NAME);
  return commitWithOperationLease(lease, async () => {
    if (await readStudioState(path) !== null) {
      throw new Error("state already exists; initialization cannot overwrite it");
    }
    return atomicWriteJson(path, state, { faultAt });
  });
}

async function readRequiredStudioState(path) {
  const state = await readStudioState(path);
  if (state === null) throw new Error("状态文件不存在");
  return state;
}

export class StateConflictError extends Error {
  constructor(state) {
    super(`状态 revision 冲突，当前为 ${state.revision}`);
    Object.defineProperty(this, "name", {
      configurable: true,
      value: "StateConflictError",
    });
    this.code = "REVISION_CONFLICT";
    this.revision = state.revision;
    this.persistenceEnabled = state.persistenceEnabled;
  }
}

async function compareAndUpdateStudioStateWithinCommit(
  path,
  { expectedRevision, mutate, faultAt },
) {
  const current = await readRequiredStudioState(path);
  if (current.revision !== expectedRevision) throw new StateConflictError(current);
  const mutated = mutate(structuredClone(current));
  const next = validateStudioState({
    ...mutated,
    revision: current.revision + 1,
  });
  return atomicWriteJson(path, next, { faultAt });
}

export async function compareAndUpdateStudioState(
  path,
  { lease, expectedRevision, mutate, faultAt } = {},
) {
  if (!isNonNegativeInteger(expectedRevision)) {
    throw new Error("expectedRevision 必须是非负安全整数");
  }
  if (typeof mutate !== "function") throw new Error("mutate 必须是函数");

  path = await mutationPath(lease, path, STATE_FILE_NAME);
  return commitWithOperationLease(
    lease,
    () => compareAndUpdateStudioStateWithinCommit(path, {
      expectedRevision,
      mutate,
      faultAt,
    }),
  );
}

function generateControlToken(randomBytes) {
  const entropy = randomBytes(32);
  if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 32) {
    throw new Error("controlToken 随机源必须返回 32 字节");
  }
  return Buffer.from(entropy).toString("base64url");
}

export async function migrateLegacyState({
  statePath,
  lease,
  legacyThemePath,
  legacyAgentLoaded,
  themeExists,
  defaultThemeId = DEFAULT_THEME_ID,
  randomBytes = cryptoRandomBytes,
}) {
  statePath = await mutationPath(lease, statePath, STATE_FILE_NAME);
  if (typeof legacyAgentLoaded !== "boolean") {
    throw new Error("legacyAgentLoaded 必须是布尔值");
  }
  if (typeof themeExists !== "function") throw new Error("themeExists 必须是函数");

  return commitWithOperationLease(lease, async () => {
    const existing = await readStudioState(statePath);
    if (existing !== null) {
      return { state: existing, migratedFrom: null };
    }

    let themeId = defaultThemeId;
    let persistenceEnabled = false;
    let migratedFrom = null;
    if (legacyAgentLoaded) {
      let legacyTheme;
      try {
        await verifyDirectoryAncestors(dirname(legacyThemePath));
        const snapshot = await readBoundedFile(legacyThemePath, {
          maxBytes: MAX_LEGACY_THEME_BYTES,
          label: "旧版主题记录",
        });
        legacyTheme = UTF8_DECODER.decode(snapshot.bytes);
      } catch (cause) {
        throw new Error(
          `旧版主题状态无效：主题文件必须是不超过 ${MAX_LEGACY_THEME_BYTES} bytes 的普通文件且不得是符号链接`,
          { cause },
        );
      }
      themeId = legacyTheme.trim();
      try {
        validateThemeId(themeId, { field: "旧版主题 ID" });
      } catch (cause) {
        throw new Error("旧版主题状态无效：主题 ID 格式错误", { cause });
      }
      if (await themeExists(themeId) !== true) {
        throw new Error("旧版主题状态无效：主题不存在");
      }
      persistenceEnabled = true;
      migratedFrom = "watchdog";
    } else {
      validateThemeId(themeId, { field: "默认主题 ID" });
      if (await themeExists(themeId) !== true) {
        throw new Error("默认主题不存在，拒绝创建状态");
      }
    }

    const token = generateControlToken(randomBytes);
    const state = validateStudioState({
      ...createDefaultStudioState({ themeId, token }),
      persistenceEnabled,
      revision: persistenceEnabled ? 1 : 0,
    });
    await atomicWriteJson(statePath, state);
    return { state, migratedFrom };
  });
}

function sameStudioStateIdentity(left, right) {
  return left.schemaVersion === right.schemaVersion &&
    left.selectedThemeId === right.selectedThemeId &&
    left.lastNonNativeThemeId === right.lastNonNativeThemeId &&
    left.controlToken === right.controlToken;
}

export async function rollbackLegacyStateMigration({
  statePath,
  lease,
  beforeState = null,
  expectedControlToken,
}) {
  statePath = await mutationPath(lease, statePath, STATE_FILE_NAME);
  expectedControlToken = validateControlToken(expectedControlToken);
  const validatedBefore = beforeState === null ? null : validateStudioState(beforeState);
  return commitWithOperationLease(lease, async () => {
    const current = await readStudioState(statePath);
    if (validatedBefore === null) {
      if (current === null) return { rolledBack: false, state: null };
      const exactPrepared = current.controlToken === expectedControlToken && (
        (
          current.persistenceEnabled === false &&
          current.revision === 0 &&
          current.lastTransitionNonce === null
        ) ||
        (
          current.persistenceEnabled === true &&
          current.revision === 1 &&
          current.lastTransitionNonce === null
        ) ||
        (
          current.persistenceEnabled === false &&
          current.revision === 2 &&
          current.lastTransitionNonce !== null
        )
      );
      if (!exactPrepared) {
        throw new Error("legacy state participant changed before rollback");
      }
      await unlink(statePath);
      await syncDirectory(dirname(statePath));
      return { rolledBack: true, state: null };
    }

    if (current === null || current.controlToken !== expectedControlToken) {
      throw new Error("legacy state participant disappeared or changed identity before rollback");
    }
    const exactBefore = JSON.stringify(current) === JSON.stringify(validatedBefore);
    const exactControllerCompensation = sameStudioStateIdentity(current, validatedBefore) &&
      validatedBefore.persistenceEnabled === true &&
      current.persistenceEnabled === false &&
      current.revision === validatedBefore.revision + 1 &&
      current.lastTransitionNonce !== null;
    if (!exactBefore && !exactControllerCompensation) {
      throw new Error("legacy state participant revision changed before rollback");
    }
    if (!exactBefore) await atomicWriteJson(statePath, validatedBefore);
    return { rolledBack: !exactBefore, state: validatedBefore };
  });
}

export function validateSessionState(value) {
  if (!isRecord(value)) throw new Error("session 状态必须是对象");
  if (value.schemaVersion !== 1) {
    throw new Error(`不支持的 session schemaVersion：${value.schemaVersion}`);
  }
  assertExactKeys(value, SESSION_KEYS, "session 状态");
  if (!SESSION_MODES.has(value.mode)) throw new Error("session mode 无效");
  const processIdentity = validateProcessIdentity(value.process, { allowNull: true });
  const activeThemeId = value.activeThemeId === null
    ? null
    : validateThemeId(value.activeThemeId, { field: "activeThemeId" });
  if (typeof value.keepUntilProcessExit !== "boolean") {
    throw new Error("keepUntilProcessExit 必须是布尔值");
  }
  if (value.mode === "active" && (processIdentity === null || activeThemeId === null)) {
    throw new Error("session mode invariant: active 必须绑定进程与活动主题");
  }
  if (value.mode === "paused" && (processIdentity === null || activeThemeId !== null)) {
    throw new Error("session mode invariant: paused 必须绑定进程且不得包含活动主题");
  }
  if (value.mode === "native" && activeThemeId !== null) {
    throw new Error("session mode invariant: native 不得包含活动主题");
  }
  if (
    value.mode === "restoring" &&
    (processIdentity === null || activeThemeId !== null || value.keepUntilProcessExit)
  ) {
    throw new Error("session mode invariant: restoring 必须绑定进程并停止活动主题与会话保留");
  }
  if (value.mode === "error" && (activeThemeId !== null || value.keepUntilProcessExit)) {
    throw new Error("session mode invariant: error 不得保留活动主题或会话注入");
  }
  if (value.keepUntilProcessExit && processIdentity === null) {
    throw new Error("keepUntilProcessExit 需要精确进程身份");
  }
  return {
    schemaVersion: 1,
    mode: value.mode,
    process: processIdentity,
    activeThemeId,
    keepUntilProcessExit: value.keepUntilProcessExit,
  };
}

export async function readSessionState(path) {
  return readJson(path, {
    damagedMessage: "session 状态文件损坏：不是有效 JSON",
    validate: validateSessionState,
  });
}

async function writeSessionStateWithinCommit(path, session, { faultAt } = {}) {
  return atomicWriteJson(path, session, { faultAt });
}

export async function writeSessionState(path, value, { lease, faultAt } = {}) {
  const session = validateSessionState(value);
  path = await mutationPath(lease, path, SESSION_FILE_NAME);
  return commitWithOperationLease(
    lease,
    () => writeSessionStateWithinCommit(path, session, { faultAt }),
  );
}

export function validateTransitionJournal(value) {
  if (!isRecord(value)) throw new Error("迁移日志必须是对象");
  if (value.schemaVersion !== 1) {
    throw new Error(`不支持的迁移日志 schemaVersion：${value.schemaVersion}`);
  }
  assertExactKeys(value, TRANSITION_KEYS, "迁移日志");
  if (!TRANSITION_OPERATIONS.has(value.operation)) {
    throw new Error("迁移日志 operation 无效");
  }
  if (!isNonNegativeInteger(value.expectedRevision)) {
    throw new Error("迁移日志 expectedRevision 必须是非负安全整数");
  }
  const processIdentity = validateProcessIdentity(value.process);
  if (typeof value.desiredPersistenceEnabled !== "boolean") {
    throw new Error("迁移日志 desiredPersistenceEnabled 必须是布尔值");
  }
  if (TRANSITION_OPERATIONS.get(value.operation) !== value.desiredPersistenceEnabled) {
    throw new Error("迁移日志 operation 与目标状态不一致");
  }
  const nonce = validateNonce(value.nonce);
  if (!TRANSITION_STAGES.has(value.stage)) throw new Error("迁移日志 stage 无效");
  return {
    schemaVersion: 1,
    operation: value.operation,
    expectedRevision: value.expectedRevision,
    process: processIdentity,
    desiredPersistenceEnabled: value.desiredPersistenceEnabled,
    nonce,
    stage: value.stage,
  };
}

export async function readTransitionJournal(path) {
  return readJson(path, {
    damagedMessage: "迁移日志损坏：不是有效 JSON",
    validate: validateTransitionJournal,
  });
}

async function writeTransitionJournalWithinCommit(path, journal, { faultAt } = {}) {
  const existing = await readTransitionJournal(path);
  if (existing === null) {
    if (journal.stage !== "prepared") {
      throw new Error("transition journal must begin at prepared stage");
    }
  } else {
    const immutableKeys = TRANSITION_KEYS.filter((key) => key !== "stage");
    if (immutableKeys.some((key) => existing[key] !== journal[key] &&
      JSON.stringify(existing[key]) !== JSON.stringify(journal[key]))) {
      throw new Error("transition journal immutable fields and nonce cannot change");
    }
    const stages = [...TRANSITION_STAGES];
    const currentIndex = stages.indexOf(existing.stage);
    const nextIndex = stages.indexOf(journal.stage);
    if (nextIndex !== currentIndex && nextIndex !== currentIndex + 1) {
      throw new Error("transition journal stage must advance monotonically one step");
    }
  }
  return atomicWriteJson(path, journal, { faultAt });
}

export async function writeTransitionJournal(path, value, { lease, faultAt } = {}) {
  const journal = validateTransitionJournal(value);
  path = await mutationPath(lease, path, TRANSITION_FILE_NAME);
  return commitWithOperationLease(
    lease,
    () => writeTransitionJournalWithinCommit(path, journal, { faultAt }),
  );
}

async function clearTransitionJournalWithinCommit(path, nonce) {
  const journal = await readTransitionJournal(path);
  if (journal === null) return false;
  if (journal.nonce !== nonce) {
    throw new Error("transition journal nonce does not match clear request");
  }
  if (journal.stage !== "session-committed") {
    throw new Error("transition journal cannot clear before session-committed stage");
  }
  try {
    await unlink(path);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  await syncDirectory(dirname(path));
  return true;
}

export async function clearTransitionJournal(path, { lease, nonce } = {}) {
  path = await mutationPath(lease, path, TRANSITION_FILE_NAME);
  nonce = validateNonce(nonce);
  return commitWithOperationLease(
    lease,
    () => clearTransitionJournalWithinCommit(path, nonce),
  );
}

export class TransitionConflictError extends Error {
  constructor(state, _journal) {
    super("状态迁移冲突：revision、目标状态或 nonce 不匹配");
    Object.defineProperty(this, "name", {
      configurable: true,
      value: "TransitionConflictError",
    });
    this.code = "TRANSITION_CONFLICT";
    this.revision = state.revision;
    this.persistenceEnabled = state.persistenceEnabled;
  }
}

function isCommittedTransition(state, journal) {
  return state.revision === journal.expectedRevision + 1 &&
    state.persistenceEnabled === journal.desiredPersistenceEnabled &&
    state.lastTransitionNonce === journal.nonce;
}

function sessionForTransition(state, journal, currentProcess) {
  const processStillRunning = currentProcess !== null &&
    sameProcessIdentity(journal.process, currentProcess);
  const selectedNative = state.selectedThemeId === NATIVE_THEME_ID;

  if (journal.operation === "disable-persistence" && processStillRunning) {
    return {
      schemaVersion: 1,
      mode: selectedNative ? "native" : "active",
      process: journal.process,
      activeThemeId: selectedNative ? null : state.selectedThemeId,
      keepUntilProcessExit: true,
    };
  }

  if (journal.operation === "enable-persistence" && processStillRunning) {
    return {
      schemaVersion: 1,
      mode: selectedNative ? "native" : "active",
      process: journal.process,
      activeThemeId: selectedNative ? null : state.selectedThemeId,
      keepUntilProcessExit: false,
    };
  }

  return {
    schemaVersion: 1,
    mode: "native",
    process: null,
    activeThemeId: null,
    keepUntilProcessExit: false,
  };
}

export async function recoverStateTransition({
  statePath,
  sessionPath,
  transitionPath,
  lease,
  currentProcess,
}) {
  statePath = await mutationPath(lease, statePath, STATE_FILE_NAME);
  sessionPath = await mutationPath(lease, sessionPath, SESSION_FILE_NAME);
  transitionPath = await mutationPath(lease, transitionPath, TRANSITION_FILE_NAME);
  if (currentProcess !== null && currentProcess !== undefined) {
    currentProcess = validateProcessIdentity(currentProcess);
  } else {
    currentProcess = null;
  }
  return commitWithOperationLease(lease, async () => {
    let journal = await readTransitionJournal(transitionPath);
    if (journal === null) {
      const state = await readStudioState(statePath);
      const session = await readSessionState(sessionPath);
      return { state, session, recovered: false };
    }

    let state = await readRequiredStudioState(statePath);
    if (journal.stage === "prepared" && state.revision === journal.expectedRevision) {
      state = await compareAndUpdateStudioStateWithinCommit(statePath, {
        expectedRevision: journal.expectedRevision,
        mutate: (current) => ({
          ...current,
          persistenceEnabled: journal.desiredPersistenceEnabled,
          lastTransitionNonce: journal.nonce,
        }),
      });
      journal = validateTransitionJournal({
        ...journal,
        stage: "state-committed",
      });
      await writeTransitionJournalWithinCommit(transitionPath, journal);
    } else if (journal.stage === "prepared" && isCommittedTransition(state, journal)) {
      journal = validateTransitionJournal({
        ...journal,
        stage: "state-committed",
      });
      await writeTransitionJournalWithinCommit(transitionPath, journal);
    } else if (journal.stage === "prepared") {
      throw new TransitionConflictError(state, journal);
    }

    if (!isCommittedTransition(state, journal)) {
      throw new TransitionConflictError(state, journal);
    }

    const session = sessionForTransition(state, journal, currentProcess);
    await writeSessionStateWithinCommit(
      sessionPath,
      validateSessionState(session),
    );
    if (journal.stage !== "session-committed") {
      journal = validateTransitionJournal({
        ...journal,
        stage: "session-committed",
      });
      await writeTransitionJournalWithinCommit(transitionPath, journal);
    }
    await clearTransitionJournalWithinCommit(transitionPath, journal.nonce);
    return { state, session, recovered: true };
  });
}
