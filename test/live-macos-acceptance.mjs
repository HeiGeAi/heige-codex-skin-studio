import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { CdpSession, fetchRendererTargets } from "../src/cdp-client.mjs";
import {
  listCodexProcesses,
  parseMacPsTable,
  resolveCodexApp,
  sameProcessIdentity,
} from "../src/codex-app.mjs";
import {
  inspectMacApp,
  macAppRepairInternals,
  recoverMacAppRepair,
  repairMacApp,
} from "../src/macos-app-repair.mjs";
import {
  coordinateMacosInstall,
  productionMacosInstallDependencies,
  runProductionMacosInstall,
  runProductionMacosInstallRecovery,
} from "../src/macos-install-coordinator.mjs";
import { resolveStudioPaths } from "../src/constants.mjs";
import { requestNormalQuit } from "../src/lifecycle-helper.mjs";
import {
  inspectLaunchAgent,
  inspectLaunchAgentProcessIdentity,
  inspectTrustedProductionRuntime,
} from "../src/macos-launch-agent.mjs";
import {
  MACOS_LAUNCHER_NAME,
  renderMacosLauncherExecutable,
  renderMacosLauncherPlist,
} from "../src/macos-launcher.mjs";
import { readProcessIdentity as readPosixProcessIdentity } from "../src/process-identity.mjs";
import { withOperationLock } from "../src/operation-lock.mjs";
import { readStudioState } from "../src/state-store.mjs";
import { classifyCodexTargets } from "../src/target-classifier.mjs";
import { listThemes } from "../src/theme-store.mjs";

const execFile = promisify(execFileCallback);
const PORT = 9341;
const LEGACY_LABEL = "com.heige.codex-skin-watchdog";
const CONTROLLER_LABEL = "com.heige.codex-skin-controller";
const MAX_PLIST_BYTES = 256 * 1024;
const MAX_THEME_ID_BYTES = 256;
const BUNDLE_IDENTIFIER = "com.openai.codex";
const TEAM_IDENTIFIER = "2DC432GLL2";
const LIVE_SEQUENCE = "rollback-then-clean";
const SHA256 = /^[a-f0-9]{64}$/;
const STAGE_NAME = /^\.ChatGPT\.app\.heige-official-stage-[A-Za-z0-9._-]+$/;
const RUN_STAMP = /^[0-9]{8}T[0-9]{6}Z$/;
const DROPPED_EVIDENCE_KEYS = /^(?:authorization|controlEndpoint|controlToken|env|environment|rawLog|stderr|stdout|token)$/i;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_REPAIR_JOURNAL = "app-repair.json";
const INTERNAL_WORKER_FLAG = "--heige-live-worker";
const MAX_WORKER_REQUEST_BYTES = 16 * 1024;
const TRANSACTION_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const TRANSACTION_UUID_RE = new RegExp(`^${TRANSACTION_UUID}$`);
const LIVE_JOURNAL_PHASES = new Set(["prepared", "running"]);

export function validateLiveWorkerRequest(value, {
  home = userInfo().homedir,
  repositoryRoot = REPOSITORY_ROOT,
} = {}) {
  if (value?.operation === "app-repair-sigkill") {
    const keys = [
      "boundary",
      "currentAppPath",
      "expectedBeforeAsarSha256",
      "expectedOfficialAsarSha256",
      "journalPath",
      "operation",
      "schemaVersion",
      "stagedAppPath",
    ];
    if (!exactKeys(value, keys) || value.schemaVersion !== 1) {
      throw new Error("app repair worker request fields are invalid");
    }
    if (value.boundary !== "after-target-published") {
      throw new Error("app repair worker boundary is invalid");
    }
    if (value.currentAppPath !== "/Applications/ChatGPT.app") {
      throw new Error("app repair worker currentAppPath is invalid");
    }
    canonicalAbsolute(value.stagedAppPath, "worker stagedAppPath");
    if (dirname(value.stagedAppPath) !== "/Applications" || !STAGE_NAME.test(basename(value.stagedAppPath))) {
      throw new Error("app repair worker stagedAppPath is invalid");
    }
    const expectedJournal = join(
      home,
      "Library",
      "Application Support",
      "HeiGeCodexSkinStudio",
      APP_REPAIR_JOURNAL,
    );
    if (value.journalPath !== expectedJournal) throw new Error("app repair worker journalPath is invalid");
    digest(value.expectedBeforeAsarSha256, "worker current app.asar");
    digest(value.expectedOfficialAsarSha256, "worker official app.asar");
    return Object.freeze({ ...value });
  }
  if (value?.operation === "install-sigkill") {
    const keys = ["boundary", "operation", "port", "schemaVersion", "sourceRoot", "targetRoot"];
    if (!exactKeys(value, keys) || value.schemaVersion !== 1) {
      throw new Error("install worker request fields are invalid");
    }
    if (value.boundary !== "services-frozen") throw new Error("install worker boundary is invalid");
    if (value.sourceRoot !== repositoryRoot) throw new Error("install worker sourceRoot is invalid");
    if (value.targetRoot !== join(home, ".codex", "heige-codex-skin-studio")) {
      throw new Error("install worker targetRoot is invalid");
    }
    if (value.port !== PORT) throw new Error("install worker port is invalid");
    return Object.freeze({ ...value });
  }
  throw new Error("live worker operation is invalid");
}

function killCurrentWorker() {
  process.kill(process.pid, "SIGKILL");
  return new Promise(() => {});
}

export async function runLiveWorker(request, {
  home = userInfo().homedir,
  repositoryRoot = REPOSITORY_ROOT,
  killSelf = killCurrentWorker,
} = {}) {
  if (
    process.env.HEIGE_RUN_LIVE_MACOS !== "1"
    || process.env.HEIGE_LIVE_SEQUENCE !== LIVE_SEQUENCE
  ) throw new Error("live worker is missing the two mutation gates");
  request = validateLiveWorkerRequest(request, { home, repositoryRoot });
  if (typeof killSelf !== "function") throw new TypeError("killSelf is required");
  if (request.operation === "app-repair-sigkill") {
    await repairMacApp({
      currentAppPath: request.currentAppPath,
      stagedAppPath: request.stagedAppPath,
      journalPath: request.journalPath,
      expectedBeforeAsarSha256: request.expectedBeforeAsarSha256,
      expectedOfficialAsarSha256: request.expectedOfficialAsarSha256,
      hooks: {
        [request.boundary]: async () => killSelf(),
      },
    });
    throw new Error("app repair SIGKILL boundary returned unexpectedly");
  }
  const paths = resolveStudioPaths({ home, platform: "darwin" });
  const dependencies = await productionMacosInstallDependencies({
    home,
    sourceRoot: request.sourceRoot,
    targetRoot: request.targetRoot,
    stateRoot: paths.stateRoot,
  });
  dependencies.checkpoint = async (boundary) => {
    if (boundary === request.boundary) await killSelf();
  };
  await coordinateMacosInstall({
    home,
    port: request.port,
    sourceRoot: request.sourceRoot,
    stateRoot: paths.stateRoot,
    targetRoot: request.targetRoot,
  }, dependencies);
  throw new Error("install SIGKILL boundary was not reached");
}

function decodeWorkerRequest(encoded) {
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > MAX_WORKER_REQUEST_BYTES * 2) {
    throw new Error("live worker request encoding is invalid");
  }
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length === 0 || bytes.length > MAX_WORKER_REQUEST_BYTES || bytes.toString("base64url") !== encoded) {
    throw new Error("live worker request encoding is not canonical");
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch (cause) {
    throw new Error("live worker request JSON is invalid", { cause });
  }
}

export async function spawnLiveWorker(request, {
  spawnImpl = spawn,
  timeoutMs = 120_000,
  home = userInfo().homedir,
  repositoryRoot = REPOSITORY_ROOT,
} = {}) {
  request = validateLiveWorkerRequest(request, { home, repositoryRoot });
  if (typeof spawnImpl !== "function") throw new TypeError("spawnImpl is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 10 * 60_000) {
    throw new TypeError("worker timeout is invalid");
  }
  const encoded = Buffer.from(JSON.stringify(request)).toString("base64url");
  const child = spawnImpl(process.execPath, [fileURLToPath(import.meta.url), INTERNAL_WORKER_FLAG, encoded], {
    detached: false,
    stdio: "ignore",
    env: {
      HOME: home,
      LANG: process.env.LANG ?? "en_US.UTF-8",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      HEIGE_RUN_LIVE_MACOS: "1",
      HEIGE_LIVE_SEQUENCE: LIVE_SEQUENCE,
    },
  });
  if (!child || typeof child.once !== "function" || typeof child.kill !== "function") {
    throw new Error("live worker could not be spawned");
  }
  let timer;
  try {
    return await new Promise((resolveExit, rejectExit) => {
      let timedOut = false;
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.once("error", rejectExit);
      child.once("exit", (code, signal) => {
        if (timedOut) {
          const error = new Error("live worker timed out; parent observed its exit after SIGKILL");
          error.code = "LIVE_WORKER_TIMEOUT";
          error.workerExit = { code, signal };
          rejectExit(error);
          return;
        }
        resolveExit({ code, signal });
      });
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function runCrashRecoveryCycle({
  label,
  spawnCrashWorker,
  recover,
  verifyRestored,
  clean,
  assertRecovery,
}) {
  if (typeof label !== "string" || label.length === 0) throw new TypeError("crash cycle label is required");
  for (const [name, value] of Object.entries({
    spawnCrashWorker,
    recover,
    verifyRestored,
    clean,
    assertRecovery,
  })) {
    if (typeof value !== "function") throw new TypeError(`crash cycle ${name} is required`);
  }
  let exit;
  let workerError = null;
  try { exit = await spawnCrashWorker(); } catch (error) { workerError = error; }
  let recovery;
  let restored;
  try {
    recovery = await recover();
    if (assertRecovery(recovery) !== true) throw new Error(`${label} recovery result is not rollback`);
    restored = await verifyRestored();
    if (restored?.exact !== true) throw new Error(`${label} pre-state was not restored exactly`);
  } catch (recoveryError) {
    throw new AggregateError(
      workerError === null ? [recoveryError] : [workerError, recoveryError],
      `${label} crash recovery did not finish`,
    );
  }
  if (workerError !== null) throw workerError;
  if (exit?.code !== null || exit?.signal !== "SIGKILL") {
    throw new Error(`${label} worker did not exit by SIGKILL`);
  }
  const cleanResult = await clean();
  return {
    status: "PASS",
    sigkillObserved: true,
    recovery,
    restored,
    clean: cleanResult,
  };
}

function pass(value, message) {
  if (value !== true) throw new Error(message);
}

export async function runOptionOneLifecycle({
  adapters,
  initialPersistenceEnabled,
  initialThemeId,
}) {
  if (typeof initialPersistenceEnabled !== "boolean") {
    throw new TypeError("initialPersistenceEnabled must be boolean");
  }
  if (initialPersistenceEnabled !== true) {
    throw new Error("live option 1 acceptance requires revalidated loaded legacy persistence=true");
  }
  if (typeof initialThemeId !== "string" || initialThemeId.length === 0) {
    throw new TypeError("initialThemeId is required");
  }
  const names = [
    "launchNativeAndAssert",
    "launchSessionAndAssert",
    "pauseAndAssertStable",
    "assertPersistentBackground",
    "quitAndAssertControllerGone",
    "readState",
    "reloadSameProcess",
    "requireMenu",
    "restoreAndAssertNative",
    "resumeAndAssert",
    "setMenuPersistence",
  ];
  for (const name of names) {
    if (typeof adapters?.[name] !== "function") throw new TypeError(`lifecycle adapter ${name} is required`);
  }
  const checks = {};
  const initialMenu = await adapters.requireMenu({
    persistenceEnabled: initialPersistenceEnabled,
    themeId: initialThemeId,
  });
  pass(initialMenu.checked === initialPersistenceEnabled, "menu switch does not match initial persistence");
  checks.menuSwitch = "PASS";

  const disabled = await adapters.setMenuPersistence(false);
  pass(disabled.checked === false && disabled.revision > initialMenu.revision, "menu off ACK is invalid");
  let state = await adapters.readState();
  pass(state.persistenceEnabled === false && state.revision === disabled.revision, "off ACK is not authoritative");
  checks.offAck = "PASS";

  const reloaded = await adapters.reloadSameProcess();
  pass(
    reloaded.sameProcess === true
      && reloaded.menuPresent === true
      && reloaded.themeId === initialThemeId,
    "renderer reload lost process, menu, or theme",
  );
  checks.sameProcessReload = "PASS";

  const quit = await adapters.quitAndAssertControllerGone();
  pass(quit.controllerGone === true, "controller remained after normal Codex exit");
  const native = await adapters.launchNativeAndAssert();
  pass(native.cdpOwner === null && native.menuPresent === false, "native restart retained CDP or injection");
  checks.nativeRestart = "PASS";

  const session = await adapters.launchSessionAndAssert();
  pass(
    session.cdpOwned === true
      && session.menuPresent === true
      && session.themeId === initialThemeId
      && session.persistenceEnabled === false
      && session.controllerRegistered === false,
    "launcher was not session-only",
  );
  checks.launcherSessionOnly = "PASS";

  const enabled = await adapters.setMenuPersistence(true);
  pass(enabled.checked === true && enabled.revision > disabled.revision, "explicit persistence enable ACK is invalid");
  state = await adapters.readState();
  pass(state.persistenceEnabled === true && state.revision === enabled.revision, "explicit enable is not authoritative");
  const background = await adapters.assertPersistentBackground({ revision: enabled.revision });
  pass(
    background.controlReachable === true
      && background.exactProcess === true
      && background.ephemeralExited === true,
    "persistent background did not own the reachable control endpoint",
  );
  checks.launcherReenable = "PASS";

  const paused = await adapters.pauseAndAssertStable();
  pass(
    paused.paused === true && paused.sameProcess === true && paused.themeId === initialThemeId,
    "pause did not remain stable for the same process and theme across ticks",
  );
  const resumed = await adapters.resumeAndAssert();
  pass(
    resumed.active === true && resumed.sameProcess === true && resumed.themeId === initialThemeId,
    "resume did not restore the same process and theme",
  );
  checks.pauseResume = "PASS";

  const restored = await adapters.restoreAndAssertNative();
  pass(restored.native === true && restored.persistenceEnabled === false, "restore did not return to native mode");
  checks.restoreNative = "PASS";

  const secondSession = await adapters.launchSessionAndAssert();
  pass(
    secondSession.cdpOwned === true
      && secondSession.menuPresent === true
      && secondSession.themeId === initialThemeId
      && secondSession.persistenceEnabled === false
      && secondSession.controllerRegistered === false,
    "second launcher run was not session-only",
  );
  if (initialPersistenceEnabled) {
    const finalEnabled = await adapters.setMenuPersistence(true);
    pass(finalEnabled.checked === true, "final persistence restore did not ACK");
    const finalBackground = await adapters.assertPersistentBackground({ revision: finalEnabled.revision });
    pass(
      finalBackground.controlReachable === true
        && finalBackground.exactProcess === true
        && finalBackground.ephemeralExited === true,
      "final persistence background is not authoritative",
    );
  }
  state = await adapters.readState();
  pass(state.persistenceEnabled === initialPersistenceEnabled, "final persistence differs from the initial choice");
  checks.finalPreference = "PASS";
  return {
    status: "PASS",
    checks,
    finalPersistenceEnabled: state.persistenceEnabled,
    finalRevision: state.revision,
  };
}

function markdownReport(result) {
  const lines = [
    "# macOS live acceptance",
    "",
    `Status: ${result.status}`,
    `Recorded: ${result.completedAt ?? result.failedAt ?? new Date().toISOString()}`,
  ];
  if (result.preflight) {
    lines.push(
      "",
      "## Preflight",
      "",
      `- mutation count: ${result.preflight.mutationCount}`,
      `- renderer origin: ${result.preflight.rendererOrigin}`,
      `- exact CDP owner: ${result.preflight.portOwnerMatchesCodex}`,
      `- current app: ${result.preflight.app?.current?.classification ?? "unknown"}`,
      `- official stage trusted: ${result.preflight.app?.stage?.identity?.signatureValid === true}`,
      `- legacy watchdog loaded: ${result.preflight.legacy?.loaded === true}`,
      `- legacy controller loaded: ${result.preflight.existingController?.loaded === true}`,
      `- legacy controller running: ${result.preflight.existingController?.running === true}`,
    );
  }
  if (result.rollback) {
    lines.push(
      "",
      "## Rollback proof",
      "",
      `- status: ${result.rollback.status}`,
      `- pre-migration behavior restored: ${result.rollback.preMigrationBehaviorRestored === true}`,
      `- migration committed during proof: ${result.rollback.migrationCommitted === true}`,
      `- app repair boundary: ${result.rollback.appRepair?.sigkillBoundary ?? "unknown"}`,
      `- app repair restored: ${result.rollback.appRepair?.restored?.exact === true}`,
      `- installer boundary: ${result.rollback.installer?.sigkillBoundary ?? "unknown"}`,
      `- installer restored: ${result.rollback.installer?.restored?.exact === true}`,
      `- legacy controller restored exactly: ${result.rollback.installer?.restored?.exactLegacyController === true}`,
    );
  }
  if (result.clean) {
    lines.push(
      "",
      "## Clean migration",
      "",
      `- status: ${result.clean.status}`,
      `- app repair: ${result.clean.appRepair}`,
      `- installer: ${result.clean.installer}`,
      `- final persistence enabled: ${result.clean.finalPersistenceEnabled}`,
      `- final state revision: ${result.clean.finalRevision}`,
    );
  }
  lines.push("", "## Checks", "");
  const checks = {
    ...(result.rollback?.checks ?? {}),
    ...(result.clean?.checks ?? {}),
    ...(result.checks ?? {}),
  };
  for (const [name, value] of Object.entries(checks)) lines.push(`- ${name}: ${value}`);
  if (result.failure) {
    lines.push("", "## Failure", "", `- code: ${result.failure.code}`, `- message: ${result.failure.message}`);
  }
  if (result.recovery) {
    lines.push("", "## Recovery", "", `- status: ${result.recovery.status ?? "UNKNOWN"}`);
    for (const [name, action] of Object.entries(result.recovery.actions ?? {})) {
      lines.push(`- ${name}: ${action?.status ?? "UNKNOWN"}`);
    }
    for (const failure of result.recovery.failures ?? []) {
      lines.push(`- failure ${failure.code ?? "UNKNOWN"}: ${failure.message ?? "unknown"}`);
    }
  }
  lines.push("", "Windows Store: 待验证", "");
  return lines.join("\n");
}

export async function writeAcceptanceEvidence({
  result,
  resultPath,
  reportPath,
  write = atomicWriteAcceptanceEvidence,
}) {
  if (typeof write !== "function") throw new TypeError("evidence writer is required");
  const report = await write(reportPath, markdownReport(result), { privateDirectory: false });
  const finalResult = {
    ...result,
    reportWritten: true,
    evidence: {
      ...(result.evidence ?? {}),
      report: { bytes: report.bytes, sha256: report.sha256 },
    },
  };
  const json = await write(resultPath, finalResult, { privateDirectory: true });
  return {
    ...finalResult,
    evidence: {
      ...finalResult.evidence,
      result: { bytes: json.bytes, sha256: json.sha256 },
    },
  };
}

function safeFailure(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "LIVE_ACCEPTANCE_FAILED",
    message: typeof error?.message === "string" ? error.message : String(error),
  };
}

export async function executeLiveAcceptance({
  execute,
  recover,
  writeEvidence = writeAcceptanceEvidence,
  resultPath,
  reportPath,
  baseResult = {},
}) {
  for (const [name, value] of Object.entries({ execute, recover, writeEvidence })) {
    if (typeof value !== "function") throw new TypeError(`${name} is required`);
  }
  try {
    const completed = await execute();
    const result = {
      ...baseResult,
      ...completed,
      status: "PASS",
      completedAt: new Date().toISOString(),
    };
    return await writeEvidence({ result, resultPath, reportPath });
  } catch (primaryError) {
    let recovery;
    let recoveryError = null;
    try { recovery = await recover(primaryError); } catch (error) {
      recoveryError = error;
      recovery = { status: "FAIL", failure: safeFailure(error) };
    }
    const failed = {
      ...baseResult,
      status: "FAIL",
      failedAt: new Date().toISOString(),
      failure: safeFailure(primaryError),
      recovery,
    };
    let evidenceError = null;
    try { await writeEvidence({ result: failed, resultPath, reportPath }); } catch (error) {
      evidenceError = error;
    }
    const reportedRecoveryErrors = recovery?.status === "PASS"
      ? []
      : (recovery?.failures ?? [recovery?.failure ?? {
        code: "LIVE_RECOVERY_INCOMPLETE",
        message: "live recovery returned a non-PASS status",
      }]).map((failure) => {
        const error = new Error(failure?.message ?? "live recovery failed");
        error.code = failure?.code ?? "LIVE_RECOVERY_INCOMPLETE";
        return error;
      });
    if (recoveryError !== null || evidenceError !== null || reportedRecoveryErrors.length > 0) {
      throw new AggregateError(
        [
          primaryError,
          ...(recoveryError ? [recoveryError] : reportedRecoveryErrors),
          ...(evidenceError ? [evidenceError] : []),
        ],
        "live acceptance failed and recovery or evidence was incomplete",
      );
    }
    throw primaryError;
  }
}

export async function recordPreMutationFailure({
  error,
  preflight,
  resultPath,
  reportPath,
  reason = "pre-mutation validation failed before any state change",
  writeEvidence = writeAcceptanceEvidence,
}) {
  if (!(error instanceof Error)) throw new TypeError("pre-mutation failure error is required");
  if (typeof writeEvidence !== "function") throw new TypeError("pre-mutation evidence writer is required");
  const result = {
    ...(preflight === undefined ? {} : { preflight }),
    status: "FAIL",
    failedAt: new Date().toISOString(),
    failure: safeFailure(error),
    recovery: { status: "NOT_STARTED", reason },
  };
  try {
    return await writeEvidence({ result, resultPath, reportPath });
  } catch (evidenceError) {
    throw new AggregateError(
      [error, evidenceError],
      "live acceptance pre-mutation validation failed and evidence was incomplete",
    );
  }
}

export async function withLiveAcceptanceSingleFlight(action, {
  home = userInfo().homedir,
  identityReader = (pid) => readPosixProcessIdentity(pid, { platform: "darwin" }),
  lock = withOperationLock,
} = {}) {
  if (typeof action !== "function") throw new TypeError("live acceptance action is required");
  if (typeof identityReader !== "function" || typeof lock !== "function") {
    throw new TypeError("live acceptance lock dependencies are required");
  }
  const identity = await identityReader(process.pid);
  if (identity?.pid !== process.pid || typeof identity.startedAt !== "string" || identity.startedAt.length === 0) {
    throw new Error("live acceptance parent process identity is unavailable");
  }
  const stateRoot = join(
    home,
    "Library",
    "Application Support",
    "HeiGeCodexSkinStudio",
    "live-acceptance-operation",
  );
  return lock({
    identity,
    lockPath: join(stateRoot, "operation.lock"),
    operation: "live-acceptance:rollback-then-clean",
    readProcessIdentity: identityReader,
    stateRoot,
  }, action);
}

function liveAcceptanceJournalPath(home = userInfo().homedir) {
  return join(
    home,
    "Library",
    "Application Support",
    "HeiGeCodexSkinStudio",
    "live-acceptance-operation",
    "live-migration.json",
  );
}

function validateLiveAcceptanceJournal(value) {
  const keys = [
    "createdAt",
    "initialPersistenceEnabled",
    "initialThemeId",
    "operation",
    "phase",
    "schemaVersion",
    "sequence",
    "transactionId",
    "updatedAt",
  ];
  if (
    !exactKeys(value, keys)
    || value.schemaVersion !== 1
    || value.operation !== "live-macos-acceptance"
    || value.sequence !== LIVE_SEQUENCE
    || !TRANSACTION_UUID_RE.test(value.transactionId)
    || !LIVE_JOURNAL_PHASES.has(value.phase)
    || value.initialPersistenceEnabled !== true
    || typeof value.initialThemeId !== "string"
    || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.initialThemeId)
    || !Number.isFinite(Date.parse(value.createdAt))
    || !Number.isFinite(Date.parse(value.updatedAt))
  ) throw new Error("live acceptance durable journal is invalid");
  return Object.freeze({ ...value });
}

export async function readLiveAcceptanceJournal({ home = userInfo().homedir } = {}) {
  const path = liveAcceptanceJournalPath(home);
  let snapshot;
  try { snapshot = await regularSnapshot(path, "live acceptance journal", 64 * 1024); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (snapshot.mode !== 0o600) throw new Error("live acceptance journal must be mode 0600");
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes)); } catch (cause) {
    throw new Error("live acceptance journal JSON is invalid", { cause });
  }
  return validateLiveAcceptanceJournal(value);
}

async function writeLiveAcceptanceJournal(journal, { home = userInfo().homedir } = {}) {
  journal = validateLiveAcceptanceJournal(journal);
  await atomicWriteAcceptanceEvidence(liveAcceptanceJournalPath(home), journal, {
    home,
    privateDirectory: true,
  });
  return journal;
}

async function prepareLiveAcceptanceJournal({ initialPersistenceEnabled, initialThemeId }, options = {}) {
  if (await readLiveAcceptanceJournal(options) !== null) {
    throw new Error("an unfinished live acceptance journal already exists");
  }
  const now = new Date().toISOString();
  return writeLiveAcceptanceJournal({
    schemaVersion: 1,
    operation: "live-macos-acceptance",
    sequence: LIVE_SEQUENCE,
    transactionId: randomUUID(),
    phase: "prepared",
    initialPersistenceEnabled,
    initialThemeId,
    createdAt: now,
    updatedAt: now,
  }, options);
}

async function advanceLiveAcceptanceJournal(journal, phase, options = {}) {
  journal = validateLiveAcceptanceJournal(journal);
  if (journal.phase !== "prepared" || phase !== "running") {
    throw new Error("live acceptance journal phase transition is invalid");
  }
  const current = await readLiveAcceptanceJournal(options);
  if (current === null || JSON.stringify(current) !== JSON.stringify(journal)) {
    throw new Error("live acceptance journal identity changed before phase advance");
  }
  return writeLiveAcceptanceJournal({
    ...journal,
    phase,
    updatedAt: new Date().toISOString(),
  }, options);
}

async function clearLiveAcceptanceJournal(journal, { home = userInfo().homedir } = {}) {
  journal = validateLiveAcceptanceJournal(journal);
  const current = await readLiveAcceptanceJournal({ home });
  if (current === null || current.transactionId !== journal.transactionId) {
    throw new Error("live acceptance journal identity changed before clear");
  }
  const path = liveAcceptanceJournalPath(home);
  await unlink(path);
  await syncDirectory(dirname(path));
}

function canonicalAbsolute(path, label) {
  if (
    typeof path !== "string"
    || !isAbsolute(path)
    || path.includes("\0")
    || normalize(path) !== path
  ) throw new Error(`${label} must be a canonical absolute path`);
  return path;
}

function digest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function parseLiveConfiguration(env = process.env) {
  const enabled = env.HEIGE_RUN_LIVE_MACOS === "1";
  if (!enabled) return Object.freeze({ enabled: false, mode: "disabled" });
  const preflightOnly = env.HEIGE_LIVE_PREFLIGHT_ONLY === "1";
  if (!preflightOnly && env.HEIGE_LIVE_SEQUENCE !== LIVE_SEQUENCE) {
    throw new Error(`live mutation requires HEIGE_LIVE_SEQUENCE=${LIVE_SEQUENCE}`);
  }
  const explicit = [
    env.HEIGE_LIVE_STAGE_APP,
    env.HEIGE_LIVE_EXPECTED_CURRENT_ASAR_SHA256,
    env.HEIGE_LIVE_EXPECTED_STAGE_ASAR_SHA256,
  ];
  const explicitCount = explicit.filter((value) => value !== undefined).length;
  if (explicitCount !== 0 && explicitCount !== explicit.length) {
    throw new Error("explicit stage mode requires stage path and both app.asar digests");
  }
  if (explicitCount === explicit.length) {
    canonicalAbsolute(explicit[0], "HEIGE_LIVE_STAGE_APP");
    digest(explicit[1], "HEIGE_LIVE_EXPECTED_CURRENT_ASAR_SHA256");
    digest(explicit[2], "HEIGE_LIVE_EXPECTED_STAGE_ASAR_SHA256");
  }
  return Object.freeze({
    enabled: true,
    mode: preflightOnly ? "preflight" : "mutation",
    sequence: preflightOnly ? (env.HEIGE_LIVE_SEQUENCE ?? LIVE_SEQUENCE) : LIVE_SEQUENCE,
    explicitStagePath: explicitCount === explicit.length ? explicit[0] : null,
    expectedCurrentAsarSha256: explicitCount === explicit.length ? explicit[1] : null,
    expectedStageAsarSha256: explicitCount === explicit.length ? explicit[2] : null,
    resultPath: env.HEIGE_LIVE_RESULT_JSON ?? null,
    reportPath: env.HEIGE_LIVE_REPORT_MD ?? null,
  });
}

function redactString(value, { home, secrets, preserveNewlines }) {
  let clean = preserveNewlines
    ? value.replace(/\0/g, "")
    : value.replace(/[\r\n\t\0]+/g, " ");
  if (home) clean = clean.split(home).join("$HOME");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) clean = clean.split(secret).join("[REDACTED]");
  }
  return clean
    .replace(/\b(authorization|control[ _-]?token|x-heige-control-token|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/[^\s)\]}>]*/gi, "[REDACTED_LOOPBACK_ENDPOINT]");
}

function sanitizeEvidence(value, context, seen = new WeakSet(), preserveNewlines = false) {
  if (typeof value === "string") {
    return redactString(value, { ...context, preserveNewlines });
  }
  if (value === null || ["boolean", "number"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeEvidence(entry, context, seen));
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!DROPPED_EVIDENCE_KEYS.test(key)) result[key] = sanitizeEvidence(entry, context, seen);
  }
  seen.delete(value);
  return result;
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function atomicWriteAcceptanceEvidence(path, value, {
  home = userInfo().homedir,
  secrets = [],
  privateDirectory = false,
} = {}) {
  canonicalAbsolute(path, "evidence path");
  const parent = dirname(path);
  let parentBefore = null;
  try { parentBefore = await lstat(parent); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error("evidence directory must be a real directory");
  }
  if (await realpath(parent) !== parent) {
    throw new Error("evidence directory has a symlink ancestor or canonical drift");
  }
  if (parentBefore === null || privateDirectory) await chmod(parent, 0o700);
  let destination = null;
  try { destination = await lstat(path); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (destination !== null && (destination.isSymbolicLink() || !destination.isFile())) {
    throw new Error("evidence destination must be absent or a regular file");
  }
  const context = { home, secrets: [...secrets] };
  const sanitized = sanitizeEvidence(value, context, new WeakSet(), typeof value === "string");
  const body = typeof sanitized === "string"
    ? `${sanitized.trimEnd()}\n`
    : `${JSON.stringify(sanitized, null, 2)}\n`;
  const temporary = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await syncDirectory(parent);
    const after = await lstat(parent);
    if (after.dev !== parentInfo.dev || after.ino !== parentInfo.ino || await realpath(parent) !== parent) {
      throw new Error("evidence directory identity changed during atomic write");
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { path, bytes: Buffer.byteLength(body), sha256: sha256(Buffer.from(body)) };
}

export function validateLiveOutputPaths(configuration, home = userInfo().homedir) {
  const resultRoot = join(home, "Library", "Application Support", "HeiGeCodexSkinStudio", "live-acceptance");
  if (configuration.mode === "preflight" && (configuration.resultPath !== null || configuration.reportPath !== null)) {
    throw new Error("live preflight is strictly read-only and does not accept evidence output paths");
  }
  if (configuration.mode === "mutation" && (!configuration.resultPath || !configuration.reportPath)) {
    throw new Error("live mutation requires both result and report paths");
  }
  if (configuration.resultPath !== null) {
    canonicalAbsolute(configuration.resultPath, "live result path");
    const runDirectory = dirname(configuration.resultPath);
    if (
      dirname(runDirectory) !== resultRoot
      || !RUN_STAMP.test(basename(runDirectory))
      || basename(configuration.resultPath) !== "result.json"
    ) throw new Error("live result path is outside the fixed acceptance run allowlist");
  }
  if (configuration.reportPath !== null) {
    canonicalAbsolute(configuration.reportPath, "live report path");
    const expected = join(REPOSITORY_ROOT, "docs", "release", "2026-07-16-macos-verification.md");
    if (configuration.reportPath !== expected) {
      throw new Error("live report path is outside the fixed repository allowlist");
    }
  }
}

function assertAppIdentity(identity, label) {
  if (identity?.bundleIdentifier !== BUNDLE_IDENTIFIER) {
    throw new Error(`${label} bundle identifier mismatch`);
  }
  digest(identity.executableSha256, `${label} executable SHA-256`);
  digest(identity.asarSha256, `${label} app.asar SHA-256`);
  return identity;
}

export async function selectOfficialStage({
  currentAppPath = "/Applications/ChatGPT.app",
  candidatePaths,
  explicitStagePath = null,
  expectedCurrentAsarSha256 = null,
  expectedStageAsarSha256 = null,
  inspectApp = inspectMacApp,
} = {}) {
  canonicalAbsolute(currentAppPath, "current app path");
  const currentIdentity = assertAppIdentity(await inspectApp(currentAppPath), "current app");
  if (expectedCurrentAsarSha256 !== null
    && currentIdentity.asarSha256 !== digest(expectedCurrentAsarSha256, "expected current app.asar")) {
    throw new Error("current app.asar digest drift");
  }
  const candidates = [...new Set(candidatePaths ?? [])];
  if (explicitStagePath !== null) {
    canonicalAbsolute(explicitStagePath, "explicit stage path");
    if (dirname(explicitStagePath) !== "/Applications" || !STAGE_NAME.test(basename(explicitStagePath))) {
      throw new Error("explicit stage path is outside the production allowlist");
    }
    if (expectedStageAsarSha256 === null) {
      throw new Error("explicit stage requires its expected app.asar digest");
    }
    candidates.splice(0, candidates.length, explicitStagePath);
  }
  const trusted = [];
  for (const path of candidates) {
    canonicalAbsolute(path, "stage candidate path");
    if (dirname(path) !== "/Applications" || !STAGE_NAME.test(basename(path))) continue;
    let identity;
    try { identity = assertAppIdentity(await inspectApp(path), "official stage"); } catch { continue; }
    if (identity.signatureValid === true && identity.teamIdentifier === TEAM_IDENTIFIER) {
      trusted.push({ path, identity });
    }
  }
  if (trusted.length !== 1) throw new Error("expected exactly one trusted official stage");
  if (expectedStageAsarSha256 !== null
    && trusted[0].identity.asarSha256 !== digest(expectedStageAsarSha256, "expected stage app.asar")) {
    throw new Error("stage app.asar digest drift");
  }
  const officialCurrent = currentIdentity.signatureValid === true
    && currentIdentity.teamIdentifier === TEAM_IDENTIFIER;
  return {
    current: {
      path: currentAppPath,
      classification: officialCurrent ? "official" : "polluted",
      identity: currentIdentity,
    },
    stage: trusted[0],
  };
}

export function createProductionRepairAdapter({
  repair = repairMacApp,
  recover = recoverMacAppRepair,
} = {}) {
  if (typeof repair !== "function" || typeof recover !== "function") {
    throw new TypeError("repair adapter requires production repair and recovery functions");
  }
  return Object.freeze({
    repair: (input) => repair(input),
    recover: (input) => recover(input),
  });
}

export function createProductionInstallAdapter({ install = runProductionMacosInstall } = {}) {
  if (typeof install !== "function") throw new TypeError("install adapter requires the production coordinator");
  return Object.freeze({ install: (input) => install(input) });
}

const MENU_SNAPSHOT_EXPRESSION = `(() => {
  const snapshot = {};
  const toggle = document.querySelector('[data-heige-role="persistence-switch"]');
  const helper = document.querySelector('[data-heige-role="persistence-helper"]');
  const confirmation = document.querySelector('[data-heige-role="persistence-confirmation"]');
  const state = globalThis.__heigeCodexSkin?.getPersistenceState?.() ?? null;
  snapshot.origin = location.origin;
  snapshot.switchPresent = toggle !== null;
  snapshot.role = toggle?.getAttribute('role') ?? null;
  snapshot.checked = toggle?.getAttribute('aria-checked') === 'true';
  snapshot.pending = state?.pending ?? null;
  snapshot.revision = state?.revision ?? null;
  snapshot.helper = helper?.textContent ?? null;
  snapshot.confirmationHidden = confirmation?.hidden ?? null;
  snapshot.menuPresent = document.getElementById('heige-codex-skin-menu') !== null;
  snapshot.themeId = document.documentElement.dataset.heigeCodexSkin ?? null;
  snapshot.generation = globalThis.__heigeCodexSkin?.generation ?? null;
  return snapshot;
})()`;

export async function inspectPersistenceMenu(session, { allowPending = false } = {}) {
  const snapshot = await session.evaluate(MENU_SNAPSHOT_EXPRESSION);
  if (
    snapshot?.origin !== "app://-"
    || snapshot.switchPresent !== true
    || snapshot.menuPresent !== true
    || snapshot.role !== "switch"
    || typeof snapshot.checked !== "boolean"
    || !Number.isSafeInteger(snapshot.revision)
    || snapshot.revision < 0
    || (allowPending ? typeof snapshot.pending !== "boolean" : snapshot.pending !== false)
  ) throw new Error("persistence menu identity or authoritative state is invalid");
  const helper = snapshot.helper ?? "";
  if (
    !helper.includes("下次启动恢复原生界面")
    || !helper.includes("HeiGe 皮肤启动器")
    || !helper.includes("恢复本次皮肤")
    || !helper.includes("下次仍常驻")
    || !helper.includes("重新打开此开关")
  ) {
    throw new Error("persistence menu reminder is missing the approved recovery guidance");
  }
  return snapshot;
}

async function openMainRendererSession() {
  const classified = classifyCodexTargets(await fetchRendererTargets(PORT));
  const targets = classified.filter(({ kind }) => kind === "main");
  if (targets.length !== 1) throw new Error(`expected exactly one main renderer, observed ${targets.length}`);
  const session = new CdpSession(targets[0].webSocketDebuggerUrl);
  await session.open();
  const origin = await session.evaluate("location.origin");
  if (origin !== "app://-") {
    session.close();
    throw new Error("main renderer origin is not app://-");
  }
  return session;
}

async function waitForPersistenceMenu({
  persistenceEnabled,
  themeId,
} = {}) {
  return waitForValue(async () => {
    const session = await openMainRendererSession();
    try { return await inspectPersistenceMenu(session); } finally { session.close(); }
  }, (snapshot) => (
    snapshot.checked === persistenceEnabled
    && snapshot.themeId === themeId
  ), { label: "verified persistence menu" });
}

async function rendererSkinSnapshot() {
  const session = await openMainRendererSession();
  try {
    return await session.evaluate(`(() => ({
      origin: location.origin,
      menuPresent: document.getElementById('heige-codex-skin-menu') !== null,
      stylePresent: document.getElementById('heige-codex-skin-style') !== null,
      themeId: document.documentElement.dataset.heigeCodexSkin ?? null
    }))()`);
  } finally { session.close(); }
}

export async function setPersistenceViaMenu(session, enabled, {
  timeoutMs = 5_000,
  pollIntervalMs = 50,
} = {}) {
  if (typeof enabled !== "boolean") throw new TypeError("enabled must be boolean");
  const before = await inspectPersistenceMenu(session);
  if (before.checked === enabled) return before;
  const activated = await session.evaluate(`(() => {
    const element = document.querySelector('[data-heige-role="persistence-switch"]');
    if (!(element instanceof HTMLButtonElement) || element.disabled) return false;
    element.click();
    return true;
  })()`);
  if (activated !== true) throw new Error("persistence switch activation failed");
  if (!enabled) {
    const confirmation = await inspectPersistenceMenu(session);
    if (confirmation.confirmationHidden !== false) {
      throw new Error("persistence off confirmation did not open");
    }
    const confirmed = await session.evaluate(`(() => {
      const element = document.querySelector('[data-heige-role="persistence-confirm"]');
      if (!(element instanceof HTMLButtonElement) || element.disabled) return false;
      element.click();
      return true;
    })()`);
    if (confirmed !== true) throw new Error("persistence off confirmation activation failed");
  }
  const deadline = Date.now() + timeoutMs;
  let last;
  do {
    last = await inspectPersistenceMenu(session, { allowPending: true });
    if (last.checked === enabled && last.revision > before.revision && last.pending === false) return last;
    if (pollIntervalMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, pollIntervalMs));
  } while (Date.now() < deadline);
  throw new Error(`persistence menu did not ACK revision ${before.revision + 1} or newer`);
}

function exactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function regularSnapshot(path, label, maxBytes) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size <= 0 || info.size > maxBytes) {
    throw new Error(`${label} 必须是非空普通文件且不得是符号链接`);
  }
  const canonical = await realpath(path);
  if (canonical !== resolve(path)) throw new Error(`${label} 必须是 canonical path`);
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    after.dev !== info.dev
    || after.ino !== info.ino
    || after.size !== info.size
    || after.mtimeMs !== info.mtimeMs
    || bytes.byteLength !== info.size
  ) throw new Error(`${label} 在读取期间发生变化`);
  return { bytes, mode: info.mode & 0o777, sha256: sha256(bytes) };
}

async function optionalRegularFingerprint(path, label, maxBytes = 16 * 1024 * 1024) {
  try {
    const snapshot = await regularSnapshot(path, label, maxBytes);
    return { present: true, mode: snapshot.mode, sha256: snapshot.sha256, bytes: snapshot.bytes.length };
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false };
    throw error;
  }
}

export async function snapshotOwnedTree(path, {
  maxEntries = 10_000,
  maxTotalBytes = 1024 * 1024 * 1024,
  maxFileBytes = 512 * 1024 * 1024,
} = {}) {
  canonicalAbsolute(path, "owned tree path");
  let root;
  try { root = await lstat(path); } catch (error) {
    if (error?.code === "ENOENT") return { present: false };
    throw error;
  }
  if (root.isSymbolicLink() || !root.isDirectory() || await realpath(path) !== path) {
    throw new Error("owned tree root must be a canonical real directory");
  }
  const entries = [];
  let totalBytes = 0;
  const walk = async (current) => {
    const names = (await readdir(current)).sort();
    for (const name of names) {
      const child = join(current, name);
      const info = await lstat(child);
      if (info.isSymbolicLink()) throw new Error("owned tree contains a symbolic link");
      const relativePath = relative(path, child);
      if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
        throw new Error("owned tree traversal escaped its root");
      }
      if (entries.length >= maxEntries) throw new Error("owned tree exceeds the entry limit");
      if (info.isDirectory()) {
        entries.push({ kind: "directory", mode: info.mode & 0o777, path: relativePath });
        await walk(child);
      } else if (info.isFile()) {
        if (info.size > maxFileBytes) throw new Error("owned tree file exceeds the size limit");
        const snapshot = await regularSnapshot(child, "owned tree file", maxFileBytes);
        totalBytes += snapshot.bytes.length;
        if (totalBytes > maxTotalBytes) throw new Error("owned tree exceeds the aggregate size limit");
        entries.push({
          kind: "file",
          mode: snapshot.mode,
          path: relativePath,
          sha256: snapshot.sha256,
          size: snapshot.bytes.length,
        });
      } else {
        throw new Error("owned tree contains an unsupported filesystem entry");
      }
    }
  };
  await walk(path);
  const manifest = JSON.stringify({ rootMode: root.mode & 0o777, entries });
  const after = await lstat(path);
  if (after.dev !== root.dev || after.ino !== root.ino || !after.isDirectory()) {
    throw new Error("owned tree root changed while snapshotting");
  }
  return {
    present: true,
    rootMode: root.mode & 0o777,
    entryCount: entries.length,
    totalBytes,
    sha256: sha256(Buffer.from(manifest)),
  };
}

async function serviceFingerprint({ home, uid, label, run = execFile }) {
  const plistPath = join(home, "Library", "LaunchAgents", `${label}.plist`);
  const plist = await optionalRegularFingerprint(plistPath, `${label} plist`, MAX_PLIST_BYTES);
  return {
    ...plist,
    loaded: await labelLoaded(uid, label, run),
  };
}

function regexLiteral(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function operationLockTemporaryPattern(base) {
  return new RegExp(
    `^${base}(?:`
    + `\\.released\\.${TRANSACTION_UUID}\\.staging\\.${TRANSACTION_UUID}`
    + `|\\.heartbeat\\.${TRANSACTION_UUID}\\.tmp\\.${TRANSACTION_UUID}`
    + `|\\.staging\\.(?:\\d+\\.)?${TRANSACTION_UUID}`
    + `|\\.checkpoint\\.\\d+\\.${TRANSACTION_UUID})$`,
  );
}

async function artifactFingerprint(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (info.isDirectory()) return { kind: "directory", ...await snapshotOwnedTree(path) };
  if (info.isFile()) {
    const snapshot = await regularSnapshot(path, label, 16 * 1024 * 1024);
    return {
      kind: "file",
      bytes: snapshot.bytes.length,
      mode: snapshot.mode,
      sha256: snapshot.sha256,
    };
  }
  throw new Error(`${label} has an unsupported filesystem kind`);
}

async function optionalArtifactFingerprint(path, label) {
  try { return { present: true, ...await artifactFingerprint(path, label) }; } catch (error) {
    if (error?.code === "ENOENT") return { present: false };
    throw error;
  }
}

async function scanStrictArtifacts(parent, patterns, label) {
  let info;
  try { info = await lstat(parent); } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(parent) !== resolve(parent)) {
    throw new Error(`${label} parent must be a canonical real directory`);
  }
  const names = (await readdir(parent)).filter((name) => patterns.some((pattern) => pattern.test(name))).sort();
  const entries = [];
  for (const name of names) {
    entries.push({
      name,
      fingerprint: await artifactFingerprint(join(parent, name), `${label} ${name}`),
    });
  }
  return entries;
}

export async function snapshotKnownInstallArtifacts({
  home = userInfo().homedir,
  targetRoot = join(home, ".codex", "heige-codex-skin-studio"),
} = {}) {
  canonicalAbsolute(home, "artifact home");
  canonicalAbsolute(targetRoot, "artifact targetRoot");
  const targetParent = dirname(targetRoot);
  const targetName = regexLiteral(basename(targetRoot));
  const applications = join(home, "Applications");
  const launcherName = regexLiteral(`${MACOS_LAUNCHER_NAME}.app`);
  const stateRoot = join(home, "Library", "Application Support", "HeiGeCodexSkinStudio");
  const exactPaths = {
    treePreparationIntent: `${targetRoot}.install-prepare.json`,
    treeStandaloneJournal: `${targetRoot}.install-journal.json`,
    launcherPreparationIntent: join(home, ".heige-codex-skin-launcher-prepare.json"),
    launcherStandaloneJournal: join(applications, ".heige-codex-skin-launcher-transaction.json"),
    coordinatorJournal: join(stateRoot, "macos-install.json"),
    freezeJournal: join(stateRoot, "stable-service-freeze.json"),
    migrationJournal: join(stateRoot, "launch-agent-migration.json"),
  };
  const exact = {};
  for (const [name, path] of Object.entries(exactPaths)) {
    exact[name] = await optionalArtifactFingerprint(path, name);
  }
  const dynamic = {
    tree: await scanStrictArtifacts(targetParent, [
      new RegExp(`^${targetName}\\.(?:staged|backup)\\.${TRANSACTION_UUID}$`),
      operationLockTemporaryPattern(`${targetName}\\.install\\.lock`),
      new RegExp(`^${targetName}\\.install-(?:prepare|journal)\\.json\\.next\\.\\d+\\.${TRANSACTION_UUID}$`),
    ], "tree transaction artifact"),
    launcher: await scanStrictArtifacts(applications, [
      new RegExp(`^${launcherName}\\.(?:staged|backup)\\.${TRANSACTION_UUID}$`),
      operationLockTemporaryPattern("\\.heige-codex-skin-launcher-install\\.lock"),
      new RegExp(`^\\.heige-codex-skin-launcher-transaction\\.json\\.\\d+\\.${TRANSACTION_UUID}\\.tmp$`),
    ], "launcher transaction artifact"),
    home: await scanStrictArtifacts(home, [
      new RegExp(`^\\.heige-codex-skin-launcher-prepare\\.json\\.\\d+\\.${TRANSACTION_UUID}\\.tmp$`),
    ], "launcher preparation artifact"),
    state: await scanStrictArtifacts(stateRoot, [
      new RegExp(`^macos-install\\.json\\.next\\.\\d+\\.${TRANSACTION_UUID}$`),
      new RegExp(`^(?:stable-service-freeze|launch-agent-migration)\\.json\\.tmp\\.${TRANSACTION_UUID}$`),
      new RegExp(`^\\.(?:state|session|transition)\\.json\\.tmp-\\d+-${TRANSACTION_UUID}$`),
      operationLockTemporaryPattern("operation\\.lock"),
      new RegExp(`^\\.operation-lock-gc\\.\\d+\\.${TRANSACTION_UUID}$`),
    ], "state transaction artifact"),
    coordinatorLock: await scanStrictArtifacts(join(stateRoot, "macos-install-operation"), [
      operationLockTemporaryPattern("operation\\.lock"),
      new RegExp(`^\\.operation-lock-gc\\.\\d+\\.${TRANSACTION_UUID}$`),
    ], "coordinator lock artifact"),
  };
  const snapshot = { exact, dynamic };
  return { ...snapshot, digest: sha256(Buffer.from(JSON.stringify(snapshot))) };
}

export function installArtifactsQuiescent(snapshot) {
  return snapshot !== null
    && typeof snapshot === "object"
    && Object.values(snapshot.exact ?? {}).every((entry) => entry?.present === false)
    && Object.values(snapshot.dynamic ?? {}).every((entries) => Array.isArray(entries) && entries.length === 0);
}

async function waitForQuiescentInstallArtifacts(options) {
  return waitForValue(
    () => snapshotKnownInstallArtifacts(options),
    installArtifactsQuiescent,
    { label: "quiescent product-owned install transaction artifacts" },
  );
}

export async function captureInstallPrestate({
  home = userInfo().homedir,
  targetRoot = join(home, ".codex", "heige-codex-skin-studio"),
  run = execFile,
} = {}) {
  if (typeof process.getuid !== "function") throw new Error("install pre-state requires a POSIX uid");
  const uid = process.getuid();
  const stateRoot = join(home, "Library", "Application Support", "HeiGeCodexSkinStudio");
  const launcherRoot = join(home, "Applications", "HeiGe 皮肤启动器.app");
  const stateFiles = {};
  for (const name of ["state.json", "session.json", "transition.json"]) {
    stateFiles[name] = await optionalRegularFingerprint(join(stateRoot, name), name, 1024 * 1024);
  }
  const [tree, launcher, legacy, controller, legacyTheme, transactionArtifacts] = await Promise.all([
    snapshotOwnedTree(targetRoot),
    snapshotOwnedTree(launcherRoot),
    serviceFingerprint({ home, uid, label: LEGACY_LABEL, run }),
    serviceFingerprint({ home, uid, label: CONTROLLER_LABEL, run }),
    optionalRegularFingerprint(
      join(home, ".codex", "heige-codex-skin-persist", "theme"),
      "legacy theme",
      MAX_THEME_ID_BYTES,
    ),
    waitForQuiescentInstallArtifacts({ home, targetRoot }),
  ]);
  const snapshot = {
    tree,
    launcher,
    stateFiles,
    services: { legacy, controller },
    legacyTheme,
    transactionArtifacts,
  };
  return {
    ...snapshot,
    digest: sha256(Buffer.from(JSON.stringify(snapshot))),
  };
}

export function exactInstallPrestate(left, right) {
  return left?.digest === right?.digest && JSON.stringify(left) === JSON.stringify(right);
}

async function labelLoaded(uid, label, run = execFile) {
  try {
    await run("/bin/launchctl", ["print", `gui/${uid}/${label}`]);
    return true;
  } catch (error) {
    if ([3, 113, "3", "113"].includes(error?.code)) return false;
    throw error;
  }
}

async function readPlistJson(path, run = execFile) {
  const snapshot = await regularSnapshot(path, "LaunchAgent plist", MAX_PLIST_BYTES);
  const { stdout } = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], {
    encoding: "utf8",
    maxBuffer: MAX_PLIST_BYTES * 2,
  });
  let plist;
  try { plist = JSON.parse(stdout); } catch (cause) {
    throw new Error("LaunchAgent plist 无法转换为 JSON", { cause });
  }
  return { plist, snapshot };
}

async function inspectLegacy({ home, uid, run = execFile }) {
  const stableRoot = join(home, ".codex", "heige-codex-skin-studio");
  const plistPath = join(home, "Library", "LaunchAgents", `${LEGACY_LABEL}.plist`);
  const scriptPath = join(stableRoot, "scripts", "lib", "skin-watchdog.zsh");
  const { plist, snapshot } = await readPlistJson(plistPath, run);
  const expectedKeys = [
    "AbandonProcessGroup",
    "EnvironmentVariables",
    "Label",
    "ProgramArguments",
    "RunAtLoad",
    "StandardErrorPath",
    "StandardOutPath",
    "StartInterval",
  ];
  if (!exactKeys(plist, expectedKeys)) throw new Error("legacy watchdog plist keys 不符合固定 tuple");
  if (
    plist.Label !== LEGACY_LABEL
    || plist.RunAtLoad !== true
    || plist.StartInterval !== 15
    || plist.AbandonProcessGroup !== true
    || !Array.isArray(plist.ProgramArguments)
    || plist.ProgramArguments.length !== 2
    || plist.ProgramArguments[0] !== "/bin/zsh"
    || plist.ProgramArguments[1] !== scriptPath
    || !exactKeys(plist.EnvironmentVariables, ["HEIGE_CODEX_SKIN_PORT", "HEIGE_CODEX_SKIN_STATE"])
    || plist.EnvironmentVariables.HEIGE_CODEX_SKIN_PORT !== String(PORT)
  ) throw new Error("legacy watchdog plist fixed tuple 不匹配");
  const script = await regularSnapshot(scriptPath, "legacy watchdog script", 1024 * 1024);
  if ((script.mode & 0o111) === 0) throw new Error("legacy watchdog script 不可执行");
  return {
    loaded: await labelLoaded(uid, LEGACY_LABEL, run),
    plistMode: snapshot.mode,
    plistSha256: snapshot.sha256,
    scriptMode: script.mode,
    scriptSha256: script.sha256,
    statePathTrusted: false,
    logPathsTrusted: false,
  };
}

async function inspectExistingController({ home, uid, run = execFile }) {
  const path = join(home, "Library", "LaunchAgents", `${CONTROLLER_LABEL}.plist`);
  try {
    const { plist, snapshot } = await readPlistJson(path, run);
    const stateRoot = join(home, "Library", "Application Support", "HeiGeCodexSkinStudio");
    const nodePath = join(home, ".hermes", "node", "bin", "node");
    const controllerPath = join(home, ".codex", "heige-codex-skin-studio", "src", "cli.mjs");
    const expectedKeys = [
      "KeepAlive",
      "Label",
      "ProcessType",
      "ProgramArguments",
      "RunAtLoad",
      "StandardErrorPath",
      "StandardOutPath",
    ];
    if (
      !exactKeys(plist, expectedKeys)
      || plist.Label !== CONTROLLER_LABEL
      || plist.RunAtLoad !== true
      || plist.ProcessType !== "Background"
      || !exactKeys(plist.KeepAlive, ["SuccessfulExit"])
      || plist.KeepAlive.SuccessfulExit !== false
      || JSON.stringify(plist.ProgramArguments) !== JSON.stringify([nodePath, controllerPath, "controller"])
      || plist.StandardOutPath !== join(stateRoot, "controller.log")
      || plist.StandardErrorPath !== join(stateRoot, "controller.error.log")
    ) throw new Error("existing controller is not the exact known Hermes legacy tuple");
    const node = await regularSnapshot(nodePath, "legacy Hermes Node", 512 * 1024 * 1024);
    const controller = await regularSnapshot(controllerPath, "legacy controller entrypoint", 16 * 1024 * 1024);
    if ((node.mode & 0o111) === 0) throw new Error("legacy Hermes Node is not executable");
    const nonce = randomUUID();
    const { stdout } = await run(nodePath, [
      "--input-type=module",
      "--eval",
      `import { pathToFileURL } from "node:url";
const controllerPath = process.argv[2];
const nonce = process.argv[3];
await import(pathToFileURL(controllerPath).href);
process.stdout.write(JSON.stringify({ nonce, pid: process.pid, execPath: process.execPath, version: process.version }));`,
      "heige-live-runtime-probe",
      controllerPath,
      nonce,
    ], { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 });
    let health;
    try { health = JSON.parse(stdout); } catch (cause) {
      throw new Error("legacy controller runtime health response is invalid", { cause });
    }
    if (
      health?.nonce !== nonce
      || health.execPath !== nodePath
      || !Number.isSafeInteger(health.pid)
      || !/^v(?:2[2-9]|[3-9]\d)\.\d+\.\d+$/.test(health.version)
    ) throw new Error("legacy controller runtime failed its exact health probe");
    const processIdentity = await inspectLaunchAgentProcessIdentity();
    return {
      present: true,
      loaded: await labelLoaded(uid, CONTROLLER_LABEL, run),
      plistMode: snapshot.mode,
      plistSha256: snapshot.sha256,
      attribution: "legacy-hermes",
      running: processIdentity !== null,
      nodeSha256: node.sha256,
      controllerSha256: controller.sha256,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        present: false,
        loaded: await labelLoaded(uid, CONTROLLER_LABEL, run),
        attribution: null,
        running: false,
      };
    }
    throw error;
  }
}

export function stableControllerProcessIdentity({
  processIdentity,
  psOutput,
  expectedArguments,
  nodePath,
}) {
  if (!Array.isArray(expectedArguments) || expectedArguments.length === 0) {
    throw new TypeError("expected controller arguments are required");
  }
  const rows = parseMacPsTable(psOutput);
  if (
    rows.length !== 1
    || rows[0].pid !== processIdentity?.pid
    || rows[0].startedAt !== processIdentity?.startedAt
    || rows[0].commandLine !== expectedArguments.join(" ")
  ) throw new Error("loaded controller process does not match the exact stable command tuple");
  return publicProcessIdentity({
    ...processIdentity,
    executablePath: nodePath,
  });
}

async function inspectControllerExact({
  home = userInfo().homedir,
  run = execFile,
} = {}) {
  const inspected = await inspectLaunchAgent();
  if (inspected.plistExists !== true) {
    if (inspected.loaded === true) throw new Error("controller is loaded without its canonical plist");
    return { registered: false, loaded: false, process: null };
  }
  const runtime = await inspectTrustedProductionRuntime();
  const { plist, snapshot } = await readPlistJson(inspected.plistPath, run);
  const expectedArguments = [
    runtime.nodePath,
    runtime.controllerPath,
    "controller",
    "--background",
    "--platform",
    "darwin",
    "--task-name",
    CONTROLLER_LABEL,
  ];
  const expectedKeys = [
    "KeepAlive",
    "Label",
    "ProcessType",
    "ProgramArguments",
    "RunAtLoad",
    "StandardErrorPath",
    "StandardOutPath",
  ];
  const stateRoot = join(home, "Library", "Application Support", "HeiGeCodexSkinStudio");
  if (
    !exactKeys(plist, expectedKeys)
    || plist.Label !== CONTROLLER_LABEL
    || plist.ProcessType !== "Background"
    || plist.RunAtLoad !== true
    || !exactKeys(plist.KeepAlive, ["SuccessfulExit"])
    || plist.KeepAlive.SuccessfulExit !== false
    || JSON.stringify(plist.ProgramArguments) !== JSON.stringify(expectedArguments)
    || plist.StandardOutPath !== join(stateRoot, "controller.log")
    || plist.StandardErrorPath !== join(stateRoot, "controller.error.log")
    || snapshot.mode !== 0o600
  ) throw new Error("controller plist does not match the exact stable production tuple");
  const processIdentity = inspected.loaded ? await inspectLaunchAgentProcessIdentity() : null;
  if (inspected.loaded && processIdentity === null) {
    throw new Error("loaded controller process identity is unavailable");
  }
  let process = null;
  if (processIdentity !== null) {
    const { stdout } = await run("/bin/ps", [
      "-p",
      String(processIdentity.pid),
      "-o",
      "pid=,lstart=,command=",
    ]);
    process = stableControllerProcessIdentity({
      processIdentity,
      psOutput: stdout,
      expectedArguments,
      nodePath: runtime.nodePath,
    });
  }
  return {
    registered: true,
    loaded: inspected.loaded === true,
    process,
    plistSha256: snapshot.sha256,
  };
}

async function waitForControllerGone(options = {}) {
  return waitForValue(
    () => inspectControllerExact(options),
    (value) => value.registered === false && value.loaded === false,
    { label: "controller unregister" },
  );
}

async function waitForControllerReady(options = {}) {
  return waitForValue(
    () => inspectControllerExact(options),
    (value) => value.registered === true && value.loaded === true && value.process !== null,
    { label: "exact background controller" },
  );
}

async function exactDirectory(path, expectedNames, label) {
  const info = await lstat(path);
  if (
    info.isSymbolicLink()
    || !info.isDirectory()
    || await realpath(path) !== resolve(path)
    || (info.mode & 0o777) !== 0o755
  ) throw new Error(`${label} is not an exact mode 0755 canonical directory`);
  const names = (await readdir(path)).sort();
  const expected = [...expectedNames].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`${label} contains unowned extra content`);
  }
}

export async function validateLauncherBundle({
  home = userInfo().homedir,
  targetRoot = join(home, ".codex", "heige-codex-skin-studio"),
} = {}) {
  const appPath = join(home, "Applications", `${MACOS_LAUNCHER_NAME}.app`);
  const contentsPath = join(appPath, "Contents");
  const macosPath = join(contentsPath, "MacOS");
  const executablePath = join(appPath, "Contents", "MacOS", "HeiGe Skin Launcher");
  const plistPath = join(appPath, "Contents", "Info.plist");
  await exactDirectory(appPath, ["Contents"], "launcher app");
  await exactDirectory(contentsPath, ["Info.plist", "MacOS"], "launcher Contents");
  await exactDirectory(macosPath, ["HeiGe Skin Launcher"], "launcher MacOS");
  const executable = await regularSnapshot(executablePath, "launcher executable", 64 * 1024);
  const expectedExecutable = renderMacosLauncherExecutable(join(targetRoot, "scripts", "apply.command"));
  if (executable.mode !== 0o755 || !executable.bytes.equals(Buffer.from(expectedExecutable))) {
    throw new Error("launcher executable is not the exact session-only apply entrypoint");
  }
  const plist = await regularSnapshot(plistPath, "launcher Info.plist", 64 * 1024);
  const expectedPlist = Buffer.from(renderMacosLauncherPlist(targetRoot));
  if (plist.mode !== 0o644 || !plist.bytes.equals(expectedPlist)) {
    throw new Error("launcher plist is not the exact generated schema and entrypoint tuple");
  }
  return {
    appPath,
    executableSha256: executable.sha256,
    plistSha256: plist.sha256,
  };
}

async function runStableCommand(command, {
  home = userInfo().homedir,
  targetRoot,
  run = execFile,
} = {}) {
  if (!new Set(["enable-skin", "pause", "resume", "restore"]).has(command)) {
    throw new Error("stable lifecycle command is not allowed");
  }
  const path = join(targetRoot, "scripts", `${command}.command`);
  const snapshot = await regularSnapshot(path, `${command}.command`, 128 * 1024);
  if ((snapshot.mode & 0o111) === 0) throw new Error(`${command}.command is not executable`);
  const { stdout } = await run(path, [], {
    env: {
      HOME: home,
      LANG: process.env.LANG ?? "en_US.UTF-8",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      HEIGE_CODEX_SKIN_PORT: String(PORT),
    },
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 256 * 1024,
  });
  try { return JSON.parse(stdout); } catch (cause) {
    throw new Error(`${command}.command returned invalid JSON`, { cause });
  }
}

async function controllerLoopbackPort(pid, run = execFile) {
  const { stdout } = await run("/usr/sbin/lsof", [
    "-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn",
  ]);
  const ports = stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^n127\.0\.0\.1:(\d+)$/.exec(line);
    return match ? [Number(match[1])] : [];
  });
  const unique = [...new Set(ports)];
  if (unique.length !== 1 || !Number.isSafeInteger(unique[0])) {
    throw new Error("background controller does not own exactly one IPv4 loopback listener");
  }
  return unique[0];
}

async function inspectEphemeralControllerProcess({
  run = execFile,
} = {}) {
  const runtime = await inspectTrustedProductionRuntime();
  const expected = [
    runtime.nodePath,
    runtime.controllerPath,
    "controller",
    "--ephemeral",
    "--port",
    String(PORT),
  ].join(" ");
  const { stdout } = await run("/bin/ps", ["-axo", "pid=,lstart=,command="]);
  const matches = parseMacPsTable(stdout).filter((entry) => entry.commandLine === expected);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one stable ephemeral controller, observed ${matches.length}`);
  }
  return publicProcessIdentity({
    pid: matches[0].pid,
    executablePath: runtime.nodePath,
    startedAt: matches[0].startedAt,
  });
}

export async function listLifecycleHelperProcesses({
  home = userInfo().homedir,
  run = execFile,
  inspectRuntime = inspectTrustedProductionRuntime,
} = {}) {
  if (typeof run !== "function" || typeof inspectRuntime !== "function") {
    throw new TypeError("lifecycle helper inspection dependencies are required");
  }
  const runtime = await inspectRuntime();
  const helperPath = join(dirname(runtime.controllerPath), "lifecycle-helper.mjs");
  const actionRoot = join(home, "Library", "Application Support", "HeiGeCodexSkinStudio");
  const exactCommand = new RegExp(
    `^${regexLiteral(runtime.nodePath)} ${regexLiteral(helperPath)} `
    + `${regexLiteral(actionRoot)}\\/lifecycle-${TRANSACTION_UUID}\\.json$`,
  );
  const { stdout } = await run("/bin/ps", ["-axo", "pid=,lstart=,command="]);
  return parseMacPsTable(stdout)
    .filter(({ commandLine }) => exactCommand.test(commandLine))
    .map((entry) => publicProcessIdentity({
      pid: entry.pid,
      executablePath: runtime.nodePath,
      startedAt: entry.startedAt,
    }));
}

async function waitForLifecycleHelpersQuiescent(options = {}) {
  await waitForValue(
    () => listLifecycleHelperProcesses(options),
    (processes) => processes.length === 0,
    { attempts: 480, intervalMs: 250, label: "trusted detached lifecycle helper quiescence" },
  );
  return { quiescent: true };
}

async function assertPersistentBackgroundControl({
  expectedRevision,
  expectedEphemeralProcess,
  home = userInfo().homedir,
  run = execFile,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (expectedEphemeralProcess === null || expectedEphemeralProcess === undefined) {
    throw new Error("exact ephemeral controller identity was not captured before enable");
  }
  await waitForValue(
    () => readPosixProcessIdentity(expectedEphemeralProcess.pid, { platform: "darwin" }),
    (observed) => observed === null || observed.startedAt !== expectedEphemeralProcess.startedAt,
    { label: "exact ephemeral controller exit" },
  );
  const controller = await waitForControllerReady({ home, run });
  const statePath = join(home, "Library", "Application Support", "HeiGeCodexSkinStudio", "state.json");
  const state = await readStudioState(statePath);
  if (
    state?.persistenceEnabled !== true
    || state.revision !== expectedRevision
    || typeof state.controlToken !== "string"
    || state.controlToken.length < 32
  ) throw new Error("authoritative state does not match the expected enabled revision");
  const ephemeralLock = join(
    home,
    "Library",
    "Application Support",
    "HeiGeCodexSkinStudio",
    "ephemeral-controller",
    "operation.lock",
  );
  if (!await pathAbsent(ephemeralLock)) throw new Error("ephemeral controller lease is still present");
  const controlPort = await controllerLoopbackPort(controller.process.pid, run);
  const response = await fetchImpl(`http://127.0.0.1:${controlPort}/v1/persistence`, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      "Origin": "app://-",
      "X-HeiGe-Control-Token": state.controlToken,
    },
    body: JSON.stringify({ revision: state.revision, persistenceEnabled: true }),
    signal: AbortSignal.timeout(3_000),
  });
  let body;
  try { body = await response.json(); } catch (cause) {
    throw new Error("background control endpoint returned invalid JSON", { cause });
  }
  if (
    !response.ok
    || body?.ok !== true
    || body.persistenceEnabled !== true
    || body.revision !== expectedRevision
  ) throw new Error("background control endpoint did not ACK the authoritative idempotent state");
  return {
    controlReachable: true,
    exactProcess: true,
    ephemeralExited: true,
    ephemeralProcess: expectedEphemeralProcess,
    process: controller.process,
  };
}

async function inspectAppAndProcess({ home, run = execFile }) {
  const app = await resolveCodexApp({ home, env: {}, platform: "darwin" });
  if (app.appPath !== "/Applications/ChatGPT.app") {
    throw new Error("live acceptance only accepts /Applications/ChatGPT.app");
  }
  const appInfo = await lstat(app.appPath);
  if (appInfo.isSymbolicLink() || !appInfo.isDirectory()) throw new Error("Codex app 不是可信目录");
  if (await realpath(app.appPath) !== resolve(app.appPath)) throw new Error("Codex app path 非 canonical");
  const identity = assertAppIdentity(await inspectMacApp(app.appPath, { run }), "current app");

  const processes = await listCodexProcesses({ app, exec: run });
  if (processes.length !== 1 || processes[0].cdpPort !== PORT) {
    throw new Error(`预期唯一一个 Codex CDP 主进程，实际 Codex 进程 ${processes.length}`);
  }
  const processIdentity = processes[0];
  const owners = await portOwners(PORT, run);
  await verifyCodexPortOwnerTree({ rootProcess: processIdentity, ownerPids: owners, run });
  return {
    app,
    identity,
    processIdentity: {
      pid: processIdentity.pid,
      executablePath: app.executablePath,
      executableSha256: identity.executableSha256,
      startedAt: processIdentity.startedAt,
    },
  };
}

function publicProcessIdentity(value, executableSha256 = null) {
  if (
    !Number.isSafeInteger(value?.pid)
    || value.pid <= 0
    || typeof value?.executablePath !== "string"
    || typeof value?.startedAt !== "string"
    || value.startedAt.length === 0
  ) throw new Error("Codex process identity is invalid");
  return {
    pid: value.pid,
    executablePath: value.executablePath,
    startedAt: value.startedAt,
    ...(executableSha256 === null ? {} : { executableSha256 }),
  };
}

async function portOwners(port, run = execFile) {
  try {
    const { stdout } = await run("/usr/sbin/lsof", [
      "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t",
    ]);
    return [...new Set(stdout.split(/\s+/).filter(Boolean).map(Number))];
  } catch (error) {
    if ([1, "1"].includes(error?.code)) return [];
    throw error;
  }
}

function parseMacProcessTree(output) {
  const rows = [];
  for (const line of String(output).split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})\s+(.*)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      startedAt: `${match[3]} ${match[4]} ${match[5]} ${match[6]} ${match[7]}`,
      commandLine: match[8],
    });
  }
  return rows;
}

export async function verifyCodexPortOwnerTree({ rootProcess, ownerPids, run = execFile }) {
  const root = publicProcessIdentity(rootProcess);
  const owners = [...new Set(ownerPids ?? [])];
  if (!owners.includes(root.pid) || owners.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
    throw new Error("CDP listener owners do not include the exact Codex root process");
  }
  const { stdout } = await run("/bin/ps", ["-axo", "pid=,ppid=,lstart=,command="]);
  const rows = new Map(parseMacProcessTree(stdout).map((row) => [row.pid, row]));
  const rootRow = rows.get(root.pid);
  if (
    rootRow?.startedAt !== root.startedAt
    || !(rootRow.commandLine === root.executablePath || rootRow.commandLine.startsWith(`${root.executablePath} `))
  ) throw new Error("CDP root process identity changed during global owner verification");
  for (const owner of owners) {
    let pid = owner;
    const visited = new Set();
    while (pid !== root.pid) {
      if (visited.has(pid) || visited.size > 64) {
        throw new Error("CDP listener owner ancestry is cyclic or too deep");
      }
      visited.add(pid);
      const row = rows.get(pid);
      if (row === undefined || row.ppid <= 0) {
        throw new Error("CDP listener has a foreign owner outside the exact Codex process tree");
      }
      pid = row.ppid;
    }
  }
  return { exactRoot: true, ownerCount: owners.length };
}

async function waitForValue(action, predicate, {
  attempts = 160,
  intervalMs = 250,
  label = "condition",
} = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const value = await action();
      if (predicate(value)) return value;
    } catch (error) { lastError = error; }
    await delay(intervalMs);
  }
  throw new Error(`${label} did not become true`, { cause: lastError });
}

async function inspectSingleCodexProcess({
  mode,
  home = userInfo().homedir,
  run = execFile,
} = {}) {
  if (!new Set(["cdp", "native"]).has(mode)) throw new Error("Codex process mode is invalid");
  const app = await resolveCodexApp({
    home,
    env: { HEIGE_CODEX_APP: "/Applications/ChatGPT.app" },
    platform: "darwin",
  });
  const identity = assertAppIdentity(await inspectMacApp(app.appPath, { run }), "running app");
  const processes = await listCodexProcesses({ app, exec: run });
  if (processes.length !== 1) throw new Error(`expected exactly one Codex process, observed ${processes.length}`);
  const processIdentity = processes[0];
  const owners = await portOwners(PORT, run);
  if (mode === "cdp") {
    if (processIdentity.cdpPort !== PORT) throw new Error("Codex process does not expose the expected CDP port");
    await verifyCodexPortOwnerTree({ rootProcess: processIdentity, ownerPids: owners, run });
  } else if (processIdentity.hasCdp || processIdentity.cdpPort !== null || owners.length !== 0) {
    throw new Error("native Codex unexpectedly retained a CDP listener");
  }
  return {
    app,
    appIdentity: identity,
    process: publicProcessIdentity(processIdentity, identity.executableSha256),
    mode,
  };
}

async function waitForSingleCodexProcess(input) {
  return waitForValue(
    () => inspectSingleCodexProcess(input),
    () => true,
    { label: `${input.mode} Codex process` },
  );
}

async function waitForExactProcessExit(identity, {
  home = userInfo().homedir,
  run = execFile,
} = {}) {
  const app = await resolveCodexApp({
    home,
    env: { HEIGE_CODEX_APP: "/Applications/ChatGPT.app" },
    platform: "darwin",
  });
  await waitForValue(async () => {
    const processes = await listCodexProcesses({ app, exec: run });
    return processes.some((entry) => sameProcessIdentity(entry, identity));
  }, (stillPresent) => stillPresent === false, { label: "exact Codex process exit" });
}

async function quitExactCodex(identity, options = {}) {
  const expected = publicProcessIdentity(identity);
  const home = options.home ?? userInfo().homedir;
  const run = options.run ?? execFile;
  const app = await resolveCodexApp({
    home,
    env: { HEIGE_CODEX_APP: "/Applications/ChatGPT.app" },
    platform: "darwin",
  });
  const processes = await listCodexProcesses({ app, exec: run });
  if (processes.length !== 1 || !sameProcessIdentity(processes[0], expected)) {
    throw new Error("Codex process identity drifted before normal quit");
  }
  await requestNormalQuit({ process: expected }, { execFile: options.run ?? execFile });
  await waitForExactProcessExit(expected, options);
}

async function launchCodex(mode, {
  home = userInfo().homedir,
  run = execFile,
} = {}) {
  const args = ["-na", "/Applications/ChatGPT.app"];
  if (mode === "cdp") {
    args.push(
      "--args",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${PORT}`,
    );
  } else if (mode !== "native") {
    throw new Error("launch mode is invalid");
  }
  await run("/usr/bin/open", args);
  return waitForSingleCodexProcess({ mode, home, run });
}

async function discoverStageCandidates() {
  const entries = await readdir("/Applications", { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && STAGE_NAME.test(entry.name))
    .map((entry) => join("/Applications", entry.name));
}

async function inspectRenderers() {
  const targets = classifyCodexTargets(await fetchRendererTargets(PORT));
  const mainTargets = targets.filter(({ kind }) => kind === "main");
  if (mainTargets.length === 0) throw new Error("没有严格识别的 Codex 主 renderer");
  const origins = [];
  for (const target of mainTargets) {
    const session = new CdpSession(target.webSocketDebuggerUrl);
    try {
      await session.open();
      origins.push(await session.evaluate("location.origin"));
    } finally {
      session.close();
    }
  }
  if (!origins.every((origin) => origin === "app://-")) throw new Error("renderer origin 不是 app://-");
  return { rendererOrigin: "app://-", mainRendererCount: mainTargets.length };
}

async function inspectLegacyTheme(home) {
  const themePath = join(home, ".codex", "heige-codex-skin-persist", "theme");
  const snapshot = await regularSnapshot(themePath, "legacy theme record", MAX_THEME_ID_BYTES);
  const themeId = snapshot.bytes.toString("utf8").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(themeId)) throw new Error("legacy theme id 无效");
  const themeRoot = join(home, ".codex", "heige-codex-skin-studio", "themes");
  const themes = await listThemes({ roots: [themeRoot] });
  if (!themes.some((theme) => theme.id === themeId)) throw new Error("legacy theme 在 stable install 中不存在");
  return { themeId, recordMode: snapshot.mode, recordSha256: snapshot.sha256 };
}

async function inspectSchema2State(home) {
  const statePath = join(home, "Library", "Application Support", "HeiGeCodexSkinStudio", "state.json");
  const state = await readStudioState(statePath);
  if (state === null) return { present: false };
  return {
    present: true,
    schemaVersion: state.schemaVersion,
    revision: state.revision,
    persistenceEnabled: state.persistenceEnabled,
    selectedThemeId: state.selectedThemeId,
  };
}

export async function discoverLivePreflight({
  run = execFile,
  explicitStagePath = null,
  expectedCurrentAsarSha256 = null,
  expectedStageAsarSha256 = null,
  inspectApp = inspectMacApp,
  stageCandidates = null,
} = {}) {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") {
    throw new Error("live macOS acceptance 只允许在 macOS 当前用户执行");
  }
  const home = userInfo().homedir;
  const uid = process.getuid();
  const [{ app, identity, processIdentity }, renderers, legacy, existingController, legacyTheme, schema2] = await Promise.all([
    inspectAppAndProcess({ home, run }),
    inspectRenderers(),
    inspectLegacy({ home, uid, run }),
    inspectExistingController({ home, uid, run }),
    inspectLegacyTheme(home),
    inspectSchema2State(home),
  ]);
  const appSelection = await selectOfficialStage({
    currentAppPath: app.appPath,
    candidatePaths: stageCandidates ?? await discoverStageCandidates(),
    explicitStagePath,
    expectedCurrentAsarSha256,
    expectedStageAsarSha256,
    inspectApp,
  });
  if (
    appSelection.current.identity.executableSha256 !== identity.executableSha256
    || appSelection.current.identity.asarSha256 !== identity.asarSha256
  ) throw new Error("current app identity drifted during preflight");
  const installArtifacts = await waitForQuiescentInstallArtifacts({
    home,
    targetRoot: join(home, ".codex", "heige-codex-skin-studio"),
  });
  return {
    mutationCount: 0,
    appPath: app.appPath,
    app: appSelection,
    port: PORT,
    portOwnerMatchesCodex: true,
    process: processIdentity,
    ...renderers,
    legacy,
    existingController,
    legacyTheme,
    schema2,
    installArtifacts,
  };
}

async function pathAbsent(path) {
  try { await lstat(path); return false; } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

export async function runAppRepairRollbackThenClean({
  preflight,
  home = userInfo().homedir,
  adapters = {},
} = {}) {
  const current = preflight?.app?.current;
  const stage = preflight?.app?.stage;
  if (current?.classification !== "polluted") throw new Error("current app is not the revalidated polluted build");
  if (stage?.identity?.signatureValid !== true || stage.identity.teamIdentifier !== TEAM_IDENTIFIER) {
    throw new Error("official stage identity is invalid");
  }
  const journalPath = join(
    home,
    "Library",
    "Application Support",
    "HeiGeCodexSkinStudio",
    APP_REPAIR_JOURNAL,
  );
  const repairInput = {
    currentAppPath: current.path,
    stagedAppPath: stage.path,
    journalPath,
    expectedBeforeAsarSha256: current.identity.asarSha256,
    expectedOfficialAsarSha256: stage.identity.asarSha256,
  };
  const spawnCrash = adapters.spawnCrashWorker ?? spawnLiveWorker;
  const recover = adapters.recover ?? recoverMacAppRepair;
  const inspect = adapters.inspectApp ?? inspectMacApp;
  const repair = adapters.repair ?? repairMacApp;
  const absent = adapters.pathAbsent ?? pathAbsent;
  const sameIdentity = adapters.sameIdentity ?? macAppRepairInternals.sameIdentity;

  const [currentBeforeMutation, stageBeforeMutation] = await Promise.all([
    inspect(current.path),
    inspect(stage.path),
  ]);
  if (
    !sameIdentity(currentBeforeMutation, current.identity)
    || !sameIdentity(stageBeforeMutation, stage.identity)
  ) throw new Error("app identity drifted after preflight and before the first mutation");
  await (adapters.quitCodex ?? quitExactCodex)(preflight.process, { home });
  const cycle = await runCrashRecoveryCycle({
    label: "app repair",
    spawnCrashWorker: () => spawnCrash(validateLiveWorkerRequest({
      schemaVersion: 1,
      operation: "app-repair-sigkill",
      boundary: "after-target-published",
      ...repairInput,
    }, { home })),
    recover: () => recover({ journalPath }),
    assertRecovery: (value) => value?.recovered === true && value.action === "rollback",
    verifyRestored: async () => {
      const [restoredCurrent, restoredStage] = await Promise.all([
        inspect(current.path),
        inspect(stage.path),
      ]);
      const exact = sameIdentity(restoredCurrent, current.identity)
        && sameIdentity(restoredStage, stage.identity);
      return {
        exact,
        currentAsarSha256: restoredCurrent.asarSha256,
        stageAsarSha256: restoredStage.asarSha256,
      };
    },
    clean: async () => {
      const repaired = await repair(repairInput);
      const official = await inspect(current.path);
      if (!sameIdentity(official, stage.identity)) throw new Error("clean app repair did not publish the exact official stage");
      if (!await absent(stage.path)) throw new Error("clean app repair retained the consumed official stage");
      return {
        status: repaired?.status === "repaired" ? "PASS" : "FAIL",
        official,
      };
    },
  });
  if (cycle.clean.status !== "PASS") throw new Error("clean app repair did not report repaired");
  return {
    status: "PASS",
    sigkillBoundary: "after-target-published",
    preMigrationBehaviorRestored: true,
    migrationCommitted: false,
    recovery: cycle.recovery,
    restored: cycle.restored,
    clean: cycle.clean,
  };
}

export async function runInstallerRollbackThenClean({
  home = userInfo().homedir,
  sourceRoot = REPOSITORY_ROOT,
  targetRoot = join(home, ".codex", "heige-codex-skin-studio"),
  expectedProcess,
  initialThemeId,
  adapters = {},
} = {}) {
  const capture = adapters.capturePrestate ?? captureInstallPrestate;
  const spawnCrash = adapters.spawnCrashWorker ?? spawnLiveWorker;
  const recover = adapters.recover ?? runProductionMacosInstallRecovery;
  const install = adapters.install ?? runProductionMacosInstall;
  const inspectProcess = adapters.inspectProcess ?? (() => inspectSingleCodexProcess({ mode: "cdp", home }));
  const inspectRenderer = adapters.inspectRenderer ?? rendererSkinSnapshot;
  const inspectLegacyController = adapters.inspectLegacyController ?? (() => {
    if (typeof process.getuid !== "function") throw new Error("legacy controller inspection requires a POSIX uid");
    return inspectExistingController({ home, uid: process.getuid() });
  });
  const before = await capture({ home, targetRoot });
  const controllerBefore = await inspectLegacyController();
  if (
    controllerBefore?.present !== true
    || controllerBefore.loaded !== true
    || controllerBefore.attribution !== "legacy-hermes"
    || controllerBefore.running !== false
  ) throw new Error("installer crash cycle requires the exact loaded but non-running legacy controller pre-state");
  const cycle = await runCrashRecoveryCycle({
    label: "macOS installer",
    spawnCrashWorker: () => spawnCrash(validateLiveWorkerRequest({
      schemaVersion: 1,
      operation: "install-sigkill",
      boundary: "services-frozen",
      sourceRoot,
      targetRoot,
      port: PORT,
    }, { home, repositoryRoot: sourceRoot })),
    recover: () => recover({ sourceRoot, targetRoot, port: PORT }),
    assertRecovery: (value) => value?.recovered === true && value.decision === "rollback",
    verifyRestored: async () => {
      const after = await capture({ home, targetRoot });
      const controllerAfter = await waitForValue(
        inspectLegacyController,
        (value) => JSON.stringify(value) === JSON.stringify(controllerBefore) && value.running === false,
        { label: "exact non-running legacy controller pre-state" },
      );
      const process = await inspectProcess();
      const sameProcess = sameProcessIdentity(process.process, expectedProcess);
      const renderer = await waitForValue(
        inspectRenderer,
        (value) => value?.themeId === initialThemeId && value.menuPresent === true,
        { label: "legacy renderer behavior after installer rollback" },
      );
      const exactController = JSON.stringify(controllerAfter) === JSON.stringify(controllerBefore);
      return {
        exact: exactInstallPrestate(before, after) && exactController && sameProcess,
        prestateDigest: after.digest,
        exactLegacyController: exactController,
        sameProcess,
        themeId: renderer.themeId,
      };
    },
    clean: async () => install({ sourceRoot, targetRoot, port: PORT }),
  });
  if (cycle.clean?.decision !== "commit") throw new Error("clean macOS install did not commit");
  return {
    status: "PASS",
    sigkillBoundary: "services-frozen",
    preMigrationBehaviorRestored: true,
    migrationCommitted: true,
    prestateDigest: before.digest,
    recovery: cycle.recovery,
    restored: cycle.restored,
    clean: cycle.clean,
  };
}

function publicStudioState(state) {
  if (state === null) throw new Error("authoritative studio state is absent");
  return {
    schemaVersion: state.schemaVersion,
    revision: state.revision,
    persistenceEnabled: state.persistenceEnabled,
    selectedThemeId: state.selectedThemeId,
    lastNonNativeThemeId: state.lastNonNativeThemeId,
  };
}

export function createProductionOptionOneAdapters({
  home = userInfo().homedir,
  targetRoot = join(home, ".codex", "heige-codex-skin-studio"),
  initialThemeId,
  initialProcess,
  expectedAppIdentity,
  run = execFile,
} = {}) {
  assertAppIdentity(expectedAppIdentity, "expected lifecycle app");
  if (
    expectedAppIdentity.signatureValid !== true
    || expectedAppIdentity.teamIdentifier !== TEAM_IDENTIFIER
  ) throw new Error("lifecycle requires the exact signed official app identity");
  let currentProcess = publicProcessIdentity(initialProcess);
  let currentEphemeralProcess = null;
  const statePath = join(home, "Library", "Application Support", "HeiGeCodexSkinStudio", "state.json");
  const readState = async () => publicStudioState(await readStudioState(statePath));
  const requireExpectedApp = (observed) => {
    if (!macAppRepairInternals.sameIdentity(observed.appIdentity, expectedAppIdentity)) {
      throw new Error("official Codex app identity changed during the option 1 lifecycle");
    }
    return observed;
  };
  const requireCurrent = async (mode) => {
    const observed = requireExpectedApp(await inspectSingleCodexProcess({ mode, home, run }));
    if (currentProcess !== null && !sameProcessIdentity(observed.process, currentProcess)) {
      throw new Error("Codex process identity changed unexpectedly");
    }
    currentProcess = observed.process;
    return observed;
  };
  const requireActiveRenderer = async () => waitForValue(
    rendererSkinSnapshot,
    (value) => value?.menuPresent === true && value.stylePresent === true && value.themeId === initialThemeId,
    { label: "active renderer skin" },
  );
  return {
    readState,
    async requireMenu(expected) {
      await requireCurrent("cdp");
      const snapshot = await waitForPersistenceMenu({
        persistenceEnabled: expected.persistenceEnabled,
        themeId: expected.themeId,
      });
      return snapshot;
    },
    async setMenuPersistence(enabled) {
      await requireCurrent("cdp");
      const session = await openMainRendererSession();
      try { return await setPersistenceViaMenu(session, enabled); } finally { session.close(); }
    },
    async reloadSameProcess() {
      const before = (await requireCurrent("cdp")).process;
      const session = await openMainRendererSession();
      try { await session.send("Page.reload", { ignoreCache: true }); } finally { session.close(); }
      const after = await waitForValue(
        () => inspectSingleCodexProcess({ mode: "cdp", home, run }),
        (value) => sameProcessIdentity(value.process, before),
        { label: "same Codex process after renderer reload" },
      );
      currentProcess = after.process;
      const menu = await waitForPersistenceMenu({ persistenceEnabled: false, themeId: initialThemeId });
      return {
        sameProcess: sameProcessIdentity(after.process, before),
        menuPresent: menu.menuPresent,
        themeId: menu.themeId,
      };
    },
    async quitAndAssertControllerGone() {
      const before = (await requireCurrent("cdp")).process;
      await quitExactCodex(before, { home, run });
      currentProcess = null;
      await waitForControllerGone({ home, run });
      const owners = await portOwners(PORT, run);
      if (owners.length !== 0) throw new Error("CDP listener remained after Codex exited");
      return { controllerGone: true };
    },
    async launchNativeAndAssert() {
      if (currentProcess !== null) throw new Error("native launch requires Codex to be closed");
      const launched = requireExpectedApp(await launchCodex("native", { home, run }));
      currentProcess = launched.process;
      await waitForControllerGone({ home, run });
      const state = await readState();
      if (state.persistenceEnabled !== false) throw new Error("native launch changed persistence");
      return { cdpOwner: null, menuPresent: false, process: launched.process };
    },
    async launchSessionAndAssert() {
      const before = (await requireCurrent("native")).process;
      const launcher = await validateLauncherBundle({ home, targetRoot, run });
      await waitForLifecycleHelpersQuiescent({ home, run });
      await run("/usr/bin/open", ["-na", launcher.appPath]);
      await waitForExactProcessExit(before, { home, run });
      const launched = requireExpectedApp(await waitForSingleCodexProcess({ mode: "cdp", home, run }));
      if (sameProcessIdentity(launched.process, before)) throw new Error("launcher did not create a new CDP process");
      currentProcess = launched.process;
      const menu = await waitForPersistenceMenu({ persistenceEnabled: false, themeId: initialThemeId });
      currentEphemeralProcess = await inspectEphemeralControllerProcess({ run });
      await waitForLifecycleHelpersQuiescent({ home, run });
      const controller = await inspectControllerExact({ home, run });
      const state = await readState();
      return {
        cdpOwned: true,
        menuPresent: menu.menuPresent,
        themeId: menu.themeId,
        persistenceEnabled: state.persistenceEnabled,
        controllerRegistered: controller.registered || controller.loaded,
        process: launched.process,
      };
    },
    async assertPersistentBackground({ revision }) {
      const result = await assertPersistentBackgroundControl({
        expectedRevision: revision,
        expectedEphemeralProcess: currentEphemeralProcess,
        home,
        run,
      });
      currentEphemeralProcess = null;
      return result;
    },
    async pauseAndAssertStable() {
      const before = (await requireCurrent("cdp")).process;
      await runStableCommand("pause", { home, targetRoot, run });
      await waitForValue(
        rendererSkinSnapshot,
        (value) => value?.menuPresent === false && value.stylePresent === false && value.themeId === null,
        { label: "paused renderer" },
      );
      await delay(2_250);
      const after = await requireCurrent("cdp");
      const stillPaused = await rendererSkinSnapshot();
      const state = await readState();
      return {
        paused: stillPaused.menuPresent === false
          && stillPaused.stylePresent === false
          && stillPaused.themeId === null,
        sameProcess: sameProcessIdentity(after.process, before),
        themeId: state.selectedThemeId,
      };
    },
    async resumeAndAssert() {
      const before = (await requireCurrent("cdp")).process;
      await runStableCommand("resume", { home, targetRoot, run });
      const renderer = await requireActiveRenderer();
      const after = await requireCurrent("cdp");
      return {
        active: renderer.menuPresent === true && renderer.stylePresent === true,
        sameProcess: sameProcessIdentity(after.process, before),
        themeId: renderer.themeId,
      };
    },
    async restoreAndAssertNative() {
      const before = (await requireCurrent("cdp")).process;
      await waitForLifecycleHelpersQuiescent({ home, run });
      await runStableCommand("restore", { home, targetRoot, run });
      await waitForExactProcessExit(before, { home, run });
      const launched = requireExpectedApp(await waitForSingleCodexProcess({ mode: "native", home, run }));
      currentProcess = launched.process;
      await waitForLifecycleHelpersQuiescent({ home, run });
      await waitForControllerGone({ home, run });
      const state = await readState();
      return {
        native: true,
        persistenceEnabled: state.persistenceEnabled,
        process: launched.process,
      };
    },
  };
}

async function currentCodexProcessOrNull({
  home = userInfo().homedir,
  run = execFile,
} = {}) {
  const app = await resolveCodexApp({
    home,
    env: { HEIGE_CODEX_APP: "/Applications/ChatGPT.app" },
    platform: "darwin",
  });
  const processes = await listCodexProcesses({ app, exec: run });
  if (processes.length === 0) return null;
  if (processes.length !== 1) throw new Error("recovery found more than one Codex process");
  const mode = processes[0].cdpPort === PORT ? "cdp" : "native";
  return inspectSingleCodexProcess({ mode, home, run });
}

export async function recoverLiveAcceptance({
  home = userInfo().homedir,
  sourceRoot = REPOSITORY_ROOT,
  targetRoot = join(home, ".codex", "heige-codex-skin-studio"),
  initialPersistenceEnabled,
  initialThemeId,
  run = execFile,
} = {}) {
  const actions = {};
  const failures = [];
  const attempt = async (name, action) => {
    try {
      actions[name] = { status: "PASS", result: await action() };
    } catch (error) {
      actions[name] = { status: "FAIL", failure: safeFailure(error) };
      failures.push(error);
    }
  };
  const journalPath = join(
    home,
    "Library",
    "Application Support",
    "HeiGeCodexSkinStudio",
    APP_REPAIR_JOURNAL,
  );
  try {
    actions.lifecycleHelpers = {
      status: "PASS",
      result: await waitForLifecycleHelpersQuiescent({ home, run }),
    };
  } catch (error) {
    actions.lifecycleHelpers = { status: "FAIL", failure: safeFailure(error) };
    failures.push(error);
    return {
      status: "FAIL",
      actions,
      failures: failures.map(safeFailure),
    };
  }
  await attempt("appRepair", () => recoverMacAppRepair({ journalPath }));
  await attempt("installer", () => runProductionMacosInstallRecovery({
    sourceRoot,
    targetRoot,
    port: PORT,
  }));
  await attempt("functionalMode", async () => {
    let current = await currentCodexProcessOrNull({ home, run });
    if (current?.mode === "native") {
      await quitExactCodex(current.process, { home, run });
      current = null;
    }
    if (current === null) current = await launchCodex("cdp", { home, run });
    const statePath = join(home, "Library", "Application Support", "HeiGeCodexSkinStudio", "state.json");
    let state = await readStudioState(statePath);
    if (state !== null && initialPersistenceEnabled === true) {
      await runStableCommand("enable-skin", { home, targetRoot, run });
      state = await waitForValue(
        () => readStudioState(statePath),
        (value) => value?.persistenceEnabled === true,
        { label: "recovered persistence preference" },
      );
    } else if (state !== null && state.persistenceEnabled !== initialPersistenceEnabled) {
      throw new Error("automatic recovery only restores the revalidated persistence=true pre-state");
    }
    const renderer = await waitForValue(
      rendererSkinSnapshot,
      (value) => value?.themeId === initialThemeId && value.menuPresent === true,
      { label: "recovered functional skin" },
    );
    if (state?.persistenceEnabled === true) await waitForControllerReady({ home, run });
    return {
      mode: "cdp",
      process: current.process,
      themeId: renderer.themeId,
      persistenceEnabled: state?.persistenceEnabled ?? initialPersistenceEnabled,
    };
  });
  return {
    status: failures.length === 0 ? "PASS" : "FAIL",
    actions,
    failures: failures.map(safeFailure),
  };
}

function revalidatedInitialChoice(preflight) {
  if (preflight?.legacy?.loaded !== true) {
    throw new Error("live mutation requires the revalidated loaded legacy watchdog");
  }
  if (
    preflight?.existingController?.present !== true
    || preflight.existingController.loaded !== true
    || preflight.existingController.attribution !== "legacy-hermes"
    || preflight.existingController.running !== false
  ) {
    throw new Error("live mutation requires the exact loaded but non-running legacy Hermes controller tuple");
  }
  const persistenceEnabled = preflight.schema2?.present
    ? preflight.schema2.persistenceEnabled
    : preflight.legacy.loaded;
  if (persistenceEnabled !== true) {
    throw new Error("live mutation requires the revalidated initial persistence choice to be true");
  }
  const themeId = preflight.schema2?.present
    ? preflight.schema2.selectedThemeId
    : preflight.legacyTheme?.themeId;
  if (typeof themeId !== "string" || themeId !== preflight.legacyTheme?.themeId) {
    throw new Error("schema 2 and legacy theme choices are absent or inconsistent");
  }
  return { persistenceEnabled, themeId };
}

export async function runProductionRollbackThenClean({
  preflight,
  home = userInfo().homedir,
  sourceRoot = REPOSITORY_ROOT,
  targetRoot = join(home, ".codex", "heige-codex-skin-studio"),
  adapters = {},
} = {}) {
  const {
    persistenceEnabled: initialPersistenceEnabled,
    themeId: initialThemeId,
  } = revalidatedInitialChoice(preflight);

  const appPhase = await (adapters.appPhase ?? runAppRepairRollbackThenClean)({
    preflight,
    home,
    adapters: adapters.appAdapters,
  });
  const officialCdp = await (adapters.launchOfficialCdp ?? launchCodex)("cdp", { home });
  if (!macAppRepairInternals.sameIdentity(officialCdp.appIdentity, preflight.app.stage.identity)) {
    throw new Error("launched Codex is not the exact repaired official app");
  }
  const installerPhase = await (adapters.installerPhase ?? runInstallerRollbackThenClean)({
    home,
    sourceRoot,
    targetRoot,
    expectedProcess: officialCdp.process,
    initialThemeId,
    adapters: adapters.installerAdapters,
  });
  const statePath = join(home, "Library", "Application Support", "HeiGeCodexSkinStudio", "state.json");
  const migrated = await waitForValue(
    () => readStudioState(statePath),
    (value) => value?.persistenceEnabled === true && value.selectedThemeId === initialThemeId,
    { label: "clean migrated authoritative state" },
  );
  await waitForControllerReady({ home });
  await waitForPersistenceMenu({ persistenceEnabled: true, themeId: initialThemeId });
  const lifecycleAdapters = adapters.lifecycleAdapters ?? createProductionOptionOneAdapters({
    home,
    targetRoot,
    initialThemeId,
    initialProcess: officialCdp.process,
    expectedAppIdentity: officialCdp.appIdentity,
  });
  const lifecycle = await runOptionOneLifecycle({
    adapters: lifecycleAdapters,
    initialPersistenceEnabled,
    initialThemeId,
  });
  return {
    preflight,
    rollback: {
      status: "PASS",
      preMigrationBehaviorRestored: true,
      migrationCommitted: false,
      appRepair: {
        status: appPhase.status,
        sigkillBoundary: appPhase.sigkillBoundary,
        restored: appPhase.restored,
      },
      installer: {
        status: installerPhase.status,
        sigkillBoundary: installerPhase.sigkillBoundary,
        prestateDigest: installerPhase.prestateDigest,
        restored: installerPhase.restored,
      },
    },
    clean: {
      status: "PASS",
      appRepair: appPhase.clean.status,
      installer: installerPhase.clean.decision === "commit" ? "PASS" : "FAIL",
      migratedRevision: migrated.revision,
      checks: lifecycle.checks,
      finalPersistenceEnabled: lifecycle.finalPersistenceEnabled,
      finalRevision: lifecycle.finalRevision,
    },
  };
}

async function recoverInterruptedLiveAcceptance({ journal, configuration }) {
  const interruption = new Error("a previous detached live acceptance run ended before final evidence commit");
  interruption.code = "LIVE_ACCEPTANCE_INTERRUPTED";
  let recovery;
  try {
    recovery = await recoverLiveAcceptance({
      initialPersistenceEnabled: journal.initialPersistenceEnabled,
      initialThemeId: journal.initialThemeId,
    });
  } catch (error) {
    recovery = { status: "FAIL", failures: [safeFailure(error)] };
  }
  const result = {
    status: "FAIL",
    failedAt: new Date().toISOString(),
    failure: safeFailure(interruption),
    recovery,
    interruptedJournal: {
      transactionId: journal.transactionId,
      phase: journal.phase,
      initialPersistenceEnabled: journal.initialPersistenceEnabled,
      initialThemeId: journal.initialThemeId,
    },
  };
  let evidenceError = null;
  try {
    await writeAcceptanceEvidence({
      result,
      resultPath: configuration.resultPath,
      reportPath: configuration.reportPath,
    });
  } catch (error) { evidenceError = error; }
  if (recovery.status === "PASS" && evidenceError === null) {
    await clearLiveAcceptanceJournal(journal);
    throw interruption;
  }
  const recoveryErrors = (recovery.failures ?? [{
    code: "LIVE_RECOVERY_INCOMPLETE",
    message: "interrupted live acceptance recovery was incomplete",
  }]).map((failure) => Object.assign(
    new Error(failure.message ?? "interrupted live acceptance recovery failed"),
    { code: failure.code ?? "LIVE_RECOVERY_INCOMPLETE" },
  ));
  throw new AggregateError(
    [interruption, ...recoveryErrors, ...(evidenceError ? [evidenceError] : [])],
    "previous live acceptance was interrupted and recovery or evidence was incomplete",
  );
}

async function runLockedLiveMutation(configuration) {
  return withLiveAcceptanceSingleFlight(async () => {
    const pending = await readLiveAcceptanceJournal();
    if (pending !== null) {
      return recoverInterruptedLiveAcceptance({ journal: pending, configuration });
    }
    let preflight;
    try {
      preflight = await discoverLivePreflight(configuration);
    } catch (error) {
      await recordPreMutationFailure({
        error,
        resultPath: configuration.resultPath,
        reportPath: configuration.reportPath,
        reason: "live preflight failed while holding the single-flight lock",
      });
      throw error;
    }
    let initial;
    try {
      initial = revalidatedInitialChoice(preflight);
    } catch (error) {
      await recordPreMutationFailure({
        error,
        preflight,
        resultPath: configuration.resultPath,
        reportPath: configuration.reportPath,
        reason: "revalidated live prerequisites failed before any mutation",
      });
      throw error;
    }
    let journal = await prepareLiveAcceptanceJournal({
      initialPersistenceEnabled: initial.persistenceEnabled,
      initialThemeId: initial.themeId,
    });
    journal = await advanceLiveAcceptanceJournal(journal, "running");
    const completed = await executeLiveAcceptance({
      execute: () => runProductionRollbackThenClean({ preflight }),
      recover: () => recoverLiveAcceptance({
        initialPersistenceEnabled: initial.persistenceEnabled,
        initialThemeId: initial.themeId,
      }),
      baseResult: { preflight },
      resultPath: configuration.resultPath,
      reportPath: configuration.reportPath,
    });
    await clearLiveAcceptanceJournal(journal);
    return completed;
  });
}

export async function runLiveMacAcceptance({
  preflightOnly = false,
  sequence = null,
  resultPath = null,
  reportPath = null,
  env = process.env,
} = {}) {
  const requestedSequence = sequence ?? env.HEIGE_LIVE_SEQUENCE;
  const configuration = parseLiveConfiguration({
    ...env,
    HEIGE_LIVE_PREFLIGHT_ONLY: preflightOnly ? "1" : env.HEIGE_LIVE_PREFLIGHT_ONLY,
    HEIGE_LIVE_SEQUENCE: requestedSequence,
    HEIGE_LIVE_RESULT_JSON: resultPath ?? env.HEIGE_LIVE_RESULT_JSON,
    HEIGE_LIVE_REPORT_MD: reportPath ?? env.HEIGE_LIVE_REPORT_MD,
  });
  if (!configuration.enabled) throw new Error("live acceptance is not explicitly enabled");
  validateLiveOutputPaths(configuration);
  if (configuration.mode === "mutation" && requestedSequence !== LIVE_SEQUENCE) {
    throw new Error("unsupported live acceptance sequence");
  }
  if (configuration.mode === "mutation") {
    return runLockedLiveMutation(configuration);
  }
  let preflight;
  try {
    if (await readLiveAcceptanceJournal() !== null) {
      const error = new Error("an interrupted live acceptance journal requires a mutation recovery run");
      error.code = "LIVE_ACCEPTANCE_RECOVERY_REQUIRED";
      throw error;
    }
    preflight = await discoverLivePreflight(configuration);
  } catch (error) {
    const result = {
      status: "FAIL",
      failedAt: new Date().toISOString(),
      failure: safeFailure(error),
      recovery: { status: "NOT_STARTED", reason: "preflight failed before mutation" },
    };
    if (configuration.resultPath && configuration.reportPath) {
      await writeAcceptanceEvidence({
        result,
        resultPath: configuration.resultPath,
        reportPath: configuration.reportPath,
      });
    } else if (configuration.resultPath) {
      await atomicWriteAcceptanceEvidence(configuration.resultPath, result, { privateDirectory: true });
    } else if (configuration.reportPath) {
      await atomicWriteAcceptanceEvidence(configuration.reportPath, markdownReport(result));
    }
    throw error;
  }
  const result = { status: "PREFLIGHT_PASS", preflight };
  if (configuration.resultPath && configuration.reportPath) {
    return writeAcceptanceEvidence({
      result,
      resultPath: configuration.resultPath,
      reportPath: configuration.reportPath,
    });
  }
  if (configuration.resultPath) {
    await atomicWriteAcceptanceEvidence(configuration.resultPath, result, { privateDirectory: true });
  }
  if (configuration.reportPath) {
    await atomicWriteAcceptanceEvidence(configuration.reportPath, markdownReport(result));
    result.reportWritten = true;
  }
  return result;
}

if (process.argv[2] === INTERNAL_WORKER_FLAG) {
  if (process.argv.length !== 4) throw new Error("invalid live worker invocation");
  await runLiveWorker(decodeWorkerRequest(process.argv[3]));
} else {
  test("live macOS migration and option 1 lifecycle", {
    skip: process.env.HEIGE_RUN_LIVE_MACOS !== "1" && "requires explicit live macOS opt-in",
    timeout: 30 * 60 * 1000,
  }, async () => {
    const result = await runLiveMacAcceptance({
      preflightOnly: process.env.HEIGE_LIVE_PREFLIGHT_ONLY === "1",
      sequence: process.env.HEIGE_LIVE_SEQUENCE,
      resultPath: process.env.HEIGE_LIVE_RESULT_JSON,
      reportPath: process.env.HEIGE_LIVE_REPORT_MD,
    });
    assert.equal(result.preflight.rendererOrigin, "app://-");
    assert.equal(result.preflight.portOwnerMatchesCodex, true);
    if (process.env.HEIGE_LIVE_PREFLIGHT_ONLY === "1") {
      assert.equal(result.preflight.mutationCount, 0);
      assert.equal(result.status, "PREFLIGHT_PASS");
      return;
    }
    assert.equal(result.rollback.status, "PASS");
    assert.equal(result.rollback.preMigrationBehaviorRestored, true);
    assert.equal(result.rollback.migrationCommitted, false);
    for (const check of [
      "menuSwitch",
      "offAck",
      "sameProcessReload",
      "nativeRestart",
      "launcherReenable",
      "pauseResume",
      "restoreNative",
      "finalPreference",
    ]) assert.equal(result.clean.checks[check], "PASS", check);
    assert.equal(result.clean.finalPersistenceEnabled, true);
    assert.equal(result.reportWritten, true);
  });
}
