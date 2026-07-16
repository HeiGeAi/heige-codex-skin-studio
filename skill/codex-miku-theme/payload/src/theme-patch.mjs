import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  constants as fsConstants,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  findEntry,
  readEntry,
  replaceEntriesFixedSize,
} from "./asar.mjs";

const ENTRY_PATH = "webview/index.html";
const THEME_MARKER = "CODEX_MIKU_THEME v5 488137 SIDEBAR";
const DEFAULT_ASAR = "/Applications/ChatGPT.app/Contents/Resources/app.asar";
const INFO_PLIST = "/Applications/ChatGPT.app/Contents/Info.plist";
const SUPPORTED_APP_VERSION = "26.707.72221";
const SUPPORTED_APP_BUILD = "5307";
export const SUPPORTED_BASE_ARCHIVE_SHA256 = Object.freeze([
  "b5da51e5df6e996076e4cb19045cec46dd4c08cf61c19cdbc5cb426b8413b73c",
  "e9f0c1defb583c414e14ac81c301f15abb533dea080501ddd329846b1a67d239",
]);
const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const THEME_PATH = join(PROJECT_ROOT, "src", "theme.css");
const STATE_DIR = join(homedir(), "Library", "Application Support", "Codex Miku Theme");
const STATE_PATH = join(STATE_DIR, "state.json");
const execFileAsync = promisify(execFile);
const SWAP_PATHS_SCRIPT = `
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
renamex_np = libc.renamex_np
renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
renamex_np.restype = ctypes.c_int
result = renamex_np(os.fsencode(sys.argv[1]), os.fsencode(sys.argv[2]), 0x00000002)
if result != 0:
    error = ctypes.get_errno()
    raise OSError(error, os.strerror(error))
`;

export const THEME_ASSETS = Object.freeze([
  Object.freeze({
    role: "hero",
    sourceName: "miku-full-canvas.png",
    entryPath: "webview/assets/dialog-artwork-connected-NZKCls7p.png",
  }),
  Object.freeze({
    role: "character",
    sourceName: "miku-character.png",
    entryPath: "webview/assets/page-artwork-allow-host-CPm7eJR2.png",
  }),
  Object.freeze({
    role: "sidebar",
    sourceName: "miku-sidebar-wash.png",
    entryPath: "webview/assets/page-artwork-waiting-pzj85BPm.png",
  }),
  Object.freeze({
    role: "polaroid",
    sourceName: "miku-polaroid.png",
    entryPath: "webview/assets/dialog-artwork-waiting-phone-UTYmfLHs.png",
  }),
]);

const APP_ASSETS = THEME_ASSETS;

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateSupportedArchiveFingerprint({
  archiveSha256,
  asarPath,
  currentHtml,
  state,
}) {
  if (SUPPORTED_BASE_ARCHIVE_SHA256.includes(archiveSha256)) {
    return archiveSha256;
  }
  if (
    currentHtml.includes("CODEX_MIKU_THEME") &&
    state?.appAsar === asarPath &&
    state.themedArchiveSha256 === archiveSha256 &&
    SUPPORTED_BASE_ARCHIVE_SHA256.includes(state.originalArchiveSha256)
  ) {
    return state.originalArchiveSha256;
  }
  throw new Error(
    `Unsupported Codex resource fingerprint ${archiveSha256}; the plist version alone is not a safe compatibility boundary`,
  );
}

export function minifyThemeCss(source) {
  const marker = source.match(/\/\* CODEX_MIKU_THEME[^*]+\*\//)?.[0];
  if (!marker) throw new Error("Theme marker comment not found");

  const body = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}:;,>])\s*/g, "$1")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s*!important/g, "!important")
    .replace(/;}/g, "}")
    .trim();
  return `${marker}${body}`;
}

export function buildPatchedHtml(originalHtml, themeCss) {
  const openTag = originalHtml.indexOf("<style>");
  const contentStart = openTag < 0 ? -1 : openTag + "<style>".length;
  const contentEnd = contentStart < 0 ? -1 : originalHtml.indexOf("</style>", contentStart);

  if (contentStart < 0 || contentEnd < 0) {
    throw new Error("Codex inline style block not found");
  }

  const originalCss = originalHtml.slice(contentStart, contentEnd);
  const nextCss = `\n${themeCss.trim()}\n`;
  if (originalCss.trim() === themeCss.trim()) return originalHtml;

  const capacity = Buffer.byteLength(originalCss);
  const required = Buffer.byteLength(nextCss);
  if (required > capacity) {
    throw new Error(`Theme exceeds inline style capacity: ${required} > ${capacity} bytes`);
  }

  const paddedCss = nextCss + " ".repeat(capacity - required);
  const patched = originalHtml.slice(0, contentStart) + paddedCss + originalHtml.slice(contentEnd);
  if (Buffer.byteLength(patched) !== Buffer.byteLength(originalHtml)) {
    throw new Error("Patched HTML byte length changed unexpectedly");
  }
  return patched;
}

export function buildPaddedAsset(source, slotSize) {
  const bytes = Buffer.from(source);
  if (bytes.length > slotSize) {
    throw new Error(`Artwork exceeds asset slot: ${bytes.length} > ${slotSize} bytes`);
  }

  const padded = Buffer.alloc(slotSize);
  bytes.copy(padded);
  return padded;
}

function inspectHtml(originalHtml) {
  const styleStart = originalHtml.indexOf("<style>") + "<style>".length;
  const styleEnd = originalHtml.indexOf("</style>", styleStart);
  if (styleStart < "<style>".length || styleEnd < 0) {
    throw new Error("Codex inline style block not found");
  }
  return { styleCapacity: Buffer.byteLength(originalHtml.slice(styleStart, styleEnd)) };
}

async function loadContext(asarPath) {
  const [archive, rawThemeCss, ...sources] = await Promise.all([
    readFile(asarPath),
    readFile(THEME_PATH, "utf8"),
    ...APP_ASSETS.map(({ sourceName }) =>
      readFile(join(PROJECT_ROOT, "assets", sourceName)),
    ),
  ]);
  const themeCss = minifyThemeCss(rawThemeCss);
  const entry = findEntry(archive, ENTRY_PATH);
  const originalHtml = readEntry(archive, ENTRY_PATH).toString("utf8");
  const { styleCapacity } = inspectHtml(originalHtml);
  const assets = APP_ASSETS.map((definition, index) => {
    const source = sources[index];
    const entryInfo = findEntry(archive, definition.entryPath);
    const padded = buildPaddedAsset(source, entryInfo.size);
    return {
      ...definition,
      entry: entryInfo,
      installed: digest(readEntry(archive, definition.entryPath)) === digest(padded),
      padded,
      source,
    };
  });

  return {
    archive,
    assets,
    entry,
    originalHtml,
    styleCapacity,
    themeCss,
    themeInstalled:
      buildPatchedHtml(originalHtml, themeCss) === originalHtml,
  };
}

function buildThemedArchive(context) {
  const patchedHtml = buildPatchedHtml(context.originalHtml, context.themeCss);
  const patchedArchive = replaceEntriesFixedSize(context.archive, [
    { entryPath: ENTRY_PATH, replacement: Buffer.from(patchedHtml) },
    ...context.assets.map(({ entryPath, padded }) => ({
      entryPath,
      replacement: padded,
    })),
  ]);

  if (patchedArchive.length !== context.archive.length) {
    throw new Error("Themed ASAR byte length changed unexpectedly");
  }
  const installedHtml = readEntry(patchedArchive, ENTRY_PATH).toString("utf8");
  if (!installedHtml.includes(THEME_MARKER)) {
    throw new Error("Theme marker missing from prepared ASAR");
  }
  for (const asset of context.assets) {
    if (digest(readEntry(patchedArchive, asset.entryPath)) !== digest(asset.padded)) {
      throw new Error(`Prepared artwork verification failed: ${asset.role}`);
    }
  }
  return { patchedArchive, patchedHtml };
}

async function swapPaths(firstPath, secondPath) {
  await execFileAsync("/usr/bin/python3", [
    "-c",
    SWAP_PATHS_SCRIPT,
    firstPath,
    secondPath,
  ]);
}

export async function compareAndSwapFileAtomically(
  targetPath,
  expectedBytes,
  replacementBytes,
  { afterSwap = async () => {} } = {},
) {
  const targetInfo = await stat(targetPath);
  const tempPath = join(dirname(targetPath), `.${Date.now()}-${process.pid}.miku.tmp`);
  let swapped = false;
  let keepTemp = false;
  const replacementSha256 = digest(replacementBytes);
  try {
    await writeFile(tempPath, replacementBytes, { mode: targetInfo.mode });
    const tempInfo = await stat(tempPath);
    if (tempInfo.size !== replacementBytes.length) {
      throw new Error("Temporary ASAR verification failed: file size mismatch");
    }
    await swapPaths(targetPath, tempPath);
    swapped = true;
    await afterSwap({ targetPath, tempPath });

    const displaced = await readFile(tempPath);
    if (digest(displaced) !== digest(expectedBytes)) {
      const current = await readFile(targetPath);
      if (digest(current) !== replacementSha256) {
        swapped = false;
        keepTemp = true;
        throw new Error(
          `Target changed again after atomic swap; displaced ASAR preserved at ${tempPath}`,
        );
      }
      await swapPaths(targetPath, tempPath);
      swapped = false;
      throw new Error("Refusing replacement because the target ASAR changed before commit");
    }
    const installed = await readFile(targetPath);
    if (digest(installed) !== replacementSha256) {
      swapped = false;
      throw new Error(
        "Target changed after atomic swap; preserving the newer target ASAR",
      );
    }
    swapped = false;
  } catch (error) {
    if (swapped) {
      try {
        const current = await readFile(targetPath);
        if (digest(current) === replacementSha256) {
          await swapPaths(targetPath, tempPath);
          swapped = false;
        } else {
          swapped = false;
          keepTemp = true;
          throw new Error(
            `rollback skipped because target changed concurrently; displaced ASAR preserved at ${tempPath}`,
          );
        }
      } catch (rollbackError) {
        keepTemp = true;
        throw new Error(`${error.message}; atomic swap rollback failed: ${rollbackError.message}`);
      }
    }
    throw error;
  } finally {
    if (!keepTemp) await rm(tempPath, { force: true }).catch(() => {});
  }
}

async function writeState(state) {
  await mkdir(STATE_DIR, { recursive: true });
  const tempPath = `${STATE_PATH}.${process.pid}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tempPath, STATE_PATH);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

export function validateExistingBackup({
  asarPath,
  backup,
  currentArchive,
  currentHtml,
  state,
}) {
  if (state.appAsar !== asarPath) {
    throw new Error("backup belongs to another ASAR");
  }
  if (digest(backup) !== state.originalArchiveSha256) {
    throw new Error("existing original backup SHA-256 mismatch");
  }
  if (backup.length !== currentArchive.length) {
    throw new Error("existing backup size does not match this Codex build");
  }

  const currentSha256 = digest(currentArchive);
  const hasTheme = currentHtml.includes("CODEX_MIKU_THEME");
  if (!hasTheme && currentSha256 !== state.originalArchiveSha256) {
    const error = new Error("current ASAR does not match the saved original build");
    error.code = "CURRENT_ASAR_MISMATCH";
    throw error;
  }
  if (hasTheme && state.themedArchiveSha256) {
    if (currentSha256 !== state.themedArchiveSha256) {
      const error = new Error("themed ASAR was modified after install");
      error.code = "THEMED_ASAR_MISMATCH";
      throw error;
    }
  } else if (hasTheme) {
    try {
      validateRestoreSource({ backup, currentArchive, state });
    } catch (cause) {
      const error = new Error(`themed ASAR cannot be matched to the saved install state: ${cause.message}`);
      error.code = "THEMED_ASAR_MISMATCH";
      throw error;
    }
  }
  return currentSha256;
}

function assertEqualOutsideEntries(currentArchive, backup, entryPaths) {
  const ranges = entryPaths
    .map((entryPath) => {
      const currentEntry = findEntry(currentArchive, entryPath);
      const backupEntry = findEntry(backup, entryPath);
      if (
        currentEntry.start !== backupEntry.start ||
        currentEntry.end !== backupEntry.end ||
        currentEntry.size !== backupEntry.size
      ) {
        throw new Error(`legacy entry layout changed: ${entryPath}`);
      }
      return currentEntry;
    })
    .sort((left, right) => left.start - right.start);

  let cursor = 0;
  for (const range of ranges) {
    if (!currentArchive.subarray(cursor, range.start).equals(backup.subarray(cursor, range.start))) {
      throw new Error("archive bytes outside legacy theme entries changed");
    }
    cursor = range.end;
  }
  if (!currentArchive.subarray(cursor).equals(backup.subarray(cursor))) {
    throw new Error("archive bytes outside legacy theme entries changed");
  }
}

export function validateRestoreSource({ backup, currentArchive, state }) {
  const currentSha256 = digest(currentArchive);
  if (currentSha256 === state.originalArchiveSha256) return "original";
  if (state.themedArchiveSha256) {
    if (currentSha256 !== state.themedArchiveSha256) {
      throw new Error("Codex was updated or modified after theme install");
    }
    return "current";
  }

  if (
    state.installedVersion !== 2 ||
    !state.themedEntrySha256 ||
    !state.artworkEntryPath ||
    !state.artworkSha256
  ) {
    throw new Error("legacy theme state is incomplete");
  }
  const currentHtml = readEntry(currentArchive, ENTRY_PATH);
  if (
    !currentHtml.toString("utf8").includes("CODEX_MIKU_THEME v2 MAXIMAL") ||
    digest(currentHtml) !== state.themedEntrySha256
  ) {
    throw new Error("legacy themed HTML does not match its saved hash");
  }
  if (digest(readEntry(currentArchive, state.artworkEntryPath)) !== state.artworkSha256) {
    throw new Error("legacy themed artwork does not match its saved hash");
  }
  if (
    state.originalEntrySha256 &&
    digest(readEntry(backup, ENTRY_PATH)) !== state.originalEntrySha256
  ) {
    throw new Error("legacy original HTML backup does not match its saved hash");
  }
  assertEqualOutsideEntries(currentArchive, backup, [
    ENTRY_PATH,
    state.artworkEntryPath,
  ]);
  return "legacy-v2";
}

export async function commitArchiveTransaction({
  nextState,
  originalArchive,
  patchedArchive,
  readTarget = readFile,
  replaceFile = compareAndSwapFileAtomically,
  saveState = writeState,
  targetPath,
}) {
  let replaced = false;
  try {
    const beforeInstall = await readTarget(targetPath);
    if (digest(beforeInstall) !== digest(originalArchive)) {
      throw new Error("Refusing install because the target ASAR changed during preparation");
    }
    await replaceFile(targetPath, originalArchive, patchedArchive);
    replaced = true;
    const installedArchive = await readTarget(targetPath);
    if (digest(installedArchive) !== digest(patchedArchive)) {
      throw new Error("Theme verification failed after atomic replacement");
    }
    await saveState(nextState);
  } catch (error) {
    if (replaced) {
      try {
        await replaceFile(targetPath, patchedArchive, originalArchive);
        const restoredArchive = await readTarget(targetPath);
        if (digest(restoredArchive) !== digest(originalArchive)) {
          throw new Error("rollback verification failed");
        }
      } catch (rollbackError) {
        throw new Error(`${error.message}; rollback failed: ${rollbackError.message}`);
      }
    }
    throw error;
  }
}

async function assertSupportedAppVersion(asarPath) {
  if (asarPath !== DEFAULT_ASAR) return null;
  const readPlistValue = async (key) => {
    const { stdout } = await execFileAsync("/usr/bin/plutil", [
      "-extract",
      key,
      "raw",
      INFO_PLIST,
    ]);
    return stdout.trim();
  };
  const [appVersion, appBuild] = await Promise.all([
    readPlistValue("CFBundleShortVersionString"),
    readPlistValue("CFBundleVersion"),
  ]);
  if (appVersion !== SUPPORTED_APP_VERSION || appBuild !== SUPPORTED_APP_BUILD) {
    throw new Error(
      `Unsupported Codex build ${appVersion} (${appBuild}); expected ${SUPPORTED_APP_VERSION} (${SUPPORTED_APP_BUILD})`,
    );
  }
  return { appBuild, appVersion };
}

async function assertSupportedAppArchive(asarPath, context) {
  if (asarPath !== DEFAULT_ASAR) return null;
  const archiveSha256 = digest(context.archive);
  let state = null;
  if (!SUPPORTED_BASE_ARCHIVE_SHA256.includes(archiveSha256)) {
    try {
      state = JSON.parse(await readFile(STATE_PATH, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const baseArchiveSha256 = validateSupportedArchiveFingerprint({
    archiveSha256,
    asarPath,
    currentHtml: context.originalHtml,
    state,
  });
  return { archiveSha256, baseArchiveSha256 };
}

export function findActiveCodexPids(processList) {
  return processList
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(.+)$/))
    .filter((match) => {
      if (!match) return false;
      const command = match[2];
      return (
        command.includes("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT") ||
        command.includes("/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)") ||
        command.includes("/Helpers/Codex (Service).app/Contents/MacOS/Codex (Service)")
      );
    })
    .map((match) => Number(match[1]));
}

async function assertCodexStopped(asarPath) {
  if (asarPath !== DEFAULT_ASAR) return;
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,command="]);
  const activePids = findActiveCodexPids(stdout);
  if (activePids.length > 0) {
    throw new Error(
      `Fully quit Codex with Command+Q before install or restore; active app PIDs: ${activePids.join(", ")}`,
    );
  }
}

async function check(asarPath) {
  await assertSupportedAppVersion(asarPath);
  const context = await loadContext(asarPath);
  const archiveIdentity = await assertSupportedAppArchive(asarPath, context);
  const hasMarker = context.originalHtml.includes(THEME_MARKER);
  const result = {
    ...(archiveIdentity ?? {}),
    appAsar: asarPath,
    archiveBytes: context.archive.length,
    artworks: context.assets.map(({ entry, installed, role, source }) => ({
      role,
      sourceBytes: source.length,
      slotBytes: entry.size,
      installed,
    })),
    entryBytes: context.entry.size,
    installed: context.themeInstalled && context.assets.every(({ installed }) => installed),
    installedVersion: hasMarker
      ? 5
      : context.originalHtml.includes("CODEX_MIKU_THEME v4 FULL CANVAS PET")
        ? 4
      : context.originalHtml.includes("CODEX_MIKU_THEME v3 PIXEL MATCH")
        ? 3
      : context.originalHtml.includes("CODEX_MIKU_THEME v2 MAXIMAL")
        ? 2
        : context.originalHtml.includes("CODEX_MIKU_THEME")
          ? 1
          : 0,
    styleCapacity: context.styleCapacity,
    themeBytes: Buffer.byteLength(context.themeCss.trim()) + 2,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function install(asarPath) {
  await assertCodexStopped(asarPath);
  const appIdentity = await assertSupportedAppVersion(asarPath);
  const context = await loadContext(asarPath);
  const archiveIdentity = await assertSupportedAppArchive(asarPath, context);
  const { patchedArchive, patchedHtml } = buildThemedArchive(context);
  const backupDir = join(STATE_DIR, "backups");
  await mkdir(backupDir, { recursive: true });

  let state;
  let backup;
  try {
    state = JSON.parse(await readFile(STATE_PATH, "utf8"));
    backup = await readFile(state.backupPath);
    validateExistingBackup({
      asarPath,
      backup,
      currentArchive: context.archive,
      currentHtml: context.originalHtml,
      state,
    });
  } catch (error) {
    if (
      context.originalHtml.includes("CODEX_MIKU_THEME") ||
      error.code === "CURRENT_ASAR_MISMATCH" ||
      error.code === "THEMED_ASAR_MISMATCH"
    ) {
      throw new Error(`Cannot upgrade without a valid original backup: ${error.message}`);
    }

    const archiveHash = digest(context.archive);
    const backupPath = join(backupDir, `${archiveHash}.asar`);
    await copyFile(asarPath, backupPath, fsConstants.COPYFILE_FICLONE);
    backup = await readFile(backupPath);
    if (digest(backup) !== archiveHash) {
      throw new Error("Backup verification failed: SHA-256 mismatch");
    }
    state = {
      appAsar: asarPath,
      archiveBytes: context.archive.length,
      backupPath,
      originalArchiveSha256: archiveHash,
      originalEntrySha256: digest(Buffer.from(context.originalHtml)),
    };
  }

  const themedArchiveSha256 = digest(patchedArchive);
  const baseState = { ...state };
  delete baseState.artworkEntryPath;
  delete baseState.artworkSha256;
  const nextState = {
    ...baseState,
    ...(appIdentity ?? {}),
    ...(archiveIdentity ?? {}),
    appAsar: asarPath,
    archiveBytes: patchedArchive.length,
    assets: context.assets.map(({ entry, entryPath, padded, role, source }) => ({
      entryPath,
      originalSha256: digest(readEntry(backup, entryPath)),
      paddedSha256: digest(padded),
      role,
      slotBytes: entry.size,
      sourceBytes: source.length,
    })),
    installedAt: new Date().toISOString(),
    installedVersion: 5,
    themedArchiveSha256,
    themedEntrySha256: digest(Buffer.from(patchedHtml)),
  };
  await assertCodexStopped(asarPath);
  await commitArchiveTransaction({
    nextState,
    originalArchive: context.archive,
    patchedArchive,
    targetPath: asarPath,
  });
  console.log(JSON.stringify(nextState, null, 2));
}

async function restore(asarPath) {
  await assertCodexStopped(asarPath);
  const state = JSON.parse(await readFile(STATE_PATH, "utf8"));
  if (state.appAsar !== asarPath) {
    throw new Error(`Backup belongs to a different ASAR: ${state.appAsar}`);
  }

  const [current, backup] = await Promise.all([readFile(asarPath), readFile(state.backupPath)]);
  if (asarPath === DEFAULT_ASAR) {
    validateSupportedArchiveFingerprint({
      archiveSha256: digest(current),
      asarPath,
      currentHtml: readEntry(current, ENTRY_PATH).toString("utf8"),
      state,
    });
  }
  if (current.length !== state.archiveBytes || backup.length !== state.archiveBytes) {
    throw new Error("Refusing restore after an app update changed the archive size");
  }
  if (digest(backup) !== state.originalArchiveSha256) {
    throw new Error("Backup verification failed: SHA-256 mismatch");
  }

  const restoreSource = validateRestoreSource({ backup, currentArchive: current, state });
  if (restoreSource === "original") {
    console.log("Codex Miku theme is not installed; nothing to restore.");
    return;
  }

  await assertCodexStopped(asarPath);
  await compareAndSwapFileAtomically(asarPath, current, backup);
  const restored = await readFile(asarPath);
  if (digest(restored) !== state.originalArchiveSha256) {
    throw new Error("Restore verification failed after atomic replacement");
  }
  console.log(`Restored original Codex theme from ${state.backupPath}`);
}

async function main() {
  const [command = "check", asarPath = DEFAULT_ASAR] = process.argv.slice(2);
  if (command === "check") return check(asarPath);
  if (command === "install") return install(asarPath);
  if (command === "restore") return restore(asarPath);
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Codex Miku theme: ${error.message}`);
    process.exitCode = 1;
  });
}
