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

test("a live owner is never stolen even with a stale heartbeat", async (t) => {
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

test("the protected action never runs when lock acquisition fails", async (t) => {
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

test("unsupported Windows durability fails closed before touching the state root", async (t) => {
  const { root } = await fixture(t);
  const stateRoot = join(root, "not-created");
  const lockPath = join(stateRoot, "operation.lock");

  await assert.rejects(
    acquireOperationLock(
      acquisitionOptions(lockPath, { platform: "win32", stateRoot }),
    ),
    (error) => error.code === "LOCK_DURABILITY_UNSUPPORTED",
  );

  assert.equal(await exists(stateRoot), false);
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
  const claimMetadata = await stat(lockPath);
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
  const claimMetadata = await stat(lockPath);
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

test("checkpoint compaction fences a contender linked from the old chain", async (t) => {
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
  const staleContender = acquireOperationLock(
    acquisitionOptions(lockPath, {
      identity: staleIdentity,
      readProcessIdentity: async () => null,
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

test("checkpoint failures after rename leave a released checkpoint, never an ownerless live lock", async (t) => {
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

test("checkpoint failure and checkpoint rollback failure are both preserved", async (t) => {
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
