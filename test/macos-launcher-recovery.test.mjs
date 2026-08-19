import assert from "node:assert/strict";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ensureLauncherOperationLock,
  recoverStaticLauncherStateRoot,
} from "../src/macos-launcher-recovery.mjs";
import { readStudioState } from "../src/state-store.mjs";
import { loadTheme } from "../src/theme-schema.mjs";

const NOW = new Date("2026-08-20T08:00:00.000Z");
const ROOT_NONCE = "root_claim_nonce_20260820";
const SUCCESSOR_NONCE = "successor_claim_nonce_20260820";
const DEAD_PID = 991_001;
const STARTED_AT = "Wed Aug 19 16:00:00 2026";

function stateDocument() {
  return {
    schemaVersion: 2,
    persistenceEnabled: false,
    selectedThemeId: "miku-488137",
    lastNonNativeThemeId: "miku-488137",
    controlToken: Buffer.alloc(32, 17).toString("base64url"),
    lastTransitionNonce: null,
    revision: 7,
  };
}

function claim({ nonce, predecessor, operation }) {
  return {
    schemaVersion: 2,
    nonce,
    pid: DEAD_PID,
    operation,
    startedAt: STARTED_AT,
    createdAt: "2026-08-19T08:00:00.000Z",
    heartbeat: "2026-08-19T08:00:00.000Z",
    predecessor,
  };
}

async function fixture(t, { includeTheme = true } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "heige-launcher-recovery-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, "Library", "Application Support", "HeiGeCodexSkinStudio");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await chmod(stateRoot, 0o700);
  const state = stateDocument();
  await writeFile(join(stateRoot, "state.json"), `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await chmod(join(stateRoot, "state.json"), 0o600);
  if (includeTheme) {
    const userTheme = join(stateRoot, "themes", "miku-488137");
    await mkdir(join(stateRoot, "themes"), { recursive: true, mode: 0o700 });
    await cp(new URL("../themes/miku-488137", import.meta.url), userTheme, { recursive: true });
  }
  const lockPath = join(stateRoot, "operation.lock");
  await writeFile(lockPath, `${JSON.stringify(claim({
    nonce: ROOT_NONCE,
    predecessor: null,
    operation: "cli:prepare-state",
  }))}\n`, { mode: 0o600 });
  await chmod(lockPath, 0o600);
  const successorPath = `${lockPath}.successor.${ROOT_NONCE}`;
  await writeFile(successorPath, `${JSON.stringify(claim({
    nonce: SUCCESSOR_NONCE,
    predecessor: { dev: "1", ino: "1", nonce: ROOT_NONCE },
    operation: "controller:start",
  }))}\n`, { mode: 0o600 });
  await chmod(successorPath, 0o600);
  return {
    root,
    stateRoot,
    state,
    paths: {
      installRoot: join(root, ".codex", "heige-codex-skin-studio"),
      stateRoot,
      statePath: join(stateRoot, "state.json"),
      lockPath,
      userThemesRoot: join(stateRoot, "themes"),
    },
  };
}

function idleDependencies(overrides = {}) {
  return {
    inspectLaunchAgent: async () => ({ loaded: false }),
    inspectPort: async () => ({ kind: "free" }),
    listRelatedProcesses: async () => [],
    now: () => NOW,
    randomUUID: () => "123e4567-e89b-42d3-a456-426614174000",
    wait: async () => {},
    ...overrides,
  };
}

test("repairs a real device-binding LOCK_CHAIN_CORRUPT once and preserves strict state and themes", async (t) => {
  const fx = await fixture(t);
  const result = await ensureLauncherOperationLock({
    paths: fx.paths,
    port: 9341,
    dependencies: idleDependencies(),
  });

  assert.equal(result.recovered, true);
  assert.equal(
    result.backupPath,
    `${fx.stateRoot}.corrupt-lock-backup-20260820T080000Z`,
  );
  assert.deepEqual(await readStudioState(fx.paths.statePath), fx.state);
  assert.equal((await lstat(fx.stateRoot)).mode & 0o777, 0o700);
  assert.equal((await lstat(fx.paths.statePath)).mode & 0o777, 0o600);
  assert.equal((await loadTheme(join(fx.paths.userThemesRoot, "miku-488137"))).manifest.id,
    "miku-488137");
  assert.equal((await lstat(join(result.backupPath, "operation.lock"))).isFile(), true);
  assert.equal(
    (await readdir(fx.stateRoot)).some((name) => name.includes(`successor.${ROOT_NONCE}`)),
    false,
  );
});

test("refuses recovery while an exact lock claim PID is still alive", async (t) => {
  const fx = await fixture(t, { includeTheme: false });
  await assert.rejects(ensureLauncherOperationLock({
    paths: fx.paths,
    port: 9341,
    dependencies: idleDependencies({
      readProcessIdentity: async (pid) => pid === DEAD_PID
        ? { pid, startedAt: STARTED_AT }
        : { pid, startedAt: "current-launcher" },
    }),
  }), (error) => error?.code === "LOCK_RECOVERY_ACTIVE_OWNER");
  assert.deepEqual(await readStudioState(fx.paths.statePath), fx.state);
  assert.equal((await readdir(join(fx.root, "Library", "Application Support")))
    .some((name) => name.includes("corrupt-lock-backup")), false);
});

test("refuses recovery while an unpublished staging claim PID is still alive", async (t) => {
  const fx = await fixture(t, { includeTheme: false });
  const stagingPid = 991_002;
  const stagingStartedAt = "Wed Aug 19 16:01:00 2026";
  const stagingNonce = "staging_claim_nonce_20260820";
  await writeFile(
    `${fx.paths.lockPath}.staging.${stagingPid}.${stagingNonce}`,
    `${JSON.stringify({
      ...claim({
        nonce: stagingNonce,
        predecessor: null,
        operation: "cli:apply",
      }),
      pid: stagingPid,
      startedAt: stagingStartedAt,
    })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(ensureLauncherOperationLock({
    paths: fx.paths,
    port: 9341,
    dependencies: idleDependencies({
      readProcessIdentity: async (pid) => pid === stagingPid
        ? { pid, startedAt: stagingStartedAt }
        : pid === DEAD_PID
          ? null
          : { pid, startedAt: "current-launcher" },
    }),
  }), (error) => error?.code === "LOCK_RECOVERY_ACTIVE_OWNER");
  assert.deepEqual(await readStudioState(fx.paths.statePath), fx.state);
});

for (const [name, dependency, code] of [
  ["loaded LaunchAgent", { inspectLaunchAgent: async () => ({ loaded: true }) }, "LOCK_RECOVERY_ACTIVE_AGENT"],
  ["foreign CDP listener", { inspectPort: async () => ({ kind: "foreign", pids: [777] }) }, "LOCK_RECOVERY_FOREIGN_LISTENER"],
  ["running lifecycle helper", {
    listRelatedProcesses: async () => [{ pid: 778, commandLine: "node src/lifecycle-helper.mjs" }],
  }, "LOCK_RECOVERY_ACTIVE_PROCESS"],
]) {
  test(`refuses recovery with ${name}`, async (t) => {
    const fx = await fixture(t, { includeTheme: false });
    await assert.rejects(ensureLauncherOperationLock({
      paths: fx.paths,
      port: 9341,
      dependencies: idleDependencies(dependency),
    }), (error) => error?.code === code);
    assert.deepEqual(await readStudioState(fx.paths.statePath), fx.state);
  });
}

test("quits an exact official CDP owner before rebuilding and rechecks the free port", async (t) => {
  const fx = await fixture(t, { includeTheme: false });
  const owner = {
    pid: 4242,
    executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    startedAt: "Wed Aug 19 17:00:00 2026",
  };
  let portChecks = 0;
  const quits = [];
  const result = await ensureLauncherOperationLock({
    paths: fx.paths,
    port: 9341,
    dependencies: idleDependencies({
      inspectPort: async () => (++portChecks === 1
        ? { kind: "official", process: owner }
        : { kind: "free" }),
      requestQuit: async (input) => quits.push(input),
      readProcessIdentity: async (pid) => pid === owner.pid
        ? null
        : pid === DEAD_PID
          ? null
          : { pid, startedAt: "current-launcher" },
    }),
  });
  assert.equal(result.recovered, true);
  assert.deepEqual(quits, [{ process: owner }]);
  assert.ok(portChecks >= 2);
});

test("invalid state fails closed without moving the original root", async (t) => {
  const fx = await fixture(t, { includeTheme: false });
  await writeFile(fx.paths.statePath, "{}\n", { mode: 0o600 });
  await assert.rejects(ensureLauncherOperationLock({
    paths: fx.paths,
    port: 9341,
    dependencies: idleDependencies(),
  }), /状态|schema|字段/);
  assert.equal(await readFile(fx.paths.statePath, "utf8"), "{}\n");
  assert.equal((await readdir(join(fx.root, "Library", "Application Support")))
    .some((name) => name.includes("corrupt-lock-backup")), false);
});

test("a symbolic link anywhere at the state-root top level fails closed", async (t) => {
  const fx = await fixture(t, { includeTheme: false });
  const outside = join(fx.root, "outside-session.json");
  await writeFile(outside, "preserve\n");
  await symlink(outside, join(fx.stateRoot, "session.json"));
  await assert.rejects(ensureLauncherOperationLock({
    paths: fx.paths,
    port: 9341,
    dependencies: idleDependencies(),
  }), (error) => error?.code === "LOCK_RECOVERY_PATH_UNTRUSTED");
  assert.equal(await readFile(outside, "utf8"), "preserve\n");
});

test("an unowned extra file inside a user theme blocks recovery", async (t) => {
  const fx = await fixture(t);
  const extra = join(fx.paths.userThemesRoot, "miku-488137", "extra.txt");
  await writeFile(extra, "do not silently discard\n");
  await assert.rejects(ensureLauncherOperationLock({
    paths: fx.paths,
    port: 9341,
    dependencies: idleDependencies(),
  }), (error) => error?.code === "LOCK_RECOVERY_THEME_INVALID");
  assert.equal(await readFile(extra, "utf8"), "do not silently discard\n");
});

test("a copied-theme verification failure restores the exact original state root", async (t) => {
  const fx = await fixture(t);
  let themeReads = 0;
  await assert.rejects(ensureLauncherOperationLock({
    paths: fx.paths,
    port: 9341,
    dependencies: idleDependencies({
      loadTheme: async (path) => {
        themeReads += 1;
        if (themeReads > 1) throw new Error("SIMULATED_COPIED_THEME_FAILURE");
        return loadTheme(path);
      },
    }),
  }), /SIMULATED_COPIED_THEME_FAILURE|用户主题/);
  assert.deepEqual(await readStudioState(fx.paths.statePath), fx.state);
  assert.equal((await lstat(fx.paths.lockPath)).isFile(), true);
  assert.equal((await readdir(join(fx.root, "Library", "Application Support")))
    .some((name) => name.includes("corrupt-lock-backup")), false);
});

test("the only retry failure leaves one recoverable backup and never loops", async (t) => {
  const fx = await fixture(t, { includeTheme: false });
  let attempts = 0;
  const acquireLock = async () => {
    attempts += 1;
    const error = new Error("LOCK_CHAIN_CORRUPT: simulated static drift");
    error.code = "LOCK_CHAIN_CORRUPT";
    throw error;
  };
  await assert.rejects(ensureLauncherOperationLock({
    paths: fx.paths,
    port: 9341,
    dependencies: idleDependencies({ acquireLock }),
  }), /LOCK_CHAIN_CORRUPT/);
  assert.equal(attempts, 2);
  assert.deepEqual(
    (await readdir(join(fx.root, "Library", "Application Support")))
      .filter((name) => name.includes("corrupt-lock-backup")),
    ["HeiGeCodexSkinStudio.corrupt-lock-backup-20260820T080000Z"],
  );
});

test("ordinary transient LOCK_HELD contention retries without rebuilding the state root", async (t) => {
  const fx = await fixture(t, { includeTheme: false });
  let attempts = 0;
  const waits = [];
  const result = await ensureLauncherOperationLock({
    paths: fx.paths,
    port: 9341,
    dependencies: idleDependencies({
      acquireLock: async () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("LOCK_HELD: active operation");
          error.code = "LOCK_HELD";
          throw error;
        }
        return { release: async () => true };
      },
      wait: async (milliseconds) => waits.push(milliseconds),
    }),
  });
  assert.deepEqual(result, { recovered: false });
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [100]);
  assert.equal((await readdir(join(fx.root, "Library", "Application Support")))
    .some((name) => name.includes("corrupt-lock-backup")), false);
});

test("direct recovery rejects a request that was not caused by a lock-chain error", async (t) => {
  const fx = await fixture(t, { includeTheme: false });
  await assert.rejects(recoverStaticLauncherStateRoot({
    stateRoot: fx.stateRoot,
    installRoot: fx.paths.installRoot,
    port: 9341,
    triggerCode: "LOCK_HELD",
    dependencies: idleDependencies(),
  }), /LOCK_CHAIN_CORRUPT/);
});
