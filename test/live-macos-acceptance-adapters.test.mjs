import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  atomicWriteAcceptanceEvidence,
  createProductionInstallAdapter,
  createProductionRepairAdapter,
  executeLiveAcceptance,
  inspectPersistenceMenu,
  listLifecycleHelperProcesses,
  parseLiveConfiguration,
  readLiveAcceptanceJournal,
  recordPreMutationFailure,
  runAppRepairRollbackThenClean,
  runCrashRecoveryCycle,
  runInstallerRollbackThenClean,
  runOptionOneLifecycle,
  selectOfficialStage,
  setPersistenceViaMenu,
  snapshotKnownInstallArtifacts,
  stableControllerProcessIdentity,
  validateLiveOutputPaths,
  validateLauncherBundle,
  validateLiveWorkerRequest,
  verifyCodexPortOwnerTree,
  writeAcceptanceEvidence,
  withLiveAcceptanceSingleFlight,
} from "./live-macos-acceptance.mjs";
import {
  MACOS_LAUNCHER_NAME,
  renderMacosLauncherExecutable,
  renderMacosLauncherPlist,
} from "../src/macos-launcher.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const APPROVED_HELPER = "关闭后本次继续使用；下次启动恢复原生界面。打开「HeiGe 皮肤启动器」可恢复本次皮肤；下次仍常驻：重新打开此开关。";

function identity(overrides = {}) {
  return {
    rootDev: "1",
    rootIno: "2",
    bundleIdentifier: "com.openai.codex",
    version: "26.707.91948",
    build: "5440",
    executableSha256: HASH_A,
    executableSize: 12,
    signatureValid: true,
    teamIdentifier: "2DC432GLL2",
    asarSha256: HASH_B,
    asarSize: 34,
    ...overrides,
  };
}

test("live mutation needs both the opt-in and exact sequence", () => {
  assert.equal(parseLiveConfiguration({}).enabled, false);
  assert.equal(parseLiveConfiguration({ HEIGE_RUN_LIVE_MACOS: "1", HEIGE_LIVE_PREFLIGHT_ONLY: "1" }).mode, "preflight");
  assert.throws(
    () => parseLiveConfiguration({ HEIGE_RUN_LIVE_MACOS: "1" }),
    /HEIGE_LIVE_SEQUENCE=rollback-then-clean/,
  );
  const config = parseLiveConfiguration({
    HEIGE_RUN_LIVE_MACOS: "1",
    HEIGE_LIVE_SEQUENCE: "rollback-then-clean",
  });
  assert.equal(config.mode, "mutation");
});

test("live evidence outputs stay inside fixed result and report allowlists", () => {
  const home = "/Users/example";
  assert.throws(() => validateLiveOutputPaths({
    mode: "preflight",
    resultPath: "/Users/example/Library/Application Support/HeiGeCodexSkinStudio/live-acceptance/20260717T010203Z/result.json",
    reportPath: null,
  }, home), /strictly read-only/);
  assert.throws(() => validateLiveOutputPaths({
    mode: "mutation",
    resultPath: "/tmp/result.json",
    reportPath: "/tmp/report.md",
  }, home), /fixed acceptance run allowlist/);
  assert.throws(() => validateLiveOutputPaths({
    mode: "mutation",
    resultPath: null,
    reportPath: null,
  }, home), /requires both result and report paths/);
});

test("stage selection accepts a polluted current app and one signed official stage", async () => {
  const current = identity({ signatureValid: false, teamIdentifier: null, asarSha256: HASH_A });
  const stage = identity();
  const result = await selectOfficialStage({
    currentAppPath: "/Applications/ChatGPT.app",
    candidatePaths: ["/Applications/.ChatGPT.app.heige-official-stage-20260716-91948"],
    inspectApp: async (path) => path.endsWith("ChatGPT.app") ? current : stage,
  });
  assert.equal(result.current.classification, "polluted");
  assert.equal(result.stage.identity.signatureValid, true);
  assert.equal(result.stage.identity.teamIdentifier, "2DC432GLL2");
  assert.equal(result.stage.identity.executableSha256, HASH_A);
  assert.equal(result.stage.identity.asarSha256, HASH_B);
});

test("stage selection rejects ambiguity and explicit digest drift", async () => {
  const current = identity({ signatureValid: false, teamIdentifier: null, asarSha256: HASH_A });
  const stage = identity();
  const inspectApp = async (path) => path.endsWith("ChatGPT.app") ? current : stage;
  await assert.rejects(selectOfficialStage({
    currentAppPath: "/Applications/ChatGPT.app",
    candidatePaths: [
      "/Applications/.ChatGPT.app.heige-official-stage-a",
      "/Applications/.ChatGPT.app.heige-official-stage-b",
    ],
    inspectApp,
  }), /exactly one trusted official stage/);
  await assert.rejects(selectOfficialStage({
    currentAppPath: "/Applications/ChatGPT.app",
    candidatePaths: ["/Applications/.ChatGPT.app.heige-official-stage-a"],
    explicitStagePath: "/Applications/.ChatGPT.app.heige-official-stage-a",
    expectedStageAsarSha256: HASH_A,
    inspectApp,
  }), /stage app.asar digest drift/);
});

test("atomic evidence uses private modes and redacts secrets", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "heige-live-evidence-")));
  const path = join(root, "nested", "result.json");
  await atomicWriteAcceptanceEvidence(path, {
    status: "FAIL",
    token: "secret-token",
    detail: `home=${process.env.HOME}/private`,
    failure: "controlToken=secret-in-an-error",
    rawLog: "must not survive",
  }, { home: process.env.HOME });
  const directory = await lstat(join(root, "nested"));
  const file = await lstat(path);
  assert.equal(directory.mode & 0o777, 0o700);
  assert.equal(file.mode & 0o777, 0o600);
  const body = await readFile(path, "utf8");
  assert.doesNotMatch(body, /secret-token|secret-in-an-error|rawLog|must not survive/);
  assert.match(body, /\$HOME/);
});

test("atomic evidence rejects symlink ancestry and keeps Markdown line structure", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "heige-live-evidence-links-")));
  const real = join(root, "real");
  const linked = join(root, "linked");
  await mkdir(real, { mode: 0o700 });
  await symlink(real, linked);
  await assert.rejects(
    atomicWriteAcceptanceEvidence(join(linked, "result.json"), { status: "PASS" }),
    /real directory|symlink ancestor|canonical drift/,
  );
  const markdownPath = join(root, "report", "result.md");
  await atomicWriteAcceptanceEvidence(markdownPath, "# Report\n\nStatus: PASS\n");
  assert.equal(await readFile(markdownPath, "utf8"), "# Report\n\nStatus: PASS\n");
});

test("repair adapter delegates repair and rollback recovery to production functions", async () => {
  const calls = [];
  const adapter = createProductionRepairAdapter({
    repair: async (input) => { calls.push(["repair", input]); return { status: "repaired" }; },
    recover: async (input) => { calls.push(["recover", input]); return { recovered: true, action: "rollback" }; },
  });
  const input = {
    currentAppPath: "/Applications/ChatGPT.app",
    stagedAppPath: "/Applications/.ChatGPT.app.heige-official-stage-a",
    journalPath: "/tmp/app-repair.json",
    expectedBeforeAsarSha256: HASH_A,
    expectedOfficialAsarSha256: HASH_B,
  };
  assert.equal((await adapter.repair(input)).status, "repaired");
  assert.equal((await adapter.recover({ journalPath: input.journalPath })).action, "rollback");
  assert.deepEqual(calls.map(([kind]) => kind), ["repair", "recover"]);
});

test("install adapter delegates to the production macOS coordinator", async () => {
  const calls = [];
  const adapter = createProductionInstallAdapter({
    install: async (input) => { calls.push(input); return { status: "installed" }; },
  });
  const input = { sourceRoot: "/source", targetRoot: "/target", port: 9341 };
  assert.equal((await adapter.install(input)).status, "installed");
  assert.deepEqual(calls, [input]);
});

test("menu helpers inspect and operate the real switch and confirmation elements", async () => {
  const expressions = [];
  const states = [
    { origin: "app://-", switchPresent: true, role: "switch", checked: true, pending: false, revision: 4, helper: APPROVED_HELPER, confirmationHidden: true },
    { origin: "app://-", switchPresent: true, role: "switch", checked: true, pending: false, revision: 4, helper: APPROVED_HELPER, confirmationHidden: true },
    { origin: "app://-", switchPresent: true, role: "switch", checked: true, pending: false, revision: 4, helper: APPROVED_HELPER, confirmationHidden: false },
    { origin: "app://-", switchPresent: true, role: "switch", checked: true, pending: true, revision: 4, helper: APPROVED_HELPER, confirmationHidden: true },
    { origin: "app://-", switchPresent: true, role: "switch", checked: false, pending: false, revision: 5, helper: APPROVED_HELPER, confirmationHidden: true },
  ];
  const session = {
    async evaluate(expression) {
      expressions.push(expression);
      if (expression.includes("const snapshot")) {
        return {
          ...states.shift(),
          menuPresent: true,
          themeId: "miku-488137",
          generation: "a".repeat(32),
        };
      }
      return true;
    },
  };
  const before = await inspectPersistenceMenu(session);
  assert.equal(before.checked, true);
  const after = await setPersistenceViaMenu(session, false, { pollIntervalMs: 0, timeoutMs: 100 });
  assert.equal(after.checked, false);
  assert.equal(after.revision, 5);
  assert.ok(expressions.some((value) => value.includes("persistence-switch")));
  assert.ok(expressions.some((value) => value.includes("persistence-confirm")));
});

test("internal live workers accept only fixed SIGKILL boundaries and production paths", () => {
  const repair = validateLiveWorkerRequest({
    schemaVersion: 1,
    operation: "app-repair-sigkill",
    boundary: "after-target-published",
    currentAppPath: "/Applications/ChatGPT.app",
    stagedAppPath: "/Applications/.ChatGPT.app.heige-official-stage-a",
    journalPath: "/Users/example/Library/Application Support/HeiGeCodexSkinStudio/app-repair.json",
    expectedBeforeAsarSha256: HASH_A,
    expectedOfficialAsarSha256: HASH_B,
  }, { home: "/Users/example", repositoryRoot: "/repo" });
  assert.equal(repair.boundary, "after-target-published");
  assert.throws(() => validateLiveWorkerRequest({
    ...repair,
    boundary: "after-commit-decision",
  }, { home: "/Users/example", repositoryRoot: "/repo" }), /boundary/);

  const install = validateLiveWorkerRequest({
    schemaVersion: 1,
    operation: "install-sigkill",
    boundary: "services-frozen",
    sourceRoot: "/repo",
    targetRoot: "/Users/example/.codex/heige-codex-skin-studio",
    port: 9341,
  }, { home: "/Users/example", repositoryRoot: "/repo" });
  assert.equal(install.operation, "install-sigkill");
  assert.throws(() => validateLiveWorkerRequest({
    ...install,
    targetRoot: "/tmp/other",
  }, { home: "/Users/example", repositoryRoot: "/repo" }), /targetRoot/);
});

test("app repair aborts on post-preflight identity drift before quitting Codex", async () => {
  const current = identity({ signatureValid: false, teamIdentifier: null });
  const stage = identity({
    rootDev: "3",
    rootIno: "4",
    executableSha256: HASH_B,
    asarSha256: HASH_A,
  });
  const calls = [];
  await assert.rejects(runAppRepairRollbackThenClean({
    home: "/Users/example",
    preflight: {
      process: {
        pid: 4242,
        executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
        startedAt: "Fri Jul 17 09:00:00 2026",
      },
      app: {
        current: { path: "/Applications/ChatGPT.app", classification: "polluted", identity: current },
        stage: { path: "/Applications/.ChatGPT.app.heige-official-stage-a", identity: stage },
      },
    },
    adapters: {
      inspectApp: async (path) => {
        calls.push(["inspect", path]);
        return path === "/Applications/ChatGPT.app"
          ? { ...current, rootIno: "999" }
          : stage;
      },
      sameIdentity: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      quitCodex: async () => { calls.push(["quit"]); },
      spawnCrashWorker: async () => { calls.push(["worker"]); },
    },
  }), /identity drifted/);
  assert.equal(calls.some(([kind]) => kind === "quit"), false);
  assert.equal(calls.some(([kind]) => kind === "worker"), false);
});

test("crash cycle always recovers, verifies exact restoration, then performs clean mutation", async () => {
  const calls = [];
  const result = await runCrashRecoveryCycle({
    label: "appRepair",
    spawnCrashWorker: async () => { calls.push("worker"); return { code: null, signal: "SIGKILL" }; },
    recover: async () => { calls.push("recover"); return { recovered: true, action: "rollback" }; },
    verifyRestored: async () => { calls.push("verify"); return { exact: true }; },
    clean: async () => { calls.push("clean"); return { status: "repaired" }; },
    assertRecovery: (value) => value.recovered === true && value.action === "rollback",
  });
  assert.deepEqual(calls, ["worker", "recover", "verify", "clean"]);
  assert.equal(result.status, "PASS");
  assert.equal(result.sigkillObserved, true);

  const failedCalls = [];
  await assert.rejects(runCrashRecoveryCycle({
    label: "installer",
    spawnCrashWorker: async () => ({ code: 1, signal: null }),
    recover: async () => { failedCalls.push("recover"); return { recovered: true, decision: "rollback" }; },
    verifyRestored: async () => { failedCalls.push("verify"); return { exact: true }; },
    clean: async () => { failedCalls.push("clean"); },
    assertRecovery: () => true,
  }), /did not exit by SIGKILL/);
  assert.deepEqual(failedCalls, ["recover", "verify"]);
});

test("installer crash cycle revalidates the exact non-running legacy controller after rollback", async () => {
  const calls = [];
  const process = {
    pid: 4242,
    executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    startedAt: "Fri Jul 17 09:00:00 2026",
  };
  const prestate = {
    tree: { present: true, sha256: HASH_A },
    launcher: { present: true, sha256: HASH_B },
    stateFiles: {},
    services: {},
    legacyTheme: { present: true, sha256: HASH_A },
    digest: HASH_B,
  };
  const legacyController = {
    present: true,
    loaded: true,
    attribution: "legacy-hermes",
    running: false,
    plistMode: 0o600,
    plistSha256: HASH_A,
    nodeSha256: HASH_B,
    controllerSha256: HASH_A,
  };
  const result = await runInstallerRollbackThenClean({
    home: "/Users/example",
    sourceRoot: "/repo",
    targetRoot: "/Users/example/.codex/heige-codex-skin-studio",
    expectedProcess: process,
    initialThemeId: "miku-488137",
    adapters: {
      capturePrestate: async () => { calls.push("snapshot"); return structuredClone(prestate); },
      inspectLegacyController: async () => { calls.push("controller"); return structuredClone(legacyController); },
      spawnCrashWorker: async () => { calls.push("worker"); return { code: null, signal: "SIGKILL" }; },
      recover: async () => { calls.push("recover"); return { recovered: true, decision: "rollback" }; },
      inspectProcess: async () => ({ process }),
      inspectRenderer: async () => ({ menuPresent: true, themeId: "miku-488137" }),
      install: async () => { calls.push("install"); return { decision: "commit" }; },
    },
  });
  assert.equal(result.restored.exactLegacyController, true);
  assert.equal(result.restored.sameProcess, true);
  assert.deepEqual(calls, [
    "snapshot",
    "controller",
    "worker",
    "recover",
    "snapshot",
    "controller",
    "install",
  ]);
});

test("stable controller identity binds launchd PID and start time to the exact production command", () => {
  const nodePath = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node";
  const argumentsList = [
    nodePath,
    "/Users/example/.codex/heige-codex-skin-studio/src/cli.mjs",
    "controller",
    "--background",
    "--platform",
    "darwin",
    "--task-name",
    "com.heige.codex-skin-controller",
  ];
  const processIdentity = { pid: 5151, startedAt: "Fri Jul 17 09:00:00 2026" };
  const psOutput = ` 5151 Fri Jul 17 09:00:00 2026 ${argumentsList.join(" ")}\n`;
  assert.deepEqual(stableControllerProcessIdentity({
    processIdentity,
    psOutput,
    expectedArguments: argumentsList,
    nodePath,
  }), {
    ...processIdentity,
    executablePath: nodePath,
  });
  assert.throws(() => stableControllerProcessIdentity({
    processIdentity,
    psOutput: psOutput.replace("--background", "--ephemeral"),
    expectedArguments: argumentsList,
    nodePath,
  }), /exact stable command tuple/);
});

test("known installer residue manifest detects strict transaction siblings without traversing unrelated paths", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "heige-live-artifacts-")));
  const home = join(root, "home");
  const targetRoot = join(home, ".codex", "heige-codex-skin-studio");
  await mkdir(targetRoot, { recursive: true });
  await mkdir(join(home, "Applications"), { recursive: true });
  await mkdir(join(home, "Library", "Application Support", "HeiGeCodexSkinStudio"), { recursive: true });
  const before = await snapshotKnownInstallArtifacts({ home, targetRoot });
  const transactionId = "12345678-1234-4123-8123-123456789abc";
  const stage = `${targetRoot}.staged.${transactionId}`;
  await mkdir(stage);
  await writeFile(join(stage, "owned.txt"), "owned\n");
  const treeStagingLock = `${targetRoot}.install.lock.staging.${transactionId}`;
  const treeNestedRelease = `${targetRoot}.install.lock.released.${transactionId}.staging.${transactionId}`;
  const treeJournalTemp = `${targetRoot}.install-prepare.json.next.4242.${transactionId}`;
  await Promise.all([
    writeFile(treeStagingLock, "lock\n"),
    writeFile(treeNestedRelease, "release\n"),
    writeFile(treeJournalTemp, "journal\n"),
    writeFile(join(home, `.heige-codex-skin-launcher-prepare.json.4242.${transactionId}.tmp`), "prepare\n"),
    writeFile(join(home, "Applications", `.heige-codex-skin-launcher-transaction.json.4242.${transactionId}.tmp`), "launcher\n"),
    writeFile(join(home, "Library", "Application Support", "HeiGeCodexSkinStudio", `macos-install.json.next.4242.${transactionId}`), "outer\n"),
    writeFile(join(home, "Library", "Application Support", "HeiGeCodexSkinStudio", `stable-service-freeze.json.tmp.${transactionId}`), "freeze\n"),
    writeFile(join(home, "Library", "Application Support", "HeiGeCodexSkinStudio", `.state.json.tmp-4242-${transactionId}`), "state\n"),
  ]);
  await writeFile(join(dirname(targetRoot), "unrelated.staged.12345678-1234-4123-8123-123456789abc"), "ignore\n");
  const after = await snapshotKnownInstallArtifacts({ home, targetRoot });
  assert.notEqual(after.digest, before.digest);
  assert.deepEqual(after.dynamic.tree.map(({ name }) => name), [
    basename(treeJournalTemp),
    basename(treeNestedRelease),
    basename(treeStagingLock),
    basename(stage),
  ].sort());
  assert.equal(after.dynamic.launcher.length, 1);
  assert.equal(after.dynamic.home.length, 1);
  assert.equal(after.dynamic.state.length, 3);
});

test("launcher validation binds the exact plist entrypoint, bytes, modes, and directory schema", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "heige-live-launcher-")));
  const home = join(root, "home");
  const targetRoot = join(home, ".codex", "heige-codex-skin-studio");
  const appPath = join(home, "Applications", `${MACOS_LAUNCHER_NAME}.app`);
  const contents = join(appPath, "Contents");
  const macos = join(contents, "MacOS");
  const executablePath = join(macos, "HeiGe Skin Launcher");
  const plistPath = join(contents, "Info.plist");
  await mkdir(macos, { recursive: true, mode: 0o755 });
  await Promise.all([appPath, contents, macos].map((path) => chmod(path, 0o755)));
  await writeFile(
    executablePath,
    renderMacosLauncherExecutable(join(targetRoot, "scripts", "apply.command")),
    { mode: 0o755 },
  );
  await writeFile(plistPath, renderMacosLauncherPlist(targetRoot), { mode: 0o644 });
  await chmod(executablePath, 0o755);
  await chmod(plistPath, 0o644);
  const valid = await validateLauncherBundle({ home, targetRoot });
  assert.equal(valid.appPath, appPath);
  await writeFile(join(macos, "unowned-entrypoint"), "#!/bin/sh\n", { mode: 0o755 });
  await assert.rejects(validateLauncherBundle({ home, targetRoot }), /unowned extra content/);
});

test("lifecycle helper inspection attributes only the trusted stable node, helper, and action tuple", async () => {
  const nodePath = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node";
  const controllerPath = "/Users/example/.codex/heige-codex-skin-studio/src/cli.mjs";
  const action = "/Users/example/Library/Application Support/HeiGeCodexSkinStudio/lifecycle-12345678-1234-4123-8123-123456789abc.json";
  const exact = `${nodePath} /Users/example/.codex/heige-codex-skin-studio/src/lifecycle-helper.mjs ${action}`;
  const processes = await listLifecycleHelperProcesses({
    home: "/Users/example",
    inspectRuntime: async () => ({ nodePath, controllerPath }),
    run: async () => ({
      stdout: [
        ` 6001 Fri Jul 17 09:00:00 2026 ${exact}`,
        ` 6002 Fri Jul 17 09:00:01 2026 ${exact.replace(nodePath, "/tmp/node")}`,
        "",
      ].join("\n"),
    }),
  });
  assert.deepEqual(processes, [{
    pid: 6001,
    executablePath: nodePath,
    startedAt: "Fri Jul 17 09:00:00 2026",
  }]);
});

test("global CDP owners allow inherited listener FDs only inside the exact Codex process tree", async () => {
  const rootProcess = {
    pid: 7001,
    executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    startedAt: "Fri Jul 17 09:00:00 2026",
  };
  const stdout = [
    ` 7001 1 Fri Jul 17 09:00:00 2026 ${rootProcess.executablePath} --remote-debugging-port=9341`,
    " 7002 7001 Fri Jul 17 09:00:01 2026 /Users/example/.codex/computer-use/service",
    " 8001 1 Fri Jul 17 09:00:02 2026 /tmp/foreign",
    "",
  ].join("\n");
  const run = async () => ({ stdout });
  assert.deepEqual(await verifyCodexPortOwnerTree({
    rootProcess,
    ownerPids: [7001, 7002],
    run,
  }), { exactRoot: true, ownerCount: 2 });
  await assert.rejects(verifyCodexPortOwnerTree({
    rootProcess,
    ownerPids: [7001, 8001],
    run,
  }), /foreign owner/);
});

test("option 1 lifecycle enforces launcher session-only before explicit persistence enable", async () => {
  const calls = [];
  let revision = 7;
  let persistenceEnabled = true;
  const adapters = {
    requireMenu: async (expected) => { calls.push(["menu", expected]); return { checked: persistenceEnabled, revision }; },
    setMenuPersistence: async (enabled) => {
      calls.push(["set", enabled]);
      persistenceEnabled = enabled;
      revision += 1;
      return { checked: enabled, revision };
    },
    reloadSameProcess: async () => { calls.push(["reload"]); return { sameProcess: true, menuPresent: true, themeId: "miku-488137" }; },
    quitAndAssertControllerGone: async () => { calls.push(["quit"]); return { controllerGone: true }; },
    launchNativeAndAssert: async () => { calls.push(["native"]); return { cdpOwner: null, menuPresent: false }; },
    launchSessionAndAssert: async () => {
      calls.push(["launcher", persistenceEnabled]);
      return { cdpOwned: true, menuPresent: true, themeId: "miku-488137", persistenceEnabled, controllerRegistered: persistenceEnabled };
    },
    assertPersistentBackground: async () => ({ controlReachable: true, exactProcess: true, ephemeralExited: true }),
    pauseAndAssertStable: async () => { calls.push(["pause"]); return { paused: true, sameProcess: true, themeId: "miku-488137" }; },
    resumeAndAssert: async () => { calls.push(["resume"]); return { active: true, sameProcess: true, themeId: "miku-488137" }; },
    restoreAndAssertNative: async () => {
      calls.push(["restore"]);
      persistenceEnabled = false;
      revision += 1;
      return { native: true, persistenceEnabled: false };
    },
    readState: async () => ({ persistenceEnabled, revision }),
  };
  const result = await runOptionOneLifecycle({
    adapters,
    initialPersistenceEnabled: true,
    initialThemeId: "miku-488137",
  });
  assert.equal(result.status, "PASS");
  assert.deepEqual(Object.values(result.checks), Object.values(result.checks).map(() => "PASS"));
  assert.equal(result.finalPersistenceEnabled, true);
  assert.deepEqual(calls.filter(([kind]) => kind === "launcher"), [
    ["launcher", false],
    ["launcher", false],
  ]);
  assert.equal(calls.some(([kind, enabled]) => kind === "set" && enabled === true), true);
});

test("evidence writer commits report first and result JSON last with final report status", async () => {
  const writes = [];
  const result = { status: "PASS", checks: { menuSwitch: "PASS" } };
  const written = await writeAcceptanceEvidence({
    result,
    resultPath: "/run/result.json",
    reportPath: "/repo/docs/release/2026-07-16-macos-verification.md",
    write: async (path, body) => {
      writes.push([path, structuredClone(body)]);
      return { path, sha256: path.endsWith(".md") ? HASH_A : HASH_B, bytes: 1 };
    },
  });
  assert.deepEqual(writes.map(([path]) => path), [
    "/repo/docs/release/2026-07-16-macos-verification.md",
    "/run/result.json",
  ]);
  assert.equal(writes[1][1].reportWritten, true);
  assert.equal(writes[1][1].evidence.report.sha256, HASH_A);
  assert.equal(written.reportWritten, true);
});

test("failed acceptance runs recovery before writing final failure evidence", async () => {
  const calls = [];
  let captured;
  await assert.rejects(executeLiveAcceptance({
    execute: async () => { calls.push("execute"); throw Object.assign(new Error("primary"), { code: "PRIMARY" }); },
    recover: async () => { calls.push("recover"); return { status: "PASS", appRepair: "none" }; },
    writeEvidence: async (input) => {
      calls.push("evidence");
      captured = input.result;
      return { ...input.result, reportWritten: true };
    },
    resultPath: "/run/result.json",
    reportPath: "/repo/report.md",
  }), /primary/);
  assert.deepEqual(calls, ["execute", "recover", "evidence"]);
  assert.equal(captured.status, "FAIL");
  assert.equal(captured.failure.code, "PRIMARY");
  assert.equal(captured.recovery.status, "PASS");
});

test("incomplete recovery writes final evidence and then reports primary and recovery errors together", async () => {
  const primary = Object.assign(new Error("primary"), { code: "PRIMARY" });
  let captured;
  await assert.rejects(executeLiveAcceptance({
    execute: async () => { throw primary; },
    recover: async () => ({
      status: "FAIL",
      failures: [{ code: "ROLLBACK_FAILED", message: "rollback" }],
    }),
    writeEvidence: async (input) => { captured = input.result; return input.result; },
    resultPath: "/run/result.json",
    reportPath: "/repo/report.md",
  }), (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.deepEqual(error.errors.map(({ code }) => code), ["PRIMARY", "ROLLBACK_FAILED"]);
    return true;
  });
  assert.equal(captured.status, "FAIL");
  assert.equal(captured.recovery.status, "FAIL");
});

test("pre-mutation prerequisite failure records final evidence without running recovery", async () => {
  const error = Object.assign(new Error("persistence drift"), { code: "PREFERENCE_DRIFT" });
  let captured;
  const written = await recordPreMutationFailure({
    error,
    preflight: { mutationCount: 0 },
    resultPath: "/run/result.json",
    reportPath: "/repo/report.md",
    writeEvidence: async (input) => {
      captured = input;
      return { ...input.result, reportWritten: true };
    },
  });
  assert.equal(captured.result.status, "FAIL");
  assert.equal(captured.result.failure.code, "PREFERENCE_DRIFT");
  assert.equal(captured.result.recovery.status, "NOT_STARTED");
  assert.equal(captured.result.preflight.mutationCount, 0);
  assert.equal(written.reportWritten, true);
});

test("mutation single-flight holds one fixed product lock around the whole parent action", async () => {
  const calls = [];
  const result = await withLiveAcceptanceSingleFlight(async () => {
    calls.push("action");
    return "done";
  }, {
    home: "/Users/example",
    identityReader: async (pid) => ({ pid, startedAt: "Fri Jul 17 09:00:00 2026" }),
    lock: async (options, action) => {
      calls.push(["lock", options]);
      return action();
    },
  });
  assert.equal(result, "done");
  assert.equal(calls[0][0], "lock");
  assert.equal(calls[0][1].operation, "live-acceptance:rollback-then-clean");
  assert.equal(calls[0][1].lockPath, "/Users/example/Library/Application Support/HeiGeCodexSkinStudio/live-acceptance-operation/operation.lock");
  assert.equal(calls[1], "action");
});

test("durable live journal preserves the initial choice for parent hard-crash recovery", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "heige-live-journal-")));
  const home = join(root, "home");
  const directory = join(
    home,
    "Library",
    "Application Support",
    "HeiGeCodexSkinStudio",
    "live-acceptance-operation",
  );
  const path = join(directory, "live-migration.json");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const journal = {
    schemaVersion: 1,
    operation: "live-macos-acceptance",
    sequence: "rollback-then-clean",
    transactionId: "12345678-1234-4123-8123-123456789abc",
    phase: "running",
    initialPersistenceEnabled: true,
    initialThemeId: "miku-488137",
    createdAt: "2026-07-17T09:00:00.000Z",
    updatedAt: "2026-07-17T09:00:01.000Z",
  };
  await writeFile(path, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  assert.deepEqual(await readLiveAcceptanceJournal({ home }), journal);
  await chmod(path, 0o644);
  await assert.rejects(readLiveAcceptanceJournal({ home }), /mode 0600/);
});
