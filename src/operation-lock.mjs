import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  sep,
} from "node:path";

import { windowsSecurityAdapter } from "./windows-secure-fs.mjs";

const LOCK_SCHEMA_VERSION = 2;
const QUARANTINE_SCHEMA_VERSION = 1;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const MAX_ACQUIRE_ATTEMPTS = 32;
const MAX_CHAIN_LENGTH = 4096;
const DEFAULT_COMPACTION_THRESHOLD = 128;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const OPERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const SUPPORTED_FAULTS = new Set([
  "before-publish",
  "after-publish",
  "after-publish-sync",
  "after-compact-rename",
  "after-compact-sync",
  "after-compact-cleanup",
]);
const leaseCapabilities = new WeakMap();
const activeCommitContext = new AsyncLocalStorage();
const activeQuarantineDirectories = new Set();

class OperationLockError extends Error {
  constructor(code, message, options = undefined) {
    super(`${code}: ${message}`, options);
    this.name = "OperationLockError";
    this.code = code;
  }
}

class HandledAcquireFailure {
  constructor(error) {
    this.error = error;
  }
}

function lockError(code, message, cause) {
  return new OperationLockError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function aggregateLockErrors(code, message, errors) {
  const aggregate = new AggregateError(errors, `${code}: ${message}`);
  aggregate.code = code;
  return aggregate;
}

function notOwnedError(message, { cause, definitive = false } = {}) {
  const error = lockError("LOCK_NOT_OWNED", message, cause);
  Object.defineProperty(error, "ownershipLost", {
    configurable: false,
    enumerable: false,
    value: definitive,
    writable: false,
  });
  return error;
}

function pathHasTraversal(path) {
  const root = parse(path).root;
  return path
    .slice(root.length)
    .split(/[\\/]+/u)
    .some((segment) => segment === "." || segment === "..");
}

function validateAbsolutePath(path, field) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    path.includes("\0") ||
    pathHasTraversal(path)
  ) {
    throw lockError(
      "LOCK_PATH_INVALID",
      `${field} must be an absolute canonical path without traversal segments`,
    );
  }
  return path;
}

function validatePaths(lockPathValue, stateRootValue) {
  const lockPath = validateAbsolutePath(lockPathValue, "lockPath");
  const stateRoot = validateAbsolutePath(stateRootValue, "stateRoot");
  const withinRoot = relative(stateRoot, lockPath);
  if (
    withinRoot === "" ||
    withinRoot === ".." ||
    withinRoot.startsWith(`..${sep}`) ||
    isAbsolute(withinRoot) ||
    basename(lockPath) === "" ||
    dirname(lockPath) === parse(lockPath).root ||
    lockPath !== join(stateRoot, "operation.lock")
  ) {
    throw lockError(
      "LOCK_PATH_INVALID",
      "lockPath must be the unique operation.lock directly below the trusted stateRoot",
    );
  }
  return { lockPath, stateRoot };
}

function validateOperation(operation) {
  if (typeof operation !== "string" || !OPERATION_PATTERN.test(operation)) {
    throw lockError(
      "LOCK_OPERATION_INVALID",
      "operation must be a non-empty stable identifier",
    );
  }
  return operation;
}

function validateIdentity(identity, code = "LOCK_IDENTITY_INVALID") {
  if (
    identity === null ||
    typeof identity !== "object" ||
    Array.isArray(identity) ||
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    typeof identity.startedAt !== "string" ||
    identity.startedAt.trim().length === 0 ||
    identity.startedAt.length > 512 ||
    identity.startedAt.includes("\0")
  ) {
    throw lockError(
      code,
      "process identity must contain a positive pid and non-empty startedAt",
    );
  }
  return { pid: identity.pid, startedAt: identity.startedAt };
}

function validateTimestamp(value, field, code) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw lockError(code, `${field} must be an ISO-compatible timestamp`);
  }
  return value;
}

function exactKeys(value, expected) {
  return (
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function validatePredecessor(value, code) {
  if (value === null) return null;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value, ["dev", "ino", "nonce"]) ||
    typeof value.dev !== "string" ||
    value.dev.length === 0 ||
    typeof value.ino !== "string" ||
    value.ino.length === 0 ||
    typeof value.nonce !== "string" ||
    !NONCE_PATTERN.test(value.nonce)
  ) {
    throw lockError(code, "owner predecessor binding is invalid");
  }
  return value;
}

function validateOwnerRecord(value, code = "LOCK_MALFORMED") {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value, [
      "createdAt",
      "heartbeat",
      "nonce",
      "operation",
      "pid",
      "predecessor",
      "schemaVersion",
      "startedAt",
    ])
  ) {
    throw lockError(code, "owner must have the exact supported schema");
  }
  if (value.schemaVersion !== LOCK_SCHEMA_VERSION) {
    throw lockError(code, "owner has an unsupported schemaVersion");
  }
  if (typeof value.nonce !== "string" || !NONCE_PATTERN.test(value.nonce)) {
    throw lockError(code, "owner nonce is invalid");
  }
  validateIdentity(value, code);
  if (
    typeof value.operation !== "string" ||
    !OPERATION_PATTERN.test(value.operation)
  ) {
    throw lockError(code, "owner operation is invalid");
  }
  validateTimestamp(value.createdAt, "createdAt", code);
  validateTimestamp(value.heartbeat, "heartbeat", code);
  validatePredecessor(value.predecessor, code);
  return value;
}

function fileMode(metadata) {
  return typeof metadata.mode === "bigint"
    ? Number(metadata.mode & 0o777n)
    : metadata.mode & 0o777;
}

function requireCurrentUser(metadata, code, description) {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    currentUid !== null &&
    metadata.uid !== (typeof metadata.uid === "bigint" ? BigInt(currentUid) : currentUid)
  ) {
    throw lockError(
      code,
      `${description} must be owned by the current user`,
    );
  }
}

function requirePrivateDirectory(metadata, description) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw lockError(
      "LOCK_PATH_INVALID",
      `${description} must be a real directory`,
    );
  }
  requireCurrentUser(metadata, "LOCK_PERMISSIONS", description);
  if (fileMode(metadata) !== PRIVATE_DIRECTORY_MODE) {
    throw lockError(
      "LOCK_PERMISSIONS",
      `${description} must have mode 0700, found ${fileMode(metadata).toString(8)}`,
    );
  }
}

function requirePrivateFile(metadata, code, description) {
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw lockError("LOCK_PATH_INVALID", `${description} must be a regular file`);
  }
  requireCurrentUser(metadata, code, description);
  if (fileMode(metadata) !== PRIVATE_FILE_MODE) {
    throw lockError(
      code,
      `${description} must have mode 0600, found ${fileMode(metadata).toString(8)}`,
    );
  }
}

function serializeJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function createNonce() {
  return randomBytes(24).toString("base64url");
}

function timestampFrom(now) {
  let value;
  try {
    value = now();
  } catch (cause) {
    throw lockError("LOCK_CLOCK_FAILED", "clock dependency failed", cause);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw lockError("LOCK_CLOCK_FAILED", "clock dependency returned an invalid date");
  }
  return date.toISOString();
}

async function syncPosixDirectory(path) {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    throw lockError(
      "LOCK_DIRECTORY_SYNC_FAILED",
      `could not fsync lock directory ${path}`,
      error,
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

function createDurabilityAdapter(platform) {
  if (platform === "win32") {
    return Object.freeze({
      assertSupported() {
        throw lockError(
          "LOCK_DURABILITY_UNSUPPORTED",
          "Windows operation-lock durability is not implemented; refusing before filesystem access",
        );
      },
      syncDirectory: undefined,
    });
  }
  if (
    !["aix", "darwin", "freebsd", "linux", "openbsd", "sunos"].includes(
      platform,
    )
  ) {
    return Object.freeze({
      assertSupported() {
        throw lockError(
          "LOCK_DURABILITY_UNSUPPORTED",
          `operation-lock durability is not implemented for ${platform}`,
        );
      },
      syncDirectory: undefined,
    });
  }
  return Object.freeze({
    assertSupported() {},
    syncDirectory: syncPosixDirectory,
  });
}

async function lstatIfPresent(path) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function pathParts(path) {
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

async function verifyRealDirectoryAncestors(path) {
  for (const current of pathParts(path)) {
    let metadata;
    try {
      metadata = await lstat(current, { bigint: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        throw lockError(
          "LOCK_PATH_INVALID",
          `trusted stateRoot ancestor does not exist: ${current}`,
          error,
        );
      }
      throw lockError(
        "LOCK_PARENT_FAILED",
        `could not inspect trusted stateRoot ancestor ${current}`,
        error,
      );
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw lockError(
        "LOCK_PATH_INVALID",
        `trusted stateRoot ancestor must not be a symlink: ${current}`,
      );
    }
  }
}

async function ensurePrivateDirectory(path, durability) {
  let metadata = await lstatIfPresent(path);
  if (metadata === null) {
    try {
      await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw lockError(
          "LOCK_PARENT_FAILED",
          `could not create private lock directory ${path}`,
          error,
        );
      }
    }
    metadata = await lstatIfPresent(path);
    if (metadata === null) {
      throw lockError(
        "LOCK_PARENT_FAILED",
        `private lock directory disappeared after creation: ${path}`,
      );
    }
    requirePrivateDirectory(metadata, `lock directory ${path}`);
    await durability.syncDirectory(dirname(path));
    return;
  }
  requirePrivateDirectory(metadata, `lock directory ${path}`);
}

async function prepareTrustedParent({ stateRoot, parentPath, durability }) {
  await verifyRealDirectoryAncestors(dirname(stateRoot));
  await ensurePrivateDirectory(stateRoot, durability);

  const belowRoot = relative(stateRoot, parentPath);
  if (belowRoot === "") return;
  let current = stateRoot;
  for (const component of belowRoot.split(sep).filter(Boolean)) {
    current = join(current, component);
    await ensurePrivateDirectory(current, durability);
  }
}

async function unlinkIfPresent(path) {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function writeSyncedExclusiveFile(path, contents) {
  let handle;
  let created = false;
  try {
    handle = await open(path, "wx", PRIVATE_FILE_MODE);
    created = true;
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    const metadata = await handle.stat({ bigint: true });
    requirePrivateFile(metadata, "LOCK_PERMISSIONS", `staging file ${path}`);
    await handle.close();
    handle = undefined;
    return { dev: metadata.dev, ino: metadata.ino };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created) await unlinkIfPresent(path).catch(() => {});
    if (error instanceof OperationLockError) throw error;
    throw lockError(
      "LOCK_STAGING_WRITE_FAILED",
      `could not write private staging file ${path}`,
      error,
    );
  }
}

async function readJsonFile(
  path,
  {
    allowMissing = false,
    malformedCode = "LOCK_MALFORMED",
    permissionsCode = "LOCK_PERMISSIONS",
    description = "lock metadata",
  } = {},
) {
  let metadata;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return null;
    if (error.code === "ENOENT") {
      throw lockError("LOCK_DISAPPEARED", `${description} disappeared at ${path}`, error);
    }
    throw lockError("LOCK_READ_FAILED", `could not inspect ${description} ${path}`, error);
  }
  requirePrivateFile(metadata, permissionsCode, `${description} ${path}`);

  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw lockError("LOCK_READ_FAILED", `could not read ${description} ${path}`, error);
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw lockError(malformedCode, `${description} ${path} is not valid JSON`, error);
  }
  return {
    metadata: { dev: metadata.dev, ino: metadata.ino },
    raw,
    value,
  };
}

function claimBinding(claim) {
  return {
    dev: String(claim.metadata.dev),
    ino: String(claim.metadata.ino),
    nonce: claim.owner.nonce,
  };
}

function sameClaim(left, right) {
  return (
    left.raw === right.raw &&
    left.owner.nonce === right.owner.nonce &&
    left.owner.pid === right.owner.pid &&
    left.owner.startedAt === right.owner.startedAt &&
    left.metadata.dev === right.metadata.dev &&
    left.metadata.ino === right.metadata.ino
  );
}

function sameFileSnapshot(left, right) {
  return (
    left.raw === right.raw &&
    left.metadata.dev === right.metadata.dev &&
    left.metadata.ino === right.metadata.ino
  );
}

async function createPrivateQuarantine(parentPath) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const path = join(
      parentPath,
      `.operation-lock-gc.${process.pid}.${createNonce()}`,
    );
    try {
      await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
      const metadata = await lstat(path, { bigint: true });
      requirePrivateDirectory(metadata, `artifact quarantine ${path}`);
      activeQuarantineDirectories.add(path);
      return path;
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw lockError(
        "LOCK_ARTIFACT_CLEANUP_FAILED",
        `could not create a private artifact quarantine below ${parentPath}`,
        error,
      );
    }
  }
  throw lockError(
    "LOCK_ARTIFACT_CLEANUP_FAILED",
    "could not allocate a unique artifact quarantine",
  );
}

async function clearQuarantineDirectory({
  quarantineDirectory,
  quarantinePath,
  manifestPath,
  durability,
}) {
  await unlinkIfPresent(quarantinePath);
  await unlinkIfPresent(manifestPath);
  await rmdir(quarantineDirectory);
  await durability.syncDirectory(dirname(quarantineDirectory));
}

async function restoreQuarantinedArtifact({
  path,
  quarantineDirectory,
  quarantinePath,
  manifestPath,
  moved,
  durability,
}) {
  try {
    await link(quarantinePath, path);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await lstat(path, { bigint: true });
    if (existing.dev !== moved.dev || existing.ino !== moved.ino) throw error;
  }
  await durability.syncDirectory(dirname(path));
  await clearQuarantineDirectory({
    quarantineDirectory,
    quarantinePath,
    manifestPath,
    durability,
  });
}

async function removeExactArtifact({
  path,
  snapshot,
  options,
  durability,
  description,
  preserveAfterMove,
}) {
  await runStage(options, "before-artifact-tombstone", { path, snapshot });
  const parentPath = dirname(path);
  const quarantineDirectory = await createPrivateQuarantine(parentPath);
  const quarantinePath = join(quarantineDirectory, "artifact");
  const manifestPath = join(quarantineDirectory, "manifest");
  try {
    await writeSyncedExclusiveFile(
      manifestPath,
      serializeJson({
        schemaVersion: QUARANTINE_SCHEMA_VERSION,
        originalName: basename(path),
        expected: {
          dev: String(snapshot.metadata.dev),
          ino: String(snapshot.metadata.ino),
        },
      }),
    );
    await durability.syncDirectory(quarantineDirectory);
    await durability.syncDirectory(parentPath);
    try {
      await rename(path, quarantinePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        await clearQuarantineDirectory({
          quarantineDirectory,
          quarantinePath,
          manifestPath,
          durability,
        });
        return false;
      }
      throw error;
    }
    await durability.syncDirectory(parentPath);
    await durability.syncDirectory(quarantineDirectory);
    await runStage(options, "after-artifact-tombstone", {
      path,
      quarantinePath,
      snapshot,
    });

    const moved = await lstat(quarantinePath, { bigint: true });
    if (
      moved.dev !== snapshot.metadata.dev ||
      moved.ino !== snapshot.metadata.ino
    ) {
      let restoreError;
      try {
        await restoreQuarantinedArtifact({
          path,
          quarantineDirectory,
          quarantinePath,
          manifestPath,
          moved,
          durability,
        });
      } catch (error) {
        restoreError = error;
      }
      throw lockError(
        "LOCK_ARTIFACT_CHANGED",
        `${description} changed inode before quarantine and was not deleted`,
        restoreError,
      );
    }

    let preserve = false;
    if (typeof preserveAfterMove === "function") {
      try {
        preserve = await preserveAfterMove({
          metadata: moved,
          path,
          quarantinePath,
        });
      } catch (error) {
        try {
          await restoreQuarantinedArtifact({
            path,
            quarantineDirectory,
            quarantinePath,
            manifestPath,
            moved,
            durability,
          });
        } catch (restoreError) {
          throw aggregateLockErrors(
            "LOCK_ARTIFACT_RESTORE_FAILED",
            `${description} validation and exact restoration both failed`,
            [error, restoreError],
          );
        }
        throw error;
      }
    }
    if (preserve) {
      await restoreQuarantinedArtifact({
        path,
        quarantineDirectory,
        quarantinePath,
        manifestPath,
        moved,
        durability,
      });
      return false;
    }

    await clearQuarantineDirectory({
      quarantineDirectory,
      quarantinePath,
      manifestPath,
      durability,
    });
    return true;
  } catch (error) {
    if (error instanceof OperationLockError) throw error;
    throw lockError(
      "LOCK_ARTIFACT_CLEANUP_FAILED",
      `could not quarantine exact ${description} ${path}`,
      error,
    );
  } finally {
    activeQuarantineDirectories.delete(quarantineDirectory);
  }
}

async function cleanupCreatedTemporary(path, metadata, durability) {
  if (metadata === undefined) return false;
  const removed = await removeExactArtifact({
    path,
    snapshot: { metadata },
    options: {},
    durability,
    description: "owned temporary artifact",
  });
  if (removed) await durability.syncDirectory(dirname(path));
  return removed;
}

async function readClaim(path, { allowMissing = false, predecessor = undefined } = {}) {
  const record = await readJsonFile(path, {
    allowMissing,
    description: "lock owner claim",
  });
  if (record === null) return null;
  const owner = validateOwnerRecord(record.value);
  if (predecessor !== undefined) {
    const expected = predecessor === null ? null : claimBinding(predecessor);
    const matches =
      owner.predecessor === null
        ? expected === null
        : expected !== null &&
          owner.predecessor.dev === expected.dev &&
          owner.predecessor.ino === expected.ino &&
          owner.predecessor.nonce === expected.nonce;
    if (!matches) {
      throw lockError(
        "LOCK_CHAIN_CORRUPT",
        `claim ${path} is not bound to its predecessor nonce and inode`,
      );
    }
  }
  return { ...record, owner, path, predecessorClaim: predecessor };
}

function successorPath(lockPath, nonce) {
  return `${lockPath}.successor.${nonce}`;
}

function releasePath(lockPath, nonce) {
  return `${lockPath}.released.${nonce}`;
}

function heartbeatFilePath(lockPath, nonce) {
  return `${lockPath}.heartbeat.${nonce}`;
}

function releaseRecord(claim, releasedAt) {
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    nonce: claim.owner.nonce,
    pid: claim.owner.pid,
    startedAt: claim.owner.startedAt,
    claim: {
      dev: String(claim.metadata.dev),
      ino: String(claim.metadata.ino),
    },
    releasedAt,
  };
}

function validateReleaseRecord(value, claim) {
  const code = "LOCK_RELEASE_MALFORMED";
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value, [
      "claim",
      "nonce",
      "pid",
      "releasedAt",
      "schemaVersion",
      "startedAt",
    ]) ||
    value.schemaVersion !== LOCK_SCHEMA_VERSION ||
    value.nonce !== claim.owner.nonce ||
    value.pid !== claim.owner.pid ||
    value.startedAt !== claim.owner.startedAt ||
    value.claim === null ||
    typeof value.claim !== "object" ||
    Array.isArray(value.claim) ||
    !exactKeys(value.claim, ["dev", "ino"]) ||
    value.claim.dev !== String(claim.metadata.dev) ||
    value.claim.ino !== String(claim.metadata.ino)
  ) {
    throw lockError(code, "release marker is not bound to its owner claim");
  }
  validateTimestamp(value.releasedAt, "releasedAt", code);
  return value;
}

function validateDetachedReleaseRecord(value, expectedNonce) {
  const code = "LOCK_RELEASE_STAGING_MALFORMED";
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value, [
      "claim",
      "nonce",
      "pid",
      "releasedAt",
      "schemaVersion",
      "startedAt",
    ]) ||
    value.schemaVersion !== LOCK_SCHEMA_VERSION ||
    value.nonce !== expectedNonce ||
    value.claim === null ||
    typeof value.claim !== "object" ||
    Array.isArray(value.claim) ||
    !exactKeys(value.claim, ["dev", "ino"]) ||
    typeof value.claim.dev !== "string" ||
    value.claim.dev.length === 0 ||
    typeof value.claim.ino !== "string" ||
    value.claim.ino.length === 0
  ) {
    throw lockError(code, "release staging record has an invalid claim binding");
  }
  validateIdentity(value, code);
  validateTimestamp(value.releasedAt, "releasedAt", code);
  return value;
}

async function readReleaseMarker(lockPath, claim) {
  const record = await readJsonFile(
    releasePath(lockPath, claim.owner.nonce),
    {
      allowMissing: true,
      malformedCode: "LOCK_RELEASE_MALFORMED",
      permissionsCode: "LOCK_RELEASE_PERMISSIONS",
      description: "lock release marker",
    },
  );
  if (record === null) return null;
  validateReleaseRecord(record.value, claim);
  return record;
}

async function findTail(lockPath) {
  let current = await readClaim(lockPath, {
    allowMissing: true,
    predecessor: null,
  });
  if (current === null) return { claims: [], depth: 0, tail: null };

  const seenInodes = new Set();
  const seenNonces = new Set();
  const claims = [];
  for (let depth = 1; depth <= MAX_CHAIN_LENGTH; depth += 1) {
    const inodeKey = `${current.metadata.dev}:${current.metadata.ino}`;
    if (seenInodes.has(inodeKey) || seenNonces.has(current.owner.nonce)) {
      throw lockError(
        "LOCK_CHAIN_CORRUPT",
        "operation-lock ownership chain contains a cycle or duplicate nonce",
      );
    }
    seenInodes.add(inodeKey);
    seenNonces.add(current.owner.nonce);
    claims.push(current);

    const next = await readClaim(
      successorPath(lockPath, current.owner.nonce),
      { allowMissing: true, predecessor: current },
    );
    if (next === null) return { claims, depth, tail: current };
    if (depth === MAX_CHAIN_LENGTH) {
      throw lockError(
        "LOCK_CHAIN_LIMIT",
        `operation-lock chain reached ${MAX_CHAIN_LENGTH} claims; run offline doctor maintenance with all related processes stopped`,
      );
    }
    current = next;
  }
  throw lockError("LOCK_CHAIN_CORRUPT", "operation-lock chain traversal failed");
}

function parseStagingArtifactName(lockPath, name) {
  const prefix = `${basename(lockPath)}.staging.`;
  if (!name.startsWith(prefix)) return null;
  const parts = name.slice(prefix.length).split(".");
  if (parts.length !== 2 || !/^[1-9][0-9]*$/u.test(parts[0])) return null;
  const pid = Number(parts[0]);
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !NONCE_PATTERN.test(parts[1])
  ) {
    return null;
  }
  return { nonce: parts[1], pid };
}

async function readStagingArtifact(path, expected) {
  try {
    const record = await readJsonFile(path, {
      allowMissing: true,
      malformedCode: "LOCK_STAGING_MALFORMED",
      permissionsCode: "LOCK_STAGING_PERMISSIONS",
      description: "lock staging artifact",
    });
    if (record === null) return null;
    const owner = validateOwnerRecord(record.value, "LOCK_STAGING_MALFORMED");
    if (owner.pid !== expected.pid || owner.nonce !== expected.nonce) return null;
    return { ...record, owner };
  } catch {
    return null;
  }
}

async function cleanupProvenDeadStaging({
  lockPath,
  parentPath,
  readProcessIdentity,
  durability,
  options,
}) {
  let entries;
  try {
    entries = await readdir(parentPath, { withFileTypes: true });
  } catch (error) {
    throw lockError(
      "LOCK_ARTIFACT_SCAN_FAILED",
      `could not scan lock artifacts in ${parentPath}`,
      error,
    );
  }

  let changed = false;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const expected = parseStagingArtifactName(lockPath, entry.name);
    if (expected === null) continue;
    const path = join(parentPath, entry.name);
    const initial = await readStagingArtifact(path, expected);
    if (initial === null) continue;

    let current;
    try {
      current = await probeOwner(initial.owner, readProcessIdentity);
    } catch {
      continue;
    }
    if (processStillOwnsRecord(initial.owner, current)) continue;

    const confirmed = await readStagingArtifact(path, expected);
    if (confirmed === null || !sameClaim(initial, confirmed)) continue;
    try {
      const rechecked = await probeOwner(confirmed.owner, readProcessIdentity);
      if (processStillOwnsRecord(confirmed.owner, rechecked)) continue;
    } catch {
      continue;
    }
    try {
      changed = (await removeExactArtifact({
        path,
        snapshot: confirmed,
        options,
        durability,
        description: "proven-dead staging artifact",
      })) || changed;
    } catch (error) {
      if (error instanceof OperationLockError) throw error;
      throw lockError(
        "LOCK_ARTIFACT_CLEANUP_FAILED",
        `could not remove proven-dead staging artifact ${path}`,
        error,
      );
    }
  }
  if (changed) await durability.syncDirectory(parentPath);
}

function parseCheckpointArtifactName(lockPath, name) {
  const prefix = `${basename(lockPath)}.checkpoint.`;
  if (!name.startsWith(prefix)) return null;
  const parts = name.slice(prefix.length).split(".");
  if (parts.length !== 2 || !/^[1-9][0-9]*$/u.test(parts[0])) return null;
  const pid = Number(parts[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !NONCE_PATTERN.test(parts[1])) {
    return null;
  }
  return { kind: "checkpoint", nonce: parts[1], pid };
}

function parseReleaseStagingArtifactName(lockPath, name) {
  const prefix = `${basename(lockPath)}.released.`;
  if (!name.startsWith(prefix)) return null;
  const remainder = name.slice(prefix.length);
  const marker = ".staging.";
  const markerIndex = remainder.indexOf(marker);
  if (
    markerIndex <= 0 ||
    markerIndex !== remainder.lastIndexOf(marker)
  ) {
    return null;
  }
  const claimNonce = remainder.slice(0, markerIndex);
  const producerNonce = remainder.slice(markerIndex + marker.length);
  if (
    !NONCE_PATTERN.test(claimNonce) ||
    !NONCE_PATTERN.test(producerNonce)
  ) {
    return null;
  }
  return { claimNonce, kind: "release-staging", producerNonce };
}

async function readCrashArtifact(path, expected) {
  try {
    const record = await readJsonFile(path, {
      allowMissing: true,
      malformedCode: "LOCK_ARTIFACT_MALFORMED",
      permissionsCode: "LOCK_ARTIFACT_PERMISSIONS",
      description: `${expected.kind} artifact`,
    });
    if (record === null) return null;
    if (expected.kind === "checkpoint") {
      const owner = validateOwnerRecord(record.value, "LOCK_CHECKPOINT_MALFORMED");
      if (
        owner.pid !== expected.pid ||
        owner.nonce !== expected.nonce ||
        owner.predecessor !== null
      ) {
        return null;
      }
      return { ...record, identity: owner };
    }
    const release = validateDetachedReleaseRecord(
      record.value,
      expected.claimNonce,
    );
    return { ...record, identity: release };
  } catch {
    return null;
  }
}

async function cleanupProvenDeadCrashArtifacts({
  lockPath,
  parentPath,
  readProcessIdentity,
  durability,
  options,
}) {
  let entries;
  try {
    entries = await readdir(parentPath, { withFileTypes: true });
  } catch (error) {
    throw lockError(
      "LOCK_ARTIFACT_SCAN_FAILED",
      `could not scan crash artifacts in ${parentPath}`,
      error,
    );
  }

  let changed = false;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const expected =
      parseCheckpointArtifactName(lockPath, entry.name) ??
      parseReleaseStagingArtifactName(lockPath, entry.name);
    if (expected === null) continue;
    const path = join(parentPath, entry.name);
    const initial = await readCrashArtifact(path, expected);
    if (initial === null) continue;

    let current;
    try {
      current = await probeOwner(initial.identity, readProcessIdentity);
    } catch {
      continue;
    }
    if (processStillOwnsRecord(initial.identity, current)) continue;

    const confirmed = await readCrashArtifact(path, expected);
    if (confirmed === null || !sameFileSnapshot(initial, confirmed)) continue;
    try {
      const rechecked = await probeOwner(confirmed.identity, readProcessIdentity);
      if (processStillOwnsRecord(confirmed.identity, rechecked)) continue;
    } catch {
      continue;
    }
    changed = (await removeExactArtifact({
      path,
      snapshot: confirmed,
      options,
      durability,
      description: `proven-dead ${expected.kind} artifact`,
    })) || changed;
  }
  if (changed) await durability.syncDirectory(parentPath);
}

function parseFinalArtifactName(lockPath, name) {
  const base = basename(lockPath);
  for (const [kind, marker] of [
    ["successor", `${base}.successor.`],
    ["heartbeat", `${base}.heartbeat.`],
    ["release", `${base}.released.`],
  ]) {
    if (!name.startsWith(marker)) continue;
    const nonce = name.slice(marker.length);
    if (!NONCE_PATTERN.test(nonce)) return null;
    return { kind, nonce };
  }
  return null;
}

async function readFinalArtifact(path, expected) {
  try {
    const record = await readJsonFile(path, {
      allowMissing: true,
      malformedCode: "LOCK_FINAL_ARTIFACT_MALFORMED",
      permissionsCode: "LOCK_FINAL_ARTIFACT_PERMISSIONS",
      description: `final ${expected.kind} artifact`,
    });
    if (record === null) return null;
    if (expected.kind === "successor") {
      const owner = validateOwnerRecord(
        record.value,
        "LOCK_FINAL_ARTIFACT_MALFORMED",
      );
      if (
        owner.predecessor === null ||
        owner.predecessor.nonce !== expected.nonce
      ) {
        return null;
      }
      return { ...record, expected, owner, path };
    }
    if (expected.kind === "heartbeat") {
      const heartbeat = validateHeartbeatRecord(record.value, expected.nonce);
      return { ...record, expected, heartbeat, path };
    }
    const release = validateDetachedReleaseRecord(record.value, expected.nonce);
    return { ...record, expected, path, release };
  } catch {
    return null;
  }
}

function finalArtifactMatchesReachable(artifact, chain) {
  if (artifact.expected.kind === "successor") {
    return chain.claims.some((claim) => claim.path === artifact.path);
  }
  return chain.claims.some((claim) =>
    claim.owner.nonce === artifact.expected.nonce);
}

function finalArtifactCouldBeReachableAfterMove(artifact, chain) {
  if (artifact.expected.kind === "successor") {
    return chain.claims.some((claim) =>
      claim.owner.nonce === artifact.owner.predecessor.nonce);
  }
  return chain.claims.some((claim) =>
    claim.owner.nonce === artifact.expected.nonce);
}

async function cleanupUnreachableFinalArtifacts({
  lockPath,
  parentPath,
  durability,
  options,
}) {
  let entries;
  try {
    entries = await readdir(parentPath, { withFileTypes: true });
  } catch (error) {
    throw lockError(
      "LOCK_ARTIFACT_SCAN_FAILED",
      `could not scan final lock artifacts in ${parentPath}`,
      error,
    );
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const expected = parseFinalArtifactName(lockPath, entry.name);
    if (expected === null) continue;
    const path = join(parentPath, entry.name);
    const initial = await readFinalArtifact(path, expected);
    if (initial === null) continue;
    const initialChain = await findTail(lockPath);
    if (finalArtifactMatchesReachable(initial, initialChain)) continue;

    const confirmed = await readFinalArtifact(path, expected);
    if (confirmed === null || !sameFileSnapshot(initial, confirmed)) continue;
    const latestChain = await findTail(lockPath);
    if (finalArtifactMatchesReachable(confirmed, latestChain)) continue;

    await removeExactArtifact({
      path,
      snapshot: confirmed,
      options,
      durability,
      description: `unreachable final ${expected.kind} artifact`,
      preserveAfterMove: async () => {
        const postMoveChain = await findTail(lockPath);
        return finalArtifactCouldBeReachableAfterMove(
          confirmed,
          postMoveChain,
        );
      },
    });
  }
}

function parseQuarantineDirectoryName(name) {
  const prefix = ".operation-lock-gc.";
  if (!name.startsWith(prefix)) return null;
  const parts = name.slice(prefix.length).split(".");
  if (parts.length !== 2 || !/^[1-9][0-9]*$/u.test(parts[0])) return null;
  const pid = Number(parts[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !NONCE_PATTERN.test(parts[1])) {
    return null;
  }
  return { nonce: parts[1], pid };
}

async function readPrivateArtifactSnapshot(path, { allowMissing = false } = {}) {
  let metadata;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return null;
    throw error;
  }
  requirePrivateFile(metadata, "LOCK_ARTIFACT_PERMISSIONS", `artifact ${path}`);
  return {
    metadata: { dev: metadata.dev, ino: metadata.ino },
    raw: await readFile(path, "utf8"),
  };
}

function validateQuarantineManifest(value, lockPath) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value, ["expected", "originalName", "schemaVersion"]) ||
    value.schemaVersion !== QUARANTINE_SCHEMA_VERSION ||
    typeof value.originalName !== "string" ||
    value.originalName !== basename(value.originalName) ||
    !value.originalName.startsWith(`${basename(lockPath)}.`) ||
    value.expected === null ||
    typeof value.expected !== "object" ||
    Array.isArray(value.expected) ||
    !exactKeys(value.expected, ["dev", "ino"]) ||
    typeof value.expected.dev !== "string" ||
    value.expected.dev.length === 0 ||
    typeof value.expected.ino !== "string" ||
    value.expected.ino.length === 0
  ) {
    throw lockError(
      "LOCK_QUARANTINE_MALFORMED",
      "artifact quarantine manifest has an invalid schema",
    );
  }
  return value;
}

async function readQuarantineContents(path, lockPath) {
  const entries = await readdir(path, { withFileTypes: true });
  if (
    entries.some((entry) =>
      !entry.isFile() || !["artifact", "manifest"].includes(entry.name))
  ) {
    return null;
  }
  const artifact = await readPrivateArtifactSnapshot(
    join(path, "artifact"),
    { allowMissing: true },
  );
  const manifestRecord = await readJsonFile(join(path, "manifest"), {
    allowMissing: true,
    malformedCode: "LOCK_QUARANTINE_MALFORMED",
    permissionsCode: "LOCK_QUARANTINE_PERMISSIONS",
    description: "artifact quarantine manifest",
  });
  const manifest =
    manifestRecord === null
      ? null
      : validateQuarantineManifest(manifestRecord.value, lockPath);
  return { artifact, manifest, manifestRecord };
}

function sameOptionalFileSnapshot(left, right) {
  if (left === null || right === null) return left === right;
  return sameFileSnapshot(left, right);
}

function sameQuarantineContents(left, right) {
  return (
    sameOptionalFileSnapshot(left.artifact, right.artifact) &&
    sameOptionalFileSnapshot(left.manifestRecord, right.manifestRecord)
  );
}

async function quarantineProducerIsLive(pid, readProcessIdentity) {
  if (pid === process.pid) return false;
  if (typeof readProcessIdentity !== "function") return true;
  try {
    const current = await readProcessIdentity(pid);
    if (current === null || current === undefined) return false;
    return validateIdentity(current, "LOCK_PROCESS_PROBE_INVALID").pid === pid;
  } catch {
    return true;
  }
}

async function allocateQuarantineTombstone(parentPath) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const path = join(
      parentPath,
      `.operation-lock-gc.${process.pid}.${createNonce()}`,
    );
    if ((await lstatIfPresent(path)) === null) return path;
  }
  throw lockError(
    "LOCK_ARTIFACT_CLEANUP_FAILED",
    "could not allocate a quarantine directory tombstone",
  );
}

async function restoreQuarantineDirectory(tombstonePath, originalPath) {
  try {
    await rename(tombstonePath, originalPath);
  } catch {
    // A conflicting directory is preserved alongside this current-process
    // tombstone. A later process can re-evaluate both without data loss.
  }
}

async function cleanupOrphanQuarantines({
  lockPath,
  parentPath,
  readProcessIdentity,
  durability,
}) {
  const entries = await readdir(parentPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const producer = parseQuarantineDirectoryName(entry.name);
    if (producer === null) continue;
    const originalDirectory = join(parentPath, entry.name);
    if (activeQuarantineDirectories.has(originalDirectory)) continue;
    if (await quarantineProducerIsLive(producer.pid, readProcessIdentity)) continue;
    let initialDirectory;
    let initialContents;
    try {
      initialDirectory = await lstat(originalDirectory, { bigint: true });
      requirePrivateDirectory(
        initialDirectory,
        `artifact quarantine ${originalDirectory}`,
      );
      initialContents = await readQuarantineContents(originalDirectory, lockPath);
    } catch {
      continue;
    }
    if (initialContents === null) continue;
    const confirmedDirectory = await lstatIfPresent(originalDirectory);
    if (
      confirmedDirectory === null ||
      confirmedDirectory.dev !== initialDirectory.dev ||
      confirmedDirectory.ino !== initialDirectory.ino ||
      await quarantineProducerIsLive(producer.pid, readProcessIdentity)
    ) {
      continue;
    }

    const tombstoneDirectory = await allocateQuarantineTombstone(parentPath);
    activeQuarantineDirectories.add(tombstoneDirectory);
    try {
      await rename(originalDirectory, tombstoneDirectory);
    } catch (error) {
      activeQuarantineDirectories.delete(tombstoneDirectory);
      if (error.code === "ENOENT") continue;
      throw lockError(
        "LOCK_ARTIFACT_CLEANUP_FAILED",
        `could not claim orphan quarantine ${originalDirectory}`,
        error,
      );
    }
    await durability.syncDirectory(parentPath);

    try {
      const movedDirectory = await lstat(tombstoneDirectory, { bigint: true });
      if (
        movedDirectory.dev !== initialDirectory.dev ||
        movedDirectory.ino !== initialDirectory.ino
      ) {
        await restoreQuarantineDirectory(tombstoneDirectory, originalDirectory);
        throw lockError(
          "LOCK_ARTIFACT_CHANGED",
          `orphan quarantine ${originalDirectory} changed before collection`,
        );
      }
      const confirmedContents = await readQuarantineContents(
        tombstoneDirectory,
        lockPath,
      );
      if (
        confirmedContents === null ||
        !sameQuarantineContents(initialContents, confirmedContents)
      ) {
        await restoreQuarantineDirectory(tombstoneDirectory, originalDirectory);
        continue;
      }

      const artifactPath = join(tombstoneDirectory, "artifact");
      if (
        confirmedContents.artifact !== null &&
        confirmedContents.manifest !== null
      ) {
        const manifest = confirmedContents.manifest;
        const manifestPath = join(tombstoneDirectory, "manifest");
        const originalPath = join(parentPath, manifest.originalName);
        const existing = await lstatIfPresent(originalPath);
        if (
          existing !== null &&
          (existing.dev !== confirmedContents.artifact.metadata.dev ||
            existing.ino !== confirmedContents.artifact.metadata.ino)
        ) {
          await restoreQuarantineDirectory(tombstoneDirectory, originalDirectory);
          continue;
        }
        const rebuildChainOrRestore = async () => {
          try {
            return await findTail(lockPath);
          } catch (error) {
            try {
              await restoreQuarantinedArtifact({
                path: originalPath,
                quarantineDirectory: tombstoneDirectory,
                quarantinePath: artifactPath,
                manifestPath,
                moved: confirmedContents.artifact.metadata,
                durability,
              });
            } catch (restoreError) {
              throw aggregateLockErrors(
                "LOCK_ARTIFACT_RESTORE_FAILED",
                "orphan quarantine validation and canonical restoration both failed",
                [error, restoreError],
              );
            }
            throw error;
          }
        };
        const expectedInodeMatches =
          manifest.expected.dev === String(confirmedContents.artifact.metadata.dev) &&
          manifest.expected.ino === String(confirmedContents.artifact.metadata.ino);
        if (!expectedInodeMatches) {
          if (existing === null) {
            await link(artifactPath, originalPath);
            await durability.syncDirectory(parentPath);
          }
          await rebuildChainOrRestore();
        } else if (existing === null) {
          const expected = parseFinalArtifactName(lockPath, manifest.originalName);
          if (expected !== null) {
            const artifact = await readFinalArtifact(artifactPath, expected);
            if (artifact === null) {
              await restoreQuarantinedArtifact({
                path: originalPath,
                quarantineDirectory: tombstoneDirectory,
                quarantinePath: artifactPath,
                manifestPath,
                moved: confirmedContents.artifact.metadata,
                durability,
              });
              throw lockError(
                "LOCK_FINAL_ARTIFACT_MALFORMED",
                `quarantined final artifact ${manifest.originalName} changed schema before recovery`,
              );
            }
            const latestChain = await rebuildChainOrRestore();
            if (finalArtifactCouldBeReachableAfterMove(artifact, latestChain)) {
              await link(artifactPath, originalPath);
              await durability.syncDirectory(parentPath);
            }
          } else {
            await findTail(lockPath);
          }
        } else {
          await rebuildChainOrRestore();
        }
      } else {
        // Manifest-less directories predate durable quarantine manifests and
        // were used only for temporary artifacts. Rebuild the live chain
        // immediately before collecting their unreachable extra link.
        await findTail(lockPath);
      }

      await clearQuarantineDirectory({
        quarantineDirectory: tombstoneDirectory,
        quarantinePath: artifactPath,
        manifestPath: join(tombstoneDirectory, "manifest"),
        durability,
      });
    } catch (error) {
      if (error instanceof OperationLockError) throw error;
      await restoreQuarantineDirectory(tombstoneDirectory, originalDirectory);
      throw lockError(
        "LOCK_ARTIFACT_CLEANUP_FAILED",
        `could not collect orphan quarantine ${originalDirectory}`,
        error,
      );
    } finally {
      activeQuarantineDirectories.delete(tombstoneDirectory);
    }
  }
}

function parseHeartbeatTemporaryName(lockPath, name) {
  const prefix = `${basename(lockPath)}.heartbeat.`;
  if (!name.startsWith(prefix)) return null;
  const remainder = name.slice(prefix.length);
  const marker = ".tmp.";
  const markerIndex = remainder.indexOf(marker);
  if (
    markerIndex <= 0 ||
    markerIndex !== remainder.lastIndexOf(marker)
  ) {
    return null;
  }
  const nonce = remainder.slice(0, markerIndex);
  const temporaryNonce = remainder.slice(markerIndex + marker.length);
  if (!NONCE_PATTERN.test(nonce) || !NONCE_PATTERN.test(temporaryNonce)) {
    return null;
  }
  return { nonce };
}

function validateHeartbeatRecord(value, expectedNonce) {
  const code = "LOCK_HEARTBEAT_MALFORMED";
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value, [
      "claim",
      "heartbeat",
      "nonce",
      "pid",
      "schemaVersion",
      "startedAt",
    ]) ||
    value.schemaVersion !== LOCK_SCHEMA_VERSION ||
    value.nonce !== expectedNonce ||
    value.claim === null ||
    typeof value.claim !== "object" ||
    Array.isArray(value.claim) ||
    !exactKeys(value.claim, ["dev", "ino"]) ||
    typeof value.claim.dev !== "string" ||
    value.claim.dev.length === 0 ||
    typeof value.claim.ino !== "string" ||
    value.claim.ino.length === 0
  ) {
    throw lockError(code, "heartbeat artifact has an invalid claim binding");
  }
  validateIdentity(value, code);
  validateTimestamp(value.heartbeat, "heartbeat", code);
  return value;
}

async function readHeartbeatTemporary(path, expected) {
  try {
    const record = await readJsonFile(path, {
      allowMissing: true,
      malformedCode: "LOCK_HEARTBEAT_MALFORMED",
      permissionsCode: "LOCK_HEARTBEAT_PERMISSIONS",
      description: "lock heartbeat temporary artifact",
    });
    if (record === null) return null;
    const heartbeat = validateHeartbeatRecord(record.value, expected.nonce);
    return { ...record, heartbeat };
  } catch {
    return null;
  }
}

function heartbeatMatchesClaim(heartbeat, claim) {
  return (
    heartbeat.nonce === claim.owner.nonce &&
    heartbeat.pid === claim.owner.pid &&
    heartbeat.startedAt === claim.owner.startedAt &&
    heartbeat.claim.dev === String(claim.metadata.dev) &&
    heartbeat.claim.ino === String(claim.metadata.ino)
  );
}

function sameHeartbeatSnapshot(left, right) {
  return (
    left.raw === right.raw &&
    left.metadata.dev === right.metadata.dev &&
    left.metadata.ino === right.metadata.ino
  );
}

async function heartbeatIsProvenOrphan({
  lockPath,
  artifact,
  chain,
  readProcessIdentity,
}) {
  const claim = chain.claims.find((candidate) =>
    heartbeatMatchesClaim(artifact.heartbeat, candidate),
  );
  if (claim !== undefined) {
    if (claim !== chain.tail) return true;
    if ((await readReleaseMarker(lockPath, claim)) !== null) return true;
  }

  let current;
  try {
    current = await probeOwner(artifact.heartbeat, readProcessIdentity);
  } catch {
    return false;
  }
  if (processStillOwnsRecord(artifact.heartbeat, current)) return false;
  return claim === undefined || claim === chain.tail;
}

async function cleanupProvenOrphanHeartbeats({
  lockPath,
  parentPath,
  readProcessIdentity,
  durability,
  options,
}) {
  let entries;
  try {
    entries = await readdir(parentPath, { withFileTypes: true });
  } catch (error) {
    throw lockError(
      "LOCK_ARTIFACT_SCAN_FAILED",
      `could not scan lock artifacts in ${parentPath}`,
      error,
    );
  }
  const chain = await findTail(lockPath);
  let changed = false;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const expected = parseHeartbeatTemporaryName(lockPath, entry.name);
    if (expected === null) continue;
    const path = join(parentPath, entry.name);
    const initial = await readHeartbeatTemporary(path, expected);
    if (initial === null) continue;
    if (
      !(await heartbeatIsProvenOrphan({
        lockPath,
        artifact: initial,
        chain,
        readProcessIdentity,
      }))
    ) {
      continue;
    }
    const confirmed = await readHeartbeatTemporary(path, expected);
    if (
      confirmed === null ||
      !sameHeartbeatSnapshot(initial, confirmed)
    ) {
      continue;
    }
    try {
      changed = (await removeExactArtifact({
        path,
        snapshot: confirmed,
        options,
        durability,
        description: "proven-orphan heartbeat artifact",
      })) || changed;
    } catch (error) {
      if (error instanceof OperationLockError) throw error;
      throw lockError(
        "LOCK_ARTIFACT_CLEANUP_FAILED",
        `could not remove proven-orphan heartbeat artifact ${path}`,
        error,
      );
    }
  }
  if (changed) await durability.syncDirectory(parentPath);
}

async function probeOwner(owner, readProcessIdentity) {
  if (typeof readProcessIdentity !== "function") {
    throw lockError(
      "LOCK_PROCESS_PROBE_REQUIRED",
      "readProcessIdentity is required to recover an existing owner",
    );
  }
  let current;
  try {
    current = await readProcessIdentity(owner.pid);
  } catch (error) {
    throw lockError(
      "LOCK_PROCESS_PROBE_FAILED",
      `could not probe lock owner pid ${owner.pid}`,
      error,
    );
  }
  if (current === null || current === undefined) return null;
  const identity = validateIdentity(current, "LOCK_PROCESS_PROBE_INVALID");
  if (identity.pid !== owner.pid) {
    throw lockError(
      "LOCK_PROCESS_PROBE_INVALID",
      `process probe returned pid ${identity.pid} for requested pid ${owner.pid}`,
    );
  }
  return identity;
}

function processStillOwnsRecord(owner, current) {
  return current !== null && current.startedAt === owner.startedAt;
}

async function runStage(options, stage, context = undefined) {
  if (options.faultAt === stage) {
    throw lockError(
      `FAULT_${stage.toUpperCase().replaceAll("-", "_")}`,
      `injected failure at ${stage}`,
    );
  }
  const hook = options.testHooks?.[stage];
  if (hook !== undefined) {
    if (typeof hook !== "function") {
      throw lockError("LOCK_HOOK_INVALID", `test hook ${stage} must be a function`);
    }
    await hook(context);
  }
}

async function publishBoundRecord({
  finalPath,
  record,
  stagingPath,
  durability,
}) {
  let metadata;
  try {
    try {
      metadata = await writeSyncedExclusiveFile(
        stagingPath,
        serializeJson(record),
      );
      await link(stagingPath, finalPath);
    } catch (error) {
      if (error.code === "EEXIST") {
        return { existing: true, metadata };
      }
      throw lockError(
        "LOCK_PUBLISH_FAILED",
        `could not atomically publish ${finalPath} with a same-filesystem hard link`,
        error,
      );
    }
    await durability.syncDirectory(dirname(finalPath));
    return { existing: false, metadata };
  } finally {
    if (metadata !== undefined) {
      await cleanupCreatedTemporary(
        stagingPath,
        metadata,
        durability,
      ).catch(() => false);
    }
  }
}

async function publishReleaseMarker({
  lockPath,
  claim,
  now,
  durability,
  options,
  rollback = false,
}) {
  if (rollback) await runStage(options, "before-rollback", { claim });
  const finalPath = releasePath(lockPath, claim.owner.nonce);
  const stagingPath = `${finalPath}.staging.${createNonce()}`;
  const value = releaseRecord(claim, timestampFrom(now));
  const publication = await publishBoundRecord({
    finalPath,
    record: value,
    stagingPath,
    durability,
  });
  if (publication.existing) {
    const existing = await readReleaseMarker(lockPath, claim);
    if (existing === null) {
      throw lockError(
        "LOCK_RELEASE_FAILED",
        "release marker disappeared during idempotent release",
      );
    }
    return false;
  }
  return true;
}

async function assertClaimOwned(lockPath, expected) {
  try {
    const chain = await findTail(lockPath);
    if (chain.tail === null || !sameClaim(chain.tail, expected)) {
      throw notOwnedError(
        "owner claim is no longer the reachable ownership-chain tail",
        { definitive: true },
      );
    }
    const released = await readReleaseMarker(lockPath, expected);
    if (released !== null) {
      throw notOwnedError("owner claim has been released", {
        definitive: true,
      });
    }
    return true;
  } catch (error) {
    if (error instanceof OperationLockError && error.code === "LOCK_NOT_OWNED") {
      throw error;
    }
    throw notOwnedError("could not prove this lease still owns the tail claim", {
      cause: error,
    });
  }
}

function heartbeatRecord(claim, heartbeat) {
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    nonce: claim.owner.nonce,
    pid: claim.owner.pid,
    startedAt: claim.owner.startedAt,
    claim: {
      dev: String(claim.metadata.dev),
      ino: String(claim.metadata.ino),
    },
    heartbeat,
  };
}

async function writeHeartbeat({ lockPath, claim, heartbeat, durability }) {
  await assertClaimOwned(lockPath, claim);
  const finalPath = heartbeatFilePath(lockPath, claim.owner.nonce);
  const temporaryPath = `${finalPath}.tmp.${createNonce()}`;
  let renamed = false;
  let temporaryMetadata;
  try {
    temporaryMetadata = await writeSyncedExclusiveFile(
      temporaryPath,
      serializeJson(heartbeatRecord(claim, heartbeat)),
    );
    await assertClaimOwned(lockPath, claim);
    await rename(temporaryPath, finalPath);
    renamed = true;
    await durability.syncDirectory(dirname(lockPath));
    await assertClaimOwned(lockPath, claim);
  } catch (error) {
    if (error instanceof OperationLockError) throw error;
    throw lockError(
      "LOCK_HEARTBEAT_FAILED",
      `could not publish heartbeat for ${lockPath}`,
      error,
    );
  } finally {
    if (!renamed && temporaryMetadata !== undefined) {
      await cleanupCreatedTemporary(
        temporaryPath,
        temporaryMetadata,
        durability,
      ).catch(() => false);
    }
  }
  return finalPath;
}

function createLease({
  lockPath,
  stateRoot,
  claim,
  now,
  durability,
  options,
  chainDepth,
}) {
  const heartbeatPath = heartbeatFilePath(lockPath, claim.owner.nonce);
  const publicOwner = {
    ...claim.owner,
    predecessor:
      claim.owner.predecessor === null
        ? null
        : Object.freeze({ ...claim.owner.predecessor }),
  };
  let lease;
  lease = Object.freeze({
    chainDepth,
    heartbeatPath,
    lockPath,
    nonce: claim.owner.nonce,
    owner: Object.freeze(publicOwner),
    async assertOwned() {
      return assertClaimOwned(lockPath, claim);
    },
    async heartbeat() {
      const heartbeat = timestampFrom(now);
      await writeHeartbeat({ lockPath, claim, heartbeat, durability });
      return heartbeat;
    },
    async release() {
      return releaseOperationLease(lease);
    },
  });
  leaseCapabilities.set(lease, {
    claim,
    commitTail: Promise.resolve(),
    durability,
    lifecycle: "active",
    lockPath,
    now,
    options,
    releasePromise: null,
    stateRoot,
  });
  return lease;
}

function requireLeaseCapability(lease) {
  const capability =
    lease !== null && typeof lease === "object"
      ? leaseCapabilities.get(lease)
      : undefined;
  if (
    capability === undefined ||
    capability.lockPath !== join(capability.stateRoot, "operation.lock")
  ) {
    throw lockError(
      "LOCK_CAPABILITY_INVALID",
      "a genuine operation lease for the unique trusted state-root lock is required",
    );
  }
  return capability;
}

export function assertOperationLeaseCapability(lease) {
  const capability = requireLeaseCapability(lease);
  return Object.freeze({
    lockPath: capability.lockPath,
    stateRoot: capability.stateRoot,
  });
}

async function assertCapabilityOwned(capability) {
  if (capability.provider === "windows") {
    return assertWindowsClaimOwned(capability);
  }
  await verifyRealDirectoryAncestors(capability.stateRoot);
  const rootMetadata = await lstat(capability.stateRoot, { bigint: true });
  requirePrivateDirectory(rootMetadata, `trusted stateRoot ${capability.stateRoot}`);
  return assertClaimOwned(capability.lockPath, capability.claim);
}

export async function guardOperationLease(lease) {
  const capability = requireLeaseCapability(lease);
  if (capability.lifecycle !== "active") {
    throw notOwnedError("lease release has already started", { definitive: true });
  }
  await assertCapabilityOwned(capability);
  return Object.freeze({
    lockPath: capability.lockPath,
    stateRoot: capability.stateRoot,
  });
}

export function commitWithOperationLease(lease, commit) {
  if (typeof commit !== "function") {
    throw lockError("LOCK_COMMIT_INVALID", "lease commit callback must be a function");
  }
  const capability = requireLeaseCapability(lease);
  if (capability.lifecycle !== "active") {
    throw notOwnedError("lease release has already started", { definitive: true });
  }

  const previous = capability.commitTail;
  const operation = (async () => {
    await previous;
    await assertCapabilityOwned(capability);
    const context = {
      active: true,
      capability,
      parent: activeCommitContext.getStore() ?? null,
    };
    try {
      return await activeCommitContext.run(context, commit);
    } finally {
      context.active = false;
    }
  })();
  capability.commitTail = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

function releaseOperationLease(lease) {
  const capability = requireLeaseCapability(lease);
  for (
    let commitContext = activeCommitContext.getStore() ?? null;
    commitContext !== null;
    commitContext = commitContext.parent
  ) {
    if (
      commitContext.active === true &&
      commitContext.capability === capability
    ) {
      return Promise.reject(lockError(
        "LOCK_COMMIT_RELEASE_REENTRANT",
        "an operation lease cannot be released from inside its active commit callback",
      ));
    }
  }
  if (capability.releasePromise !== null) return capability.releasePromise;
  if (capability.lifecycle === "active") capability.lifecycle = "releasing";
  const releaseAttempt = (async () => {
    await capability.commitTail;
    try {
      await runStage(capability.options, "before-release", {
        claim: capability.claim,
      });
      if (capability.provider === "windows") {
        await assertWindowsClaimOwned(capability);
        const releasePath = join(
          capability.stateRoot,
          `${WINDOWS_ARTIFACT_PREFIX}${basename(capability.lockPath)}.released.${capability.claim.owner.nonce}.${createNonce()}`,
        );
        try {
          await rename(capability.lockPath, releasePath);
        } catch (cause) {
          throw notOwnedError("Windows owner directory changed before release", {
            cause,
            definitive: cause?.code === "ENOENT",
          });
        }
        await runStage(capability.options, "after-windows-release-rename", {
          claim: capability.claim,
          releasePath,
        });
        const moved = await readWindowsOwnerDirectory(releasePath, capability.security);
        if (!sameWindowsClaim(capability.claim, moved)) {
          throw notOwnedError("Windows owner directory changed during release", {
            definitive: true,
          });
        }
        await removeWindowsClaimDirectory(releasePath, moved, capability.security);
        capability.lifecycle = "released";
        return true;
      }
      await assertClaimOwned(capability.lockPath, capability.claim);
      const released = await publishReleaseMarker({
        lockPath: capability.lockPath,
        claim: capability.claim,
        now: capability.now,
        durability: capability.durability,
        options: capability.options,
      });
      capability.lifecycle = "released";
      return released;
    } catch (error) {
      if (
        error instanceof OperationLockError &&
        error.code === "LOCK_NOT_OWNED" &&
        error.ownershipLost === true
      ) {
        capability.lifecycle = "released";
        return false;
      }
      if (error instanceof OperationLockError && error.code === "LOCK_RELEASE_FAILED") {
        throw error;
      }
      throw lockError(
        "LOCK_RELEASE_FAILED",
        `could not release operation lock claim ${capability.claim.owner.nonce}`,
        error,
      );
    }
  })();
  capability.releasePromise = releaseAttempt;
  void releaseAttempt.catch(() => {
    if (
      capability.releasePromise === releaseAttempt &&
      capability.lifecycle === "releasing"
    ) {
      capability.releasePromise = null;
    }
  });
  return releaseAttempt;
}

function ownerRecord({
  identity,
  operation,
  timestamp,
  predecessor,
  excludedNonces = [],
}) {
  const excluded = new Set(excludedNonces);
  let nonce;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    nonce = createNonce();
    if (!excluded.has(nonce)) break;
    nonce = undefined;
  }
  if (nonce === undefined) {
    throw lockError(
      "LOCK_NONCE_FAILED",
      "could not create a nonce distinct from the ownership chain",
    );
  }
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    nonce,
    pid: identity.pid,
    operation,
    startedAt: identity.startedAt,
    createdAt: timestamp,
    heartbeat: timestamp,
    predecessor: predecessor === null ? null : claimBinding(predecessor),
  };
}

function attachPredecessorClaim(claim, predecessor) {
  return {
    ...claim,
    predecessorClaim: predecessor,
  };
}

function validateCompactionThreshold(value) {
  const threshold = value ?? DEFAULT_COMPACTION_THRESHOLD;
  if (
    !Number.isSafeInteger(threshold) ||
    threshold < 2 ||
    threshold > MAX_CHAIN_LENGTH
  ) {
    throw lockError(
      "LOCK_COMPACTION_THRESHOLD_INVALID",
      `compactionThreshold must be an integer from 2 to ${MAX_CHAIN_LENGTH}`,
    );
  }
  return threshold;
}

async function cleanupCompactedChain({
  lockPath,
  durability,
  options,
}) {
  try {
    await cleanupUnreachableFinalArtifacts({
      lockPath,
      parentPath: dirname(lockPath),
      durability,
      options,
    });
  } catch (error) {
    throw lockError(
      "LOCK_COMPACTION_CLEANUP_FAILED",
      "could not durably remove the captured unreachable ownership chain",
      error,
    );
  }
}

async function compactOwnershipChain({
  lockPath,
  chain,
  identity,
  operation,
  now,
  durability,
  options,
}) {
  const timestamp = timestampFrom(now);
  const checkpointOwner = ownerRecord({
    identity,
    operation,
    timestamp,
    predecessor: null,
    excludedNonces: chain.claims.map((claim) => claim.owner.nonce),
  });
  const stagingPath = `${lockPath}.checkpoint.${identity.pid}.${checkpointOwner.nonce}`;
  const raw = serializeJson(checkpointOwner);
  let renamed = false;
  let checkpointClaim;
  let stagingMetadata;
  try {
    stagingMetadata = await writeSyncedExclusiveFile(stagingPath, raw);
    await runStage(options, "before-compact-rename", { chain });
    await assertClaimOwned(lockPath, chain.tail);
    await runStage(options, "after-compact-final-check", { chain });
    try {
      await rename(stagingPath, lockPath);
    } catch (error) {
      throw lockError(
        "LOCK_COMPACTION_RENAME_FAILED",
        "could not atomically publish ownership checkpoint",
        error,
      );
    }
    renamed = true;
    checkpointClaim = attachPredecessorClaim(
      {
        metadata: stagingMetadata,
        owner: checkpointOwner,
        path: lockPath,
        raw,
      },
      null,
    );
    await runStage(options, "after-compact-rename", { checkpointClaim });
    await durability.syncDirectory(dirname(lockPath));
    await runStage(options, "after-compact-sync", { checkpointClaim });

    const confirmed = await readClaim(lockPath, { predecessor: null });
    if (!sameClaim(checkpointClaim, confirmed)) {
      throw lockError(
        "LOCK_COMPACTION_VERIFY_FAILED",
        "published ownership checkpoint changed before verification",
      );
    }
    checkpointClaim = attachPredecessorClaim(confirmed, null);
    await cleanupCompactedChain({
      lockPath,
      durability,
      options,
    });
    await runStage(options, "after-compact-cleanup", { checkpointClaim });
    await assertClaimOwned(lockPath, checkpointClaim);
    return checkpointClaim;
  } catch (error) {
    if (!renamed) throw error;
    try {
      await publishReleaseMarker({
        lockPath,
        claim: checkpointClaim,
        now,
        durability,
        options,
        rollback: true,
      });
    } catch (rollbackError) {
      throw new HandledAcquireFailure(
        aggregateLockErrors(
          "LOCK_ACQUIRE_ROLLBACK_FAILED",
          "checkpoint publication failed and nonce-bound rollback also failed",
          [error, rollbackError],
        ),
      );
    }
    throw new HandledAcquireFailure(error);
  } finally {
    if (!renamed && stagingMetadata !== undefined) {
      await cleanupCreatedTemporary(
        stagingPath,
        stagingMetadata,
        durability,
      ).catch(() => false);
    }
  }
}

const WINDOWS_OWNER_FILE = "owner.json";
const WINDOWS_HEARTBEAT_FILE = "heartbeat.json";
const WINDOWS_ARTIFACT_PREFIX = ".operation-lock.windows-";
const preparedWindowsStateRoots = new WeakMap();

async function windowsSecurityBatch(security, operations) {
  if (typeof security.batch === "function") {
    return security.batch(operations);
  }
  const results = [];
  for (const entry of operations) {
    switch (entry.action) {
      case "protect-directory":
        results.push(await security.protectDirectory(entry.path));
        break;
      case "protect-file":
        results.push(await security.protectFile(entry.path));
        break;
      case "migrate-directory":
        results.push(await security.migrateDirectory(entry.path));
        break;
      case "migrate-file":
        results.push(await security.migrateFile(entry.path));
        break;
      case "verify-directory":
        results.push(await security.verifyDirectory(entry.path));
        break;
      case "verify-file":
        results.push(await security.verifyFile(entry.path));
        break;
      default:
        throw lockError("LOCK_OPTIONS_INVALID", `unsupported Windows ACL action: ${entry.action}`);
    }
  }
  return results;
}

function validateWindowsSecurity(value) {
  const security = value ?? windowsSecurityAdapter();
  if (
    security === null ||
    typeof security !== "object" ||
    ![
      security.protectDirectory,
      security.protectFile,
      security.migrateDirectory,
      security.migrateFile,
      security.verifyDirectory,
      security.verifyFile,
    ]
      .every((entry) => typeof entry === "function")
  ) {
    throw lockError("LOCK_OPTIONS_INVALID", "Windows security adapter is invalid");
  }
  if (
    value !== undefined &&
    process.platform === "win32" &&
    process.env.NODE_ENV !== "test"
  ) {
    throw lockError(
      "LOCK_OPTIONS_INVALID",
      "Windows production security adapter cannot be overridden",
    );
  }
  return security;
}

async function readWindowsOwnerDirectory(
  path,
  security,
  { allowMissing = false, aclAlreadyVerified = false } = {},
) {
  let directory;
  try {
    directory = await lstat(path, { bigint: true });
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return null;
    if (error.code === "ENOENT") {
      throw lockError("LOCK_DISAPPEARED", `Windows owner directory disappeared: ${path}`, error);
    }
    throw lockError("LOCK_READ_FAILED", `could not inspect Windows owner directory ${path}`, error);
  }
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw lockError("LOCK_PATH_INVALID", `Windows owner path must be a real directory: ${path}`);
  }
  const ownerPath = join(path, WINDOWS_OWNER_FILE);
  let file;
  try {
    file = await lstat(ownerPath, { bigint: true });
  } catch (cause) {
    throw lockError("LOCK_MALFORMED", `Windows owner directory lacks owner.json: ${path}`, cause);
  }
  if (!file.isFile() || file.isSymbolicLink() || file.size <= 0n || file.size > 64n * 1024n) {
    throw lockError("LOCK_MALFORMED", `Windows owner.json is not one bounded regular file: ${ownerPath}`);
  }
  if (!aclAlreadyVerified) {
    try {
      await windowsSecurityBatch(security, [
        { action: "verify-directory", path },
        { action: "verify-file", path: ownerPath },
      ]);
    } catch (cause) {
      throw lockError("LOCK_PERMISSIONS", `Windows owner ACL is not private: ${path}`, cause);
    }
  }
  let handle;
  let raw;
  let opened;
  try {
    handle = await open(ownerPath, "r");
    opened = await handle.stat({ bigint: true });
    if (opened.dev !== file.dev || opened.ino !== file.ino || opened.size !== file.size) {
      throw lockError("LOCK_READ_FAILED", `Windows owner file changed while opening: ${ownerPath}`);
    }
    raw = await handle.readFile("utf8");
    const after = await handle.stat({ bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw lockError("LOCK_READ_FAILED", `Windows owner file changed while reading: ${ownerPath}`);
    }
  } finally {
    await handle?.close().catch(() => {});
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw lockError("LOCK_MALFORMED", `Windows owner file is not valid JSON: ${ownerPath}`, cause);
  }
  const owner = validateOwnerRecord(value);
  if (owner.predecessor !== null || raw !== serializeJson(owner)) {
    throw lockError("LOCK_MALFORMED", "Windows owner must be one canonical predecessor-free record");
  }
  return {
    metadata: { dev: directory.dev, ino: directory.ino },
    ownerMetadata: { dev: opened.dev, ino: opened.ino },
    owner,
    ownerPath,
    path,
    raw,
  };
}

function sameWindowsClaim(left, right) {
  return (
    left !== null &&
    right !== null &&
    left.raw === right.raw &&
    left.metadata.dev === right.metadata.dev &&
    left.metadata.ino === right.metadata.ino &&
    left.ownerMetadata.dev === right.ownerMetadata.dev &&
    left.ownerMetadata.ino === right.ownerMetadata.ino
  );
}

async function prepareWindowsStateRoot(stateRoot, security) {
  await verifyRealDirectoryAncestors(dirname(stateRoot));
  let created = false;
  try {
    await mkdir(stateRoot);
    created = true;
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw lockError("LOCK_PARENT_FAILED", `could not create Windows state root ${stateRoot}`, error);
    }
  }
  const metadata = await lstat(stateRoot, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw lockError("LOCK_PATH_INVALID", `Windows state root must be a real directory: ${stateRoot}`);
  }
  const prepared = preparedWindowsStateRoots.get(security);
  const cached = prepared?.get(stateRoot);
  if (cached?.dev === metadata.dev && cached?.ino === metadata.ino) return;
  try {
    await windowsSecurityBatch(security, [
      {
        action: created ? "protect-directory" : "migrate-directory",
        path: stateRoot,
      },
      { action: "verify-directory", path: stateRoot },
    ]);
  } catch (cause) {
    throw lockError("LOCK_PERMISSIONS", `Windows state root ACL is not private: ${stateRoot}`, cause);
  }
  const roots = prepared ?? new Map();
  roots.set(stateRoot, { dev: metadata.dev, ino: metadata.ino });
  if (prepared === undefined) preparedWindowsStateRoots.set(security, roots);
}

async function writeWindowsOwnerStaging({ path, owner, security }) {
  try {
    await mkdir(path);
  } catch (cause) {
    throw lockError("LOCK_STAGING_WRITE_FAILED", `could not create Windows owner staging ${path}`, cause);
  }
  try {
    const ownerPath = join(path, WINDOWS_OWNER_FILE);
    const handle = await open(ownerPath, "wx");
    try {
      await handle.writeFile(serializeJson(owner), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await windowsSecurityBatch(security, [
      { action: "protect-directory", path },
      { action: "protect-file", path: ownerPath },
      { action: "verify-directory", path },
      { action: "verify-file", path: ownerPath },
    ]);
    return await readWindowsOwnerDirectory(path, security, { aclAlreadyVerified: true });
  } catch (error) {
    await rm(path, { recursive: true, force: true }).catch(() => {});
    if (error instanceof OperationLockError) throw error;
    throw lockError("LOCK_STAGING_WRITE_FAILED", `could not prepare Windows owner staging ${path}`, error);
  }
}

async function removeWindowsClaimDirectory(path, expected, security) {
  const observed = await readWindowsOwnerDirectory(path, security);
  if (!sameWindowsClaim(expected, observed)) {
    throw lockError("LOCK_ARTIFACT_CHANGED", `Windows owner directory changed before removal: ${path}`);
  }
  await rm(path, { recursive: true, force: false });
}

async function healBrokenWindowsOwnerDirectory(path, security, readProcessIdentity) {
  // fail-closed：无法证明 owner 已死亡时不得删除仍可能存活的锁。
  // 仅在成功恢复精确 ACL 且能读取 owner、并确认进程已死后，才允许外层 quarantine。
  try {
    await windowsSecurityBatch(security, [
      { action: "protect-directory", path },
    ]);
  } catch (cause) {
    throw lockError(
      "LOCK_PERMISSIONS",
      `Windows owner directory ACL cannot be healed safely: ${path}`,
      cause,
    );
  }
  const ownerPath = join(path, WINDOWS_OWNER_FILE);
  try {
    await windowsSecurityBatch(security, [
      { action: "protect-file", path: ownerPath },
    ]);
  } catch (cause) {
    throw lockError(
      "LOCK_PERMISSIONS",
      `Windows owner file ACL cannot be healed safely: ${ownerPath}`,
      cause,
    );
  }
  const claim = await readWindowsOwnerDirectory(path, security, { allowMissing: false });
  if (typeof readProcessIdentity === "function") {
    const current = await probeOwner(claim.owner, readProcessIdentity);
    if (processStillOwnsRecord(claim.owner, current)) {
      throw lockError(
        "LOCK_HELD",
        `operation ${claim.owner.operation} is held by live pid ${claim.owner.pid}`,
      );
    }
  }
  return claim;
}

async function readWindowsOwnerDirectoryAllowingHeal(
  path,
  security,
  { allowMissing = false, readProcessIdentity = undefined } = {},
) {
  try {
    return await readWindowsOwnerDirectory(path, security, { allowMissing });
  } catch (error) {
    if (
      allowMissing &&
      error instanceof OperationLockError &&
      error.code === "LOCK_MALFORMED" &&
      /lacks owner\.json/.test(error.message)
    ) {
      // rename 以含 owner.json 的完整 staging 原子发布；缺文件的目录只能是崩溃残留，不得阻塞 acquire。
      await rm(path, { recursive: true, force: true }).catch(() => {});
      return null;
    }
    if (
      !allowMissing ||
      !(error instanceof OperationLockError) ||
      error.code !== "LOCK_PERMISSIONS"
    ) {
      throw error;
    }
    return healBrokenWindowsOwnerDirectory(path, security, readProcessIdentity);
  }
}

async function cleanupWindowsArtifacts({ stateRoot, lockPath, security, readProcessIdentity }) {
  const base = basename(lockPath);
  const names = await readdir(stateRoot);
  for (const name of names) {
    if (!name.startsWith(`${WINDOWS_ARTIFACT_PREFIX}${base}.`)) continue;
    const path = join(stateRoot, name);
    const disposable =
      name.startsWith(`${WINDOWS_ARTIFACT_PREFIX}${base}.staging.`) ||
      name.startsWith(`${WINDOWS_ARTIFACT_PREFIX}${base}.released.`) ||
      name.startsWith(`${WINDOWS_ARTIFACT_PREFIX}${base}.stale.`);
    let claim;
    try {
      claim = await readWindowsOwnerDirectory(path, security);
    } catch (error) {
      // Released/staging leftovers with broken ACLs must not block a fresh acquire.
      if (disposable && error?.code === "LOCK_PERMISSIONS") {
        await rm(path, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      // 并发 writer 可能刚 mkdir staging、尚未写出 owner.json；勿把竞态抬成致命 LOCK_MALFORMED。
      // 另一进程可能已把 staging rename 成正式锁，readdir 后到 lstat 前目录消失 → LOCK_DISAPPEARED。
      if (
        disposable &&
        (error?.code === "LOCK_MALFORMED" || error?.code === "LOCK_DISAPPEARED")
      ) {
        continue;
      }
      throw error;
    }
    if (disposable) {
      const current = await probeOwner(claim.owner, readProcessIdentity);
      if (processStillOwnsRecord(claim.owner, current)) continue;
    }
    await removeWindowsClaimDirectory(path, claim, security);
  }
}

async function assertWindowsClaimOwned(capability) {
  try {
    await capability.security.verifyDirectory(capability.stateRoot);
    const observed = await readWindowsOwnerDirectory(
      capability.lockPath,
      capability.security,
    );
    if (!sameWindowsClaim(capability.claim, observed)) {
      throw notOwnedError("Windows owner directory no longer matches this lease", {
        definitive: true,
      });
    }
    return true;
  } catch (error) {
    if (error instanceof OperationLockError && error.code === "LOCK_NOT_OWNED") throw error;
    if (error instanceof OperationLockError && error.code === "LOCK_DISAPPEARED") {
      throw notOwnedError("Windows owner directory disappeared", {
        cause: error,
        definitive: true,
      });
    }
    throw notOwnedError("could not prove Windows operation lease ownership", { cause: error });
  }
}

async function heartbeatWindowsLease(capability) {
  await assertWindowsClaimOwned(capability);
  const heartbeat = timestampFrom(capability.now);
  const finalPath = join(capability.lockPath, WINDOWS_HEARTBEAT_FILE);
  const temporaryPath = join(capability.lockPath, `.heartbeat.${createNonce()}.tmp`);
  const record = serializeJson({
    schemaVersion: LOCK_SCHEMA_VERSION,
    nonce: capability.claim.owner.nonce,
    pid: capability.claim.owner.pid,
    startedAt: capability.claim.owner.startedAt,
    heartbeat,
  });
  const handle = await open(temporaryPath, "wx");
  try {
    await handle.writeFile(record, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await windowsSecurityBatch(capability.security, [
    { action: "protect-file", path: temporaryPath },
    { action: "verify-file", path: temporaryPath },
  ]);
  await assertWindowsClaimOwned(capability);
  await rename(temporaryPath, finalPath);
  await capability.security.verifyFile(finalPath);
  await assertWindowsClaimOwned(capability);
  return heartbeat;
}

function createWindowsLease({ lockPath, stateRoot, claim, now, options, security }) {
  let lease;
  lease = Object.freeze({
    chainDepth: 1,
    heartbeatPath: join(lockPath, WINDOWS_HEARTBEAT_FILE),
    lockPath,
    nonce: claim.owner.nonce,
    owner: Object.freeze({ ...claim.owner }),
    async assertOwned() {
      const capability = requireLeaseCapability(lease);
      return assertWindowsClaimOwned(capability);
    },
    async heartbeat() {
      const capability = requireLeaseCapability(lease);
      return heartbeatWindowsLease(capability);
    },
    async release() {
      return releaseOperationLease(lease);
    },
  });
  leaseCapabilities.set(lease, {
    claim,
    commitTail: Promise.resolve(),
    lifecycle: "active",
    lockPath,
    now,
    options,
    provider: "windows",
    releasePromise: null,
    security,
    stateRoot,
  });
  return lease;
}

async function acquireWindowsOperationLock(options) {
  const { lockPath, stateRoot } = validatePaths(options.lockPath, options.stateRoot);
  const operation = validateOperation(options.operation);
  const identity = validateIdentity(options.identity);
  validateCompactionThreshold(options.compactionThreshold);
  const now = options.now ?? (() => new Date());
  if (typeof now !== "function") throw lockError("LOCK_CLOCK_FAILED", "now must be a function");
  if (options.faultAt !== undefined && !SUPPORTED_FAULTS.has(options.faultAt)) {
    throw lockError("LOCK_FAULT_INVALID", "unknown fault injection point");
  }
  if (
    options.testHooks !== undefined &&
    (options.testHooks === null || typeof options.testHooks !== "object" || Array.isArray(options.testHooks))
  ) {
    throw lockError("LOCK_HOOK_INVALID", "testHooks must be an object");
  }
  const security = validateWindowsSecurity(options.windowsSecurity);
  await prepareWindowsStateRoot(stateRoot, security);
  await cleanupWindowsArtifacts({
    stateRoot,
    lockPath,
    security,
    readProcessIdentity: options.readProcessIdentity,
  });

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    const existing = await readWindowsOwnerDirectoryAllowingHeal(lockPath, security, {
      allowMissing: true,
      readProcessIdentity: options.readProcessIdentity,
    });
    if (existing !== null) {
      const current = await probeOwner(existing.owner, options.readProcessIdentity);
      if (processStillOwnsRecord(existing.owner, current)) {
        throw lockError(
          "LOCK_HELD",
          `operation ${existing.owner.operation} is held by live pid ${existing.owner.pid}`,
        );
      }
      const rechecked = await readWindowsOwnerDirectoryAllowingHeal(lockPath, security, {
        allowMissing: true,
        readProcessIdentity: options.readProcessIdentity,
      });
      if (!sameWindowsClaim(existing, rechecked)) continue;
      const stalePath = join(
        stateRoot,
        `${WINDOWS_ARTIFACT_PREFIX}${basename(lockPath)}.stale.${existing.owner.nonce}.${createNonce()}`,
      );
      try {
        await rename(lockPath, stalePath);
      } catch (error) {
        if (["ENOENT", "EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) continue;
        throw lockError("LOCK_PUBLISH_FAILED", "could not quarantine a dead Windows owner", error);
      }
      const moved = await readWindowsOwnerDirectory(stalePath, security);
      if (!sameWindowsClaim(existing, moved)) {
        throw lockError("LOCK_ARTIFACT_CHANGED", "dead Windows owner changed during quarantine");
      }
      await removeWindowsClaimDirectory(stalePath, moved, security);
    }

    const timestamp = timestampFrom(now);
    const owner = ownerRecord({ identity, operation, timestamp, predecessor: null });
    const stagingPath = join(
      stateRoot,
      `${WINDOWS_ARTIFACT_PREFIX}${basename(lockPath)}.staging.${identity.pid}.${owner.nonce}`,
    );
    let staging;
    let published = false;
    try {
      await runStage(options, "before-staging-open", { owner, stagingPath });
      staging = await writeWindowsOwnerStaging({ path: stagingPath, owner, security });
      await runStage(options, "before-publish", { owner, stagingPath });
      try {
        await rename(stagingPath, lockPath);
      } catch (error) {
        if (["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) {
          await removeWindowsClaimDirectory(stagingPath, staging, security);
          staging = undefined;
          continue;
        }
        throw lockError("LOCK_PUBLISH_FAILED", "could not atomically publish Windows owner", error);
      }
      published = true;
      // Reapply and verify in one PowerShell process after the atomic rename.
      await windowsSecurityBatch(security, [
        { action: "protect-directory", path: lockPath },
        { action: "protect-file", path: join(lockPath, WINDOWS_OWNER_FILE) },
        { action: "verify-directory", path: lockPath },
        { action: "verify-file", path: join(lockPath, WINDOWS_OWNER_FILE) },
      ]);
      const claim = await readWindowsOwnerDirectory(lockPath, security, {
        aclAlreadyVerified: true,
      });
      if (!sameWindowsClaim(staging, claim)) {
        throw lockError("LOCK_PUBLISH_VERIFY_FAILED", "published Windows owner changed before lease creation");
      }
      await runStage(options, "after-publish", { claim });
      return createWindowsLease({ lockPath, stateRoot, claim, now, options, security });
    } catch (error) {
      if (published && staging !== undefined) {
        const current = await readWindowsOwnerDirectory(lockPath, security, { allowMissing: true });
        if (sameWindowsClaim(staging, current)) {
          await removeWindowsClaimDirectory(lockPath, current, security).catch(() => {});
        }
      }
      throw error;
    } finally {
      if (!published && staging !== undefined) {
        await removeWindowsClaimDirectory(stagingPath, staging, security).catch(() => {});
      }
    }
  }
  throw lockError(
    "LOCK_CONTENTION_LIMIT",
    `Windows operation lock changed more than ${MAX_ACQUIRE_ATTEMPTS} times`,
  );
}

export async function acquireOperationLock(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw lockError("LOCK_OPTIONS_INVALID", "lock options must be an object");
  }
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return acquireWindowsOperationLock(options);
  const durability = createDurabilityAdapter(platform);
  durability.assertSupported();
  const { lockPath, stateRoot } = validatePaths(
    options.lockPath,
    options.stateRoot,
  );
  const operation = validateOperation(options.operation);
  const identity = validateIdentity(options.identity);
  const compactionThreshold = validateCompactionThreshold(
    options.compactionThreshold,
  );
  const readProcessIdentity = options.readProcessIdentity;
  const now = options.now ?? (() => new Date());
  if (typeof now !== "function") {
    throw lockError("LOCK_CLOCK_FAILED", "now must be a function");
  }
  if (options.faultAt !== undefined && !SUPPORTED_FAULTS.has(options.faultAt)) {
    throw lockError("LOCK_FAULT_INVALID", "unknown fault injection point");
  }
  if (
    options.testHooks !== undefined &&
    (options.testHooks === null ||
      typeof options.testHooks !== "object" ||
      Array.isArray(options.testHooks))
  ) {
    throw lockError("LOCK_HOOK_INVALID", "testHooks must be an object");
  }

  const parentPath = dirname(lockPath);
  await prepareTrustedParent({ stateRoot, parentPath, durability });
  await cleanupOrphanQuarantines({
    lockPath,
    parentPath,
    readProcessIdentity,
    durability,
  });
  await cleanupProvenDeadStaging({
    lockPath,
    parentPath,
    readProcessIdentity,
    durability,
    options,
  });
  await cleanupProvenDeadCrashArtifacts({
    lockPath,
    parentPath,
    readProcessIdentity,
    durability,
    options,
  });
  await cleanupProvenOrphanHeartbeats({
    lockPath,
    parentPath,
    readProcessIdentity,
    durability,
    options,
  });
  await cleanupUnreachableFinalArtifacts({
    lockPath,
    parentPath,
    durability,
    options,
  });

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    const chain = await findTail(lockPath);
    let predecessor = chain.tail;
    if (predecessor !== null) {
      const released = await readReleaseMarker(lockPath, predecessor);
      if (released === null) {
        const current = await probeOwner(
          predecessor.owner,
          readProcessIdentity,
        );
        if (processStillOwnsRecord(predecessor.owner, current)) {
          throw lockError(
            "LOCK_HELD",
            `operation ${predecessor.owner.operation} is held by live pid ${predecessor.owner.pid}`,
          );
        }
        await runStage(options, "after-tail-inspected", { predecessor });
        const rechecked = await readClaim(predecessor.path, {
          predecessor:
            predecessor.owner.predecessor === null
              ? null
              : predecessor.predecessorClaim,
        });
        if (!sameClaim(predecessor, rechecked)) continue;
      }
      if (chain.depth >= MAX_CHAIN_LENGTH) {
        throw lockError(
          "LOCK_CHAIN_LIMIT",
          `operation-lock chain reached ${MAX_CHAIN_LENGTH} claims; run offline doctor maintenance with all related processes stopped`,
        );
      }
    }

    const timestamp = timestampFrom(now);
    const owner = ownerRecord({ identity, operation, timestamp, predecessor });
    const finalPath =
      predecessor === null
        ? lockPath
        : successorPath(lockPath, predecessor.owner.nonce);
    const stagingPath = `${lockPath}.staging.${identity.pid}.${owner.nonce}`;
    const raw = serializeJson(owner);
    let published = false;
    let keepStaging = false;
    let stagingMetadata;
    let claim;
    try {
      await runStage(options, "before-staging-open", { owner, stagingPath });
      stagingMetadata = await writeSyncedExclusiveFile(stagingPath, raw);
      try {
        if (options.faultAt === "before-publish") keepStaging = true;
        await runStage(options, "before-publish", { owner, stagingPath });
        try {
          await link(stagingPath, finalPath);
        } catch (error) {
          if (error.code === "EEXIST") {
            await cleanupCreatedTemporary(
              stagingPath,
              stagingMetadata,
              durability,
            );
            stagingMetadata = undefined;
            continue;
          }
          throw lockError(
            "LOCK_PUBLISH_FAILED",
            `could not atomically publish ${finalPath} with a same-filesystem hard link`,
            error,
          );
        }
        published = true;
        claim = attachPredecessorClaim(
          {
            metadata: stagingMetadata,
            owner,
            path: finalPath,
            raw,
          },
          predecessor,
        );
        await runStage(options, "after-publish", { claim });
        await cleanupCreatedTemporary(stagingPath, stagingMetadata, durability);
        stagingMetadata = undefined;
        await runStage(options, "after-publish-sync", { claim });

        const confirmed = await readClaim(finalPath, { predecessor });
        if (!sameClaim(claim, confirmed)) {
          throw lockError(
            "LOCK_PUBLISH_VERIFY_FAILED",
            "published claim inode or contents changed before lease creation",
          );
        }
        claim = attachPredecessorClaim(confirmed, predecessor);
        let chainDepth = chain.depth + 1;
        if (chainDepth >= compactionThreshold) {
          const compactedChain = {
            claims: [...chain.claims, claim],
            depth: chainDepth,
            tail: claim,
          };
          claim = await compactOwnershipChain({
            lockPath,
            chain: compactedChain,
            identity,
            operation,
            now,
            durability,
            options,
          });
          chainDepth = 1;
        }
        const lease = createLease({
          lockPath,
          stateRoot,
          claim,
          now,
          durability,
          options,
          chainDepth,
        });
        await writeHeartbeat({
          lockPath,
          claim,
          heartbeat: claim.owner.heartbeat,
          durability,
        });
        return lease;
      } catch (error) {
        if (error instanceof HandledAcquireFailure) throw error.error;
        if (!published) throw error;
        const publicationError =
          error instanceof OperationLockError &&
          error.code === "LOCK_DISAPPEARED"
            ? notOwnedError(
                "published owner claim became unreachable before lease creation",
                { cause: error, definitive: true },
              )
            : error;
        try {
          await publishReleaseMarker({
            lockPath,
            claim,
            now,
            durability,
            options,
            rollback: true,
          });
        } catch (rollbackError) {
          throw aggregateLockErrors(
            "LOCK_ACQUIRE_ROLLBACK_FAILED",
            "claim publication failed and nonce-bound rollback also failed",
            [publicationError, rollbackError],
          );
        }
        throw publicationError;
      }
    } finally {
      if (stagingMetadata !== undefined && !keepStaging) {
        await cleanupCreatedTemporary(
          stagingPath,
          stagingMetadata,
          durability,
        ).catch(() => false);
      }
    }
  }

  throw lockError(
    "LOCK_CONTENTION_LIMIT",
    `operation lock tail changed more than ${MAX_ACQUIRE_ATTEMPTS} times`,
  );
}

export async function withOperationLock(options, action) {
  if (typeof action !== "function") {
    throw lockError("LOCK_ACTION_INVALID", "protected action must be a function");
  }
  const lock = await acquireOperationLock(options);
  let result;
  let actionError;
  let actionFailed = false;
  try {
    result = await action(lock);
  } catch (error) {
    actionFailed = true;
    actionError = error;
  }

  try {
    const released = await lock.release();
    if (!released) {
      throw lockError(
        "LOCK_RELEASE_FAILED",
        "lease ownership was lost before withOperationLock could release it",
      );
    }
  } catch (releaseError) {
    if (actionFailed) {
      throw aggregateLockErrors(
        "LOCK_ACTION_RELEASE_FAILED",
        "protected action and lease release both failed",
        [actionError, releaseError],
      );
    }
    throw releaseError;
  }
  if (actionFailed) throw actionError;
  return result;
}
