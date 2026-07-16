import { randomBytes } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
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

const LOCK_SCHEMA_VERSION = 2;
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
    dirname(lockPath) === parse(lockPath).root
  ) {
    throw lockError(
      "LOCK_PATH_INVALID",
      "lockPath must be a file path strictly below the trusted stateRoot",
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
  return metadata.mode & 0o777;
}

function requireCurrentUser(metadata, code, description) {
  if (
    typeof process.getuid === "function" &&
    metadata.uid !== process.getuid()
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
    return await lstat(path);
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
      metadata = await lstat(current);
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
  try {
    handle = await open(path, "wx", PRIVATE_FILE_MODE);
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    const metadata = await handle.stat();
    requirePrivateFile(metadata, "LOCK_PERMISSIONS", `staging file ${path}`);
    await handle.close();
    handle = undefined;
    return { dev: metadata.dev, ino: metadata.ino };
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlinkIfPresent(path).catch(() => {});
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
    metadata = await lstat(path);
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
      changed = (await unlinkIfPresent(path)) || changed;
    } catch (error) {
      throw lockError(
        "LOCK_ARTIFACT_CLEANUP_FAILED",
        `could not remove proven-dead staging artifact ${path}`,
        error,
      );
    }
  }
  if (changed) await durability.syncDirectory(parentPath);
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
      changed = (await unlinkIfPresent(path)) || changed;
    } catch (error) {
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
  const metadata = await writeSyncedExclusiveFile(
    stagingPath,
    serializeJson(record),
  );
  try {
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
  try {
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
  } finally {
    await unlinkIfPresent(stagingPath).catch(() => {});
  }
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
  try {
    await writeSyncedExclusiveFile(
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
    if (!renamed) await unlinkIfPresent(temporaryPath).catch(() => {});
  }
  return finalPath;
}

function createLease({
  lockPath,
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
  return Object.freeze({
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
      try {
        await runStage(options, "before-release", { claim });
        await assertClaimOwned(lockPath, claim);
        return await publishReleaseMarker({
          lockPath,
          claim,
          now,
          durability,
          options,
        });
      } catch (error) {
        if (
          error instanceof OperationLockError &&
          error.code === "LOCK_NOT_OWNED" &&
          error.ownershipLost === true
        ) {
          return false;
        }
        if (error instanceof OperationLockError && error.code === "LOCK_RELEASE_FAILED") {
          throw error;
        }
        throw lockError(
          "LOCK_RELEASE_FAILED",
          `could not release operation lock claim ${claim.owner.nonce}`,
          error,
        );
      }
    },
  });
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
  claims,
  durability,
}) {
  const targets = new Set();
  for (const claim of claims) {
    if (claim.path !== lockPath) targets.add(claim.path);
    targets.add(heartbeatFilePath(lockPath, claim.owner.nonce));
    targets.add(releasePath(lockPath, claim.owner.nonce));
  }

  let changed = false;
  try {
    for (const target of targets) {
      changed = (await unlinkIfPresent(target)) || changed;
    }
    if (changed) await durability.syncDirectory(dirname(lockPath));
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
  try {
    const stagingMetadata = await writeSyncedExclusiveFile(stagingPath, raw);
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
      claims: chain.claims,
      durability,
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
    if (!renamed) await unlinkIfPresent(stagingPath).catch(() => {});
  }
}

export async function acquireOperationLock(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw lockError("LOCK_OPTIONS_INVALID", "lock options must be an object");
  }
  const durability = createDurabilityAdapter(options.platform ?? process.platform);
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
  await cleanupProvenDeadStaging({
    lockPath,
    parentPath,
    readProcessIdentity,
    durability,
  });
  await cleanupProvenOrphanHeartbeats({
    lockPath,
    parentPath,
    readProcessIdentity,
    durability,
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
    let claim;
    try {
      const stagingMetadata = await writeSyncedExclusiveFile(stagingPath, raw);
      try {
        if (options.faultAt === "before-publish") keepStaging = true;
        await runStage(options, "before-publish", { owner, stagingPath });
        try {
          await link(stagingPath, finalPath);
        } catch (error) {
          if (error.code === "EEXIST") {
            await unlinkIfPresent(stagingPath);
            await durability.syncDirectory(parentPath);
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
        await unlinkIfPresent(stagingPath);
        await durability.syncDirectory(parentPath);
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
            [error, rollbackError],
          );
        }
        throw error;
      }
    } finally {
      if (!keepStaging) await unlinkIfPresent(stagingPath).catch(() => {});
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
