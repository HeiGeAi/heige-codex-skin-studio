import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  createStableServiceFreezeDescriptor,
  finalizeStableServiceFreezeRollback,
  finalizeStableServiceFreeze,
  finalizeLegacyWatchdogMigration,
  inspectLaunchAgent,
  inspectLaunchAgentProcessIdentity,
  migrateLegacyWatchdog,
  prepareStableServiceFreeze,
  registerControllerAgent,
  renderControllerPlist,
  rollbackLegacyWatchdogMigration,
  rollbackStableServiceFreeze,
  stopStableServiceFreezeForRollback,
  unregisterControllerAgent,
  wakeControllerAgent,
} from "../src/macos-launch-agent.mjs";

const CONTROLLER_LABEL = "com.heige.codex-skin-controller";
const LEGACY_LABEL = "com.heige.codex-skin-watchdog";
const UID = 501;
const execFileAsync = promisify(execFileCallback);

function renderedLabel(xml) {
  const match = String(xml).match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/);
  return match?.[1]
    ?.replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'") ?? null;
}

function xmlUnescape(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

function renderedProgramArguments(xml) {
  const array = String(xml).match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1];
  if (!array) return null;
  return [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => xmlUnescape(match[1]));
}

async function pathExists(path) {
  return stat(path).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}

function exchangePathBeforeMutation(deps, targetPath, foreignBytes, { attempt = 1 } = {}) {
  const originalRm = deps.fs.rm.bind(deps.fs);
  const originalRename = deps.fs.rename.bind(deps.fs);
  const originalLink = deps.fs.link.bind(deps.fs);
  let mutationAttempts = 0;
  let exchanged = false;
  const exchange = async (from, to) => {
    if (exchanged || (from !== targetPath && to !== targetPath)) return;
    mutationAttempts += 1;
    if (mutationAttempts !== attempt) return;
    exchanged = true;
    if (await pathExists(targetPath)) {
      await fsPromises.rename(targetPath, `${targetPath}.attacker-saved.${randomUUID()}`);
    }
    await writeFile(targetPath, foreignBytes, { mode: 0o600 });
  };
  deps.fs = {
    ...deps.fs,
    async rm(path, ...args) {
      await exchange(String(path), null);
      return originalRm(path, ...args);
    },
    async rename(from, to, ...args) {
      await exchange(String(from), String(to));
      return originalRename(from, to, ...args);
    },
    async link(from, to, ...args) {
      await exchange(String(from), String(to));
      return originalLink(from, to, ...args);
    },
  };
  return {
    get exchanged() {
      return exchanged;
    },
  };
}

function legacyPlistObject({
  root,
  label = LEGACY_LABEL,
  script = join(root, "scripts", "lib", "skin-watchdog.zsh"),
  environment = {},
  runAtLoad = true,
  startInterval = 15,
  abandonProcessGroup = true,
  port = "9341",
} = {}) {
  return {
    Label: label,
    ProgramArguments: ["/bin/zsh", script],
    EnvironmentVariables: {
      HEIGE_CODEX_SKIN_PORT: port,
      ...environment,
    },
    RunAtLoad: runAtLoad,
    StartInterval: startInterval,
    AbandonProcessGroup: abandonProcessGroup,
    StandardOutPath: environment.HEIGE_CODEX_SKIN_STATE
      ? join(environment.HEIGE_CODEX_SKIN_STATE, "watchdog.log")
      : join(root, "watchdog.log"),
  };
}

function legacyPlistBytes(plist) {
  return Buffer.from(`legacy plist fixture for ${plist.Label}\n`);
}

async function fixture(t, overrides = {}) {
  const base = await fsPromises.realpath(
    await mkdtemp(join(tmpdir(), "heige-launch-agent-")),
  );
  t.after(() => rm(base, { recursive: true, force: true }));

  const home = join(base, "home");
  const launchAgentsDir = join(home, "Library", "LaunchAgents");
  const stateDir = join(home, "Library", "Application Support", "HeiGeCodexSkinStudio");
  const stableInstallRoot = join(home, ".codex", "heige-codex-skin-studio");
  const controllerLabel = overrides.label ?? `${CONTROLLER_LABEL}.test.${randomUUID()}`;
  const oldLabel = overrides.oldLabel ?? `${LEGACY_LABEL}.test.${randomUUID()}`;
  const controllerPath = join(stableInstallRoot, "src", "cli.mjs");
  const nodePath = join(stableInstallRoot, "runtime", "node");
  const oldPlistPath = join(launchAgentsDir, `${oldLabel}.plist`);
  const controllerPlistPath = join(launchAgentsDir, `${controllerLabel}.plist`);
  const journalPath = join(stateDir, "launch-agent-migration.json");

  await fsPromises.mkdir(join(stableInstallRoot, "scripts", "lib"), { recursive: true });
  await fsPromises.mkdir(dirname(controllerPath), { recursive: true });
  await fsPromises.mkdir(dirname(nodePath), { recursive: true });
  await fsPromises.mkdir(launchAgentsDir, { recursive: true });
  await writeFile(join(stableInstallRoot, "scripts", "lib", "skin-watchdog.zsh"), "#!/bin/zsh\n");
  await writeFile(controllerPath, "// controller\n");
  await writeFile(nodePath, "#!/bin/sh\n", { mode: overrides.nodeMode ?? 0o755 });
  await fsPromises.chmod(nodePath, overrides.nodeMode ?? 0o755);

  const oldPlist = overrides.oldPlist ?? overrides.oldPlistFactory?.({ oldLabel }) ?? legacyPlistObject({
    root: stableInstallRoot,
    label: oldLabel,
    environment: overrides.oldEnvironment,
  });
  const originalPlistBytes = overrides.originalPlistBytes ?? legacyPlistBytes(oldPlist);
  await writeFile(oldPlistPath, originalPlistBytes, { mode: 0o640 });
  await fsPromises.chmod(oldPlistPath, 0o640);

  const loaded = new Set(overrides.oldLoaded === false ? [] : [oldLabel]);
  const commands = [];
  const touchedPaths = [];
  const chmodPaths = [];
  const openCalls = [];
  const deletedPaths = [];
  const parsedByPath = new Map([[oldPlistPath, oldPlist]]);
  let controllerBootstrapFailures = overrides.controllerBootstrapFailures ?? 0;

  const trackingFs = {
    ...fsPromises,
    async chmod(path, ...args) {
      touchedPaths.push(String(path));
      chmodPaths.push(String(path));
      return fsPromises.chmod(path, ...args);
    },
    async lstat(path, ...args) {
      touchedPaths.push(String(path));
      return fsPromises.lstat(path, ...args);
    },
    async mkdir(path, ...args) {
      touchedPaths.push(String(path));
      return fsPromises.mkdir(path, ...args);
    },
    async open(path, ...args) {
      touchedPaths.push(String(path));
      openCalls.push([String(path), ...args]);
      return fsPromises.open(path, ...args);
    },
    async readFile(path, ...args) {
      touchedPaths.push(String(path));
      return fsPromises.readFile(path, ...args);
    },
    async realpath(path, ...args) {
      touchedPaths.push(String(path));
      return fsPromises.realpath(path, ...args);
    },
    async rename(from, to, ...args) {
      touchedPaths.push(String(from), String(to));
      return fsPromises.rename(from, to, ...args);
    },
    async rm(path, ...args) {
      touchedPaths.push(String(path));
      deletedPaths.push(String(path));
      return fsPromises.rm(path, ...args);
    },
    async stat(path, ...args) {
      touchedPaths.push(String(path));
      return fsPromises.stat(path, ...args);
    },
    async writeFile(path, ...args) {
      touchedPaths.push(String(path));
      return fsPromises.writeFile(path, ...args);
    },
  };

  async function readPlist(path) {
    if (parsedByPath.has(path)) return structuredClone(parsedByPath.get(path));
    const xml = await readFile(path, "utf8");
    const label = renderedLabel(xml);
    if (!label) throw new Error(`unparseable plist: ${path}`);
    return {
      Label: label,
      ProgramArguments: renderedProgramArguments(xml) ?? [nodePath, controllerPath, "controller"],
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
      ProcessType: "Background",
      StandardOutPath: join(stateDir, "controller.log"),
      StandardErrorPath: join(stateDir, "controller.error.log"),
    };
  }

  async function execFile(file, args) {
    commands.push([file, ...args]);
    if (file === nodePath && args.length === 1 && args[0] === "--version") {
      return { stdout: `${overrides.nodeVersion ?? "v22.17.0"}\n`, stderr: "" };
    }
    if (file === nodePath && args[0] === "--input-type=module" && args[1] === "--eval") {
      if (overrides.nodeHealthFailure) throw overrides.nodeHealthFailure;
      const nonce = args.at(-1);
      const health = typeof overrides.nodeHealth === "function"
        ? overrides.nodeHealth({ nonce, nodePath, controllerPath })
        : overrides.nodeHealth ?? {
        nonce,
        pid: 4242,
        execPath: nodePath,
        version: overrides.nodeVersion ?? "v22.17.0",
        release: "node",
        controllerPath,
        };
      return { stdout: `${JSON.stringify(health)}\n`, stderr: "" };
    }
    if (file === "/usr/bin/plutil" && args[0] === "-lint") {
      if (overrides.lintFailure) throw new Error("lint failed");
      if (overrides.swapStagedAfterLint) {
        await writeFile(args.at(-1), "foreign staged plist\n");
      }
      if (overrides.swapStateAfterLint) {
        const support = dirname(stateDir);
        const moved = join(home, "moved-state-after-lint");
        await fsPromises.rename(support, moved);
        await symlink(moved, support);
      }
      if (overrides.swapLaunchAgentsAfterLint) {
        const moved = join(home, "moved-launch-agents-after-lint");
        await fsPromises.rename(launchAgentsDir, moved);
        await symlink(moved, launchAgentsDir);
      }
      return { stdout: `${args.at(-1)}: OK\n`, stderr: "" };
    }
    if (file !== "/bin/launchctl") throw new Error(`unexpected command: ${file}`);
    if (args[0] === "print") {
      const label = args[1].split("/").at(-1);
      if (loaded.has(label)) {
        const pid = overrides.printPid?.(label);
        return {
          stdout: `service = ${label}\n${pid === undefined ? "" : `pid = ${pid}\n`}`,
          stderr: "",
        };
      }
      if (overrides.printError) throw overrides.printError({ label, target: args[1] });
      const stderr = `Bad request.\nCould not find service "${label}" in domain for user gui: ${UID}\n`;
      const error = new Error(`Command failed: /bin/launchctl print ${args[1]}\n${stderr}`);
      error.code = 113;
      error.stdout = "";
      error.stderr = stderr;
      throw error;
    }
    if (args[0] === "bootstrap") {
      const path = args[2];
      const label = path === oldPlistPath
        ? oldLabel
        : renderedLabel(await readFile(path, "utf8"));
      if (overrides.failOldBootstrap && label === oldLabel) {
        throw new Error("old bootstrap failed");
      }
      if (label === controllerLabel && controllerBootstrapFailures > 0) {
        controllerBootstrapFailures -= 1;
        throw new Error("controller bootstrap failed");
      }
      loaded.add(label);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "bootout") {
      const label = args[1].split("/").at(-1);
      loaded.delete(label);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "kickstart") {
      const label = args.at(-1).split("/").at(-1);
      if (!loaded.has(label)) throw new Error("kickstart target is not loaded");
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected launchctl action: ${args[0]}`);
  }

  return {
    home,
    launchAgentsDir,
    stateDir,
    stableInstallRoot,
    legacyRoots: [stableInstallRoot],
    controllerPath,
    nodePath,
    label: controllerLabel,
    oldLabel,
    oldPlistPath,
    controllerPlistPath,
    journalPath,
    processUid: UID,
    testMode: true,
    fs: trackingFs,
    execFile,
    readPlist,
    originalPlistBytes,
    commands,
    loaded,
    touchedPaths,
    chmodPaths,
    openCalls,
    deletedPaths,
    faultAt: overrides.faultAt,
    hardCrashAt: overrides.hardCrashAt,
    rollbackFaultAt: overrides.rollbackFaultAt,
    processExists: overrides.processExists,
    wait: overrides.wait,
  };
}

async function installKnownHermesController(deps, {
  extraArguments = [],
  nodeVersion = "v22.17.0",
  symlinkNode = false,
  mode = 0o640,
} = {}) {
  const hermesNode = join(deps.home, ".hermes", "node", "bin", "node");
  await fsPromises.mkdir(dirname(hermesNode), { recursive: true });
  if (symlinkNode) {
    const backing = join(deps.home, ".hermes", "node", "bin", "node-real");
    await writeFile(backing, "#!/bin/sh\n", { mode: 0o755 });
    await fsPromises.chmod(backing, 0o755);
    await symlink(backing, hermesNode);
  } else {
    await writeFile(hermesNode, "#!/bin/sh\n", { mode: 0o755 });
    await fsPromises.chmod(hermesNode, 0o755);
  }
  const bytes = Buffer.from(renderControllerPlist({
    label: deps.label,
    programArguments: [hermesNode, deps.controllerPath, "controller", ...extraArguments],
    stateDir: deps.stateDir,
  }));
  await writeFile(deps.controllerPlistPath, bytes, { mode });
  await fsPromises.chmod(deps.controllerPlistPath, mode);
  deps.loaded.add(deps.label);
  const originalExecFile = deps.execFile;
  deps.execFile = async (file, args) => {
    if (file === hermesNode && args[0] === "--input-type=module" && args[1] === "--eval") {
      const nonce = args.at(-1);
      return {
        stdout: `${JSON.stringify({
          nonce,
          pid: 4343,
          execPath: hermesNode,
          version: nodeVersion,
          release: "node",
          controllerPath: deps.controllerPath,
        })}\n`,
        stderr: "",
      };
    }
    return originalExecFile(file, args);
  };
  return { bytes, hermesNode, mode };
}

async function outerMigrationJournal(deps, { decision = "undecided" } = {}) {
  const transactionId = randomUUID();
  const journalPath = join(deps.stateDir, `outer-migration-${transactionId}.json`);
  await fsPromises.mkdir(deps.stateDir, { recursive: true });
  let document = {
    schemaVersion: 1,
    product: "heige-codex-skin-studio",
    operation: "legacy-migration",
    transactionId,
    revision: 0,
    nonce: randomUUID(),
    previousNonce: null,
    decision,
    phase: decision === "commit" ? "commit-decided" : "prepared",
    createdAt: new Date().toISOString(),
    ack: decision === "commit" ? {
      persistenceEnabled: true,
      revision: 1,
      processIdentity: { pid: 8301, startedAt: "Fri Jul 17 16:50:00 2026" },
    } : null,
    stateParticipant: null,
    serviceParticipant: null,
  };
  const write = async () => {
    await writeFile(journalPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
    await fsPromises.chmod(journalPath, 0o600);
  };
  await write();
  return {
    outerTransaction: { transactionId, journalPath },
    async bind(participant) {
      document = {
        ...document,
        previousNonce: document.nonce,
        nonce: randomUUID(),
        revision: document.revision + 1,
        serviceParticipant: participant,
        phase: "service-prepared",
      };
      await write();
    },
    async acknowledge() {
      document = {
        ...document,
        previousNonce: document.nonce,
        nonce: randomUUID(),
        revision: document.revision + 1,
        phase: "ready-acked",
        ack: {
          persistenceEnabled: true,
          revision: 1,
          processIdentity: { pid: 8301, startedAt: "Fri Jul 17 16:50:00 2026" },
        },
      };
      await write();
    },
    async decide(nextDecision) {
      document = {
        ...document,
        previousNonce: document.nonce,
        nonce: randomUUID(),
        revision: document.revision + 1,
        decision: nextDecision,
        phase: `${nextDecision}-decided`,
        ack: nextDecision === "commit" ? {
          persistenceEnabled: true,
          revision: 1,
          processIdentity: { pid: 8301, startedAt: "Fri Jul 17 16:50:00 2026" },
        } : document.ack,
      };
      await write();
    },
  };
}

async function outerMacosInstallJournal(deps) {
  const transactionId = randomUUID();
  const journalPath = join(deps.stateDir, `outer-macos-${transactionId}.json`);
  await fsPromises.mkdir(deps.stateDir, { recursive: true });
  let document = {
    schemaVersion: 1,
    product: "heige-codex-skin-studio",
    operation: "macos-install",
    transactionId,
    revision: 0,
    nonce: randomUUID(),
    previousNonce: null,
    decision: "undecided",
    phase: "freeze-intent",
    createdAt: new Date().toISOString(),
    sourceRoot: deps.stableInstallRoot,
    targetRoot: deps.stableInstallRoot,
    home: deps.home,
    stateRoot: deps.stateDir,
    activation: "pending",
    treeParticipant: null,
    launcherParticipant: null,
    stateParticipant: null,
    freezeParticipant: null,
    ack: null,
  };
  const write = async () => {
    await writeFile(journalPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
    await fsPromises.chmod(journalPath, 0o600);
  };
  await write();
  return {
    outerTransaction: { transactionId, journalPath },
    async bind(participant) {
      document = {
        ...document,
        previousNonce: document.nonce,
        nonce: randomUUID(),
        revision: document.revision + 1,
        freezeParticipant: participant,
      };
      await write();
    },
    async decide(nextDecision) {
      document = {
        ...document,
        previousNonce: document.nonce,
        nonce: randomUUID(),
        revision: document.revision + 1,
        decision: nextDecision,
        phase: `${nextDecision}-decided`,
      };
      await write();
    },
    async markFreezeRollbackRestored() {
      document = {
        ...document,
        previousNonce: document.nonce,
        nonce: randomUUID(),
        revision: document.revision + 1,
        decision: "rollback",
        phase: "freeze-rollback-restored",
      };
      await write();
    },
  };
}

test("test mode refuses both production labels", async (t) => {
  const deps = await fixture(t);
  for (const label of [LEGACY_LABEL, CONTROLLER_LABEL]) {
    await assert.rejects(
      registerControllerAgent({ ...deps, label, testMode: true }),
      /production label/i,
    );
  }
  await assert.rejects(
    inspectLaunchAgent({ ...deps, label: CONTROLLER_LABEL, testMode: true }),
    /production label/i,
  );
});

test("launch-agent process ACK binds both launchd PID and process start time", async (t) => {
  const deps = await fixture(t, { printPid: () => 8201 });
  deps.loaded.add(deps.label);
  const observed = await inspectLaunchAgentProcessIdentity({
    ...deps,
    readProcessIdentity: async (pid) => ({
      pid,
      startedAt: "Fri Jul 17 16:40:00 2026",
    }),
  });
  assert.deepEqual(observed, {
    pid: 8201,
    startedAt: "Fri Jul 17 16:40:00 2026",
  });
});

test("launch-agent process ACK fails closed when launchd replaces the PID during inspection", async (t) => {
  let calls = 0;
  const deps = await fixture(t, { printPid: () => (++calls < 2 ? 8201 : 8202) });
  deps.loaded.add(deps.label);
  assert.equal(await inspectLaunchAgentProcessIdentity({
    ...deps,
    readProcessIdentity: async (pid) => ({ pid, startedAt: `start-${pid}` }),
  }), null);
});

test("test mode accepts only a random isolated controller label", async (t) => {
  const deps = await fixture(t);
  await assert.rejects(
    registerControllerAgent({ ...deps, label: `${CONTROLLER_LABEL}.test.fixed`, testMode: true }),
    /random UUID/i,
  );
});

test("test-mode migration refuses to address the production legacy label", async (t) => {
  const deps = await fixture(t);
  await assert.rejects(
    migrateLegacyWatchdog({ ...deps, oldLabel: LEGACY_LABEL }),
    /test mode requires a random UUID legacy label/i,
  );
  assert.equal(deps.commands.some((command) => command[0] === "/bin/launchctl"), false);
});

test("controller plist is escaped and encodes a failure-only background job", () => {
  const xml = renderControllerPlist({
    label: `${CONTROLLER_LABEL}.test.123e4567-e89b-42d3-a456-426614174000`,
    programArguments: ["/Users/a&b<c>/node", "/Users/a&b<c>/cli.mjs", "controller"],
    stateDir: "/Users/a&b<c>/state",
  });

  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(xml, /<key>ProcessType<\/key>\s*<string>Background<\/string>/);
  assert.match(xml, /\/Users\/a&amp;b&lt;c&gt;\/node/);
  assert.doesNotMatch(xml, /\/Users\/a&b<c>/);
  assert.match(xml, /controller\.log/);
  assert.match(xml, /controller\.error\.log/);
});

test("controller plist rejects relative executable and log paths", () => {
  assert.throws(
    () => renderControllerPlist({
      label: CONTROLLER_LABEL,
      programArguments: ["node", "/stable/cli.mjs", "controller"],
      stateDir: "/stable/state",
    }),
    /absolute/,
  );
  assert.throws(
    () => renderControllerPlist({
      label: CONTROLLER_LABEL,
      programArguments: ["/stable/node", "/stable/cli.mjs", "controller"],
      stateDir: "relative/state",
    }),
    /absolute/,
  );
  assert.throws(
    () => renderControllerPlist({
      label: CONTROLLER_LABEL,
      nodePath: "/stable/node",
      controllerPath: "cli.mjs",
      stateDir: "/stable/state",
    }),
    /controllerPath.*absolute/i,
  );
});

test("trusted production home ignores a forged HOME environment value", async () => {
  const module = await import("../src/macos-launch-agent.mjs");
  assert.equal(typeof module.trustedUserHome, "function");
  const previous = process.env.HOME;
  process.env.HOME = "/tmp/forged-home";
  try {
    assert.equal(module.trustedUserHome(), userInfo().homedir);
    assert.notEqual(module.trustedUserHome(), process.env.HOME);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
});

test("production registration cannot replace the stable controller entrypoint", async () => {
  await assert.rejects(
    registerControllerAgent({
      programArguments: ["/bin/sh", "/tmp/hostile-script"],
    }),
    /stable controller entrypoint/i,
  );
});

test("production mode fixes homedir uid and platform dependencies to the current process", async () => {
  await assert.rejects(
    registerControllerAgent({
      home: "/tmp/redirected-home",
      nodePath: "/bin/sh",
      controllerPath: "/tmp/controller.mjs",
    }),
    /production platform context cannot be overridden/i,
  );
  await assert.rejects(
    registerControllerAgent({
      processUid: 0,
      nodePath: "/bin/sh",
      controllerPath: "/tmp/controller.mjs",
    }),
    /production platform context cannot be overridden/i,
  );
  await assert.rejects(
    registerControllerAgent({
      fs: fsPromises,
      execFile: async () => ({ stdout: "", stderr: "" }),
      nodePath: "/bin/sh",
      controllerPath: "/tmp/controller.mjs",
    }),
    /production platform context cannot be overridden/i,
  );
  await assert.rejects(
    migrateLegacyWatchdog({ legacyRoots: ["/tmp/self-declared-legacy"] }),
    /production platform context cannot be overridden/i,
  );
  await assert.rejects(
    registerControllerAgent({
      nodePath: "/bin/sh",
      controllerPath: join(userInfo().homedir, ".codex", "heige-codex-skin-studio", "src", "cli.mjs"),
    }),
    /production platform context cannot be overridden/i,
  );
});

test("runtime validation requires Node 22 plus regular canonical executable files", async (t) => {
  await t.test("old Node", async (t) => {
    const deps = await fixture(t, { nodeVersion: "v21.7.3" });
    deps.loaded.clear();
    await assert.rejects(registerControllerAgent(deps), /Node 22 or newer/i);
    assert.equal(await pathExists(deps.controllerPlistPath), false);
  });

  await t.test("non-executable Node", async (t) => {
    const deps = await fixture(t, { nodeMode: 0o644 });
    deps.loaded.clear();
    await assert.rejects(registerControllerAgent(deps), /regular executable/i);
    assert.equal(await pathExists(deps.controllerPlistPath), false);
  });

  await t.test("controller symlink escape", async (t) => {
    const deps = await fixture(t);
    deps.loaded.clear();
    const outside = join(deps.home, "outside-controller.mjs");
    await writeFile(outside, "// foreign controller\n");
    await rm(deps.controllerPath);
    await symlink(outside, deps.controllerPath);
    await assert.rejects(registerControllerAgent(deps), /stable controller entrypoint/i);
    assert.equal(await pathExists(deps.controllerPlistPath), false);
  });

  await t.test("health response without a PID", async (t) => {
    const deps = await fixture(t, {
      nodeHealth: ({ nonce, nodePath, controllerPath }) => ({
        nonce,
        execPath: nodePath,
        version: "v22.17.0",
        release: "node",
        controllerPath,
      }),
    });
    deps.loaded.clear();
    await assert.rejects(registerControllerAgent(deps), /health.*PID/i);
    assert.equal(await pathExists(deps.controllerPlistPath), false);
  });

  await t.test("version-printing shell cannot impersonate a healthy Node runtime", async (t) => {
    const deps = await fixture(t, {
      nodeHealthFailure: new Error("shell does not implement the module health probe"),
    });
    deps.loaded.clear();
    await assert.rejects(registerControllerAgent(deps), /health probe failed/i);
    assert.equal(await pathExists(deps.controllerPlistPath), false);
  });

  await t.test("controller JavaScript must import successfully in the real runtime probe", async (t) => {
    const deps = await fixture(t, {
      nodeHealthFailure: new SyntaxError("invalid controller JavaScript"),
    });
    deps.loaded.clear();
    await assert.rejects(registerControllerAgent(deps), /health probe failed/i);
    assert.equal(await pathExists(deps.controllerPlistPath), false);
  });

  await t.test("a real version-printing shell fails the module health probe", async (t) => {
    const deps = await fixture(t);
    deps.loaded.clear();
    await writeFile(deps.nodePath, "#!/bin/sh\nprintf 'v22.17.0\\n'\n", { mode: 0o755 });
    await fsPromises.chmod(deps.nodePath, 0o755);
    deps.execFile = execFileAsync;
    await assert.rejects(registerControllerAgent(deps), /health probe failed/i);
    assert.equal(await pathExists(deps.controllerPlistPath), false);
  });

  await t.test("invalid JavaScript is rejected by an actual Node process", async (t) => {
    const deps = await fixture(t);
    deps.loaded.clear();
    await writeFile(deps.controllerPath, "export const = invalid syntax;\n");
    deps.nodePath = process.execPath;
    deps.execFile = execFileAsync;
    await assert.rejects(registerControllerAgent(deps), /health probe failed/i);
    assert.equal(await pathExists(deps.controllerPlistPath), false);
  });
});

test("launchctl not-found detection requires matching code target and native semantics", async (t) => {
  for (const [name, printError] of [
    ["permission denial", ({ target }) => Object.assign(
      new Error(`Permission denied while printing ${target}`),
      { code: 113, stderr: "Operation not permitted\n" },
    )],
    ["wrong label", () => Object.assign(
      new Error("Could not find service \"example.foreign\" in domain for user gui: 501"),
      { code: 113, stderr: "Could not find service \"example.foreign\" in domain for user gui: 501\n" },
    )],
    ["wrong domain", ({ label }) => Object.assign(
      new Error(`Could not find service \"${label}\" in domain for user gui: 502`),
      { code: 113, stderr: `Could not find service \"${label}\" in domain for user gui: 502\n` },
    )],
    ["semantic match with wrong code", ({ label }) => Object.assign(
      new Error(`Could not find service \"${label}\" in domain for user gui: 501`),
      { code: 77, stderr: `Could not find service \"${label}\" in domain for user gui: 501\n` },
    )],
    ["native absence mixed with a policy error", ({ label, target }) => {
      const stderr = `Bad request.\nCould not find service \"${label}\" in domain for user gui: 501\nOperation not permitted\n`;
      return Object.assign(
        new Error(`Command failed: /bin/launchctl print ${target}\n${stderr}`),
        { code: 113, stdout: "", stderr },
      );
    }],
  ]) {
    await t.test(name, async (t) => {
      const deps = await fixture(t, { printError });
      deps.loaded.clear();
      await assert.rejects(registerControllerAgent(deps), (error) => error.code !== undefined);
      assert.equal(await pathExists(deps.controllerPlistPath), false);
    });
  }
});

test("register writes private files, lints, bootstraps and verifies gui uid state", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();

  const result = await registerControllerAgent(deps);

  assert.deepEqual(result, {
    label: deps.label,
    plistPath: deps.controllerPlistPath,
    loaded: true,
  });
  assert.equal((await stat(deps.stateDir)).mode & 0o777, 0o700);
  assert.equal((await stat(deps.controllerPlistPath)).mode & 0o777, 0o600);
  assert.deepEqual(deps.commands.filter(([file]) => file === "/bin/launchctl"), [
    ["/bin/launchctl", "print", `gui/${UID}/${deps.label}`],
    ["/bin/launchctl", "bootstrap", `gui/${UID}`, deps.controllerPlistPath],
    ["/bin/launchctl", "print", `gui/${UID}/${deps.label}`],
  ]);
  const lintIndex = deps.commands.findIndex((command) =>
    command[0] === "/usr/bin/plutil" && command[1] === "-lint"
  );
  const bootstrapIndex = deps.commands.findIndex((command) =>
    command[0] === "/bin/launchctl" && command[1] === "bootstrap"
  );
  assert.match(deps.commands[lintIndex][2], new RegExp(
    `^${deps.controllerPlistPath.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.staged\\.`,
  ));
  assert.equal(lintIndex < bootstrapIndex, true, "lint must finish before publish/bootstrap");
  assert.equal(await pathExists(deps.commands[lintIndex][2]), false);
  assert.equal(deps.chmodPaths.includes(deps.controllerPlistPath), false);
});

test("register keeps one fixed background command across revision drift", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  await registerControllerAgent({
    ...deps,
    revision: 7,
    transitionNonce: "controller-transition-9",
  });
  const plist = await deps.readPlist(deps.controllerPlistPath);
  assert.deepEqual(plist.ProgramArguments.slice(-5), [
    "--background",
    "--platform",
    "darwin",
    "--task-name",
    deps.label,
  ]);
  assert.equal(plist.ProgramArguments.includes("--handshake-revision"), false);
  assert.equal(plist.ProgramArguments.includes("controller-transition-9"), false);
  const removed = await unregisterControllerAgent(deps);
  assert.equal(removed.loaded, false);
});

test("wake uses launchctl kickstart and verifies the exact job remains loaded", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  await registerControllerAgent(deps);
  deps.commands.length = 0;
  assert.deepEqual(await wakeControllerAgent(deps), {
    label: deps.label,
    loaded: true,
    woken: true,
  });
  assert.deepEqual(deps.commands, [
    ["/bin/launchctl", "print", `gui/${UID}/${deps.label}`],
    ["/bin/launchctl", "kickstart", "-k", `gui/${UID}/${deps.label}`],
    ["/bin/launchctl", "print", `gui/${UID}/${deps.label}`],
  ]);
});

test("register leaves an existing loaded controller byte-for-byte intact when staged lint fails", async (t) => {
  const deps = await fixture(t, { lintFailure: true });
  const previous = Buffer.from(renderControllerPlist({
    label: deps.label,
    programArguments: [deps.nodePath, deps.controllerPath, "controller"],
    stateDir: deps.stateDir,
  }));
  await writeFile(deps.controllerPlistPath, previous, { mode: 0o640 });
  await fsPromises.chmod(deps.controllerPlistPath, 0o640);
  deps.loaded.add(deps.label);

  await assert.rejects(registerControllerAgent(deps), /lint failed/);
  assert.deepEqual(await readFile(deps.controllerPlistPath), previous);
  assert.equal((await stat(deps.controllerPlistPath)).mode & 0o777, 0o640);
  assert.equal(deps.loaded.has(deps.label), true);
});

test("register refuses a staged plist swapped during lint", async (t) => {
  const deps = await fixture(t, { swapStagedAfterLint: true });
  deps.loaded.clear();
  await assert.rejects(
    registerControllerAgent(deps),
    (error) => error.code === "FILE_CHANGED_DURING_VALIDATION",
  );
  assert.equal(await pathExists(deps.controllerPlistPath), false);
  assert.equal(deps.commands.some((command) => command[1] === "bootstrap"), false);
});

test("staged creation never overwrites a path created at the publish syscall", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  const foreign = Buffer.from("foreign staged creation race\n");
  const originalLink = deps.fs.link.bind(deps.fs);
  let attackedPath;
  deps.fs = {
    ...deps.fs,
    async link(from, to, ...args) {
      if (!attackedPath && String(to).includes(".staged.")) {
        attackedPath = String(to);
        await writeFile(attackedPath, foreign, { mode: 0o600 });
      }
      return originalLink(from, to, ...args);
    },
  };

  await assert.rejects(
    registerControllerAgent(deps),
    (error) => error.code === "FILE_CAPABILITY_CONFLICT",
  );
  assert.equal(typeof attackedPath, "string");
  assert.deepEqual(await readFile(attackedPath), foreign);
  assert.equal(await pathExists(deps.controllerPlistPath), false);
});

test("register restores an existing loaded controller when replacement bootstrap fails", async (t) => {
  const deps = await fixture(t, { controllerBootstrapFailures: 1 });
  const previous = Buffer.from(renderControllerPlist({
    label: deps.label,
    programArguments: [deps.nodePath, deps.controllerPath, "controller"],
    stateDir: deps.stateDir,
  }));
  await writeFile(deps.controllerPlistPath, previous, { mode: 0o640 });
  await fsPromises.chmod(deps.controllerPlistPath, 0o640);
  deps.loaded.add(deps.label);

  await assert.rejects(registerControllerAgent(deps), /controller bootstrap failed/);
  assert.deepEqual(await readFile(deps.controllerPlistPath), previous);
  assert.equal((await stat(deps.controllerPlistPath)).mode & 0o777, 0o640);
  assert.equal(deps.loaded.has(deps.label), true);
});

test("register fails closed when a loaded controller has no restorable canonical plist", async (t) => {
  const deps = await fixture(t);
  deps.loaded.add(deps.label);
  await assert.rejects(
    registerControllerAgent(deps),
    (error) => error.code === "CONTROLLER_PRESTATE_INVALID",
  );
  assert.equal(deps.loaded.has(deps.label), true);
  assert.equal(await pathExists(deps.controllerPlistPath), false);
});

test("register refuses to overwrite a foreign plist at the canonical controller path", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  const foreign = Buffer.from("foreign controller plist\n");
  await writeFile(deps.controllerPlistPath, foreign, { mode: 0o600 });
  const readPlist = async (path) => path === deps.controllerPlistPath
    ? { Label: "example.foreign.agent" }
    : deps.readPlist(path);
  await assert.rejects(
    registerControllerAgent({ ...deps, readPlist }),
    /controller plist attribution failed/i,
  );
  assert.deepEqual(await readFile(deps.controllerPlistPath), foreign);
});

test("register does not roll back over a plist swapped after attribution", async (t) => {
  const deps = await fixture(t);
  const previous = Buffer.from(renderControllerPlist({
    label: deps.label,
    programArguments: [deps.nodePath, deps.controllerPath, "controller"],
    stateDir: deps.stateDir,
  }));
  const foreign = Buffer.from("swapped foreign plist\n");
  await writeFile(deps.controllerPlistPath, previous, { mode: 0o600 });
  deps.loaded.add(deps.label);
  const readPlist = async (path) => {
    const parsed = await deps.readPlist(path);
    if (path === deps.controllerPlistPath) await writeFile(path, foreign);
    return parsed;
  };

  await assert.rejects(
    registerControllerAgent({ ...deps, readPlist }),
    (error) => error.code === "FILE_CHANGED_DURING_VALIDATION",
  );
  assert.deepEqual(await readFile(deps.controllerPlistPath), foreign);
  assert.equal(deps.loaded.has(deps.label), true);
  assert.equal(deps.commands.some((command) => command[1] === "bootout"), false);
});

test("register never overwrites a path exchanged at the publish syscall", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  const foreign = Buffer.from("foreign publish race\n");
  const exchange = exchangePathBeforeMutation(deps, deps.controllerPlistPath, foreign);

  await assert.rejects(
    registerControllerAgent(deps),
    (error) => error.code === "FILE_CAPABILITY_CONFLICT",
  );
  assert.equal(exchange.exchanged, true);
  assert.deepEqual(await readFile(deps.controllerPlistPath), foreign);
  assert.equal(deps.loaded.has(deps.label), false);
});

test("registration rollback never overwrites a path exchanged at restore", async (t) => {
  const deps = await fixture(t, { controllerBootstrapFailures: 1 });
  deps.loaded.clear();
  const foreign = Buffer.from("foreign rollback race\n");
  const exchange = exchangePathBeforeMutation(
    deps,
    deps.controllerPlistPath,
    foreign,
    { attempt: 2 },
  );

  await assert.rejects(
    registerControllerAgent(deps),
    (error) => error.code === "REGISTRATION_ROLLBACK_FAILED",
  );
  assert.equal(exchange.exchanged, true);
  assert.deepEqual(await readFile(deps.controllerPlistPath), foreign);
});

test("inspect reports plist identity and verified launchctl state", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  await registerControllerAgent(deps);

  const inspection = await inspectLaunchAgent(deps);
  assert.equal(inspection.label, deps.label);
  assert.equal(inspection.plistPath, deps.controllerPlistPath);
  assert.equal(inspection.plistExists, true);
  assert.equal(inspection.plistLabel, deps.label);
  assert.equal(inspection.loaded, true);
});

test("the plist reader parses immutable snapshot bytes through plutil", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  await registerControllerAgent(deps);
  deps.commands.length = 0;
  const execFile = async (file, args) => {
    if (file === "/usr/bin/plutil" && args[0] === "-convert") {
      deps.commands.push([file, ...args]);
      return { stdout: JSON.stringify({ Label: deps.label }), stderr: "" };
    }
    return deps.execFile(file, args);
  };

  const inspection = await inspectLaunchAgent({
    ...deps,
    execFile,
    readPlist: undefined,
  });
  assert.equal(inspection.plistLabel, deps.label);
  assert.deepEqual(deps.commands[0].slice(0, 5), [
    "/usr/bin/plutil",
    "-convert",
    "json",
    "-o",
    "-",
  ]);
  assert.match(
    deps.commands[0][5],
    new RegExp(`^${deps.controllerPlistPath.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.validated\\.`),
  );
  assert.notEqual(deps.commands[0][5], deps.controllerPlistPath);
  assert.equal(await pathExists(deps.commands[0][5]), false);
});

test("the plist reader rejects its immutable parse copy being swapped", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  await registerControllerAgent(deps);
  let parseCopyPath;
  const execFile = async (file, args) => {
    if (file === "/usr/bin/plutil" && args[0] === "-convert") {
      parseCopyPath = args.at(-1);
      await writeFile(args.at(-1), "swapped parse copy\n");
      return { stdout: JSON.stringify({ Label: deps.label }), stderr: "" };
    }
    return deps.execFile(file, args);
  };

  await assert.rejects(
    inspectLaunchAgent({ ...deps, execFile, readPlist: undefined }),
    (error) => error.code === "FILE_CHANGED_DURING_VALIDATION",
  );
  assert.equal(await readFile(parseCopyPath, "utf8"), "swapped parse copy\n");
});

test("unregister verifies absence and deletes only its matching generated plist", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  await registerControllerAgent(deps);
  deps.commands.length = 0;

  const result = await unregisterControllerAgent(deps);
  assert.deepEqual(result, {
    label: deps.label,
    plistPath: deps.controllerPlistPath,
    loaded: false,
    removed: true,
  });
  assert.equal(await pathExists(deps.controllerPlistPath), false);
  assert.deepEqual(deps.commands.filter(([file]) => file === "/bin/launchctl"), [
    ["/bin/launchctl", "print", `gui/${UID}/${deps.label}`],
    ["/bin/launchctl", "bootout", `gui/${UID}/${deps.label}`],
    ["/bin/launchctl", "print", `gui/${UID}/${deps.label}`],
  ]);
});

test("unregister refuses to delete a plist owned by another label", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  await fsPromises.mkdir(dirname(deps.controllerPlistPath), { recursive: true });
  await writeFile(deps.controllerPlistPath, "foreign\n");
  const readPlist = async (path) => path === deps.controllerPlistPath
    ? { Label: "example.foreign.agent" }
    : deps.readPlist(path);

  await assert.rejects(
    unregisterControllerAgent({ ...deps, readPlist }),
    (error) => error.code === "CONTROLLER_PRESTATE_INVALID",
  );
  assert.equal(await pathExists(deps.controllerPlistPath), true);
});

test("unregister verifies the complete generated tuple before bootout or deletion", async (t) => {
  const deps = await fixture(t);
  const bytes = Buffer.from("same label but foreign tuple\n");
  await writeFile(deps.controllerPlistPath, bytes, { mode: 0o600 });
  deps.loaded.add(deps.label);
  const readPlist = async (path) => path === deps.controllerPlistPath
    ? {
      Label: deps.label,
      ProgramArguments: ["/bin/sh", "/tmp/foreign"],
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
      ProcessType: "Background",
      StandardOutPath: join(deps.stateDir, "controller.log"),
      StandardErrorPath: join(deps.stateDir, "controller.error.log"),
    }
    : deps.readPlist(path);

  await assert.rejects(
    unregisterControllerAgent({ ...deps, readPlist }),
    (error) => error.code === "CONTROLLER_PRESTATE_INVALID",
  );
  assert.equal(deps.loaded.has(deps.label), true);
  assert.deepEqual(await readFile(deps.controllerPlistPath), bytes);
  assert.equal(deps.commands.some((command) => command[1] === "bootout"), false);
});

test("unregister rejects unknown plist keys and KeepAlive extensions", async (t) => {
  for (const [name, mutate] of [
    ["unknown top-level key", (plist) => ({ ...plist, ThrottleInterval: 1 })],
    ["KeepAlive extension", (plist) => ({
      ...plist,
      KeepAlive: { ...plist.KeepAlive, OtherJobEnabled: { "example.foreign": true } },
    })],
  ]) {
    await t.test(name, async (t) => {
      const deps = await fixture(t);
      deps.loaded.clear();
      await registerControllerAgent(deps);
      deps.loaded.add(deps.label);
      const readPlist = async (path) => path === deps.controllerPlistPath
        ? mutate(await deps.readPlist(path))
        : deps.readPlist(path);

      await assert.rejects(
        unregisterControllerAgent({ ...deps, readPlist }),
        (error) => error.code === "CONTROLLER_PRESTATE_INVALID",
      );
      assert.equal(deps.loaded.has(deps.label), true);
      assert.equal(await pathExists(deps.controllerPlistPath), true);
      assert.equal(deps.commands.filter((command) => command[1] === "bootout").length, 0);
    });
  }
});

test("unregister fails closed when the label is loaded without a trusted canonical plist", async (t) => {
  const deps = await fixture(t);
  deps.loaded.add(deps.label);
  await assert.rejects(
    unregisterControllerAgent(deps),
    (error) => error.code === "CONTROLLER_PRESTATE_INVALID",
  );
  assert.equal(deps.loaded.has(deps.label), true);
  assert.equal(deps.commands.some((command) => command[1] === "bootout"), false);
});

test("unregister detects a canonical plist swap after attribution", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  await registerControllerAgent(deps);
  const foreign = Buffer.from("swapped foreign plist\n");
  const readPlist = async (path) => {
    const parsed = await deps.readPlist(path);
    if (path === deps.controllerPlistPath) await writeFile(path, foreign);
    return parsed;
  };

  await assert.rejects(
    unregisterControllerAgent({ ...deps, readPlist }),
    (error) => error.code === "FILE_CHANGED_DURING_VALIDATION",
  );
  assert.equal(deps.loaded.has(deps.label), true);
  assert.deepEqual(await readFile(deps.controllerPlistPath), foreign);
});

test("unregister never deletes a path exchanged at the remove syscall", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  await registerControllerAgent(deps);
  const foreign = Buffer.from("foreign remove race\n");
  const exchange = exchangePathBeforeMutation(deps, deps.controllerPlistPath, foreign);

  await assert.rejects(
    unregisterControllerAgent(deps),
    (error) => error.code === "FILE_CAPABILITY_CONFLICT",
  );
  assert.equal(exchange.exchanged, true);
  assert.deepEqual(await readFile(deps.controllerPlistPath), foreign);
});

test("legacy migration removes only a fully attributed old plist", async (t) => {
  const deps = await fixture(t);
  const result = await migrateLegacyWatchdog(deps);

  assert.deepEqual(result, {
    legacyFound: true,
    legacyRemoved: true,
    controllerRegistered: true,
  });
  assert.equal(deps.loaded.has(deps.oldLabel), false);
  assert.equal(deps.loaded.has(deps.label), true);
  assert.equal(await pathExists(deps.oldPlistPath), false);
  assert.equal(await pathExists(deps.controllerPlistPath), true);
  assert.equal(await pathExists(deps.journalPath), false);
  assert.deepEqual(
    deps.deletedPaths.filter((path) => path === deps.oldPlistPath),
    [],
    "the validated legacy inode is quarantined before deletion",
  );
  const firstWritableOpen = deps.openCalls.find(([, flags]) => /[wax+]/.test(String(flags)));
  assert.deepEqual(firstWritableOpen?.slice(0, 2), [deps.journalPath, "wx"]);
});

test("deferred legacy migration consumes the exact-ACK outer schema before commit", async (t) => {
  const deps = await fixture(t);
  const outer = await outerMigrationJournal(deps);
  const result = await migrateLegacyWatchdog({
    ...deps,
    deferCommit: true,
    outerTransaction: outer.outerTransaction,
  });

  assert.equal(result.legacyFound, true);
  assert.equal(result.legacyLoadedBefore, true);
  assert.equal(typeof result.transaction, "object");
  assert.equal(await pathExists(deps.journalPath), true);
  assert.equal(result.legacyRemoved, false);
  assert.equal(await pathExists(deps.oldPlistPath), true);
  assert.equal(deps.loaded.has(deps.oldLabel), true);
  assert.equal(deps.loaded.has(deps.label), true);

  await outer.bind(result.transaction);
  await outer.decide("commit");
  await finalizeLegacyWatchdogMigration(
    JSON.parse(JSON.stringify(result.transaction)),
    deps,
  );
  assert.equal(await pathExists(deps.journalPath), false);
  assert.equal(await pathExists(deps.oldPlistPath), false);
  assert.equal(deps.loaded.has(deps.label), true);
});

test("deferred legacy migration rollback accepts the ACK-bearing outer rollback schema", async (t) => {
  const deps = await fixture(t);
  const outer = await outerMigrationJournal(deps);
  const result = await migrateLegacyWatchdog({
    ...deps,
    deferCommit: true,
    outerTransaction: outer.outerTransaction,
  });

  await outer.bind(result.transaction);
  await outer.acknowledge();
  await outer.decide("rollback");
  await rollbackLegacyWatchdogMigration(
    JSON.parse(JSON.stringify(result.transaction)),
    deps,
  );

  assert.equal(await pathExists(deps.journalPath), false);
  assert.deepEqual(await readFile(deps.oldPlistPath), deps.originalPlistBytes);
  assert.equal((await stat(deps.oldPlistPath)).mode & 0o777, 0o640);
  assert.equal(deps.loaded.has(deps.oldLabel), true);
  assert.equal(await pathExists(deps.controllerPlistPath), false);
  assert.equal(deps.loaded.has(deps.label), false);
});

test("a durable outer commit decision rolls forward after a crash before participant finalize", async (t) => {
  const deps = await fixture(t);
  const outer = await outerMigrationJournal(deps);
  await migrateLegacyWatchdog({
    ...deps,
    deferCommit: true,
    outerTransaction: outer.outerTransaction,
  }).then((result) => outer.bind(result.transaction));
  await outer.decide("commit");

  const recovered = await migrateLegacyWatchdog(deps);

  assert.deepEqual(recovered, {
    legacyFound: false,
    legacyRemoved: false,
    controllerRegistered: false,
  });
  assert.equal(await pathExists(deps.journalPath), false);
  assert.equal(await pathExists(deps.oldPlistPath), false);
  assert.equal(deps.loaded.has(deps.oldLabel), false);
  assert.equal(await pathExists(deps.controllerPlistPath), true);
  assert.equal(deps.loaded.has(deps.label), true);
});

test("register is inode-stable when the exact fixed controller is already loaded", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  await registerControllerAgent(deps);
  const before = await stat(deps.controllerPlistPath);
  deps.commands.length = 0;

  await registerControllerAgent(deps);

  const after = await stat(deps.controllerPlistPath);
  assert.equal(after.ino, before.ino);
  assert.equal(deps.commands.some((command) => ["bootstrap", "bootout"].includes(command[1])), false);
});

test("stable service freeze stops both attributed jobs and rollback restores their exact prestate", async (t) => {
  const deps = await fixture(t);
  await registerControllerAgent(deps);
  const controllerBytes = await readFile(deps.controllerPlistPath);
  const outer = await outerMacosInstallJournal(deps);
  const descriptor = await createStableServiceFreezeDescriptor({
    ...deps,
    outerTransaction: outer.outerTransaction,
  });
  const frozen = await prepareStableServiceFreeze({
    ...deps,
    outerTransaction: outer.outerTransaction,
  });
  await outer.bind(descriptor);

  assert.deepEqual(frozen.transaction, descriptor);
  assert.equal(frozen.servicesFrozen, 2);
  assert.equal(deps.loaded.has(deps.label), false);
  assert.equal(deps.loaded.has(deps.oldLabel), false);
  assert.equal(await pathExists(deps.controllerPlistPath), false);
  assert.equal(await pathExists(deps.oldPlistPath), false);

  await outer.decide("rollback");
  await rollbackStableServiceFreeze(JSON.parse(JSON.stringify(descriptor)), deps);
  assert.equal(deps.loaded.has(deps.label), true);
  assert.equal(deps.loaded.has(deps.oldLabel), true);
  assert.deepEqual(await readFile(deps.controllerPlistPath), controllerBytes);
  assert.deepEqual(await readFile(deps.oldPlistPath), deps.originalPlistBytes);
  assert.equal(await pathExists(join(deps.stateDir, "stable-service-freeze.json")), true);
  await outer.markFreezeRollbackRestored();
  await finalizeStableServiceFreezeRollback(descriptor, deps);
  assert.equal(await pathExists(join(deps.stateDir, "stable-service-freeze.json")), false);
});

test("stable service freeze hard crash restores both old jobs only after outer rollback", async (t) => {
  const deps = await fixture(t);
  await registerControllerAgent(deps);
  const outer = await outerMacosInstallJournal(deps);
  const descriptor = await createStableServiceFreezeDescriptor({
    ...deps,
    outerTransaction: outer.outerTransaction,
  });
  await outer.bind(descriptor);
  await assert.rejects(
    prepareStableServiceFreeze({
      ...deps,
      hardCrashAt: "after-controller-freeze",
      outerTransaction: outer.outerTransaction,
    }),
    /SIMULATED_HARD_CRASH/,
  );
  assert.equal(deps.loaded.has(deps.label), false);
  assert.equal(deps.loaded.has(deps.oldLabel), true);

  await outer.decide("rollback");
  await rollbackStableServiceFreeze(JSON.parse(JSON.stringify(descriptor)), deps);
  assert.equal(deps.loaded.has(deps.label), true);
  assert.equal(deps.loaded.has(deps.oldLabel), true);
});

test("stable service freeze waits for every captured launchd PID to exit", async (t) => {
  const probes = new Map();
  const deps = await fixture(t, {
    printPid: (label) => label.includes("controller") ? 8101 : 8102,
    processExists: (pid) => {
      const count = probes.get(pid) ?? 0;
      probes.set(pid, count + 1);
      return count === 0;
    },
    wait: async () => {},
  });
  await registerControllerAgent(deps);
  const outer = await outerMacosInstallJournal(deps);
  await prepareStableServiceFreeze({
    ...deps,
    outerTransaction: outer.outerTransaction,
  });
  assert.equal(probes.get(8101), 2);
  assert.equal(probes.get(8102), 2);
});

test("stable service freeze finalize never revives the old watchdog after outer commit", async (t) => {
  const deps = await fixture(t);
  await registerControllerAgent(deps);
  const outer = await outerMacosInstallJournal(deps);
  const frozen = await prepareStableServiceFreeze({
    ...deps,
    outerTransaction: outer.outerTransaction,
  });
  await outer.bind(frozen.transaction);
  await registerControllerAgent(deps);
  deps.commands.length = 0;
  await outer.decide("commit");
  await finalizeStableServiceFreeze(
    JSON.parse(JSON.stringify(frozen.transaction)),
    deps,
  );
  assert.equal(deps.loaded.has(deps.label), true, "the committed new controller remains running");
  assert.equal(deps.loaded.has(deps.oldLabel), false, "the old watchdog is never revived");
  assert.equal(
    deps.commands.some((command) => command[1] === "bootout" && command[2].endsWith(`/${deps.label}`)),
    false,
    "finalize must preserve the ACKed controller process",
  );
  assert.equal(await pathExists(join(deps.stateDir, "stable-service-freeze.json")), false);
});

test("stable service freeze rollback restores an overwritten Hermes controller byte-for-byte", async (t) => {
  const deps = await fixture(t);
  const legacy = await installKnownHermesController(deps, { mode: 0o640 });
  const outer = await outerMacosInstallJournal(deps);
  const descriptor = await createStableServiceFreezeDescriptor({
    ...deps,
    outerTransaction: outer.outerTransaction,
  });
  await outer.bind(descriptor);
  await prepareStableServiceFreeze({
    ...deps,
    outerTransaction: outer.outerTransaction,
  });
  await registerControllerAgent(deps);
  assert.notDeepEqual(await readFile(deps.controllerPlistPath), legacy.bytes);

  await outer.decide("rollback");
  await stopStableServiceFreezeForRollback(descriptor, deps);
  await rollbackStableServiceFreeze(descriptor, deps);

  assert.deepEqual(await readFile(deps.controllerPlistPath), legacy.bytes);
  assert.equal((await stat(deps.controllerPlistPath)).mode & 0o777, 0o640);
  assert.equal(deps.loaded.has(deps.label), true);
  assert.equal(deps.loaded.has(deps.oldLabel), true);
});

test("ordinary registration still refuses an existing Hermes controller without an outer freeze", async (t) => {
  const deps = await fixture(t);
  const legacy = await installKnownHermesController(deps, { mode: 0o640 });

  await assert.rejects(
    registerControllerAgent(deps),
    (error) => error.code === "CONTROLLER_PRESTATE_INVALID",
  );

  assert.deepEqual(await readFile(deps.controllerPlistPath), legacy.bytes);
  assert.equal((await stat(deps.controllerPlistPath)).mode & 0o777, 0o640);
  assert.equal(deps.loaded.has(deps.label), true);
});

test("non-persistent freeze commit removes every trusted old service", async (t) => {
  const deps = await fixture(t);
  await registerControllerAgent(deps);
  const outer = await outerMacosInstallJournal(deps);
  const descriptor = await createStableServiceFreezeDescriptor({
    ...deps,
    outerTransaction: outer.outerTransaction,
  });
  await outer.bind(descriptor);
  await prepareStableServiceFreeze({
    ...deps,
    outerTransaction: outer.outerTransaction,
  });
  await outer.decide("commit");

  await finalizeStableServiceFreeze(descriptor, {
    ...deps,
    removeFrozenServices: true,
  });

  assert.equal(await pathExists(deps.controllerPlistPath), false);
  assert.equal(await pathExists(deps.oldPlistPath), false);
  assert.equal(deps.loaded.has(deps.label), false);
  assert.equal(deps.loaded.has(deps.oldLabel), false);
});

test("freeze rollback is idempotent when no pre-existing service journal exists", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  await rm(deps.oldPlistPath);
  const outer = await outerMacosInstallJournal(deps);
  const descriptor = await createStableServiceFreezeDescriptor({
    ...deps,
    outerTransaction: outer.outerTransaction,
  });
  await outer.bind(descriptor);
  const frozen = await prepareStableServiceFreeze({
    ...deps,
    outerTransaction: outer.outerTransaction,
  });
  assert.equal(frozen.transaction, null);
  await registerControllerAgent(deps);
  await outer.decide("rollback");

  await stopStableServiceFreezeForRollback(descriptor, deps);
  await rollbackStableServiceFreeze(descriptor, deps);

  assert.equal(await pathExists(deps.controllerPlistPath), false);
  assert.equal(deps.loaded.has(deps.label), false);
});

for (const prestate of ["both", "watchdog-only", "controller-only", "none"]) {
  test(`stable service freeze preserves the exact ${prestate} prestate on rollback`, async (t) => {
    const deps = await fixture(t);
    let controller = null;
    if (["both", "controller-only"].includes(prestate)) {
      controller = await installKnownHermesController(deps, { mode: 0o640 });
    }
    if (["controller-only", "none"].includes(prestate)) {
      deps.loaded.delete(deps.oldLabel);
      await rm(deps.oldPlistPath);
    }
    const outer = await outerMacosInstallJournal(deps);
    const descriptor = await createStableServiceFreezeDescriptor({
      ...deps,
      outerTransaction: outer.outerTransaction,
    });
    await outer.bind(descriptor);
    await prepareStableServiceFreeze({
      ...deps,
      outerTransaction: outer.outerTransaction,
    });
    assert.equal(await pathExists(deps.controllerPlistPath), false);
    assert.equal(await pathExists(deps.oldPlistPath), false);
    assert.equal(deps.loaded.size, 0);

    await outer.decide("rollback");
    await rollbackStableServiceFreeze(descriptor, deps);
    await outer.markFreezeRollbackRestored();
    await finalizeStableServiceFreezeRollback(descriptor, deps);
    await finalizeStableServiceFreezeRollback(descriptor, deps);

    assert.equal(await pathExists(deps.controllerPlistPath), controller !== null);
    assert.equal(await pathExists(deps.oldPlistPath), ["both", "watchdog-only"].includes(prestate));
    assert.equal(deps.loaded.has(deps.label), controller !== null);
    assert.equal(deps.loaded.has(deps.oldLabel), ["both", "watchdog-only"].includes(prestate));
    if (controller !== null) {
      assert.deepEqual(await readFile(deps.controllerPlistPath), controller.bytes);
      assert.equal((await stat(deps.controllerPlistPath)).mode & 0o777, 0o640);
    }
  });

  test(`persistent commit replaces the exact ${prestate} prestate with one controller`, async (t) => {
    const deps = await fixture(t);
    if (["both", "controller-only"].includes(prestate)) {
      await installKnownHermesController(deps, { mode: 0o640 });
    }
    if (["controller-only", "none"].includes(prestate)) {
      deps.loaded.delete(deps.oldLabel);
      await rm(deps.oldPlistPath);
    }
    const outer = await outerMacosInstallJournal(deps);
    const descriptor = await createStableServiceFreezeDescriptor({
      ...deps,
      outerTransaction: outer.outerTransaction,
    });
    await outer.bind(descriptor);
    await prepareStableServiceFreeze({
      ...deps,
      outerTransaction: outer.outerTransaction,
    });
    await registerControllerAgent(deps);
    await outer.decide("commit");
    await finalizeStableServiceFreeze(descriptor, deps);

    assert.equal(await pathExists(deps.controllerPlistPath), true);
    assert.equal(await pathExists(deps.oldPlistPath), false);
    assert.equal(deps.loaded.has(deps.label), true);
    assert.equal(deps.loaded.has(deps.oldLabel), false);
  });
}

test("stable service freeze refuses a foreign loaded controller before stopping either job", async (t) => {
  const deps = await fixture(t);
  const foreign = renderControllerPlist({
    label: deps.label,
    programArguments: ["/foreign/node", "/foreign/cli.mjs", "controller"],
    stateDir: deps.stateDir,
  });
  await writeFile(deps.controllerPlistPath, foreign, { mode: 0o600 });
  deps.loaded.add(deps.label);
  const outer = await outerMigrationJournal(deps);

  await assert.rejects(
    prepareStableServiceFreeze({
      ...deps,
      outerTransaction: outer.outerTransaction,
    }),
    (error) => error.code === "CONTROLLER_PRESTATE_INVALID",
  );
  assert.equal(deps.loaded.has(deps.label), true);
  assert.equal(deps.loaded.has(deps.oldLabel), true);
  assert.equal(
    deps.commands.some((command) => command[1] === "bootout"),
    false,
  );
});

test("migration fails closed when the legacy label is loaded without its canonical plist", async (t) => {
  const deps = await fixture(t);
  await rm(deps.oldPlistPath);
  await assert.rejects(
    migrateLegacyWatchdog(deps),
    (error) => error.code === "LEGACY_PRESTATE_INVALID",
  );
  assert.equal(deps.loaded.has(deps.oldLabel), true);
  assert.equal(deps.loaded.has(deps.label), false);
  assert.equal(deps.commands.some((command) => command[1] === "bootout"), false);
});

test("migration creates its recovery journal exclusively and never overwrites an unfinished one", async (t) => {
  const deps = await fixture(t);
  await fsPromises.mkdir(deps.stateDir, { recursive: true });
  const unfinished = Buffer.from('{"schemaVersion":2,"phase":"rollback-failed"}\n');
  await writeFile(deps.journalPath, unfinished, { mode: 0o600 });
  deps.commands.length = 0;

  await assert.rejects(
    migrateLegacyWatchdog(deps),
    (error) => error.code === "MIGRATION_INCOMPLETE",
  );
  assert.deepEqual(await readFile(deps.journalPath), unfinished);
  assert.deepEqual(await readFile(deps.oldPlistPath), deps.originalPlistBytes);
  assert.equal(deps.loaded.has(deps.oldLabel), true);
  assert.equal(deps.loaded.has(deps.label), false);
  assert.equal(deps.commands.some((command) => ["bootstrap", "bootout"].includes(command[1])), false);
});

test("every journal update uses nonce and inode CAS without overwriting a replacement", async (t) => {
  const deps = await fixture(t);
  const foreign = Buffer.from('{"foreign":true}\n');
  const originalRename = deps.fs.rename.bind(deps.fs);
  const originalLink = deps.fs.link.bind(deps.fs);
  let exchanged = false;
  const exchange = async (from, to) => {
    if (!exchanged && (from === deps.journalPath || to === deps.journalPath)) {
      exchanged = true;
      await rm(deps.journalPath, { force: true });
      await writeFile(deps.journalPath, foreign, { mode: 0o600 });
    }
  };
  deps.fs = {
    ...deps.fs,
    async rename(from, to, ...args) {
      await exchange(String(from), String(to));
      return originalRename(from, to, ...args);
    },
    async link(from, to, ...args) {
      await exchange(String(from), String(to));
      return originalLink(from, to, ...args);
    },
  };

  await assert.rejects(
    migrateLegacyWatchdog(deps),
    (error) => error.code === "JOURNAL_CONFLICT",
  );
  assert.equal(exchanged, true);
  assert.deepEqual(await readFile(deps.journalPath), foreign);
  assert.deepEqual(await readFile(deps.oldPlistPath), deps.originalPlistBytes);
  assert.equal(deps.loaded.has(deps.oldLabel), true);
  assert.equal(deps.loaded.has(deps.label), false);
  assert.equal(deps.commands.some((command) => ["bootstrap", "bootout"].includes(command[1])), false);
});

test("migration refuses an oversized recovery snapshot before creating a journal", async (t) => {
  const oversized = Buffer.alloc(256 * 1024 + 1, 0x61);
  const deps = await fixture(t, { originalPlistBytes: oversized });
  deps.commands.length = 0;
  await assert.rejects(
    migrateLegacyWatchdog(deps),
    (error) => error.code === "PLIST_BACKUP_TOO_LARGE",
  );
  assert.equal(await pathExists(deps.journalPath), false);
  assert.equal(deps.commands.some((command) => ["bootstrap", "bootout"].includes(command[1])), false);
});

test("migration never deletes or restores over a legacy plist exchanged at removal", async (t) => {
  const deps = await fixture(t);
  const foreign = Buffer.from("foreign legacy removal race\n");
  const exchange = exchangePathBeforeMutation(deps, deps.oldPlistPath, foreign);

  await assert.rejects(
    migrateLegacyWatchdog(deps),
    (error) => error.code === "MIGRATION_ROLLBACK_FAILED",
  );
  assert.equal(exchange.exchanged, true);
  assert.deepEqual(await readFile(deps.oldPlistPath), foreign);
});

test("polluted legacy state and log paths are never followed or deleted", async (t) => {
  const polluted = "/tmp/a&b<c>d";
  const deps = await fixture(t, {
    oldEnvironment: { HEIGE_CODEX_SKIN_STATE: polluted },
  });

  await migrateLegacyWatchdog(deps);

  assert.equal(deps.touchedPaths.some((path) => path === polluted || path.startsWith(`${polluted}/`)), false);
  assert.equal(deps.deletedPaths.some((path) => path === polluted || path.startsWith(`${polluted}/`)), false);
});

test("temporary or unapproved watchdog executable paths fail attribution closed", async (t) => {
  const temporary = await fixture(t, {
    oldPlistFactory: ({ oldLabel }) => legacyPlistObject({
      root: "/tmp/hostile-root",
      label: oldLabel,
    }),
  });
  await assert.rejects(migrateLegacyWatchdog(temporary), /legacy attribution/i);
  assert.equal(await pathExists(temporary.oldPlistPath), true);

  const unknown = await fixture(t, {
    oldPlistFactory: ({ oldLabel }) => legacyPlistObject({
      root: "/Users/unknown/repository",
      label: oldLabel,
    }),
  });
  await assert.rejects(migrateLegacyWatchdog(unknown), /legacy attribution/i);
  assert.equal(await pathExists(unknown.oldPlistPath), true);
});

test("legacy attribution rejects canonical plist and executable symlink escapes", async (t) => {
  await t.test("canonical legacy plist symlink", async (t) => {
    const deps = await fixture(t);
    const backing = join(deps.home, "legacy-backing.plist");
    await writeFile(backing, deps.originalPlistBytes);
    await rm(deps.oldPlistPath);
    await symlink(backing, deps.oldPlistPath);
    await assert.rejects(migrateLegacyWatchdog(deps), /non-regular file|attribution/i);
    assert.equal(deps.loaded.has(deps.label), false);
  });

  await t.test("watchdog file symlink", async (t) => {
    const deps = await fixture(t);
    const script = join(deps.stableInstallRoot, "scripts", "lib", "skin-watchdog.zsh");
    const outside = join(deps.home, "outside-watchdog.zsh");
    await writeFile(outside, "#!/bin/zsh\n");
    await rm(script);
    await symlink(outside, script);
    await assert.rejects(migrateLegacyWatchdog(deps), /legacy attribution/i);
    assert.equal(deps.loaded.has(deps.label), false);
  });

  await t.test("watchdog ancestor symlink", async (t) => {
    const deps = await fixture(t);
    const scripts = join(deps.stableInstallRoot, "scripts");
    const outside = join(deps.home, "outside-scripts");
    await fsPromises.mkdir(join(outside, "lib"), { recursive: true });
    await writeFile(join(outside, "lib", "skin-watchdog.zsh"), "#!/bin/zsh\n");
    await rm(scripts, { recursive: true });
    await symlink(outside, scripts);
    await assert.rejects(migrateLegacyWatchdog(deps), /legacy attribution/i);
    assert.equal(deps.loaded.has(deps.label), false);
  });
});

test("register refuses a symlink at the canonical controller plist", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  const backing = join(deps.home, "controller-backing.plist");
  await writeFile(backing, "foreign\n");
  await symlink(backing, deps.controllerPlistPath);
  await assert.rejects(registerControllerAgent(deps), /non-regular file/);
  assert.equal(await readFile(backing, "utf8"), "foreign\n");
});

test("state directory rejects every symlinked ancestor", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  const applicationSupport = dirname(deps.stateDir);
  const outside = join(deps.home, "outside-state-root");
  await fsPromises.mkdir(outside, { recursive: true });
  await symlink(outside, applicationSupport);

  await assert.rejects(
    registerControllerAgent(deps),
    (error) => error.code === "STATE_PATH_UNTRUSTED",
  );
  assert.equal(await pathExists(deps.controllerPlistPath), false);
});

test("state directory rejects an ancestor exchanged during secure creation", async (t) => {
  const deps = await fixture(t);
  deps.loaded.clear();
  const applicationSupport = dirname(deps.stateDir);
  const movedSupport = join(deps.home, "moved-application-support");
  const originalMkdir = deps.fs.mkdir.bind(deps.fs);
  let exchanged = false;
  deps.fs = {
    ...deps.fs,
    async mkdir(path, options) {
      const result = await originalMkdir(path, options);
      if (!exchanged && path === deps.stateDir) {
        exchanged = true;
        await fsPromises.rename(applicationSupport, movedSupport);
        await symlink(movedSupport, applicationSupport);
      }
      return result;
    },
  };

  await assert.rejects(
    registerControllerAgent(deps),
    (error) => error.code === "STATE_PATH_UNTRUSTED",
  );
  assert.equal(await pathExists(deps.controllerPlistPath), false);
});

test("state directory capability is revalidated immediately before publish", async (t) => {
  const deps = await fixture(t, { swapStateAfterLint: true });
  deps.loaded.clear();

  await assert.rejects(
    registerControllerAgent(deps),
    (error) => error.code === "STATE_PATH_UNTRUSTED",
  );
  assert.equal(await pathExists(deps.controllerPlistPath), false);
  assert.equal(deps.commands.some((command) => command[1] === "bootstrap"), false);
});

test("LaunchAgents ancestor capability is revalidated immediately before publish", async (t) => {
  const deps = await fixture(t, { swapLaunchAgentsAfterLint: true });
  deps.loaded.clear();

  await assert.rejects(
    registerControllerAgent(deps),
    (error) => error.code === "LAUNCH_AGENTS_PATH_UNTRUSTED",
  );
  assert.equal(await pathExists(deps.controllerPlistPath), false);
  assert.equal(deps.commands.some((command) => command[1] === "bootstrap"), false);
});

for (const [field, value] of [
  ["Label", "example.foreign"],
  ["ProgramArguments", ["/bin/zsh", "/tmp/skin-watchdog.zsh"]],
  ["RunAtLoad", false],
  ["StartInterval", 30],
  ["AbandonProcessGroup", false],
  ["EnvironmentVariables", { HEIGE_CODEX_SKIN_PORT: "9342" }],
]) {
  test(`legacy attribution rejects mismatched ${field}`, async (t) => {
    const deps = await fixture(t);
    const source = await deps.readPlist(deps.oldPlistPath);
    const readPlist = async (path) => path === deps.oldPlistPath
      ? { ...source, [field]: value }
      : deps.readPlist(path);
    await assert.rejects(
      migrateLegacyWatchdog({ ...deps, readPlist }),
      /legacy attribution/i,
    );
    assert.equal(deps.loaded.has(deps.oldLabel), true);
    assert.equal(deps.loaded.has(deps.label), false);
    assert.deepEqual(await readFile(deps.oldPlistPath), deps.originalPlistBytes);
  });
}

const MIGRATION_BOUNDARIES = [
  "after-journal",
  "after-new-stage",
  "after-new-lint",
  "after-new-publish",
  "after-new-bootstrap",
  "after-new-verify",
  "after-old-bootout",
  "after-old-verify",
  "after-old-remove",
];

const DURABLE_MIGRATION_BOUNDARIES = [
  "after-journal",
  "after-new-stage",
  "after-new-lint",
  "after-new-publish",
  "after-new-bootstrap",
  "after-new-verify",
  "after-old-bootout",
  "after-old-verify",
  "after-old-remove",
];

for (const hardCrashAt of DURABLE_MIGRATION_BOUNDARIES) {
  test(`next migration durably recovers a hard crash after ${hardCrashAt}`, async (t) => {
    const deps = await fixture(t, { hardCrashAt, oldLoaded: true });
    await assert.rejects(
      migrateLegacyWatchdog(deps),
      (error) => error.code === "SIMULATED_HARD_CRASH" && error.phase === hardCrashAt,
    );
    assert.equal(await pathExists(deps.journalPath), true);

    await assert.rejects(
      migrateLegacyWatchdog({
        ...deps,
        hardCrashAt: undefined,
        faultAt: "after-journal",
      }),
      /INJECTED_MIGRATION_FAILURE/,
    );

    assert.equal(deps.loaded.has(deps.oldLabel), true);
    assert.equal(deps.loaded.has(deps.label), false);
    assert.deepEqual(await readFile(deps.oldPlistPath), deps.originalPlistBytes);
    assert.equal((await stat(deps.oldPlistPath)).mode & 0o777, 0o640);
    assert.equal(await pathExists(deps.controllerPlistPath), false);
    assert.equal(await pathExists(deps.journalPath), false);
  });
}

test("hard-crash recovery restores an existing Hermes controller pre-state", async (t) => {
  const deps = await fixture(t, { hardCrashAt: "after-old-remove" });
  const legacy = await installKnownHermesController(deps, { mode: 0o640 });

  await assert.rejects(
    migrateLegacyWatchdog(deps),
    (error) => error.code === "SIMULATED_HARD_CRASH",
  );
  await assert.rejects(
    migrateLegacyWatchdog({
      ...deps,
      hardCrashAt: undefined,
      faultAt: "after-journal",
    }),
    /INJECTED_MIGRATION_FAILURE/,
  );

  assert.deepEqual(await readFile(deps.controllerPlistPath), legacy.bytes);
  assert.equal((await stat(deps.controllerPlistPath)).mode & 0o777, 0o640);
  assert.equal(deps.loaded.has(deps.label), true);
  assert.deepEqual(await readFile(deps.oldPlistPath), deps.originalPlistBytes);
  assert.equal(deps.loaded.has(deps.oldLabel), true);
  assert.equal(await pathExists(deps.journalPath), false);
});

test("hard-crash recovery preserves a foreign staged path and fails closed", async (t) => {
  const deps = await fixture(t, { hardCrashAt: "after-new-stage" });
  await assert.rejects(migrateLegacyWatchdog(deps), /SIMULATED_HARD_CRASH/);
  const journal = JSON.parse(await readFile(deps.journalPath, "utf8"));
  const foreign = Buffer.from("foreign staged path\n");
  await writeFile(journal.forward.stagedPath, foreign, { mode: 0o600 });
  deps.commands.length = 0;

  await assert.rejects(
    migrateLegacyWatchdog({ ...deps, hardCrashAt: undefined }),
    (error) => error.code === "MIGRATION_RECOVERY_CONFLICT",
  );

  assert.deepEqual(await readFile(journal.forward.stagedPath), foreign);
  assert.deepEqual(await readFile(deps.oldPlistPath), deps.originalPlistBytes);
  assert.equal(deps.loaded.has(deps.oldLabel), true);
  assert.equal(deps.loaded.has(deps.label), false);
  assert.equal(deps.commands.some((command) => ["bootstrap", "bootout"].includes(command[1])), false);
});

test("hard-crash recovery preserves a foreign canonical controller and fails closed", async (t) => {
  const deps = await fixture(t, { hardCrashAt: "after-new-publish" });
  await assert.rejects(migrateLegacyWatchdog(deps), /SIMULATED_HARD_CRASH/);
  const foreign = Buffer.from("foreign canonical controller\n");
  await writeFile(deps.controllerPlistPath, foreign, { mode: 0o600 });
  deps.commands.length = 0;

  await assert.rejects(
    migrateLegacyWatchdog({ ...deps, hardCrashAt: undefined }),
    (error) => error.code === "MIGRATION_RECOVERY_CONFLICT",
  );

  assert.deepEqual(await readFile(deps.controllerPlistPath), foreign);
  assert.deepEqual(await readFile(deps.oldPlistPath), deps.originalPlistBytes);
  assert.equal(deps.loaded.has(deps.oldLabel), true);
  assert.equal(deps.commands.some((command) => ["bootstrap", "bootout"].includes(command[1])), false);
});

test("migration refuses a non-private or symlinked recovery journal before service mutation", async (t) => {
  await t.test("mode 0644", async (t) => {
    const deps = await fixture(t, { hardCrashAt: "after-journal" });
    await assert.rejects(migrateLegacyWatchdog(deps), /SIMULATED_HARD_CRASH/);
    await fsPromises.chmod(deps.journalPath, 0o644);
    deps.commands.length = 0;
    await assert.rejects(
      migrateLegacyWatchdog({ ...deps, hardCrashAt: undefined }),
      (error) => error.code === "MIGRATION_INCOMPLETE",
    );
    assert.equal(deps.commands.some((command) => ["bootstrap", "bootout"].includes(command[1])), false);
  });

  await t.test("symlink", async (t) => {
    const deps = await fixture(t);
    await fsPromises.mkdir(deps.stateDir, { recursive: true });
    const backing = join(deps.stateDir, "journal-backing.json");
    await writeFile(backing, "{}\n", { mode: 0o600 });
    await symlink(backing, deps.journalPath);
    deps.commands.length = 0;
    await assert.rejects(migrateLegacyWatchdog(deps), /non-regular file/i);
    assert.equal(deps.commands.some((command) => ["bootstrap", "bootout"].includes(command[1])), false);
  });
});

test("migration aborts if loaded state changes immediately before the first mutation", async (t) => {
  const deps = await fixture(t);
  const originalExecFile = deps.execFile;
  let oldPrints = 0;
  deps.execFile = async (file, args) => {
    if (
      file === "/bin/launchctl" &&
      args[0] === "print" &&
      args[1].endsWith(`/${deps.oldLabel}`)
    ) {
      oldPrints += 1;
      if (oldPrints === 2) deps.loaded.delete(deps.oldLabel);
    }
    return originalExecFile(file, args);
  };

  await assert.rejects(
    migrateLegacyWatchdog(deps),
    (error) => error.code === "MIGRATION_PRESTATE_CHANGED",
  );

  assert.deepEqual(await readFile(deps.oldPlistPath), deps.originalPlistBytes);
  assert.equal(deps.loaded.has(deps.oldLabel), false, "external state change is not undone");
  assert.equal(deps.loaded.has(deps.label), false);
  assert.equal(await pathExists(deps.controllerPlistPath), false);
  assert.equal(await pathExists(deps.journalPath), false);
  assert.equal(deps.commands.some((command) => ["bootstrap", "bootout"].includes(command[1])), false);
});

for (const faultAt of MIGRATION_BOUNDARIES) {
  test(`migration rolls back byte-for-byte after ${faultAt}`, async (t) => {
    const deps = await fixture(t, { faultAt, oldLoaded: true });
    await assert.rejects(
      migrateLegacyWatchdog(deps),
      (error) => error.code === "INJECTED_MIGRATION_FAILURE" && error.phase === faultAt,
    );

    assert.equal(deps.loaded.has(deps.oldLabel), true);
    assert.equal(deps.loaded.has(deps.label), false);
    assert.deepEqual(await readFile(deps.oldPlistPath), deps.originalPlistBytes);
    assert.equal((await stat(deps.oldPlistPath)).mode & 0o777, 0o640);
    assert.equal(await pathExists(deps.controllerPlistPath), false);
    assert.equal(await pathExists(deps.journalPath), false);
  });
}

test("rollback restores an unloaded legacy job without loading it", async (t) => {
  const deps = await fixture(t, { faultAt: "after-old-remove", oldLoaded: false });
  await assert.rejects(migrateLegacyWatchdog(deps), /INJECTED_MIGRATION_FAILURE/);
  assert.equal(deps.loaded.has(deps.oldLabel), false);
  assert.deepEqual(await readFile(deps.oldPlistPath), deps.originalPlistBytes);
});

test("migration rollback restores an existing controller plist, mode, and loaded state", async (t) => {
  const deps = await fixture(t, { faultAt: "after-old-bootout" });
  const previous = Buffer.from(renderControllerPlist({
    label: deps.label,
    programArguments: [deps.nodePath, deps.controllerPath, "controller"],
    stateDir: deps.stateDir,
  }));
  await writeFile(deps.controllerPlistPath, previous, { mode: 0o640 });
  await fsPromises.chmod(deps.controllerPlistPath, 0o640);
  deps.loaded.add(deps.label);

  await assert.rejects(migrateLegacyWatchdog(deps), /INJECTED_MIGRATION_FAILURE/);
  assert.deepEqual(await readFile(deps.controllerPlistPath), previous);
  assert.equal((await stat(deps.controllerPlistPath)).mode & 0o777, 0o640);
  assert.equal(deps.loaded.has(deps.label), true);
  assert.deepEqual(await readFile(deps.oldPlistPath), deps.originalPlistBytes);
  assert.equal(deps.loaded.has(deps.oldLabel), true);
});

test("migration upgrades only the exact known Hermes controller tuple", async (t) => {
  const deps = await fixture(t);
  const legacy = await installKnownHermesController(deps);

  const result = await migrateLegacyWatchdog(deps);

  assert.equal(result.controllerRegistered, true);
  assert.equal(deps.loaded.has(deps.label), true);
  assert.notDeepEqual(await readFile(deps.controllerPlistPath), legacy.bytes);
  assert.deepEqual(
    renderedProgramArguments(await readFile(deps.controllerPlistPath, "utf8")),
    [
      deps.nodePath,
      deps.controllerPath,
      "controller",
      "--background",
      "--platform",
      "darwin",
      "--task-name",
      deps.label,
    ],
  );
});

for (const [name, options, pattern] of [
  ["extra argument", { extraArguments: ["--foreign"] }, /attribution failed/i],
  ["symlinked node", { symlinkNode: true }, /regular executable|attribution/i],
  ["Node below 22", { nodeVersion: "v20.19.4" }, /Node 22/i],
]) {
  test(`migration rejects known Hermes tuple with ${name}`, async (t) => {
    const deps = await fixture(t);
    const legacy = await installKnownHermesController(deps, options);
    deps.commands.length = 0;

    await assert.rejects(migrateLegacyWatchdog(deps), pattern);

    assert.deepEqual(await readFile(deps.controllerPlistPath), legacy.bytes);
    assert.equal(deps.loaded.has(deps.label), true);
    assert.equal(deps.loaded.has(deps.oldLabel), true);
    assert.equal(deps.commands.some((command) => ["bootstrap", "bootout"].includes(command[1])), false);
  });
}

test("migration rollback restores the known Hermes controller bytes, mode, and loaded state", async (t) => {
  const deps = await fixture(t, { faultAt: "after-old-bootout" });
  const legacy = await installKnownHermesController(deps, { mode: 0o640 });

  await assert.rejects(migrateLegacyWatchdog(deps), /INJECTED_MIGRATION_FAILURE/);

  assert.deepEqual(await readFile(deps.controllerPlistPath), legacy.bytes);
  assert.equal((await stat(deps.controllerPlistPath)).mode & 0o777, 0o640);
  assert.equal(deps.loaded.has(deps.label), true);
  assert.deepEqual(await readFile(deps.oldPlistPath), deps.originalPlistBytes);
  assert.equal(deps.loaded.has(deps.oldLabel), true);
});

test("migration refuses an existing controller plist whose fixed tuple is foreign", async (t) => {
  const deps = await fixture(t);
  const previous = Buffer.from("foreign same-label controller\n");
  await writeFile(deps.controllerPlistPath, previous, { mode: 0o600 });
  const readPlist = async (path) => path === deps.controllerPlistPath
    ? {
      Label: deps.label,
      ProgramArguments: ["/bin/sh", "/tmp/foreign"],
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
      ProcessType: "Background",
    }
    : deps.readPlist(path);

  await assert.rejects(
    migrateLegacyWatchdog({ ...deps, readPlist }),
    /controller plist attribution failed/i,
  );
  assert.deepEqual(await readFile(deps.controllerPlistPath), previous);
  assert.equal(deps.loaded.has(deps.oldLabel), true);
});

test("the existing-controller bootout boundary is injectable and reversible", async (t) => {
  const deps = await fixture(t, { faultAt: "after-existing-new-bootout" });
  const previous = Buffer.from(renderControllerPlist({
    label: deps.label,
    programArguments: [deps.nodePath, deps.controllerPath, "controller"],
    stateDir: deps.stateDir,
  }));
  await writeFile(deps.controllerPlistPath, previous, { mode: 0o600 });
  deps.loaded.add(deps.label);

  await assert.rejects(
    migrateLegacyWatchdog(deps),
    (error) => error.code === "INJECTED_MIGRATION_FAILURE" &&
      error.phase === "after-existing-new-bootout",
  );
  assert.deepEqual(await readFile(deps.controllerPlistPath), previous);
  assert.equal(deps.loaded.has(deps.label), true);
  assert.deepEqual(await readFile(deps.oldPlistPath), deps.originalPlistBytes);
  assert.equal(deps.loaded.has(deps.oldLabel), true);
});

test("rollback reports primary and rollback failures and retains the journal", async (t) => {
  const deps = await fixture(t, {
    faultAt: "after-old-bootout",
    rollbackFaultAt: "before-old-rebootstrap",
  });

  await assert.rejects(
    migrateLegacyWatchdog(deps),
    (error) => {
      assert.equal(error.code, "MIGRATION_ROLLBACK_FAILED");
      assert.match(error.primaryError.message, /INJECTED_MIGRATION_FAILURE/);
      assert.equal(error.rollbackErrors.length > 0, true);
      assert.match(error.message, /rollback/i);
      return true;
    },
  );
  assert.equal(await pathExists(deps.journalPath), true);
  const journal = JSON.parse(await readFile(deps.journalPath, "utf8"));
  assert.equal(journal.schemaVersion, 2);
  assert.equal(journal.phase, "rollback-failed");
  assert.equal(journal.primaryError.code, "INJECTED_MIGRATION_FAILURE");
  assert.equal(journal.rollbackErrors.length > 0, true);
  assert.equal(journal.oldBackup.path, deps.oldPlistPath);
  assert.equal(journal.oldBackup.bytesBase64, deps.originalPlistBytes.toString("base64"));
  assert.equal(
    journal.oldBackup.sha256,
    createHash("sha256").update(deps.originalPlistBytes).digest("hex"),
  );
  assert.equal(journal.oldBackup.mode, 0o640);
  assert.equal(journal.oldBackup.loaded, true);
  assert.equal(journal.newBackup.path, deps.controllerPlistPath);
  assert.equal(journal.newBackup.existed, false);
  assert.equal(journal.newBackup.bytesBase64, null);
  assert.equal(journal.newBackup.sha256, null);
  const fixedArguments = [
    deps.nodePath,
    deps.controllerPath,
    "controller",
    "--background",
    "--platform",
    "darwin",
    "--task-name",
    deps.label,
  ];
  const forwardBytes = Buffer.from(renderControllerPlist({
    label: deps.label,
    programArguments: fixedArguments,
    stateDir: deps.stateDir,
  }));
  assert.match(journal.nonce, /^[0-9a-f-]{36}$/i);
  assert.equal(Number.isInteger(journal.revision), true);
  assert.equal(journal.revision > 0, true);
  assert.equal(journal.forward.plistPath, deps.controllerPlistPath);
  assert.match(journal.forward.stagedPath, new RegExp(
    `^${deps.controllerPlistPath.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.staged\\.`,
  ));
  assert.deepEqual(journal.forward.programArguments, fixedArguments);
  assert.equal(journal.forward.bytesBase64, forwardBytes.toString("base64"));
  assert.equal(
    journal.forward.sha256,
    createHash("sha256").update(forwardBytes).digest("hex"),
  );
});

test("recovery journal durably embeds an existing controller pre-state", async (t) => {
  const deps = await fixture(t, {
    faultAt: "after-old-bootout",
    rollbackFaultAt: "before-new-rebootstrap",
  });
  const previous = Buffer.from(renderControllerPlist({
    label: deps.label,
    programArguments: [deps.nodePath, deps.controllerPath, "controller"],
    stateDir: deps.stateDir,
  }));
  await writeFile(deps.controllerPlistPath, previous, { mode: 0o640 });
  await fsPromises.chmod(deps.controllerPlistPath, 0o640);
  deps.loaded.add(deps.label);

  await assert.rejects(
    migrateLegacyWatchdog(deps),
    (error) => error.code === "MIGRATION_ROLLBACK_FAILED",
  );
  const journal = JSON.parse(await readFile(deps.journalPath, "utf8"));
  assert.equal(journal.newBackup.existed, true);
  assert.equal(journal.newBackup.bytesBase64, previous.toString("base64"));
  assert.equal(
    journal.newBackup.sha256,
    createHash("sha256").update(previous).digest("hex"),
  );
  assert.equal(journal.newBackup.mode, 0o640);
  assert.equal(journal.newBackup.loaded, true);
});

test("unit and integration sources never reuse production labels accidentally", async () => {
  const integration = await readFile(
    new URL("./macos-launch-agent.integration.test.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(integration, /com\.heige\.codex-skin-watchdog/);
  assert.doesNotMatch(integration, /com\.heige\.codex-skin-controller[\"']/);
});
