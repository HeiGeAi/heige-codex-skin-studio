import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { readEntry, replaceEntriesFixedSize } from "../src/asar.mjs";
import { THEME_ASSETS } from "../src/theme-patch.mjs";

const APP_ASSETS = THEME_ASSETS;

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PATCHER = join(PROJECT_ROOT, "src", "theme-patch.mjs");
const ENTRY_PATH = "webview/index.html";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeArchiveEntries(entries) {
  const header = { files: {} };
  const payloads = [];
  let offset = 0;
  for (const [path, content] of entries) {
    const parts = path.split("/");
    const leaf = parts.pop();
    let cursor = header;
    for (const part of parts) {
      cursor.files[part] ??= { files: {} };
      cursor = cursor.files[part];
    }
    const payload = Buffer.from(content);
    cursor.files[leaf] = { size: payload.length, offset: String(offset) };
    payloads.push(payload);
    offset += payload.length;
  }
  const json = Buffer.from(JSON.stringify(header));
  const padding = (4 - (json.length % 4)) % 4;
  const headerSize = 8 + json.length + padding;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerSize, 4);
  prefix.writeUInt32LE(headerSize - 4, 8);
  prefix.writeUInt32LE(json.length, 12);
  return Buffer.concat([prefix, json, Buffer.alloc(padding), ...payloads]);
}

async function makeOfficialArchive(version = "old-build") {
  const sourceSizes = await Promise.all(
    APP_ASSETS.map(({ sourceName }) =>
      readFile(join(PROJECT_ROOT, "assets", sourceName)).then((source) => source.length),
    ),
  );
  const html = Buffer.from(
    `<!doctype html><html><head><style>${" ".repeat(8003)}</style></head><body><div id="root"></div></body></html>`,
  );
  return makeArchiveEntries([
    [ENTRY_PATH, html],
    ...APP_ASSETS.map(({ entryPath }, index) => [
      entryPath,
      Buffer.alloc(sourceSizes[index] + 64, index + 1),
    ]),
    ["webview/version.txt", Buffer.from(version)],
  ]);
}

function stateDir(home) {
  return join(home, "Library", "Application Support", "Codex Miku Theme");
}

async function runPatcher(command, asarPath, home) {
  return execFileAsync(process.execPath, [PATCHER, command, asarPath], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, HOME: home },
    maxBuffer: 1024 * 1024,
  });
}

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "codex-miku-integration-"));
  try {
    await run({ home: join(root, "home"), root, target: join(root, "app.asar") });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("CLI install and restore round-trip preserves the exact official ASAR", async () => {
  await withFixture(async ({ home, target }) => {
    const original = await makeOfficialArchive();
    await writeFile(target, original);

    await runPatcher("install", target, home);
    const themed = await readFile(target);
    assert.match(readEntry(themed, ENTRY_PATH).toString("utf8"), /CODEX_MIKU_THEME v5 488137 SIDEBAR/);

    await runPatcher("restore", target, home);
    assert.deepEqual(await readFile(target), original);
  });
});

test("CLI refuses a same-length official update instead of restoring an old build over it", async () => {
  await withFixture(async ({ home, root, target }) => {
    const oldBuild = await makeOfficialArchive("old-build");
    const newBuild = await makeOfficialArchive("new-build");
    assert.equal(oldBuild.length, newBuild.length);
    const backupPath = join(root, "old.asar");
    await writeFile(backupPath, oldBuild);
    await writeFile(target, newBuild);
    await mkdir(stateDir(home), { recursive: true });
    await writeFile(
      join(stateDir(home), "state.json"),
      `${JSON.stringify({
        appAsar: target,
        archiveBytes: oldBuild.length,
        backupPath,
        originalArchiveSha256: sha256(oldBuild),
        originalEntrySha256: sha256(readEntry(oldBuild, ENTRY_PATH)),
      })}\n`,
    );

    await assert.rejects(
      () => runPatcher("install", target, home),
      (error) => {
        assert.match(error.stderr, /current ASAR does not match the saved original build/);
        return true;
      },
    );
    assert.deepEqual(await readFile(target), newBuild);
  });
});

test("CLI rolls the ASAR back when state.json cannot be committed", async () => {
  await withFixture(async ({ home, target }) => {
    const original = await makeOfficialArchive();
    await writeFile(target, original);
    await mkdir(join(stateDir(home), "state.json"), { recursive: true });

    await assert.rejects(() => runPatcher("install", target, home));
    const afterFailure = await readFile(target);
    assert.deepEqual(afterFailure, original);
    assert.doesNotMatch(readEntry(afterFailure, ENTRY_PATH).toString("utf8"), /CODEX_MIKU_THEME/);
  });
});

test("CLI safely restores a v2 state after validating every untouched ASAR byte", async () => {
  await withFixture(async ({ home, root, target }) => {
    const backup = await makeOfficialArchive();
    const originalHtml = readEntry(backup, ENTRY_PATH).toString("utf8");
    const styleStart = originalHtml.indexOf("<style>") + "<style>".length;
    const styleEnd = originalHtml.indexOf("</style>", styleStart);
    const styleBytes = Buffer.byteLength(originalHtml.slice(styleStart, styleEnd));
    const marker = "\n/* CODEX_MIKU_THEME v2 MAXIMAL */\n";
    const legacyHtml = Buffer.from(
      originalHtml.slice(0, styleStart) +
        marker +
        " ".repeat(styleBytes - Buffer.byteLength(marker)) +
        originalHtml.slice(styleEnd),
    );
    const artworkPath = THEME_ASSETS[0].entryPath;
    const originalArtwork = readEntry(backup, artworkPath);
    const legacyArtwork = Buffer.alloc(originalArtwork.length, 0x7f);
    const legacy = replaceEntriesFixedSize(backup, [
      { entryPath: ENTRY_PATH, replacement: legacyHtml },
      { entryPath: artworkPath, replacement: legacyArtwork },
    ]);
    const backupPath = join(root, "official.asar");
    await writeFile(backupPath, backup);
    await writeFile(target, legacy);
    await mkdir(stateDir(home), { recursive: true });
    await writeFile(
      join(stateDir(home), "state.json"),
      `${JSON.stringify({
        appAsar: target,
        archiveBytes: backup.length,
        artworkEntryPath: artworkPath,
        artworkSha256: sha256(legacyArtwork),
        backupPath,
        installedVersion: 2,
        originalArchiveSha256: sha256(backup),
        originalEntrySha256: sha256(readEntry(backup, ENTRY_PATH)),
        themedEntrySha256: sha256(legacyHtml),
      })}\n`,
    );

    await runPatcher("restore", target, home);
    assert.deepEqual(await readFile(target), backup);
  });
});
