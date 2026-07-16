import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";

import {
  assertOperationLeaseCapability,
  commitWithOperationLease,
  guardOperationLease,
} from "./operation-lock.mjs";
import { validateStudioState } from "./state-store.mjs";

const FILE_NAME = "legacy-migration.json";
const MAX_BYTES = 128 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PHASES = new Set([
  "prepared",
  "state-prepared",
  "service-prepared",
  "ready-acked",
  "commit-decided",
  "rollback-decided",
]);
const PHASE_TRANSITIONS = new Map([
  ["prepared", new Set(["state-prepared", "rollback-decided"])],
  ["state-prepared", new Set(["service-prepared", "commit-decided", "rollback-decided"])],
  ["service-prepared", new Set(["ready-acked", "rollback-decided"])],
  ["ready-acked", new Set(["commit-decided", "rollback-decided"])],
  ["commit-decided", new Set()],
  ["rollback-decided", new Set()],
]);
const KEYS = [
  "ack",
  "createdAt",
  "decision",
  "nonce",
  "operation",
  "phase",
  "previousNonce",
  "product",
  "revision",
  "schemaVersion",
  "serviceParticipant",
  "stateParticipant",
  "transactionId",
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function validateAck(value) {
  if (value === null) return null;
  if (
    !exactKeys(value, ["persistenceEnabled", "processIdentity", "revision"]) ||
    value.persistenceEnabled !== true ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !exactKeys(value.processIdentity, ["pid", "startedAt"]) ||
    !Number.isSafeInteger(value.processIdentity.pid) ||
    value.processIdentity.pid <= 0 ||
    typeof value.processIdentity.startedAt !== "string" ||
    value.processIdentity.startedAt.length === 0
  ) throw new Error("legacy migration exact ACK schema is invalid");
  return { ...value, processIdentity: { ...value.processIdentity } };
}

function canonicalAbsolute(path, label) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    normalize(path) !== path ||
    path.includes("\0")
  ) {
    throw new Error(`${label} must be a canonical absolute path`);
  }
  return path;
}

function validateStateParticipant(value) {
  if (!exactKeys(value, ["afterState", "beforeState", "expectedControlToken", "statePath"])) {
    throw new Error("legacy migration state participant schema is invalid");
  }
  canonicalAbsolute(value.statePath, "state participant path");
  if (!TOKEN.test(value.expectedControlToken)) {
    throw new Error("legacy migration state participant token is invalid");
  }
  const beforeState = value.beforeState === null ? null : validateStudioState(value.beforeState);
  const afterState = value.afterState === null ? null : validateStudioState(value.afterState);
  if (
    beforeState?.controlToken !== undefined &&
    beforeState.controlToken !== value.expectedControlToken
  ) {
    throw new Error("legacy migration beforeState token does not match its participant");
  }
  if (
    afterState?.controlToken !== undefined &&
    afterState.controlToken !== value.expectedControlToken
  ) {
    throw new Error("legacy migration afterState token does not match its participant");
  }
  return { ...value, beforeState, afterState };
}

function validateServiceParticipant(value, document, expectedPath) {
  if (value === null) return null;
  const keys = [
    "coordinatorJournalPath",
    "newLabel",
    "newPlistPath",
    "oldLabel",
    "oldPlistPath",
    "operation",
    "participantJournalPath",
    "schemaVersion",
    "transactionId",
  ];
  if (
    !exactKeys(value, keys) ||
    value.schemaVersion !== 1 ||
    value.operation !== "migrate-legacy-watchdog" ||
    value.transactionId !== document.transactionId ||
    value.coordinatorJournalPath !== expectedPath ||
    !LABEL.test(value.oldLabel) ||
    !LABEL.test(value.newLabel)
  ) {
    throw new Error("legacy migration service participant schema is invalid");
  }
  for (const [field, path] of [
    ["coordinatorJournalPath", value.coordinatorJournalPath],
    ["participantJournalPath", value.participantJournalPath],
    ["oldPlistPath", value.oldPlistPath],
    ["newPlistPath", value.newPlistPath],
  ]) {
    canonicalAbsolute(path, `service participant ${field}`);
  }
  if (
    value.participantJournalPath !== join(dirname(expectedPath), "launch-agent-migration.json")
  ) {
    throw new Error("legacy migration service participant journal path is invalid");
  }
  return value;
}

function validateDocument(value, expectedPath = null) {
  if (
    !exactKeys(value, KEYS) ||
    value.schemaVersion !== 1 ||
    value.product !== "heige-codex-skin-studio" ||
    value.operation !== "legacy-migration" ||
    !UUID.test(value.transactionId) ||
    !["undecided", "rollback", "commit"].includes(value.decision) ||
    !PHASES.has(value.phase) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !UUID.test(value.nonce) ||
    !(value.previousNonce === null || UUID.test(value.previousNonce)) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !(value.serviceParticipant === null || isRecord(value.serviceParticipant)) ||
    (value.decision === "commit") !== (value.phase === "commit-decided") ||
    (value.decision === "rollback") !== (value.phase === "rollback-decided")
  ) {
    throw new Error("legacy migration coordinator journal is invalid");
  }
  const stateParticipant = validateStateParticipant(value.stateParticipant);
  if (expectedPath !== null && legacyMigrationJournalPath(dirname(value.stateParticipant.statePath)) !== expectedPath) {
    throw new Error("legacy migration coordinator path does not match its state participant");
  }
  const serviceParticipant = validateServiceParticipant(value.serviceParticipant, value, expectedPath);
  const ack = validateAck(value.ack);
  const persistentServiceCommit = ["ready-acked", "commit-decided"].includes(value.phase) &&
    serviceParticipant !== null;
  if (
    persistentServiceCommit &&
    (
      ack === null ||
      stateParticipant.afterState?.persistenceEnabled !== true ||
      ack.revision !== stateParticipant.afterState.revision
    )
  ) throw new Error("legacy migration persistent commit is missing its exact ACK");
  const ackAllowed = ["ready-acked", "commit-decided", "rollback-decided"].includes(value.phase) &&
    serviceParticipant !== null;
  if (!ackAllowed && ack !== null) {
    throw new Error("legacy migration ACK is invalid for its phase");
  }
  return { ...value, ack, serviceParticipant, stateParticipant };
}

async function syncDirectory(path) {
  if (process.platform === "win32") return;
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensurePrivateParent(path) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await realpath(parent) !== parent) {
    throw new Error("legacy migration coordinator parent must be canonical and symlink-free");
  }
  const info = await lstat(parent);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("legacy migration coordinator parent must be a real directory");
  }
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o700) {
    throw new Error("legacy migration coordinator parent mode must be 0700");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("legacy migration coordinator parent owner is invalid");
  }
  return parent;
}

async function readPrivate(path) {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size <= 0 ||
    before.size > MAX_BYTES ||
    (process.platform !== "win32" && (before.mode & 0o777) !== 0o600) ||
    (typeof process.getuid === "function" && before.uid !== process.getuid())
  ) {
    throw new Error("legacy migration coordinator must be a private regular file");
  }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) {
      throw new Error("legacy migration coordinator changed while opening");
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error("legacy migration coordinator changed while reading");
    }
  } finally {
    await handle.close();
  }
  let value;
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  try {
    value = JSON.parse(decoded);
  } catch (cause) {
    throw new Error("legacy migration coordinator is not valid JSON", { cause });
  }
  if (decoded !== `${JSON.stringify(value)}\n`) {
    throw new Error("legacy migration coordinator JSON must be canonical");
  }
  return validateDocument(value, path);
}

async function durableWrite(path, value, { exclusive = false } = {}) {
  const parent = await ensurePrivateParent(path);
  const temporary = `${path}.next.${process.pid}.${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (exclusive) {
      await link(temporary, path);
      await syncDirectory(parent);
      await unlink(temporary);
    } else {
      await rename(temporary, path);
    }
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function assertBoundLease(lease, journalPath) {
  const capability = assertOperationLeaseCapability(lease);
  if (
    journalPath !== legacyMigrationJournalPath(capability.stateRoot) ||
    await realpath(capability.stateRoot) !== capability.stateRoot
  ) {
    throw new Error("legacy migration coordinator is not bound to the leased stateRoot");
  }
  await guardOperationLease(lease);
  return capability;
}

export function legacyMigrationJournalPath(stateRoot) {
  return join(canonicalAbsolute(stateRoot, "stateRoot"), FILE_NAME);
}

export async function readLegacyMigrationCoordinator(path, { lease } = {}) {
  path = canonicalAbsolute(path, "coordinator journal path");
  await assertBoundLease(lease, path);
  return readPrivate(path);
}

export async function createLegacyMigrationCoordinator({
  journalPath,
  transactionId = randomUUID(),
  stateParticipant,
  lease,
}) {
  journalPath = canonicalAbsolute(journalPath, "coordinator journal path");
  const capability = await assertBoundLease(lease, journalPath);
  if (stateParticipant?.statePath !== join(capability.stateRoot, "state.json")) {
    throw new Error("legacy migration state participant is not bound to the leased stateRoot");
  }
  const document = validateDocument({
    schemaVersion: 1,
    product: "heige-codex-skin-studio",
    operation: "legacy-migration",
    transactionId,
    revision: 0,
    nonce: randomUUID(),
    previousNonce: null,
    decision: "undecided",
    phase: "prepared",
    createdAt: new Date().toISOString(),
    ack: null,
    stateParticipant,
    serviceParticipant: null,
  }, journalPath);
  await commitWithOperationLease(lease, () => durableWrite(
    journalPath,
    document,
    { exclusive: true },
  ));
  return document;
}

export async function updateLegacyMigrationCoordinator(journalPath, current, changes, { lease } = {}) {
  journalPath = canonicalAbsolute(journalPath, "coordinator journal path");
  await assertBoundLease(lease, journalPath);
  current = validateDocument(current, journalPath);
  if (!isRecord(changes)) {
    throw new Error("legacy migration coordinator changes must be an object");
  }
  const mutable = new Set(["ack", "decision", "phase", "serviceParticipant", "stateParticipant"]);
  if (Object.keys(changes).some((key) => !mutable.has(key))) {
    throw new Error("legacy migration coordinator changes contain immutable fields");
  }
  if (current.decision !== "undecided" && changes.decision !== current.decision) {
    throw new Error("legacy migration coordinator decision is already durable");
  }
  const nextPhase = changes.phase ?? current.phase;
  if (
    nextPhase !== current.phase &&
    !PHASE_TRANSITIONS.get(current.phase)?.has(nextPhase)
  ) {
    throw new Error("legacy migration coordinator phase transition is invalid");
  }
  const next = validateDocument({
    ...current,
    ...changes,
    previousNonce: current.nonce,
    nonce: randomUUID(),
    revision: current.revision + 1,
  }, journalPath);
  await commitWithOperationLease(lease, async () => {
    const observed = await readPrivate(journalPath);
    if (
      observed === null ||
      observed.transactionId !== current.transactionId ||
      observed.revision !== current.revision ||
      observed.nonce !== current.nonce
    ) {
      throw new Error("legacy migration coordinator CAS conflict");
    }
    await durableWrite(journalPath, next);
  });
  return next;
}

export async function clearLegacyMigrationCoordinator(journalPath, expected, { lease } = {}) {
  journalPath = canonicalAbsolute(journalPath, "coordinator journal path");
  await assertBoundLease(lease, journalPath);
  expected = validateDocument(expected, journalPath);
  await commitWithOperationLease(lease, async () => {
    const observed = await readPrivate(journalPath);
    if (
      observed === null ||
      observed.transactionId !== expected.transactionId ||
      observed.revision !== expected.revision ||
      observed.nonce !== expected.nonce
    ) {
      throw new Error("legacy migration coordinator clear conflict");
    }
    await unlink(journalPath);
    await syncDirectory(dirname(journalPath));
  });
}
