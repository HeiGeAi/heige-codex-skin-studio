import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import test from "node:test";

const skillRoot = new URL("../skill/codex-miku-theme/", import.meta.url);

async function text(path) {
  return readFile(new URL(path, skillRoot), "utf8");
}

test("ships a standard Codex skill with the complete v5 theme payload", async () => {
  const required = [
    "SKILL.md",
    "README.md",
    "scripts/check.command",
    "scripts/install-after-quit.command",
    "scripts/install-now.command",
    "scripts/restore-after-quit.command",
    "payload/package.json",
    "payload/src/asar.mjs",
    "payload/src/theme-patch.mjs",
    "payload/src/theme.css",
    "payload/assets/miku-full-canvas.png",
    "payload/assets/miku-character.png",
    "payload/assets/miku-sidebar-wash.png",
    "payload/assets/miku-polaroid.png",
    "payload/custom-pet/miku-future/pet.json",
    "payload/custom-pet/miku-future/spritesheet.webp",
    "scripts/install-pet.command",
  ];

  await Promise.all(required.map((path) => access(new URL(path, skillRoot), fsConstants.R_OK)));
});

test("describes precise triggers and keeps the reusable skill free of author paths", async () => {
  const skill = await text("SKILL.md");
  assert.match(skill, /^---\nname: codex-miku-theme\ndescription: Use when /);
  assert.match(skill, /初音未来|Miku/);
  assert.match(skill, /install-after-quit\.command/);
  assert.match(skill, /restore-after-quit\.command/);
  assert.doesNotMatch(skill, /\/Users\/blakexu/);
});

test("queued installer waits for Codex to quit and never bypasses compatibility checks", async () => {
  const installer = await text("scripts/install-after-quit.command");
  const runner = await text("scripts/lib/run-after-quit.zsh");
  assert.match(runner, /ChatGPT\.app\/Contents/);
  assert.match(installer, /node "\$PATCHER" check/);
  assert.match(runner, /"\$PATCHER" install/);
  assert.match(runner, /open \/Applications\/ChatGPT\.app/);
  assert.doesNotMatch(`${installer}\n${runner}`, /killall|pkill|codesign/);
});

test("pet installer selects the independent Miku Future avatar", async () => {
  const installer = await text("scripts/install-pet.command");
  assert.match(installer, /custom:miku-future/);
  assert.match(installer, /\.codex\/pets\/miku-future/);
});

test("bundled theme stays self-contained and includes the full-canvas marker", async () => {
  const css = await text("payload/src/theme.css");
  const patcher = await text("payload/src/theme-patch.mjs");
  assert.match(css, /CODEX_MIKU_THEME v5 488137 SIDEBAR/);
  assert.match(patcher, /CODEX_MIKU_THEME v5 488137 SIDEBAR/);
  assert.doesNotMatch(css, /https?:\/\//i);
  assert.doesNotMatch(patcher, /\/Users\/blakexu/);
});
