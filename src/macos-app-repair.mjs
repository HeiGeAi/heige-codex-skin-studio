import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { promisify } from "node:util";

import { withOperationLock } from "./operation-lock.mjs";

const execFile = promisify(execFileCallback);
const PRODUCT = "heige-codex-skin-studio";
const OPERATION = "repair-polluted-codex-app";
const TEAM_IDENTIFIER = "2DC432GLL2";
const BUNDLE_IDENTIFIER = "com.openai.codex";
const JOURNAL_NAME = "app-repair.json";
const MAX_JOURNAL_BYTES = 128 * 1024;
const MAX_ASAR_BYTES = 512 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHASES = new Set(["prepared", "backup-detached", "target-published", "commit-decided"]);
const IDENTITY_KEYS = [
  "asarSha256",
  "asarSize",
  "build",
  "bundleIdentifier",
  "executableSha256",
  "executableSize",
  "rootDev",
  "rootIno",
  "signatureValid",
  "teamIdentifier",
  "version",
];
const JOURNAL_KEYS = [
  "after",
  "backupAppPath",
  "before",
  "createdAt",
  "currentAppPath",
  "decision",
  "nonce",
  "operation",
  "phase",
  "previousNonce",
  "product",
  "revision",
  "schemaVersion",
  "stagedAppPath",
  "transactionId",
];

function exactKeys(value, keys) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function canonicalAbsolute(path, label) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    path.includes("\0") ||
    normalize(path) !== path
  ) throw new Error(`${label} must be a canonical absolute path`);
  return path;
}

function sha256Digest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function validateIdentity(value, label) {
  if (
    !exactKeys(value, IDENTITY_KEYS) ||
    typeof value.rootDev !== "string" ||
    value.rootDev.length === 0 ||
    typeof value.rootIno !== "string" ||
    value.rootIno.length === 0 ||
    value.bundleIdentifier !== BUNDLE_IDENTIFIER ||
    typeof value.version !== "string" ||
    value.version.length === 0 ||
    typeof value.build !== "string" ||
    value.build.length === 0 ||
    !Number.isSafeInteger(value.executableSize) ||
    value.executableSize <= 0 ||
    value.executableSize > MAX_ASAR_BYTES ||
    typeof value.signatureValid !== "boolean" ||
    !(value.teamIdentifier === null || typeof value.teamIdentifier === "string") ||
    !Number.isSafeInteger(value.asarSize) ||
    value.asarSize <= 0 ||
    value.asarSize > MAX_ASAR_BYTES
  ) throw new Error(`${label} identity is invalid`);
  sha256Digest(value.asarSha256, `${label} app.asar`);
  sha256Digest(value.executableSha256, `${label} executable`);
  return value;
}

function validateJournal(value, journalPath) {
  if (
    !exactKeys(value, JOURNAL_KEYS) ||
    value.schemaVersion !== 1 ||
    value.product !== PRODUCT ||
    value.operation !== OPERATION ||
    !UUID.test(value.transactionId) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !UUID.test(value.nonce) ||
    !(value.previousNonce === null || UUID.test(value.previousNonce)) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !["undecided", "commit"].includes(value.decision) ||
    !PHASES.has(value.phase) ||
    (value.decision === "commit") !== (value.phase === "commit-decided")
  ) throw new Error("macOS app repair journal is invalid");
  for (const [field, path] of [
    ["currentAppPath", value.currentAppPath],
    ["stagedAppPath", value.stagedAppPath],
    ["backupAppPath", value.backupAppPath],
  ]) canonicalAbsolute(path, field);
  if (
    dirname(value.currentAppPath) !== dirname(value.stagedAppPath) ||
    dirname(value.currentAppPath) !== dirname(value.backupAppPath) ||
    value.backupAppPath !== join(
      dirname(value.currentAppPath),
      `.ChatGPT.app.heige-polluted-backup-${value.transactionId}`,
    ) ||
    basename(journalPath) !== JOURNAL_NAME
  ) throw new Error("macOS app repair paths are not transaction-derived");
  const before = validateIdentity(value.before, "before app");
  const after = validateIdentity(value.after, "after app");
  if (after.signatureValid !== true || after.teamIdentifier !== TEAM_IDENTIFIER) {
    throw new Error("macOS app repair journal does not identify an official signed app");
  }
  return { ...value, before, after };
}

function sameIdentity(left, right) {
  try {
    validateIdentity(left, "observed app");
    validateIdentity(right, "expected app");
  } catch {
    return false;
  }
  return IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

async function pathInfo(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
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

async function ensurePrivateRoot(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error("app repair state root must be canonical and symlink-free");
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("app repair state root must be a real directory");
  }
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o700) {
    throw new Error("app repair state root must have mode 0700");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("app repair state root must belong to the current user");
  }
}

async function durableWrite(path, value, { exclusive = false } = {}) {
  const parent = dirname(path);
  await ensurePrivateRoot(parent);
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

async function readJournal(path) {
  const initial = await pathInfo(path);
  if (initial === null) return null;
  if (
    initial.isSymbolicLink() ||
    !initial.isFile() ||
    initial.size <= 0 ||
    initial.size > MAX_JOURNAL_BYTES ||
    (process.platform !== "win32" && (initial.mode & 0o777) !== 0o600) ||
    (typeof process.getuid === "function" && initial.uid !== process.getuid())
  ) throw new Error("macOS app repair journal must be a private regular file");
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const opened = await handle.stat();
    if (opened.dev !== initial.dev || opened.ino !== initial.ino || !opened.isFile()) {
      throw new Error("macOS app repair journal changed while opening");
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error("macOS app repair journal changed while reading");
    }
  } finally {
    await handle.close();
  }
  let parsed;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error("macOS app repair journal is not JSON", { cause });
  }
  if (text !== `${JSON.stringify(parsed)}\n`) {
    throw new Error("macOS app repair journal is not canonical JSON");
  }
  return validateJournal(parsed, path);
}

async function updateJournal(path, current, changes) {
  const observed = await readJournal(path);
  if (
    observed === null ||
    observed.transactionId !== current.transactionId ||
    observed.revision !== current.revision ||
    observed.nonce !== current.nonce
  ) throw new Error("macOS app repair journal CAS conflict");
  const next = validateJournal({
    ...current,
    ...changes,
    revision: current.revision + 1,
    previousNonce: current.nonce,
    nonce: randomUUID(),
  }, path);
  await durableWrite(path, next);
  return next;
}

async function stableFileDigest(path) {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(MAX_ASAR_BYTES)) {
      throw new Error("app.asar must be a bounded non-empty regular file");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0n;
    while (offset < before.size) {
      const length = Number(before.size - offset > BigInt(buffer.length)
        ? BigInt(buffer.length)
        : before.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, Number(offset));
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += BigInt(bytesRead);
    }
    const after = await handle.stat({ bigint: true });
    if (
      offset !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) throw new Error("app.asar changed while hashing");
    return { sha256: hash.digest("hex"), size: Number(before.size) };
  } finally {
    await handle.close();
  }
}

async function plistValue(path, key, run) {
  const { stdout } = await run("/usr/bin/plutil", [
    "-extract", key, "raw", "-o", "-", join(path, "Contents", "Info.plist"),
  ]);
  const value = stdout.trim();
  if (value.length === 0 || value.length > 512 || value.includes("\0")) {
    throw new Error(`Codex ${key} is invalid`);
  }
  return value;
}

export async function inspectMacApp(path, { run = execFile } = {}) {
  path = canonicalAbsolute(path, "app path");
  const root = await lstat(path, { bigint: true });
  if (root.isSymbolicLink() || !root.isDirectory() || await realpath(path) !== path) {
    throw new Error("Codex app must be a canonical real directory");
  }
  const asar = await stableFileDigest(join(path, "Contents", "Resources", "app.asar"));
  const executable = await stableFileDigest(join(path, "Contents", "MacOS", "ChatGPT"));
  const bundleIdentifier = await plistValue(path, "CFBundleIdentifier", run);
  const version = await plistValue(path, "CFBundleShortVersionString", run);
  const build = await plistValue(path, "CFBundleVersion", run);
  let signatureValid = true;
  try {
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--", path]);
  } catch {
    signatureValid = false;
  }
  let teamIdentifier = null;
  try {
    const result = await run("/usr/bin/codesign", ["-dv", "--verbose=4", "--", path]);
    const details = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    teamIdentifier = details.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() ?? null;
    if (teamIdentifier === "not set") teamIdentifier = null;
  } catch {}
  const after = await lstat(path, { bigint: true });
  if (after.dev !== root.dev || after.ino !== root.ino || !after.isDirectory()) {
    throw new Error("Codex app changed while inspecting");
  }
  return validateIdentity({
    rootDev: String(root.dev),
    rootIno: String(root.ino),
    bundleIdentifier,
    version,
    build,
    executableSha256: executable.sha256,
    executableSize: executable.size,
    signatureValid,
    teamIdentifier,
    asarSha256: asar.sha256,
    asarSize: asar.size,
  }, "Codex app");
}

async function defaultAssertAppStopped(currentAppPath, { run = execFile } = {}) {
  const { stdout } = await run("/bin/ps", ["-axo", "pid=,command="]);
  const prefix = `${currentAppPath}/`;
  return !stdout.split(/\r?\n/).some((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    return match && Number(match[1]) !== process.pid && match[2].startsWith(prefix);
  });
}

async function defaultReadProcessIdentity(pid, { run = execFile } = {}) {
  try {
    const { stdout } = await run("/bin/ps", ["-p", String(pid), "-o", "lstart="]);
    const startedAt = stdout.trim();
    return startedAt.length === 0 ? null : { pid, startedAt };
  } catch (error) {
    if ([1, "1"].includes(error?.code)) return null;
    throw error;
  }
}

function normalizeTestMode(value) {
  if (value === undefined) return { allowAnyPaths: false };
  if (!exactKeys(value, ["allowAnyPaths"]) || value.allowAnyPaths !== true) {
    throw new Error("testMode is invalid");
  }
  return value;
}

async function validatedPaths({ currentAppPath, stagedAppPath, journalPath, testMode }) {
  currentAppPath = canonicalAbsolute(currentAppPath, "currentAppPath");
  stagedAppPath = canonicalAbsolute(stagedAppPath, "stagedAppPath");
  journalPath = canonicalAbsolute(journalPath, "journalPath");
  testMode = normalizeTestMode(testMode);
  if (dirname(currentAppPath) !== dirname(stagedAppPath)) {
    throw new Error("current and staged apps must share one atomic rename directory");
  }
  if (testMode.allowAnyPaths !== true) {
    const expectedJournal = join(
      userInfo().homedir,
      "Library",
      "Application Support",
      "HeiGeCodexSkinStudio",
      JOURNAL_NAME,
    );
    if (
      currentAppPath !== "/Applications/ChatGPT.app" ||
      !/^\.ChatGPT\.app\.heige-official-stage-[A-Za-z0-9._-]+$/.test(basename(stagedAppPath)) ||
      journalPath !== expectedJournal
    ) throw new Error("production app repair paths are outside the fixed allowlist");
  }
  if (await realpath(currentAppPath) !== currentAppPath) {
    throw new Error("current app must be a canonical real directory");
  }
  if (await realpath(stagedAppPath) !== stagedAppPath) {
    throw new Error("staged app must be a canonical real directory");
  }
  await ensurePrivateRoot(dirname(journalPath));
  return { currentAppPath, stagedAppPath, journalPath, testMode };
}

function dependenciesFrom(overrides = {}) {
  return {
    inspectApp: overrides.inspectApp ?? inspectMacApp,
    assertAppStopped: overrides.assertAppStopped ?? defaultAssertAppStopped,
    readProcessIdentity: overrides.readProcessIdentity ?? defaultReadProcessIdentity,
  };
}

async function assertExactApp(path, expected, dependencies, label) {
  const observed = await dependencies.inspectApp(path);
  if (!sameIdentity(observed, expected)) throw new Error(`${label} identity changed`);
  return observed;
}

async function assertRepairQuiescent(journal, dependencies, phase) {
  for (const path of [journal.currentAppPath, journal.backupAppPath]) {
    if (await dependencies.assertAppStopped(path) !== true) {
      throw new Error(`Codex app must be fully stopped and remain stopped during ${phase}`);
    }
  }
}

async function removeBoundAppTree(path, expected, label) {
  const root = await lstat(path, { bigint: true });
  if (
    root.isSymbolicLink() ||
    !root.isDirectory() ||
    String(root.dev) !== expected.rootDev ||
    String(root.ino) !== expected.rootIno
  ) throw new Error(`${label} root identity changed`);
  await rm(path, { recursive: true, force: false });
  await syncDirectory(dirname(path));
}

async function prepareUnderLock(input, dependencies) {
  const {
    currentAppPath,
    stagedAppPath,
    journalPath,
  } = await validatedPaths(input);
  if (await readJournal(journalPath) !== null) {
    throw new Error("macOS app repair requires recovery before preparing another transaction");
  }
  const expectedBefore = sha256Digest(
    input.expectedBeforeAsarSha256,
    "expected current app.asar",
  );
  const expectedOfficial = sha256Digest(
    input.expectedOfficialAsarSha256,
    "expected official app.asar",
  );
  const before = await dependencies.inspectApp(currentAppPath);
  if (before.asarSha256 !== expectedBefore) throw new Error("current app.asar digest mismatch");
  if (before.signatureValid === true && before.teamIdentifier === TEAM_IDENTIFIER) {
    throw new Error("current app is already an official signed build and does not need repair");
  }
  const after = await dependencies.inspectApp(stagedAppPath);
  if (after.asarSha256 !== expectedOfficial) throw new Error("official stage app.asar digest mismatch");
  if (after.signatureValid !== true || after.teamIdentifier !== TEAM_IDENTIFIER) {
    throw new Error("official stage must retain the OpenAI signature");
  }
  if (before.bundleIdentifier !== BUNDLE_IDENTIFIER || after.bundleIdentifier !== BUNDLE_IDENTIFIER) {
    throw new Error("app repair accepts only the Codex bundle identifier");
  }
  const transactionId = randomUUID();
  const journal = validateJournal({
    schemaVersion: 1,
    product: PRODUCT,
    operation: OPERATION,
    transactionId,
    revision: 0,
    nonce: randomUUID(),
    previousNonce: null,
    createdAt: new Date().toISOString(),
    decision: "undecided",
    phase: "prepared",
    currentAppPath,
    stagedAppPath,
    backupAppPath: join(
      dirname(currentAppPath),
      `.ChatGPT.app.heige-polluted-backup-${transactionId}`,
    ),
    before,
    after,
  }, journalPath);
  if (await pathInfo(journal.backupAppPath) !== null) {
    throw new Error("transaction-derived app backup path already exists");
  }
  await durableWrite(journalPath, journal, { exclusive: true });
  return journal;
}

async function publishUnderLock(journalPath, journal, dependencies, hooks = {}) {
  await assertRepairQuiescent(journal, dependencies, "repair preparation");
  await assertExactApp(journal.currentAppPath, journal.before, dependencies, "current app");
  await assertExactApp(journal.stagedAppPath, journal.after, dependencies, "official stage");
  await rename(journal.currentAppPath, journal.backupAppPath);
  await syncDirectory(dirname(journal.currentAppPath));
  journal = await updateJournal(journalPath, journal, { phase: "backup-detached" });
  await hooks["after-backup-detached"]?.(journal);
  await assertRepairQuiescent(journal, dependencies, "detached-backup verification");
  await rename(journal.stagedAppPath, journal.currentAppPath);
  await syncDirectory(dirname(journal.currentAppPath));
  await assertExactApp(journal.currentAppPath, journal.after, dependencies, "published official app");
  journal = await updateJournal(journalPath, journal, { phase: "target-published" });
  await hooks["after-target-published"]?.(journal);
  await assertRepairQuiescent(journal, dependencies, "published-app verification");
  journal = await updateJournal(journalPath, journal, {
    decision: "commit",
    phase: "commit-decided",
  });
  await hooks["after-commit-decision"]?.(journal);
  return journal;
}

async function clearJournal(journalPath, expected) {
  const observed = await readJournal(journalPath);
  if (
    observed === null ||
    observed.transactionId !== expected.transactionId ||
    observed.revision !== expected.revision ||
    observed.nonce !== expected.nonce
  ) throw new Error("macOS app repair journal clear conflict");
  await unlink(journalPath);
  await syncDirectory(dirname(journalPath));
}

async function rollbackUnderLock(journalPath, journal, dependencies) {
  const backup = await pathInfo(journal.backupAppPath);
  const current = await pathInfo(journal.currentAppPath);
  const stage = await pathInfo(journal.stagedAppPath);
  if (backup !== null) {
    await assertExactApp(journal.backupAppPath, journal.before, dependencies, "polluted backup");
    if (current !== null) {
      await assertExactApp(journal.currentAppPath, journal.after, dependencies, "uncommitted official app");
      if (stage !== null) {
        throw new Error("official stage reappeared before rollback");
      }
      await rename(journal.currentAppPath, journal.stagedAppPath);
      await syncDirectory(dirname(journal.currentAppPath));
    } else if (stage !== null) {
      await assertExactApp(journal.stagedAppPath, journal.after, dependencies, "official stage");
    }
    await rename(journal.backupAppPath, journal.currentAppPath);
    await syncDirectory(dirname(journal.currentAppPath));
  } else {
    if (current === null || stage === null) {
      throw new Error("prepared app repair precondition disappeared before rollback");
    }
    await assertExactApp(journal.currentAppPath, journal.before, dependencies, "current app");
    await assertExactApp(journal.stagedAppPath, journal.after, dependencies, "official stage");
  }
  await clearJournal(journalPath, journal);
  return { recovered: true, action: "rollback" };
}

async function finalizeUnderLock(journalPath, journal, dependencies) {
  await assertExactApp(journal.currentAppPath, journal.after, dependencies, "committed official app");
  if (await pathInfo(journal.stagedAppPath) !== null) {
    throw new Error("committed official stage unexpectedly reappeared");
  }
  if (await pathInfo(journal.backupAppPath) !== null) {
    await removeBoundAppTree(journal.backupAppPath, journal.before, "polluted backup");
  }
  await clearJournal(journalPath, journal);
  return { recovered: true, action: "roll-forward" };
}

async function withRepairLock(journalPath, dependencies, action) {
  const stateRoot = dirname(journalPath);
  await ensurePrivateRoot(stateRoot);
  const identity = await dependencies.readProcessIdentity(process.pid);
  if (
    identity === null ||
    identity?.pid !== process.pid ||
    typeof identity?.startedAt !== "string" ||
    identity.startedAt.length === 0
  ) throw new Error("app repair process identity is unavailable");
  return withOperationLock({
    stateRoot,
    lockPath: join(stateRoot, "operation.lock"),
    operation: "macos-app-repair",
    identity,
    readProcessIdentity: dependencies.readProcessIdentity,
  }, action);
}

export async function recoverMacAppRepair(input) {
  const journalPath = canonicalAbsolute(input.journalPath, "journalPath");
  const dependencies = dependenciesFrom(input.dependencies);
  return withRepairLock(journalPath, dependencies, async () => {
    const journal = await readJournal(journalPath);
    if (journal === null) return { recovered: false, action: "none" };
    return journal.decision === "commit"
      ? finalizeUnderLock(journalPath, journal, dependencies)
      : rollbackUnderLock(journalPath, journal, dependencies);
  });
}

export async function repairMacApp(input) {
  const journalPath = canonicalAbsolute(input.journalPath, "journalPath");
  const dependencies = dependenciesFrom(input.dependencies);
  const hooks = input.hooks ?? {};
  return withRepairLock(journalPath, dependencies, async () => {
    const pending = await readJournal(journalPath);
    if (pending !== null) {
      if (pending.decision === "commit") {
        await finalizeUnderLock(journalPath, pending, dependencies);
      } else {
        await rollbackUnderLock(journalPath, pending, dependencies);
      }
    }
    let journal = null;
    try {
      journal = await prepareUnderLock(input, dependencies);
      journal = await publishUnderLock(journalPath, journal, dependencies, hooks);
      await finalizeUnderLock(journalPath, journal, dependencies);
      return { status: "repaired", before: journal.before, after: journal.after };
    } catch (error) {
      if (error?.simulatedHardCrash === true) throw error;
      const observed = await readJournal(journalPath).catch(() => null);
      if (observed !== null && observed.decision !== "commit") {
        try {
          await rollbackUnderLock(journalPath, observed, dependencies);
        } catch (rollbackError) {
          const aggregate = new AggregateError(
            [error, rollbackError],
            "macOS app repair failed and rollback did not finish",
          );
          aggregate.code = "MACOS_APP_REPAIR_ROLLBACK_FAILED";
          throw aggregate;
        }
      }
      throw error;
    }
  });
}

export const macAppRepairInternals = Object.freeze({
  inspectMacApp,
  readJournal,
  sameIdentity,
});
