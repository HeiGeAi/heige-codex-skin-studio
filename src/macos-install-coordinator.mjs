#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { resolveCodexApp, sameProcessIdentity } from "./codex-app.mjs";
import { DEFAULT_CDP_PORT, NATIVE_THEME_ID, resolveStudioPaths } from "./constants.mjs";
import { skinStatus } from "./injector.mjs";
import {
  acquireInstallTreeParticipantLock,
  finalizeInstallTree,
  prepareInstallTree,
  publishInstallTree,
  recoverInstallTreeUnderLock,
  recoverInstallTreePreparationUnderLock,
  rollbackInstallTree,
} from "./install-transaction.mjs";
import {
  clearMacosInstallJournal,
  createMacosInstallJournal,
  macosInstallJournalPath,
  readMacosInstallJournal,
  updateMacosInstallJournal,
} from "./macos-install-journal.mjs";
import * as launchAgent from "./macos-launch-agent.mjs";
import {
  acquireMacosLauncherInstallLock,
  finalizeMacosLauncher,
  prepareMacosLauncher,
  publishMacosLauncher,
  recoverMacosLauncherPreparationUnderLock,
  rollbackMacosLauncher,
} from "./macos-launcher.mjs";
import { ensureMacosStateRoot } from "./macos-state-root.mjs";
import { readMacCdpProcess } from "./lifecycle-helper.mjs";
import { withOperationLock } from "./operation-lock.mjs";
import {
  finalizeInstallStateParticipant,
  prepareInstallStateParticipant,
  publishInstallStateParticipant,
  rollbackInstallStateParticipant,
} from "./state-store.mjs";
import { loadTheme } from "./theme-schema.mjs";
import { listThemes } from "./theme-store.mjs";

const execFile = promisify(execFileCallback);
const RENDERER_GENERATION = /^[0-9a-f]{32}$/;
const THEME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function exactObject(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function rendererObservation(status) {
  try {
    const statuses = status?.statuses;
    const failed = status?.failed;
    const succeeded = status?.results?.succeeded;
    const resultFailed = status?.results?.failed;
    if (
      !Array.isArray(statuses)
      || statuses.length === 0
      || !Array.isArray(failed)
      || failed.length !== 0
      || !Array.isArray(succeeded)
      || succeeded.length !== statuses.length
      || !Array.isArray(resultFailed)
      || resultFailed.length !== 0
    ) return null;
    const ids = new Set();
    const renderers = [];
    const selections = [];
    for (let index = 0; index < succeeded.length; index += 1) {
      const entry = succeeded[index];
      const value = entry?.value;
      if (
        entry?.kind !== "main"
        || entry?.url !== "app://-/index.html"
        || typeof entry?.id !== "string"
        || entry.id.length === 0
        || entry.id.length > 512
        || ids.has(entry.id)
        || !exactObject(value, statuses[index])
        || value?.installed !== true
        || value?.menu !== true
        || typeof value?.persistenceEnabled !== "boolean"
        || !Number.isSafeInteger(value?.revision)
        || value.revision < 0
        || !(
          value.generation === null
          || (typeof value.generation === "string" && RENDERER_GENERATION.test(value.generation))
        )
      ) return null;
      let selection;
      if (
        value.mode === "native"
        && (value.themeId === null || value.themeId === NATIVE_THEME_ID)
      ) {
        selection = NATIVE_THEME_ID;
      } else if (
        value.mode === "active"
        && typeof value.themeId === "string"
        && THEME_ID.test(value.themeId)
      ) {
        selection = value.themeId;
      } else {
        return null;
      }
      ids.add(entry.id);
      renderers.push({ id: entry.id, generation: value.generation });
      selections.push(selection);
    }
    if (
      !selections.every((selection) => selection === selections[0])
    ) return null;
    renderers.sort((left, right) => left.id.localeCompare(right.id));
    return { renderers, selection: selections[0] };
  } catch {
    return null;
  }
}

export async function observeLegacyRendererSelection({
  readProcess,
  readStatus,
  validateThemeSelection,
} = {}) {
  if (
    typeof readProcess !== "function"
    || typeof readStatus !== "function"
    || typeof validateThemeSelection !== "function"
  ) {
    throw new TypeError("legacy renderer observation dependencies are required");
  }
  try {
    const before = await readProcess();
    const first = rendererObservation(await readStatus());
    const second = rendererObservation(await readStatus());
    const after = await readProcess();
    if (
      first === null
      || second === null
      || !sameProcessIdentity(before, after)
      || !exactObject(first, second)
    ) return null;
    if (
      first.selection !== NATIVE_THEME_ID
      && await validateThemeSelection(first.selection) !== true
    ) return null;
    return first.selection;
  } catch {
    return null;
  }
}

function assertDependencies(dependencies) {
  const names = [
    "acquireLauncherLock",
    "acquireTreeLock",
    "awaitExactReady",
    "checkpoint",
    "clearJournal",
    "createFreezeDescriptor",
    "createJournal",
    "finalizeFreeze",
    "finalizeFreezeRollback",
    "finalizeLauncher",
    "finalizeState",
    "finalizeTree",
    "inspectRendererSelection",
    "inspectServices",
    "prepareFreeze",
    "prepareLauncher",
    "prepareState",
    "prepareTree",
    "publishLauncher",
    "publishState",
    "publishTree",
    "readJournal",
    "recoverLauncherPreparation",
    "recoverStandaloneTree",
    "recoverTreePreparation",
    "rollbackFreeze",
    "rollbackLauncher",
    "rollbackState",
    "rollbackTree",
    "stopFreezeForRollback",
    "updateJournal",
    "verifyAckIdentity",
    "withCoordinatorLock",
  ];
  for (const name of names) {
    if (typeof dependencies?.[name] !== "function") {
      throw new TypeError(`macOS install dependency ${name} is required`);
    }
  }
  return dependencies;
}

async function update(deps, journal, changes) {
  return deps.updateJournal(journal, changes);
}

function exactReadyAck(ready, expectedState) {
  if (
    ready?.persistenceEnabled !== true ||
    ready?.revision !== expectedState.revision ||
    !Number.isSafeInteger(ready?.processIdentity?.pid) ||
    ready.processIdentity.pid <= 0 ||
    typeof ready.processIdentity.startedAt !== "string" ||
    ready.processIdentity.startedAt.length === 0
  ) throw new Error("macOS install did not receive the exact controller readiness ACK");
  return {
    persistenceEnabled: true,
    revision: ready.revision,
    processIdentity: { ...ready.processIdentity },
  };
}

async function finishCommittedInstall(deps, journal) {
  const persistent = journal.stateParticipant.afterState.persistenceEnabled === true;
  await deps.finalizeState(journal.stateParticipant);
  await deps.checkpoint("state-finalized", journal);
  await deps.finalizeLauncher(journal.launcherParticipant);
  await deps.checkpoint("launcher-finalized", journal);
  await deps.finalizeTree(journal.treeParticipant);
  await deps.checkpoint("tree-finalized", journal);
  await deps.finalizeFreeze(journal.freezeParticipant, {
    removeFrozenServices: !persistent,
  });
  await deps.checkpoint("freeze-finalized", journal);
  await deps.clearJournal(journal);
  return { recovered: true, decision: "commit" };
}

async function undoUndecidedInstall(deps, journal, { controllerQuiesced = false } = {}) {
  if (journal.phase === "freeze-rollback-restored") {
    await deps.finalizeFreezeRollback(journal.freezeParticipant);
    await deps.checkpoint("freeze-rollback-finalized", journal);
    await deps.clearJournal(journal);
    return { recovered: true, decision: "rollback" };
  }

  if (
    controllerQuiesced !== true &&
    journal.activation === "controller" &&
    journal.freezeParticipant !== null
  ) {
    await deps.stopFreezeForRollback(journal.freezeParticipant);
  }

  if (journal.stateParticipant !== null) {
    await deps.rollbackState(journal.stateParticipant);
  }
  if (journal.launcherParticipant !== null) {
    await deps.rollbackLauncher(journal.launcherParticipant);
  } else {
    await deps.recoverLauncherPreparation();
  }
  if (journal.treeParticipant !== null) {
    await deps.rollbackTree(journal.treeParticipant);
  } else {
    await deps.recoverTreePreparation();
  }
  if (journal.freezeParticipant !== null) {
    await deps.rollbackFreeze(journal.freezeParticipant);
    journal = await update(deps, journal, { phase: "freeze-rollback-restored" });
    await deps.checkpoint("freeze-rollback-restored", journal);
    await deps.finalizeFreezeRollback(journal.freezeParticipant);
    await deps.checkpoint("freeze-rollback-finalized", journal);
  }
  await deps.clearJournal(journal);
  return { recovered: true, decision: "rollback" };
}

export async function recoverMacosInstallTransaction(dependencies) {
  const deps = assertDependencies(dependencies);
  let journal = await deps.readJournal();
  if (journal === null) return { recovered: false };
  let controllerQuiesced = false;
  if (journal.decision === "undecided") {
    if (journal.activation === "controller" && journal.freezeParticipant !== null) {
      await deps.stopFreezeForRollback(journal.freezeParticipant);
      controllerQuiesced = true;
    }
    journal = await update(deps, journal, {
      decision: "rollback",
      phase: "rollback-decided",
    });
  }
  return journal.decision === "commit"
    ? finishCommittedInstall(deps, journal)
    : undoUndecidedInstall(deps, journal, { controllerQuiesced });
}

async function createFreshInstall(input, deps, launcherLock) {
  let journal = await deps.createJournal({
    transactionId: deps.randomUUID(),
    sourceRoot: input.sourceRoot,
    targetRoot: input.targetRoot,
    home: input.home,
    stateRoot: input.stateRoot,
  });
  try {
    await deps.checkpoint("skeleton", journal);
    const services = await deps.inspectServices();
    const inspectRendererSelection = async () => {
      try {
        return await deps.inspectRendererSelection({ port: input.port });
      } catch {
        return null;
      }
    };
    const tree = await deps.prepareTree({
      sourceRoot: input.sourceRoot,
      targetRoot: input.targetRoot,
      transactionId: journal.transactionId,
    });
    journal = await update(deps, journal, {
      phase: "tree-prepared",
      treeParticipant: tree,
    });
    await deps.checkpoint("tree-prepared", journal);

    const launcher = await deps.prepareLauncher({
      home: input.home,
      installRoot: input.targetRoot,
      validationRoot: input.sourceRoot,
      transactionId: journal.transactionId,
      applicationsPriorExisted: launcherLock.applicationsPriorExisted,
    });
    journal = await update(deps, journal, {
      phase: "launcher-prepared",
      launcherParticipant: launcher,
    });
    await deps.checkpoint("launcher-prepared", journal);

    const observedLegacyThemeId = await inspectRendererSelection();
    const state = await deps.prepareState({
      transactionId: journal.transactionId,
      legacyAgentLoaded: services.legacyLoaded === true,
      ...(observedLegacyThemeId !== null || services.legacyLoaded === true
        ? { observedLegacyThemeId }
        : {}),
    });
    journal = await update(deps, journal, {
      phase: "state-prepared",
      stateParticipant: state,
    });
    await deps.checkpoint("state-prepared", journal);

    const outerTransaction = {
      journalPath: deps.journalPath,
      transactionId: journal.transactionId,
    };
    const freezeDescriptor = await deps.createFreezeDescriptor({ outerTransaction });
    journal = await update(deps, journal, {
      phase: "freeze-intent",
      freezeParticipant: freezeDescriptor,
    });
    await deps.checkpoint("freeze-intent", journal);
    const frozen = await deps.prepareFreeze({ outerTransaction });
    if (
      frozen?.transaction !== null &&
      !exactObject(frozen?.transaction, freezeDescriptor)
    ) throw new Error("stable service freeze returned a mismatched transaction descriptor");
    if (
      typeof frozen?.legacyLoadedBefore === "boolean"
      && frozen.legacyLoadedBefore !== (services.legacyLoaded === true)
    ) throw new Error("legacy watchdog loaded state changed before service freeze");
    const frozenRendererSelection = await inspectRendererSelection();
    if (frozenRendererSelection !== observedLegacyThemeId) {
      throw new Error("renderer selection changed before service freeze completed");
    }
    journal = await update(deps, journal, { phase: "services-frozen" });
    await deps.checkpoint("services-frozen", journal);

    await deps.publishTree(tree);
    journal = await update(deps, journal, { phase: "tree-published" });
    await deps.checkpoint("tree-published", journal);

    await deps.publishLauncher(launcher);
    journal = await update(deps, journal, { phase: "launcher-published" });
    await deps.checkpoint("launcher-published", journal);

    await deps.publishState(state);
    journal = await update(deps, journal, { phase: "state-published" });
    await deps.checkpoint("state-published", journal);

    if (state.afterState.persistenceEnabled !== true) {
      journal = await update(deps, journal, {
        activation: "none",
        phase: "activation-skipped",
      });
      await deps.checkpoint("activation-skipped", journal);
    } else {
      journal = await update(deps, journal, {
        activation: "controller",
        phase: "activation-planned",
      });
      await deps.checkpoint("activation-planned", journal);
      const ready = await deps.awaitExactReady({
        expectedState: state.afterState,
        outerTransaction,
        port: input.port,
      });
      const ack = exactReadyAck(ready, state.afterState);
      journal = await update(deps, journal, { phase: "service-prepared" });
      await deps.checkpoint("service-prepared", journal);
      journal = await update(deps, journal, {
        ack,
        phase: "ready-acked",
      });
      await deps.checkpoint("ready-acked", journal);
      if (!await deps.verifyAckIdentity(ack.processIdentity)) {
        throw new Error("macOS install controller ACK changed before commit");
      }
    }

    journal = await update(deps, journal, {
      decision: "commit",
      phase: "commit-decided",
    });
    await deps.checkpoint("after-commit-decision", journal);
    await finishCommittedInstall(deps, journal);
    return {
      decision: "commit",
      persistenceEnabled: state.afterState.persistenceEnabled,
      recovered: false,
      targetRoot: input.targetRoot,
    };
  } catch (primaryError) {
    if (primaryError?.simulatedHardCrash === true) throw primaryError;
    try {
      await recoverMacosInstallTransaction(deps);
    } catch (recoveryError) {
      const error = new AggregateError(
        [primaryError, recoveryError],
        `macOS install failed and recovery did not finish: ${primaryError.message}`,
      );
      error.code = "MACOS_INSTALL_ROLLBACK_FAILED";
      throw error;
    }
    throw primaryError;
  }
}

export async function coordinateMacosInstall(input, dependencies) {
  const deps = assertDependencies(dependencies);
  return withMacosInstallParticipantLocks(deps, async ({ launcherLock }) => {
    await recoverMacosInstallTransaction(deps);
    return createFreshInstall(input, deps, launcherLock);
  });
}

async function withMacosInstallParticipantLocks(deps, action) {
  return deps.withCoordinatorLock(async () => {
    const treeLock = await deps.acquireTreeLock();
    let launcherLock;
    let primaryError = null;
    try {
      const initial = await deps.readJournal();
      if (initial === null) await deps.recoverStandaloneTree();
      launcherLock = await deps.acquireLauncherLock({ recover: initial === null });
      return await action({ initial, launcherLock });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const releaseErrors = [];
      if (launcherLock) {
        await launcherLock.release().catch((error) => releaseErrors.push(error));
      }
      await treeLock.release().catch((error) => releaseErrors.push(error));
      if (releaseErrors.length > 0) {
        if (primaryError !== null) {
          throw new AggregateError(
            [primaryError, ...releaseErrors],
            "macOS install and participant lock release both failed",
          );
        }
        throw new AggregateError(releaseErrors, "macOS participant lock release failed");
      }
    }
  });
}

export async function coordinateMacosInstallRecovery(dependencies) {
  const deps = assertDependencies(dependencies);
  return withMacosInstallParticipantLocks(
    deps,
    () => recoverMacosInstallTransaction(deps),
  );
}

async function readPosixProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const { stdout } = await execFile("/bin/ps", ["-p", String(pid), "-o", "pid=,lstart="]);
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(stdout);
    return match && Number(match[1]) === pid
      ? { pid, startedAt: match[2] }
      : null;
  } catch (error) {
    if (error?.code === 1) return null;
    throw error;
  }
}

async function operationLockOptions(stateRoot) {
  const identity = await readPosixProcessIdentity(process.pid);
  if (identity === null) throw new Error("cannot read the current installer process identity");
  return {
    identity,
    lockPath: join(stateRoot, "operation.lock"),
    readProcessIdentity: readPosixProcessIdentity,
    stateRoot,
  };
}

export async function productionMacosInstallDependencies({
  home,
  sourceRoot,
  targetRoot,
  stateRoot,
}) {
  const journalPath = macosInstallJournalPath(stateRoot);
  const statePath = join(stateRoot, "state.json");
  const stateLock = await operationLockOptions(stateRoot);
  const coordinatorRoot = join(stateRoot, "macos-install-operation");
  const coordinatorLock = await operationLockOptions(coordinatorRoot);
  const withStateLease = (operation, action) => withOperationLock({
    ...stateLock,
    operation,
  }, action);
  const themes = async () => listThemes({
    roots: [join(sourceRoot, "themes"), join(stateRoot, "themes")],
  });
  const fullyValidatedThemeExists = async (themeId) => {
    const selected = (await themes()).find((theme) => theme.id === themeId);
    if (selected === undefined) return false;
    try {
      const loaded = await loadTheme(selected.path);
      return loaded.manifest.id === themeId;
    } catch {
      return false;
    }
  };
  const dependencies = {
    journalPath,
    randomUUID,
    checkpoint: async () => {},
    withCoordinatorLock: (action) => withOperationLock({
      ...coordinatorLock,
      operation: "install:macos-coordinator",
    }, action),
    readJournal: () => withStateLease(
      "install:macos-read-journal",
      (lease) => readMacosInstallJournal(journalPath, { lease }),
    ),
    createJournal: (input) => withStateLease(
      "install:macos-create-journal",
      (lease) => createMacosInstallJournal({ ...input, journalPath, lease }),
    ),
    updateJournal: (journal, changes) => withStateLease(
      "install:macos-update-journal",
      (lease) => updateMacosInstallJournal(journalPath, journal, changes, { lease }),
    ),
    clearJournal: (journal) => withStateLease(
      "install:macos-clear-journal",
      (lease) => clearMacosInstallJournal(journalPath, journal, { lease }),
    ),
    recoverStandaloneTree: () => recoverInstallTreeUnderLock({ targetRoot }),
    acquireTreeLock: () => acquireInstallTreeParticipantLock({ targetRoot }),
    acquireLauncherLock: ({ recover }) => acquireMacosLauncherInstallLock({ home, recover }),
    prepareTree: prepareInstallTree,
    publishTree: publishInstallTree,
    rollbackTree: rollbackInstallTree,
    finalizeTree: finalizeInstallTree,
    recoverTreePreparation: () => recoverInstallTreePreparationUnderLock({ targetRoot }),
    prepareLauncher: prepareMacosLauncher,
    publishLauncher: publishMacosLauncher,
    rollbackLauncher: rollbackMacosLauncher,
    finalizeLauncher: finalizeMacosLauncher,
    recoverLauncherPreparation: () => recoverMacosLauncherPreparationUnderLock({ home }),
    prepareState: (input) => withStateLease(
      "install:macos-prepare-state",
      (lease) => prepareInstallStateParticipant({
        ...input,
        statePath,
        lease,
        legacyThemePath: join(home, ".codex", "heige-codex-skin-persist", "theme"),
        themeExists: fullyValidatedThemeExists,
      }),
    ),
    publishState: (participant) => withStateLease(
      "install:macos-publish-state",
      (lease) => publishInstallStateParticipant(participant, { lease }),
    ),
    rollbackState: (participant) => withStateLease(
      "install:macos-rollback-state",
      (lease) => rollbackInstallStateParticipant(participant, { lease }),
    ),
    finalizeState: (participant) => withStateLease(
      "install:macos-finalize-state",
      (lease) => finalizeInstallStateParticipant(participant, { lease }),
    ),
    inspectServices: async () => {
      const [controller, legacy] = await Promise.all([
        launchAgent.inspectLaunchAgent(),
        launchAgent.inspectLegacyWatchdog(),
      ]);
      return {
        controllerLoaded: controller.loaded === true,
        controllerPresent: controller.plistExists === true,
        legacyLoaded: legacy.loaded === true,
        legacyPresent: legacy.plistExists === true,
      };
    },
    inspectRendererSelection: ({ port }) => observeLegacyRendererSelection({
      readProcess: async () => {
        const app = await resolveCodexApp({ home, platform: "darwin" });
        return readMacCdpProcess({ appPath: app.appPath, port });
      },
      readStatus: () => skinStatus({ port }),
      validateThemeSelection: fullyValidatedThemeExists,
    }),
    createFreezeDescriptor: launchAgent.createStableServiceFreezeDescriptor,
    prepareFreeze: launchAgent.prepareStableServiceFreeze,
    stopFreezeForRollback: async (descriptor) => {
      if (typeof launchAgent.stopStableServiceFreezeForRollback !== "function") {
        throw new Error("stable service two-phase rollback API is unavailable");
      }
      return launchAgent.stopStableServiceFreezeForRollback(descriptor);
    },
    rollbackFreeze: launchAgent.rollbackStableServiceFreeze,
    finalizeFreezeRollback: launchAgent.finalizeStableServiceFreezeRollback,
    finalizeFreeze: (descriptor, options) => launchAgent.finalizeStableServiceFreeze(
      descriptor,
      options,
    ),
    verifyAckIdentity: async (expected) => {
      const observed = await launchAgent.inspectLaunchAgentProcessIdentity();
      return observed?.pid === expected?.pid && observed?.startedAt === expected?.startedAt;
    },
    awaitExactReady: async ({ expectedState, outerTransaction, port }) => {
      const pending = execFile(process.execPath, [
        join(targetRoot, "src", "cli.mjs"),
        "set-persistence",
        "true",
        "--revision",
        String(expectedState.revision),
        "--port",
        String(port),
        "--install-authorization-stdin",
      ], {
        timeout: 15_000,
        maxBuffer: 256 * 1024,
      });
      // 授权 JSON 走 stdin 管道，避免控制 token 经环境变量暴露给同用户进程。
      pending.child.stdin.end(JSON.stringify({
        role: "macos-install-ready-foreground",
        transactionId: outerTransaction.transactionId,
        journalPath: outerTransaction.journalPath,
        expectedRevision: expectedState.revision,
        expectedControlToken: expectedState.controlToken,
      }));
      const { stdout } = await pending;
      try { return JSON.parse(stdout); } catch (cause) {
        throw new Error("controller readiness command returned invalid JSON", { cause });
      }
    },
  };
  return assertDependencies(dependencies);
}

export async function runProductionMacosInstall({ sourceRoot, targetRoot, port = DEFAULT_CDP_PORT }) {
  if (process.platform !== "darwin") throw new Error("macOS install coordinator requires Darwin");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("macOS install port is invalid");
  }
  const home = launchAgent.trustedUserHome();
  const paths = resolveStudioPaths({ home, platform: "darwin" });
  await ensureMacosStateRoot(paths.stateRoot);
  const dependencies = await productionMacosInstallDependencies({
    home,
    sourceRoot,
    targetRoot,
    stateRoot: paths.stateRoot,
  });
  return coordinateMacosInstall({
    home,
    port,
    sourceRoot,
    stateRoot: paths.stateRoot,
    targetRoot,
  }, dependencies);
}

export async function runProductionMacosInstallRecovery({
  sourceRoot,
  targetRoot,
  port = DEFAULT_CDP_PORT,
}) {
  if (process.platform !== "darwin") throw new Error("macOS install coordinator requires Darwin");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("macOS install port is invalid");
  }
  const home = launchAgent.trustedUserHome();
  const paths = resolveStudioPaths({ home, platform: "darwin" });
  await ensureMacosStateRoot(paths.stateRoot);
  const dependencies = await productionMacosInstallDependencies({
    home,
    sourceRoot,
    targetRoot,
    stateRoot: paths.stateRoot,
  });
  return coordinateMacosInstallRecovery(dependencies);
}

function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("invalid macOS install arguments");
    const name = flag.slice(2);
    if (
      !new Set(["source", "target", "port", "recovery-only"]).has(name) ||
      Object.hasOwn(options, name)
    ) {
      throw new Error(`unknown or duplicate macOS install option: ${flag}`);
    }
    options[name] = value;
  }
  if (!options.source || !options.target) throw new Error("macOS install requires --source and --target");
  const port = options.port === undefined ? DEFAULT_CDP_PORT : Number(options.port);
  if (options["recovery-only"] !== undefined && options["recovery-only"] !== "true") {
    throw new Error("macOS install --recovery-only accepts only true");
  }
  return {
    sourceRoot: options.source,
    targetRoot: options.target,
    port,
    recoveryOnly: options["recovery-only"] === "true",
  };
}

function isMainEntry() {
  const entry = process.argv[1];
  if (!entry) return false;
  let real = entry;
  try { real = realpathSync(entry); } catch {}
  return pathToFileURL(real).href === import.meta.url;
}

if (isMainEntry()) {
  const input = parseCli(process.argv.slice(2));
  const run = input.recoveryOnly
    ? runProductionMacosInstallRecovery
    : runProductionMacosInstall;
  run(input)
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`HeiGe Codex Skin Studio：${error.message}\n`);
      process.exitCode = 1;
    });
}
