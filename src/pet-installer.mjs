import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { validateImageMetadata } from "./image-metadata.mjs";
import { parseBoundedJson, readBoundedFile, RESOURCE_LIMITS } from "./resource-limits.mjs";

const CONFIG_BYTES = 1024 * 1024;
const MANIFEST_KEYS = Object.freeze([
  "description",
  "displayName",
  "id",
  "spriteVersionNumber",
  "spritesheetPath",
]);
const PET_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SELECTED_PET_ID = /^custom:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const TABLE_HEADER = /^\s*\[\[?[^\]\r\n]+\]\]?\s*(?:#.*)?$/;
const DESKTOP_HEADER = /^\s*\[desktop\]\s*(?:#.*)?$/;
const SELECTED_KEY = /^\s*selected-avatar-id\s*=/;

function stageError(label, error) {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${label}：${detail}`, { cause: error });
}

function uniqueSuffix() {
  return `${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;
}

function requireAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new TypeError(`${label}必须是绝对路径`);
  }
  return resolve(value);
}

function validateText(value, label, maxLength) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new TypeError(`pet.json 的 ${label} 必须是 1 到 ${maxLength} 个字符的字符串`);
  }
}

function validateManifest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("pet.json 必须是对象");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== MANIFEST_KEYS.length || keys.some((key, index) => key !== MANIFEST_KEYS[index])) {
    throw new TypeError(`pet.json 必须只包含精确字段：${MANIFEST_KEYS.join(", ")}`);
  }
  if (typeof value.id !== "string" || !PET_ID.test(value.id)) {
    throw new TypeError("pet.json 的 id 格式无效");
  }
  validateText(value.displayName, "displayName", 80);
  validateText(value.description, "description", 500);
  if (value.spriteVersionNumber !== 2) {
    throw new TypeError("pet.json 的 spriteVersionNumber 必须是 2");
  }
  if (value.spritesheetPath !== "spritesheet.webp") {
    throw new TypeError('pet.json 的 spritesheetPath 必须是 "spritesheet.webp"');
  }
  return Object.freeze({ ...value });
}

function bytesEqual(left, right) {
  return left.byteLength === right.byteLength && Buffer.from(left).equals(Buffer.from(right));
}

async function inspectDirectory(path, { allowMissing = false } = {}) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new TypeError(`目录类型无效：${path}`);
    }
    return info;
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureDirectory(path, mode = 0o700) {
  await mkdir(path, { recursive: true, mode });
  return inspectDirectory(path);
}

async function syncPath(path) {
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readPetDirectory(root, { requireExactFiles = true } = {}) {
  const directory = await inspectDirectory(root);
  if (requireExactFiles) {
    const entries = (await readdir(root)).sort();
    if (
      entries.length !== 2
      || entries[0] !== "pet.json"
      || entries[1] !== "spritesheet.webp"
    ) {
      throw new TypeError("宠物目录必须只包含 pet.json 和 spritesheet.webp");
    }
  }

  const manifestResult = await readBoundedFile(join(root, "pet.json"), {
    maxBytes: RESOURCE_LIMITS.manifestBytes,
    label: "pet.json",
  });
  const manifest = validateManifest(parseBoundedJson(manifestResult.bytes));
  const spritesheetResult = await readBoundedFile(join(root, manifest.spritesheetPath), {
    maxBytes: RESOURCE_LIMITS.assetBytes,
    label: "spritesheet.webp",
  });
  const metadata = validateImageMetadata(spritesheetResult.bytes, { expectedMime: "image/webp" });
  if (metadata.width !== 1536 || metadata.height !== 2288) {
    throw new RangeError(`v2 spritesheet 尺寸必须是 1536x2288，实际为 ${metadata.width}x${metadata.height}`);
  }
  return {
    directory,
    manifest,
    manifestBytes: manifestResult.bytes,
    spritesheetBytes: spritesheetResult.bytes,
    metadata,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function newlineOf(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function setSelectedPet(configText, petId) {
  if (typeof configText !== "string") throw new TypeError("configText 必须是字符串");
  if (typeof petId !== "string" || !SELECTED_PET_ID.test(petId)) {
    throw new TypeError("petId 必须是安全的 custom: 宠物 ID");
  }

  const newline = newlineOf(configText);
  const lines = configText === "" ? [] : configText.split(/\r?\n/);
  const hasFinalNewline = configText.endsWith("\n");
  const contentLength = hasFinalNewline ? lines.length - 1 : lines.length;
  const desktopIndexes = [];
  for (let index = 0; index < contentLength; index += 1) {
    if (DESKTOP_HEADER.test(lines[index])) desktopIndexes.push(index);
  }
  if (desktopIndexes.length > 1) {
    throw new TypeError("config.toml 含有重复的 [desktop] section");
  }

  const selectedLine = `selected-avatar-id = "${petId}"`;
  if (desktopIndexes.length === 0) {
    let prefix = configText;
    if (prefix.length > 0 && !prefix.endsWith(newline)) prefix += newline;
    if (prefix.length > 0 && !prefix.endsWith(newline + newline)) prefix += newline;
    return `${prefix}[desktop]${newline}${selectedLine}${newline}`;
  }

  const sectionStart = desktopIndexes[0] + 1;
  let sectionEnd = contentLength;
  for (let index = sectionStart; index < contentLength; index += 1) {
    if (TABLE_HEADER.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }
  const selectedIndexes = [];
  for (let index = sectionStart; index < sectionEnd; index += 1) {
    if (SELECTED_KEY.test(lines[index])) selectedIndexes.push(index);
  }
  if (selectedIndexes.length > 1) {
    throw new TypeError("[desktop] 含有重复的 selected-avatar-id");
  }

  if (selectedIndexes.length === 1) {
    const targetPattern = new RegExp(
      `^\\s*selected-avatar-id\\s*=\\s*"${escapeRegExp(petId)}"\\s*(?:#.*)?$`,
    );
    if (targetPattern.test(lines[selectedIndexes[0]])) return configText;
    lines[selectedIndexes[0]] = selectedLine;
    return lines.join(newline);
  }

  let insertion = sectionEnd;
  while (insertion > sectionStart && lines[insertion - 1].trim() === "") insertion -= 1;
  lines.splice(insertion, 0, selectedLine);
  return lines.join(newline);
}

async function readConfig(path) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false, bytes: Buffer.alloc(0), text: "", mode: 0o600 };
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new TypeError("config.toml 必须是普通文件且不得是符号链接");
  if (!Number.isSafeInteger(info.size) || info.size > CONFIG_BYTES) {
    throw new RangeError(`config.toml 超过 ${CONFIG_BYTES} bytes`);
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== info.size) throw new Error("config.toml 在读取期间发生变化");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SyntaxError("config.toml 不是有效的 UTF-8");
  }
  return { exists: true, bytes, text, mode: info.mode & 0o777, ino: info.ino };
}

async function writeSyncedExclusive(path, bytes, finalMode, afterWrite) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    if (afterWrite) await afterWrite({ path });
    if (finalMode !== 0o600) {
      await handle.chmod(finalMode);
      await handle.sync();
    }
  } finally {
    await handle.close();
  }
}

function hook(hooks, name) {
  const candidate = hooks?.[name];
  if (candidate === undefined) return null;
  if (typeof candidate !== "function") throw new TypeError(`hooks.${name} 必须是函数`);
  return candidate;
}

async function invokeHook(hooks, name, context) {
  const callback = hook(hooks, name);
  if (callback) await callback(context);
}

async function prepareConfig({ configPath, snapshot, nextText, hooks }) {
  if (nextText === snapshot.text) {
    return { changed: false, tempPath: null, backupPath: null };
  }
  const suffix = uniqueSuffix();
  const tempPath = join(dirname(configPath), `.config.toml.pet-${suffix}.tmp`);
  const nextBytes = Buffer.from(nextText, "utf8");
  let backupPath = null;
  try {
    await writeSyncedExclusive(
      tempPath,
      nextBytes,
      snapshot.exists ? snapshot.mode : 0o600,
      hook(hooks, "afterConfigTempWrite"),
    );
    if (snapshot.exists) {
      const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "");
      backupPath = `${configPath}.bak-miku-pet-${timestamp}-${randomBytes(4).toString("hex")}`;
      await writeSyncedExclusive(backupPath, snapshot.bytes, snapshot.mode);
    }
    await syncPath(dirname(configPath));
    return { changed: true, tempPath, backupPath, nextBytes };
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    if (backupPath !== null) await rm(backupPath, { force: true }).catch(() => undefined);
    await syncPath(dirname(configPath)).catch(() => undefined);
    throw error;
  }
}

async function configStillMatches(configPath, snapshot) {
  const current = await readConfig(configPath);
  return current.exists === snapshot.exists
    && current.mode === snapshot.mode
    && bytesEqual(current.bytes, snapshot.bytes);
}

async function restoreConfig(configPath, snapshot) {
  if (!snapshot.exists) {
    await rm(configPath, { force: true });
    await syncPath(dirname(configPath));
    return;
  }
  const rollbackPath = join(dirname(configPath), `.config.toml.rollback-${uniqueSuffix()}.tmp`);
  try {
    await writeSyncedExclusive(rollbackPath, snapshot.bytes, snapshot.mode);
    await rename(rollbackPath, configPath);
    await syncPath(dirname(configPath));
  } finally {
    await rm(rollbackPath, { force: true });
  }
}

async function installPetDirectory({ sourceRoot, source, petsRoot, targetRoot, hooks }) {
  const stageRoot = join(petsRoot, `.${source.manifest.id}.tmp-${uniqueSuffix()}`);
  await mkdir(stageRoot, { mode: 0o700 });
  try {
    try {
      await invokeHook(hooks, "beforeCopy", { sourceRoot, stageRoot });
      await copyFile(join(sourceRoot, "pet.json"), join(stageRoot, "pet.json"), fsConstants.COPYFILE_EXCL);
      await copyFile(
        join(sourceRoot, "spritesheet.webp"),
        join(stageRoot, "spritesheet.webp"),
        fsConstants.COPYFILE_EXCL,
      );
      await chmod(join(stageRoot, "pet.json"), 0o644);
      await chmod(join(stageRoot, "spritesheet.webp"), 0o644);
      await syncPath(join(stageRoot, "pet.json"));
      await syncPath(join(stageRoot, "spritesheet.webp"));
      await syncPath(stageRoot);
      await invokeHook(hooks, "afterCopy", { sourceRoot, stageRoot });
      const copied = await readPetDirectory(stageRoot);
      if (
        !bytesEqual(copied.manifestBytes, source.manifestBytes)
        || !bytesEqual(copied.spritesheetBytes, source.spritesheetBytes)
      ) {
        throw new Error("复制后的宠物文件与已验证源不一致");
      }
    } catch (error) {
      throw stageError("宠物复制失败", error);
    }

    let existing = null;
    const targetInfo = await inspectDirectory(targetRoot, { allowMissing: true });
    if (targetInfo !== null) {
      try {
        existing = await readPetDirectory(targetRoot);
      } catch {
        existing = null;
      }
    }
    const unchanged = existing !== null
      && bytesEqual(existing.manifestBytes, source.manifestBytes)
      && bytesEqual(existing.spritesheetBytes, source.spritesheetBytes);
    if (unchanged) {
      return { changed: false, stageRoot, retiredRoot: null };
    }

    const retiredRoot = targetInfo === null
      ? null
      : join(petsRoot, `.${source.manifest.id}.retired-${uniqueSuffix()}`);
    try {
      await invokeHook(hooks, "beforePetRename", { stageRoot, targetRoot, retiredRoot });
      if (retiredRoot !== null) await rename(targetRoot, retiredRoot);
      try {
        await rename(stageRoot, targetRoot);
      } catch (error) {
        if (retiredRoot !== null) await rename(retiredRoot, targetRoot).catch(() => undefined);
        throw error;
      }
      await syncPath(petsRoot);
    } catch (error) {
      throw stageError("宠物目录替换失败", error);
    }
    return { changed: true, stageRoot, retiredRoot };
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function rollbackPet({ targetRoot, retiredRoot, changed }) {
  if (!changed) return;
  if (retiredRoot === null) {
    await rm(targetRoot, { recursive: true, force: true });
    await syncPath(dirname(targetRoot));
    return;
  }
  const failedRoot = join(dirname(targetRoot), `.${basename(targetRoot)}.failed-${uniqueSuffix()}`);
  await rename(targetRoot, failedRoot).catch(() => undefined);
  await rename(retiredRoot, targetRoot);
  await rm(failedRoot, { recursive: true, force: true });
  await syncPath(dirname(targetRoot));
}

async function verifyFinal({ targetRoot, source, configPath, selectedPet }) {
  const installed = await readPetDirectory(targetRoot);
  if (
    !bytesEqual(installed.manifestBytes, source.manifestBytes)
    || !bytesEqual(installed.spritesheetBytes, source.spritesheetBytes)
  ) {
    throw new Error("最终宠物文件与已验证源不一致");
  }
  const config = await readConfig(configPath);
  if (!config.exists || setSelectedPet(config.text, selectedPet) !== config.text) {
    throw new Error("config.toml 未确认选中目标宠物");
  }
  return installed;
}

export async function installPet({ sourceRoot, home, hooks } = {}) {
  sourceRoot = requireAbsolutePath(sourceRoot, "sourceRoot");
  home = requireAbsolutePath(home, "home");
  await inspectDirectory(home);

  let source;
  try {
    await inspectDirectory(sourceRoot);
    source = await readPetDirectory(sourceRoot, { requireExactFiles: false });
    if (basename(sourceRoot) !== source.manifest.id) {
      throw new TypeError("宠物源目录名必须与 pet.json 的 id 一致");
    }
  } catch (error) {
    throw stageError("宠物源校验失败", error);
  }

  const codexRoot = join(home, ".codex");
  const petsRoot = join(codexRoot, "pets");
  const targetRoot = join(petsRoot, source.manifest.id);
  const configPath = join(codexRoot, "config.toml");
  await ensureDirectory(codexRoot);
  await ensureDirectory(petsRoot);

  let configSnapshot;
  let nextConfig;
  try {
    configSnapshot = await readConfig(configPath);
    nextConfig = setSelectedPet(configSnapshot.text, `custom:${source.manifest.id}`);
  } catch (error) {
    throw stageError("配置写入失败", error);
  }

  const petTransaction = await installPetDirectory({
    sourceRoot,
    source,
    petsRoot,
    targetRoot,
    hooks,
  });
  let configTransaction = null;
  let configCommitted = false;
  try {
    try {
      configTransaction = await prepareConfig({
        configPath,
        snapshot: configSnapshot,
        nextText: nextConfig,
        hooks,
      });
      if (configTransaction.changed) {
        if (!(await configStillMatches(configPath, configSnapshot))) {
          throw new Error("config.toml 在安装期间被其他进程修改");
        }
        await invokeHook(hooks, "beforeConfigRename", {
          path: configPath,
          tempPath: configTransaction.tempPath,
        });
        await rename(configTransaction.tempPath, configPath);
        configCommitted = true;
        await syncPath(codexRoot);
      }
    } catch (error) {
      throw stageError("配置写入失败", error);
    }

    try {
      await invokeHook(hooks, "beforeFinalVerify", { targetRoot, configPath });
      await verifyFinal({
        targetRoot,
        source,
        configPath,
        selectedPet: `custom:${source.manifest.id}`,
      });
    } catch (error) {
      throw stageError("最终验证失败", error);
    }

    if (petTransaction.retiredRoot !== null) {
      await rm(petTransaction.retiredRoot, { recursive: true, force: true });
      await syncPath(petsRoot);
    }
    const configChanged = Boolean(configTransaction?.changed);
    const restartRequired = configChanged || petTransaction.changed;
    return Object.freeze({
      installed: true,
      petId: source.manifest.id,
      effectivePetId: `custom:${source.manifest.id}`,
      targetRoot,
      configPath,
      petChanged: petTransaction.changed,
      configChanged,
      restartRequired,
      nextAction: restartRequired
        ? "桌宠已安装并选中，请重启 Codex 使其生效。"
        : null,
      backupPath: configTransaction?.backupPath ?? null,
    });
  } catch (error) {
    const rollbackErrors = [];
    if (configCommitted) {
      await restoreConfig(configPath, configSnapshot).catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    await rollbackPet({
      targetRoot,
      retiredRoot: petTransaction.retiredRoot,
      changed: petTransaction.changed,
    }).catch((rollbackError) => rollbackErrors.push(rollbackError));
    if (rollbackErrors.length === 0 && configTransaction?.backupPath) {
      await rm(configTransaction.backupPath, { force: true }).catch((rollbackError) => rollbackErrors.push(rollbackError));
      await syncPath(codexRoot).catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], `${error.message}；回滚失败`);
    }
    throw error;
  } finally {
    if (configTransaction?.tempPath) await rm(configTransaction.tempPath, { force: true }).catch(() => undefined);
    await rm(petTransaction.stageRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
