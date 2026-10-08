import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, readdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkinController } from "../src/controller.mjs";
import { createSingleImageThemeFromBytes, removeUserTheme } from "../src/theme-store.mjs";
import { withOperationLock } from "../src/operation-lock.mjs";
import { readStudioState, compareAndUpdateStudioState } from "../src/state-store.mjs";
import { DEFAULT_THEME_ID, NATIVE_THEME_ID } from "../src/constants.mjs";

function png(size = 24) {
  const bytes = Buffer.alloc(size);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write("IHDR", 12);
  bytes.writeUInt32BE(10, 16); bytes.writeUInt32BE(10, 20);
  return bytes;
}

async function fixture(t, { native = false, active = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "skin-transaction-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storeRoot = join(root, "themes");
  const statePath = join(root, "state.json");
  const bytes = png();
  const original = await createSingleImageThemeFromBytes({ bytes, extension: ".png", name: "Saved", storeRoot,
    colors: { accent: "#123456", secondary: "#234567", surface: "#345678", text: "#456789" } });
  const before = await readFile(join(original.path, "theme.json"));
  const initial = { schemaVersion: 2, persistenceEnabled: true,
    selectedThemeId: native ? NATIVE_THEME_ID : active ? original.id : DEFAULT_THEME_ID,
    lastNonNativeThemeId: native || active ? original.id : DEFAULT_THEME_ID,
    controlToken: Buffer.alloc(32, 6).toString("base64url"), lastTransitionNonce: null, revision: 1 };
  await writeFile(statePath, JSON.stringify(initial), { mode: 0o600 });
  const identity = { pid: process.pid, startedAt: "2026-10-08T01:00:00.000Z" };
  const withLease = (operation, fn) => withOperationLock({ stateRoot: root,
    lockPath: join(root, "operation.lock"), identity, operation,
    readProcessIdentity: async (pid) => pid === identity.pid ? identity : null }, fn);
  const knobs = { process: { pid: 4242, executablePath: "/mock/Codex", startedAt: "2026-10-08" },
    hooks: {}, validate: true, beforeDelete: async () => {}, failCas: false };
  let handlers;
  const controller = createSkinController({
    withLease, readState: () => {
      if (knobs.unreadableState) throw new Error("state read failed");
      return readStudioState(statePath);
    }, readSession: async () => null,
    readTransition: async () => null, recoverTransition: async () => ({ state: await readStudioState(statePath) }),
    writeSession: async () => {}, probeCurrentProcess: async () => knobs.process,
    validatePortOwner: async () => true, injectSkin: async () => {}, removeSkin: async () => {},
    registerBackground: async () => {}, unregisterBackground: async () => {},
    inspectBackground: async () => ({ registered: false }), wakeBackground: async () => {},
    verifyBackgroundHandshake: async () => {},
    startControlServer: async (value) => { handlers = value; return { host: "127.0.0.1", port: 12345, close: async () => {} }; },
    validateThemeSelection: async () => knobs.validate,
    compareAndUpdate: async (options, lease) => {
      if (knobs.failCas) throw new Error("injected state write failure");
      const updated = await compareAndUpdateStudioState(statePath, { ...options, lease });
      if (knobs.failAfterCas) {
        if (knobs.failOutcomeRead) knobs.unreadableState = true;
        throw new Error("post-rename durability or verification failure");
      }
      return updated;
    },
    createUserThemeFromBytes: (options) => createSingleImageThemeFromBytes({ ...options, storeRoot, hooks: knobs.hooks }),
    removeUserTheme: async (options) => {
      await knobs.beforeDelete();
      return removeUserTheme({ ...options, storeRoot });
    },
  });
  await controller.start();
  t.after(() => controller.stop());
  return { knobs, withLease, original, initial, statePath, storeRoot,
    state: () => readStudioState(statePath),
    publish: (options = {}) => handlers.publishUserTheme({ expectedRevision: 1,
      imageBytes: bytes, extension: ".png", name: "Saved", colors: { accent: "#abcdef" }, ...options }),
    delete: (options = {}) => handlers.deleteUserTheme({ expectedRevision: 1, themeId: original.id, ...options }),
    assertPreserved: async () => {
      assert.deepEqual(await readFile(join(original.path, "theme.json")), before);
      assert.deepEqual(await readFile(join(original.path, "hero.png")), bytes);
      assert.deepEqual(await readStudioState(statePath), initial);
    },
  };
}

for (const failure of ["stale revision", "abort after publication", "unavailable process", "state write"]) {
  test(`same-ID publication preserves original bytes and colors on ${failure}`, async (t) => {
    const fx = await fixture(t);
    const abort = new AbortController();
    if (failure === "abort after publication") fx.knobs.hooks.afterPublished = () => abort.abort(new Error("aborted after publish"));
    if (failure === "unavailable process") fx.knobs.process = null;
    if (failure === "state write") fx.knobs.failCas = true;
    await assert.rejects(fx.publish({ expectedRevision: failure === "stale revision" ? 0 : 1, signal: abort.signal }));
    await fx.assertPreserved();
  });
}

test("same-ID publication commits new colors and real state under one lease", async (t) => {
  const fx = await fixture(t);
  const result = await fx.publish();
  assert.equal(result.revision, 2);
  assert.equal((await fx.state()).selectedThemeId, fx.original.id);
  assert.equal(JSON.parse(await readFile(join(fx.original.path, "theme.json"))).colors.accent, "#abcdef");
});

test("native-mode remembered deletion commits with the genuine state lease", async (t) => {
  const fx = await fixture(t, { native: true });
  const result = await fx.delete();
  assert.equal(result.revision, 2);
  const state = await fx.state();
  assert.equal(state.selectedThemeId, NATIVE_THEME_ID);
  assert.equal(state.lastNonNativeThemeId, DEFAULT_THEME_ID);
  await assert.rejects(access(fx.original.path));
});

for (const failure of ["fallback validation", "unavailable process", "state write", "abort"]) {
  test(`active deletion restores theme and state on ${failure}`, async (t) => {
    const fx = await fixture(t, { active: true });
    const abort = new AbortController();
    if (failure === "fallback validation") fx.knobs.validate = false;
    if (failure === "unavailable process") fx.knobs.process = null;
    if (failure === "state write") fx.knobs.failCas = true;
    if (failure === "abort") fx.knobs.beforeDelete = () => abort.abort(new Error("abort deletion"));
    await assert.rejects(fx.delete({ signal: abort.signal }));
    await fx.assertPreserved();
  });
}

test("active deletion excludes a competing real writer until fallback and removal commit", async (t) => {
  const fx = await fixture(t, { active: true });
  let blocked = false;
  fx.knobs.beforeDelete = async () => {
    await assert.rejects(fx.withLease("competing-writer", async () => assert.fail("must not acquire")),
      (error) => { blocked = error.code === "LOCK_HELD"; return blocked; });
  };
  assert.equal((await fx.delete()).revision, 2);
  assert.equal(blocked, true);
  assert.equal((await fx.state()).selectedThemeId, DEFAULT_THEME_ID);
  await assert.rejects(access(fx.original.path));
  await fx.withLease("writer-after-delete", (lease) => compareAndUpdateStudioState(fx.statePath, {
    lease, expectedRevision: 2, mutate: (state) => ({ ...state, persistenceEnabled: false }),
  }));
  assert.equal((await fx.state()).revision, 3);
});

test("new publication is removed on failure without touching other themes", async (t) => {
  const fx = await fixture(t);
  fx.knobs.process = null;
  await assert.rejects(fx.publish({ name: "New theme" }));
  await fx.assertPreserved();
  assert.deepEqual(await readdir(fx.storeRoot), [fx.original.id]);
});

test("native remembered deletion rolls its directory back on state write failure", async (t) => {
  const fx = await fixture(t, { native: true });
  fx.knobs.failCas = true;
  await assert.rejects(fx.delete(), /state write failure/);
  await fx.assertPreserved();
});

// Exercise the fallback status expression, real CDP response decoder, controller,
// image limits, real theme store and real state lease. Only the renderer/socket
// and app-process effects are simulated; no HTTP endpoint or desktop is used.
for (const size of [768 * 1024 + 1, 1024 * 1024, 8 * 1024 * 1024, 8 * 1024 * 1024 + 1]) {
  test(`CDP fallback saves bounded upload ${size} bytes or explicitly rejects oversize`, async (t) => {
    const { skinStatus } = await import("../src/injector.mjs");
    const { CdpSession } = await import("../src/cdp-client.mjs");
    const { runInNewContext } = await import("node:vm");
    const fx = await fixture(t);
    const request = { schemaVersion: 1, requestId: "a".repeat(32), action: "publish-user-theme",
      capability: fx.initial.controlToken, expectedRevision: 1, name: "Fallback",
      image: "data:image/png;base64," + png(size).toString("base64") };
    let transportHealthy = false;
    class Session extends CdpSession {
      constructor(url) {
        super(url, { WebSocketImpl: class {} });
        this.socketOpen = true;
        this.socket = { close() {}, send: (payload) => {
          const command = JSON.parse(payload);
          const value = runInNewContext(command.params.expression, {
            document: { getElementById: () => ({}), documentElement: { dataset: {} } },
            window: { __heigeCodexSkinRuntime: { status: () => ({ controlRequest: request }) } },
          });
          this.handleMessage({ data: JSON.stringify({ id: command.id, result: { result: { type: "object", value } } }) });
        }};
      }
      async open() { return this; }
      close() { transportHealthy = !this.closed; super.close(); }
    }
    const result = await skinStatus({ port: 9341, includeControlRequest: true, deps: {
      Session, fetchRendererTargets: async () => [{ id: "main", type: "page", url: "app://-/index.html",
        webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/main" }],
    }});
    assert.equal(transportHealthy, true);
    const transported = result.statuses[0].controlRequest;
    assert.equal(transported.image, request.image);
    const save = fx.publish({ name: transported.name,
      imageBytes: Buffer.from(transported.image.split(",")[1], "base64") });
    if (size > 8 * 1024 * 1024) {
      await assert.rejects(save, /8MB/);
      await fx.assertPreserved();
    } else {
      assert.equal((await save).revision, 2);
      const state = await fx.state();
      assert.equal((await readFile(join(fx.storeRoot, state.selectedThemeId, "hero.png"))).length, size);
    }
  });
}

for (const operation of ["publish", "delete"]) {
  test(`${operation} retries join the same commit without nested lease acquisition`, async (t) => {
    const fx = await fixture(t, { active: operation === "delete" });
    const request = { requestId: "b".repeat(32) };
    const results = await Promise.all([fx[operation](request), fx[operation](request)]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0].revision, 2);
    assert.deepEqual(await fx[operation](request), results[0]);
    assert.equal((await fx.state()).revision, 2);
  });
}

for (const sameId of [false, true]) {
  test(`publication preserves committed ${sameId ? "same-ID" : "new"} theme after CAS throws`, async (t) => {
    const fx = await fixture(t);
    fx.knobs.failAfterCas = true;
    const result = await fx.publish(sameId ? {} : { name: "New after commit" });
    assert.equal(result.revision, 2);
    const state = await fx.state();
    const manifest = JSON.parse(await readFile(join(fx.storeRoot, state.selectedThemeId, "theme.json")));
    assert.equal(manifest.colors.accent, "#abcdef");
    await access(join(fx.storeRoot, state.selectedThemeId, "hero.png"));
  });
}

for (const native of [false, true]) {
  test(`${native ? "native remembered" : "active"} deletion recognizes a committed CAS that throws`, async (t) => {
    const fx = await fixture(t, { active: !native, native });
    fx.knobs.failAfterCas = true;
    assert.equal((await fx.delete()).revision, 2);
    const state = await fx.state();
    assert.equal(state.selectedThemeId, native ? NATIVE_THEME_ID : DEFAULT_THEME_ID);
    assert.equal(state.lastNonNativeThemeId, DEFAULT_THEME_ID);
    await assert.rejects(access(fx.original.path));
  });
}

test("unreadable CAS outcome retains both published and retired versions", async (t) => {
  const fx = await fixture(t);
  fx.knobs.failAfterCas = true;
  fx.knobs.failOutcomeRead = true;
  await assert.rejects(fx.publish(), { code: "THEME_COMMIT_OUTCOME_UNKNOWN" });
  const state = await fx.state();
  assert.equal(state.revision, 2);
  const published = JSON.parse(await readFile(join(fx.original.path, "theme.json")));
  assert.equal(published.colors.accent, "#abcdef");
  const retired = (await readdir(fx.storeRoot)).find((name) => name.includes(".retired-"));
  assert.ok(retired);
  const previous = JSON.parse(await readFile(join(fx.storeRoot, retired, "theme.json")));
  assert.equal(previous.colors.accent, "#123456");
});
