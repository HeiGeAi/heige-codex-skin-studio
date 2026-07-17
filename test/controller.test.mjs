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
  let nativeProcessIdentity = Object.hasOwn(overrides, "nativeProcess")
    ? clone(overrides.nativeProcess)
    : null;
  let serverClosed = false;
  let backgroundRegistered = overrides.backgroundRegistered ?? state.persistenceEnabled;
  let backgroundIdentityVerified = false;
  const backgroundProcessIdentity = overrides.backgroundProcessIdentity ?? {
    pid: 8101,
    startedAt: "Fri Jul 17 16:00:00 2026",
  };
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
    probeNative: [],
    restart: [],
  };
  let nonceIndex = 0;
  let journalWriteCount = 0;

  const deps = {
    backgroundProcess: overrides.backgroundProcess === true,
    allowInternalPersistenceEnable: overrides.allowInternalPersistenceEnable ?? true,
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
    ...(Object.hasOwn(overrides, "nativeProcess")
      ? {
        probeNativeProcess: async () => {
          calls.probeNative.push(true);
          if (overrides.probeNativeFailure) throw new Error("native probe failed");
          return clone(nativeProcessIdentity);
        },
      }
      : {}),
    ...(overrides.omitRestartIntoCdp === true
      ? {}
      : {
        restartIntoCdp: async (input) => {
          calls.restart.push(clone(input));
          if (overrides.restartFailure) throw new Error("relaunch failed");
          return { queued: true };
        },
      }),
    validatePortOwner: async (candidate) => {
      if (overrides.wrongPortOwner) return false;
      return candidate !== null;
    },
    inspectSkin: async (input) => {
      calls.inspect.push(clone(input));
      if (health instanceof Error) throw health;
      return clone(health);
    },
    validateThemeSelection: overrides.validateThemeSelection ?? (async () => false),
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
      return {
        registered: true,
        started: overrides.registrationStarted === true,
      };
    },
    unregisterBackground: async () => {
      calls.unregister.push(true);
      backgroundRegistered = false;
      return { registered: false, loaded: false };
    },
    inspectBackground: async (expected) => {
      calls.inspectBackground.push(clone(expected));
      const ready = backgroundRegistered &&
        (backgroundIdentityVerified || overrides.backgroundReady !== false);
      return {
        registered: backgroundRegistered,
        running: backgroundRegistered,
        loaded: ready,
        processIdentity: ready
          ? clone(backgroundProcessIdentity)
          : null,
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
      backgroundIdentityVerified = true;
      return clone(backgroundProcessIdentity);
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
      warn: async (event, error) => {
        calls.logs.push({ event, message: error?.message });
        return true;
      },
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
    setNativeProcess(value) { nativeProcessIdentity = clone(value); },
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

test("an unauthorised direct controller call cannot enable persistence", async () => {
  const fx = fixture({
    state: { persistenceEnabled: false },
    session: activeSession({ keepUntilProcessExit: true }),
    backgroundRegistered: false,
    allowInternalPersistenceEnable: false,
  });

  await assert.rejects(
    createSkinController(fx.deps).setPersistence({ expectedRevision: 1, enabled: true }),
    /顶部菜单.*皮肤常驻.*开关/,
  );

  assert.equal(fx.state.persistenceEnabled, false);
  assert.equal(fx.state.revision, 1);
  assert.equal(fx.transition, null);
  assert.equal(fx.calls.register.length, 0);
  assert.equal(fx.calls.prepareHandshake.length, 0);
});

test("the private control-server closure is the only ordinary false-to-true capability", async () => {
  const fx = fixture({
    state: { persistenceEnabled: false },
    session: activeSession({ keepUntilProcessExit: true }),
    backgroundRegistered: false,
    allowInternalPersistenceEnable: false,
  });
  const controller = createSkinController(fx.deps);
  await controller.start();

  const changed = await fx.calls.server[0].setPersistence({
    expectedRevision: 1,
    enabled: true,
  });

  assert.deepEqual(changed, { persistenceEnabled: true, revision: 2 });
  assert.equal(fx.state.persistenceEnabled, true);
});

test("foreground controller hands off only on the tick after the successful HTTP response finishes", async () => {
  const fx = fixture({
    state: { persistenceEnabled: false, revision: 1 },
    session: activeSession({ keepUntilProcessExit: true }),
    backgroundRegistered: false,
  });
  const controller = createSkinController(fx.deps);
  await controller.start();
  const changed = await controller.setPersistence({ expectedRevision: 1, enabled: true });
  assert.deepEqual(changed, { persistenceEnabled: true, revision: 2 });
  assert.notEqual((await controller.tick()).action, "handoff");

  await fx.calls.server[0].onPersistenceResponseFinished(changed);
  const handedOff = await controller.tick();
  assert.equal(handedOff.action, "handoff");
  assert.equal(handedOff.persistenceEnabled, true);
  assert.deepEqual(
    fx.calls.leaseContext.find((_entry, index) =>
      fx.calls.lease[index] === "controller:set-persistence"),
    { desiredPersistenceEnabled: true, expectedRevision: 1 },
  );
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
    "prepare",
    "register",
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

test("outer install fence blocks idempotent repair compensation so installer rollback retains authority", async () => {
  const fx = fixture({ backgroundRegistered: false, handshakeFailure: true });
  const withLease = fx.deps.withLease;
  fx.deps.withLease = (operation, action, context) => {
    if (operation === "controller:compensate-unacked-enable") {
      const error = new Error("outer install owns rollback");
      error.code = "MACOS_INSTALL_IN_PROGRESS";
      throw error;
    }
    return withLease(operation, action, context);
  };
  await assert.rejects(createSkinController(fx.deps).setPersistence({
    expectedRevision: 1,
    enabled: true,
  }), (error) => {
    assert.equal(error.code, "BACKGROUND_START_FAILED");
    assert.equal(error.state, undefined);
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.errors[1].code, "MACOS_INSTALL_IN_PROGRESS");
    return true;
  });
  assert.equal(fx.state.persistenceEnabled, true);
  assert.equal(fx.state.revision, 1);
  assert.equal(fx.transition, null);
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

test("pause does not publish paused state before skin removal succeeds", async () => {
  const fx = fixture({ removeFailure: true });
  const before = fx.session;

  await assert.rejects(createSkinController(fx.deps).pause(), /remove failed/);

  assert.deepEqual(fx.session, before);
  assert.equal(fx.session.mode, "active");
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

function rendererRequestHealth(request, overrides = {}) {
  const value = rendererStatus({
    controlRequest: request,
    ...overrides,
  });
  return {
    statuses: [value],
    failed: [],
    results: {
      succeeded: [{ id: "main", value }],
      failed: [],
      skipped: [],
    },
  };
}

test("a polled menu request disables persistence and reinjects the current session ACK", async () => {
  const fx = fixture({ backgroundProcess: true });
  const controller = createSkinController(fx.deps);
  await controller.start();
  fx.setHealth(rendererRequestHealth({
    schemaVersion: 1,
    requestId: "b".repeat(32),
    action: "set-persistence",
    capability: CONTROL_TOKEN,
    expectedRevision: 1,
    persistenceEnabled: false,
  }));

  const result = await controller.tick();

  assert.equal(result.action, "repair");
  assert.equal(result.persistenceEnabled, false);
  assert.equal(result.revision, 2);
  assert.equal(fx.state.persistenceEnabled, false);
  assert.equal(fx.session.keepUntilProcessExit, true);
  assert.equal(fx.calls.unregister.length, 0);
  assert.equal(fx.calls.inject.length, 2);
});

test("the retained background controller re-enables persistence without restarting itself", async () => {
  const fx = fixture({ backgroundProcess: true });
  const controller = createSkinController(fx.deps);
  await controller.start();
  fx.setHealth(rendererRequestHealth({
    schemaVersion: 1,
    requestId: "b".repeat(32),
    action: "set-persistence",
    capability: CONTROL_TOKEN,
    expectedRevision: 1,
    persistenceEnabled: false,
  }));
  const disabled = await controller.tick();
  assert.equal(disabled.persistenceEnabled, false);
  assert.equal(disabled.revision, 2);

  fx.setHealth(rendererRequestHealth({
    schemaVersion: 1,
    requestId: "c".repeat(32),
    action: "set-persistence",
    capability: CONTROL_TOKEN,
    expectedRevision: 2,
    persistenceEnabled: true,
  }, {
    persistenceEnabled: false,
    revision: 2,
  }));
  const enabled = await controller.tick();

  assert.equal(enabled.action, "repair");
  assert.equal(enabled.persistenceEnabled, true);
  assert.equal(enabled.revision, 3);
  assert.equal(fx.state.persistenceEnabled, true);
  assert.equal(fx.session.keepUntilProcessExit, false);
  assert.equal(fx.backgroundRegistered, true);
  assert.equal(fx.calls.unregister.length, 0);
  assert.equal(fx.calls.register.length, 0);
  assert.equal(fx.calls.wake.length, 0);
  assert.equal(fx.calls.handshake.length, 0);
});

test("a polled menu request is the only non-internal path that can re-enable persistence", async () => {
  const fx = fixture({
    state: { persistenceEnabled: false, revision: 1 },
    session: activeSession({ keepUntilProcessExit: true }),
    backgroundRegistered: false,
    allowInternalPersistenceEnable: false,
  });
  const controller = createSkinController(fx.deps);
  await controller.start();
  fx.setHealth(rendererRequestHealth({
    schemaVersion: 1,
    requestId: "c".repeat(32),
    action: "set-persistence",
    capability: CONTROL_TOKEN,
    expectedRevision: 1,
    persistenceEnabled: true,
  }, {
    persistenceEnabled: false,
  }));

  const result = await controller.tick();

  assert.equal(result.action, "handoff");
  assert.equal(result.persistenceEnabled, true);
  assert.equal(result.revision, 2);
  assert.equal(fx.state.persistenceEnabled, true);
  assert.equal(fx.calls.register.length, 1);
  assert.equal(fx.calls.wake.length, 1);
  assert.equal(fx.calls.handshake.length, 1);
});

test("a polled menu theme request commits and reinjects the authoritative selection", async () => {
  const selected = "genshin-night";
  const fx = fixture({
    validateThemeSelection: async (themeId) => themeId === selected,
  });
  const controller = createSkinController(fx.deps);
  await controller.start();
  fx.setHealth(rendererRequestHealth({
    schemaVersion: 1,
    requestId: "d".repeat(32),
    action: "set-theme",
    capability: CONTROL_TOKEN,
    expectedRevision: 1,
    themeId: selected,
  }));

  const result = await controller.tick();

  assert.equal(result.action, "repair");
  assert.equal(result.revision, 2);
  assert.equal(fx.state.selectedThemeId, selected);
  assert.equal(fx.state.lastNonNativeThemeId, selected);
  assert.equal(fx.calls.inject.at(-1).themeId, selected);
  assert.equal(fx.calls.inject.at(-1).preferStored, false);
});

test("an idempotent polled theme request replaces a local quick image with the formal selection", async () => {
  const fx = fixture();
  const controller = createSkinController(fx.deps);
  await controller.start();
  fx.setHealth(rendererRequestHealth({
    schemaVersion: 1,
    requestId: "9".repeat(32),
    action: "set-theme",
    capability: CONTROL_TOKEN,
    expectedRevision: 1,
    themeId: DEFAULT_THEME_ID,
  }, {
    themeId: "custom-upload",
  }));

  const result = await controller.tick();

  assert.equal(result.action, "repair");
  assert.equal(result.revision, 1);
  assert.equal(fx.state.selectedThemeId, DEFAULT_THEME_ID);
  assert.equal(fx.calls.inject.length, 2);
  assert.equal(fx.calls.inject.at(-1).themeId, DEFAULT_THEME_ID);
  assert.equal(fx.calls.inject.at(-1).preferStored, false);
});

test("a polled menu request with the wrong capability cannot mutate state", async () => {
  const fx = fixture({ backgroundProcess: true });
  const controller = createSkinController(fx.deps);
  await controller.start();
  fx.setHealth(rendererRequestHealth({
    schemaVersion: 1,
    requestId: "e".repeat(32),
    action: "set-persistence",
    capability: Buffer.alloc(32, 9).toString("base64url"),
    expectedRevision: 1,
    persistenceEnabled: false,
  }));

  const result = await controller.tick();

  assert.equal(result.action, "idle");
  assert.equal(fx.state.persistenceEnabled, true);
  assert.equal(fx.state.revision, 1);
  assert.equal(fx.transition, null);
  assert.equal(fx.calls.logs.at(-1).event, "renderer_control_request_failed");
});

test("a non-canonical base64url alias of the control capability is rejected", async () => {
  const fx = fixture({ backgroundProcess: true });
  const controller = createSkinController(fx.deps);
  await controller.start();
  fx.setHealth(rendererRequestHealth({
    schemaVersion: 1,
    requestId: "8".repeat(32),
    action: "set-persistence",
    capability: `${CONTROL_TOKEN.slice(0, -1)}Z`,
    expectedRevision: 1,
    persistenceEnabled: false,
  }));

  const result = await controller.tick();

  assert.equal(result.action, "idle");
  assert.equal(fx.state.persistenceEnabled, true);
  assert.equal(fx.state.revision, 1);
  assert.equal(fx.transition, null);
  assert.equal(fx.calls.logs.at(-1).event, "renderer_control_request_failed");
});

test("conflicting requests from multiple renderers fail closed without choosing a winner", async () => {
  const disable = {
    schemaVersion: 1,
    requestId: "f".repeat(32),
    action: "set-persistence",
    capability: CONTROL_TOKEN,
    expectedRevision: 1,
    persistenceEnabled: false,
  };
  const theme = {
    schemaVersion: 1,
    requestId: "a".repeat(32),
    action: "set-theme",
    capability: CONTROL_TOKEN,
    expectedRevision: 1,
    themeId: "genshin-night",
  };
  const left = rendererStatus({ controlRequest: disable });
  const right = rendererStatus({ controlRequest: theme });
  const fx = fixture({
    backgroundProcess: true,
    health: {
      statuses: [left, right],
      failed: [],
      results: {
        succeeded: [
          { id: "left", value: left },
          { id: "right", value: right },
        ],
        failed: [],
        skipped: [],
      },
    },
  });
  const controller = createSkinController(fx.deps);
  await controller.start();

  const result = await controller.tick();

  assert.equal(result.action, "idle");
  assert.equal(fx.state.persistenceEnabled, true);
  assert.equal(fx.state.selectedThemeId, DEFAULT_THEME_ID);
  assert.equal(fx.state.revision, 1);
  assert.equal(fx.transition, null);
});

test("a divergent formal renderer is repaired from authoritative state without a reverse CAS", async () => {
  const selected = "genshin-night";
  const fx = fixture({
    validateThemeSelection: async (themeId) => themeId === selected,
  });
  const controller = createSkinController(fx.deps);
  await controller.start();
  fx.setHealth({
    statuses: [rendererStatus({ themeId: selected })],
    failed: [],
    results: {
      succeeded: [{ id: "main", value: rendererStatus({ themeId: selected }) }],
      failed: [],
      skipped: [],
    },
  });

  const result = await controller.tick();

  assert.equal(result.action, "repair");
  assert.equal(fx.state.selectedThemeId, DEFAULT_THEME_ID);
  assert.equal(fx.state.lastNonNativeThemeId, DEFAULT_THEME_ID);
  assert.equal(fx.state.revision, 1);
  assert.equal(fx.session.activeThemeId, DEFAULT_THEME_ID);
  assert.equal(fx.calls.inject.at(-1).themeId, DEFAULT_THEME_ID);
  assert.equal(fx.calls.inject.at(-1).control.revision, 1);
});

test("a divergent native renderer is repaired without changing the formal selection", async () => {
  const lastNonNativeThemeId = "genshin-night";
  const fx = fixture({
    state: { lastNonNativeThemeId },
  });
  const controller = createSkinController(fx.deps);
  await controller.start();
  const native = rendererStatus({ mode: "native", themeId: null });
  fx.setHealth({
    statuses: [native],
    failed: [],
    results: {
      succeeded: [{ id: "main", value: native }],
      failed: [],
      skipped: [],
    },
  });

  const result = await controller.tick();

  assert.equal(result.mode, "active");
  assert.equal(fx.state.selectedThemeId, DEFAULT_THEME_ID);
  assert.equal(fx.state.lastNonNativeThemeId, lastNonNativeThemeId);
  assert.equal(fx.state.revision, 1);
  assert.equal(fx.session.mode, "active");
  assert.equal(fx.session.activeThemeId, DEFAULT_THEME_ID);
  assert.equal(fx.calls.inject.at(-1).themeId, DEFAULT_THEME_ID);
});

test("the menu theme endpoint commits a verified selection before acknowledging it", async () => {
  const selected = "genshin-night";
  const fx = fixture({
    validateThemeSelection: async (themeId) => themeId === selected,
  });
  const controller = createSkinController(fx.deps);
  await controller.start();

  const changed = await fx.calls.server[0].setThemeSelection({
    expectedRevision: 1,
    themeId: selected,
  });

  assert.deepEqual(changed, {
    persistenceEnabled: true,
    revision: 2,
    selectedThemeId: selected,
    lastNonNativeThemeId: selected,
  });
  assert.equal(fx.state.selectedThemeId, selected);
  assert.equal(fx.state.lastNonNativeThemeId, selected);
  assert.equal(fx.session.activeThemeId, selected);
});

test("the menu native endpoint preserves the last formal launcher theme", async () => {
  const fx = fixture();
  const controller = createSkinController(fx.deps);
  await controller.start();

  const changed = await fx.calls.server[0].setThemeSelection({
    expectedRevision: 1,
    themeId: NATIVE_THEME_ID,
  });

  assert.equal(changed.selectedThemeId, NATIVE_THEME_ID);
  assert.equal(changed.lastNonNativeThemeId, DEFAULT_THEME_ID);
  assert.equal(fx.state.lastNonNativeThemeId, DEFAULT_THEME_ID);
  assert.equal(fx.session.mode, "native");
  assert.equal(fx.session.activeThemeId, null);
});

test("the menu theme endpoint rejects the local quick-image sentinel", async () => {
  const fx = fixture({ validateThemeSelection: async () => true });
  const controller = createSkinController(fx.deps);
  await controller.start();

  await assert.rejects(
    fx.calls.server[0].setThemeSelection({
      expectedRevision: 1,
      themeId: "custom-upload",
    }),
    /themeId is invalid/,
  );
  assert.equal(fx.state.selectedThemeId, DEFAULT_THEME_ID);
});

test("a committed theme remains authoritative when its derived session cache write fails", async () => {
  const selected = "genshin-night";
  const fx = fixture({
    validateThemeSelection: async (themeId) => themeId === selected,
  });
  const originalWriteSession = fx.deps.writeSession;
  fx.deps.writeSession = async (...args) => {
    if (fx.state.revision > 1) throw new Error("session cache unavailable");
    return originalWriteSession(...args);
  };
  const controller = createSkinController(fx.deps);
  await controller.start();

  const changed = await fx.calls.server[0].setThemeSelection({
    expectedRevision: 1,
    themeId: selected,
  });

  assert.equal(changed.selectedThemeId, selected);
  assert.equal(fx.state.selectedThemeId, selected);
  assert.equal(fx.calls.logs.at(-1).event, "theme_session_cache_write_failed");
});

test("a quick local custom image is healthy without impersonating a durable launcher theme", async () => {
  const fx = fixture();
  const controller = createSkinController(fx.deps);
  await controller.start();
  const injectsBefore = fx.calls.inject.length;
  fx.setHealth({
    statuses: [rendererStatus({ themeId: "custom-upload" })],
    failed: [],
    results: {
      succeeded: [{ id: "main", value: rendererStatus({ themeId: "custom-upload" }) }],
      failed: [],
      skipped: [],
    },
  });

  const result = await controller.tick();

  assert.equal(result.action, "idle");
  assert.equal(fx.calls.inject.length, injectsBefore);
  assert.equal(fx.state.selectedThemeId, DEFAULT_THEME_ID);
  assert.equal(fx.state.lastNonNativeThemeId, DEFAULT_THEME_ID);
});

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

test("enable publishes its one-shot request before bootstrap and never wakes that new process twice", async () => {
  const fx = fixture({
    state: { persistenceEnabled: false },
    session: activeSession({ keepUntilProcessExit: true }),
    backgroundRegistered: false,
    registrationStarted: true,
  });

  assert.deepEqual(await createSkinController(fx.deps).setPersistence({
    expectedRevision: 1,
    enabled: true,
  }), { persistenceEnabled: true, revision: 2 });

  assert.deepEqual(fx.calls.backgroundSequence, [
    "prepare",
    "register",
    "verify",
  ]);
  assert.equal(fx.calls.wake.length, 0);
});

test("authorized persistence enable returns the exact acknowledged background identity", async () => {
  const fx = fixture({ state: { persistenceEnabled: false } });
  assert.deepEqual(await createSkinController(fx.deps).setPersistence({
    expectedRevision: 1,
    enabled: true,
    includeProcessIdentity: true,
  }), {
    persistenceEnabled: true,
    revision: 2,
    processIdentity: {
      pid: 8101,
      startedAt: "Fri Jul 17 16:00:00 2026",
    },
  });
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
    return { pid: 8101, startedAt: "Fri Jul 17 16:00:00 2026" };
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

test("restore keeps a retryable retained session when skin removal fails", async () => {
  const fx = fixture({ removeFailure: true });
  const controller = createSkinController(fx.deps);
  await controller.start();

  await assert.rejects(controller.restore(), /remove failed/);

  assert.equal(fx.state.persistenceEnabled, false);
  assert.equal(fx.session.mode, "active");
  assert.equal(fx.session.keepUntilProcessExit, true);
  assert.deepEqual(fx.session.process, CURRENT_PROCESS);
  assert.equal(fx.calls.unregister.length, 0);
  assert.equal(fx.calls.close, 0);
});

test("stop is idempotent and closes the control endpoint exactly once", async () => {
  const fx = fixture();
  const controller = createSkinController(fx.deps);
  await controller.start();
  assert.deepEqual(await controller.stop(), { stopped: true });
  assert.deepEqual(await controller.stop(), { stopped: true });
  assert.equal(fx.calls.close, 1);
});

// ---- 常驻承诺：原生启动的 Codex 必须被后台控制器拉回皮肤模式 ----

const NATIVE_PROCESS = {
  pid: 4242,
  executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  startedAt: "Fri Jul 17 17:00:00 2026",
};

test("background controller relaunches a natively started Codex into CDP while persistence is on", async () => {
  const fx = fixture({
    backgroundProcess: true,
    state: { persistenceEnabled: true, revision: 3, selectedThemeId: DEFAULT_THEME_ID },
    session: nativeSession(),
    process: null,
    nativeProcess: NATIVE_PROCESS,
  });
  const result = await createSkinController(fx.deps).start();

  assert.deepEqual(result, {
    action: "relaunch",
    mode: "native",
    persistenceEnabled: true,
    revision: 3,
  });
  assert.equal(fx.calls.restart.length, 1);
  assert.deepEqual(fx.calls.restart[0], {
    process: NATIVE_PROCESS,
    themeId: DEFAULT_THEME_ID,
  });
  assert.equal(fx.calls.inject.length, 0);
  assert.equal(fx.calls.unregister.length, 0);
});

test("controller relaunches one exact native process at most once", async () => {
  const fx = fixture({
    backgroundProcess: true,
    state: { persistenceEnabled: true, revision: 3 },
    session: nativeSession(),
    process: null,
    nativeProcess: NATIVE_PROCESS,
  });
  const controller = createSkinController(fx.deps);
  assert.equal((await controller.start()).action, "relaunch");
  assert.equal((await controller.tick()).action, "wait-for-app");
  assert.equal((await controller.tick()).action, "wait-for-app");
  assert.equal(fx.calls.restart.length, 1);
});

test("controller relaunches again once a different native process appears", async () => {
  const fx = fixture({
    backgroundProcess: true,
    state: { persistenceEnabled: true, revision: 3 },
    session: nativeSession(),
    process: null,
    nativeProcess: NATIVE_PROCESS,
  });
  const controller = createSkinController(fx.deps);
  assert.equal((await controller.start()).action, "relaunch");
  assert.equal((await controller.tick()).action, "wait-for-app");
  fx.setNativeProcess({ ...NATIVE_PROCESS, pid: 4343, startedAt: "Fri Jul 17 17:05:00 2026" });
  assert.equal((await controller.tick()).action, "relaunch");
  assert.equal(fx.calls.restart.length, 2);
  assert.equal(fx.calls.restart[1].process.pid, 4343);
});

test("controller never relaunches while persistence is off", async () => {
  const fx = fixture({
    backgroundProcess: true,
    state: { persistenceEnabled: false, revision: 3 },
    session: nativeSession(),
    process: null,
    nativeProcess: NATIVE_PROCESS,
    backgroundRegistered: true,
  });
  assert.equal((await createSkinController(fx.deps).start()).action, "unregister");
  assert.equal(fx.calls.restart.length, 0);
});

test("controller waits without relaunching when no Codex process exists at all", async () => {
  const fx = fixture({
    backgroundProcess: true,
    state: { persistenceEnabled: true, revision: 3 },
    session: nativeSession(),
    process: null,
    nativeProcess: null,
  });
  assert.equal((await createSkinController(fx.deps).start()).action, "wait-for-app");
  assert.equal(fx.calls.restart.length, 0);
});

test("ephemeral controller never relaunches Codex", async () => {
  const fx = fixture({
    backgroundProcess: false,
    state: { persistenceEnabled: true, revision: 3 },
    session: nativeSession(),
    process: null,
    nativeProcess: NATIVE_PROCESS,
  });
  assert.equal((await createSkinController(fx.deps).start()).action, "wait-for-app");
  assert.equal(fx.calls.restart.length, 0);
  assert.equal(fx.calls.probeNative.length, 0);
});

test("controller keeps waiting and stays quiet when the relaunch dependency is absent", async () => {
  const fx = fixture({
    backgroundProcess: true,
    state: { persistenceEnabled: true, revision: 3 },
    session: nativeSession(),
    process: null,
    nativeProcess: NATIVE_PROCESS,
    omitRestartIntoCdp: true,
  });
  assert.equal((await createSkinController(fx.deps).start()).action, "wait-for-app");
  assert.equal(fx.calls.restart.length, 0);
});

test("a failing relaunch degrades to waiting instead of erroring or looping", async () => {
  const fx = fixture({
    backgroundProcess: true,
    state: { persistenceEnabled: true, revision: 3 },
    session: nativeSession(),
    process: null,
    nativeProcess: NATIVE_PROCESS,
    restartFailure: true,
  });
  const controller = createSkinController(fx.deps);
  assert.equal((await controller.start()).action, "wait-for-app");
  assert.equal((await controller.tick()).action, "wait-for-app");
  assert.equal(fx.calls.restart.length, 1);
  assert.ok(fx.calls.logs.some((entry) => entry.event === "relaunch_failed"));
});

test("a failing native probe degrades to waiting instead of erroring", async () => {
  const fx = fixture({
    backgroundProcess: true,
    state: { persistenceEnabled: true, revision: 3 },
    session: nativeSession(),
    process: null,
    nativeProcess: NATIVE_PROCESS,
    probeNativeFailure: true,
  });
  assert.equal((await createSkinController(fx.deps).start()).action, "wait-for-app");
  assert.equal(fx.calls.restart.length, 0);
});

test("repeated relaunches that never restore CDP stop after the failure budget", async () => {
  const fx = fixture({
    backgroundProcess: true,
    state: { persistenceEnabled: true, revision: 3 },
    session: nativeSession(),
    process: null,
    nativeProcess: NATIVE_PROCESS,
  });
  const controller = createSkinController(fx.deps);
  // 每次重启后 Codex 都换了身份却依旧没有 CDP：单靠身份去重会无限重启。
  assert.equal((await controller.start()).action, "relaunch");
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    fx.setNativeProcess({ ...NATIVE_PROCESS, pid: 5000 + attempt, startedAt: `Fri Jul 17 18:0${attempt}:00 2026` });
    await controller.tick();
  }
  assert.equal(fx.calls.restart.length, 3);
  assert.equal((await controller.tick()).action, "wait-for-app");
});

test("a relaunch that restores CDP refills the budget for the next native start", async () => {
  const fx = fixture({
    backgroundProcess: true,
    state: { persistenceEnabled: true, revision: 3 },
    session: nativeSession(),
    process: null,
    nativeProcess: NATIVE_PROCESS,
  });
  const controller = createSkinController(fx.deps);
  assert.equal((await controller.start()).action, "relaunch");

  // 重启生效：Codex 带着 CDP 回来，控制器完成注入。
  fx.setProcess(REPLACEMENT_PROCESS);
  fx.setNativeProcess(null);
  assert.equal((await controller.tick()).action, "inject");

  // 用户随后又正常重启了一次 Codex，必须照样被接管。
  fx.setProcess(null);
  fx.setNativeProcess({ ...NATIVE_PROCESS, pid: 6161, startedAt: "Fri Jul 17 19:00:00 2026" });
  assert.equal((await controller.tick()).action, "relaunch");
  assert.equal(fx.calls.restart.length, 2);
});
