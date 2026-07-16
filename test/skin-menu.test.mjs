import assert from "node:assert/strict";
import test from "node:test";

import { buildSkinMenuScript, CSS_SENTINELS } from "../src/skin-menu.mjs";

const base = {
  styleId: "heige-codex-skin-style",
  menuId: "heige-codex-skin-menu",
};

test("embeds every theme and the active id as JSON data", () => {
  const script = buildSkinMenuScript({
    ...base,
    activeId: "miku-488137",
    entries: [
      { id: "miku-488137", name: "Miku 488137", accent: "#19c9e5", css: "#root{}" },
      { id: "night-city", name: "Night City", accent: "#7a5cff", css: "#root{background:black}" },
    ],
  });

  assert.match(script, /"miku-488137"/);
  assert.match(script, /"night-city"/);
  assert.match(script, /"activeId":"miku-488137"/);
  assert.match(script, /heige-codex-skin-menu/);
  assert.match(script, /\\u539f\\u751f\\u754c\\u9762/);
});

test("keeps hostile names as inert JSON instead of executable code", () => {
  const script = buildSkinMenuScript({
    ...base,
    activeId: "evil",
    entries: [{ id: "evil", name: '";alert(1);//', accent: "not-a-color", css: "#root{}" }],
  });

  assert.ok(script.includes(String.raw`\";alert(1);//`), "name must stay inside a JSON string");
  assert.match(script, /"accent":"#24c9d7"/);
});

test("ships the custom upload flow with the sentinel css template", () => {
  const cssTemplate = `#root { background: url("${CSS_SENTINELS.hero}"); color: ${CSS_SENTINELS.text}; }`;
  const script = buildSkinMenuScript({
    ...base,
    activeId: "a",
    cssTemplate,
    entries: [{ id: "a", name: "A", accent: "#123456", css: "#root{}" }],
  });

  assert.match(script, /heigeCodexCustomTheme/, "custom theme must persist via localStorage");
  assert.match(script, /custom-upload/);
  assert.match(script, /HEIGEHEROSENTINEL/, "css template must ride along for client-side builds");
  assert.match(script, /extractPalette/, "palette extraction must ship");
  assert.match(script, /__heigeCodexSkin/, "scriptable hook must be exposed");
  assert.match(script, /deleteCustom/, "custom theme must be deletable");
  assert.match(script, /removeItem/, "delete must clear persisted storage");
});

test("rejects empty menus and unknown active themes", () => {
  assert.throws(() => buildSkinMenuScript({ ...base, activeId: null, entries: [] }));
  assert.throws(() =>
    buildSkinMenuScript({
      ...base,
      activeId: "missing",
      entries: [{ id: "real", name: "Real", accent: "#123456", css: "#root{}" }],
    }),
  );
});
