import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pairs = [
  ["src/asar.mjs", "skill/codex-miku-theme/payload/src/asar.mjs"],
  ["src/theme-patch.mjs", "skill/codex-miku-theme/payload/src/theme-patch.mjs"],
  ["src/theme.css", "skill/codex-miku-theme/payload/src/theme.css"],
  ["assets/miku-full-canvas.png", "skill/codex-miku-theme/payload/assets/miku-full-canvas.png"],
  ["assets/miku-character.png", "skill/codex-miku-theme/payload/assets/miku-character.png"],
  ["assets/miku-sidebar-wash.png", "skill/codex-miku-theme/payload/assets/miku-sidebar-wash.png"],
  ["assets/miku-polaroid.png", "skill/codex-miku-theme/payload/assets/miku-polaroid.png"],
  ["custom-pet/miku-future/pet.json", "skill/codex-miku-theme/payload/custom-pet/miku-future/pet.json"],
  ["custom-pet/miku-future/spritesheet.webp", "skill/codex-miku-theme/payload/custom-pet/miku-future/spritesheet.webp"],
];

test("keeps every runtime payload byte-identical to its repository source", async () => {
  for (const [sourcePath, payloadPath] of pairs) {
    const [source, payload] = await Promise.all([
      readFile(new URL(`../${sourcePath}`, import.meta.url)),
      readFile(new URL(`../${payloadPath}`, import.meta.url)),
    ]);
    assert.deepEqual(payload, source, `${payloadPath} drifted from ${sourcePath}`);
  }
});
