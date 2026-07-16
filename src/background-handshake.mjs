import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

export const BACKGROUND_HANDSHAKE_FILE = "controller-handshake.json";
export const BACKGROUND_START_REQUEST_FILE = "controller-start-request.json";

const HANDSHAKE_BYTES = 4096;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const NONCE = /^[A-Za-z0-9_-]{1,128}$/;
const PLATFORMS = new Set(["darwin", "win32"]);
const OUTCOMES = new Set(["ready", "unregister"]);
const HANDSHAKE_KEYS = Object.freeze([
  "backgroundIdentity",
  "createdAt",
  "outcome",
  "pid",
  "platform",
  "revision",
  "schemaVersion",
  "startedAt",
  "transitionNonce",
]);
const START_REQUEST_KEYS = Object.freeze([
  "backgroundIdentity",
  "createdAt",
  "platform",
  "revision",
  "schemaVersion",
  "transitionNonce",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function boundedText(value, field, max = 512) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max ||
    value.includes("\0") ||
    /[\r\n]/.test(value)
  ) {
    throw new Error(`background handshake ${field} is invalid`);
  }
  return value;
}

function validateHandshake(value) {
  if (!exactKeys(value, HANDSHAKE_KEYS)) {
    throw new Error("background handshake schema has unknown or missing fields");
  }
  if (value.schemaVersion !== 1) throw new Error("background handshake schemaVersion is unsupported");
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new Error("background handshake revision is invalid");
  }
  if (typeof value.transitionNonce !== "string" || !NONCE.test(value.transitionNonce)) {
    throw new Error("background handshake transition nonce is invalid");
  }
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new Error("background handshake PID is invalid");
  }
  const startedAt = boundedText(value.startedAt, "startedAt");
  if (!PLATFORMS.has(value.platform)) throw new Error("background handshake platform is invalid");
  const backgroundIdentity = boundedText(value.backgroundIdentity, "background identity", 256);
  if (!OUTCOMES.has(value.outcome)) throw new Error("background handshake outcome is invalid");
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error("background handshake createdAt is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    revision: value.revision,
    transitionNonce: value.transitionNonce,
    pid: value.pid,
    startedAt,
    platform: value.platform,
    backgroundIdentity,
    outcome: value.outcome,
    createdAt: value.createdAt,
  });
}

function validateStartRequest(value) {
  if (!exactKeys(value, START_REQUEST_KEYS)) {
    throw new Error("background start request schema has unknown or missing fields");
  }
  if (value.schemaVersion !== 1) {
    throw new Error("background start request schemaVersion is unsupported");
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new Error("background start request revision is invalid");
  }
  if (typeof value.transitionNonce !== "string" || !NONCE.test(value.transitionNonce)) {
    throw new Error("background start request nonce is invalid");
  }
  if (!PLATFORMS.has(value.platform)) {
    throw new Error("background start request platform is invalid");
  }
  const backgroundIdentity = boundedText(
    value.backgroundIdentity,
    "start request background identity",
    256,
  );
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error("background start request createdAt is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    revision: value.revision,
    transitionNonce: value.transitionNonce,
    platform: value.platform,
    backgroundIdentity,
    createdAt: value.createdAt,
  });
}

function validateStateRoot(stateRoot) {
  if (
    typeof stateRoot !== "string" ||
    !isAbsolute(stateRoot) ||
    normalize(stateRoot) !== stateRoot ||
    stateRoot.includes("\0")
  ) {
    throw new Error("background handshake stateRoot must be a canonical absolute path");
  }
  return stateRoot;
}

export function backgroundHandshakePath(stateRoot) {
  return join(validateStateRoot(stateRoot), BACKGROUND_HANDSHAKE_FILE);
}

export function backgroundStartRequestPath(stateRoot) {
  return join(validateStateRoot(stateRoot), BACKGROUND_START_REQUEST_FILE);
}

function sameFile(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs;
}

function requireOwner(metadata, description) {
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`${description} must belong to the current user`);
  }
}

function requirePrivateDirectory(metadata) {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("background handshake stateRoot must be a real directory, not a symbolic link");
  }
  requireOwner(metadata, "background handshake stateRoot");
  if (process.platform !== "win32" && (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new Error("background handshake stateRoot mode must be 0700");
  }
}

function requirePrivateFile(metadata) {
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("background handshake must be a regular file, not a symbolic link");
  }
  requireOwner(metadata, "background handshake file");
  if (process.platform !== "win32" && (metadata.mode & 0o777) !== PRIVATE_FILE_MODE) {
    throw new Error("background handshake file mode must be 0600");
  }
  if (metadata.size <= 0 || metadata.size > HANDSHAKE_BYTES) {
    throw new Error(`background handshake must be at most ${HANDSHAKE_BYTES} bytes`);
  }
}

async function ensurePrivateStateRoot(stateRoot) {
  validateStateRoot(stateRoot);
  await mkdir(stateRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const before = await lstat(stateRoot);
  requirePrivateDirectory(before);
  // Windows does not support opening a directory as a regular file handle.
  // ACL validation is owned by the Windows adapter; lstat still closes the
  // reparse-point and type-confusion boundary here.
  if (process.platform === "win32") return before;
  const handle = await open(stateRoot, fsConstants.O_RDONLY);
  try {
    const opened = await handle.stat();
    requirePrivateDirectory(opened);
    if (before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new Error("background handshake stateRoot changed during validation");
    }
  } finally {
    await handle.close();
  }
  return before;
}

async function syncDirectory(stateRoot) {
  if (process.platform === "win32") return;
  const handle = await open(stateRoot, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readPrivateDocument({ stateRoot, path, validate, description }) {
  const root = await ensurePrivateStateRoot(stateRoot);
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  requirePrivateFile(before);
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const opened = await handle.stat();
    requirePrivateFile(opened);
    if (!sameFile(before, opened)) throw new Error("background handshake changed while opening");
    bytes = await handle.readFile();
    const afterRead = await handle.stat();
    if (!sameFile(opened, afterRead) || bytes.byteLength !== opened.size) {
      throw new Error("background handshake changed while reading");
    }
  } finally {
    await handle.close();
  }
  const currentRoot = await lstat(stateRoot);
  requirePrivateDirectory(currentRoot);
  if (root.dev !== currentRoot.dev || root.ino !== currentRoot.ino) {
    throw new Error("background handshake stateRoot changed while reading");
  }
  const current = await lstat(path);
  if (!sameFile(before, current)) throw new Error("background handshake path changed while reading");
  let parsed;
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  try {
    parsed = JSON.parse(decoded);
  } catch (cause) {
    throw new Error(`${description} is not valid JSON`, { cause });
  }
  if (decoded.trim() !== JSON.stringify(parsed)) {
    throw new Error(`${description} JSON must be canonical and contain no duplicate fields`);
  }
  return validate(parsed);
}

export async function readBackgroundHandshake({ stateRoot } = {}) {
  return readPrivateDocument({
    stateRoot,
    path: backgroundHandshakePath(stateRoot),
    validate: validateHandshake,
    description: "background handshake",
  });
}

export async function readBackgroundStartRequest({ stateRoot } = {}) {
  return readPrivateDocument({
    stateRoot,
    path: backgroundStartRequestPath(stateRoot),
    validate: validateStartRequest,
    description: "background start request",
  });
}

export async function publishBackgroundHandshake(input, {
  now = () => new Date(),
  nonce = randomUUID,
} = {}) {
  if (!isRecord(input)) throw new Error("background handshake input is required");
  const stateRoot = validateStateRoot(input.stateRoot);
  const document = validateHandshake({
    schemaVersion: 1,
    revision: input.revision,
    transitionNonce: input.transitionNonce,
    pid: input.pid,
    startedAt: input.startedAt,
    platform: input.platform,
    backgroundIdentity: input.backgroundIdentity,
    outcome: input.outcome,
    createdAt: now().toISOString(),
  });
  const root = await ensurePrivateStateRoot(stateRoot);
  const path = backgroundHandshakePath(stateRoot);
  const temporaryPath = join(stateRoot, `.${BACKGROUND_HANDSHAKE_FILE}.${nonce()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      PRIVATE_FILE_MODE,
    );
    await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8");
    if (process.platform !== "win32") await handle.chmod(PRIVATE_FILE_MODE);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const temporary = await lstat(temporaryPath);
    requirePrivateFile(temporary);
    const currentRoot = await lstat(stateRoot);
    requirePrivateDirectory(currentRoot);
    if (root.dev !== currentRoot.dev || root.ino !== currentRoot.ino) {
      throw new Error("background handshake stateRoot changed before publish");
    }
    await rename(temporaryPath, path);
    await syncDirectory(stateRoot);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch((cleanupError) => {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
  const published = await readBackgroundHandshake({ stateRoot });
  if (JSON.stringify(published) !== JSON.stringify(document)) {
    throw new Error("background handshake publication did not verify exactly");
  }
  return published;
}

export async function publishBackgroundStartRequest(input, {
  now = () => new Date(),
  nonce = randomUUID,
} = {}) {
  if (!isRecord(input)) throw new Error("background start request input is required");
  const stateRoot = validateStateRoot(input.stateRoot);
  const document = validateStartRequest({
    schemaVersion: 1,
    revision: input.revision,
    transitionNonce: input.transitionNonce,
    platform: input.platform,
    backgroundIdentity: input.backgroundIdentity,
    createdAt: now().toISOString(),
  });
  const root = await ensurePrivateStateRoot(stateRoot);
  const path = backgroundStartRequestPath(stateRoot);
  const temporaryPath = join(stateRoot, `.${BACKGROUND_START_REQUEST_FILE}.${nonce()}.tmp`);
  let handle;
  let published = false;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      PRIVATE_FILE_MODE,
    );
    await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8");
    if (process.platform !== "win32") await handle.chmod(PRIVATE_FILE_MODE);
    await handle.sync();
    await handle.close();
    handle = undefined;
    requirePrivateFile(await lstat(temporaryPath));
    const currentRoot = await lstat(stateRoot);
    requirePrivateDirectory(currentRoot);
    if (root.dev !== currentRoot.dev || root.ino !== currentRoot.ino) {
      throw new Error("background start request stateRoot changed before publish");
    }
    await link(temporaryPath, path);
    published = true;
    await unlink(temporaryPath);
    await syncDirectory(stateRoot);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch((cleanupError) => {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    });
    if (error?.code === "EEXIST") {
      const conflict = new Error("a background start request is already pending", { cause: error });
      conflict.code = "BACKGROUND_START_REQUEST_PENDING";
      throw conflict;
    }
    throw error;
  }
  if (!published) throw new Error("background start request publication did not complete");
  const observed = await readBackgroundStartRequest({ stateRoot });
  if (JSON.stringify(observed) !== JSON.stringify(document)) {
    throw new Error("background start request publication did not verify exactly");
  }
  return observed;
}

export async function claimBackgroundStartRequest({
  stateRoot,
  platform,
  backgroundIdentity,
  maxAgeMs = 30_000,
  clock = Date.now,
} = {}, { nonce = randomUUID } = {}) {
  if (!PLATFORMS.has(platform)) throw new Error("background start request expected platform is invalid");
  boundedText(backgroundIdentity, "start request expected background identity", 256);
  if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 300_000) {
    throw new Error("background start request freshness window is invalid");
  }
  const statePath = backgroundStartRequestPath(stateRoot);
  await ensurePrivateStateRoot(stateRoot);
  let before;
  try {
    before = await lstat(statePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  requirePrivateFile(before);
  const claimedPath = join(stateRoot, `.${BACKGROUND_START_REQUEST_FILE}.${nonce()}.claim`);
  try {
    await rename(statePath, claimedPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  await syncDirectory(stateRoot);
  try {
    const claimed = await lstat(claimedPath);
    requirePrivateFile(claimed);
    if (!sameFile(before, claimed)) {
      throw new Error("background start request changed while it was claimed");
    }
    const request = await readPrivateDocument({
      stateRoot,
      path: claimedPath,
      validate: validateStartRequest,
      description: "background start request",
    });
    if (request.platform !== platform) {
      throw new Error("background start request platform mismatch");
    }
    if (request.backgroundIdentity !== backgroundIdentity) {
      throw new Error("background start request identity mismatch");
    }
    const createdAt = Date.parse(request.createdAt);
    const observedAt = clock();
    if (createdAt < observedAt - maxAgeMs) {
      throw new Error("background start request is stale");
    }
    if (createdAt > observedAt + 30_000) {
      throw new Error("background start request is from the future");
    }
    return request;
  } finally {
    await unlink(claimedPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await syncDirectory(stateRoot);
  }
}

export async function removeBackgroundHandshake({ stateRoot } = {}) {
  const existing = await readBackgroundHandshake({ stateRoot });
  if (existing === null) return false;
  const path = backgroundHandshakePath(stateRoot);
  const before = await lstat(path);
  requirePrivateFile(before);
  await unlink(path);
  await syncDirectory(stateRoot);
  return true;
}

export async function removeBackgroundStartRequest({ stateRoot } = {}) {
  const existing = await readBackgroundStartRequest({ stateRoot });
  if (existing === null) return false;
  const path = backgroundStartRequestPath(stateRoot);
  const before = await lstat(path);
  requirePrivateFile(before);
  await unlink(path);
  await syncDirectory(stateRoot);
  return true;
}

function validateExpected(expected) {
  if (!isRecord(expected)) throw new Error("expected background handshake is required");
  if (!Number.isSafeInteger(expected.revision) || expected.revision < 0) {
    throw new Error("expected background handshake revision is invalid");
  }
  if (typeof expected.transitionNonce !== "string" || !NONCE.test(expected.transitionNonce)) {
    throw new Error("expected background handshake nonce is invalid");
  }
  if (!PLATFORMS.has(expected.platform)) throw new Error("expected background platform is invalid");
  boundedText(expected.backgroundIdentity, "background identity", 256);
  if (!OUTCOMES.has(expected.outcome)) throw new Error("expected background outcome is invalid");
  return expected;
}

function exactExpected(document, expected) {
  for (const key of [
    "revision",
    "transitionNonce",
    "platform",
    "backgroundIdentity",
    "outcome",
  ]) {
    if (document[key] !== expected[key]) {
      throw new Error(`background handshake ${key} mismatch`);
    }
  }
}

function defaultWait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForBackgroundHandshake({
  stateRoot,
  expected,
  forbiddenPid,
  notBefore,
  timeoutMs = 10_000,
  pollIntervalMs = 100,
  readProcessIdentity,
  wait = defaultWait,
  clock = Date.now,
} = {}) {
  validateExpected(expected);
  if (!Number.isSafeInteger(forbiddenPid) || forbiddenPid <= 0) {
    throw new Error("foreground PID is invalid");
  }
  if (!Number.isFinite(notBefore)) throw new Error("handshake notBefore is invalid");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("handshake timeout is invalid");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > timeoutMs) {
    throw new Error("handshake poll interval is invalid");
  }
  if (expected.outcome === "ready" && typeof readProcessIdentity !== "function") {
    throw new Error("readProcessIdentity is required for a ready handshake");
  }
  const deadline = clock() + timeoutMs;
  const maxAttempts = Math.ceil(timeoutMs / pollIntervalMs) + 1;
  let lastMismatch = null;
  for (let attempt = 0; attempt < maxAttempts && clock() <= deadline; attempt += 1) {
    const document = await readBackgroundHandshake({ stateRoot });
    if (document !== null) {
      try {
        exactExpected(document, expected);
        const createdAt = Date.parse(document.createdAt);
        if (createdAt < notBefore) throw new Error("background handshake createdAt is stale");
        if (createdAt > clock() + 30_000) {
          throw new Error("background handshake createdAt is from the future");
        }
        if (document.pid === forbiddenPid) {
          throw new Error("background handshake PID belongs to the requesting foreground process");
        }
        if (expected.outcome === "ready") {
          const observed = await readProcessIdentity(document.pid);
          if (
            !isRecord(observed) ||
            observed.pid !== document.pid ||
            observed.startedAt !== document.startedAt
          ) {
            throw new Error("background handshake process identity is no longer live and exact");
          }
        }
        return document;
      } catch (error) {
        lastMismatch = error;
      }
    }
    if (attempt === maxAttempts - 1 || clock() >= deadline) break;
    await wait(pollIntervalMs);
  }
  if (lastMismatch !== null) throw lastMismatch;
  const error = new Error("background handshake timed out");
  error.code = "BACKGROUND_HANDSHAKE_TIMEOUT";
  throw error;
}

export async function consumeBackgroundHandshake({
  stateRoot,
  expected,
  forbiddenPid,
  notBefore,
  readProcessIdentity,
  clock = Date.now,
} = {}, { nonce = randomUUID } = {}) {
  validateExpected(expected);
  if (!Number.isSafeInteger(forbiddenPid) || forbiddenPid <= 0) {
    throw new Error("foreground PID is invalid");
  }
  if (!Number.isFinite(notBefore)) throw new Error("handshake notBefore is invalid");
  if (expected.outcome === "ready" && typeof readProcessIdentity !== "function") {
    throw new Error("readProcessIdentity is required for a ready handshake");
  }
  const path = backgroundHandshakePath(stateRoot);
  await ensurePrivateStateRoot(stateRoot);
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      const missing = new Error("background handshake is no longer available");
      missing.code = "BACKGROUND_HANDSHAKE_MISSING";
      throw missing;
    }
    throw error;
  }
  requirePrivateFile(before);
  const claimedPath = join(stateRoot, `.${BACKGROUND_HANDSHAKE_FILE}.${nonce()}.claim`);
  try {
    await rename(path, claimedPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      const missing = new Error("background handshake was already consumed");
      missing.code = "BACKGROUND_HANDSHAKE_MISSING";
      throw missing;
    }
    throw error;
  }
  await syncDirectory(stateRoot);
  try {
    const claimed = await lstat(claimedPath);
    requirePrivateFile(claimed);
    if (!sameFile(before, claimed)) {
      throw new Error("background handshake changed while it was claimed");
    }
    const document = await readPrivateDocument({
      stateRoot,
      path: claimedPath,
      validate: validateHandshake,
      description: "background handshake",
    });
    exactExpected(document, expected);
    const createdAt = Date.parse(document.createdAt);
    if (createdAt < notBefore) throw new Error("background handshake createdAt is stale");
    if (createdAt > clock() + 30_000) {
      throw new Error("background handshake createdAt is from the future");
    }
    if (document.pid === forbiddenPid) {
      throw new Error("background handshake PID belongs to the requesting foreground process");
    }
    if (expected.outcome === "ready") {
      const observed = await readProcessIdentity(document.pid);
      if (
        !isRecord(observed) ||
        observed.pid !== document.pid ||
        observed.startedAt !== document.startedAt
      ) {
        throw new Error("background handshake process identity is no longer live and exact");
      }
    }
    return document;
  } finally {
    await unlink(claimedPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await syncDirectory(stateRoot);
  }
}
