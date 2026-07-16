import assert from "node:assert/strict";
import test from "node:test";

import {
  controllerInjectionPreference,
  createBackgroundReadinessVerifier,
  enforceLegacyMigrationFence,
  migrateLegacyLifecycle,
  normalizeWindowsBackgroundStatus,
  offlineDisablePersistence,
  probeWindowsCdpProcess,
  runCli,
  runControllerProcess,
  validatePortOwner,
  waitForAppliedSkin,
} from "../src/cli.mjs";

function deps(overrides = {}) {
  return {
    bundledThemesRoot: "/bundle/themes",
    userThemesRoot: "/user/themes",
    listThemes: async () => [{ id: "miku-488137", name: "Miku", path: "/bundle/themes/miku-488137" }],
    loadTheme: async (path) => ({ manifest: { id: path.split("/").at(-1) }, heroPath: "/tmp/hero.png" }),
    applySkin: async ({ loadedTheme, port }) => ({ applied: 1, themeId: loadedTheme.manifest.id, port }),
    removeSkin: async () => ({ removed: 1 }),
    skinStatus: async () => [{ installed: true, themeId: "miku-488137" }],
    createSingleImageTheme: async ({ imagePath, name }) => ({ id: "new-skin", imagePath, name }),
    ...overrides,
  };
}

function lifecycleDeps(overrides = {}) {
  let state = overrides.initialState ?? {
    schemaVersion: 2,
    persistenceEnabled: false,
    selectedThemeId: "miku-488137",
    lastNonNativeThemeId: "miku-488137",
    controlToken: Buffer.alloc(32, 7).toString("base64url"),
    lastTransitionNonce: null,
    revision: 5,
  };
  const calls = {
    controller: [],
    createController: [],
    detached: [],
    offlineDisable: [],
    migrate: [],
    preflight: [],
    registerEphemeral: [],
    runController: [],
  };
  const controller = {
    pause: async () => ({ mode: "paused" }),
    resume: async () => ({ mode: "active" }),
    restore: async () => ({ mode: "restoring", persistenceEnabled: false }),
    setPersistence: async ({ expectedRevision, enabled }) => {
      calls.controller.push({ expectedRevision, enabled });
      state = { ...state, persistenceEnabled: enabled, revision: state.revision + 1 };
      return { persistenceEnabled: state.persistenceEnabled, revision: state.revision };
    },
    start: async () => ({ action: "idle", mode: "active" }),
    stop: async () => ({ stopped: true }),
  };
  const fixture = deps({
    nodeVersion: "v22.14.0",
    readState: async () => structuredClone(state),
    preflightLifecycle: async (input) => {
      calls.preflight.push(structuredClone(input));
      if (overrides.validatePortOwner === false) throw new Error("端口不属于目标 Codex");
      return {
        appPath: "/Applications/ChatGPT.app",
        nodePath: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
        process: {
          pid: 4242,
          executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
          startedAt: "Fri Jul 17 11:00:00 2026",
        },
      };
    },
    registerEphemeralController: async (input) => {
      calls.registerEphemeral.push(structuredClone(input));
      return { mode: "active" };
    },
    createController: (input) => {
      calls.createController.push(structuredClone(input));
      return controller;
    },
    runController: async (instance, input) => {
      calls.runController.push(structuredClone(input));
      return instance.start();
    },
    restartDetached: async (input) => {
      calls.detached.push(structuredClone(input));
      return { queued: true };
    },
    offlineDisablePersistence: async (input) => {
      calls.offlineDisable.push(structuredClone(input));
      if (state.persistenceEnabled) {
        state = {
          ...state,
          persistenceEnabled: false,
          lastTransitionNonce: "offline-disable",
          revision: state.revision + 1,
        };
      }
      return { persistenceEnabled: false, revision: state.revision };
    },
    migrateLegacy: async (input) => {
      calls.migrate.push(structuredClone(input));
      return { migratedFrom: "watchdog", persistenceEnabled: true };
    },
    ...overrides,
  });
  return {
    deps: fixture,
    calls,
    controller,
    get state() { return structuredClone(state); },
  };
}

function legacyMigrationHarness(overrides = {}) {
  const events = [];
  const token = Buffer.alloc(32, 13).toString("base64url");
  let state = null;
  let coordinator = null;
  let stateLeaseActive = false;
  let oldWatchdogIntact = true;
  let legacyChecks = 0;
  const dependencies = {
    randomBytes: () => Buffer.alloc(32, 13),
    randomUUID: () => "123e4567-e89b-42d3-a456-426614174000",
    legacyLoaded: async () => {
      legacyChecks += 1;
      return true;
    },
    readState: async () => structuredClone(state),
    withCoordinatorLease: async (action) => {
      events.push("coordinator-lock:begin");
      try {
        return await action();
      } finally {
        events.push("coordinator-lock:end");
      }
    },
    withStateLease: async (operation, action) => {
      assert.equal(stateLeaseActive, false, `nested state lease at ${operation}`);
      stateLeaseActive = true;
      events.push(`${operation}:begin`);
      try {
        return await action({ operation });
      } finally {
        events.push(`${operation}:end`);
        stateLeaseActive = false;
      }
    },
    readCoordinator: async () => {
      assert.equal(stateLeaseActive, true);
      return structuredClone(coordinator);
    },
    createCoordinator: async ({ stateParticipant, transactionId }) => {
      assert.equal(stateLeaseActive, true);
      coordinator = {
        transactionId,
        decision: "undecided",
        phase: "prepared",
        stateParticipant: structuredClone(stateParticipant),
        serviceParticipant: null,
      };
      events.push("coordinator:create");
      return structuredClone(coordinator);
    },
    updateCoordinator: async (_path, current, changes) => {
      assert.equal(stateLeaseActive, true);
      assert.equal(current.transactionId, coordinator.transactionId);
      coordinator = { ...coordinator, ...structuredClone(changes) };
      events.push(`coordinator:${coordinator.decision}:${coordinator.phase}`);
      return structuredClone(coordinator);
    },
    clearCoordinator: async () => {
      assert.equal(stateLeaseActive, true);
      events.push("coordinator:clear");
      coordinator = null;
    },
    migrateState: async ({ legacyAgentLoaded }) => {
      assert.equal(stateLeaseActive, true);
      assert.equal(legacyAgentLoaded, true);
      state = {
        schemaVersion: 2,
        persistenceEnabled: true,
        selectedThemeId: "miku-488137",
        lastNonNativeThemeId: "miku-488137",
        controlToken: token,
        lastTransitionNonce: null,
        revision: 1,
      };
      events.push("state:prepared");
      return { state: structuredClone(state), migratedFrom: "watchdog" };
    },
    rollbackState: async ({ expectedControlToken }) => {
      assert.equal(stateLeaseActive, true);
      assert.equal(state?.controlToken, expectedControlToken);
      assert.equal([1, 2].includes(state?.revision), true);
      state = null;
      events.push("state:rolled-back");
    },
    migrateService: async () => {
      assert.equal(stateLeaseActive, false, "service bootstrap must run outside the common lease");
      assert.equal(oldWatchdogIntact, true);
      events.push("service:prepared-old-intact");
      return {
        legacyFound: true,
        controllerRegistered: true,
        transaction: { operation: "test-service-participant" },
      };
    },
    awaitExactReady: async ({ expectedState }) => {
      assert.equal(stateLeaseActive, false, "wake and exact ACK must run outside the common lease");
      assert.equal(oldWatchdogIntact, true, "old watchdog must survive until the exact ACK");
      events.push("ready:exact-ack");
      return {
        persistenceEnabled: true,
        revision: expectedState.revision,
      };
    },
    finalizeService: async () => {
      assert.equal(stateLeaseActive, false, "service finalize must run outside the common lease");
      assert.equal(coordinator.decision, "commit");
      oldWatchdogIntact = false;
      events.push("service:committed");
    },
    recoverService: async () => {
      assert.equal(stateLeaseActive, false, "service recovery must run outside the common lease");
      if (coordinator?.decision === "commit") {
        oldWatchdogIntact = false;
        events.push("service:recovered-forward");
      } else {
        oldWatchdogIntact = true;
        events.push("service:recovered-rollback");
      }
    },
    themeExists: async () => true,
    ...overrides,
  };
  return {
    dependencies,
    events,
    get coordinator() { return structuredClone(coordinator); },
    get legacyChecks() { return legacyChecks; },
    get oldWatchdogIntact() { return oldWatchdogIntact; },
    get state() { return structuredClone(state); },
    set state(value) { state = structuredClone(value); },
  };
}

function runLegacyMigration(harness) {
  return migrateLegacyLifecycle({
    port: 9341,
    statePath: "/private/state/state.json",
    journalPath: "/private/state/legacy-migration.json",
    legacyThemePath: "/private/legacy/theme",
    dependencies: harness.dependencies,
  });
}

test("lists the bundled Miku preset by default", async () => {
  assert.deepEqual(await runCli(["list"], deps()), [{ id: "miku-488137", name: "Miku", path: "/bundle/themes/miku-488137" }]);
});

test("creates a skin directly from one image", async () => {
  assert.deepEqual(
    await runCli(["create", "--image", "/tmp/art.webp", "--name", "Fast Skin"], deps()),
    { id: "new-skin", imagePath: "/tmp/art.webp", name: "Fast Skin" },
  );
});

test("customize keeps the Finder workflow in JavaScript and applies the created theme", async () => {
  const fx = lifecycleDeps({
    chooseThemeInputs: async () => ({ imagePath: "/tmp/art.webp", name: "Fast Skin" }),
    createSingleImageTheme: async ({ imagePath, name }) => ({ id: "new-skin", imagePath, name }),
    listThemes: async () => [
      { id: "miku-488137", name: "Miku", path: "/bundle/themes/miku-488137" },
      { id: "new-skin", name: "Fast Skin", path: "/user/themes/new-skin" },
    ],
  });
  const result = await runCli(["customize"], fx.deps);
  assert.deepEqual(result, {
    created: { id: "new-skin", imagePath: "/tmp/art.webp", name: "Fast Skin" },
    applied: { mode: "active", persistenceEnabled: false },
  });
  assert.equal(fx.calls.registerEphemeral.length, 1);
  assert.equal(fx.calls.registerEphemeral[0].themeId, "new-skin");
});

test("cancelling customize is a clean no-op", async () => {
  let created = false;
  const fx = lifecycleDeps({
    chooseThemeInputs: async () => null,
    createSingleImageTheme: async () => {
      created = true;
    },
  });
  assert.deepEqual(await runCli(["customize"], fx.deps), { cancelled: true });
  assert.equal(created, false);
  assert.deepEqual(fx.calls.registerEphemeral, []);
});

test("rejects unknown commands and missing options", async () => {
  await assert.rejects(() => runCli(["create", "--image", "/tmp/a.png"], deps()), /--name/);
  await assert.rejects(() => runCli(["launch"], deps()), /未知命令/);
});

test("running through a bin symlink still executes instead of silently no-op", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtemp, symlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const run = promisify(execFile);

  const cliPath = resolve(fileURLToPath(new URL("../src/cli.mjs", import.meta.url)));
  const dir = await mkdtemp(join(tmpdir(), "heige-binlink-"));
  const link = join(dir, "heige-codex-skin");
  await symlink(cliPath, link);

  const { stdout } = await run(process.execPath, [link, "help"]);
  assert.match(stdout, /commands/, "通过符号链接调用必须真正执行并输出");
});

test("runtime commands reject Node below 22 before invoking any dependency", async () => {
  let invoked = false;
  const fx = lifecycleDeps({
    nodeVersion: "v20.19.4",
    listThemes: async () => {
      invoked = true;
      return [];
    },
  });
  await assert.rejects(runCli(["list"], fx.deps), /Node\.js 22/);
  assert.equal(invoked, false);
  assert.deepEqual((await runCli(["help"], fx.deps)).commands.includes("apply [--theme ID] [--port 9341]"), true);
});

test("Node 22 is accepted for runtime commands", async () => {
  const fx = lifecycleDeps({ nodeVersion: "22.0.0" });
  assert.equal((await runCli(["list"], fx.deps))[0].id, "miku-488137");
});

test("apply validates everything and registers only an ephemeral current-session controller", async () => {
  const fx = lifecycleDeps();
  const result = await runCli(["apply", "--theme", "miku-488137"], fx.deps);
  assert.deepEqual(result, { mode: "active", persistenceEnabled: false });
  assert.equal(fx.calls.registerEphemeral.length, 1);
  assert.equal(fx.calls.controller.length, 0, "apply must not enable persistence");
  assert.equal(fx.state.persistenceEnabled, false);
});

test("explicit apply ignores an older renderer theme while background repair may reuse it", () => {
  assert.equal(controllerInjectionPreference({ ephemeral: true }), false);
  assert.equal(controllerInjectionPreference({ ephemeral: false }), true);
  assert.equal(controllerInjectionPreference({ ephemeral: false, preferStored: false }), false);
});

test("apply prefer-stored uses authoritative lastNonNative only when Theme is omitted", async () => {
  const baseState = {
    schemaVersion: 2,
    persistenceEnabled: false,
    selectedThemeId: "miku-488137",
    lastNonNativeThemeId: "genshin-night",
    controlToken: Buffer.alloc(32, 31).toString("base64url"),
    lastTransitionNonce: null,
    revision: 9,
  };
  const make = () => lifecycleDeps({
    initialState: structuredClone(baseState),
    listThemes: async () => [
      { id: "miku-488137", name: "Miku", path: "/bundle/themes/miku-488137" },
      { id: "genshin-night", name: "Genshin", path: "/user/themes/genshin-night" },
    ],
  });

  const stored = make();
  await runCli(["apply", "--prefer-stored"], stored.deps);
  assert.equal(stored.calls.registerEphemeral[0].themeId, "genshin-night");

  const ordinary = make();
  await runCli(["apply"], ordinary.deps);
  assert.equal(ordinary.calls.registerEphemeral[0].themeId, "miku-488137");

  const explicit = make();
  await runCli(["apply", "--prefer-stored", "--theme", "miku-488137"], explicit.deps);
  assert.equal(explicit.calls.registerEphemeral[0].themeId, "miku-488137");
});

test("apply confirmation rejects a partial multi-window status result", async () => {
  const partial = {
    statuses: [{ installed: true, themeId: "miku-488137" }],
    failed: ["second-main"],
    results: {
      succeeded: [{ id: "first-main" }],
      failed: [{ id: "second-main" }],
      skipped: [],
    },
  };
  await assert.rejects(waitForAppliedSkin({
    deps: { skinStatus: async () => partial },
    port: 9341,
    themeId: "miku-488137",
    attempts: 1,
    wait: async () => {},
  }), /未确认皮肤已应用/);
});

test("apply on a native Codex queues one detached CDP restart and applies only after restart", async () => {
  const fx = lifecycleDeps({
    preflightLifecycle: async (input) => {
      fx.calls.preflight.push(structuredClone(input));
      if (input.requirePort) {
        const error = new Error("当前 Codex 尚未启用 CDP");
        error.code = "CDP_NOT_OWNED";
        throw error;
      }
      return {
        appPath: "/Applications/ChatGPT.app",
        nodePath: "/trusted/node",
        process: {
          pid: 4242,
          executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
          startedAt: "Fri Jul 17 11:00:00 2026",
        },
      };
    },
  });
  const result = await runCli(["apply", "--theme", "miku-488137"], fx.deps);
  assert.deepEqual(result, { mode: "restarting", persistenceEnabled: false, queued: true });
  assert.equal(fx.calls.registerEphemeral.length, 0);
  assert.equal(fx.calls.detached.length, 1);
  assert.deepEqual(fx.calls.detached[0].afterLaunch, {
    command: "apply",
    themeId: "miku-488137",
  });
});

test("apply starts a fully closed Codex through a launch-only detached action", async () => {
  const fx = lifecycleDeps({
    preflightLifecycle: async (input) => {
      if (input.requirePort) {
        const error = new Error("当前没有 CDP owner");
        error.code = "CDP_NOT_OWNED";
        throw error;
      }
      return {
        appPath: "/Applications/ChatGPT.app",
        nodePath: "/trusted/node",
        process: null,
      };
    },
  });
  assert.deepEqual(await runCli(["apply"], fx.deps), {
    mode: "restarting",
    persistenceEnabled: false,
    queued: true,
  });
  assert.equal(fx.calls.detached[0].preflight.process, null);
  assert.equal(fx.calls.detached[0].afterLaunch.command, "apply");
});

test("pause resume restore and enable-skin remain distinct lifecycle operations", async () => {
  const fx = lifecycleDeps();
  assert.deepEqual(await runCli(["pause"], fx.deps), { mode: "paused" });
  assert.deepEqual(await runCli(["resume"], fx.deps), { mode: "active" });
  assert.deepEqual(await runCli(["restore"], fx.deps), { mode: "restoring", persistenceEnabled: false });
  assert.deepEqual(await runCli(["enable-skin"], fx.deps), { mode: "active", persistenceEnabled: true });
  assert.deepEqual(await runCli(["set-persistence", "false"], fx.deps), { persistenceEnabled: false, revision: 7 });
  assert.deepEqual(await runCli(["migrate-legacy"], fx.deps), { migratedFrom: "watchdog", persistenceEnabled: true });
  assert.equal(fx.calls.detached.length, 1, "an existing CDP enable must not restart Codex");
  assert.equal(fx.calls.detached[0].port, 9341, "restore helper must verify the old CDP port was released");
});

test("legacy migration releases the common lease for service bootstrap and exact readiness ACK", async () => {
  const harness = legacyMigrationHarness();
  assert.deepEqual(await runLegacyMigration(harness), {
    migratedFrom: "watchdog",
    persistenceEnabled: true,
  });
  assert.equal(harness.coordinator, null);
  assert.equal(harness.oldWatchdogIntact, false);
  assert.deepEqual(harness.state, {
    schemaVersion: 2,
    persistenceEnabled: true,
    selectedThemeId: "miku-488137",
    lastNonNativeThemeId: "miku-488137",
    controlToken: Buffer.alloc(32, 13).toString("base64url"),
    lastTransitionNonce: null,
    revision: 1,
  });
  assert.ok(
    harness.events.indexOf("ready:exact-ack") <
      harness.events.indexOf("coordinator:commit:commit-decided"),
    "the global commit decision must follow the exact ACK",
  );
  assert.ok(
    harness.events.indexOf("coordinator:commit:commit-decided") <
      harness.events.indexOf("service:committed"),
    "the old watchdog may be removed only after the durable global commit",
  );
});

test("legacy migration readiness failure durably decides rollback before restoring service and state", async () => {
  const harness = legacyMigrationHarness();
  harness.dependencies.awaitExactReady = async () => {
    assert.equal(harness.oldWatchdogIntact, true);
    harness.state = {
      ...harness.state,
      persistenceEnabled: false,
      lastTransitionNonce: "controller-compensation",
      revision: 2,
    };
    throw new Error("EXACT_ACK_FAILED");
  };

  await assert.rejects(runLegacyMigration(harness), /EXACT_ACK_FAILED/);
  assert.equal(harness.coordinator, null);
  assert.equal(harness.state, null);
  assert.equal(harness.oldWatchdogIntact, true);
  assert.ok(
    harness.events.indexOf("coordinator:rollback:rollback-decided") <
      harness.events.indexOf("service:recovered-rollback"),
    "the rollback decision must be durable before service recovery",
  );
  assert.ok(
    harness.events.indexOf("service:recovered-rollback") <
      harness.events.indexOf("state:rolled-back"),
    "service recovery precedes removal of the prepared state",
  );
});

test("legacy migration recovers a precommit hard crash by restoring the old service and deleting prepared state", async () => {
  const harness = legacyMigrationHarness();
  const hardCrash = new Error("SIMULATED_HARD_CRASH");
  hardCrash.simulatedHardCrash = true;
  harness.dependencies.migrateService = async () => {
    assert.equal(harness.oldWatchdogIntact, true);
    throw hardCrash;
  };

  await assert.rejects(runLegacyMigration(harness), /SIMULATED_HARD_CRASH/);
  assert.equal(harness.coordinator.decision, "undecided");
  assert.equal(harness.state.persistenceEnabled, true);

  harness.dependencies.legacyLoaded = async () => {
    throw new Error("STOP_AFTER_RECOVERY");
  };
  await assert.rejects(runLegacyMigration(harness), /STOP_AFTER_RECOVERY/);
  assert.equal(harness.coordinator, null);
  assert.equal(harness.state, null);
  assert.equal(harness.oldWatchdogIntact, true);
  assert.ok(harness.events.includes("service:recovered-rollback"));
  assert.ok(harness.events.includes("state:rolled-back"));
});

test("legacy migration rolls forward after a crash between global commit and participant finalize", async () => {
  const harness = legacyMigrationHarness();
  const hardCrash = new Error("SIMULATED_HARD_CRASH");
  hardCrash.simulatedHardCrash = true;
  harness.dependencies.finalizeService = async () => {
    assert.equal(harness.coordinator.decision, "commit");
    throw hardCrash;
  };

  await assert.rejects(runLegacyMigration(harness), /SIMULATED_HARD_CRASH/);
  assert.equal(harness.coordinator.decision, "commit");
  assert.equal(harness.oldWatchdogIntact, true);

  harness.dependencies.finalizeService = async () => {
    throw new Error("a recovered transaction must not be finalized twice");
  };
  assert.deepEqual(await runLegacyMigration(harness), {
    migratedFrom: null,
    persistenceEnabled: true,
  });
  assert.equal(harness.coordinator, null);
  assert.equal(harness.oldWatchdogIntact, false);
  assert.equal(
    harness.events.filter((event) => event === "service:recovered-forward").length,
    1,
  );
});

test("legacy migration commit recovery keeps its journal when the committed state disappeared", async () => {
  const harness = legacyMigrationHarness();
  const hardCrash = new Error("SIMULATED_HARD_CRASH");
  hardCrash.simulatedHardCrash = true;
  harness.dependencies.finalizeService = async () => {
    throw hardCrash;
  };
  await assert.rejects(runLegacyMigration(harness), /SIMULATED_HARD_CRASH/);
  harness.state = null;

  await assert.rejects(
    runLegacyMigration(harness),
    (error) => error.code === "LEGACY_MIGRATION_RECOVERY_FAILED",
  );
  assert.equal(harness.coordinator.decision, "commit");
  assert.equal(harness.state, null);
});

test("legacy migration rollback recovery preserves its journal on a foreign state identity", async () => {
  const harness = legacyMigrationHarness();
  const hardCrash = new Error("SIMULATED_HARD_CRASH");
  hardCrash.simulatedHardCrash = true;
  harness.dependencies.migrateService = async () => {
    throw hardCrash;
  };
  await assert.rejects(runLegacyMigration(harness), /SIMULATED_HARD_CRASH/);
  harness.state = {
    ...harness.state,
    controlToken: Buffer.alloc(32, 41).toString("base64url"),
  };

  await assert.rejects(
    runLegacyMigration(harness),
    (error) => error.code === "LEGACY_MIGRATION_RECOVERY_FAILED",
  );
  assert.equal(harness.coordinator.decision, "rollback");
  assert.equal(harness.state.controlToken, Buffer.alloc(32, 41).toString("base64url"));
});

test("legacy migration fence rejects every unrelated mutation and admits only its exact foreground and one-shot background", async () => {
  const state = {
    schemaVersion: 2,
    persistenceEnabled: true,
    selectedThemeId: "miku-488137",
    lastNonNativeThemeId: "miku-488137",
    controlToken: Buffer.alloc(32, 29).toString("base64url"),
    lastTransitionNonce: null,
    revision: 1,
  };
  const coordinator = {
    transactionId: "123e4567-e89b-42d3-a456-426614174000",
    decision: "undecided",
    phase: "service-prepared",
    createdAt: "2026-07-17T08:00:00.000Z",
    serviceParticipant: { operation: "migrate-legacy-watchdog" },
    stateParticipant: { afterState: state },
  };
  let transition = null;
  const dependencies = {
    readCoordinator: async () => structuredClone(coordinator),
    readState: async () => structuredClone(state),
    readTransition: async () => structuredClone(transition),
  };
  const base = {
    journalPath: "/private/state/legacy-migration.json",
    statePath: "/private/state/state.json",
    transitionPath: "/private/state/transition.json",
    lease: { genuine: true },
    dependencies,
  };

  for (const operation of [
    "cli:prepare-state",
    "cli:disable-persistence-offline",
    "controller:set-persistence",
    "controller:restore",
    "controller:tick",
    "controller:start",
  ]) {
    await assert.rejects(
      enforceLegacyMigrationFence({ ...base, operation }),
      (error) => error.code === "LEGACY_MIGRATION_IN_PROGRESS",
      operation,
    );
  }

  const authorization = {
    role: "migration-ready-foreground",
    transactionId: coordinator.transactionId,
    journalPath: base.journalPath,
    expectedRevision: state.revision,
    expectedControlToken: state.controlToken,
  };
  for (const operation of ["controller:set-persistence", "controller:finalize-enable"]) {
    assert.equal((await enforceLegacyMigrationFence({
      ...base,
      operation,
      authorization,
    })).role, "migration-ready-foreground");
  }
  assert.equal((await enforceLegacyMigrationFence({
    ...base,
    operation: "controller:start",
    startupHandshake: {
      revision: 1,
      createdAt: "2026-07-17T08:00:01.000Z",
    },
  })).role, "migration-ready-background");
  await assert.rejects(
    enforceLegacyMigrationFence({
      ...base,
      operation: "controller:start",
      startupHandshake: {
        revision: 1,
        createdAt: "2026-07-17T07:59:59.000Z",
      },
    }),
    (error) => error.code === "LEGACY_MIGRATION_IN_PROGRESS",
  );

  transition = { operation: "foreign-transition" };
  await assert.rejects(
    enforceLegacyMigrationFence({
      ...base,
      operation: "controller:set-persistence",
      authorization,
    }),
    (error) => error.code === "LEGACY_MIGRATION_IN_PROGRESS",
  );
});

test("production readiness verifier preserves the real handshake through wait then consumes it exactly once", async (t) => {
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const {
    publishBackgroundHandshake,
    readBackgroundHandshake,
  } = await import("../src/background-handshake.mjs");
  const parent = await mkdtemp(join(tmpdir(), "heige-production-ready-"));
  const stateRoot = join(parent, "state");
  await mkdir(stateRoot, { mode: 0o700 });
  t.after(() => rm(parent, { recursive: true, force: true }));
  const startedAt = "Fri Jul 17 16:00:00 2026";
  const published = await publishBackgroundHandshake({
    stateRoot,
    revision: 7,
    transitionNonce: "migration-ready-7",
    pid: 73001,
    startedAt,
    platform: "darwin",
    backgroundIdentity: "com.heige.codex-skin-controller",
    outcome: "ready",
  });
  const verifier = createBackgroundReadinessVerifier({
    stateRoot,
    platform: "darwin",
    backgroundIdentity: "com.heige.codex-skin-controller",
    forbiddenPid: 1000,
    readIdentity: async () => ({ pid: 73001, startedAt }),
  });
  const expected = {
    revision: 7,
    transitionNonce: "migration-ready-7",
    handshakeRequest: { notBefore: Date.parse(published.createdAt) },
  };
  assert.equal(await verifier.verify(expected), true);
  assert.notEqual(await readBackgroundHandshake({ stateRoot }), null);
  assert.equal(await verifier.consume(expected), true);
  assert.equal(await readBackgroundHandshake({ stateRoot }), null);
  assert.equal(await verifier.consume(expected), false);
});

test("offline disable commits authority and a non-retained native session before unregister verification", async () => {
  const events = [];
  let leaseActive = false;
  let state = {
    schemaVersion: 2,
    persistenceEnabled: true,
    selectedThemeId: "miku-488137",
    lastNonNativeThemeId: "miku-488137",
    controlToken: Buffer.alloc(32, 23).toString("base64url"),
    lastTransitionNonce: null,
    revision: 8,
  };
  let session = null;
  const result = await offlineDisablePersistence({
    statePath: "/private/state/state.json",
    sessionPath: "/private/state/session.json",
    transitionPath: "/private/state/transition.json",
    expectedRevision: 8,
    dependencies: {
      withStateLease: async (_operation, action) => {
        leaseActive = true;
        try {
          return await action({ genuine: true });
        } finally {
          leaseActive = false;
        }
      },
      recoverTransition: async () => {
        assert.equal(leaseActive, true);
        events.push("transition:recovered");
      },
      readState: async () => structuredClone(state),
      compareState: async (_path, { expectedRevision, mutate }) => {
        assert.equal(leaseActive, true);
        assert.equal(expectedRevision, state.revision);
        state = { ...mutate(state), revision: state.revision + 1 };
        events.push("state:false");
        return structuredClone(state);
      },
      writeSession: async (_path, value) => {
        assert.equal(leaseActive, true);
        session = structuredClone(value);
        events.push("session:not-retained");
      },
      newTransitionNonce: () => "offline-disable-nonce",
      unregisterBackground: async () => {
        assert.equal(leaseActive, true);
        assert.equal(state.persistenceEnabled, false);
        assert.equal(session.keepUntilProcessExit, false);
        events.push("background:unregistered");
      },
      inspectBackground: async () => {
        assert.equal(leaseActive, true);
        events.push("background:verified");
        return { registered: false };
      },
    },
  });
  assert.deepEqual(result, { persistenceEnabled: false, revision: 9 });
  assert.deepEqual(session, {
    schemaVersion: 1,
    mode: "native",
    process: null,
    activeThemeId: null,
    keepUntilProcessExit: false,
  });
  assert.deepEqual(events, [
    "transition:recovered",
    "state:false",
    "session:not-retained",
    "background:unregistered",
    "background:verified",
  ]);
});

test("enable-skin from a native process defers the state transition until the verified CDP restart", async () => {
  const fx = lifecycleDeps({
    preflightLifecycle: async (input) => {
      if (input.requirePort) {
        const error = new Error("当前 Codex 尚未启用 CDP");
        error.code = "CDP_NOT_OWNED";
        throw error;
      }
      return {
        appPath: "/Applications/ChatGPT.app",
        nodePath: "/trusted/node",
        process: {
          pid: 4242,
          executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
          startedAt: "Fri Jul 17 11:00:00 2026",
        },
      };
    },
  });
  const result = await runCli(["enable-skin"], fx.deps);
  assert.deepEqual(result, { mode: "restarting", persistenceEnabled: false, queued: true });
  assert.deepEqual(fx.calls.controller, []);
  assert.deepEqual(fx.calls.detached[0].afterLaunch, {
    command: "enable-after-restart",
    themeId: "miku-488137",
  });
});

test("enable-skin starts a fully closed Codex and completes enable only after launch", async () => {
  const fx = lifecycleDeps({
    preflightLifecycle: async (input) => {
      if (input.requirePort) {
        const error = new Error("当前没有 CDP owner");
        error.code = "CDP_NOT_OWNED";
        throw error;
      }
      return {
        appPath: "/Applications/ChatGPT.app",
        nodePath: "/trusted/node",
        process: null,
      };
    },
  });
  assert.deepEqual(await runCli(["enable-skin"], fx.deps), {
    mode: "restarting",
    persistenceEnabled: false,
    queued: true,
  });
  assert.equal(fx.calls.detached[0].preflight.process, null);
  assert.equal(fx.calls.detached[0].afterLaunch.command, "enable-after-restart");
});

test("set-persistence false uses the offline path when Codex is native without CDP", async () => {
  const fx = lifecycleDeps({
    preflightLifecycle: async (input) => {
      if (input.requirePort) {
        const error = new Error("当前 Codex 尚未启用 CDP");
        error.code = "CDP_NOT_OWNED";
        throw error;
      }
      return {
        appPath: "/Applications/ChatGPT.app",
        nodePath: "/trusted/node",
        process: {
          pid: 4242,
          executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
          startedAt: "Fri Jul 17 11:00:00 2026",
        },
      };
    },
  });
  assert.deepEqual(await runCli(["set-persistence", "false"], fx.deps), {
    persistenceEnabled: false,
    revision: 5,
  });
  assert.deepEqual(fx.calls.offlineDisable, [{ port: 9341, expectedRevision: 5 }]);
  assert.deepEqual(fx.calls.controller, []);
  assert.deepEqual(fx.calls.detached, []);
});

test("offline restore keeps a closed Codex closed and a native Codex native", async () => {
  for (const process of [
    null,
    {
      pid: 4242,
      executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      startedAt: "Fri Jul 17 11:00:00 2026",
    },
  ]) {
    const fx = lifecycleDeps({
      preflightLifecycle: async (input) => {
        if (input.requirePort) {
          const error = new Error("当前没有 CDP owner");
          error.code = "CDP_NOT_OWNED";
          throw error;
        }
        return {
          appPath: "/Applications/ChatGPT.app",
          nodePath: "/trusted/node",
          process,
        };
      },
    });
    assert.deepEqual(await runCli(["restore"], fx.deps), {
      mode: process === null ? "closed" : "native",
      persistenceEnabled: false,
    });
    assert.deepEqual(fx.calls.offlineDisable, [{ port: 9341 }]);
    assert.deepEqual(fx.calls.controller, []);
    assert.deepEqual(fx.calls.detached, []);
  }
});

test("restore validates every dependency before Codex can be quit", async () => {
  const fx = lifecycleDeps({ validatePortOwner: false });
  await assert.rejects(runCli(["restore"], fx.deps), /端口不属于目标 Codex/);
  assert.deepEqual(fx.calls.detached, []);
  assert.deepEqual(fx.calls.controller, []);
});

test("theme identifiers use strict equality and are never interpreted as regular expressions", async () => {
  const fx = lifecycleDeps();
  await assert.rejects(runCli(["enable-skin", "--theme", ".*"], fx.deps), /找不到主题/);
  assert.equal(fx.state.lastNonNativeThemeId, "miku-488137");
  assert.deepEqual(fx.calls.detached, []);
  assert.deepEqual(fx.calls.preflight, []);
});

test("set-persistence accepts only the exact boolean words", async () => {
  const fx = lifecycleDeps();
  for (const value of ["TRUE", "0", "yes", "false "]) {
    await assert.rejects(runCli(["set-persistence", value], fx.deps), /true 或 false/);
  }
  assert.deepEqual(fx.calls.controller, []);
});

test("controller command never reports exit-zero success for an error state", async () => {
  const fx = lifecycleDeps({
    createController: () => ({
      start: async () => ({ action: "error", mode: "error" }),
      stop: async () => ({ stopped: true }),
    }),
  });
  await assert.rejects(runCli(["controller", "--once"], fx.deps), /控制器启动或巡检失败/);
});

test("controller CLI rejects dynamic handshake credentials outside the one-shot request file", async () => {
  const taskName = "HeiGe Codex Skin Studio Test 123e4567-e89b-42d3-a456-426614174000";
  await assert.rejects(runCli([
    "controller",
    "--platform",
    "windows",
    "--task-name",
    taskName,
    "--state-directory",
    "/tmp/heige-controller-isolated",
    "--handshake-revision",
    "5",
    "--handshake-nonce",
    "controller-start-5",
  ], lifecycleDeps().deps), /无法识别|handshake/i);
});

test("long-lived Windows controller forwards a fixed background identity without dynamic credentials", async () => {
  const taskName = "HeiGe Codex Skin Studio Test 123e4567-e89b-42d3-a456-426614174000";
  const fx = lifecycleDeps();
  await runCli([
    "controller",
    "--background",
    "--once",
    "--platform",
    "windows",
    "--task-name",
    taskName,
    "--state-directory",
    "/tmp/heige-controller-isolated",
  ], fx.deps);
  assert.equal(fx.calls.createController[0].background, true);
  assert.equal(fx.calls.runController[0].startupHandshake, null);
  assert.deepEqual(fx.calls.runController[0].backgroundRuntime, {
    platform: "win32",
    backgroundIdentity: taskName,
  });
});

test("background controller claims one start request before start and publishes its exact terminal ACK", async () => {
  const events = [];
  const request = {
    schemaVersion: 1,
    revision: 8,
    transitionNonce: "controller-transition-8",
    platform: "win32",
    backgroundIdentity: "HeiGe Codex Skin Studio Controller",
    createdAt: "2026-07-17T08:00:00.000Z",
  };
  const result = await runControllerProcess({
    start: async (options) => {
      assert.deepEqual(options, { startupHandshake: request });
      events.push("start");
      return {
        action: "idle",
        mode: "active",
        persistenceEnabled: true,
        revision: 8,
      };
    },
    stop: async () => events.push("stop"),
  }, {
    once: true,
    backgroundRuntime: {
      platform: "win32",
      backgroundIdentity: "HeiGe Codex Skin Studio Controller",
    },
    paths: { stateRoot: "C:\\PrivateState" },
    claimStartRequest: async (input) => {
      events.push(["claim", input]);
      return request;
    },
    readCurrentIdentity: async () => ({ pid: process.pid, startedAt: "exact-start" }),
    publishHandshake: async (input) => events.push(["publish", input]),
  });
  assert.equal(result.revision, 8);
  assert.deepEqual(events.map((entry) => Array.isArray(entry) ? entry[0] : entry), [
    "claim",
    "start",
    "publish",
    "stop",
  ]);
  assert.deepEqual(events[2][1], {
    stateRoot: "C:\\PrivateState",
    revision: 8,
    transitionNonce: "controller-transition-8",
    platform: "win32",
    backgroundIdentity: "HeiGe Codex Skin Studio Controller",
    pid: process.pid,
    startedAt: "exact-start",
    outcome: "ready",
  });
});

test("background login with no one-shot request follows the latest revision without forging an ACK", async () => {
  const events = [];
  const result = await runControllerProcess({
    start: async (options) => {
      assert.deepEqual(options, { startupHandshake: null });
      events.push("start");
      return {
        action: "idle",
        mode: "active",
        persistenceEnabled: true,
        revision: 19,
      };
    },
    stop: async () => events.push("stop"),
  }, {
    once: true,
    backgroundRuntime: {
      platform: "darwin",
      backgroundIdentity: "com.heige.codex-skin-controller",
    },
    paths: { stateRoot: "/private/state" },
    claimStartRequest: async () => {
      events.push("claim");
      return null;
    },
    publishHandshake: async () => events.push("publish"),
  });
  assert.equal(result.revision, 19, "a later theme CAS revision must not break login startup");
  assert.deepEqual(events, ["claim", "start", "stop"]);
});

test("Windows CDP probe and validation use one exact Get-NetTCPConnection owner, never lsof", async () => {
  const calls = [];
  const identity = {
    pid: 4242,
    executablePath: "C:\\Program Files\\Codex\\Codex.exe",
    startedAt: "2026-07-17T08:00:00.0000000Z",
  };
  const execFileImpl = async (file, args) => {
    calls.push([file, ...args]);
    return {
      stdout: JSON.stringify([{
        ...identity,
        processName: "Codex",
        localAddress: "127.0.0.1",
        localPort: 9341,
      }]),
    };
  };
  assert.deepEqual(await probeWindowsCdpProcess(9341, {
    execFileImpl,
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  }), identity);
  assert.equal(await validatePortOwner(9341, identity, {
    platform: "win32",
    execFileImpl,
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  }), true);
  assert.equal(calls.every((entry) => !entry.includes("/usr/sbin/lsof")), true);
  assert.equal(calls.every((entry) => entry.join(" ").includes("Get-NetTCPConnection")), true);
});

test("Windows CDP validation rejects non-loopback, multiple, and exact identity mismatches", async (t) => {
  const exact = {
    pid: 4242,
    executablePath: "C:\\Program Files\\Codex\\Codex.exe",
    startedAt: "2026-07-17T08:00:00.0000000Z",
    processName: "Codex",
    localAddress: "127.0.0.1",
    localPort: 9341,
  };
  for (const [name, records] of [
    ["non-loopback", [{ ...exact, localAddress: "0.0.0.0" }]],
    ["multiple", [exact, { ...exact, pid: 5252 }]],
    ["non-Codex", [{ ...exact, processName: "node" }]],
  ]) {
    await t.test(name, async () => {
      const execFileImpl = async () => ({ stdout: JSON.stringify(records) });
      await assert.rejects(probeWindowsCdpProcess(9341, {
        execFileImpl,
        powershellPath: "powershell.exe",
      }), /owner|loopback|unique|Codex|process/i);
      assert.equal(await validatePortOwner(9341, exact, {
        platform: "win32",
        execFileImpl,
        powershellPath: "powershell.exe",
      }), false);
    });
  }
  const mismatchExec = async () => ({ stdout: JSON.stringify([exact]) });
  assert.equal(await validatePortOwner(9341, {
    ...exact,
    startedAt: "2026-07-17T08:01:00.0000000Z",
  }, {
    platform: "win32",
    execFileImpl: mismatchExec,
    powershellPath: "powershell.exe",
  }), false);
  assert.equal(await probeWindowsCdpProcess(9341, {
    execFileImpl: async () => ({ stdout: "[]" }),
    powershellPath: "powershell.exe",
  }), null, "a closed CDP port is a normal wait-for-app state");
});

test("Windows task registration is distinct from exact running readiness", () => {
  assert.deepEqual(normalizeWindowsBackgroundStatus({
    Exists: true,
    State: "Ready",
    TaskRunning: false,
  }), {
    registered: true,
    running: false,
  });
  assert.deepEqual(normalizeWindowsBackgroundStatus({
    Exists: true,
    State: "Running",
    TaskRunning: true,
  }), {
    registered: true,
    running: true,
  });
  assert.deepEqual(normalizeWindowsBackgroundStatus({
    Exists: false,
    State: "Absent",
    TaskRunning: false,
  }), {
    registered: false,
    running: false,
  });
});

test("controller CLI rejects case-drifted task names duplicate flags and unsafe Windows state roots", async () => {
  const taskName = "HeiGe Codex Skin Studio Test 123e4567-e89b-42d3-a456-426614174000";
  await assert.rejects(runCli([
    "controller",
    "--platform",
    "windows",
    "--task-name",
    taskName,
    "--state-directory",
    "/tmp/heige-controller-isolated",
    "--handshake-revision",
    "5",
  ], lifecycleDeps().deps), /无法识别|handshake/i);
  await assert.rejects(runCli([
    "controller",
    "--platform",
    "windows",
    "--task-name",
    "heige Codex Skin Studio Test 123e4567-e89b-42d3-a456-426614174000",
    "--state-directory",
    "/tmp/heige-controller-isolated",
  ], lifecycleDeps().deps), /TaskName|允许范围/i);
  await assert.rejects(runCli([
    "controller",
    "--platform",
    "windows",
    "--task-name",
    taskName,
    "--state-directory",
    "relative-state",
  ], lifecycleDeps().deps), /绝对|absolute/i);
  await assert.rejects(runCli([
    "controller",
    "--platform",
    "windows",
    "--platform",
    "windows",
    "--task-name",
    taskName,
  ], lifecycleDeps().deps), /重复/);
});

test("background controller publishes ready only after exact successful start", async () => {
  const calls = [];
  const controller = {
    start: async () => ({
      action: "idle",
      mode: "active",
      persistenceEnabled: true,
      revision: 8,
    }),
    stop: async () => calls.push("stop"),
  };
  const startupHandshake = {
    revision: 8,
    transitionNonce: "controller-transition-8",
    platform: "darwin",
    backgroundIdentity: "com.heige.codex-skin-controller",
  };
  const result = await runControllerProcess(controller, {
    once: true,
    startupHandshake,
    paths: { stateRoot: "/private/state" },
    readCurrentIdentity: async () => ({ pid: process.pid, startedAt: "exact-start" }),
    publishHandshake: async (input) => calls.push(input),
  });
  assert.equal(result.action, "idle");
  assert.deepEqual(calls, [{
    stateRoot: "/private/state",
    ...startupHandshake,
    pid: process.pid,
    startedAt: "exact-start",
    outcome: "ready",
  }, "stop"]);
});

test("disabled background publishes unregister promptly and a wrong revision publishes nothing", async () => {
  const published = [];
  let stoppedAfterMismatch = false;
  const startupHandshake = {
    revision: 4,
    transitionNonce: "controller-start-4",
    platform: "win32",
    backgroundIdentity: "HeiGe Codex Skin Studio Controller",
  };
  const unregister = await runControllerProcess({
    start: async () => ({
      action: "unregister",
      mode: "native",
      persistenceEnabled: false,
      revision: 4,
    }),
    stop: async () => { stoppedAfterMismatch = true; },
  }, {
    startupHandshake,
    paths: { stateRoot: "C:\\State" },
    readCurrentIdentity: async () => ({ pid: process.pid, startedAt: "exact-start" }),
    publishHandshake: async (input) => published.push(input),
  });
  assert.equal(unregister.action, "unregister");
  assert.equal(published[0].outcome, "unregister");
  stoppedAfterMismatch = false;

  await assert.rejects(runControllerProcess({
    start: async () => ({
      action: "idle",
      mode: "active",
      persistenceEnabled: true,
      revision: 5,
    }),
    stop: async () => { stoppedAfterMismatch = true; },
  }, {
    once: true,
    startupHandshake,
    paths: { stateRoot: "C:\\State" },
    readCurrentIdentity: async () => ({ pid: process.pid, startedAt: "exact-start" }),
    publishHandshake: async (input) => published.push(input),
  }), /revision/i);
  assert.equal(published.length, 1);
  assert.equal(stoppedAfterMismatch, true);
});

test("install-pet CLI routing remains intact", async () => {
  const calls = [];
  const result = await runCli(["install-pet", "--source", "/tmp/pet-source"], deps({
    nodeVersion: "v22.14.0",
    home: "/Users/tester",
    installPet: async (input) => {
      calls.push(input);
      return { installed: true };
    },
  }));
  assert.deepEqual(result, { installed: true });
  assert.deepEqual(calls, [{ sourceRoot: "/tmp/pet-source", home: "/Users/tester" }]);
});
