import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { readProcessIdentity, sameProcessIdentity } from "./process-identity.mjs";

export const INSTALL_MARKER_NAME = ".heige-install.json";
export const INSTALL_PRODUCT = "heige-codex-skin-studio";
export const MAX_INSTALL_SOURCE_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_INSTALL_SOURCE_TREE_BYTES = 32 * 1024 * 1024;
export const MAX_INSTALL_SOURCE_TREE_ENTRIES = 4096;
export const MAX_INSTALL_SOURCE_TREE_DEPTH = 32;

const SOURCE_ENTRIES = Object.freeze([
  { name: "package.json", type: "file" },
  { name: "src", type: "directory" },
  { name: "themes", type: "directory" },
  { name: "scripts", type: "directory" },
  { name: "custom-pet", type: "directory" },
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_JOURNAL_BYTES = 128 * 1024;
const MAX_PACKAGE_BYTES = 256 * 1024;
const OPTION1_DEPRECATED_ENABLE_ENTRYPOINT = [
  "#!/bin/zsh",
  "set -euo pipefail",
  "",
  "# HEIGE_OPTION1_MENU_ONLY=1",
  "print -u2 -- \"此旧入口不再开启常驻。请先打开「HeiGe 皮肤启动器」恢复本次皮肤，再在 Codex 顶部「皮肤常驻」开关中开启下次常驻。\"",
  "exit 64",
  "",
].join("\n");
const PARTICIPANT_KEYS = [
  "afterManifestSha256",
  "backupPath",
  "beforeExisted",
  "beforeKind",
  "beforeLegacyCommit",
  "beforeManifestSha256",
  "intentPath",
  "product",
  "schemaVersion",
  "stagePath",
  "targetRoot",
  "transactionId",
  "unchanged",
];
const PREPARATION_INTENT_KEYS = [
  "backupPath",
  "operation",
  "product",
  "schemaVersion",
  "stagePath",
  "targetRoot",
  "transactionId",
];
const JOURNAL_KEYS = [
  "createdAt",
  "decision",
  "nonce",
  "operation",
  "participant",
  "phase",
  "previousNonce",
  "product",
  "revision",
  "schemaVersion",
  "transactionId",
];

function assertAbsolutePath(value, label) {
  if (typeof value !== "string" || value.includes("\0") || !isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  return resolve(value);
}

async function pathInfo(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function isWithin(root, candidate) {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function requireCanonicalDirectory(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  const canonical = await realpath(path);
  if (!sameCanonicalPath(canonical, path)) {
    throw new Error(`${label} must be canonical and contain no symlink ancestor`);
  }
  return info;
}

async function ensureTargetParent(targetRoot) {
  const parent = dirname(targetRoot);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await requireCanonicalDirectory(parent, "target parent");
  return parent;
}

async function canonicalizeTargetRoot(value) {
  const targetRoot = assertAbsolutePath(value, "targetRoot");
  const parent = dirname(targetRoot);
  if (parent === targetRoot || basename(targetRoot) === "") {
    throw new Error("targetRoot cannot be a filesystem root");
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error("target parent must be a real directory");
  }
  return join(await realpath(parent), basename(targetRoot));
}

function reserveBudget(budget, bytes) {
  if (budget === null) return;
  const next = BigInt(budget.totalBytes) + bytes;
  if (next > BigInt(budget.maxBytes)) {
    throw new RangeError(`${budget.label} aggregate exceeds the ${budget.maxBytes} byte limit`);
  }
  budget.totalBytes = Number(next);
}

function reserveTreeEntry(budget, relativePath) {
  if (budget === null) return;
  const depth = relativePath.split(/[\\/]+/u).filter(Boolean).length;
  if (depth > budget.maxDepth) {
    throw new RangeError(`${budget.label} exceeds the ${budget.maxDepth} level depth limit`);
  }
  budget.totalEntries += 1;
  if (budget.totalEntries > budget.maxEntries) {
    throw new RangeError(`${budget.label} exceeds the ${budget.maxEntries} entry limit`);
  }
}

function treeBudget(label, maxBytes = MAX_INSTALL_SOURCE_TREE_BYTES) {
  return {
    totalBytes: 0,
    maxBytes,
    totalEntries: 0,
    maxEntries: MAX_INSTALL_SOURCE_TREE_ENTRIES,
    maxDepth: MAX_INSTALL_SOURCE_TREE_DEPTH,
    label,
  };
}

async function readStableFile(path, label, {
  maxBytes = MAX_INSTALL_SOURCE_FILE_BYTES,
  budget = null,
  afterOpenStat,
} = {}) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    if (before.size > BigInt(maxBytes)) {
      throw new RangeError(`${label} exceeds the ${maxBytes} byte limit`);
    }
    reserveBudget(budget, before.size);
    await afterOpenStat?.({ path, size: Number(before.size) });
    const bytes = Buffer.allocUnsafe(Number(before.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await handle.read(probe, 0, 1, bytes.byteLength);
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      offset !== bytes.byteLength ||
      extraBytes !== 0
    ) {
      throw new Error(`${label} changed while it was read`);
    }
    return { bytes, mode: Number(before.mode & 0o111n) === 0 ? 0o644 : 0o755 };
  } finally {
    await handle.close();
  }
}

function manifestDigest(entries) {
  return createHash("sha256").update(`${JSON.stringify(entries)}\n`).digest("hex");
}

function exactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sameCanonicalPath(left, right) {
  if (process.platform === "win32") return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function modeMatches(info, expected) {
  return process.platform === "win32" || (info.mode & 0o777) === expected;
}

async function captureDirectoryIdentity(path, label) {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} must be a real directory and not a symlink`);
  }
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  };
}

async function assertDirectoryIdentity(path, expected, label) {
  const current = await captureDirectoryIdentity(path, label);
  if (
    current.dev !== expected.dev
    || current.ino !== expected.ino
    || current.mode !== expected.mode
    || current.mtimeNs !== expected.mtimeNs
    || current.ctimeNs !== expected.ctimeNs
  ) throw new Error(`${label} changed while it was read`);
}

async function scanOwnedDirectory(root, relativePath, entries, budget) {
  const directory = relativePath === "" ? root : join(root, relativePath);
  const directoryInfo = await lstat(directory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new Error(`owned tree contains an untrusted directory: ${relativePath || "."}`);
  }
  if (relativePath !== "") {
    reserveTreeEntry(budget, relativePath);
    if (!modeMatches(directoryInfo, 0o755)) {
      throw new Error(`owned tree directory mode is invalid: ${relativePath}`);
    }
    entries.push({ path: relativePath, type: "directory", mode: 0o755 });
  }
  const children = await readdir(directory, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const child of children) {
    const childRelative = relativePath === "" ? child.name : join(relativePath, child.name);
    if (childRelative === INSTALL_MARKER_NAME) {
      reserveTreeEntry(budget, childRelative);
      continue;
    }
    const childPath = join(root, childRelative);
    const childInfo = await lstat(childPath);
    if (childInfo.isSymbolicLink()) throw new Error(`owned tree symlink is forbidden: ${childRelative}`);
    if (childInfo.isDirectory()) {
      await scanOwnedDirectory(root, childRelative, entries, budget);
      continue;
    }
    if (!childInfo.isFile()) throw new Error(`owned tree entry is unsupported: ${childRelative}`);
    reserveTreeEntry(budget, childRelative);
    const file = await readStableFile(childPath, `owned tree file ${childRelative}`, { budget });
    if (!modeMatches(childInfo, file.mode)) {
      throw new Error(`owned tree file mode is invalid: ${childRelative}`);
    }
    entries.push({
      path: childRelative,
      type: "file",
      mode: file.mode,
      size: file.bytes.byteLength,
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
    });
  }
}

async function readOwnedInstallMarker(root) {
  const markerPath = join(root, INSTALL_MARKER_NAME);
  const markerInfo = await lstat(markerPath).catch((error) => {
    if (error?.code === "ENOENT") throw new Error("existing target requires an ownership marker");
    throw error;
  });
  if (markerInfo.isSymbolicLink() || !markerInfo.isFile() || !modeMatches(markerInfo, 0o600)) {
    throw new Error("ownership marker is not a mode 0600 regular file");
  }
  const marker = JSON.parse((await readStableFile(markerPath, "ownership marker", {
    maxBytes: MAX_JOURNAL_BYTES,
  })).bytes.toString("utf8"));
  if (
    !exactKeys(marker, ["kind", "manifestSha256", "product", "schemaVersion"]) ||
    marker.schemaVersion !== 1 ||
    marker.product !== INSTALL_PRODUCT ||
    marker.kind !== "stable-tree" ||
    typeof marker.manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(marker.manifestSha256)
  ) {
    throw new Error("ownership marker schema is invalid");
  }
  return marker;
}

async function validateOwnedTree(root, expectedManifestSha256 = null) {
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || !modeMatches(rootInfo, 0o755)) {
    throw new Error("existing target is not an owned real directory");
  }
  if (!sameCanonicalPath(await realpath(root), root)) throw new Error("existing target is not canonical");
  const marker = await readOwnedInstallMarker(root);
  const topLevel = (await readdir(root)).sort();
  const expectedTopLevel = [...SOURCE_ENTRIES.map((entry) => entry.name), INSTALL_MARKER_NAME].sort();
  if (
    topLevel.length !== expectedTopLevel.length ||
    !topLevel.every((name, index) => name === expectedTopLevel[index])
  ) {
    throw new Error("owned tree contains unexpected top-level content");
  }
  const entries = [];
  const budget = treeBudget("owned tree");
  await scanOwnedDirectory(root, "", entries, budget);
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const manifestSha256 = manifestDigest(entries);
  if (manifestSha256 !== marker.manifestSha256) {
    throw new Error("owned tree manifest does not match its ownership marker");
  }
  if (expectedManifestSha256 !== null && manifestSha256 !== expectedManifestSha256) {
    throw new Error("owned tree manifest does not match the transaction");
  }
  return { manifestSha256, marker };
}

async function healDriftedOwnedTreeIfSafe(targetRoot, testMode) {
  // 手工覆盖/半截同步会导致「标记哈希 ≠ 目录内容」。仅在当前用户规范安装根、
  // 且顶层结构仍是我们的 owned tree 时，删掉后按 absent 重装。
  await requireCurrentUserLegacyTarget(targetRoot, testMode);
  const rootInfo = await lstat(targetRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || !modeMatches(rootInfo, 0o755)) {
    throw new Error("existing target is not an owned real directory");
  }
  if (!sameCanonicalPath(await realpath(targetRoot), targetRoot)) {
    throw new Error("existing target is not canonical");
  }
  await readOwnedInstallMarker(targetRoot);
  const topLevel = (await readdir(targetRoot)).sort();
  const expectedTopLevel = [...SOURCE_ENTRIES.map((entry) => entry.name), INSTALL_MARKER_NAME].sort();
  if (
    topLevel.length !== expectedTopLevel.length ||
    !topLevel.every((name, index) => name === expectedTopLevel[index])
  ) {
    throw new Error("owned tree contains unexpected top-level content");
  }
  await rm(targetRoot, { recursive: true, force: false });
  await syncDirectory(dirname(targetRoot));
}

function testCurrentUserHome(testMode) {
  if (testMode === undefined) return userInfo().homedir;
  if (!exactKeys(testMode, ["currentUserHome"])) {
    throw new Error("testMode must contain only currentUserHome");
  }
  return assertAbsolutePath(testMode.currentUserHome, "testMode currentUserHome");
}

async function requireCurrentUserLegacyTarget(targetRoot, testMode) {
  const canonicalHome = await realpath(testCurrentUserHome(testMode));
  const expected = join(canonicalHome, ".codex", INSTALL_PRODUCT);
  if (!sameCanonicalPath(targetRoot, expected)) {
    throw new Error("legacy install adoption is restricted to the current user's canonical stable target");
  }
}

async function validateLegacyTree(root, {
  requireCurrentTarget = false,
  expectedManifestSha256 = null,
  expectedCommit,
  testMode,
} = {}) {
  if (requireCurrentTarget) await requireCurrentUserLegacyTarget(root, testMode);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || !modeMatches(rootInfo, 0o755)) {
    throw new Error("legacy target is not a mode 0755 real directory");
  }
  if (!sameCanonicalPath(await realpath(root), root)) {
    throw new Error("legacy target is not canonical");
  }
  const topLevel = (await readdir(root)).sort();
  const hasCommit = topLevel.includes("INSTALLED_COMMIT");
  const expectedTopLevel = [
    ...SOURCE_ENTRIES.map((entry) => entry.name),
    ...(hasCommit ? ["INSTALLED_COMMIT"] : []),
  ].sort();
  if (
    topLevel.length !== expectedTopLevel.length ||
    !topLevel.every((name, index) => name === expectedTopLevel[index])
  ) {
    throw new Error("legacy target contains unexpected top-level content");
  }

  let commit = null;
  if (hasCommit) {
    const commitPath = join(root, "INSTALLED_COMMIT");
    const commitInfo = await lstat(commitPath);
    if (commitInfo.isSymbolicLink() || !commitInfo.isFile() || !modeMatches(commitInfo, 0o644)) {
      throw new Error("legacy INSTALLED_COMMIT must be a mode 0644 regular file");
    }
    const commitText = (await readStableFile(commitPath, "legacy INSTALLED_COMMIT", {
      maxBytes: 41,
    })).bytes.toString("utf8");
    if (!/^[a-f0-9]{40}\n$/.test(commitText)) {
      throw new Error("legacy INSTALLED_COMMIT format is invalid");
    }
    commit = commitText.trim();
  }
  if (expectedCommit !== undefined && commit !== expectedCommit) {
    throw new Error("legacy INSTALLED_COMMIT does not match the transaction");
  }

  const packageDocument = JSON.parse((await readStableFile(
    join(root, "package.json"),
    "legacy package.json",
    { maxBytes: MAX_PACKAGE_BYTES },
  )).bytes.toString("utf8"));
  if (
    packageDocument?.name !== INSTALL_PRODUCT ||
    packageDocument?.type !== "module" ||
    !exactKeys(packageDocument?.bin, ["heige-codex-skin"]) ||
    packageDocument.bin["heige-codex-skin"] !== "src/cli.mjs"
  ) {
    throw new Error("legacy package identity is invalid");
  }
  const cliPath = join(root, "src", "cli.mjs");
  const cliInfo = await lstat(cliPath);
  if (cliInfo.isSymbolicLink() || !cliInfo.isFile() || !modeMatches(cliInfo, 0o755)) {
    throw new Error("legacy CLI identity file is invalid");
  }
  const cliText = (await readStableFile(cliPath, "legacy CLI identity", {
    maxBytes: 1024 * 1024,
  })).bytes.toString("utf8");
  if (
    !cliText.startsWith("#!/usr/bin/env node\n") ||
    !cliText.includes("resolveStudioPaths") ||
    !cliText.includes('from "./constants.mjs"')
  ) {
    throw new Error("legacy CLI identity signature is invalid");
  }
  const enablePath = join(root, "scripts", "enable-persist.command");
  const enableInfo = await lstat(enablePath);
  if (enableInfo.isSymbolicLink() || !enableInfo.isFile() || !modeMatches(enableInfo, 0o755)) {
    throw new Error("legacy enable entrypoint identity file is invalid");
  }
  const enableText = (await readStableFile(enablePath, "legacy enable entrypoint identity", {
    maxBytes: 1024 * 1024,
  })).bytes.toString("utf8");
  const isHistoricalEnable = enableText.includes("skin-watchdog.zsh")
    && enableText.includes("launchctl bootstrap")
    && enableText.includes("com.heige.codex-skin-watchdog");
  const isCurrentEnable = enableText.includes("run-cli.zsh")
    && enableText.includes("enable-skin");
  const isOption1DeprecatedEnable = enableText === OPTION1_DEPRECATED_ENABLE_ENTRYPOINT;
  if (
    !enableText.startsWith("#!/bin/zsh\n") ||
    (!isHistoricalEnable && !isCurrentEnable && !isOption1DeprecatedEnable)
  ) {
    throw new Error("legacy enable entrypoint identity signature is invalid");
  }

  const entries = [];
  const budget = treeBudget("legacy tree");
  await scanOwnedDirectory(root, "", entries, budget);
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const manifestSha256 = manifestDigest(entries);
  if (expectedManifestSha256 !== null && manifestSha256 !== expectedManifestSha256) {
    throw new Error("legacy tree manifest does not match the transaction");
  }
  return { commit, manifestSha256 };
}

async function writeNewDurableFile(path, bytes, mode) {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function copyDirectory(sourceRoot, destinationRoot, relativePath, entries, budget, hooks) {
  const source = relativePath === "" ? sourceRoot : join(sourceRoot, relativePath);
  const destination = relativePath === "" ? destinationRoot : join(destinationRoot, relativePath);
  const label = `source directory ${relativePath || "."}`;
  const sourceIdentity = await captureDirectoryIdentity(source, label);
  if (relativePath !== "") {
    reserveTreeEntry(budget, relativePath);
    await mkdir(destination, { mode: 0o755 });
    await chmod(destination, 0o755);
    entries.push({ path: relativePath, type: "directory", mode: 0o755 });
  }
  const children = await readdir(source, { withFileTypes: true });
  await hooks.afterSourceDirectoryOpened?.({ path: source, relativePath });
  await assertDirectoryIdentity(source, sourceIdentity, label);
  children.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const child of children) {
    await assertDirectoryIdentity(source, sourceIdentity, label);
    const childRelative = relativePath === "" ? child.name : join(relativePath, child.name);
    const childSource = join(sourceRoot, childRelative);
    const childDestination = join(destinationRoot, childRelative);
    const childInfo = await lstat(childSource);
    if (childInfo.isSymbolicLink()) throw new Error(`source symlink is forbidden: ${childRelative}`);
    if (childInfo.isDirectory()) {
      await copyDirectory(sourceRoot, destinationRoot, childRelative, entries, budget, hooks);
      continue;
    }
    if (!childInfo.isFile()) throw new Error(`unsupported source entry: ${childRelative}`);
    reserveTreeEntry(budget, childRelative);
    const file = await readStableFile(childSource, `source file ${childRelative}`, {
      budget,
      afterOpenStat: hooks.afterSourceFileOpened,
    });
    await writeNewDurableFile(childDestination, file.bytes, file.mode);
    entries.push({
      path: childRelative,
      type: "file",
      mode: file.mode,
      size: file.bytes.byteLength,
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
    });
  }
  await assertDirectoryIdentity(source, sourceIdentity, label);
  await syncDirectory(destination);
}

async function validateSourceRoot(sourceRoot) {
  await requireCanonicalDirectory(sourceRoot, "sourceRoot");
  const sourceIdentity = await captureDirectoryIdentity(sourceRoot, "sourceRoot");
  for (const entry of SOURCE_ENTRIES) {
    await assertDirectoryIdentity(sourceRoot, sourceIdentity, "sourceRoot");
    const info = await lstat(join(sourceRoot, entry.name));
    if (info.isSymbolicLink()) throw new Error(`source symlink is forbidden: ${entry.name}`);
    if (entry.type === "file" ? !info.isFile() : !info.isDirectory()) {
      throw new Error(`source entry has the wrong type: ${entry.name}`);
    }
  }
  const packageDocument = JSON.parse((await readStableFile(
    join(sourceRoot, "package.json"),
    "source package.json",
    { maxBytes: MAX_PACKAGE_BYTES },
  )).bytes.toString("utf8"));
  if (
    packageDocument?.name !== INSTALL_PRODUCT
    || packageDocument?.type !== "module"
    || !exactKeys(packageDocument?.bin, ["heige-codex-skin"])
    || packageDocument.bin["heige-codex-skin"] !== "src/cli.mjs"
  ) throw new Error("source package identity is invalid");
  const cliPath = join(sourceRoot, "src", "cli.mjs");
  const cliInfo = await lstat(cliPath);
  if (cliInfo.isSymbolicLink() || !cliInfo.isFile()) throw new Error("source CLI identity is invalid");
  const cli = (await readStableFile(cliPath, "source CLI identity", {
    maxBytes: 1024 * 1024,
  })).bytes.toString("utf8");
  if (!cli.startsWith("#!/usr/bin/env node\n")) throw new Error("source CLI identity is invalid");
  const enablePath = join(sourceRoot, "scripts", "enable-skin.command");
  const enableInfo = await lstat(enablePath);
  if (
    enableInfo.isSymbolicLink()
    || !enableInfo.isFile()
    || (process.platform !== "win32" && (enableInfo.mode & 0o111) === 0)
  ) throw new Error("source stable enable entrypoint is invalid");
  await assertDirectoryIdentity(sourceRoot, sourceIdentity, "sourceRoot");
  return sourceIdentity;
}

async function stageSourceTree({ sourceRoot, sourceIdentity, stagePath, hooks = {} }) {
  await mkdir(stagePath, { mode: 0o755 });
  await chmod(stagePath, 0o755);
  await syncDirectory(dirname(stagePath));
  await hooks.afterStageCreated?.({ stagePath });
  const entries = [];
  const budget = treeBudget("source tree");
  reserveTreeEntry(budget, INSTALL_MARKER_NAME);
  for (const entry of SOURCE_ENTRIES) {
    await assertDirectoryIdentity(sourceRoot, sourceIdentity, "sourceRoot");
    if (entry.type === "directory") {
      await copyDirectory(sourceRoot, stagePath, entry.name, entries, budget, hooks);
      continue;
    }
    const sourcePath = join(sourceRoot, entry.name);
    reserveTreeEntry(budget, entry.name);
    const file = await readStableFile(sourcePath, `source file ${entry.name}`, {
      budget,
      afterOpenStat: hooks.afterSourceFileOpened,
    });
    await writeNewDurableFile(join(stagePath, entry.name), file.bytes, file.mode);
    entries.push({
      path: entry.name,
      type: "file",
      mode: file.mode,
      size: file.bytes.byteLength,
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
    });
  }
  await assertDirectoryIdentity(sourceRoot, sourceIdentity, "sourceRoot");
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const manifestSha256 = manifestDigest(entries);
  const marker = {
    schemaVersion: 1,
    product: INSTALL_PRODUCT,
    kind: "stable-tree",
    manifestSha256,
  };
  await writeNewDurableFile(
    join(stagePath, INSTALL_MARKER_NAME),
    Buffer.from(`${JSON.stringify(marker)}\n`),
    0o600,
  );
  await syncDirectory(stagePath);
  return manifestSha256;
}

async function syncDirectory(path) {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function injectFailure(faultAt, phase) {
  if (faultAt !== phase) return;
  const error = new Error(`INJECTED_INSTALL_FAILURE at ${phase}`);
  error.code = "INJECTED_INSTALL_FAILURE";
  error.phase = phase;
  throw error;
}

function assertManifestHash(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function assertParticipant(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("install tree participant is invalid");
  }
  if (value.schemaVersion !== 1 || value.product !== INSTALL_PRODUCT) {
    throw new Error("install tree participant schema is invalid");
  }
  if (!exactKeys(value, PARTICIPANT_KEYS)) {
    throw new Error("install tree participant has unknown or missing fields");
  }
  const targetRoot = assertAbsolutePath(value.targetRoot, "participant targetRoot");
  if (typeof value.transactionId !== "string" || !UUID_PATTERN.test(value.transactionId)) {
    throw new Error("participant transaction id is invalid");
  }
  const stagePath = `${targetRoot}.staged.${value.transactionId}`;
  const backupPath = `${targetRoot}.backup.${value.transactionId}`;
  const intentPath = preparationIntentPathFor(targetRoot);
  if (
    value.stagePath !== stagePath
    || value.backupPath !== backupPath
    || value.intentPath !== intentPath
  ) {
    throw new Error("participant paths are not derived from its canonical target and transaction id");
  }
  if (typeof value.beforeExisted !== "boolean" || typeof value.unchanged !== "boolean") {
    throw new Error("participant flags are invalid");
  }
  if (!["absent", "legacy", "owned"].includes(value.beforeKind)) {
    throw new Error("participant before-kind is invalid");
  }
  if (value.beforeExisted !== (value.beforeKind !== "absent")) {
    throw new Error("participant before-kind contradicts beforeExisted");
  }
  if (value.beforeExisted) {
    assertManifestHash(value.beforeManifestSha256, "before manifest");
  } else if (value.beforeManifestSha256 !== null) {
    throw new Error("absent prestate cannot have a manifest");
  }
  if (value.beforeKind === "legacy") {
    if (
      value.beforeLegacyCommit !== null
      && (typeof value.beforeLegacyCommit !== "string"
        || !/^[a-f0-9]{40}$/.test(value.beforeLegacyCommit))
    ) {
      throw new Error("participant legacy commit is invalid");
    }
    if (value.unchanged) throw new Error("legacy participant cannot be unchanged");
  } else if (value.beforeLegacyCommit !== null) {
    throw new Error("non-legacy participant cannot have a legacy commit");
  }
  assertManifestHash(value.afterManifestSha256, "after manifest");
  return value;
}

export function validateInstallTreeParticipant(value) {
  return assertParticipant(value);
}

function journalPathFor(targetRoot) {
  return `${targetRoot}.install-journal.json`;
}

function preparationIntentPathFor(targetRoot) {
  return `${targetRoot}.install-prepare.json`;
}

function lockPathFor(targetRoot) {
  return `${targetRoot}.install.lock`;
}

function assertPreparationIntent(value, targetRoot = value?.targetRoot) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || !exactKeys(value, PREPARATION_INTENT_KEYS)
    || value.schemaVersion !== 1
    || value.product !== INSTALL_PRODUCT
    || value.operation !== "prepare-install-tree"
    || typeof value.transactionId !== "string"
    || !UUID_PATTERN.test(value.transactionId)
  ) throw new Error("install tree preparation intent schema is invalid");
  targetRoot = assertAbsolutePath(targetRoot, "preparation intent targetRoot");
  if (
    value.targetRoot !== targetRoot
    || value.stagePath !== `${targetRoot}.staged.${value.transactionId}`
    || value.backupPath !== `${targetRoot}.backup.${value.transactionId}`
  ) throw new Error("install tree preparation intent paths are invalid");
  return value;
}

async function readPreparationIntent(targetRoot) {
  const intentPath = preparationIntentPathFor(targetRoot);
  const info = await pathInfo(intentPath);
  if (info === null) return null;
  if (info.isSymbolicLink() || !info.isFile() || !modeMatches(info, 0o600)) {
    throw new Error("install tree preparation intent is not a mode 0600 regular file");
  }
  const bytes = (await readStableFile(intentPath, "install tree preparation intent", {
    maxBytes: MAX_JOURNAL_BYTES,
  })).bytes;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error("install tree preparation intent JSON is invalid", { cause });
  }
  if (text !== `${JSON.stringify(value)}\n`) {
    throw new Error("install tree preparation intent JSON is not canonical");
  }
  return assertPreparationIntent(value, targetRoot);
}

async function createPreparationIntent(targetRoot, transactionId) {
  const value = assertPreparationIntent({
    schemaVersion: 1,
    product: INSTALL_PRODUCT,
    operation: "prepare-install-tree",
    transactionId,
    targetRoot,
    stagePath: `${targetRoot}.staged.${transactionId}`,
    backupPath: `${targetRoot}.backup.${transactionId}`,
  }, targetRoot);
  await writeDurableBytes(
    preparationIntentPathFor(targetRoot),
    Buffer.from(`${JSON.stringify(value)}\n`),
    { exclusive: true, mode: 0o600 },
  );
  return value;
}

async function clearPreparationIntent(targetRoot, expectedTransactionId) {
  const intent = await readPreparationIntent(targetRoot);
  if (intent === null) return false;
  if (intent.transactionId !== expectedTransactionId) {
    throw new Error("install tree preparation intent transaction changed before cleanup");
  }
  await unlink(preparationIntentPathFor(targetRoot));
  await syncDirectory(dirname(targetRoot));
  return true;
}

async function validatePartialStageDirectory(root, relativePath, budget) {
  const path = relativePath === "" ? root : join(root, relativePath);
  const info = await lstat(path);
  if (
    info.isSymbolicLink()
    || !info.isDirectory()
    || (process.platform !== "win32" && (info.mode & 0o022) !== 0)
  ) throw new Error(`partial install stage contains an unsafe directory: ${relativePath || "."}`);
  if (relativePath !== "") reserveTreeEntry(budget, relativePath);
  const children = await readdir(path, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const child of children) {
    const childRelative = relativePath === "" ? child.name : join(relativePath, child.name);
    const childPath = join(root, childRelative);
    const childInfo = await lstat(childPath);
    if (childInfo.isSymbolicLink()) {
      throw new Error(`partial install stage contains a symlink: ${childRelative}`);
    }
    if (childInfo.isDirectory()) {
      await validatePartialStageDirectory(root, childRelative, budget);
      continue;
    }
    if (
      !childInfo.isFile()
      || childInfo.size > MAX_INSTALL_SOURCE_FILE_BYTES
      || (process.platform !== "win32" && (childInfo.mode & 0o022) !== 0)
    ) throw new Error(`partial install stage contains an unsafe file: ${childRelative}`);
    reserveTreeEntry(budget, childRelative);
    reserveBudget(budget, BigInt(childInfo.size));
  }
}

async function validatePartialPreparationStage(intent) {
  const rootInfo = await lstat(intent.stagePath);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("partial install stage is not a real directory");
  }
  if (!sameCanonicalPath(await realpath(intent.stagePath), intent.stagePath)) {
    throw new Error("partial install stage is not canonical");
  }
  const topLevel = await readdir(intent.stagePath);
  const allowed = new Map(SOURCE_ENTRIES.map((entry) => [entry.name, entry.type]));
  allowed.set(INSTALL_MARKER_NAME, "file");
  for (const name of topLevel) {
    const expectedType = allowed.get(name);
    if (expectedType === undefined) {
      throw new Error(`partial install stage contains unexpected top-level content: ${name}`);
    }
    const info = await lstat(join(intent.stagePath, name));
    if (
      info.isSymbolicLink()
      || (expectedType === "file" ? !info.isFile() : !info.isDirectory())
    ) throw new Error(`partial install stage top-level type is invalid: ${name}`);
  }
  await validatePartialStageDirectory(
    intent.stagePath,
    "",
    treeBudget("partial install stage", MAX_INSTALL_SOURCE_TREE_BYTES + MAX_JOURNAL_BYTES),
  );
}

async function recoverPreparationIntentUnderLock(targetRoot) {
  const intent = await readPreparationIntent(targetRoot);
  if (intent === null) return { recovered: false };
  if (await pathInfo(intent.backupPath)) {
    throw new Error("install preparation unexpectedly created a backup before publication");
  }
  if (await pathInfo(intent.stagePath)) {
    if (await pathInfo(join(intent.stagePath, INSTALL_MARKER_NAME))) {
      try {
        await validateOwnedTree(intent.stagePath);
      } catch {
        await validatePartialPreparationStage(intent);
      }
    } else {
      await validatePartialPreparationStage(intent);
    }
    await rm(intent.stagePath, { recursive: true, force: false });
    await syncDirectory(dirname(targetRoot));
  }
  await clearPreparationIntent(targetRoot, intent.transactionId);
  return { recovered: true, action: "prepare-cleanup" };
}

async function writeDurableBytes(path, bytes, { exclusive = false, mode = 0o600 } = {}) {
  const parent = dirname(path);
  const temporary = `${path}.next.${process.pid}.${randomUUID()}`;
  let temporaryCreated = false;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode });
    temporaryCreated = true;
    await chmod(temporary, mode);
    const handle = await open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (exclusive) {
      await link(temporary, path);
      await unlink(temporary);
      temporaryCreated = false;
    } else {
      await rename(temporary, path);
      temporaryCreated = false;
    }
    await syncDirectory(parent);
  } catch (error) {
    if (temporaryCreated) await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeDurableJson(path, value, options) {
  return writeDurableBytes(path, Buffer.from(`${JSON.stringify(value)}\n`), options);
}

function validateJournal(value, targetRoot) {
  if (!exactKeys(value, JOURNAL_KEYS)) throw new Error("install journal schema is invalid");
  if (
    value.schemaVersion !== 1 ||
    value.product !== INSTALL_PRODUCT ||
    value.operation !== "install-tree" ||
    typeof value.transactionId !== "string" ||
    !UUID_PATTERN.test(value.transactionId) ||
    !["undecided", "rollback", "commit"].includes(value.decision) ||
    ![
      "staged",
      "backup-detached",
      "target-published",
      "rollback-decided",
      "commit-decided",
    ].includes(value.phase) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.nonce !== "string" ||
    !UUID_PATTERN.test(value.nonce) ||
    !(value.previousNonce === null || UUID_PATTERN.test(value.previousNonce)) ||
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    (value.decision === "commit") !== (value.phase === "commit-decided") ||
    (value.decision === "rollback") !== (value.phase === "rollback-decided")
  ) {
    throw new Error("install journal fields are invalid");
  }
  const participant = assertParticipant(value.participant);
  if (participant.targetRoot !== targetRoot || participant.transactionId !== value.transactionId) {
    throw new Error("install journal participant does not match its canonical target");
  }
  return { ...value, participant };
}

async function readJournal(targetRoot) {
  const path = journalPathFor(targetRoot);
  const info = await pathInfo(path);
  if (info === null) return null;
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.size <= 0 ||
    info.size > MAX_JOURNAL_BYTES ||
    (process.platform !== "win32" && (info.mode & 0o777) !== 0o600)
  ) {
    throw new Error("install journal is not a private regular file");
  }
  let value;
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
    (await readStableFile(path, "install journal")).bytes,
  );
  try {
    value = JSON.parse(decoded);
  } catch (cause) {
    throw new Error("install journal is not valid JSON", { cause });
  }
  if (decoded !== `${JSON.stringify(value)}\n`) {
    throw new Error("install journal JSON is not canonical");
  }
  return validateJournal(value, targetRoot);
}

async function createJournal(targetRoot, participant) {
  const journal = validateJournal({
    schemaVersion: 1,
    product: INSTALL_PRODUCT,
    operation: "install-tree",
    transactionId: participant.transactionId,
    revision: 0,
    nonce: randomUUID(),
    previousNonce: null,
    decision: "undecided",
    phase: "staged",
    createdAt: new Date().toISOString(),
    participant,
  }, targetRoot);
  try {
    await writeDurableJson(journalPathFor(targetRoot), journal, { exclusive: true, mode: 0o600 });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("unfinished install journal already exists");
    throw error;
  }
  return journal;
}

async function updateJournal(targetRoot, journal, changes) {
  const next = validateJournal({
    ...journal,
    ...changes,
    previousNonce: journal.nonce,
    nonce: randomUUID(),
    revision: journal.revision + 1,
  }, targetRoot);
  await writeDurableJson(journalPathFor(targetRoot), next, { mode: 0o600 });
  return next;
}

async function clearJournal(targetRoot) {
  const path = journalPathFor(targetRoot);
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await syncDirectory(dirname(path));
}

async function validateLock(lockPath) {
  const info = await lstat(lockPath);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    (process.platform !== "win32" && (info.mode & 0o777) !== 0o700) ||
    !sameCanonicalPath(await realpath(lockPath), lockPath)
  ) {
    throw new Error("install lock is not an owned private directory");
  }
  const names = (await readdir(lockPath)).sort();
  if (names.length !== 1 || names[0] !== "owner.json") {
    throw new Error("install lock contains unknown content");
  }
  const ownerPath = join(lockPath, "owner.json");
  const ownerInfo = await lstat(ownerPath);
  if (
    ownerInfo.isSymbolicLink() ||
    !ownerInfo.isFile() ||
    ownerInfo.size > MAX_JOURNAL_BYTES ||
    (process.platform !== "win32" && (ownerInfo.mode & 0o777) !== 0o600)
  ) {
    throw new Error("install lock owner is invalid");
  }
  const owner = JSON.parse((await readStableFile(ownerPath, "install lock owner")).bytes.toString("utf8"));
  const schema1 = exactKeys(owner, ["createdAt", "nonce", "pid", "schemaVersion"]) &&
    owner.schemaVersion === 1;
  const schema2 = exactKeys(
    owner,
    ["createdAt", "nonce", "pid", "schemaVersion", "startedAt"],
  ) && owner.schemaVersion === 2;
  if (
    (!schema1 && !schema2) ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.nonce !== "string" ||
    !UUID_PATTERN.test(owner.nonce) ||
    (schema2 && (
      typeof owner.startedAt !== "string" ||
      owner.startedAt.length === 0
    )) ||
    typeof owner.createdAt !== "string" ||
    Number.isNaN(Date.parse(owner.createdAt))
  ) {
    throw new Error("install lock owner schema is invalid");
  }
  return owner;
}

async function acquireInstallLock(targetRoot, identityReader = readProcessIdentity) {
  const parent = await ensureTargetParent(targetRoot);
  const lockPath = lockPathFor(targetRoot);
  const identity = await identityReader(process.pid);
  if (
    identity?.pid !== process.pid ||
    typeof identity.startedAt !== "string" ||
    identity.startedAt.length === 0
  ) {
    throw new Error("cannot establish the stable tree installer process identity");
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await chmod(lockPath, 0o700);
      const owner = {
        schemaVersion: 2,
        pid: process.pid,
        startedAt: identity.startedAt,
        nonce: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      try {
        await writeDurableJson(join(lockPath, "owner.json"), owner, {
          exclusive: true,
          mode: 0o600,
        });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        await syncDirectory(parent).catch(() => undefined);
        throw error;
      }
      return async () => {
        const current = await validateLock(lockPath);
        if (
          current.pid !== owner.pid ||
          current.startedAt !== owner.startedAt ||
          current.nonce !== owner.nonce
        ) {
          throw new Error("install lock ownership changed before release");
        }
        await rm(lockPath, { recursive: true, force: false });
        await syncDirectory(parent);
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const owner = await validateLock(lockPath);
    const current = await identityReader(owner.pid);
    if (
      (owner.schemaVersion === 1 && current !== null) ||
      (owner.schemaVersion === 2 && sameProcessIdentity(current, owner))
    ) {
      throw new Error("another stable tree installation is still running");
    }
    const stalePath = `${lockPath}.stale.${randomUUID()}`;
    try {
      await rename(lockPath, stalePath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    await validateLock(stalePath);
    await rm(stalePath, { recursive: true, force: false });
    await syncDirectory(parent);
  }
  throw new Error("could not acquire the stable tree install lock");
}

export async function acquireInstallTreeParticipantLock({
  targetRoot,
  readProcessIdentity: identityReader,
} = {}) {
  targetRoot = await canonicalizeTargetRoot(targetRoot);
  const release = await acquireInstallLock(targetRoot, identityReader);
  return Object.freeze({ targetRoot, release });
}

export async function recoverInstallTreePreparationUnderLock({ targetRoot } = {}) {
  targetRoot = await canonicalizeTargetRoot(targetRoot);
  return recoverPreparationIntentUnderLock(targetRoot);
}

async function removeExactOwnedTree(path, manifestSha256) {
  await validateOwnedTree(path, manifestSha256);
  await rm(path, { recursive: true, force: false });
  await syncDirectory(dirname(path));
}

async function validateParticipantBeforeTree(participant, path, testMode) {
  if (participant.beforeKind === "legacy") {
    await requireCurrentUserLegacyTarget(participant.targetRoot, testMode);
    return validateLegacyTree(path, {
      expectedManifestSha256: participant.beforeManifestSha256,
      expectedCommit: participant.beforeLegacyCommit,
    });
  }
  if (participant.beforeKind === "owned") {
    return validateOwnedTree(path, participant.beforeManifestSha256);
  }
  throw new Error("absent participant has no before tree to validate");
}

async function removeExactParticipantBeforeTree(participant, path, testMode) {
  await validateParticipantBeforeTree(participant, path, testMode);
  await rm(path, { recursive: true, force: false });
  await syncDirectory(dirname(path));
}

export async function prepareInstallTree({
  sourceRoot,
  targetRoot,
  transactionId = randomUUID(),
  hooks = {},
  testMode,
} = {}) {
  sourceRoot = assertAbsolutePath(sourceRoot, "sourceRoot");
  targetRoot = await canonicalizeTargetRoot(targetRoot);
  if (isWithin(sourceRoot, targetRoot) || isWithin(targetRoot, sourceRoot)) {
    throw new Error("sourceRoot and targetRoot must not contain one another");
  }
  const sourceIdentity = await validateSourceRoot(sourceRoot);
  await ensureTargetParent(targetRoot);
  if (!UUID_PATTERN.test(transactionId)) throw new Error("transaction id is invalid");
  const stagePath = `${targetRoot}.staged.${transactionId}`;
  const backupPath = `${targetRoot}.backup.${transactionId}`;
  const intentPath = preparationIntentPathFor(targetRoot);
  if (await pathInfo(stagePath) || await pathInfo(backupPath)) {
    throw new Error("transaction stage or backup path already exists");
  }
  if (await pathInfo(intentPath)) {
    throw new Error("an unfinished install tree preparation intent already exists");
  }
  const existing = await pathInfo(targetRoot);
  let before = null;
  let beforeKind = "absent";
  if (existing !== null) {
    if (await pathInfo(join(targetRoot, INSTALL_MARKER_NAME))) {
      try {
        before = await validateOwnedTree(targetRoot);
        beforeKind = "owned";
      } catch (error) {
        if (!/owned tree manifest does not match its ownership marker/.test(String(error?.message ?? ""))) {
          throw error;
        }
        try {
          await healDriftedOwnedTreeIfSafe(targetRoot, testMode);
        } catch {
          // 非当前用户规范安装根，或不满足安全结构：保留原始漂移错误。
          throw error;
        }
        before = null;
        beforeKind = "absent";
      }
    } else {
      before = await validateLegacyTree(targetRoot, { requireCurrentTarget: true, testMode });
      beforeKind = "legacy";
    }
  }
  let intent = null;
  try {
    intent = await createPreparationIntent(targetRoot, transactionId);
    await hooks.afterPreparationIntent?.({ intent });
    const afterManifestSha256 = await stageSourceTree({
      sourceRoot,
      sourceIdentity,
      stagePath,
      hooks,
    });
    const unchanged = beforeKind === "owned" && before.manifestSha256 === afterManifestSha256;
    if (unchanged) {
      await removeExactOwnedTree(stagePath, afterManifestSha256);
    }
    const participant = assertParticipant({
      schemaVersion: 1,
      product: INSTALL_PRODUCT,
      transactionId,
      targetRoot,
      stagePath,
      backupPath,
      intentPath,
      beforeExisted: before !== null,
      beforeKind,
      beforeLegacyCommit: beforeKind === "legacy" ? before.commit : null,
      beforeManifestSha256: before?.manifestSha256 ?? null,
      afterManifestSha256,
      unchanged,
    });
    if (unchanged) await clearPreparationIntent(targetRoot, transactionId);
    return participant;
  } catch (error) {
    let cleanupError = null;
    try {
      if (intent !== null) {
        await recoverPreparationIntentUnderLock(targetRoot);
      } else if (await pathInfo(stagePath)) {
        throw new Error("install stage appeared before its durable preparation intent");
      }
    } catch (failure) {
      cleanupError = failure;
    }
    if (cleanupError !== null) {
      throw new AggregateError(
        [error, cleanupError],
        "install tree preparation and cleanup both failed",
      );
    }
    throw error;
  }
}

export async function publishInstallTree(value, { faultAt, onBoundary, testMode } = {}) {
  const participant = assertParticipant(value);
  if (participant.unchanged) return { ...participant, published: false };
  const parent = await ensureTargetParent(participant.targetRoot);
  await validateOwnedTree(participant.stagePath, participant.afterManifestSha256);
  if (await pathInfo(participant.backupPath)) throw new Error("transaction backup path already exists");
  const target = await pathInfo(participant.targetRoot);
  if (participant.beforeExisted) {
    if (target === null) throw new Error("owned target disappeared before publication");
    await validateParticipantBeforeTree(participant, participant.targetRoot, testMode);
    await rename(participant.targetRoot, participant.backupPath);
    await syncDirectory(parent);
    await onBoundary?.("backup-detached", participant);
    injectFailure(faultAt, "after-backup-detached");
  } else if (target !== null) {
    throw new Error("target appeared before first publication");
  }
  await rename(participant.stagePath, participant.targetRoot);
  await syncDirectory(parent);
  await onBoundary?.("target-published", participant);
  injectFailure(faultAt, "after-target-published");
  await validateOwnedTree(participant.targetRoot, participant.afterManifestSha256);
  return { ...participant, published: true };
}

export async function rollbackInstallTree(value, { testMode } = {}) {
  const participant = assertParticipant(value);
  if (participant.unchanged) {
    await clearPreparationIntent(participant.targetRoot, participant.transactionId);
    return { ...participant, rolledBack: false };
  }
  const parent = await ensureTargetParent(participant.targetRoot);
  const backup = await pathInfo(participant.backupPath);
  const target = await pathInfo(participant.targetRoot);

  if (backup !== null) {
    if (!participant.beforeExisted) throw new Error("unexpected backup for absent prestate");
    await validateParticipantBeforeTree(participant, participant.backupPath, testMode);
    if (target !== null) {
      await removeExactOwnedTree(participant.targetRoot, participant.afterManifestSha256);
    }
    await rename(participant.backupPath, participant.targetRoot);
    await syncDirectory(parent);
  } else if (participant.beforeExisted) {
    if (target === null) throw new Error("rollback cannot find the old target or its backup");
    await validateParticipantBeforeTree(participant, participant.targetRoot, testMode);
  } else if (target !== null) {
    await removeExactOwnedTree(participant.targetRoot, participant.afterManifestSha256);
  }

  if (await pathInfo(participant.stagePath)) {
    await removeExactOwnedTree(participant.stagePath, participant.afterManifestSha256);
  }
  if (participant.beforeExisted) {
    await validateParticipantBeforeTree(participant, participant.targetRoot, testMode);
  } else if (await pathInfo(participant.targetRoot)) {
    throw new Error("rollback left a target that did not exist before the transaction");
  }
  await clearPreparationIntent(participant.targetRoot, participant.transactionId);
  return { ...participant, rolledBack: true };
}

export async function finalizeInstallTree(value, { testMode } = {}) {
  const participant = assertParticipant(value);
  if (participant.unchanged) {
    await clearPreparationIntent(participant.targetRoot, participant.transactionId);
    return { ...participant, finalized: true };
  }
  await validateOwnedTree(participant.targetRoot, participant.afterManifestSha256);
  if (await pathInfo(participant.stagePath)) {
    await removeExactOwnedTree(participant.stagePath, participant.afterManifestSha256);
  }
  if (await pathInfo(participant.backupPath)) {
    if (!participant.beforeExisted) throw new Error("unexpected backup for absent prestate");
    await removeExactParticipantBeforeTree(participant, participant.backupPath, testMode);
  }
  await clearPreparationIntent(participant.targetRoot, participant.transactionId);
  return { ...participant, finalized: true };
}

async function recoverJournalUnderLock(targetRoot, { testMode } = {}) {
  let journal = await readJournal(targetRoot);
  if (journal === null) return recoverPreparationIntentUnderLock(targetRoot);
  if (journal.decision === "commit") {
    await finalizeInstallTree(journal.participant, { testMode });
    await clearJournal(targetRoot);
    return { recovered: true, action: "roll-forward" };
  }
  if (journal.decision === "undecided") {
    journal = await updateJournal(targetRoot, journal, {
      decision: "rollback",
      phase: "rollback-decided",
    });
  }
  await rollbackInstallTree(journal.participant, { testMode });
  await clearJournal(targetRoot);
  return { recovered: true, action: "rollback" };
}

export async function recoverInstallTreeUnderLock({ targetRoot, testMode } = {}) {
  targetRoot = await canonicalizeTargetRoot(targetRoot);
  return recoverJournalUnderLock(targetRoot, { testMode });
}

export async function recoverInstallTree({ targetRoot, readProcessIdentity: identityReader, testMode } = {}) {
  targetRoot = await canonicalizeTargetRoot(targetRoot);
  const releaseLock = await acquireInstallLock(targetRoot, identityReader);
  let operationError = null;
  try {
    return await recoverJournalUnderLock(targetRoot, { testMode });
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await releaseLock();
    } catch (releaseError) {
      if (operationError !== null) {
        throw new AggregateError(
          [operationError, releaseError],
          "install recovery and lock release both failed",
        );
      }
      throw releaseError;
    }
  }
}

export async function installTree({
  sourceRoot,
  targetRoot,
  faultAt,
  hooks = {},
  readProcessIdentity: identityReader,
  testMode,
} = {}) {
  targetRoot = await canonicalizeTargetRoot(targetRoot);
  const releaseLock = await acquireInstallLock(targetRoot, identityReader);
  let operationError = null;
  try {
    const recovery = await recoverJournalUnderLock(targetRoot, { testMode });
    const participant = await prepareInstallTree({ sourceRoot, targetRoot, hooks, testMode });
    await hooks.afterPrepare?.({ participant });
    if (participant.unchanged) {
      return {
        targetRoot: participant.targetRoot,
        manifestSha256: participant.afterManifestSha256,
        installed: false,
        unchanged: true,
        migratedLegacy: false,
        recovered: recovery.recovered,
      };
    }
    let journal;
    try {
      injectFailure(faultAt, "before-journal-created");
      journal = await createJournal(targetRoot, participant);
    } catch (error) {
      let cleanupError = null;
      try {
        let persisted = await readJournal(targetRoot);
        if (persisted !== null) {
          if (
            persisted.transactionId !== participant.transactionId ||
            persisted.decision !== "undecided"
          ) {
            throw new Error("failed journal creation left an unrelated or decided journal");
          }
          persisted = await updateJournal(targetRoot, persisted, {
            decision: "rollback",
            phase: "rollback-decided",
          });
        }
        await rollbackInstallTree(participant, { testMode });
        if (persisted !== null) await clearJournal(targetRoot);
      } catch (failure) {
        cleanupError = failure;
      }
      if (cleanupError !== null) {
        throw new AggregateError(
          [error, cleanupError],
          "install journal creation and staged-tree cleanup both failed",
        );
      }
      throw error;
    }
    let commitDecided = false;
    try {
      await publishInstallTree(participant, {
        faultAt,
        testMode,
        onBoundary: async (boundary) => {
          journal = await updateJournal(targetRoot, journal, {
            phase: boundary,
          });
          const hookName = boundary === "backup-detached"
            ? "afterBackupDetached"
            : "afterTargetPublished";
          await hooks[hookName]?.({ journal, participant });
        },
      });
      journal = await updateJournal(targetRoot, journal, {
        decision: "commit",
        phase: "commit-decided",
      });
      injectFailure(faultAt, "after-commit-journal-write");
      commitDecided = true;
      await hooks.afterCommitDecision?.({ journal, participant });
      await finalizeInstallTree(participant, { testMode });
      await clearJournal(targetRoot);
      return {
        targetRoot: participant.targetRoot,
        manifestSha256: participant.afterManifestSha256,
        installed: true,
        migratedLegacy: participant.beforeKind === "legacy",
        recovered: recovery.recovered,
      };
    } catch (error) {
      let current = null;
      if (!commitDecided) {
        try {
          current = await readJournal(targetRoot);
          if (current !== null && current.transactionId !== participant.transactionId) {
            throw new Error("install journal transaction changed during publication");
          }
          if (current?.decision === "commit") commitDecided = true;
        } catch (journalError) {
          throw new AggregateError(
            [error, journalError],
            "install publication failed and its durable decision could not be verified",
          );
        }
      }
      if (commitDecided) throw error;
      let rollbackError = null;
      try {
        if (current === null) current = await readJournal(targetRoot);
        if (current !== null && current.decision === "undecided") {
          journal = await updateJournal(targetRoot, current, {
            decision: "rollback",
            phase: "rollback-decided",
          });
        }
        await rollbackInstallTree(participant, { testMode });
        await clearJournal(targetRoot);
      } catch (failure) {
        rollbackError = failure;
      }
      if (rollbackError !== null) {
        throw new AggregateError(
          [error, rollbackError],
          "install tree publication and rollback both failed",
        );
      }
      throw error;
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await releaseLock();
    } catch (releaseError) {
      if (operationError !== null) {
        throw new AggregateError(
          [operationError, releaseError],
          "install operation and lock release both failed",
        );
      }
      throw releaseError;
    }
  }
}

export async function inspectInstallTree(targetRoot) {
  targetRoot = await canonicalizeTargetRoot(targetRoot);
  const owned = await validateOwnedTree(targetRoot);
  const journal = await readJournal(targetRoot);
  return {
    targetRoot,
    manifestSha256: owned.manifestSha256,
    journal: journal === null ? null : {
      transactionId: journal.transactionId,
      decision: journal.decision,
      phase: journal.phase,
      revision: journal.revision,
    },
  };
}

async function cli(argv) {
  if (Number(process.versions.node.split(".")[0]) < 22) {
    throw new Error("Node.js 22 or newer is required");
  }
  const command = argv[0] ?? "install";
  const options = {};
  const allowedByCommand = {
    install: new Set(["source", "target"]),
    recover: new Set(["target"]),
    "participant-prepare": new Set(["source", "target", "transaction-id"]),
    "participant-publish": new Set(["participant-json"]),
    "participant-rollback": new Set(["participant-json"]),
    "participant-finalize": new Set(["participant-json"]),
    "participant-recover-prepare": new Set(["target"]),
  };
  const allowed = allowedByCommand[command];
  if (allowed === undefined) throw new Error(`unknown install transaction command: ${command}`);
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("invalid install arguments");
    const name = flag.slice(2);
    if (!allowed.has(name) || Object.hasOwn(options, name)) {
      throw new Error(`unknown or duplicate install option: ${flag}`);
    }
    options[name] = value;
  }
  if (command === "install") {
    if (!options.source || !options.target) throw new Error("install requires --source and --target");
    return installTree({ sourceRoot: options.source, targetRoot: options.target });
  }
  if (command === "recover") {
    if (!options.target) throw new Error("recover requires only --target");
    return recoverInstallTree({ targetRoot: options.target });
  }
  if (command === "participant-prepare") {
    if (!options.source || !options.target || !options["transaction-id"]) {
      throw new Error("participant-prepare requires --source --target and --transaction-id");
    }
    return prepareInstallTree({
      sourceRoot: options.source,
      targetRoot: options.target,
      transactionId: options["transaction-id"],
    });
  }
  if (command === "participant-recover-prepare") {
    if (!options.target) throw new Error("participant-recover-prepare requires --target");
    return recoverInstallTree({ targetRoot: options.target });
  }
  const participant = (() => {
    if (!options["participant-json"]) {
      throw new Error(`${command} requires --participant-json`);
    }
    if (Buffer.byteLength(options["participant-json"], "utf8") > MAX_JOURNAL_BYTES) {
      throw new Error("participant JSON exceeds the install bound");
    }
    try {
      return JSON.parse(options["participant-json"]);
    } catch (cause) {
      throw new Error("participant JSON is invalid", { cause });
    }
  })();
  if (command === "participant-publish") return publishInstallTree(participant);
  if (command === "participant-rollback") return rollbackInstallTree(participant);
  if (command === "participant-finalize") return finalizeInstallTree(participant);
  throw new Error(`unknown install transaction command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cli(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`HeiGe stable tree install failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
