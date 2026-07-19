import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  acquireOperationLock,
  withOperationLock,
} from "../src/operation-lock.mjs";

const CREATED_AT = "2026-07-17T01:00:00.000Z";
const OWNER = {
  pid: 31_001,
  startedAt: "2026-07-17T00:00:00.000Z",
};
const CONTENDER = {
  pid: 31_002,
  startedAt: "2026-07-17T00:01:00.000Z",
};

function ownerRecord({
  identity = OWNER,
  nonce = "owner-nonce",
  operation = "apply",
  heartbeat = CREATED_AT,
  predecessor = null,
} = {}) {
  return {
    schemaVersion: 2,
    nonce,
    pid: identity.pid,
    operation,
    startedAt: identity.startedAt,
    createdAt: CREATED_AT,
    heartbeat,
    predecessor,
  };
}

function heartbeatPath(lockPath, nonce) {
  return `${lockPath}.heartbeat.${nonce}`;
}

function stagingPath(lockPath, identity, nonce) {
  return `${lockPath}.staging.${identity.pid}.${nonce}`;
}

function successorPath(lockPath, nonce) {
  return `${lockPath}.successor.${nonce}`;
}

function releasePath(lockPath, nonce) {
  return `${lockPath}.released.${nonce}`;
}

function heartbeatTempPath(lockPath, nonce, temporaryNonce = "temporary") {
  return `${lockPath}.heartbeat.${nonce}.tmp.${temporaryNonce}`;
}

async function readTail(lockPath) {
  let path = lockPath;
  let current = JSON.parse(await readFile(path, "utf8"));
  while (await exists(successorPath(lockPath, current.nonce))) {
    path = successorPath(lockPath, current.nonce);
    current = JSON.parse(await readFile(path, "utf8"));
  }
  return { owner: current, path };
}

async function writePrivateJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function seedLock(lockPath, record = ownerRecord()) {
  await mkdir(join(lockPath, ".."), { recursive: true, mode: 0o700 });
  await writePrivateJson(lockPath, record);
  await writePrivateJson(heartbeatPath(lockPath, record.nonce), {
    schemaVersion: 2,
    nonce: record.nonce,
    pid: record.pid,
    startedAt: record.startedAt,
    heartbeat: record.heartbeat,
  });
  return record;
}

const skipPosixLock = process.platform === "win32"
  ? "POSIX file-lock protocol is not used on win32"
  : false;

async function exists(path) {
  return stat(path).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}

async function fixture(t) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "heige-operation-lock-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    lockPath: join(root, "runtime", "operation.lock"),
  };
}

function acquisitionOptions(lockPath, overrides = {}) {
  return {
    lockPath,
    stateRoot: dirname(lockPath),
    operation: "restore",
    identity: CONTENDER,
    readProcessIdentity: async () => null,
    now: () => new Date("2026-07-17T01:02:03.000Z"),
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function runNodeChild(source) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { ...result, stderr };
}

async function operationArtifactSummary(lockPath) {
  const parentPath = dirname(lockPath);
  const names = (await readdir(parentPath)).filter((name) =>
    name.startsWith(basename(lockPath)));
  const reachable = new Set();
  if (!(await exists(lockPath))) return { extras: names, names, reachable };

  let path = lockPath;
  while (true) {
    const owner = JSON.parse(await readFile(path, "utf8"));
    reachable.add(basename(path));
    for (const related of [
      heartbeatPath(lockPath, owner.nonce),
      releasePath(lockPath, owner.nonce),
    ]) {
      if (await exists(related)) reachable.add(basename(related));
    }
    const nextPath = successorPath(lockPath, owner.nonce);
    if (!(await exists(nextPath))) break;
    path = nextPath;
  }
  return {
    extras: names.filter((name) => !reachable.has(name)),
    names,
    reachable,
  };
}

async function assertOnlyReachableArtifacts(lockPath, upperBound) {
  const summary = await operationArtifactSummary(lockPath);
  assert.deepEqual(summary.extras, [], `unreachable artifacts: ${summary.extras}`);
  assert.ok(
    summary.names.length <= upperBound,
    `found ${summary.names.length} operation.lock artifacts, expected <= ${upperBound}`,
  );
}

test("a live owner is never stolen even with a stale heartbeat", {
  skip: skipPosixLock,
}, async (t) => {
  const { lockPath } = await fixture(t);
  const stale = ownerRecord({ heartbeat: "2000-01-01T00:00:00.000Z" });
  await seedLock(lockPath, stale);

  await assert.rejects(
    acquireOperationLock(
      acquisitionOptions(lockPath, {
        readProcessIdentity: async (pid) => (pid === OWNER.pid ? OWNER : null),
      }),
    ),
    (error) => error.code === "LOCK_HELD",
  );

  assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), stale);
});

test("the protected action never runs when lock acquisition fails", {
  skip: skipPosixLock,
}, async (t) => {
  const { lockPath } = await fixture(t);
  await seedLock(lockPath);
  let protectedActionRan = false;

  await assert.rejects(
    withOperationLock(
      acquisitionOptions(lockPath, {
        readProcessIdentity: async () => OWNER,
      }),
      async () => {
        protectedActionRan = true;
      },
    ),
    (error) => error.code === "LOCK_HELD",
  );

  assert.equal(protectedActionRan, false);
});

test("filesystem claims retain exact 64-bit identities as bigint", async (t) => {
  const { lockPath } = await fixture(t);
  let publishedMetadata;
  const lease = await acquireOperationLock(acquisitionOptions(lockPath, {
    testHooks: {
      "after-publish": async ({ claim }) => {
        publishedMetadata = claim.metadata;
      },
    },
  }));
  t.after(() => lease.release());

  const exact = await stat(lockPath, { bigint: true });
  assert.equal(typeof publishedMetadata.dev, "bigint");
  assert.equal(typeof publishedMetadata.ino, "bigint");
  assert.deepEqual(publishedMetadata, { dev: exact.dev, ino: exact.ino });
});

test("withOperationLock releases the lease when the protected action throws", async (t) => {
  const { lockPath } = await fixture(t);
  const failure = new Error("protected action failed");
  let nonce;

  await assert.rejects(
    withOperationLock(acquisitionOptions(lockPath), async (lease) => {
      assert.equal(await exists(lockPath), true);
      assert.equal(typeof lease.nonce, "string");
      nonce = lease.nonce;
      throw failure;
    }),
    (error) => error === failure,
  );

  assert.equal(await exists(lockPath), true);
  assert.equal(await exists(releasePath(lockPath, nonce)), true);
});

test("a crash before atomic publication leaves no blocking empty lock", async (t) => {
  const { lockPath } = await fixture(t);

  await assert.rejects(
    acquireOperationLock(
      acquisitionOptions(lockPath, { faultAt: "before-publish" }),
    ),
    (error) => error.code === "FAULT_BEFORE_PUBLISH",
  );
  assert.equal(await exists(lockPath), false);

  const leftover = (await readdir(join(lockPath, ".."))).find((entry) =>
    entry.startsWith(`${basename(lockPath)}.staging.`),
  );
  assert.ok(leftover, "the injected crash should leave only an inert staging file");
  const leftoverPath = join(lockPath, "..", leftover);
  assert.ok(JSON.parse(await readFile(leftoverPath, "utf8")).nonce);
  assert.equal((await stat(leftoverPath)).mode & 0o777, 0o600);

  const lease = await acquireOperationLock(acquisitionOptions(lockPath));
  t.after(() => lease.release());
  const published = JSON.parse(await readFile(lockPath, "utf8"));

  assert.deepEqual(Object.keys(published).sort(), [
    "createdAt",
    "heartbeat",
    "nonce",
    "operation",
    "pid",
    "predecessor",
    "schemaVersion",
    "startedAt",
  ]);
  assert.equal(typeof published.nonce, "string");
  assert.ok(published.nonce.length >= 16);
  assert.equal((await stat(lockPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(lockPath, ".."))).mode & 0o777, 0o700);
});

test("PID reuse permits takeover only after the start time differs", async (t) => {
  const { lockPath } = await fixture(t);
  const old = await seedLock(lockPath);
  const reused = { pid: old.pid, startedAt: "2026-07-17T01:01:01.000Z" };

  const lease = await acquireOperationLock(
    acquisitionOptions(lockPath, {
      readProcessIdentity: async (pid) => (pid === old.pid ? reused : null),
    }),
  );
  t.after(() => lease.release());

  const current = (await readTail(lockPath)).owner;
  assert.notEqual(current.nonce, old.nonce);
  assert.equal(current.pid, CONTENDER.pid);
  assert.equal(await exists(heartbeatPath(lockPath, old.nonce)), true);
});

test("a proven dead owner can be taken over", async (t) => {
  const { lockPath } = await fixture(t);
  const dead = await seedLock(lockPath);

  const lease = await acquireOperationLock(acquisitionOptions(lockPath));
  t.after(() => lease.release());

  assert.notEqual(
    (await readTail(lockPath)).owner.nonce,
    dead.nonce,
  );
});

test("a malformed published owner fails closed and is never deleted", async (t) => {
  const { lockPath } = await fixture(t);
  await mkdir(join(lockPath, ".."), { recursive: true, mode: 0o700 });
  await writeFile(lockPath, "{bad", { mode: 0o600 });

  await assert.rejects(
    acquireOperationLock(acquisitionOptions(lockPath)),
    (error) => error.code === "LOCK_MALFORMED",
  );
  assert.equal(await readFile(lockPath, "utf8"), "{bad");
});

test("a well-formed owner with a blank process start identity fails closed", async (t) => {
  const { lockPath } = await fixture(t);
  const malformed = ownerRecord();
  malformed.startedAt = "   ";
  await seedLock(lockPath, malformed);

  await assert.rejects(
    acquireOperationLock(acquisitionOptions(lockPath)),
    (error) => error.code === "LOCK_MALFORMED",
  );
  assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), malformed);
});

test("a published owner with unsafe permissions fails closed", async (t) => {
  const { lockPath } = await fixture(t);
  await seedLock(lockPath);
  await chmod(lockPath, 0o644);

  await assert.rejects(
    acquireOperationLock(acquisitionOptions(lockPath)),
    (error) => error.code === "LOCK_PERMISSIONS",
  );
  assert.equal(await exists(lockPath), true);
});

test("heartbeats atomically update a nonce-bound sibling without rewriting owner", async (t) => {
  const { lockPath } = await fixture(t);
  const times = [
    new Date("2026-07-17T01:02:03.000Z"),
    new Date("2026-07-17T01:03:04.000Z"),
  ];
  const lease = await acquireOperationLock(
    acquisitionOptions(lockPath, { now: () => times.shift() }),
  );
  t.after(() => lease.release());
  const immutableOwner = await readFile(lockPath, "utf8");

  await lease.heartbeat();

  assert.equal(await readFile(lockPath, "utf8"), immutableOwner);
  const heartbeat = JSON.parse(await readFile(lease.heartbeatPath, "utf8"));
  assert.equal(heartbeat.nonce, lease.nonce);
  assert.equal(heartbeat.pid, CONTENDER.pid);
  assert.equal(heartbeat.startedAt, CONTENDER.startedAt);
  assert.equal(heartbeat.heartbeat, "2026-07-17T01:03:04.000Z");
  assert.equal((await stat(lease.heartbeatPath)).mode & 0o777, 0o600);
  assert.equal(
    (await readdir(join(lockPath, ".."))).some((entry) => entry.includes("heartbeat-tmp")),
    false,
  );
});

test("release is idempotent", async (t) => {
  const { lockPath } = await fixture(t);
  const lease = await acquireOperationLock(acquisitionOptions(lockPath));

  await lease.release();
  await lease.release();

  assert.equal(await exists(lockPath), true);
  assert.equal(await exists(releasePath(lockPath, lease.nonce)), true);
  assert.equal(await exists(lease.heartbeatPath), true);
});

test("release surfaces corruption instead of treating it as benign ownership loss", async (t) => {
  const { lockPath } = await fixture(t);
  const lease = await acquireOperationLock(acquisitionOptions(lockPath));
  await writeFile(lockPath, "{corrupt", { mode: 0o600 });

  await assert.rejects(
    lease.release(),
    (error) => {
      assert.equal(error.code, "LOCK_RELEASE_FAILED");
      assert.equal(error.cause.code, "LOCK_NOT_OWNED");
      assert.equal(error.cause.cause.code, "LOCK_MALFORMED");
      return true;
    },
  );
});

test("startup preserves a misbound release marker for a reachable claim", async (t) => {
  const { lockPath } = await fixture(t);
  const lease = await acquireOperationLock(acquisitionOptions(lockPath));
  const malformed = {
    schemaVersion: 2,
    nonce: lease.nonce,
    pid: lease.owner.pid,
    startedAt: lease.owner.startedAt,
    claim: { dev: "wrong-device", ino: "wrong-inode" },
    releasedAt: "2026-07-17T01:04:00.000Z",
  };
  await writePrivateJson(releasePath(lockPath, lease.nonce), malformed);

  await assert.rejects(
    acquireOperationLock(acquisitionOptions(lockPath, {
      identity: OWNER,
      readProcessIdentity: async () => null,
    })),
    (error) => error.code === "LOCK_RELEASE_MALFORMED",
  );
  assert.deepEqual(
    JSON.parse(await readFile(releasePath(lockPath, lease.nonce), "utf8")),
    malformed,
  );
});

test("release never removes a replacement owner with a different nonce", async (t) => {
  const { lockPath } = await fixture(t);
  const oldLease = await acquireOperationLock(acquisitionOptions(lockPath));
  await unlink(lockPath);
  const replacement = ownerRecord({
    identity: OWNER,
    nonce: "replacement-nonce",
    operation: "apply",
  });
  await seedLock(lockPath, replacement);

  await oldLease.release();

  assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), replacement);
  assert.equal(await exists(heartbeatPath(lockPath, replacement.nonce)), true);
});

test("concurrent acquisition has exactly one winner", async (t) => {
  const { lockPath } = await fixture(t);
  const first = { pid: 41_001, startedAt: "2026-07-17T02:00:00.000Z" };
  const second = { pid: 41_002, startedAt: "2026-07-17T02:00:01.000Z" };
  const processes = new Map([
    [first.pid, first],
    [second.pid, second],
  ]);
  const readProcessIdentity = async (pid) => processes.get(pid) ?? null;

  const results = await Promise.allSettled([
    acquireOperationLock(
      acquisitionOptions(lockPath, { identity: first, readProcessIdentity }),
    ),
    acquireOperationLock(
      acquisitionOptions(lockPath, { identity: second, readProcessIdentity }),
    ),
  ]);

  const winners = results.filter(({ status }) => status === "fulfilled");
  const losers = results.filter(({ status }) => status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].reason.code, "LOCK_HELD");
  await winners[0].value.release();
});

test("startup removes only strict staging files whose exact process identity is gone", async (t) => {
  const { lockPath } = await fixture(t);
  await mkdir(join(lockPath, ".."), { recursive: true, mode: 0o700 });
  const live = { pid: 51_001, startedAt: "2026-07-17T03:00:00.000Z" };
  const reused = { pid: 51_002, startedAt: "2026-07-17T03:00:01.000Z" };
  const dead = { pid: 51_003, startedAt: "2026-07-17T03:00:02.000Z" };
  const livePath = stagingPath(lockPath, live, "live");
  const reusedPath = stagingPath(lockPath, reused, "reused");
  const deadPath = stagingPath(lockPath, dead, "dead");
  const malformedPath = stagingPath(lockPath, { pid: 51_004 }, "malformed");
  await writePrivateJson(livePath, ownerRecord({ identity: live, nonce: "live" }));
  await writePrivateJson(reusedPath, ownerRecord({ identity: reused, nonce: "reused" }));
  await writePrivateJson(deadPath, ownerRecord({ identity: dead, nonce: "dead" }));
  await writeFile(malformedPath, "{bad", { mode: 0o600 });

  const lease = await acquireOperationLock(
    acquisitionOptions(lockPath, {
      readProcessIdentity: async (pid) => {
        if (pid === live.pid) return live;
        if (pid === reused.pid) {
          return { ...reused, startedAt: "2026-07-17T03:09:09.000Z" };
        }
        return null;
      },
    }),
  );
  t.after(() => lease.release());

  assert.equal(await exists(livePath), true, "live staging ownership must be preserved");
  assert.equal(await exists(reusedPath), false, "PID-reused staging may be removed");
  assert.equal(await exists(deadPath), false, "dead staging may be removed");
  assert.equal(await exists(malformedPath), true, "unprovable staging must be preserved");
});

test("takeover rechecks the reachable head after a process-probe race", async (t) => {
  const { lockPath } = await fixture(t);
  const old = await seedLock(lockPath);
  const replacementIdentity = {
    pid: 61_001,
    startedAt: "2026-07-17T04:00:00.000Z",
  };
  const replacement = ownerRecord({
    identity: replacementIdentity,
    nonce: "new-owner-nonce",
  });
  let replaced = false;

  await assert.rejects(
    acquireOperationLock(
      acquisitionOptions(lockPath, {
        readProcessIdentity: async (pid) => {
          if (pid === old.pid && !replaced) {
            replaced = true;
            await unlink(lockPath);
            await seedLock(lockPath, replacement);
            return null;
          }
          if (pid === replacementIdentity.pid) return replacementIdentity;
          return null;
        },
      }),
    ),
    (error) => error.code === "LOCK_HELD",
  );

  assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), replacement);
});

test("relative lock paths are rejected before touching the filesystem", async () => {
  await assert.rejects(
    acquireOperationLock(acquisitionOptions("relative/operation.lock")),
    (error) => error.code === "LOCK_PATH_INVALID",
  );
});

test("a lease exposes assertOwned and fails closed after a successor takes over", async (t) => {
  const { lockPath } = await fixture(t);
  const oldLease = await acquireOperationLock(acquisitionOptions(lockPath));

  assert.equal(await oldLease.assertOwned(), true);

  const successorIdentity = {
    pid: 71_001,
    startedAt: "2026-07-17T05:00:00.000Z",
  };
  const successor = await acquireOperationLock(
    acquisitionOptions(lockPath, {
      identity: successorIdentity,
      readProcessIdentity: async () => null,
    }),
  );
  t.after(() => successor.release());

  await assert.rejects(
    oldLease.assertOwned(),
    (error) => error.code === "LOCK_NOT_OWNED",
  );
  assert.equal(await successor.assertOwned(), true);
});

test("a symlink ancestor below stateRoot is rejected without touching its target", async (t) => {
  const { root } = await fixture(t);
  const stateRoot = join(root, "state");
  const outside = join(root, "outside");
  await mkdir(stateRoot, { mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, join(stateRoot, "redirect"));
  const lockPath = join(stateRoot, "redirect", "runtime", "operation.lock");

  await assert.rejects(
    acquireOperationLock(
      acquisitionOptions(lockPath, { stateRoot }),
    ),
    (error) => error.code === "LOCK_PATH_INVALID",
  );

  assert.equal(await exists(join(outside, "runtime")), false);
});

function fakeWindowsSecurity(events = []) {
  return {
    async protectDirectory(path) { events.push(["protect-directory", path]); },
    async protectFile(path) { events.push(["protect-file", path]); },
    async migrateDirectory(path) { events.push(["migrate-directory", path]); },
    async migrateFile(path) { events.push(["migrate-file", path]); },
    async verifyDirectory(path) { events.push(["verify-directory", path]); },
    async verifyFile(path) { events.push(["verify-file", path]); },
  };
}

test("Windows operation lease publishes atomically and releases its exact private owner", async (t) => {
  const { root } = await fixture(t);
  const stateRoot = join(root, "not-created");
  const lockPath = join(stateRoot, "operation.lock");
  const securityEvents = [];
  const options = acquisitionOptions(lockPath, {
    platform: "win32",
    stateRoot,
    windowsSecurity: fakeWindowsSecurity(securityEvents),
  });

  const lease = await acquireOperationLock(options);
  assert.equal(await lease.assertOwned(), true);
  assert.equal(await exists(lockPath), true);
  assert.equal(await lease.release(), true);
  assert.equal(await exists(lockPath), false);
  assert.equal(securityEvents.some(([action]) => action === "protect-directory"), true);
  assert.equal(securityEvents.some(([action]) => action === "verify-file"), true);
});

test("Windows owner publication batches ACL work without duplicate read verification", async (t) => {
  const { root } = await fixture(t);
  const stateRoot = join(root, "batched-windows-state");
  const lockPath = join(stateRoot, "operation.lock");
  const batches = [];
  const security = {
    ...fakeWindowsSecurity(),
    async batch(operations) {
      batches.push(operations.map((entry) => entry.action));
      return operations.map(() => undefined);
    },
  };
  const lease = await acquireOperationLock(acquisitionOptions(lockPath, {
    platform: "win32",
    stateRoot,
    windowsSecurity: security,
  }));
  t.after(() => lease.release());

  assert.deepEqual(batches, [
    ["protect-directory", "verify-directory"],
    ["protect-directory", "protect-file", "verify-directory", "verify-file"],
    ["protect-directory", "protect-file", "verify-directory", "verify-file"],
  ]);
});

test("Windows state root ACL is reused after its directory identity is verified", async (t) => {
  const { root } = await fixture(t);
  const stateRoot = join(root, "cached-windows-state");
  const lockPath = join(stateRoot, "operation.lock");
  const batches = [];
  const security = {
    ...fakeWindowsSecurity(),
    async batch(operations) {
      batches.push(operations.map((entry) => ({ ...entry })));
      return operations.map(() => undefined);
    },
  };
  const options = acquisitionOptions(lockPath, {
    platform: "win32",
    stateRoot,
    windowsSecurity: security,
  });

  const first = await acquireOperationLock(options);
  assert.equal(await first.release(), true);
  const second = await acquireOperationLock(options);
  t.after(() => second.release());

  const stateRootBatches = batches.filter((operations) =>
    operations.some((entry) => entry.path === stateRoot));
  assert.equal(stateRootBatches.length, 1);
});

test("Windows operation lease safely migrates a current-user-owned legacy state root ACL", async (t) => {
  const { root } = await fixture(t);
  const stateRoot = join(root, "legacy-windows-state");
  const lockPath = join(stateRoot, "operation.lock");
  await mkdir(stateRoot);
  const securityEvents = [];
  const lease = await acquireOperationLock(acquisitionOptions(lockPath, {
    platform: "win32",
    stateRoot,
    windowsSecurity: fakeWindowsSecurity(securityEvents),
  }));
  t.after(() => lease.release());

  assert.deepEqual(securityEvents.slice(0, 2), [
    ["migrate-directory", stateRoot],
    ["verify-directory", stateRoot],
  ]);
  assert.equal(await lease.assertOwned(), true);
});

test("Windows operation lease has one concurrent winner and recovers a proven-dead owner", async (t) => {
  const { root } = await fixture(t);
  const stateRoot = join(root, "windows-state");
  const lockPath = join(stateRoot, "operation.lock");
  const windowsSecurity = fakeWindowsSecurity();
  const live = new Map([[CONTENDER.pid, CONTENDER.startedAt]]);
  const options = (identity) => acquisitionOptions(lockPath, {
    platform: "win32",
    stateRoot,
    identity,
    windowsSecurity,
    readProcessIdentity: async (pid) => live.has(pid)
      ? { pid, startedAt: live.get(pid) }
      : null,
  });

  const first = await acquireOperationLock(options(CONTENDER));
  await assert.rejects(
    acquireOperationLock(options({ pid: 31_003, startedAt: "2026-07-17T00:03:00.000Z" })),
    (error) => error.code === "LOCK_HELD",
  );
  live.delete(CONTENDER.pid);
  const successorIdentity = { pid: 31_003, startedAt: "2026-07-17T00:03:00.000Z" };
  live.set(successorIdentity.pid, successorIdentity.startedAt);
  const successor = await acquireOperationLock(options(successorIdentity));
  assert.equal(await successor.assertOwned(), true);
  assert.equal(await first.release(), false);
  assert.equal(await successor.release(), true);

  const artifacts = await readdir(stateRoot);
  assert.deepEqual(artifacts, []);
});

test("Windows cleanup preserves a live producer's delayed released artifact during successor acquire", async (t) => {
  const { root } = await fixture(t);
  const stateRoot = join(root, "windows-release-race");
  const lockPath = join(stateRoot, "operation.lock");
  const security = fakeWindowsSecurity();
  const releaseRenamed = deferred();
  const allowReleaseCleanup = deferred();
  const successorIdentity = {
    pid: 31_003,
    startedAt: "2026-07-17T00:03:00.000Z",
  };
  const live = new Map([
    [CONTENDER.pid, CONTENDER.startedAt],
    [successorIdentity.pid, successorIdentity.startedAt],
  ]);
  const common = {
    platform: "win32",
    stateRoot,
    windowsSecurity: security,
    readProcessIdentity: async (pid) => live.has(pid)
      ? { pid, startedAt: live.get(pid) }
      : null,
  };
  const first = await acquireOperationLock(acquisitionOptions(lockPath, {
    ...common,
    testHooks: {
      "after-windows-release-rename": async ({ releasePath: path }) => {
        releaseRenamed.resolve(path);
        await allowReleaseCleanup.promise;
      },
    },
  }));

  const release = first.release();
  const releasedPath = await releaseRenamed.promise;
  assert.equal(await exists(releasedPath), true);
  const successor = await acquireOperationLock(acquisitionOptions(lockPath, {
    ...common,
    identity: successorIdentity,
  }));
  t.after(() => successor.release());
  assert.equal(await exists(releasedPath), true);
  assert.equal(await successor.assertOwned(), true);

  allowReleaseCleanup.resolve();
  assert.equal(await release, true);
  assert.equal(await exists(releasedPath), false);
});

test("withOperationLock preserves both action and release errors", async (t) => {
  const { lockPath } = await fixture(t);
  const actionError = new Error("action failed");
  const releaseError = new Error("release failed");

  await assert.rejects(
    withOperationLock(
      acquisitionOptions(lockPath, {
        testHooks: {
          "before-release": async () => {
            throw releaseError;
          },
        },
      }),
      async () => {
        throw actionError;
      },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.code, "LOCK_ACTION_RELEASE_FAILED");
      assert.equal(error.errors[0], actionError);
      assert.equal(error.errors[1].code, "LOCK_RELEASE_FAILED");
      assert.equal(error.errors[1].cause, releaseError);
      return true;
    },
  );
});

test("withOperationLock preserves an explicit undefined rejection", async (t) => {
  const { lockPath } = await fixture(t);
  let rejected = false;
  try {
    await withOperationLock(acquisitionOptions(lockPath), async () => {
      throw undefined;
    });
  } catch (error) {
    rejected = true;
    assert.equal(error, undefined);
  }
  assert.equal(rejected, true);
});

test("two stale contenders publish one successor while delayed old release cannot affect it", async (t) => {
  const { lockPath } = await fixture(t);
  const releaseEntered = deferred();
  const allowRelease = deferred();
  const oldLease = await acquireOperationLock(
    acquisitionOptions(lockPath, {
      testHooks: {
        "before-release": async () => {
          releaseEntered.resolve();
          await allowRelease.promise;
        },
      },
    }),
  );
  const delayedRelease = oldLease.release();
  await releaseEntered.promise;

  const first = { pid: 72_001, startedAt: "2026-07-17T05:01:00.000Z" };
  const second = { pid: 72_002, startedAt: "2026-07-17T05:02:00.000Z" };
  const live = new Map([
    [first.pid, first],
    [second.pid, second],
  ]);
  const readProcessIdentity = async (pid) => live.get(pid) ?? null;
  const results = await Promise.allSettled([
    acquireOperationLock(
      acquisitionOptions(lockPath, { identity: first, readProcessIdentity }),
    ),
    acquireOperationLock(
      acquisitionOptions(lockPath, { identity: second, readProcessIdentity }),
    ),
  ]);
  const winners = results.filter((result) => result.status === "fulfilled");
  const losers = results.filter((result) => result.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].reason.code, "LOCK_HELD");
  const successor = winners[0].value;
  t.after(() => successor.release());

  allowRelease.resolve();
  assert.equal(await delayedRelease, false);
  assert.equal(await successor.assertOwned(), true);
  assert.equal((await readTail(lockPath)).owner.nonce, successor.nonce);
});

test("every handled post-publication fault creates a nonce-bound rollback marker", async (t) => {
  for (const faultAt of ["after-publish", "after-publish-sync"]) {
    await t.test(faultAt, async (subtest) => {
      const { lockPath } = await fixture(subtest);
      await assert.rejects(
        acquireOperationLock(acquisitionOptions(lockPath, { faultAt })),
        (error) =>
          error.code === `FAULT_${faultAt.toUpperCase().replaceAll("-", "_")}`,
      );

      const failedOwner = JSON.parse(await readFile(lockPath, "utf8"));
      assert.equal(
        await exists(releasePath(lockPath, failedOwner.nonce)),
        true,
      );
      const successor = await acquireOperationLock(acquisitionOptions(lockPath));
      subtest.after(() => successor.release());
      assert.equal(await successor.assertOwned(), true);
      assert.equal(
        successor.owner.predecessor.nonce,
        failedOwner.nonce,
      );
    });
  }
});

test("publication and rollback failures are both preserved", async (t) => {
  const { lockPath } = await fixture(t);
  const publicationError = new Error("after publication failed");
  const rollbackError = new Error("rollback failed");

  await assert.rejects(
    acquireOperationLock(
      acquisitionOptions(lockPath, {
        testHooks: {
          "after-publish": async () => {
            throw publicationError;
          },
          "before-rollback": async () => {
            throw rollbackError;
          },
        },
      }),
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.code, "LOCK_ACQUIRE_ROLLBACK_FAILED");
      assert.deepEqual(error.errors, [publicationError, rollbackError]);
      return true;
    },
  );
});

test("a successor with the wrong predecessor inode binding fails closed", async (t) => {
  const { lockPath } = await fixture(t);
  const head = await seedLock(lockPath);
  const corruptSuccessor = ownerRecord({
    identity: CONTENDER,
    nonce: "corrupt-successor",
    predecessor: {
      dev: "wrong-device",
      ino: "wrong-inode",
      nonce: head.nonce,
    },
  });
  await writePrivateJson(
    successorPath(lockPath, head.nonce),
    corruptSuccessor,
  );

  await assert.rejects(
    acquireOperationLock(acquisitionOptions(lockPath)),
    (error) => error.code === "LOCK_CHAIN_CORRUPT",
  );
});

test("lexical traversal is rejected before creating the trusted state root", async (t) => {
  const { root } = await fixture(t);
  const stateRoot = join(root, "state-not-created");
  const lockPath = `${stateRoot}/../outside/operation.lock`;

  await assert.rejects(
    acquireOperationLock(
      acquisitionOptions(lockPath, { stateRoot }),
    ),
    (error) => error.code === "LOCK_PATH_INVALID",
  );
  assert.equal(await exists(stateRoot), false);
  assert.equal(await exists(join(root, "outside")), false);
});

test("foreign heartbeat temporary files are preserved conservatively", async (t) => {
  const { lockPath } = await fixture(t);
  await mkdir(dirname(lockPath), { mode: 0o700 });
  const orphan = `${lockPath}.heartbeat.owner.tmp.foreign`;
  await writePrivateJson(orphan, { unknown: true });

  const lease = await acquireOperationLock(acquisitionOptions(lockPath));
  t.after(() => lease.release());

  assert.equal(await exists(orphan), true);
});

test("heartbeat temporary cleanup requires a strict released claim binding", async (t) => {
  const { lockPath } = await fixture(t);
  const releasedLease = await acquireOperationLock(acquisitionOptions(lockPath));
  const claimMetadata = await stat(lockPath, { bigint: true });
  await releasedLease.release();
  const releasedTemp = heartbeatTempPath(lockPath, releasedLease.nonce);
  await writePrivateJson(releasedTemp, {
    schemaVersion: 2,
    nonce: releasedLease.nonce,
    pid: releasedLease.owner.pid,
    startedAt: releasedLease.owner.startedAt,
    claim: {
      dev: String(claimMetadata.dev),
      ino: String(claimMetadata.ino),
    },
    heartbeat: CREATED_AT,
  });

  const next = await acquireOperationLock(acquisitionOptions(lockPath));
  t.after(() => next.release());
  assert.equal(await exists(releasedTemp), false);
});

test("heartbeat temporary cleanup preserves a strict live claim", async (t) => {
  const { lockPath } = await fixture(t);
  const liveLease = await acquireOperationLock(acquisitionOptions(lockPath));
  t.after(() => liveLease.release());
  const claimMetadata = await stat(lockPath, { bigint: true });
  const liveTemp = heartbeatTempPath(lockPath, liveLease.nonce);
  await writePrivateJson(liveTemp, {
    schemaVersion: 2,
    nonce: liveLease.nonce,
    pid: liveLease.owner.pid,
    startedAt: liveLease.owner.startedAt,
    claim: {
      dev: String(claimMetadata.dev),
      ino: String(claimMetadata.ino),
    },
    heartbeat: CREATED_AT,
  });

  await assert.rejects(
    acquireOperationLock(
      acquisitionOptions(lockPath, {
        readProcessIdentity: async (pid) =>
          pid === liveLease.owner.pid
            ? {
                pid: liveLease.owner.pid,
                startedAt: liveLease.owner.startedAt,
              }
            : null,
      }),
    ),
    (error) => error.code === "LOCK_HELD",
  );
  assert.equal(await exists(liveTemp), true);
});

test("a low compaction threshold keeps repeated short leases bounded", async (t) => {
  const { lockPath } = await fixture(t);
  for (let index = 0; index < 10; index += 1) {
    const identity = {
      pid: 80_000 + index,
      startedAt: `2026-07-17T06:${String(index).padStart(2, "0")}:00.000Z`,
    };
    const lease = await acquireOperationLock(
      acquisitionOptions(lockPath, {
        compactionThreshold: 3,
        identity,
        readProcessIdentity: async () => null,
      }),
    );
    assert.equal(await lease.assertOwned(), true);
    await lease.release();
  }

  const head = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(head.predecessor, null);
  const artifacts = (await readdir(dirname(lockPath))).filter((entry) =>
    entry.startsWith(basename(lockPath)),
  );
  assert.ok(
    artifacts.length <= 8,
    `compacted lock artifacts should stay bounded, found ${artifacts.length}`,
  );
});

test("checkpoint compaction fences a contender linked from the old chain", {
  // Windows directory locks do not run the POSIX checkpoint compaction hooks.
  skip: process.platform === "win32",
}, async (t) => {
  const { lockPath } = await fixture(t);
  const released = await acquireOperationLock(acquisitionOptions(lockPath));
  await released.release();

  const compactReady = deferred();
  const allowCompact = deferred();
  const contenderLinked = deferred();
  const allowContender = deferred();
  const compactorPromise = acquireOperationLock(
    acquisitionOptions(lockPath, {
      compactionThreshold: 2,
      testHooks: {
        "after-compact-final-check": async () => {
          compactReady.resolve();
          await allowCompact.promise;
        },
      },
    }),
  );
  await compactReady.promise;

  const staleIdentity = {
    pid: 81_001,
    startedAt: "2026-07-17T07:00:00.000Z",
  };
  let compactorProbes = 0;
  const staleContender = acquireOperationLock(
    acquisitionOptions(lockPath, {
      identity: staleIdentity,
      readProcessIdentity: async (pid) => {
        if (pid !== CONTENDER.pid) return null;
        compactorProbes += 1;
        return compactorProbes === 1 ? CONTENDER : null;
      },
      testHooks: {
        "after-publish-sync": async () => {
          contenderLinked.resolve();
          await allowContender.promise;
        },
      },
    }),
  );
  await contenderLinked.promise;

  allowCompact.resolve();
  const checkpoint = await compactorPromise;
  t.after(() => checkpoint.release());
  allowContender.resolve();

  await assert.rejects(
    staleContender,
    (error) => error.code === "LOCK_NOT_OWNED",
  );
  assert.equal(await checkpoint.assertOwned(), true);
  assert.equal((await readTail(lockPath)).owner.nonce, checkpoint.nonce);
});

test("checkpoint failures after rename leave a released checkpoint, never an ownerless live lock", {
  skip: process.platform === "win32",
}, async (t) => {
  for (const faultAt of [
    "after-compact-rename",
    "after-compact-sync",
    "after-compact-cleanup",
  ]) {
    await t.test(faultAt, async (subtest) => {
      const { lockPath } = await fixture(subtest);
      const initial = await acquireOperationLock(acquisitionOptions(lockPath));
      await initial.release();

      await assert.rejects(
        acquireOperationLock(
          acquisitionOptions(lockPath, {
            compactionThreshold: 2,
            faultAt,
          }),
        ),
        (error) =>
          error.code === `FAULT_${faultAt.toUpperCase().replaceAll("-", "_")}`,
      );

      const checkpointOwner = JSON.parse(await readFile(lockPath, "utf8"));
      assert.equal(checkpointOwner.predecessor, null);
      assert.equal(
        await exists(releasePath(lockPath, checkpointOwner.nonce)),
        true,
      );
      const recovery = await acquireOperationLock(acquisitionOptions(lockPath));
      subtest.after(() => recovery.release());
      assert.equal(await recovery.assertOwned(), true);
    });
  }
});

test("checkpoint failure and checkpoint rollback failure are both preserved", {
  skip: process.platform === "win32",
}, async (t) => {
  const { lockPath } = await fixture(t);
  const initial = await acquireOperationLock(acquisitionOptions(lockPath));
  await initial.release();
  const rollbackError = new Error("checkpoint rollback failed");

  await assert.rejects(
    acquireOperationLock(
      acquisitionOptions(lockPath, {
        compactionThreshold: 2,
        faultAt: "after-compact-rename",
        testHooks: {
          "before-rollback": async () => {
            throw rollbackError;
          },
        },
      }),
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.code, "LOCK_ACQUIRE_ROLLBACK_FAILED");
      assert.equal(error.errors[0].code, "FAULT_AFTER_COMPACT_RENAME");
      assert.equal(error.errors[1], rollbackError);
      return true;
    },
  );
});

test("a trusted state root has exactly one canonical operation lock path", async (t) => {
  const { root } = await fixture(t);
  const stateRoot = join(root, "state");

  for (const name of ["a.lock", "b.lock"]) {
    await assert.rejects(
      acquireOperationLock(acquisitionOptions(join(stateRoot, name), { stateRoot })),
      (error) => error.code === "LOCK_PATH_INVALID",
    );
  }
  assert.equal(await exists(stateRoot), false);
});

test("lease capabilities cannot be forged or copied", async (t) => {
  const { lockPath } = await fixture(t);
  const module = await import("../src/operation-lock.mjs");
  assert.equal(typeof module.assertOperationLeaseCapability, "function");
  const lease = await acquireOperationLock(acquisitionOptions(lockPath));
  t.after(() => lease.release());

  const trusted = module.assertOperationLeaseCapability(lease);
  assert.equal(trusted.stateRoot, dirname(lockPath));
  assert.equal(trusted.lockPath, lockPath);
  assert.throws(
    () => module.assertOperationLeaseCapability({ ...lease }),
    (error) => error.code === "LOCK_CAPABILITY_INVALID",
  );
});

test("lease commit fences concurrent release until the atomic callback finishes", async (t) => {
  const { lockPath } = await fixture(t);
  const module = await import("../src/operation-lock.mjs");
  assert.equal(typeof module.commitWithOperationLease, "function");
  const lease = await acquireOperationLock(acquisitionOptions(lockPath));
  const commitEntered = deferred();
  const allowRename = deferred();
  const stagedPath = join(dirname(lockPath), "state.tmp");
  const statePath = join(dirname(lockPath), "state.json");
  const order = [];
  await writeFile(stagedPath, "new-state", { mode: 0o600 });

  const commit = module.commitWithOperationLease(lease, async () => {
    commitEntered.resolve();
    await allowRename.promise;
    await rename(stagedPath, statePath);
    order.push("rename");
  });
  await commitEntered.promise;

  let releaseSettled = false;
  const release = lease.release().then((value) => {
    releaseSettled = true;
    order.push("release");
    return value;
  });
  let successorSettled = false;
  const successor = (async () => {
    while (true) {
      try {
        const acquired = await acquireOperationLock(acquisitionOptions(lockPath, {
          identity: OWNER,
          readProcessIdentity: async (pid) =>
            pid === lease.owner.pid ? lease.owner : null,
        }));
        successorSettled = true;
        order.push("successor");
        return acquired;
      } catch (error) {
        if (error.code !== "LOCK_HELD") throw error;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  })();

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releaseSettled, false);
  assert.equal(successorSettled, false);
  assert.equal(await exists(statePath), false);

  allowRename.resolve();
  await commit;
  assert.equal(await release, true);
  const successorLease = await successor;
  t.after(() => successorLease.release());
  assert.deepEqual(order, ["rename", "release", "successor"]);
  assert.equal(await readFile(statePath, "utf8"), "new-state");
});

test("release drains every commit accepted before release started", async (t) => {
  const { lockPath } = await fixture(t);
  const { commitWithOperationLease } = await import("../src/operation-lock.mjs");
  const lease = await acquireOperationLock(acquisitionOptions(lockPath));
  const entered = deferred();
  const unblock = deferred();
  const order = [];

  const first = commitWithOperationLease(lease, async () => {
    entered.resolve();
    await unblock.promise;
    order.push("first");
  });
  await entered.promise;
  const second = commitWithOperationLease(lease, async () => {
    order.push("second");
  });
  const release = lease.release().then((value) => {
    order.push("release");
    return value;
  });

  unblock.resolve();
  await first;
  await second;
  assert.equal(await release, true);
  assert.deepEqual(order, ["first", "second", "release"]);
});

test("a transient pre-publication release failure is retryable without reopening commits", async (t) => {
  const { lockPath } = await fixture(t);
  const { commitWithOperationLease } = await import("../src/operation-lock.mjs");
  const releaseEntered = deferred();
  const allowFailure = deferred();
  const transient = new Error("temporary release publication outage");
  let attempts = 0;
  let repaired = false;
  const lease = await acquireOperationLock(acquisitionOptions(lockPath, {
    testHooks: {
      "before-release": async () => {
        attempts += 1;
        if (repaired) return;
        releaseEntered.resolve();
        await allowFailure.promise;
        throw transient;
      },
    },
  }));

  const first = lease.release();
  const duplicate = lease.release();
  await releaseEntered.promise;
  assert.equal(attempts, 1, "pending release calls must share one attempt");
  allowFailure.resolve();
  const failed = await Promise.allSettled([first, duplicate]);
  assert.deepEqual(failed.map(({ status }) => status), ["rejected", "rejected"]);
  assert.equal(failed[0].reason.cause, transient);
  assert.equal(failed[1].reason, failed[0].reason);

  assert.throws(
    () => commitWithOperationLease(lease, async () => {}),
    (error) => error.code === "LOCK_NOT_OWNED",
  );
  repaired = true;
  assert.equal(await lease.release(), true);
  assert.equal(attempts, 2);
  assert.equal(await exists(releasePath(lockPath, lease.nonce)), true);
});

test("a release retry completes idempotently when the marker already exists", async (t) => {
  const { lockPath } = await fixture(t);
  const transient = new Error("response lost after release publication");
  let lease;
  let failOnce = true;
  lease = await acquireOperationLock(acquisitionOptions(lockPath, {
    testHooks: {
      "before-release": async ({ claim }) => {
        if (!failOnce) return;
        failOnce = false;
        await writePrivateJson(releasePath(lockPath, claim.owner.nonce), {
          schemaVersion: 2,
          nonce: claim.owner.nonce,
          pid: claim.owner.pid,
          startedAt: claim.owner.startedAt,
          claim: {
            dev: String(claim.metadata.dev),
            ino: String(claim.metadata.ino),
          },
          releasedAt: "2026-07-17T11:00:00.000Z",
        });
        throw transient;
      },
    },
  }));

  await assert.rejects(
    lease.release(),
    (error) => error.code === "LOCK_RELEASE_FAILED" && error.cause === transient,
  );
  assert.equal(await lease.release(), false);
  assert.equal(await exists(releasePath(lockPath, lease.nonce)), true);
});

test("release from inside the active commit callback fails immediately", async (t) => {
  const { lockPath } = await fixture(t);
  const { commitWithOperationLease } = await import("../src/operation-lock.mjs");
  const lease = await acquireOperationLock(acquisitionOptions(lockPath));

  const operation = commitWithOperationLease(lease, async () => lease.release());
  const outcome = await Promise.race([
    operation.then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ reason, status: "rejected" }),
    ),
    new Promise((resolve) => setTimeout(
      () => resolve({ status: "timeout" }),
      100,
    )),
  ]);

  assert.notEqual(outcome.status, "timeout", "commit callback release deadlocked");
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.reason.code, "LOCK_COMMIT_RELEASE_REENTRANT");
  assert.equal(await lease.release(), true);
});

test("release rejects through nested commit contexts instead of deadlocking", async (t) => {
  const firstFixture = await fixture(t);
  const secondFixture = await fixture(t);
  const { commitWithOperationLease } = await import("../src/operation-lock.mjs");
  const first = await acquireOperationLock(acquisitionOptions(firstFixture.lockPath));
  const second = await acquireOperationLock(acquisitionOptions(
    secondFixture.lockPath,
    { identity: OWNER },
  ));

  const operation = commitWithOperationLease(first, async () =>
    commitWithOperationLease(second, async () => first.release()));
  const outcome = await Promise.race([
    operation.then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ reason, status: "rejected" }),
    ),
    new Promise((resolve) => setTimeout(
      () => resolve({ status: "timeout" }),
      100,
    )),
  ]);

  assert.notEqual(outcome.status, "timeout", "nested commit release deadlocked");
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.reason.code, "LOCK_COMMIT_RELEASE_REENTRANT");
  assert.equal(await first.release(), true);
  assert.equal(await second.release(), true);
});

test("exclusive staging collisions never unlink a file this call did not create", async (t) => {
  const { lockPath } = await fixture(t);
  const sentinel = "foreign staging file\n";
  let collisionPath;

  await assert.rejects(
    acquireOperationLock(acquisitionOptions(lockPath, {
      testHooks: {
        "before-staging-open": async ({ stagingPath: path }) => {
          collisionPath = path;
          await writeFile(path, sentinel, { mode: 0o600 });
        },
      },
    })),
    (error) => error.code === "LOCK_STAGING_WRITE_FAILED",
  );
  assert.equal(await readFile(collisionPath, "utf8"), sentinel);
});

test("startup conservatively collects strict dead checkpoint and release staging artifacts", async (t) => {
  const { lockPath } = await fixture(t);
  await mkdir(dirname(lockPath), { mode: 0o700 });
  const dead = { pid: 91_001, startedAt: "2026-07-17T09:00:00.000Z" };
  const live = { pid: 91_002, startedAt: "2026-07-17T09:01:00.000Z" };
  const racing = { pid: 91_003, startedAt: "2026-07-17T09:01:30.000Z" };
  const deadCheckpoint = `${lockPath}.checkpoint.${dead.pid}.dead-checkpoint`;
  const liveCheckpoint = `${lockPath}.checkpoint.${live.pid}.live-checkpoint`;
  const malformedCheckpoint = `${lockPath}.checkpoint.${dead.pid}.malformed`;
  const racingCheckpoint = `${lockPath}.checkpoint.${racing.pid}.racing-checkpoint`;
  await writePrivateJson(deadCheckpoint, ownerRecord({
    identity: dead,
    nonce: "dead-checkpoint",
    predecessor: null,
  }));
  await writePrivateJson(liveCheckpoint, ownerRecord({
    identity: live,
    nonce: "live-checkpoint",
    predecessor: null,
  }));
  await writeFile(malformedCheckpoint, "{bad", { mode: 0o600 });
  await writePrivateJson(racingCheckpoint, ownerRecord({
    identity: racing,
    nonce: "racing-checkpoint",
    predecessor: null,
  }));

  const releaseRecord = (identity, nonce) => ({
    schemaVersion: 2,
    nonce,
    pid: identity.pid,
    startedAt: identity.startedAt,
    claim: { dev: "1", ino: "2" },
    releasedAt: "2026-07-17T09:02:00.000Z",
  });
  const deadRelease = `${lockPath}.released.dead-release.staging.dead-producer`;
  const liveRelease = `${lockPath}.released.live-release.staging.live-producer`;
  const malformedRelease = `${lockPath}.released.malformed.staging.producer`;
  await writePrivateJson(deadRelease, releaseRecord(dead, "dead-release"));
  await writePrivateJson(liveRelease, releaseRecord(live, "live-release"));
  await writeFile(malformedRelease, "{}\n", { mode: 0o600 });

  let racingProbes = 0;
  const lease = await acquireOperationLock(acquisitionOptions(lockPath, {
    readProcessIdentity: async (pid) => {
      if (pid === live.pid) return live;
      if (pid === racing.pid) {
        racingProbes += 1;
        return racingProbes === 1 ? null : racing;
      }
      return null;
    },
  }));
  t.after(() => lease.release());
  assert.equal(await exists(deadCheckpoint), false);
  assert.equal(await exists(deadRelease), false);
  assert.equal(await exists(liveCheckpoint), true);
  assert.equal(await exists(liveRelease), true);
  assert.equal(await exists(malformedCheckpoint), true);
  assert.equal(await exists(malformedRelease), true);
  assert.equal(await exists(racingCheckpoint), true);
});

test("startup collects an inactive quarantine left by this long-lived process", async (t) => {
  const { lockPath } = await fixture(t);
  await mkdir(dirname(lockPath), { mode: 0o700 });
  const quarantinePath = join(
    dirname(lockPath),
    `.operation-lock-gc.${process.pid}.inactive-same-process`,
  );
  await mkdir(quarantinePath, { mode: 0o700 });
  await writePrivateJson(
    join(quarantinePath, "artifact"),
    ownerRecord({
      identity: { pid: process.pid, startedAt: "inactive" },
      nonce: "inactive-same-process",
    }),
  );

  const lease = await acquireOperationLock(acquisitionOptions(lockPath));
  await lease.release();
  assert.equal(await exists(quarantinePath), false);
});

test("artifact cleanup never unlinks a replacement with a different inode", async (t) => {
  const { lockPath } = await fixture(t);
  const dead = { pid: 92_001, startedAt: "2026-07-17T10:00:00.000Z" };
  const path = stagingPath(lockPath, dead, "dead-artifact");
  await mkdir(dirname(lockPath), { mode: 0o700 });
  await writePrivateJson(path, ownerRecord({
    identity: dead,
    nonce: "dead-artifact",
  }));
  const replacement = "replacement must survive\n";
  const replacementPath = `${path}.replacement`;
  await writeFile(replacementPath, replacement, { mode: 0o600 });
  const [originalInfo, replacementInfo] = await Promise.all([
    lstat(path, { bigint: true }),
    lstat(replacementPath, { bigint: true }),
  ]);
  assert.notDeepEqual(
    [originalInfo.dev, originalInfo.ino],
    [replacementInfo.dev, replacementInfo.ino],
    "fixture must provide a distinct replacement inode",
  );

  await assert.rejects(
    acquireOperationLock(acquisitionOptions(lockPath, {
      testHooks: {
        "before-artifact-tombstone": async ({ path: candidate }) => {
          if (candidate !== path) return;
          await unlink(path);
          await rename(replacementPath, path);
        },
      },
    })),
    (error) => error.code === "LOCK_ARTIFACT_CHANGED",
  );
  assert.equal(await readFile(path, "utf8"), replacement);
});

test("hard-exit checkpoint crashes remain bounded across recovery loops", {
  skip: process.platform === "win32",
}, async (t) => {
  const { lockPath } = await fixture(t);
  const initial = await acquireOperationLock(acquisitionOptions(lockPath));
  await initial.release();
  const moduleUrl = new URL("../src/operation-lock.mjs", import.meta.url).href;

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const childSource = `
      const { acquireOperationLock } = await import(${JSON.stringify(moduleUrl)});
      await acquireOperationLock({
        lockPath: ${JSON.stringify(lockPath)},
        stateRoot: ${JSON.stringify(dirname(lockPath))},
        operation: "child-crash",
        identity: { pid: process.pid, startedAt: "child-" + process.pid },
        readProcessIdentity: async () => null,
        compactionThreshold: 2,
        testHooks: {
          "before-compact-rename": async () => process.exit(73),
        },
      });
      process.exit(0);
    `;
    const child = await runNodeChild(childSource);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.code, 73, child.stderr);
    assert.ok(
      (await readdir(dirname(lockPath))).some((name) =>
        name.startsWith(`${basename(lockPath)}.checkpoint.`)),
    );

    const recovery = await acquireOperationLock(acquisitionOptions(lockPath, {
      compactionThreshold: 2,
      readProcessIdentity: async () => null,
    }));
    await recovery.release();
  }

  const checkpointArtifacts = (await readdir(dirname(lockPath))).filter((name) =>
    name.startsWith(`${basename(lockPath)}.checkpoint.`));
  assert.deepEqual(checkpointArtifacts, []);
  const allArtifacts = (await readdir(dirname(lockPath))).filter((name) =>
    name.startsWith(basename(lockPath)));
  assert.ok(allArtifacts.length <= 8, `found ${allArtifacts.length} lock artifacts`);
  assert.equal(
    (await readdir(dirname(lockPath))).some((name) =>
      name.startsWith(".operation-lock-gc.")),
    false,
  );
});

test("post-publication checkpoint hard exits keep every complete artifact class bounded", {
  skip: process.platform === "win32",
}, async (t) => {
  const moduleUrl = new URL("../src/operation-lock.mjs", import.meta.url).href;
  for (const stage of ["after-compact-rename", "after-compact-sync"]) {
    await t.test(stage, async (subtest) => {
      const { lockPath } = await fixture(subtest);
      const initial = await acquireOperationLock(acquisitionOptions(lockPath));
      await initial.release();

      for (let iteration = 0; iteration < 8; iteration += 1) {
        const childSource = `
          const { acquireOperationLock } = await import(${JSON.stringify(moduleUrl)});
          await acquireOperationLock({
            lockPath: ${JSON.stringify(lockPath)},
            stateRoot: ${JSON.stringify(dirname(lockPath))},
            operation: "child-crash",
            identity: { pid: process.pid, startedAt: ${JSON.stringify(stage)} + "-" + ${iteration} + "-" + process.pid },
            readProcessIdentity: async () => null,
            compactionThreshold: 2,
            testHooks: {
              ${JSON.stringify(stage)}: async () => process.exit(73),
            },
          });
          process.exit(0);
        `;
        const child = await runNodeChild(childSource);
        assert.equal(child.signal, null, child.stderr);
        assert.equal(child.code, 73, child.stderr);

        const quarantinePath = join(
          dirname(lockPath),
          `.operation-lock-gc.${93_000 + iteration}.legacy-${iteration}`,
        );
        await mkdir(quarantinePath, { mode: 0o700 });
        await writePrivateJson(
          join(quarantinePath, "artifact"),
          ownerRecord({
            identity: {
              pid: 93_000 + iteration,
              startedAt: `legacy-${iteration}`,
            },
            nonce: `legacy-${iteration}`,
          }),
        );

        const recovery = await acquireOperationLock(acquisitionOptions(lockPath, {
          compactionThreshold: 2,
          identity: {
            pid: 94_000 + iteration,
            startedAt: `${stage}-recovery-${iteration}`,
          },
          readProcessIdentity: async () => null,
        }));
        await recovery.release();
        await assertOnlyReachableArtifacts(lockPath, 3);
        assert.equal(await exists(quarantinePath), false);
      }
    });
  }
});

test("handled checkpoint publication faults keep complete artifacts bounded", {
  skip: process.platform === "win32",
}, async (t) => {
  for (const stage of ["after-compact-rename", "after-compact-sync"]) {
    await t.test(stage, async (subtest) => {
      const { lockPath } = await fixture(subtest);
      const initial = await acquireOperationLock(acquisitionOptions(lockPath));
      await initial.release();

      for (let iteration = 0; iteration < 8; iteration += 1) {
        await assert.rejects(
          acquireOperationLock(acquisitionOptions(lockPath, {
            compactionThreshold: 2,
            faultAt: stage,
            identity: {
              pid: 95_000 + iteration,
              startedAt: `${stage}-fault-${iteration}`,
            },
          })),
          (error) => error.code === `FAULT_${stage.toUpperCase().replaceAll("-", "_")}`,
        );
        const recovery = await acquireOperationLock(acquisitionOptions(lockPath, {
          compactionThreshold: 2,
          identity: {
            pid: 96_000 + iteration,
            startedAt: `${stage}-handled-recovery-${iteration}`,
          },
        }));
        await recovery.release();
        await assertOnlyReachableArtifacts(lockPath, 3);
      }
    });
  }
});

test("final artifact collection preserves a racing inode replacement", {
  skip: process.platform === "win32",
}, async (t) => {
  const { root, lockPath } = await fixture(t);
  const initial = await acquireOperationLock(acquisitionOptions(lockPath));
  await initial.release();
  await assert.rejects(
    acquireOperationLock(acquisitionOptions(lockPath, {
      compactionThreshold: 2,
      faultAt: "after-compact-rename",
    })),
    (error) => error.code === "FAULT_AFTER_COMPACT_RENAME",
  );
  const candidatePath = successorPath(lockPath, initial.nonce);
  assert.equal(await exists(candidatePath), true);
  const replacement = ownerRecord({
    identity: { pid: 97_001, startedAt: "replacement" },
    nonce: "replacement-final",
    predecessor: {
      dev: "replacement-device",
      ino: "replacement-inode",
      nonce: initial.nonce,
    },
  });
  const replacementPath = join(root, "final-racing-replacement.json");
  await writePrivateJson(replacementPath, replacement);
  const [candidateInfo, replacementInfo] = await Promise.all([
    lstat(candidatePath, { bigint: true }),
    lstat(replacementPath, { bigint: true }),
  ]);
  assert.notDeepEqual(
    [candidateInfo.dev, candidateInfo.ino],
    [replacementInfo.dev, replacementInfo.ino],
    "fixture must provide a distinct replacement inode",
  );

  await assert.rejects(
    acquireOperationLock(acquisitionOptions(lockPath, {
      testHooks: {
        "before-artifact-tombstone": async ({ path }) => {
          if (path !== candidatePath) return;
          await unlink(path);
          await rename(replacementPath, path);
        },
      },
    })),
    (error) => error.code === "LOCK_ARTIFACT_CHANGED",
  );
  assert.deepEqual(JSON.parse(await readFile(candidatePath, "utf8")), replacement);
});

test("a failed post-tombstone reachability check restores the exact candidate", {
  skip: process.platform === "win32",
}, async (t) => {
  const { lockPath } = await fixture(t);
  const initial = await acquireOperationLock(acquisitionOptions(lockPath));
  await initial.release();
  await assert.rejects(
    acquireOperationLock(acquisitionOptions(lockPath, {
      compactionThreshold: 2,
      faultAt: "after-compact-rename",
    })),
    (error) => error.code === "FAULT_AFTER_COMPACT_RENAME",
  );
  const candidatePath = successorPath(lockPath, initial.nonce);
  const candidate = await readFile(candidatePath, "utf8");

  await assert.rejects(
    acquireOperationLock(acquisitionOptions(lockPath, {
      testHooks: {
        "after-artifact-tombstone": async ({ path }) => {
          if (path === candidatePath) {
            await writeFile(lockPath, "{corrupt", { mode: 0o600 });
          }
        },
      },
    })),
    (error) => error.code === "LOCK_MALFORMED",
  );
  assert.equal(await readFile(candidatePath, "utf8"), candidate);
});

test("orphan quarantine recovery restores an artifact that became reachable before a collector crash", {
  skip: process.platform === "win32",
}, async (t) => {
  const { lockPath } = await fixture(t);
  const current = await acquireOperationLock(acquisitionOptions(lockPath));
  await current.release();
  const savedRootPath = join(dirname(lockPath), "saved-root");
  const savedRoot = ownerRecord({
    identity: { pid: 98_001, startedAt: "saved-root" },
    nonce: "saved-root",
  });
  await writePrivateJson(savedRootPath, savedRoot);
  const savedMetadata = await stat(savedRootPath, { bigint: true });
  const candidatePath = successorPath(lockPath, savedRoot.nonce);
  const candidate = ownerRecord({
    identity: { pid: 98_002, startedAt: "saved-successor" },
    nonce: "saved-successor",
    predecessor: {
      dev: String(savedMetadata.dev),
      ino: String(savedMetadata.ino),
      nonce: savedRoot.nonce,
    },
  });
  await writePrivateJson(candidatePath, candidate);
  const moduleUrl = new URL("../src/operation-lock.mjs", import.meta.url).href;
  const childSource = `
    const { rename } = await import("node:fs/promises");
    const { acquireOperationLock } = await import(${JSON.stringify(moduleUrl)});
    await acquireOperationLock({
      lockPath: ${JSON.stringify(lockPath)},
      stateRoot: ${JSON.stringify(dirname(lockPath))},
      operation: "collector-crash",
      identity: { pid: process.pid, startedAt: "collector-" + process.pid },
      readProcessIdentity: async () => null,
      testHooks: {
        "before-artifact-tombstone": async ({ path }) => {
          if (path === ${JSON.stringify(candidatePath)}) {
            await rename(${JSON.stringify(savedRootPath)}, ${JSON.stringify(lockPath)});
          }
        },
        "after-artifact-tombstone": async ({ path }) => {
          if (path === ${JSON.stringify(candidatePath)}) process.exit(74);
        },
      },
    });
    process.exit(0);
  `;
  const child = await runNodeChild(childSource);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.code, 74, child.stderr);
  assert.equal(await exists(candidatePath), false);
  assert.equal(
    (await readdir(dirname(lockPath))).some((name) =>
      name.startsWith(".operation-lock-gc.")),
    true,
  );

  const savedRootRaw = await readFile(lockPath, "utf8");
  await writeFile(lockPath, "{transient-corruption", { mode: 0o600 });
  await assert.rejects(
    acquireOperationLock(acquisitionOptions(lockPath, {
      identity: { pid: 98_004, startedAt: "failed-race-recovery" },
      readProcessIdentity: async () => null,
    })),
    (error) => error.code === "LOCK_MALFORMED",
  );
  assert.deepEqual(JSON.parse(await readFile(candidatePath, "utf8")), candidate);
  await writeFile(lockPath, savedRootRaw, { mode: 0o600 });

  const recovery = await acquireOperationLock(acquisitionOptions(lockPath, {
    identity: { pid: 98_003, startedAt: "race-recovery" },
    readProcessIdentity: async () => null,
  }));
  await recovery.release();
  assert.deepEqual(JSON.parse(await readFile(candidatePath, "utf8")), candidate);
  assert.equal(
    (await readdir(dirname(lockPath))).some((name) =>
      name.startsWith(".operation-lock-gc.")),
    false,
  );
});

test("orphan quarantine recovery restores a racing replacement after the collector crashes", {
  skip: process.platform === "win32",
}, async (t) => {
  const { root, lockPath } = await fixture(t);
  const current = await acquireOperationLock(acquisitionOptions(lockPath));
  await current.release();
  const savedRootPath = join(dirname(lockPath), "replacement-root");
  const savedRoot = ownerRecord({
    identity: { pid: 99_001, startedAt: "replacement-root" },
    nonce: "replacement-root",
  });
  await writePrivateJson(savedRootPath, savedRoot);
  const savedMetadata = await stat(savedRootPath, { bigint: true });
  const candidatePath = successorPath(lockPath, savedRoot.nonce);
  const predecessor = {
    dev: String(savedMetadata.dev),
    ino: String(savedMetadata.ino),
    nonce: savedRoot.nonce,
  };
  await writePrivateJson(candidatePath, ownerRecord({
    identity: { pid: 99_002, startedAt: "old-candidate" },
    nonce: "old-candidate",
    predecessor,
  }));
  const replacement = ownerRecord({
    identity: { pid: 99_003, startedAt: "racing-replacement" },
    nonce: "racing-replacement",
    predecessor,
  });
  const replacementPath = join(root, "orphan-racing-replacement.json");
  await writePrivateJson(replacementPath, replacement);
  const [candidateInfo, replacementInfo] = await Promise.all([
    lstat(candidatePath, { bigint: true }),
    lstat(replacementPath, { bigint: true }),
  ]);
  assert.notDeepEqual(
    [candidateInfo.dev, candidateInfo.ino],
    [replacementInfo.dev, replacementInfo.ino],
    "fixture must provide a distinct replacement inode",
  );
  const moduleUrl = new URL("../src/operation-lock.mjs", import.meta.url).href;
  const childSource = `
    const { rename, unlink } = await import("node:fs/promises");
    const { acquireOperationLock } = await import(${JSON.stringify(moduleUrl)});
    await acquireOperationLock({
      lockPath: ${JSON.stringify(lockPath)},
      stateRoot: ${JSON.stringify(dirname(lockPath))},
      operation: "replacement-crash",
      identity: { pid: process.pid, startedAt: "replacement-collector-" + process.pid },
      readProcessIdentity: async () => null,
      testHooks: {
        "before-artifact-tombstone": async ({ path }) => {
          if (path !== ${JSON.stringify(candidatePath)}) return;
          await unlink(path);
          await rename(${JSON.stringify(replacementPath)}, path);
          await rename(${JSON.stringify(savedRootPath)}, ${JSON.stringify(lockPath)});
        },
        "after-artifact-tombstone": async ({ path }) => {
          if (path === ${JSON.stringify(candidatePath)}) process.exit(75);
        },
      },
    });
    process.exit(0);
  `;
  const child = await runNodeChild(childSource);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.code, 75, child.stderr);
  assert.equal(await exists(candidatePath), false);

  const recovery = await acquireOperationLock(acquisitionOptions(lockPath, {
    identity: { pid: 99_004, startedAt: "replacement-recovery" },
    readProcessIdentity: async () => null,
  }));
  await recovery.release();
  assert.deepEqual(JSON.parse(await readFile(candidatePath, "utf8")), replacement);
  assert.equal(
    (await readdir(dirname(lockPath))).some((name) =>
      name.startsWith(".operation-lock-gc.")),
    false,
  );
});
