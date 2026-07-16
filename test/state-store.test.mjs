import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { DEFAULT_THEME_ID, NATIVE_THEME_ID } from "../src/constants.mjs";
import { acquireOperationLock } from "../src/operation-lock.mjs";
import {
  clearTransitionJournal,
  compareAndUpdateStudioState,
  createDefaultStudioState,
  migrateLegacyState,
  readSessionState,
  readStudioState,
  readTransitionJournal,
  recoverStateTransition,
  rollbackLegacyStateMigration,
  validateSessionState,
  validateStudioState,
  writeSessionState,
  writeStudioState,
  writeTransitionJournal,
} from "../src/state-store.mjs";

const CONTROL_TOKEN = Buffer.alloc(32, 3).toString("base64url");
const CURRENT_PROCESS = {
  pid: 4242,
  executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  startedAt: "Thu Jul 16 16:49:24 2026",
};

async function fixture(t) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "heige-state-store-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    statePath: join(root, "state", "state.json"),
    sessionPath: join(root, "state", "session.json"),
    transitionPath: join(root, "state", "transition.json"),
    legacyThemePath: join(root, "legacy-theme"),
  };
}

async function acquireStateLease(t, path, operation = "state-store-test") {
  const stateRoot = dirname(path);
  const identity = {
    pid: process.pid,
    startedAt: "2026-07-17T08:00:00.000Z",
  };
  const lease = await acquireOperationLock({
    lockPath: join(stateRoot, "operation.lock"),
    stateRoot,
    operation,
    identity,
    readProcessIdentity: async (pid) => (pid === identity.pid ? identity : null),
  });
  t.after(() => lease.release());
  return lease;
}

function stateAtRevision(revision, overrides = {}) {
  return {
    ...createDefaultStudioState({ themeId: DEFAULT_THEME_ID, token: CONTROL_TOKEN }),
    persistenceEnabled: true,
    revision,
    ...overrides,
  };
}

function disableJournal(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: "disable-persistence",
    expectedRevision: 3,
    process: CURRENT_PROCESS,
    desiredPersistenceEnabled: false,
    nonce: "transition-1",
    stage: "prepared",
    ...overrides,
  };
}

async function seedState(t, path, state, lease = undefined) {
  lease ??= await acquireStateLease(t, path, "seed-state");
  await writeStudioState(path, { ...state, revision: 0 }, { lease });
  for (let revision = 0; revision < state.revision; revision += 1) {
    await compareAndUpdateStudioState(path, {
      lease,
      expectedRevision: revision,
      mutate: (current) => current,
    });
  }
  return lease;
}

async function seedJournal(path, journal, lease) {
  await writeTransitionJournal(path, { ...journal, stage: "prepared" }, { lease });
  if (journal.stage === "prepared") return;
  await writeTransitionJournal(
    path,
    { ...journal, stage: "state-committed" },
    { lease },
  );
  if (journal.stage === "state-committed") return;
  await writeTransitionJournal(path, journal, { lease });
}

test("corrupt state fails closed without generating replacement state", async (t) => {
  const { statePath } = await fixture(t);
  await mkdir(join(statePath, ".."), { recursive: true, mode: 0o700 });
  await chmod(join(statePath, ".."), 0o700);
  await writeFile(statePath, "{bad", { mode: 0o600 });

  await assert.rejects(() => readStudioState(statePath), /状态文件损坏/);
  const lease = await acquireStateLease(t, statePath);

  let randomCalls = 0;
  await assert.rejects(
    () => migrateLegacyState({
      statePath,
      lease,
      legacyAgentLoaded: false,
      themeExists: async () => true,
      randomBytes: () => {
        randomCalls += 1;
        return Buffer.alloc(32, 7);
      },
    }),
    /状态文件损坏/,
  );
  assert.equal(randomCalls, 0);
  assert.equal(await readFile(statePath, "utf8"), "{bad");
});

test("private state readers reject files larger than 64 KiB before parsing", async (t) => {
  const { statePath, sessionPath, transitionPath } = await fixture(t);
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await chmod(dirname(statePath), 0o700);
  const oversized = " ".repeat(64 * 1024 + 1);
  for (const [path, read] of [
    [statePath, readStudioState],
    [sessionPath, readSessionState],
    [transitionPath, readTransitionJournal],
  ]) {
    await writeFile(path, oversized, { mode: 0o600 });
    await assert.rejects(() => read(path), /65536 bytes/);
  }
});

test("legacy theme migration rejects oversized files and final symlinks", async (t) => {
  const { statePath, legacyThemePath, root } = await fixture(t);
  const lease = await acquireStateLease(t, statePath);
  const migrate = () => migrateLegacyState({
    statePath,
    lease,
    legacyThemePath,
    legacyAgentLoaded: true,
    themeExists: async () => true,
    randomBytes: () => Buffer.alloc(32, 5),
  });

  await writeFile(legacyThemePath, "x".repeat(257), { mode: 0o600 });
  await assert.rejects(migrate, /256 bytes/);
  assert.equal(await readStudioState(statePath), null);

  await rm(legacyThemePath);
  const backing = join(root, "legacy-theme-backing");
  await writeFile(backing, `${DEFAULT_THEME_ID}\n`, { mode: 0o600 });
  await symlink(backing, legacyThemePath);
  await assert.rejects(migrate, /symbolic link|too many levels|\u7b26\u53f7\u94fe\u63a5/i);
  assert.equal(await readStudioState(statePath), null);
});

test("state validation rejects unknown schemas and malformed fields", () => {
  const valid = createDefaultStudioState({ themeId: DEFAULT_THEME_ID, token: CONTROL_TOKEN });
  assert.deepEqual(valid, {
    schemaVersion: 2,
    persistenceEnabled: false,
    selectedThemeId: DEFAULT_THEME_ID,
    lastNonNativeThemeId: DEFAULT_THEME_ID,
    controlToken: CONTROL_TOKEN,
    lastTransitionNonce: null,
    revision: 0,
  });

  for (const malformed of [
    { ...valid, schemaVersion: 99 },
    { ...valid, persistenceEnabled: "false" },
    { ...valid, selectedThemeId: "../theme" },
    { ...valid, lastNonNativeThemeId: NATIVE_THEME_ID },
    { ...valid, controlToken: `${CONTROL_TOKEN}=` },
    { ...valid, lastTransitionNonce: "" },
    { ...valid, lastTransitionNonce: "not safe!" },
    { ...valid, lastTransitionNonce: 7 },
    { ...valid, revision: -1 },
    { ...valid, revision: 1.5 },
  ]) {
    assert.throws(() => validateStudioState(malformed));
  }
});

test("a loaded legacy watchdog and valid theme migrate enabled exactly once", async (t) => {
  const { statePath, legacyThemePath } = await fixture(t);
  const lease = await acquireStateLease(t, statePath);
  await writeFile(legacyThemePath, `${DEFAULT_THEME_ID}\n`);
  let randomCalls = 0;

  const result = await migrateLegacyState({
    statePath,
    lease,
    legacyThemePath,
    legacyAgentLoaded: true,
    themeExists: async (id) => id === DEFAULT_THEME_ID,
    randomBytes: (size) => {
      assert.equal(size, 32);
      randomCalls += 1;
      return Buffer.alloc(32, 7);
    },
  });

  assert.equal(result.migratedFrom, "watchdog");
  assert.equal(result.state.schemaVersion, 2);
  assert.equal(result.state.persistenceEnabled, true);
  assert.equal(result.state.revision, 1);
  assert.equal(result.state.controlToken, Buffer.alloc(32, 7).toString("base64url"));
  assert.match(result.state.controlToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(result.state.controlToken.includes("="), false);
  assert.equal(Buffer.from(result.state.controlToken, "base64url").length, 32);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(statePath, ".."))).mode & 0o777, 0o700);

  await writeFile(legacyThemePath, "genshin-night\n");
  const second = await migrateLegacyState({
    statePath,
    lease,
    legacyThemePath,
    legacyAgentLoaded: true,
    themeExists: async () => true,
    randomBytes: () => {
      throw new Error("existing state must not request a new token");
    },
  });
  assert.equal(second.migratedFrom, null);
  assert.deepEqual(second.state, result.state);
  assert.equal(randomCalls, 1);
});

test("legacy state rollback removes the exact prepared state and its controller compensation", async (t) => {
  for (const compensated of [false, true]) {
    const { statePath, legacyThemePath } = await fixture(t);
    const lease = await acquireStateLease(t, statePath, `legacy-rollback-${compensated}`);
    await writeFile(legacyThemePath, `${DEFAULT_THEME_ID}\n`);
    const token = Buffer.alloc(32, compensated ? 19 : 18).toString("base64url");
    await migrateLegacyState({
      statePath,
      lease,
      legacyThemePath,
      legacyAgentLoaded: true,
      themeExists: async () => true,
      randomBytes: () => Buffer.from(token, "base64url"),
    });
    if (compensated) {
      await compareAndUpdateStudioState(statePath, {
        lease,
        expectedRevision: 1,
        mutate: (current) => ({
          ...current,
          persistenceEnabled: false,
          lastTransitionNonce: "controller-compensation",
        }),
      });
    }
    assert.deepEqual(await rollbackLegacyStateMigration({
      statePath,
      lease,
      beforeState: null,
      expectedControlToken: token,
    }), { rolledBack: true, state: null });
    assert.equal(await readStudioState(statePath), null);
  }
});

test("legacy state rollback removes an uncommitted state-only default", async (t) => {
  const { statePath, legacyThemePath } = await fixture(t);
  const lease = await acquireStateLease(t, statePath, "legacy-default-rollback");
  const token = Buffer.alloc(32, 20).toString("base64url");
  await migrateLegacyState({
    statePath,
    lease,
    legacyThemePath,
    legacyAgentLoaded: false,
    themeExists: async () => true,
    randomBytes: () => Buffer.from(token, "base64url"),
  });
  await rollbackLegacyStateMigration({
    statePath,
    lease,
    beforeState: null,
    expectedControlToken: token,
  });
  assert.equal(await readStudioState(statePath), null);
});

test("new installs default off while invalid loaded legacy state fails closed", async (t) => {
  const first = await fixture(t);
  const firstLease = await acquireStateLease(t, first.statePath);
  const fresh = await migrateLegacyState({
    statePath: first.statePath,
    lease: firstLease,
    legacyAgentLoaded: false,
    themeExists: async (id) => id === DEFAULT_THEME_ID,
    randomBytes: () => Buffer.alloc(32, 5),
  });
  assert.equal(fresh.migratedFrom, null);
  assert.equal(fresh.state.persistenceEnabled, false);
  assert.equal(fresh.state.selectedThemeId, DEFAULT_THEME_ID);
  assert.equal(fresh.state.revision, 0);

  const second = await fixture(t);
  const secondLease = await acquireStateLease(t, second.statePath);
  await writeFile(second.legacyThemePath, "not a valid theme id!\n");
  await assert.rejects(
    () => migrateLegacyState({
      statePath: second.statePath,
      lease: secondLease,
      legacyThemePath: second.legacyThemePath,
      legacyAgentLoaded: true,
      themeExists: async () => true,
      randomBytes: () => Buffer.alloc(32, 5),
    }),
    /旧版主题状态无效/,
  );
  assert.equal(await readStudioState(second.statePath), null);
});

test("compare and update returns current state on conflict and increments revision on success", async (t) => {
  const { statePath } = await fixture(t);
  const lease = await seedState(t, statePath, stateAtRevision(3));

  await assert.rejects(
    () => compareAndUpdateStudioState(statePath, {
      lease,
      expectedRevision: 2,
      mutate: (state) => state,
    }),
    (error) => {
      assert.equal(error.code, "REVISION_CONFLICT");
      assert.equal(error.revision, 3);
      assert.equal(error.persistenceEnabled, true);
      assert.deepEqual(Object.keys(error).sort(), [
        "code",
        "persistenceEnabled",
        "revision",
      ]);
      const serialized = JSON.stringify(error);
      assert.doesNotMatch(serialized, new RegExp(CONTROL_TOKEN));
      assert.doesNotMatch(serialized, /controlToken|selectedThemeId|lastTransitionNonce/);
      return true;
    },
  );

  let mutationInput;
  const changed = await compareAndUpdateStudioState(statePath, {
    lease,
    expectedRevision: 3,
    mutate: (state) => {
      mutationInput = state;
      state.selectedThemeId = NATIVE_THEME_ID;
      state.revision = 999;
      return state;
    },
  });
  assert.notStrictEqual(mutationInput, changed);
  assert.equal(changed.revision, 4);
  assert.equal(changed.selectedThemeId, NATIVE_THEME_ID);
  assert.equal(changed.lastNonNativeThemeId, DEFAULT_THEME_ID);
  assert.deepEqual(await readStudioState(statePath), changed);

  await assert.rejects(
    () => compareAndUpdateStudioState(statePath, {
      lease,
      expectedRevision: 4,
      mutate: (state) => ({ ...state, lastNonNativeThemeId: NATIVE_THEME_ID }),
    }),
  );
  assert.deepEqual(await readStudioState(statePath), changed);
});

test("two concurrent CAS calls on one genuine lease have one winner", async (t) => {
  const { statePath } = await fixture(t);
  const lease = await seedState(t, statePath, stateAtRevision(0));

  const results = await Promise.allSettled([
    compareAndUpdateStudioState(statePath, {
      lease,
      expectedRevision: 0,
      mutate: (state) => ({ ...state, persistenceEnabled: false }),
    }),
    compareAndUpdateStudioState(statePath, {
      lease,
      expectedRevision: 0,
      mutate: (state) => ({ ...state, selectedThemeId: NATIVE_THEME_ID }),
    }),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "REVISION_CONFLICT");
  assert.equal((await readStudioState(statePath)).revision, 1);
});

test("two genuine leases for different roots are rejected before target CAS", async (t) => {
  const target = await fixture(t);
  const targetLease = await seedState(t, target.statePath, stateAtRevision(0));
  assert.ok(targetLease);
  const first = await fixture(t);
  const second = await fixture(t);
  const leases = await Promise.all([
    acquireStateLease(t, first.statePath, "wrong-root-a"),
    acquireStateLease(t, second.statePath, "wrong-root-b"),
  ]);
  let entered = 0;

  const results = await Promise.allSettled(leases.map((lease) =>
    compareAndUpdateStudioState(target.statePath, {
      lease,
      expectedRevision: 0,
      mutate: (state) => {
        entered += 1;
        return state;
      },
    })));
  assert.equal(entered, 0);
  assert.equal(results.every((result) =>
    result.status === "rejected" && result.reason.code === "STATE_PATH_INVALID"), true);
  assert.equal((await readStudioState(target.statePath)).revision, 0);
});

test("leased state changes fail closed when the lease is absent, unrelated, or released", async (t) => {
  const { statePath } = await fixture(t);
  const original = stateAtRevision(3);
  const lease = await seedState(t, statePath, original);

  await assert.rejects(
    () => compareAndUpdateStudioState(statePath, {
      expectedRevision: 3,
      mutate: (state) => state,
    }),
    (error) => error.code === "LOCK_CAPABILITY_INVALID",
  );

  const unrelated = await fixture(t);
  const unrelatedLease = await acquireStateLease(t, unrelated.statePath, "unrelated");
  let entered = false;
  await assert.rejects(
    () => compareAndUpdateStudioState(statePath, {
      lease: unrelatedLease,
      expectedRevision: 3,
      mutate: (state) => {
        entered = true;
        return state;
      },
    }),
    (error) => error.code === "STATE_PATH_INVALID",
  );
  assert.equal(entered, false);

  await lease.release();
  await assert.rejects(
    () => compareAndUpdateStudioState(statePath, {
      lease,
      expectedRevision: 3,
      mutate: (state) => state,
    }),
    (error) => error.code === "LOCK_NOT_OWNED",
  );
  assert.deepEqual(await readStudioState(statePath), original);
});

test("a real operation lease authorizes CAS only while its claim remains owned", {
  skip: process.platform === "win32",
}, async (t) => {
  const { statePath } = await fixture(t);
  const lease = await seedState(t, statePath, stateAtRevision(3));
  const canonicalStatePath = statePath;

  const changed = await compareAndUpdateStudioState(canonicalStatePath, {
    lease,
    expectedRevision: 3,
    mutate: (state) => ({ ...state, persistenceEnabled: false }),
  });
  assert.equal(changed.revision, 4);
  assert.equal(changed.persistenceEnabled, false);

  assert.equal(await lease.release(), true);
  await assert.rejects(
    () => compareAndUpdateStudioState(canonicalStatePath, {
      lease,
      expectedRevision: 4,
      mutate: (state) => state,
    }),
    (error) => error.code === "LOCK_NOT_OWNED",
  );
  assert.deepEqual(await readStudioState(canonicalStatePath), changed);
});

test("state writes are private and atomic write failures clean sibling temporary files", async (t) => {
  const { root, statePath } = await fixture(t);
  const state = stateAtRevision(0);
  const lease = await acquireStateLease(t, statePath);
  await writeStudioState(statePath, state, { lease });
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  assert.deepEqual(await readStudioState(statePath), state);

  if (process.platform !== "win32" && typeof process.getuid === "function") {
    await chmod(statePath, 0o000);
    try {
      await assert.rejects(
        () => readStudioState(statePath),
        (error) => error.code === "STATE_FILE_MODE_INVALID",
      );
    } finally {
      await chmod(statePath, 0o600);
    }
  }

  const badPath = join(root, "atomic", "state.json");
  await mkdir(badPath, { recursive: true });
  await assert.rejects(
    () => writeStudioState(badPath, state, { lease }),
    (error) => error.code === "STATE_PATH_INVALID",
  );
  const siblings = await readdir(join(root, "atomic"));
  assert.deepEqual(siblings, ["state.json"]);
});

test("fault before rename preserves old state and cleans newly synced private directories", async (t) => {
  const { root, statePath } = await fixture(t);
  const original = stateAtRevision(0);
  const changed = stateAtRevision(1, { persistenceEnabled: false });
  const lease = await acquireStateLease(t, statePath);
  await writeStudioState(statePath, original, { lease });

  await assert.rejects(
    () => compareAndUpdateStudioState(statePath, {
      lease,
      expectedRevision: 0,
      mutate: () => changed,
      faultAt: "after-temp-sync",
    }),
    (error) => error.code === "FAULT_AFTER_TEMP_SYNC",
  );
  assert.deepEqual(await readStudioState(statePath), original);
  assert.equal(
    (await readdir(dirname(statePath))).some((name) => name.startsWith(".state.json.tmp-")),
    false,
  );

  const freshPath = join(root, "fresh", "nested", "state.json");
  await mkdir(join(root, "fresh"), { mode: 0o700 });
  const freshLease = await acquireStateLease(t, freshPath, "fault-init");
  await assert.rejects(
    () => writeStudioState(freshPath, original, {
      lease: freshLease,
      faultAt: "after-temp-sync",
    }),
    (error) => error.code === "FAULT_AFTER_TEMP_SYNC",
  );
  assert.equal(await readStudioState(freshPath), null);
  assert.equal(
    (await readdir(dirname(freshPath))).some((name) => name.startsWith(".state.json.tmp-")),
    false,
  );
  if (process.platform !== "win32") {
    assert.equal((await stat(dirname(freshPath))).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, "fresh"))).mode & 0o777, 0o700);
  }
});

test("POSIX readers reject links, non-files, wrong modes, and insecure parents", {
  skip: process.platform === "win32",
}, async (t) => {
  const { root, statePath } = await fixture(t);
  const state = stateAtRevision(0);
  const lease = await acquireStateLease(t, statePath);
  await writeStudioState(statePath, state, { lease });

  const targetPath = join(root, "outside-state.json");
  await writeFile(targetPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rm(statePath);
  await symlink(targetPath, statePath);
  await assert.rejects(
    () => readStudioState(statePath),
    (error) => error.code === "STATE_PATH_SYMLINK",
  );

  const outsideDirectory = join(root, "outside-state");
  const linkedDirectory = join(root, "linked-state");
  await mkdir(outsideDirectory, { mode: 0o700 });
  await writeFile(
    join(outsideDirectory, "state.json"),
    `${JSON.stringify(state)}\n`,
    { mode: 0o600 },
  );
  await symlink(outsideDirectory, linkedDirectory);
  await assert.rejects(
    () => readStudioState(join(linkedDirectory, "state.json")),
    (error) => error.code === "STATE_PARENT_SYMLINK",
  );

  await rm(statePath);
  await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await chmod(statePath, 0o644);
  await assert.rejects(
    () => readStudioState(statePath),
    (error) => error.code === "STATE_FILE_MODE_INVALID",
  );

  await chmod(statePath, 0o600);
  await chmod(dirname(statePath), 0o755);
  await assert.rejects(
    () => readStudioState(statePath),
    (error) => error.code === "STATE_PARENT_MODE_INVALID",
  );
  await chmod(dirname(statePath), 0o700);
  assert.deepEqual(await readStudioState(statePath), state);

  await rm(statePath);
  await mkdir(statePath, { mode: 0o700 });
  await assert.rejects(
    () => readStudioState(statePath),
    (error) => error.code === "STATE_FILE_TYPE_INVALID",
  );
});

test("journal and session readers reject unknown schemas and malformed shapes", async (t) => {
  const { sessionPath, transitionPath } = await fixture(t);
  const lease = await acquireStateLease(t, join(dirname(transitionPath), "state.json"));
  await writeTransitionJournal(transitionPath, disableJournal(), { lease });
  assert.equal((await stat(transitionPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readTransitionJournal(transitionPath), disableJournal());
  await writeTransitionJournal(
    transitionPath,
    disableJournal({ stage: "state-committed" }),
    { lease },
  );
  await writeTransitionJournal(
    transitionPath,
    disableJournal({ stage: "session-committed" }),
    { lease },
  );
  assert.equal(
    await clearTransitionJournal(transitionPath, { lease, nonce: "transition-1" }),
    true,
  );
  assert.equal(
    await clearTransitionJournal(transitionPath, { lease, nonce: "transition-1" }),
    false,
  );
  assert.equal(await readTransitionJournal(transitionPath), null);

  await mkdir(join(transitionPath, ".."), { recursive: true });
  await writeFile(
    transitionPath,
    JSON.stringify({ ...disableJournal(), schemaVersion: 9 }),
    { mode: 0o600 },
  );
  await assert.rejects(() => readTransitionJournal(transitionPath), /schema/i);
  await writeFile(transitionPath, "{");
  await assert.rejects(() => readTransitionJournal(transitionPath), /迁移日志损坏/);

  await writeFile(sessionPath, JSON.stringify({ schemaVersion: 9 }), { mode: 0o600 });
  await assert.rejects(() => readSessionState(sessionPath), /schema/i);
  await writeFile(sessionPath, JSON.stringify({
    schemaVersion: 1,
    mode: "unknown",
    process: null,
    activeThemeId: null,
    keepUntilProcessExit: false,
  }));
  await assert.rejects(() => readSessionState(sessionPath));
});

test("session modes enforce their documented discriminated invariants", () => {
  const active = {
    schemaVersion: 1,
    mode: "active",
    process: CURRENT_PROCESS,
    activeThemeId: DEFAULT_THEME_ID,
    keepUntilProcessExit: false,
  };

  for (const malformed of [
    { ...active, process: null },
    { ...active, activeThemeId: null },
    { ...active, mode: "paused", process: null, activeThemeId: null },
    { ...active, mode: "paused" },
    { ...active, mode: "native", activeThemeId: DEFAULT_THEME_ID },
    { ...active, mode: "restoring", process: null, activeThemeId: null },
    {
      ...active,
      mode: "restoring",
      activeThemeId: null,
      keepUntilProcessExit: true,
    },
    { ...active, mode: "error" },
    { ...active, mode: "error", activeThemeId: null, keepUntilProcessExit: true },
  ]) {
    assert.throws(() => validateSessionState(malformed), /session mode invariant/i);
  }

  for (const valid of [
    active,
    { ...active, mode: "paused", activeThemeId: null },
    {
      ...active,
      mode: "paused",
      activeThemeId: null,
      keepUntilProcessExit: true,
    },
    {
      ...active,
      mode: "native",
      process: null,
      activeThemeId: null,
    },
    {
      ...active,
      mode: "native",
      activeThemeId: null,
      keepUntilProcessExit: true,
    },
    { ...active, mode: "restoring", activeThemeId: null },
    {
      ...active,
      mode: "error",
      process: null,
      activeThemeId: null,
    },
    { ...active, mode: "error", activeThemeId: null },
  ]) {
    assert.deepEqual(validateSessionState(valid), valid);
  }
});

test("prepared recovery commits state, rebuilds exact live session, and clears journal", async (t) => {
  const { statePath, sessionPath, transitionPath } = await fixture(t);
  const lease = await seedState(t, statePath, stateAtRevision(3));
  await seedJournal(transitionPath, disableJournal(), lease);

  const recovered = await recoverStateTransition({
    statePath,
    sessionPath,
    transitionPath,
    lease,
    currentProcess: CURRENT_PROCESS,
  });

  assert.equal(recovered.state.persistenceEnabled, false);
  assert.equal(recovered.state.revision, 4);
  assert.equal(recovered.state.lastTransitionNonce, "transition-1");
  assert.deepEqual(recovered.session, {
    schemaVersion: 1,
    mode: "active",
    process: CURRENT_PROCESS,
    activeThemeId: DEFAULT_THEME_ID,
    keepUntilProcessExit: true,
  });
  assert.deepEqual(await readSessionState(sessionPath), recovered.session);
  assert.equal(await readTransitionJournal(transitionPath), null);
});

test("composite recovery cannot interleave with CAS on the same genuine lease", async (t) => {
  const { statePath, sessionPath, transitionPath } = await fixture(t);
  const lease = await seedState(t, statePath, stateAtRevision(3));
  await seedJournal(transitionPath, disableJournal(), lease);

  const results = await Promise.allSettled([
    recoverStateTransition({
      statePath,
      sessionPath,
      transitionPath,
      lease,
      currentProcess: CURRENT_PROCESS,
    }),
    compareAndUpdateStudioState(statePath, {
      lease,
      expectedRevision: 3,
      mutate: (state) => ({ ...state, selectedThemeId: NATIVE_THEME_ID }),
    }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);

  const state = await readStudioState(statePath);
  const journal = await readTransitionJournal(transitionPath);
  const session = await readSessionState(sessionPath);
  if (journal === null) {
    assert.equal(state.lastTransitionNonce, "transition-1");
    assert.notEqual(session, null);
  } else {
    assert.equal(journal.stage, "prepared");
    assert.equal(state.lastTransitionNonce, null);
    assert.equal(session, null);
  }
});

test("prepared recovery resumes an already committed CAS without another revision", async (t) => {
  const { statePath, sessionPath, transitionPath } = await fixture(t);
  const lease = await seedState(t, statePath, stateAtRevision(3));
  await seedJournal(transitionPath, disableJournal(), lease);
  await compareAndUpdateStudioState(statePath, {
    lease,
    expectedRevision: 3,
    mutate: (state) => ({
      ...state,
      persistenceEnabled: false,
      lastTransitionNonce: "transition-1",
    }),
  });

  const recovered = await recoverStateTransition({
    statePath,
    sessionPath,
    transitionPath,
    lease,
    currentProcess: CURRENT_PROCESS,
  });
  assert.equal(recovered.state.revision, 4);
  assert.equal(recovered.session.keepUntilProcessExit, true);
  assert.equal(await readTransitionJournal(transitionPath), null);
});

test("state-committed and session-committed recovery stages are idempotent", async (t) => {
  for (const stage of ["state-committed", "session-committed"]) {
    const paths = await fixture(t);
    const committed = stateAtRevision(4, {
      persistenceEnabled: false,
      lastTransitionNonce: "transition-1",
    });
    const session = {
      schemaVersion: 1,
      mode: "active",
      process: CURRENT_PROCESS,
      activeThemeId: DEFAULT_THEME_ID,
      keepUntilProcessExit: true,
    };
    const lease = await seedState(t, paths.statePath, committed);
    await seedJournal(paths.transitionPath, disableJournal({ stage }), lease);
    if (stage === "session-committed") {
      await writeSessionState(paths.sessionPath, session, { lease });
    }

    const recovered = await recoverStateTransition({
      statePath: paths.statePath,
      sessionPath: paths.sessionPath,
      transitionPath: paths.transitionPath,
      lease,
      currentProcess: CURRENT_PROCESS,
    });
    assert.deepEqual(recovered.state, committed);
    assert.deepEqual(recovered.session, session);
    assert.equal(await readTransitionJournal(paths.transitionPath), null);
  }
});

test("transition recovery fails closed on revision, desired value, or nonce mismatch", async (t) => {
  const cases = [
    stateAtRevision(5, { persistenceEnabled: false, lastTransitionNonce: "transition-1" }),
    stateAtRevision(4, { persistenceEnabled: true, lastTransitionNonce: "transition-1" }),
    stateAtRevision(4, { persistenceEnabled: false, lastTransitionNonce: "someone-else" }),
  ];

  for (const state of cases) {
    const paths = await fixture(t);
    const lease = await seedState(t, paths.statePath, state);
    await seedJournal(paths.transitionPath, disableJournal(), lease);
    await assert.rejects(
      () => recoverStateTransition({
        statePath: paths.statePath,
        sessionPath: paths.sessionPath,
        transitionPath: paths.transitionPath,
        lease,
        currentProcess: CURRENT_PROCESS,
      }),
      (error) => {
        assert.equal(error.code, "TRANSITION_CONFLICT");
        assert.equal(error.revision, state.revision);
        assert.equal(error.persistenceEnabled, state.persistenceEnabled);
        assert.deepEqual(Object.keys(error).sort(), [
          "code",
          "persistenceEnabled",
          "revision",
        ]);
        const serialized = JSON.stringify(error);
        assert.doesNotMatch(serialized, new RegExp(CONTROL_TOKEN));
        assert.doesNotMatch(serialized, /executablePath|transition-1|journal|process/);
        return true;
      },
    );
    assert.notEqual(await readTransitionJournal(paths.transitionPath), null);
    assert.equal(await readSessionState(paths.sessionPath), null);
  }
});

test("disable recovery completes without retaining injection after the exact process exits", async (t) => {
  const { statePath, sessionPath, transitionPath } = await fixture(t);
  const lease = await seedState(t, statePath, stateAtRevision(3));
  await seedJournal(transitionPath, disableJournal(), lease);

  const recovered = await recoverStateTransition({
    statePath,
    sessionPath,
    transitionPath,
    lease,
    currentProcess: null,
  });
  assert.equal(recovered.state.persistenceEnabled, false);
  assert.deepEqual(recovered.session, {
    schemaVersion: 1,
    mode: "native",
    process: null,
    activeThemeId: null,
    keepUntilProcessExit: false,
  });
  assert.equal(await readTransitionJournal(transitionPath), null);
});

test("state mutation APIs reject duck-typed leases before entering CAS", async (t) => {
  const { statePath } = await fixture(t);
  const realLease = await acquireStateLease(t, statePath, "seed-state");
  await writeStudioState(statePath, stateAtRevision(0), { lease: realLease });
  let entered = false;
  const fakeLease = {
    lockPath: join(dirname(statePath), "operation.lock"),
    async assertOwned() {},
  };

  await assert.rejects(
    () => compareAndUpdateStudioState(statePath, {
      lease: fakeLease,
      expectedRevision: 0,
      mutate: (state) => {
        entered = true;
        return state;
      },
    }),
    (error) => error.code === "LOCK_CAPABILITY_INVALID",
  );
  assert.equal(entered, false);
});

test("raw state, session, and journal mutations require a branded lease", async (t) => {
  const paths = await fixture(t);
  const session = {
    schemaVersion: 1,
    mode: "native",
    process: null,
    activeThemeId: null,
    keepUntilProcessExit: false,
  };

  await assert.rejects(
    () => writeStudioState(paths.statePath, stateAtRevision(0)),
    (error) => error.code === "LOCK_CAPABILITY_INVALID",
  );
  await assert.rejects(
    () => writeSessionState(paths.sessionPath, session),
    (error) => error.code === "LOCK_CAPABILITY_INVALID",
  );
  await assert.rejects(
    () => writeTransitionJournal(paths.transitionPath, disableJournal()),
    (error) => error.code === "LOCK_CAPABILITY_INVALID",
  );
  await assert.rejects(
    () => clearTransitionJournal(paths.transitionPath),
    (error) => error.code === "LOCK_CAPABILITY_INVALID",
  );
});

test("state initialization is absent-only revision zero and journals advance monotonically", async (t) => {
  const paths = await fixture(t);
  const lease = await acquireStateLease(t, paths.statePath);

  await assert.rejects(
    () => writeStudioState(paths.statePath, stateAtRevision(1), { lease }),
    /revision 0/i,
  );
  await writeStudioState(paths.statePath, stateAtRevision(0), { lease });
  await assert.rejects(
    () => writeStudioState(paths.statePath, stateAtRevision(0), { lease }),
    /already exists/i,
  );

  await writeTransitionJournal(paths.transitionPath, disableJournal(), { lease });
  await assert.rejects(
    () => writeTransitionJournal(paths.transitionPath, disableJournal({
      nonce: "different-transition",
      stage: "state-committed",
    }), { lease }),
    /nonce|immutable/i,
  );
  await assert.rejects(
    () => writeTransitionJournal(paths.transitionPath, disableJournal({
      stage: "session-committed",
    }), { lease }),
    /stage|monotonic/i,
  );
});

test("readers reject a symlink in any existing ancestor", {
  skip: process.platform === "win32",
}, async (t) => {
  const { root } = await fixture(t);
  const outside = join(root, "outside");
  const inside = join(outside, "inner");
  const alias = join(root, "alias");
  await mkdir(inside, { recursive: true, mode: 0o700 });
  await chmod(outside, 0o700);
  await chmod(inside, 0o700);
  await writeFile(
    join(inside, "state.json"),
    `${JSON.stringify(stateAtRevision(0))}\n`,
    { mode: 0o600 },
  );
  await symlink(outside, alias);

  await assert.rejects(
    () => readStudioState(join(alias, "inner", "state.json")),
    (error) => error.code === "STATE_PARENT_SYMLINK",
  );
});
