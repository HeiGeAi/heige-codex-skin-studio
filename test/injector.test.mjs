import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applySkin, removeSkin, skinStatus } from "../src/injector.mjs";

class FakeSession {
  static expressions = [];
  constructor() { this.closed = false; }
  async open() { return this; }
  async evaluate(expression) {
    FakeSession.expressions.push(expression);
    if (expression.includes("installed:")) return { installed: true, themeId: "demo" };
    return true;
  }
  close() { this.closed = true; }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "heige-injector-"));
  await writeFile(join(root, "hero.png"), Buffer.from([137, 80, 78, 71]));
  return {
    loaded: {
      root,
      heroPath: join(root, "hero.png"),
      manifest: {
        id: "demo",
        name: "Demo",
        colors: { accent: "#19C9E5", secondary: "#ED6EC1", surface: "#F5F6FC", text: "#122C60" },
        copy: null,
      },
    },
    deps: {
      waitForRendererTargets: async () => [
        { id: "overlay", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/overlay" },
        { id: "one", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/one" },
      ],
      fetchRendererTargets: async () => [
        { id: "overlay", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/overlay" },
        { id: "one", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/one" },
      ],
      Session: FakeSession,
    },
  };
}

test("applies the skin to the main window only, never the pet overlay", async () => {
  FakeSession.expressions = [];
  const { loaded, deps } = await fixture();
  const result = await applySkin({ loadedTheme: loaded, port: 9341, deps });
  assert.equal(result.applied, 1);
  assert.deepEqual(result.targets, ["one"]);
  assert.match(FakeSession.expressions[0], /heige-codex-skin-style/);
  assert.match(FakeSession.expressions[0], /data:image\/png;base64/);
});

test("keeps waiting when only the pet overlay renderer exists", async () => {
  const { loaded, deps } = await fixture();
  deps.waitForRendererTargets = async () => [
    { id: "overlay", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/overlay" },
  ];
  await assert.rejects(
    applySkin({ loadedTheme: loaded, port: 9341, deps: { ...deps, waitTimeoutMs: 30, pollMs: 5 } }),
    /主窗口/,
  );
});

test("injects the in-app switcher menu with every loaded theme", async () => {
  FakeSession.expressions = [];
  const { loaded, deps } = await fixture();
  const second = structuredClone(loaded);
  second.manifest.id = "night-city";
  second.manifest.name = "Night City";
  const result = await applySkin({ loadedTheme: loaded, themes: [loaded, second], port: 9341, deps });
  assert.deepEqual(result.menuThemes, ["demo", "night-city"]);
  assert.match(FakeSession.expressions[0], /heige-codex-skin-menu/);
  assert.match(FakeSession.expressions[0], /"activeId":"demo"/);
  assert.match(FakeSession.expressions[0], /"night-city"/);
});

test("removes and checks the live style without persistent machinery", async () => {
  FakeSession.expressions = [];
  const { deps } = await fixture();
  assert.equal((await removeSkin({ port: 9341, deps })).removed, 2, "pause 要连宠物悬浮层一起清理");
  assert.deepEqual(await skinStatus({ port: 9341, deps }), [{ installed: true, themeId: "demo" }]);
  assert.match(FakeSession.expressions[0], /remove\(\)/);
  assert.match(FakeSession.expressions[0], /heige-codex-skin-menu/);
});
