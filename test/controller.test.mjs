import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_RENDERER_ORIGIN,
  DEFAULT_THEME_ID,
  NATIVE_THEME_ID,
} from "../src/constants.mjs";
import { createSkinController } from "../src/controller.mjs";

const CONTROL_TOKEN = Buffer.alloc(32, 6).toString("base64url");
const CURRENT_PROCESS = Object.freeze({
  pid: 4242,
  executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  startedAt: "Fri Jul 17 08:00:00 2026",
});
const REPLACEMENT_PROCESS = Object.freeze({
  ...CURRENT_PROCESS,
  pid: 5252,
  startedAt: "Fri Jul 17 09:00:00 2026",
});

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function studioState(overrides = {}) {
  return {
    schemaVersion: 2,
    persistenceEnabled: true,
    selectedThemeId: DEFAULT_THEME_ID,
    lastNonNativeThemeId: DEFAULT_THEME_ID,
    controlToken: CONTROL_TOKEN,
    lastTransitionNonce: null,
    revision: 1,
    ...overrides,
  };
}

function activeSession(overrides = {}) {
  return {
    schemaVersion: 1,
    mode: "active",
    process: clone(CURRENT_PROCESS),
    activeThemeId: DEFAULT_THEME_ID,
    keepUntilProcessExit: false,
    ...overrides,
  };
}

function nativeSession(overrides = {}) {
  return {
    schemaVersion: 1,
    mode: "native",
    process: null,
    activeThemeId: null,
    keepUntilProcessExit: false,
    ...overrides,
  };
}

function stateConflict(state) {
  const error = new Error("revision conflict");
  error.code = "REVISION_CONFLICT";
  error.persistenceEnabled = state.persistenceEnabled;
  error.revision = state.revision;
  return error;
}

function transitionSession(state, journal, currentProcess) {
  const matches = currentProcess !== null &&
    currentProcess.pid === journal.process.pid &&
    currentProcess.executablePath === journal.process.executablePath &&
    currentProcess.startedAt === journal.process.startedAt;
  if (!matches) return nativeSession();
  return activeSession({
    process: clone(journal.process),
    activeThemeId: state.selectedThemeId,
    keepUntilProcessExit: !journal.desiredPersistenceEnabled,
  });
}

function fixture(overrides = {}) {
  let state = studioState(overrides.state);
  let session = activeSession(overrides.session);
  let transition = clone(overrides.transition ?? null);
  let processIdentity = Object.hasOwn(overrides, "process")
    ? clone(overrides.process)
    : clone(CURRENT_PROCESS);
  let serverClosed = false;
  let backgroundRegistered = overrides.backgroundRegistered ?? state.persistenceEnabled;
  let health = overrides.health ?? { healthy: true };
  const calls = {
    lease: [],
    leaseContext: [],
    server: [],
    close: 0,
    launch: [],
    inject: [],
    remove: [],
    inspect: [],
    register: [],
    unregister: [],
    inspectBackground: [],
    wake: [],
    handshake: [],
    preflight: [],
    prepareHandshake: [],
    logs: [],
    backgroundSequence: [],
  };
  let nonceIndex = 0;
  let journalWriteCount = 0;

  const deps = {
    backgroundProcess: overrides.backgroundProcess === true,
    withLease: async (operation, action, context) => {
      calls.lease.push(operation);
      calls.leaseContext.push(clone(context));
      if (overrides.lockFailure) throw new Error("LOCK_NOT_OWNED");
      const value = await action(Object.freeze({ operation }));
      if (overrides.releaseFailureAfterEnable && operation === "controller:set-persistence") {
        throw new Error("LOCK_RELEASE_FAILED");
      }
      if (overrides.releaseFailureAfterFinalize && operation === "controller:finalize-enable") {
        throw new Error("LOCK_RELEASE_FAILED_AFTER_FINALIZE");
      }
      return value;
    },
    readState: async () => {
      if (overrides.stateFailure) throw new Error("state corrupted");
      return clone(state);
    },
    readSession: async () => clone(session),
    readTransition: async () => clone(transition),
    writeJournal: async (value) => {
      journalWriteCount += 1;
      transition = clone(value);
      if (overrides.journalWriteFailureAfterCommit && journalWriteCount === 1) {
        throw new Error("journal sync result was indeterminate");
      }
    },
    compareAndUpdate: async ({ expectedRevision, mutate }) => {
      if (state.revision !== expectedRevision) throw stateConflict(state);
      state = {
        ...clone(mutate(clone(state))),
        revision: state.revision + 1,
      };
      return clone(state);
    },
    writeSession: async (value) => {
      session = clone(value);
    },
    clearJournal: async (nonce) => {
      assert.equal(transition?.nonce, nonce);
      assert.equal(transition?.stage, "session-committed");
      transition = null;
      return true;
    },
    recoverTransition: async ({ currentProcess }) => {
      if (transition === null) {
        return { state: clone(state), session: clone(session), recovered: false };
      }
      const committed = state.revision === transition.expectedRevision + 1 &&
        state.persistenceEnabled === transition.desiredPersistenceEnabled &&
        state.lastTransitionNonce === transition.nonce;
      if (transition.stage === "prepared" && state.revision === transition.expectedRevision) {
        state = {
          ...state,
          persistenceEnabled: transition.desiredPersistenceEnabled,
          lastTransitionNonce: transition.nonce,
          revision: state.revision + 1,
        };
      } else if (transition.stage === "prepared" && !committed) {
        throw new Error("TRANSITION_CONFLICT");
      } else if (!committed) {
        throw new Error("TRANSITION_CONFLICT");
      }
      transition = { ...transition, stage: "state-committed" };
      session = transitionSession(state, transition, currentProcess);
      transition = { ...transition, stage: "session-committed" };
      transition = null;
      return { state: clone(state), session: clone(session), recovered: true };
    },
    probeCurrentProcess: async () => clone(processIdentity),
    validatePortOwner: async (candidate) => {
      if (overrides.wrongPortOwner) return false;
      return candidate !== null;
    },
    inspectSkin: async (input) => {
      calls.inspect.push(clone(input));
      if (health instanceof Error) throw health;
      return clone(health);
    },
    injectSkin: async (input) => {
      calls.inject.push(clone(input));
      if (overrides.injectFailure) throw new Error("inject failed");
      return clone(overrides.injectResult ?? {
        applied: 1,
        targets: input.targetIds ?? ["main"],
        failed: [],
      });
    },
    removeSkin: async (input) => {
      calls.remove.push(clone(input));
      if (overrides.removeFailure) throw new Error("remove failed");
      return { removed: 1 };
    },
    startControlServer: async (input) => {
      calls.server.push(input);
      if (overrides.serverFailure) throw new Error("server failed");
      return {
        host: "127.0.0.1",
        port: 43123,
        close: async () => {
          if (!serverClosed) {
            serverClosed = true;
            calls.close += 1;
          }
        },
      };
    },
    preflightEnable: async () => {
      calls.preflight.push(true);
      if (overrides.preflightFailure) throw new Error("preflight failed");
      return true;
    },
    prepareBackgroundHandshake: async (input) => {
      calls.backgroundSequence.push("prepare");
      calls.prepareHandshake.push(clone(input));
      return { notBefore: 12345 };
    },
    registerBackground: async () => {
      calls.backgroundSequence.push("register");
      calls.register.push(true);
      if (overrides.registerFailure) throw new Error("后台控制器启动失败");
      backgroundRegistered = true;
      return { registered: true };
    },
    unregisterBackground: async () => {
      calls.unregister.push(true);
      backgroundRegistered = false;
      return { registered: false, loaded: false };
    },
    inspectBackground: async (expected) => {
      calls.inspectBackground.push(clone(expected));
      return {
        registered: backgroundRegistered,
        running: backgroundRegistered,
        loaded: backgroundRegistered && overrides.backgroundReady !== false,
      };
    },
    wakeBackground: async () => {
      calls.backgroundSequence.push("wake");
      calls.wake.push(true);
      if (overrides.wakeFailure) throw new Error("后台控制器启动失败");
    },
    verifyBackgroundHandshake: async (input) => {
      calls.backgroundSequence.push("verify");
      calls.handshake.push(clone(input));
      if (overrides.handshakeFailure) throw new Error("后台控制器启动失败");
      return true;
    },
    newTransitionNonce: () => `controller-transition-${++nonceIndex}`,
    fault: async (point) => {
      if (overrides.faultAt === point) throw new Error("SIMULATED_CRASH");
    },
    logger: {
      error: async (event, error) => {
        calls.logs.push({ event, message: error?.message });
        return overrides.logFailure ? false : true;
      },
      info: async () => true,
      warn: async () => true,
    },
    launcherName: "HeiGe 皮肤启动器",
  };

  return {
    deps,
    calls,
    get state() { return clone(state); },
    get session() { return clone(session); },
    get transition() { return clone(transition); },
    get backgroundRegistered() { return backgroundRegistered; },
    setProcess(value) { processIdentity = clone(value); },
    setHealth(value) { health = value; },
  };
}

test("new default-off boot unregisters without launching injecting or opening a server", async () => {
  const fx = fixture({
    state: { persistenceEnabled: false, revision: 0 },
    session: nativeSession(),
    process: null,
    backgroundRegistered: true,
  });
  const result = await createSkinController(fx.deps).start();

  assert.deepEqual(result, {
    action: "unregister",
    mode: "native",
    persistenceEnabled: false,
    revision: 0,
  });
  assert.equal(fx.calls.server.length, 0);
  assert.equal(fx.calls.inject.length, 0);
  assert.equal(fx.calls.launch.length, 0);
  assert.equal(fx.calls.unregister.length, 1);
});

test("controller start forwards the claimed one-shot request to the operation-lease gate", async () => {
  const fx = fixture({ session: nativeSession() });
  const startupHandshake = {
    schemaVersion: 1,
    revision: 1,
    transitionNonce: "migration-ready",
    platform: "darwin",
    backgroundIdentity: "com.heige.codex-skin-controller",
    createdAt: "2026-07-17T08:00:01.000Z",
  };
  await createSkinController(fx.deps).start({ startupHandshake });
  assert.deepEqual(fx.calls.leaseContext[0], { startupHandshake });
});

test("legacy-on state starts one exact-origin endpoint and injects with a narrow descriptor", async () => {
  const fx = fixture({ session: nativeSession() });
  const result = await createSkinController(fx.deps).start();

  assert.equal(result.action, "inject");
  assert.equal(result.mode, "active");
  assert.equal(fx.calls.server.length, 1);
  assert.deepEqual(fx.calls.server[0].allowedOrigins, new Set([CODEX_RENDERER_ORIGIN]));
  assert.equal(fx.calls.server[0].token, CONTROL_TOKEN);
  assert.equal(fx.calls.inject.length, 1);
  assert.deepEqual(Object.keys(fx.calls.inject[0]).sort(), ["control", "process", "themeId"]);
  assert.deepEqual(fx.calls.inject[0].control, {
    available: true,
    persistenceEnabled: true,
    revision: 1,
    endpoint: "http://127.0.0.1:43123/v1/persistence",
    token: CONTROL_TOKEN,
    launcherName: "HeiGe 皮肤启动器",
  });
});

test("a fresh controller endpoint repairs an already active menu with the new descriptor", async () => {
  const fx = fixture();
  const result = await createSkinController(fx.deps).start();
  assert.equal(result.action, "repair");
  assert.equal(fx.calls.inspect.length, 0);
  assert.equal(fx.calls.inject.length, 1);
  assert.equal(
    fx.calls.inject[0].control.endpoint,
    "http://127.0.0.1:43123/v1/persistence",
  );
});

test("native appearance still repairs the menu when the controller endpoint changes", async () => {
  const fx = fixture({
    state: { selectedThemeId: NATIVE_THEME_ID },
    session: nativeSession({ process: clone(CURRENT_PROCESS) }),
  });
  const result = await createSkinController(fx.deps).start();
  assert.equal(result.action, "repair");
  assert.equal(result.mode, "native");
  assert.equal(fx.calls.inject.length, 1);
  assert.equal(fx.calls.inject[0].themeId, NATIVE_THEME_ID);
});

test("a healthy native renderer is not repeatedly repaired", async () => {
  const fx = fixture({
    state: { selectedThemeId: NATIVE_THEME_ID },
    session: nativeSession({ process: clone(CURRENT_PROCESS) }),
  });
  const controller = createSkinController(fx.deps);
  await controller.start();
  fx.setHealth({
    statuses: [rendererStatus({ themeId: null, mode: "native" })],
  });
  const result = await controller.tick();
  assert.equal(result.action, "idle");
  assert.equal(result.mode, "native");
  assert.equal(fx.calls.inject.length, 1);
});

test("turning persistence off keeps only the verified current process", async () => {
  const fx = fixture();
  const controller = createSkinController(fx.deps);
  const changed = await controller.setPersistence({ expectedRevision: 1, enabled: false });

  assert.equal(changed.persistenceEnabled, false);
  assert.equal(changed.revision, 2);
  assert.equal(fx.session.keepUntilProcessExit, true);
  assert.deepEqual(fx.session.process, CURRENT_PROCESS);

  fx.setProcess(REPLACEMENT_PROCESS);
  const result = await controller.tick();
  assert.equal(result.action, "unregister");
  assert.equal(fx.calls.inject.length, 0);
  assert.deepEqual(fx.session, nativeSession());
});

test("same-value persistence request is idempotent even when its request revision is old", async () => {
  const fx = fixture();
  const result = await createSkinController(fx.deps).setPersistence({
    expectedRevision: 0,
    enabled: true,
  });
  assert.deepEqual(result, { persistenceEnabled: true, revision: 1 });
  assert.equal(fx.transition, null);
});

test("same-value enabled state repairs a missing background job without changing revision", async () => {
  const fx = fixture({ backgroundRegistered: false });
  const result = await createSkinController(fx.deps).setPersistence({
    expectedRevision: 0,
    enabled: true,
  });
  assert.deepEqual(result, { persistenceEnabled: true, revision: 1 });
  assert.equal(fx.calls.register.length, 1);
  assert.equal(fx.calls.wake.length, 1);
  assert.deepEqual(fx.calls.backgroundSequence.slice(0, 4), [
    "register",
    "prepare",
    "wake",
    "verify",
  ]);
  assert.equal(fx.calls.handshake[0].revision, 1);
  assert.equal(fx.state.revision, 1);
});

test("a merely registered background job is not treated as an exact readiness ACK", async () => {
  const fx = fixture({ backgroundRegistered: true, backgroundReady: false });
  const result = await createSkinController(fx.deps).setPersistence({
    expectedRevision: 0,
    enabled: true,
  });
  assert.deepEqual(result, { persistenceEnabled: true, revision: 1 });
  assert.equal(fx.calls.register.length, 1);
  assert.equal(fx.calls.wake.length, 1);
  assert.equal(fx.calls.handshake.length, 1);
  assert.deepEqual(fx.calls.inspectBackground[0], {
    revision: 1,
    transitionNonce: fx.state.lastTransitionNonce,
  });
});

test("the already-running background controller does not restart itself for an idempotent enable", async () => {
  const fx = fixture({
    backgroundProcess: true,
    backgroundRegistered: true,
    backgroundReady: false,
  });
  assert.deepEqual(await createSkinController(fx.deps).setPersistence({
    expectedRevision: 0,
    enabled: true,
  }), { persistenceEnabled: true, revision: 1 });
  assert.equal(fx.calls.inspectBackground.length, 0);
  assert.equal(fx.calls.register.length, 0);
  assert.equal(fx.calls.wake.length, 0);
});

test("failed same-value repair compensates the stale enabled claim to false", async () => {
  const fx = fixture({ backgroundRegistered: false, handshakeFailure: true });
  await assert.rejects(createSkinController(fx.deps).setPersistence({
    expectedRevision: 0,
    enabled: true,
  }), (error) => {
    assert.equal(error.code, "BACKGROUND_START_FAILED");
    assert.deepEqual(error.state, { persistenceEnabled: false, revision: 2 });
    return true;
  });
  assert.equal(fx.state.persistenceEnabled, false);
  assert.equal(fx.backgroundRegistered, false);
});

test("a different-value stale revision fails before writing a transition", async () => {
  const fx = fixture();
  await assert.rejects(
    createSkinController(fx.deps).setPersistence({ expectedRevision: 0, enabled: false }),
    (error) => error.code === "REVISION_CONFLICT",
  );
  assert.equal(fx.transition, null);
});

test("an indeterminate disable journal publication is recovered before ACK", async () => {
  const fx = fixture({ journalWriteFailureAfterCommit: true });
  const changed = await createSkinController(fx.deps).setPersistence({
    expectedRevision: 1,
    enabled: false,
  });
  assert.deepEqual(changed, { persistenceEnabled: false, revision: 2 });
  assert.equal(fx.session.keepUntilProcessExit, true);
  assert.equal(fx.transition, null);
});

test("pause survives ticks and resume restores the same verified process", async () => {
  const fx = fixture();
  const controller = createSkinController(fx.deps);

  assert.deepEqual(await controller.pause(), { mode: "paused" });
  assert.equal(fx.calls.remove.length, 1);
  assert.equal((await controller.tick()).action, "paused");
  assert.equal(fx.calls.inject.length, 0);

  assert.deepEqual(await controller.resume(), { mode: "active" });
  assert.equal(fx.calls.inject.length, 1);
  assert.equal(fx.session.mode, "active");
  assert.deepEqual(fx.session.process, CURRENT_PROCESS);
});

test("resume rejects a replaced process without injecting", async () => {
  const fx = fixture({
    session: activeSession({ mode: "paused", activeThemeId: null }),
    process: REPLACEMENT_PROCESS,
  });
  await assert.rejects(createSkinController(fx.deps).resume(), /same verified process/i);
  assert.equal(fx.calls.inject.length, 0);
});

test("state token process port and lease failures are fail-closed", async (t) => {
  const cases = [
    ["state", { stateFailure: true }],
    ["token", { state: { controlToken: "" } }],
    ["identity", { process: [CURRENT_PROCESS, REPLACEMENT_PROCESS] }],
    ["port", { wrongPortOwner: true }],
    ["lock", { lockFailure: true }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async () => {
      const fx = fixture(options);
      const result = await createSkinController(fx.deps).start();
      assert.equal(result.action, "error");
      assert.equal(result.mode, "error");
      assert.equal(fx.calls.inject.length, 0);
      assert.equal(fx.calls.register.length, 0);
      assert.equal(fx.calls.unregister.length, 0);
      assert.equal(fx.calls.server.length, 0);
      assert.equal(fx.calls.launch.length, 0);
    });
  }
});

test("a healthy tick resets the consecutive health failure count", async () => {
  const fx = fixture();
  const controller = createSkinController(fx.deps);
  await controller.start();
  fx.setHealth(new Error("temporary health failure"));
  const failed = await controller.tick();
  assert.equal(failed.action, "error");
  assert.equal(failed.consecutiveFailures, 1);

  fx.setHealth({ healthy: true });
  const healthy = await controller.tick();
  assert.equal(healthy.action, "idle");
  assert.equal(healthy.consecutiveFailures, 0);
});

test("one failed repair tick increments the consecutive failure count only once", async () => {
  const fx = fixture({ health: { healthy: false }, injectFailure: true });
  const failed = await createSkinController(fx.deps).tick();
  assert.equal(failed.action, "error");
  assert.equal(failed.consecutiveFailures, 1);
});

function rendererStatus(overrides = {}) {
  return {
    installed: true,
    generation: "a".repeat(32),
    mode: "active",
    themeId: DEFAULT_THEME_ID,
    menu: true,
    persistenceEnabled: true,
    revision: 1,
    ...overrides,
  };
}

test("tick repairs only missing stale or divergent renderer targets", async () => {
  const fx = fixture();
  const controller = createSkinController(fx.deps);
  await controller.start();
  fx.setHealth({
    statuses: [rendererStatus(), rendererStatus({ themeId: "wrong-theme" })],
    failed: ["missing"],
    results: {
      succeeded: [
        { id: "healthy", value: rendererStatus() },
        { id: "drifted", value: rendererStatus({ themeId: "wrong-theme" }) },
        { id: "stale", value: rendererStatus({ generation: null }) },
      ],
      failed: [{ id: "missing", error: "目标连接或执行失败" }],
      skipped: [],
    },
  });

  const result = await controller.tick();
  assert.equal(result.action, "repair");
  assert.deepEqual(result.healthyTargets, ["healthy"]);
  assert.deepEqual(result.repairedTargets, ["drifted", "stale", "missing"]);
  assert.deepEqual(fx.calls.inject.at(-1).targetIds, ["drifted", "stale", "missing"]);
});

test("a partially failed selective repair never reinjects a healthy window", async () => {
  const fx = fixture({
    injectResult: {
      applied: 1,
      targets: ["drifted"],
      failed: ["missing"],
    },
  });
  const controller = createSkinController(fx.deps);
  await controller.start();
  fx.setHealth({
    results: {
      succeeded: [
        { id: "healthy", value: rendererStatus() },
        { id: "drifted", value: rendererStatus({ revision: 0 }) },
      ],
      failed: [{ id: "missing", error: "目标连接或执行失败" }],
      skipped: [],
    },
  });

  const result = await controller.tick();
  assert.deepEqual(fx.calls.inject.at(-1).targetIds, ["drifted", "missing"]);
  assert.deepEqual(result.healthyTargets, ["healthy"]);
  assert.deepEqual(result.repairedTargets, ["drifted"]);
  assert.deepEqual(result.failedTargets, ["missing"]);
  assert.equal(fx.calls.inject.at(-1).targetIds.includes("healthy"), false);
});

test("an all-target status failure still repairs only the identified main targets", async () => {
  const fx = fixture();
  const controller = createSkinController(fx.deps);
  await controller.start();
  const statusError = new Error("all status probes failed");
  statusError.code = "ALL_MAIN_TARGETS_FAILED";
  statusError.results = {
    succeeded: [],
    failed: [
      { id: "left", error: "目标连接或执行失败" },
      { id: "right", error: "目标连接或执行失败" },
    ],
    skipped: [],
  };
  fx.setHealth(statusError);

  const result = await controller.tick();
  assert.equal(result.action, "repair");
  assert.deepEqual(fx.calls.inject.at(-1).targetIds, ["left", "right"]);
  assert.deepEqual(result.repairedTargets, ["left", "right"]);
});

test("malformed or duplicate renderer status IDs fail closed before repair", async () => {
  const fx = fixture();
  const controller = createSkinController(fx.deps);
  await controller.start();
  const injectsBefore = fx.calls.inject.length;
  fx.setHealth({
    results: {
      succeeded: [
        { id: "same", value: rendererStatus() },
        { id: "same", value: rendererStatus({ revision: 0 }) },
      ],
      failed: [],
      skipped: [],
    },
  });
  const result = await controller.tick();
  assert.equal(result.action, "error");
  assert.equal(fx.calls.inject.length, injectsBefore);
});

for (const faultAt of ["after-journal", "after-state-cas", "after-session-write"]) {
  test(`disable recovers after crash at ${faultAt}`, async () => {
    const fx = fixture({ faultAt });
    await assert.rejects(
      createSkinController(fx.deps).setPersistence({ expectedRevision: 1, enabled: false }),
      /SIMULATED_CRASH/,
    );

    fx.deps.fault = async () => {};
    const recovered = await createSkinController(fx.deps).start();
    assert.equal(recovered.persistenceEnabled, false);
    assert.equal(recovered.revision, 2);
    assert.equal(fx.session.keepUntilProcessExit, true);
    assert.deepEqual(fx.session.process, CURRENT_PROCESS);
    assert.equal(fx.transition, null);
  });
}

test("startup completes a pending enable journal before considering self-unregister", async () => {
  const fx = fixture({
    state: { persistenceEnabled: false },
    session: activeSession({ keepUntilProcessExit: true }),
    transition: {
      schemaVersion: 1,
      operation: "enable-persistence",
      expectedRevision: 1,
      process: clone(CURRENT_PROCESS),
      desiredPersistenceEnabled: true,
      nonce: "pending-enable-1",
      stage: "prepared",
    },
    backgroundRegistered: true,
  });
  const result = await createSkinController(fx.deps).start();
  assert.equal(result.persistenceEnabled, true);
  assert.equal(result.revision, 2);
  assert.equal(fx.state.persistenceEnabled, true);
  assert.equal(fx.session.keepUntilProcessExit, false);
  assert.equal(fx.transition, null);
  assert.equal(fx.calls.unregister.length, 0);
});

test("enable background registration failure compensates to authoritative false with two revisions", async () => {
  const fx = fixture({
    state: { persistenceEnabled: false },
    session: activeSession({ keepUntilProcessExit: true }),
    registerFailure: true,
    backgroundRegistered: false,
  });

  await assert.rejects(
    createSkinController(fx.deps).setPersistence({ expectedRevision: 1, enabled: true }),
    (error) => {
      assert.equal(error.code, "BACKGROUND_START_FAILED");
      assert.deepEqual(error.state, { persistenceEnabled: false, revision: 3 });
      return true;
    },
  );
  assert.equal(fx.state.persistenceEnabled, false);
  assert.equal(fx.state.revision, 3);
  assert.equal(fx.backgroundRegistered, false);
  assert.equal(fx.transition, null);
  assert.equal(fx.calls.unregister.length, 1);
});

test("an indeterminate prepared-journal write is inspected and compensated before enable returns", async () => {
  const fx = fixture({
    state: { persistenceEnabled: false },
    session: activeSession({ keepUntilProcessExit: true }),
    journalWriteFailureAfterCommit: true,
    backgroundRegistered: false,
  });

  await assert.rejects(
    createSkinController(fx.deps).setPersistence({ expectedRevision: 1, enabled: true }),
    (error) => {
      assert.equal(error.code, "BACKGROUND_START_FAILED");
      assert.deepEqual(error.state, { persistenceEnabled: false, revision: 3 });
      return true;
    },
  );
  assert.equal(fx.state.persistenceEnabled, false);
  assert.equal(fx.state.revision, 3);
  assert.equal(fx.transition, null);
});

test("enable ACK follows registration wake handshake and clears current-session retention", async () => {
  const fx = fixture({
    state: { persistenceEnabled: false },
    session: activeSession({ keepUntilProcessExit: true }),
    backgroundRegistered: false,
  });
  const result = await createSkinController(fx.deps).setPersistence({
    expectedRevision: 1,
    enabled: true,
  });

  assert.deepEqual(result, { persistenceEnabled: true, revision: 2 });
  assert.equal(fx.calls.preflight.length, 1);
  assert.equal(fx.calls.register.length, 1);
  assert.equal(fx.calls.wake.length, 1);
  assert.deepEqual(fx.calls.prepareHandshake, [{
    revision: 2,
    transitionNonce: "controller-transition-1",
  }]);
  assert.deepEqual(fx.calls.handshake, [{
    revision: 2,
    transitionNonce: "controller-transition-1",
    handshakeRequest: { notBefore: 12345 },
  }]);
  assert.equal(fx.session.keepUntilProcessExit, false);
  assert.equal(fx.transition, null);
});

test("enable releases the operation lease before wake and exact background handshake", async () => {
  const fx = fixture({
    state: { persistenceEnabled: false },
    session: activeSession({ keepUntilProcessExit: true }),
    backgroundRegistered: false,
  });
  let tail = Promise.resolve();
  let backgroundStart = null;
  let backgroundAcquired = false;
  const activeOperations = new Set();
  fx.deps.withLease = async (operation, action) => {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    activeOperations.add(operation);
    fx.calls.lease.push(operation);
    try {
      return await action(Object.freeze({ operation }));
    } finally {
      activeOperations.delete(operation);
      release();
    }
  };
  fx.deps.wakeBackground = async () => {
    fx.calls.wake.push(true);
    backgroundStart = fx.deps.withLease("controller:background-start", async () => {
      backgroundAcquired = true;
      return true;
    });
  };
  fx.deps.verifyBackgroundHandshake = async ({ revision, transitionNonce }) => {
    assert.equal(
      activeOperations.has("controller:set-persistence"),
      false,
      "foreground must not hold the operation lease while waiting for ACK",
    );
    await Promise.race([
      backgroundStart,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("background start could not acquire the shared lease")),
        50,
      )),
    ]);
    assert.equal(revision, 2);
    assert.equal(transitionNonce, "controller-transition-1");
    return true;
  };

  const result = await createSkinController(fx.deps).setPersistence({
    expectedRevision: 1,
    enabled: true,
  });
  assert.deepEqual(result, { persistenceEnabled: true, revision: 2 });
  assert.equal(backgroundAcquired, true);
});

test("enable handshake failure compensates after the enabled CAS and unregisters", async () => {
  const fx = fixture({
    state: { persistenceEnabled: false },
    session: activeSession({ keepUntilProcessExit: true }),
    handshakeFailure: true,
    backgroundRegistered: false,
  });
  await assert.rejects(
    createSkinController(fx.deps).setPersistence({ expectedRevision: 1, enabled: true }),
    (error) => {
      assert.equal(error.code, "BACKGROUND_START_FAILED");
      assert.deepEqual(error.state, { persistenceEnabled: false, revision: 3 });
      return true;
    },
  );
  assert.equal(fx.calls.handshake.length, 1);
  assert.equal(fx.calls.unregister.length, 1);
  assert.equal(fx.backgroundRegistered, false);
  assert.equal(fx.transition, null);
});

test("an unacknowledged enable caused by lease-release failure is compensated off", async () => {
  const fx = fixture({
    state: { persistenceEnabled: false },
    session: activeSession({ keepUntilProcessExit: true }),
    releaseFailureAfterEnable: true,
    backgroundRegistered: false,
  });
  await assert.rejects(
    createSkinController(fx.deps).setPersistence({ expectedRevision: 1, enabled: true }),
    (error) => {
      assert.equal(error.code, "BACKGROUND_START_FAILED");
      assert.deepEqual(error.state, { persistenceEnabled: false, revision: 3 });
      return true;
    },
  );
  assert.equal(fx.state.persistenceEnabled, false);
  assert.equal(fx.state.revision, 3);
  assert.equal(fx.backgroundRegistered, false);
  assert.equal(fx.calls.lease.includes("controller:compensate-unacked-enable"), true);
});

test("finalize lease-release failure is compensated by a new exact lease", async () => {
  const fx = fixture({
    state: { persistenceEnabled: false },
    session: activeSession({ keepUntilProcessExit: true }),
    releaseFailureAfterFinalize: true,
    backgroundRegistered: false,
  });
  await assert.rejects(
    createSkinController(fx.deps).setPersistence({ expectedRevision: 1, enabled: true }),
    (error) => {
      assert.equal(error.code, "BACKGROUND_START_FAILED");
      assert.deepEqual(error.state, { persistenceEnabled: false, revision: 3 });
      return true;
    },
  );
  assert.equal(fx.calls.lease.includes("controller:finalize-enable"), true);
  assert.equal(fx.calls.lease.includes("controller:compensate-unacked-enable"), true);
  assert.equal(fx.backgroundRegistered, false);
});

test("restore disables persistence removes skin unregisters and closes the endpoint", async () => {
  const fx = fixture();
  const controller = createSkinController(fx.deps);
  await controller.start();
  const result = await controller.restore();

  assert.deepEqual(result, { mode: "restoring", persistenceEnabled: false });
  assert.equal(fx.state.persistenceEnabled, false);
  assert.equal(fx.session.mode, "restoring");
  assert.equal(fx.session.keepUntilProcessExit, false);
  assert.equal(fx.calls.remove.length, 1);
  assert.equal(fx.calls.unregister.length, 1);
  assert.equal(fx.calls.close, 1);
});

test("stop is idempotent and closes the control endpoint exactly once", async () => {
  const fx = fixture();
  const controller = createSkinController(fx.deps);
  await controller.start();
  assert.deepEqual(await controller.stop(), { stopped: true });
  assert.deepEqual(await controller.stop(), { stopped: true });
  assert.equal(fx.calls.close, 1);
});
