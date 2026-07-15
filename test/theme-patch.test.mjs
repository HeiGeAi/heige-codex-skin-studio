import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  THEME_ASSETS,
  buildPaddedAsset,
  buildPatchedHtml,
  commitArchiveTransaction,
  compareAndSwapFileAtomically,
  findActiveCodexPids,
  minifyThemeCss,
  validateExistingBackup,
  validateRestoreSource,
} from "../src/theme-patch.mjs";
import { createHash } from "node:crypto";
import { replaceEntriesFixedSize } from "../src/asar.mjs";

const original = `<!doctype html><head><style>
  .startup-loader { display: flex; }
  ${"x".repeat(200)}
</style></head><body></body>`;

test("replaces the first inline style and preserves byte length", () => {
  const patched = buildPatchedHtml(original, "/* CODEX_MIKU_THEME */\n:root{--miku-cyan:#18c7d4}");
  assert.equal(Buffer.byteLength(patched), Buffer.byteLength(original));
  assert.match(patched, /CODEX_MIKU_THEME/);
  assert.doesNotMatch(patched, /startup-loader \{ display/);
});

test("is idempotent when the theme is already installed", () => {
  const theme = "/* CODEX_MIKU_THEME v5 488137 SIDEBAR */\n:root{--miku-cyan:#19c9e5}";
  const once = buildPatchedHtml(original, theme);
  const twice = buildPatchedHtml(once, theme);
  assert.equal(twice, once);
});

test("upgrades an older installed theme in place", () => {
  const oldTheme = "/* CODEX_MIKU_THEME v1 */\n:root{--miku-cyan:#18c7d4}";
  const newTheme = "/* CODEX_MIKU_THEME v5 488137 SIDEBAR */\n:root{--miku-pink:#ed6ec1}";
  const oldInstalled = buildPatchedHtml(original, oldTheme);
  const upgraded = buildPatchedHtml(oldInstalled, newTheme);

  assert.equal(Buffer.byteLength(upgraded), Buffer.byteLength(original));
  assert.match(upgraded, /CODEX_MIKU_THEME v5 488137 SIDEBAR/);
  assert.doesNotMatch(upgraded, /CODEX_MIKU_THEME v1/);
});

test("rejects a theme larger than the inline style capacity", () => {
  assert.throws(
    () => buildPatchedHtml(original, "y".repeat(500)),
    /exceeds inline style capacity/,
  );
});

test("rejects HTML without the expected inline style", () => {
  assert.throws(
    () => buildPatchedHtml("<html></html>", "/* CODEX_MIKU_THEME */"),
    /inline style block not found/,
  );
});

test("pads the supplied artwork to the existing ASAR slot size", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const padded = buildPaddedAsset(png, 12);

  assert.equal(padded.length, 12);
  assert.deepEqual(padded.subarray(0, png.length), png);
});

test("rejects artwork larger than the existing ASAR slot", () => {
  assert.throws(() => buildPaddedAsset(Buffer.alloc(13), 12), /exceeds asset slot/);
});

test("uses only PNG slots outside core chat and pet spritesheets", () => {
  assert.equal(THEME_ASSETS.length, 4);
  for (const asset of THEME_ASSETS) {
    assert.match(asset.entryPath, /^webview\/assets\/.+\.png$/);
    assert.doesNotMatch(asset.entryPath, /spritesheet/i);
  }
});

test("detects every process running from the Codex app bundle", () => {
  const processList = `
    101 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
    102 /Applications/ChatGPT.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper
    103 /usr/bin/node test/theme-patch.test.mjs
  `;
  assert.deepEqual(findActiveCodexPids(processList), [101, 102]);
});

test("check validates the supported Codex build before an install is queued", async () => {
  const source = await readFile(new URL("../src/theme-patch.mjs", import.meta.url), "utf8");
  const checkBody = source.match(/async function check\(asarPath\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(checkBody, /await assertSupportedAppVersion\(asarPath\)/);
});

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

test("the real v5 CSS fits the Codex inline slot and keeps static startup layout", async () => {
  const source = await readFile(new URL("../src/theme.css", import.meta.url), "utf8");
  const compiled = minifyThemeCss(source);

  assert.ok(Buffer.byteLength(compiled) + 2 <= 8003);
  assert.match(compiled, /@layer theme,base,components,utilities/);
  assert.match(compiled, /html,body\{width:100%;height:100%;margin:0/);
  assert.match(compiled, /#root\{position:relative;width:100%;height:100%/);
  assert.match(compiled, /\.startup-loader\{display:flex;width:100%;height:100%;align-items:center;justify-content:center/);
  assert.match(compiled, /\.startup-loader__logo\{position:relative;width:56px;height:56px/);
});

test("rejects a same-length current ASAR that does not belong to the saved backup", () => {
  const backup = Buffer.from("original-build");
  const current = Buffer.from("differentbuild");
  const state = {
    appAsar: "/Applications/ChatGPT.app/Contents/Resources/app.asar",
    originalArchiveSha256: sha256(backup),
  };

  assert.throws(
    () =>
      validateExistingBackup({
        asarPath: state.appAsar,
        backup,
        currentArchive: current,
        currentHtml: "<html>official update</html>",
        state,
      }),
    /current ASAR does not match the saved original build/,
  );
});

test("rejects a themed ASAR modified after its recorded install", () => {
  const backup = Buffer.from("original-build");
  const current = Buffer.from("modified-theme");
  const state = {
    appAsar: "/Applications/ChatGPT.app/Contents/Resources/app.asar",
    originalArchiveSha256: sha256(backup),
    themedArchiveSha256: sha256(Buffer.from("expected-theme")),
  };

  assert.throws(
    () =>
      validateExistingBackup({
        asarPath: state.appAsar,
        backup,
        currentArchive: current,
        currentHtml: "/* CODEX_MIKU_THEME v3 PIXEL MATCH */",
        state,
      }),
    /themed ASAR was modified after install/,
  );
});

test("rolls the ASAR back when atomic state persistence fails", async () => {
  const originalArchive = Buffer.from("original");
  const patchedArchive = Buffer.from("theme-v3");
  let current = originalArchive;
  const writes = [];

  await assert.rejects(
    () =>
      commitArchiveTransaction({
        nextState: { installedVersion: 3 },
        originalArchive,
        patchedArchive,
        readTarget: async () => current,
        replaceFile: async (_path, expected, replacement) => {
          assert.deepEqual(current, expected);
          current = Buffer.from(replacement);
          writes.push(current.toString());
        },
        saveState: async () => {
          throw new Error("state disk full");
        },
        targetPath: "/tmp/app.asar",
      }),
    /state disk full/,
  );

  assert.equal(current.toString(), "original");
  assert.deepEqual(writes, ["theme-v3", "original"]);
});

test("refuses installation when the target changes after preparation", async () => {
  const writes = [];
  await assert.rejects(
    () =>
      commitArchiveTransaction({
        nextState: { installedVersion: 3 },
        originalArchive: Buffer.from("original"),
        patchedArchive: Buffer.from("theme-v3"),
        readTarget: async () => Buffer.from("changed!"),
        replaceFile: async (_path, _expected, replacement) =>
          writes.push(Buffer.from(replacement)),
        saveState: async () => {},
        targetPath: "/tmp/app.asar",
      }),
    /target ASAR changed during preparation/,
  );
  assert.deepEqual(writes, []);
});

test("atomic CAS preserves a target that changed before commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-miku-cas-"));
  const target = join(root, "app.asar");
  try {
    await writeFile(target, Buffer.from("new-build"));
    await assert.rejects(
      () =>
        compareAndSwapFileAtomically(
          target,
          Buffer.from("old-build"),
          Buffer.from("theme-v3"),
        ),
      /target ASAR changed before commit/,
    );
    assert.equal((await readFile(target)).toString(), "new-build");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("atomic CAS preserves a newer target written after the swap", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-miku-cas-after-"));
  const target = join(root, "app.asar");
  try {
    await writeFile(target, Buffer.from("old-build"));
    await assert.rejects(
      () =>
        compareAndSwapFileAtomically(
          target,
          Buffer.from("old-build"),
          Buffer.from("theme-v3"),
          {
            afterSwap: async () => writeFile(target, Buffer.from("newer-app")),
          },
        ),
      /preserving the newer target ASAR/,
    );
    assert.equal((await readFile(target)).toString(), "newer-app");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("accepts a verified v2 archive as a safe legacy restore source", () => {
  const originalHtml = Buffer.from(`<style>${" ".repeat(180)}</style>`);
  const legacyMarker = "/* CODEX_MIKU_THEME v2 MAXIMAL */";
  const legacyHtml = Buffer.from(
    `<style>${legacyMarker}${" ".repeat(180 - legacyMarker.length)}</style>`,
  );
  const artworkPath = THEME_ASSETS[0].entryPath;
  const backup = makeArchiveEntries([
    ["webview/index.html", originalHtml],
    [artworkPath, Buffer.from("original-art")],
    ["webview/version.txt", Buffer.from("old-build")],
  ]);
  const legacyArtwork = Buffer.from("miku-theme!!");
  const currentArchive = replaceEntriesFixedSize(backup, [
    { entryPath: "webview/index.html", replacement: legacyHtml },
    { entryPath: artworkPath, replacement: legacyArtwork },
  ]);
  const state = {
    appAsar: "/tmp/app.asar",
    archiveBytes: backup.length,
    artworkEntryPath: artworkPath,
    artworkSha256: sha256(legacyArtwork),
    installedVersion: 2,
    originalArchiveSha256: sha256(backup),
    originalEntrySha256: sha256(originalHtml),
    themedEntrySha256: sha256(legacyHtml),
  };

  assert.equal(
    validateRestoreSource({ backup, currentArchive, state }),
    "legacy-v2",
  );

  const tampered = replaceEntriesFixedSize(currentArchive, [
    { entryPath: "webview/version.txt", replacement: Buffer.from("new-build") },
  ]);
  assert.throws(
    () => validateRestoreSource({ backup, currentArchive: tampered, state }),
    /outside legacy theme entries changed/,
  );
});
