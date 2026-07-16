import { randomUUID } from "node:crypto";

import { CODEX_RENDERER_ORIGIN, NATIVE_THEME_ID } from "./constants.mjs";
import { sameProcessIdentity } from "./codex-app.mjs";
import { withOperationLock } from "./operation-lock.mjs";
import {
  clearTransitionJournal,
  compareAndUpdateStudioState,
  readSessionState,
  readStudioState,
  readTransitionJournal,
  recoverStateTransition,
  writeSessionState,
  writeTransitionJournal,
} from "./state-store.mjs";
import { startControlServer as startLoopbackControlServer } from "./control-server.mjs";

const CONTROL_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const RENDERER_GENERATION = /^[a-f0-9]{32}$/;
const ACTIONS = new Set([
  "idle",
  "inject",
  "repair",
  "wait-for-app",
  "unregister",
  "paused",
  "error",
]);

class ControllerTransitionError extends Error {
  constructor(code, message, state, options = undefined) {
    super(message, options);
    this.name = "ControllerTransitionError";
    this.code = code;
    this.state = state === null ? undefined : {
      persistenceEnabled: state.persistenceEnabled,
      revision: state.revision,
    };
    if (this.state !== undefined) {
      this.persistenceEnabled = this.state.persistenceEnabled;
      this.revision = this.state.revision;
    }
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactProcessIdentity(value) {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.executablePath !== "string" ||
    value.executablePath.length === 0 ||
    typeof value.startedAt !== "string" ||
    value.startedAt.length === 0
  ) {
    throw new Error("Codex process identity is invalid or ambiguous");
  }
  return {
    pid: value.pid,
    executablePath: value.executablePath,
    startedAt: value.startedAt,
  };
}

function normalizeProcessProbe(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.length !== 1) {
      throw new Error("Codex process identity is invalid or ambiguous");
    }
    return exactProcessIdentity(value[0]);
  }
  return exactProcessIdentity(value);
}

function validateControlState(value) {
  if (
    !isRecord(value) ||
    typeof value.persistenceEnabled !== "boolean" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.selectedThemeId !== "string" ||
    value.selectedThemeId.length === 0 ||
    typeof value.controlToken !== "string" ||
    !CONTROL_TOKEN.test(value.controlToken) ||
    Buffer.from(value.controlToken, "base64url").length !== 32 ||
    Buffer.from(value.controlToken, "base64url").toString("base64url") !== value.controlToken
  ) {
    throw new Error("controller state or control token is invalid");
  }
  return value;
}

function requireFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} is required`);
  return value;
}

function noopLogger() {
  return Object.freeze({
    info: async () => false,
    warn: async () => false,
    error: async () => false,
  });
}

function normalizedDependencies(input) {
  if (!isRecord(input)) throw new Error("controller dependencies are required");
  const readState = input.readState ?? (() => readStudioState(input.statePath));
  const readSession = input.readSession ?? (() => readSessionState(input.sessionPath));
  const readTransition = input.readTransition ?? (() => readTransitionJournal(input.transitionPath));
  const writeJournal = input.writeJournal ?? ((journal, lease) =>
    writeTransitionJournal(input.transitionPath, journal, { lease }));
  const compareAndUpdate = input.compareAndUpdate ?? ((options, lease) =>
    compareAndUpdateStudioState(input.statePath, { lease, ...options }));
  const writeSession = input.writeSession ?? ((session, lease) =>
    writeSessionState(input.sessionPath, session, { lease }));
  const clearJournal = input.clearJournal ?? ((nonce, lease) =>
    clearTransitionJournal(input.transitionPath, { lease, nonce }));
  const recoverTransition = input.recoverTransition ?? ((options, lease) =>
    recoverStateTransition({
      statePath: input.statePath,
      sessionPath: input.sessionPath,
      transitionPath: input.transitionPath,
      lease,
      ...options,
    }));

  let withLease = input.withLease;
  if (withLease === undefined) {
    if (!isRecord(input.lockOptions)) {
      withLease = async () => {
        throw new Error("controller lock options are required");
      };
    } else {
      withLease = (operation, action) => withOperationLock(
        { ...input.lockOptions, operation },
        action,
      );
    }
  }

  return Object.freeze({
    withLease: requireFunction(withLease, "withLease"),
    readState: requireFunction(readState, "readState"),
    readSession: requireFunction(readSession, "readSession"),
    readTransition: requireFunction(readTransition, "readTransition"),
    writeJournal: requireFunction(writeJournal, "writeJournal"),
    compareAndUpdate: requireFunction(compareAndUpdate, "compareAndUpdate"),
    writeSession: requireFunction(writeSession, "writeSession"),
    clearJournal: requireFunction(clearJournal, "clearJournal"),
    recoverTransition: requireFunction(recoverTransition, "recoverTransition"),
    probeCurrentProcess: requireFunction(input.probeCurrentProcess, "probeCurrentProcess"),
    validatePortOwner: requireFunction(input.validatePortOwner, "validatePortOwner"),
    inspectSkin: input.inspectSkin,
    injectSkin: requireFunction(input.injectSkin, "injectSkin"),
    removeSkin: requireFunction(input.removeSkin, "removeSkin"),
    startControlServer: input.startControlServer ?? startLoopbackControlServer,
    preflightEnable: input.preflightEnable ?? (async () => true),
    prepareBackgroundHandshake: input.prepareBackgroundHandshake ?? (async () => ({
      notBefore: Date.now(),
    })),
    registerBackground: requireFunction(input.registerBackground, "registerBackground"),
    unregisterBackground: requireFunction(input.unregisterBackground, "unregisterBackground"),
    inspectBackground: requireFunction(input.inspectBackground, "inspectBackground"),
    wakeBackground: requireFunction(input.wakeBackground, "wakeBackground"),
    verifyBackgroundHandshake: requireFunction(
      input.verifyBackgroundHandshake,
      "verifyBackgroundHandshake",
    ),
    backgroundProcess: input.backgroundProcess === true,
    newTransitionNonce: input.newTransitionNonce ?? randomUUID,
    fault: input.fault ?? (async () => {}),
    logger: input.logger ?? noopLogger(),
    launcherName: input.launcherName ?? "HeiGe 皮肤启动器",
    controlPort: input.controlPort ?? 0,
  });
}

function transitionJournal({ operation, expectedRevision, process, enabled, nonce, stage }) {
  return {
    schemaVersion: 1,
    operation,
    expectedRevision,
    process,
    desiredPersistenceEnabled: enabled,
    nonce,
    stage,
  };
}

function sameTransition(left, right) {
  return isRecord(left) &&
    left.schemaVersion === right.schemaVersion &&
    left.operation === right.operation &&
    left.expectedRevision === right.expectedRevision &&
    left.desiredPersistenceEnabled === right.desiredPersistenceEnabled &&
    left.nonce === right.nonce &&
    left.stage === right.stage &&
    sameProcessIdentity(left.process, right.process);
}

function sessionForState(state, process, { keepUntilProcessExit = false } = {}) {
  if (state.selectedThemeId === NATIVE_THEME_ID) {
    return {
      schemaVersion: 1,
      mode: "native",
      process,
      activeThemeId: null,
      keepUntilProcessExit,
    };
  }
  return {
    schemaVersion: 1,
    mode: "active",
    process,
    activeThemeId: state.selectedThemeId,
    keepUntilProcessExit,
  };
}

function nativeSession() {
  return {
    schemaVersion: 1,
    mode: "native",
    process: null,
    activeThemeId: null,
    keepUntilProcessExit: false,
  };
}

function restoringSession(process) {
  return {
    schemaVersion: 1,
    mode: "restoring",
    process,
    activeThemeId: null,
    keepUntilProcessExit: false,
  };
}

function result(action, mode, state, additions = undefined) {
  if (!ACTIONS.has(action)) throw new Error(`invalid controller action: ${action}`);
  return {
    action,
    mode,
    persistenceEnabled: state?.persistenceEnabled ?? null,
    revision: state?.revision ?? null,
    ...(additions ?? {}),
  };
}

function publicState(state) {
  return {
    persistenceEnabled: state.persistenceEnabled,
    revision: state.revision,
  };
}

function rendererStatusIsHealthy(value, state) {
  if (!isRecord(value)) return false;
  try {
    const installed = value.installed;
    const generation = value.generation;
    const mode = value.mode;
    const themeId = value.themeId;
    const menu = value.menu;
    const persistenceEnabled = value.persistenceEnabled;
    const revision = value.revision;
    if (
      installed !== true ||
      typeof generation !== "string" ||
      !RENDERER_GENERATION.test(generation) ||
      menu !== true ||
      persistenceEnabled !== state.persistenceEnabled ||
      revision !== state.revision
    ) {
      return false;
    }
    if (state.selectedThemeId === NATIVE_THEME_ID) {
      return mode === "native" &&
        (themeId === null || themeId === NATIVE_THEME_ID);
    }
    return mode === "active" && themeId === state.selectedThemeId;
  } catch {
    return false;
  }
}

function rendererId(entry, seen) {
  let id;
  try { id = entry?.id; } catch { throw new Error("renderer status ID is unreadable"); }
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > 512 ||
    id.includes("\0") ||
    seen.has(id)
  ) {
    throw new Error("renderer status IDs must be unique bounded strings");
  }
  seen.add(id);
  return id;
}

function analyzeRendererHealth(health, state) {
  if (!isRecord(health)) {
    return { selective: false, healthyTargets: [], repairTargets: null };
  }
  if (typeof health.healthy === "boolean") {
    return {
      selective: false,
      healthyTargets: [],
      repairTargets: health.healthy ? [] : null,
    };
  }

  const results = health.results;
  if (isRecord(results)) {
    let succeeded;
    let failed;
    try {
      succeeded = results.succeeded;
      failed = results.failed;
    } catch {
      throw new Error("renderer status results are unreadable");
    }
    if (!Array.isArray(succeeded) || !Array.isArray(failed)) {
      throw new Error("renderer status results are malformed");
    }
    if (succeeded.length + failed.length === 0) {
      throw new Error("renderer status contains no audited main target");
    }
    const seen = new Set();
    const healthyTargets = [];
    const repairTargets = [];
    for (const entry of succeeded) {
      const id = rendererId(entry, seen);
      let value;
      try { value = entry.value; } catch { value = null; }
      (rendererStatusIsHealthy(value, state) ? healthyTargets : repairTargets).push(id);
    }
    for (const entry of failed) repairTargets.push(rendererId(entry, seen));
    return { selective: true, healthyTargets, repairTargets };
  }

  if (Array.isArray(health.statuses) && health.statuses.length > 0) {
    const healthy = health.statuses.every((entry) => rendererStatusIsHealthy(entry, state));
    return {
      selective: false,
      healthyTargets: [],
      repairTargets: healthy ? [] : null,
    };
  }
  return { selective: false, healthyTargets: [], repairTargets: null };
}

function validatedRepairResult(injected, requestedTargets) {
  const requested = new Set(requestedTargets);
  const readIds = (value, fallback) => {
    if (value === undefined) return fallback;
    if (!Array.isArray(value)) throw new Error("selective repair result IDs are malformed");
    const seen = new Set();
    return value.map((id) => {
      if (typeof id !== "string" || !requested.has(id) || seen.has(id)) {
        throw new Error("selective repair returned an unrequested or duplicate target");
      }
      seen.add(id);
      return id;
    });
  };
  const repairedTargets = readIds(injected?.targets, [...requestedTargets]);
  const failedTargets = readIds(injected?.failed, []);
  if (failedTargets.some((id) => repairedTargets.includes(id))) {
    throw new Error("selective repair reported one target as both repaired and failed");
  }
  return { repairedTargets, failedTargets };
}

async function safeLog(logger, level, event, value) {
  try {
    await logger[level](event, value);
  } catch {}
}

export function createSkinController(input) {
  const deps = normalizedDependencies(input);
  let server = null;
  let stopped = false;
  let lastKnownState = null;
  let consecutiveFailures = 0;

  const probeProcess = async () => normalizeProcessProbe(await deps.probeCurrentProcess());

  const assertPortOwner = async (processIdentity) => {
    if (processIdentity === null || await deps.validatePortOwner(processIdentity) !== true) {
      throw new Error("CDP port is not owned by the exact Codex process");
    }
  };

  const closeServer = async () => {
    const current = server;
    server = null;
    if (current !== null) await current.close();
  };

  let setPersistencePublic;

  const ensureServer = async (state) => {
    const started = server === null;
    if (server === null) {
      server = await deps.startControlServer({
        token: state.controlToken,
        allowedOrigins: new Set([CODEX_RENDERER_ORIGIN]),
        readState: deps.readState,
        setPersistence: (request) => setPersistencePublic(request),
        host: "127.0.0.1",
        port: deps.controlPort,
      });
      if (server?.host !== "127.0.0.1" || !Number.isSafeInteger(server.port)) {
        const invalid = server;
        server = null;
        await invalid?.close?.();
        throw new Error("control server did not bind an exact IPv4 loopback endpoint");
      }
    }
    return {
      started,
      control: {
        available: true,
        persistenceEnabled: state.persistenceEnabled,
        revision: state.revision,
        endpoint: `http://127.0.0.1:${server.port}/v1/persistence`,
        token: state.controlToken,
        launcherName: deps.launcherName,
      },
    };
  };

  const unregisterAndVerify = async () => {
    await deps.unregisterBackground();
    const inspected = await deps.inspectBackground();
    if (!isRecord(inspected) || inspected.registered !== false) {
      throw new Error("background controller remained registered after unregister");
    }
  };

  const disableTransition = async ({ lease, state, processIdentity }) => {
    const nonce = deps.newTransitionNonce();
    let journal = transitionJournal({
      operation: "disable-persistence",
      expectedRevision: state.revision,
      process: processIdentity,
      enabled: false,
      nonce,
      stage: "prepared",
    });
    try {
      await deps.writeJournal(journal, lease);
    } catch (error) {
      const observed = await deps.readTransition().catch(() => null);
      if (!sameTransition(observed, journal)) throw error;
      const recovered = await deps.recoverTransition({
        currentProcess: processIdentity,
      }, lease);
      const recoveredState = validateControlState(recovered.state);
      if (
        recoveredState.persistenceEnabled !== false ||
        recoveredState.revision !== state.revision + 1 ||
        recoveredState.lastTransitionNonce !== nonce
      ) {
        throw new Error("indeterminate disable journal did not recover exactly");
      }
      lastKnownState = recoveredState;
      return { state: recoveredState, session: recovered.session };
    }
    await deps.fault("after-journal");

    const updated = validateControlState(await deps.compareAndUpdate({
      expectedRevision: state.revision,
      mutate: (current) => ({
        ...current,
        persistenceEnabled: false,
        lastTransitionNonce: nonce,
      }),
    }, lease));
    lastKnownState = updated;
    await deps.fault("after-state-cas");

    journal = { ...journal, stage: "state-committed" };
    await deps.writeJournal(journal, lease);
    const session = sessionForState(updated, processIdentity, {
      keepUntilProcessExit: true,
    });
    await deps.writeSession(session, lease);
    await deps.fault("after-session-write");

    journal = { ...journal, stage: "session-committed" };
    await deps.writeJournal(journal, lease);
    await deps.clearJournal(nonce, lease);
    return { state: updated, session };
  };

  const compensateFailedEnable = async ({ lease, processIdentity, primaryError }) => {
    let enabledState;
    try {
      const recovered = await deps.recoverTransition({ currentProcess: processIdentity }, lease);
      enabledState = validateControlState(recovered.state);
      if (enabledState.persistenceEnabled !== true) {
        throw new Error("pending enable did not settle to enabled before compensation");
      }
      const compensated = await disableTransition({
        lease,
        state: enabledState,
        processIdentity,
      });
      await unregisterAndVerify();
      return new ControllerTransitionError(
        "BACKGROUND_START_FAILED",
        "后台控制器启动失败，常驻仍为关闭",
        compensated.state,
        { cause: primaryError },
      );
    } catch (compensationError) {
      try {
        await unregisterAndVerify();
      } catch (unregisterError) {
        compensationError = new AggregateError(
          [compensationError, unregisterError],
          "enable compensation and background unregister both failed",
        );
      }
      const authoritative = await deps.readState().catch(() => enabledState ?? lastKnownState);
      return new ControllerTransitionError(
        "BACKGROUND_START_FAILED",
        "后台控制器启动失败，补偿状态需要人工检查",
        isRecord(authoritative) ? authoritative : null,
        { cause: new AggregateError([primaryError, compensationError]) },
      );
    }
  };

  const prepareEnableTransition = async ({ lease, state, processIdentity, nonce }) => {
    await assertPortOwner(processIdentity);
    if (await deps.preflightEnable({ state, process: processIdentity }) !== true) {
      throw new Error("background enable preflight failed");
    }

    let journal = transitionJournal({
      operation: "enable-persistence",
      expectedRevision: state.revision,
      process: processIdentity,
      enabled: true,
      nonce,
      stage: "prepared",
    });
    let preparedPublished = false;
    try {
      try {
        await deps.writeJournal(journal, lease);
        preparedPublished = true;
      } catch (error) {
        const observed = await deps.readTransition().catch(() => null);
        if (!sameTransition(observed, journal)) throw error;
        preparedPublished = true;
        throw error;
      }
      const updated = validateControlState(await deps.compareAndUpdate({
        expectedRevision: state.revision,
        mutate: (current) => ({
          ...current,
          persistenceEnabled: true,
          lastTransitionNonce: nonce,
        }),
      }, lease));
      lastKnownState = updated;
      journal = { ...journal, stage: "state-committed" };
      await deps.writeJournal(journal, lease);

      const session = sessionForState(updated, processIdentity, {
        keepUntilProcessExit: false,
      });
      await deps.writeSession(session, lease);
      journal = { ...journal, stage: "session-committed" };
      await deps.writeJournal(journal, lease);

      return { journal, state: updated, session };
    } catch (error) {
      if (!preparedPublished) throw error;
      throw await compensateFailedEnable({
        lease,
        processIdentity,
        primaryError: error,
      });
    }
  };

  const finalizeEnableTransition = async ({ lease, expectedRevision, nonce, journal }) => {
    const current = validateControlState(await deps.readState());
    if (
      current.persistenceEnabled !== true ||
      current.revision !== expectedRevision + 1 ||
      current.lastTransitionNonce !== nonce
    ) {
      throw new Error("background ACK no longer matches the authoritative enabled state");
    }
    const pending = await deps.readTransition();
    if (pending !== null) {
      if (!sameTransition(pending, journal) || pending.stage !== "session-committed") {
        throw new Error("background ACK does not match the pending enable transition");
      }
      await deps.clearJournal(nonce, lease);
    }
    lastKnownState = current;
    return current;
  };

  const reconcile = async ({ lease, recovered = false, includeHealthCount = false }) => {
    const state = validateControlState(await deps.readState());
    lastKnownState = state;
    let session = await deps.readSession();
    const processIdentity = await probeProcess();

    if (!state.persistenceEnabled) {
      const retained = isRecord(session) &&
        session.keepUntilProcessExit === true &&
        processIdentity !== null &&
        sameProcessIdentity(session.process, processIdentity);
      if (!retained) {
        if (session !== null && (
          session.process !== null ||
          session.mode !== "native" ||
          session.keepUntilProcessExit === true
        )) {
          session = nativeSession();
          await deps.writeSession(session, lease);
        }
        await closeServer();
        await unregisterAndVerify();
        return result("unregister", "native", state);
      }
    }

    if (processIdentity === null) {
      if (!state.persistenceEnabled) {
        await closeServer();
        await unregisterAndVerify();
        return result("unregister", "native", state);
      }
      if (session?.process !== null && session?.process !== undefined) {
        session = nativeSession();
        await deps.writeSession(session, lease);
      }
      return result("wait-for-app", "native", state);
    }

    await assertPortOwner(processIdentity);
    const { control, started: serverStarted } = await ensureServer(state);
    const sameSessionProcess = isRecord(session) &&
      sameProcessIdentity(session.process, processIdentity);

    if (sameSessionProcess && session.mode === "paused") {
      return result("paused", "paused", state);
    }

    const expectedMode = state.selectedThemeId === NATIVE_THEME_ID ? "native" : "active";
    let action = sameSessionProcess && session.mode === expectedMode ? "repair" : "inject";
    let targetHealth = {
      selective: false,
      healthyTargets: [],
      repairTargets: null,
    };
    if (action === "repair" && !serverStarted && typeof deps.inspectSkin === "function") {
      let health;
      try {
        health = await deps.inspectSkin({
          expected: {
            themeId: state.selectedThemeId,
            mode: expectedMode,
            persistenceEnabled: state.persistenceEnabled,
            revision: state.revision,
          },
          process: processIdentity,
        });
      } catch (error) {
        let failedResults;
        try { failedResults = error?.results; } catch { failedResults = null; }
        if (!isRecord(failedResults)) throw error;
        health = { results: failedResults };
      }
      targetHealth = analyzeRendererHealth(health, state);
      if (targetHealth.repairTargets?.length === 0) {
        consecutiveFailures = 0;
        return result("idle", expectedMode, state, includeHealthCount
          ? {
            consecutiveFailures,
            ...(targetHealth.selective
              ? { healthyTargets: targetHealth.healthyTargets }
              : {}),
          }
          : undefined);
      }
    }

    const selectiveTargets = targetHealth.selective
      ? targetHealth.repairTargets
      : null;
    const injected = await deps.injectSkin({
      themeId: state.selectedThemeId,
      process: processIdentity,
      control,
      ...(selectiveTargets === null ? {} : { targetIds: selectiveTargets }),
    });
    consecutiveFailures = 0;
    session = sessionForState(state, processIdentity, {
      keepUntilProcessExit: !state.persistenceEnabled,
    });
    await deps.writeSession(session, lease);
    const targetResult = selectiveTargets === null
      ? null
      : validatedRepairResult(injected, selectiveTargets);
    return result(action, session.mode, state, includeHealthCount
      ? {
        consecutiveFailures,
        recovered,
        ...(targetResult === null
          ? {}
          : {
            healthyTargets: targetHealth.healthyTargets,
            repairedTargets: targetResult.repairedTargets,
            failedTargets: targetResult.failedTargets,
          }),
      }
      : undefined);
  };

  const runSafe = async (
    operation,
    action,
    { includeHealthCount = false, startupHandshake = null } = {},
  ) => {
    if (stopped) return result("error", "error", lastKnownState);
    try {
      return await deps.withLease(operation, action, { startupHandshake });
    } catch (error) {
      if (includeHealthCount) consecutiveFailures += 1;
      await safeLog(deps.logger, "error", "controller_failure", error);
      return result("error", "error", lastKnownState, includeHealthCount
        ? { consecutiveFailures }
        : undefined);
    }
  };

  const start = ({ startupHandshake = null } = {}) => runSafe("controller:start", async (lease) => {
    const processIdentity = await probeProcess();
    const recovered = await deps.recoverTransition({ currentProcess: processIdentity }, lease);
    if (recovered?.state !== null && recovered?.state !== undefined) {
      lastKnownState = validateControlState(recovered.state);
    }
    return reconcile({ lease, recovered: recovered?.recovered === true });
  }, { startupHandshake });

  const tick = () => runSafe(
    "controller:tick",
    (lease) => reconcile({ lease, includeHealthCount: true }),
    { includeHealthCount: true },
  );

  setPersistencePublic = async ({ expectedRevision, enabled, signal } = {}) => {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error("expectedRevision must be a non-negative safe integer");
    }
    if (typeof enabled !== "boolean") throw new Error("enabled must be boolean");
    if (signal?.aborted) throw signal.reason ?? new Error("persistence request aborted");

    let enableAttempt = null;
    try {
      const changed = await deps.withLease("controller:set-persistence", async (lease) => {
        const state = validateControlState(await deps.readState());
        lastKnownState = state;
        if (state.persistenceEnabled === enabled) {
          if (enabled) {
            const processIdentity = await probeProcess();
            await assertPortOwner(processIdentity);
            enableAttempt = {
              committedRevision: state.revision,
              nonce: deps.newTransitionNonce(),
              processIdentity,
              requireStateNonce: false,
            };
          }
          return { idempotent: true, state };
        }
        if (state.revision !== expectedRevision) throw new ControllerTransitionError(
          "REVISION_CONFLICT",
          `state revision is ${state.revision}`,
          state,
        );

        const processIdentity = await probeProcess();
        await assertPortOwner(processIdentity);
        if (enabled) {
          enableAttempt = {
            committedRevision: state.revision + 1,
            nonce: deps.newTransitionNonce(),
            processIdentity,
            requireStateNonce: true,
          };
          return prepareEnableTransition({
            lease,
            state,
            processIdentity,
            nonce: enableAttempt.nonce,
          });
        }
        return disableTransition({ lease, state, processIdentity });
      });

      if (!enabled) return publicState(changed.state);
      if (changed.idempotent === true) {
        if (deps.backgroundProcess) return publicState(changed.state);
        const inspected = await deps.inspectBackground({
          revision: changed.state.revision,
          transitionNonce: changed.state.lastTransitionNonce,
        });
        if (isRecord(inspected) && inspected.loaded === true) return publicState(changed.state);
      }

      const registration = await deps.registerBackground({
        pendingRevision: changed.idempotent === true
          ? changed.state.revision
          : changed.state.revision - 1,
        revision: changed.state.revision,
        transitionNonce: enableAttempt.nonce,
      });
      if (!isRecord(registration) || registration.registered !== true) {
        throw new Error("后台控制器注册失败");
      }
      const handshakeRequest = await deps.prepareBackgroundHandshake({
        revision: changed.state.revision,
        transitionNonce: enableAttempt.nonce,
      });
      await deps.wakeBackground({
        revision: changed.state.revision,
        transitionNonce: enableAttempt.nonce,
      });
      if (await deps.verifyBackgroundHandshake({
        revision: changed.state.revision,
        transitionNonce: enableAttempt.nonce,
        handshakeRequest,
      }) !== true) {
        throw new Error("后台控制器启动握手失败");
      }
      const inspected = await deps.inspectBackground({
        revision: changed.state.revision,
        transitionNonce: enableAttempt.nonce,
      });
      if (!isRecord(inspected) || inspected.registered !== true) {
        throw new Error("后台控制器未保持注册状态");
      }
      const finalized = await deps.withLease("controller:finalize-enable", async (lease) => {
        if (changed.idempotent === true) {
          const current = validateControlState(await deps.readState());
          if (
            current.persistenceEnabled !== true ||
            current.revision !== changed.state.revision
          ) {
            throw new Error("background repair ACK no longer matches the authoritative state");
          }
          return current;
        }
        return finalizeEnableTransition({
          lease,
          expectedRevision,
          nonce: enableAttempt.nonce,
          journal: changed.journal,
        });
      });
      return publicState(finalized);
    } catch (error) {
      if (enabled && enableAttempt !== null) {
        const authoritative = await deps.readState().catch(() => null);
        const exactUnacknowledgedEnable = isRecord(authoritative) &&
          authoritative.persistenceEnabled === true &&
          authoritative.revision === enableAttempt.committedRevision &&
          (
            enableAttempt.requireStateNonce !== true ||
            authoritative.lastTransitionNonce === enableAttempt.nonce
          );
        if (exactUnacknowledgedEnable) {
          let compensationError = null;
          let compensatedState = null;
          try {
            compensatedState = await deps.withLease(
              "controller:compensate-unacked-enable",
              async (lease) => {
                const current = validateControlState(await deps.readState());
                if (
                  current.persistenceEnabled !== true ||
                  current.revision !== enableAttempt.committedRevision ||
                  (
                    enableAttempt.requireStateNonce === true &&
                    current.lastTransitionNonce !== enableAttempt.nonce
                  )
                ) {
                  throw new Error("unacknowledged enable changed before compensation");
                }
                const compensated = await disableTransition({
                  lease,
                  state: current,
                  processIdentity: enableAttempt.processIdentity,
                });
                await unregisterAndVerify();
                return compensated.state;
              },
            );
          } catch (failure) {
            compensationError = failure;
            const afterFailure = await deps.readState().catch(() => null);
            if (isRecord(afterFailure) && afterFailure.persistenceEnabled === false) {
              compensatedState = afterFailure;
            }
          }
          const transitionError = new ControllerTransitionError(
            "BACKGROUND_START_FAILED",
            compensatedState?.persistenceEnabled === false
              ? "后台控制器启动失败，常驻仍为关闭"
              : "后台控制器启动失败，补偿状态需要人工检查",
            compensatedState,
            {
              cause: compensationError === null
                ? error
                : new AggregateError([error, compensationError]),
            },
          );
          await safeLog(
            deps.logger,
            "error",
            "persistence_transition_failed",
            transitionError,
          );
          throw transitionError;
        }
      }
      await safeLog(deps.logger, "error", "persistence_transition_failed", error);
      throw error;
    }
  };

  const pause = async () => deps.withLease("controller:pause", async (lease) => {
    const state = validateControlState(await deps.readState());
    lastKnownState = state;
    const processIdentity = await probeProcess();
    await assertPortOwner(processIdentity);
    const session = {
      schemaVersion: 1,
      mode: "paused",
      process: processIdentity,
      activeThemeId: null,
      keepUntilProcessExit: !state.persistenceEnabled,
    };
    await deps.writeSession(session, lease);
    await deps.removeSkin({ process: processIdentity });
    return { mode: "paused" };
  });

  const resume = async () => deps.withLease("controller:resume", async (lease) => {
    const state = validateControlState(await deps.readState());
    lastKnownState = state;
    const session = await deps.readSession();
    const processIdentity = await probeProcess();
    if (
      !isRecord(session) ||
      session.mode !== "paused" ||
      processIdentity === null ||
      !sameProcessIdentity(session.process, processIdentity)
    ) {
      throw new Error("resume requires the same verified process");
    }
    await assertPortOwner(processIdentity);
    const { control } = await ensureServer(state);
    await deps.injectSkin({
      themeId: state.selectedThemeId,
      process: processIdentity,
      control,
    });
    await deps.writeSession(sessionForState(state, processIdentity, {
      keepUntilProcessExit: !state.persistenceEnabled,
    }), lease);
    consecutiveFailures = 0;
    return { mode: state.selectedThemeId === NATIVE_THEME_ID ? "native" : "active" };
  });

  const restore = async () => deps.withLease("controller:restore", async (lease) => {
    let state = validateControlState(await deps.readState());
    lastKnownState = state;
    const processIdentity = await probeProcess();
    await assertPortOwner(processIdentity);
    if (state.persistenceEnabled) {
      state = (await disableTransition({ lease, state, processIdentity })).state;
    }
    await deps.writeSession(restoringSession(processIdentity), lease);
    await deps.removeSkin({ process: processIdentity });
    await unregisterAndVerify();
    await closeServer();
    return { mode: "restoring", persistenceEnabled: false };
  });

  const stop = async () => {
    stopped = true;
    await closeServer();
    return { stopped: true };
  };

  const api = Object.freeze({ start, tick, setPersistence: setPersistencePublic, pause, resume, restore, stop });
  return api;
}

export { ControllerTransitionError };
