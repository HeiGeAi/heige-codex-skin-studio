import assert from "node:assert/strict";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadTheme } from "../src/theme-schema.mjs";

const themesRoot = fileURLToPath(new URL("../themes", import.meta.url));
const requiredPresets = new Map([
  ["dragonball-nimbus", {
    name: "龙珠 · 筋斗云",
    previewFocus: { x: 72, y: 43 },
    appearance: "light",
    colors: {
      surface: "#F3F7FF",
      text: "#14213D",
    },
  }],
  ["dragonball-super-saiyan", {
    name: "龙珠 · 超级赛亚人",
    previewFocus: { x: 67, y: 43 },
    appearance: "light",
    colors: {
      surface: "#FFF8E8",
      text: "#282033",
    },
  }],
]);

test("every bundled preset validates and ships a real hero", async () => {
  const ids = (await readdir(themesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(ids.includes("miku-488137"), "the Miku showcase preset must stay bundled");
  assert.ok(ids.length >= 9, `expected the full preset lineup, found ${ids.length}`);

  for (const [id, expected] of requiredPresets) {
    assert.ok(ids.includes(id), `${id}: preset must stay bundled`);
    const theme = await loadTheme(join(themesRoot, id));
    assert.equal(theme.manifest.name, expected.name);
    assert.deepEqual(theme.manifest.previewFocus, expected.previewFocus);
    assert.equal(theme.manifest.appearance, expected.appearance);
    assert.equal(theme.manifest.colors.surface, expected.colors.surface);
    assert.equal(theme.manifest.colors.text, expected.colors.text);
    assert.equal(theme.assetMetadata.hero.width, 1600);
    assert.equal(theme.assetMetadata.hero.height, 900);
  }

  for (const id of ids) {
    const theme = await loadTheme(join(themesRoot, id));
    assert.equal(theme.manifest.id, id, `${id}: manifest id must match its directory`);
    const hero = await stat(theme.heroPath);
    assert.ok(hero.size > 10_000, `${id}: hero looks empty`);
    assert.ok(hero.size < 1_000_000, `${id}: hero too heavy for the switcher payload`);
  }
});
