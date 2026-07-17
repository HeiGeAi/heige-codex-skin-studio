import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applySkin, removeSkin, skinStatus } from "../src/injector.mjs";

function png(width, height, bytes = 24) {
  const result = Buffer.alloc(Math.max(bytes, 24));
  Buffer.from("89504e470d0a1a0a", "hex").copy(result, 0);
  result.writeUInt32BE(13, 8);
  result.write("IHDR", 12, "ascii");
  result.writeUInt32BE(width, 16);
  result.writeUInt32BE(height, 20);
  return result;
}

class FakeSession {
  static expressions = [];
  constructor() { this.closed = false; }
  async open() { return this; }
  async evaluate(expression) {
    FakeSession.expressions.push(expression);
    if (expression.includes("installed:")) {
      return {
        installed: true,
        generation: "a".repeat(32),
        mode: "active",
        themeId: "demo",
        menu: true,
        persistenceEnabled: true,
        revision: 7,
      };
    }
    return true;
  }
  close() { this.closed = true; }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "heige-injector-"));
  const hero = png(640, 360);
  const frame = png(64, 96, 32);
  await writeFile(join(root, "hero.png"), hero);
  await writeFile(join(root, "frame.png"), frame);
  return {
    frameDataUrl: `data:image/png;base64,${frame.toString("base64")}`,
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
        { id: "overlay", type: "page", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/overlay" },
        { id: "one", type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/one" },
      ],
      fetchRendererTargets: async () => [
        { id: "overlay", type: "page", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/overlay" },
        { id: "one", type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/one" },
      ],
      Session: FakeSession,
      signatureCardFramePath: join(root, "frame.png"),
    },
  };
}

test("applies the skin to the main window only, never the pet overlay", async () => {
  FakeSession.expressions = [];
  const { loaded, deps } = await fixture();
  const result = await applySkin({ loadedTheme: loaded, port: 9341, deps });
  assert.equal(result.applied, 1);
  assert.deepEqual(result.targets, ["one"]);
  assert.deepEqual(result.results.skipped.map(({ id, kind }) => ({ id, kind })), [
    { id: "overlay", kind: "overlay" },
  ]);
  assert.match(FakeSession.expressions[0], /heige-codex-skin-style/);
  assert.match(FakeSession.expressions[0], /data:image\/png;base64/);
});

test("keeps waiting when only the pet overlay renderer exists", async () => {
  const { loaded, deps } = await fixture();
  deps.waitForRendererTargets = async () => [
    { id: "overlay", type: "page", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/overlay" },
  ];
  await assert.rejects(
    applySkin({ loadedTheme: loaded, port: 9341, deps: { ...deps, waitTimeoutMs: 30, pollMs: 5 } }),
    /主窗口/,
  );
});

test("injects the in-app switcher menu with every loaded theme", async () => {
  FakeSession.expressions = [];
  const { loaded, deps, frameDataUrl } = await fixture();
  const second = structuredClone(loaded);
  second.manifest.id = "night-city";
  second.manifest.name = "Night City";
  const result = await applySkin({ loadedTheme: loaded, themes: [loaded, second], port: 9341, deps });
  assert.deepEqual(result.menuThemes, ["demo", "night-city"]);
  assert.match(FakeSession.expressions[0], /heige-codex-skin-menu/);
  assert.match(FakeSession.expressions[0], /"activeId":"demo"/);
  assert.match(FakeSession.expressions[0], /"night-city"/);
  assert.equal(
    FakeSession.expressions[0].split(frameDataUrl).length - 1,
    1,
    "共享相框在 renderer 表达式中只能出现一次",
  );
  assert.match(FakeSession.expressions[0], /By@HeiGe/);
});

test("passes the read-only persistence control descriptor into every main menu", async () => {
  FakeSession.expressions = [];
  const { loaded, deps } = await fixture();
  const control = {
    available: true,
    persistenceEnabled: false,
    revision: 3,
    endpoint: "http://127.0.0.1:43123/v1/persistence",
    token: Buffer.alloc(32, 7).toString("base64url"),
    launcherName: "HeiGe 皮肤启动器",
  };
  await applySkin({ loadedTheme: loaded, port: 9341, control, deps });
  assert.match(FakeSession.expressions[0], /"persistenceEnabled":false/);
  assert.match(FakeSession.expressions[0], /127\.0\.0\.1:43123\/v1\/persistence/);
  assert.match(FakeSession.expressions[0], /persistence-switch/);
});

test("removes and checks the live style without persistent machinery", async () => {
  FakeSession.expressions = [];
  const { deps } = await fixture();
  assert.equal((await removeSkin({ port: 9341, deps })).removed, 2, "pause 要连宠物悬浮层一起清理");
  const status = await skinStatus({ port: 9341, deps });
  assert.deepEqual(status.statuses, [{
    installed: true,
    generation: "a".repeat(32),
    mode: "active",
    themeId: "demo",
    menu: true,
    persistenceEnabled: true,
    revision: 7,
  }]);
  assert.equal(status.results.succeeded[0].kind, "main");
  assert.match(FakeSession.expressions.at(-1), /const includeControlRequest = false/);
  assert.match(FakeSession.expressions[0], /remove\(\)/);
  assert.match(FakeSession.expressions[0], /heige-codex-skin-menu/);
  assert.match(FakeSession.expressions[0], /__heigeCodexSkinRuntime\?\.dispose/);
});

test("status exposes renderer control requests only to an explicit internal caller", async () => {
  FakeSession.expressions = [];
  const { deps } = await fixture();

  await skinStatus({ port: 9341, includeControlRequest: true, deps });

  assert.match(FakeSession.expressions[0], /const includeControlRequest = true/);
  await assert.rejects(
    skinStatus({ port: 9341, includeControlRequest: "true", deps }),
    /includeControlRequest 必须是布尔值/,
  );
});

test("one dead target does not abort injection into the survivors", async () => {
  const { loaded, deps } = await fixture();
  class FlakySession {
    constructor(url) { this.url = url; }
    async open() { if (this.url.endsWith("/dead")) throw new Error("connection refused"); return this; }
    async evaluate() { return true; }
    close() {}
  }
  deps.waitForRendererTargets = async () => [
    { id: "dead", type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/dead" },
    { id: "alive", type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/alive" },
  ];
  deps.Session = FlakySession;
  const result = await applySkin({ loadedTheme: loaded, port: 9341, deps });
  assert.equal(result.applied, 1, "存活窗口仍被注入");
  assert.deepEqual(result.targets, ["alive"]);
  assert.deepEqual(result.failed, ["dead"]);
  assert.equal(result.results.failed[0].error, "目标连接或执行失败");
  assert.equal("webSocketDebuggerUrl" in result.results.failed[0], false);
});

test("apply throws only when every target fails", async () => {
  const { loaded, deps } = await fixture();
  class DeadSession {
    async open() { throw new Error("all dead"); }
    async evaluate() { return true; }
    close() {}
  }
  deps.Session = DeadSession;
  await assert.rejects(applySkin({ loadedTheme: loaded, port: 9341, deps }), /注入失败/);
});

test("overlay success cannot hide total main-window failure", async () => {
  const { deps } = await fixture();
  class MainDeadSession {
    constructor(url) { this.url = url; }
    async open() {
      if (this.url.endsWith("/main-dead")) throw new Error("connection refused");
      return this;
    }
    async evaluate() { return true; }
    close() {}
  }
  deps.Session = MainDeadSession;
  deps.fetchRendererTargets = async () => [
    { id: "main-dead", type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/main-dead" },
    { id: "overlay-alive", type: "page", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/overlay-alive" },
  ];
  await assert.rejects(removeSkin({ port: 9341, deps }), (error) => {
    assert.equal(error.code, "ALL_MAIN_TARGETS_FAILED");
    assert.equal(error.results.failed[0].id, "main-dead");
    assert.equal(error.results.succeeded[0].id, "overlay-alive");
    assert.equal("webSocketDebuggerUrl" in error.results.failed[0], false);
    return true;
  });
});

test("status and remove fail when no exact main renderer exists", async () => {
  const { deps } = await fixture();
  const constructed = [];
  deps.Session = class RecordingSession {
    constructor(url) { constructed.push(url); }
    async open() { return this; }
    async evaluate() { return true; }
    close() {}
  };
  deps.fetchRendererTargets = async () => [
    { id: "overlay", type: "page", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/overlay" },
    { id: "local-page", type: "page", url: "http://127.0.0.1:5175/", webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/local-page" },
  ];
  await assert.rejects(skinStatus({ port: 9341, deps }), (error) => error.code === "NO_MAIN_RENDERER");
  await assert.rejects(removeSkin({ port: 9341, deps }), (error) => {
    assert.equal(error.code, "NO_MAIN_RENDERER");
    assert.deepEqual(error.results.skipped.map(({ id }) => id), ["local-page"]);
    return true;
  });
  assert.equal(constructed.some((url) => url.endsWith("/local-page")), false);
});

test("status reports safe per-target evidence when every exact main fails", async () => {
  const { deps } = await fixture();
  deps.fetchRendererTargets = async () => [
    { id: "dead", type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/dead" },
  ];
  deps.Session = class DeadSession {
    async open() { throw new Error("ws://127.0.0.1:9341/private-path secret stack"); }
    close() {}
  };
  await assert.rejects(skinStatus({ port: 9341, deps }), (error) => {
    assert.equal(error.code, "ALL_MAIN_TARGETS_FAILED");
    assert.deepEqual(error.results.failed, [{
      id: "dead",
      url: "app://-/index.html",
      kind: "main",
      error: "目标连接或执行失败",
    }]);
    assert.doesNotMatch(JSON.stringify(error.results), /private-path|secret|stack|webSocketDebuggerUrl/);
    return true;
  });
});

test("rejects compressed dimension bombs before CDP evaluation", async () => {
  FakeSession.expressions = [];
  const { loaded, deps } = await fixture();
  await writeFile(loaded.heroPath, png(8000, 8000, 1024));
  await assert.rejects(applySkin({ loadedTheme: loaded, port: 9341, deps }), /像素|pixel/i);
  assert.equal(FakeSession.expressions.length, 0);
});

test("uses the validated load snapshot if an asset path changes before injection", async () => {
  FakeSession.expressions = [];
  const { loaded, deps } = await fixture();
  loaded.assetBuffers = { hero: png(640, 360), logo: null, polaroid: null };
  await writeFile(loaded.heroPath, png(8000, 8000, 1024));
  const result = await applySkin({ loadedTheme: loaded, port: 9341, deps });
  assert.equal(result.applied, 1);
  assert.equal(FakeSession.expressions.length, 1);
});

test("rejects an oversized in-memory snapshot before encoding or CDP evaluation", async () => {
  FakeSession.expressions = [];
  const { loaded, deps } = await fixture();
  loaded.assetBuffers = {
    hero: new Uint8Array((8 * 1024 * 1024) + 1),
    logo: null,
    polaroid: null,
  };
  await assert.rejects(applySkin({ loadedTheme: loaded, port: 9341, deps }), /8 MiB|8388608/);
  assert.equal(FakeSession.expressions.length, 0);
});

test("apply target allowlist evaluates only selected exact main renderers", async () => {
  const { loaded, deps } = await fixture();
  const evaluated = [];
  deps.waitForRendererTargets = async () => [
    { id: "healthy", type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/healthy" },
    { id: "drifted", type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/drifted" },
  ];
  deps.Session = class RecordingSession {
    constructor(url) { this.id = url.split("/").at(-1); }
    async open() { return this; }
    async evaluate() { evaluated.push(this.id); return true; }
    close() {}
  };
  const result = await applySkin({
    loadedTheme: loaded,
    port: 9341,
    targetIds: ["drifted"],
    deps,
  });
  assert.deepEqual(evaluated, ["drifted"]);
  assert.deepEqual(result.targets, ["drifted"]);
  assert.deepEqual(result.results.skipped.map(({ id }) => id), ["healthy"]);
});

test("apply target allowlist fails closed when no selected main exists", async () => {
  const { loaded, deps } = await fixture();
  let sessions = 0;
  deps.Session = class NeverSession { constructor() { sessions += 1; } };
  await assert.rejects(
    applySkin({ loadedTheme: loaded, port: 9341, targetIds: ["missing"], deps }),
    (error) => error.code === "NO_SELECTED_MAIN_RENDERER",
  );
  assert.equal(sessions, 0);
});

test("apply target allowlist rejects malformed and duplicate IDs before resource or CDP work", async () => {
  const { loaded, deps } = await fixture();
  let waits = 0;
  deps.waitForRendererTargets = async () => { waits += 1; return []; };
  for (const targetIds of ["one", [""], ["one", "one"], [1]]) {
    await assert.rejects(
      applySkin({ loadedTheme: loaded, port: 9341, targetIds, deps }),
      /targetIds|renderer ID/,
    );
  }
  assert.equal(waits, 0);
});
