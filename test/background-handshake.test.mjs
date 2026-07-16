import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BACKGROUND_HANDSHAKE_FILE,
  BACKGROUND_START_REQUEST_FILE,
  backgroundStartRequestPath,
  claimBackgroundStartRequest,
  consumeBackgroundHandshake,
  backgroundHandshakePath,
  publishBackgroundHandshake,
  publishBackgroundStartRequest,
  readBackgroundStartRequest,
  readBackgroundHandshake,
  removeBackgroundHandshake,
  removeBackgroundStartRequest,
  removeLegacyBackgroundStartRequest,
  waitForBackgroundHandshake,
} from "../src/background-handshake.mjs";

const NOW = new Date("2026-07-17T08:00:00.000Z");

function handshake(overrides = {}) {
  return {
    revision: 6,
    transitionNonce: "controller-transition-7",
    pid: 73001,
    startedAt: "Fri Jul 17 16:00:00 2026",
    platform: "darwin",
    backgroundIdentity: "com.heige.codex-skin-controller",
    outcome: "ready",
    ...overrides,
  };
}

function startRequest(overrides = {}) {
  return {
    revision: 6,
    transitionNonce: "controller-transition-7",
    platform: "darwin",
    backgroundIdentity: "com.heige.codex-skin-controller",
    outerTransaction: null,
    ...overrides,
  };
}

async function privateRoot(prefix = "heige-handshake-") {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  const root = join(parent, "state");
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  return root;
}

test("background handshake is an exact token-free atomic 0600 document", async () => {
  const stateRoot = await privateRoot();
  const path = backgroundHandshakePath(stateRoot);
  assert.equal(path, join(stateRoot, BACKGROUND_HANDSHAKE_FILE));
  const published = await publishBackgroundHandshake({
    stateRoot,
    ...handshake(),
  }, { now: () => NOW });

  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.deepEqual(published, {
    schemaVersion: 1,
    ...handshake(),
    createdAt: NOW.toISOString(),
  });
  const bytes = await readFile(path, "utf8");
  assert.doesNotMatch(bytes, /controlToken|token/i);
  assert.deepEqual(await readBackgroundHandshake({ stateRoot }), published);
});

test("background start request is one exact token-free atomic 0600 document", async () => {
  const stateRoot = await privateRoot();
  const path = backgroundStartRequestPath(stateRoot);
  assert.equal(path, join(stateRoot, BACKGROUND_START_REQUEST_FILE));
  const published = await publishBackgroundStartRequest({
    stateRoot,
    ...startRequest(),
  }, { now: () => NOW });

  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.deepEqual(published, {
    schemaVersion: 2,
    ...startRequest(),
    createdAt: NOW.toISOString(),
  });
  const bytes = await readFile(path, "utf8");
  assert.doesNotMatch(bytes, /controlToken|token/i);
  assert.deepEqual(await readBackgroundStartRequest({ stateRoot }), published);
});

test("install start request preserves one exact outer transaction through claim", async () => {
  const stateRoot = await privateRoot();
  const outerTransaction = {
    transactionId: "123e4567-e89b-42d3-a456-426614174000",
    journalPath: join(stateRoot, "macos-install.json"),
  };
  const published = await publishBackgroundStartRequest({
    stateRoot,
    ...startRequest(),
    outerTransaction,
  }, { now: () => NOW });
  assert.deepEqual(published.outerTransaction, outerTransaction);
  const claimed = await claimBackgroundStartRequest({
    stateRoot,
    platform: "darwin",
    backgroundIdentity: "com.heige.codex-skin-controller",
    clock: () => NOW.getTime(),
  });
  assert.deepEqual(claimed.outerTransaction, outerTransaction);
});

test("canonical v1 start requests are cleanup-only before a v2 republish", async () => {
  const legacyDocument = {
    schemaVersion: 1,
    revision: 6,
    transitionNonce: "controller-transition-7",
    platform: "darwin",
    backgroundIdentity: "com.heige.codex-skin-controller",
    createdAt: NOW.toISOString(),
  };

  const cleanupRoot = await privateRoot("heige-v1-cleanup-");
  const cleanupPath = backgroundStartRequestPath(cleanupRoot);
  await writeFile(cleanupPath, `${JSON.stringify(legacyDocument)}\n`, { mode: 0o600 });
  await assert.rejects(
    readBackgroundStartRequest({ stateRoot: cleanupRoot }),
    /schema|unsupported/i,
  );
  assert.equal(await removeLegacyBackgroundStartRequest({ stateRoot: cleanupRoot }), true);
  assert.equal(await readBackgroundStartRequest({ stateRoot: cleanupRoot }), null);
  const republished = await publishBackgroundStartRequest({
    stateRoot: cleanupRoot,
    ...startRequest(),
  }, { now: () => NOW });
  assert.equal(republished.schemaVersion, 2);
  assert.equal(await removeLegacyBackgroundStartRequest({ stateRoot: cleanupRoot }), false);
  assert.deepEqual(await readBackgroundStartRequest({ stateRoot: cleanupRoot }), republished);
  assert.equal(await removeBackgroundStartRequest({ stateRoot: cleanupRoot }), true);
  assert.equal(await readBackgroundStartRequest({ stateRoot: cleanupRoot }), null);

  const claimRoot = await privateRoot("heige-v1-claim-");
  await writeFile(
    backgroundStartRequestPath(claimRoot),
    `${JSON.stringify(legacyDocument)}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(claimBackgroundStartRequest({
    stateRoot: claimRoot,
    platform: "darwin",
    backgroundIdentity: "com.heige.codex-skin-controller",
    clock: () => NOW.getTime(),
  }), /schema|unsupported/i);
  assert.equal(await readBackgroundStartRequest({ stateRoot: claimRoot }), null);

  const unregisterRoot = await privateRoot("heige-v1-unregister-");
  await writeFile(
    backgroundStartRequestPath(unregisterRoot),
    `${JSON.stringify(legacyDocument)}\n`,
    { mode: 0o600 },
  );
  assert.equal(await removeBackgroundStartRequest({ stateRoot: unregisterRoot }), true);
  assert.equal(await readBackgroundStartRequest({ stateRoot: unregisterRoot }), null);

  const malformedRoot = await privateRoot("heige-v1-malformed-");
  const malformedPath = backgroundStartRequestPath(malformedRoot);
  const malformedBytes = `${JSON.stringify({ ...legacyDocument, unexpected: true })}\n`;
  await writeFile(malformedPath, malformedBytes, { mode: 0o600 });
  await assert.rejects(
    removeLegacyBackgroundStartRequest({ stateRoot: malformedRoot }),
    /unknown|schema/i,
  );
  assert.equal(await readFile(malformedPath, "utf8"), malformedBytes);
});

test("background start request is atomically single-consumer and cannot replay", async () => {
  const stateRoot = await privateRoot();
  await publishBackgroundStartRequest({ stateRoot, ...startRequest() }, { now: () => NOW });
  const claim = () => claimBackgroundStartRequest({
    stateRoot,
    platform: "darwin",
    backgroundIdentity: "com.heige.codex-skin-controller",
    clock: () => NOW.getTime(),
  });
  const claims = await Promise.all([claim(), claim()]);
  assert.equal(claims.filter(Boolean).length, 1, "only one controller may consume the request");
  assert.equal(await claim(), null, "a consumed request must never replay");
});

test("a second writer cannot overwrite a pending one-shot request", async () => {
  const stateRoot = await privateRoot();
  const original = await publishBackgroundStartRequest({
    stateRoot,
    ...startRequest(),
  }, { now: () => NOW });
  await assert.rejects(publishBackgroundStartRequest({
    stateRoot,
    ...startRequest({ transitionNonce: "replacement-request" }),
  }, { now: () => NOW }), (error) => error.code === "BACKGROUND_START_REQUEST_PENDING");
  assert.deepEqual(await readBackgroundStartRequest({ stateRoot }), original);
});

test("background start request rejects stale, wrong identity, malformed fields, and symlink inputs", async (t) => {
  await t.test("stale request is consumed and rejected", async () => {
    const stateRoot = await privateRoot();
    await publishBackgroundStartRequest({ stateRoot, ...startRequest() }, { now: () => NOW });
    await assert.rejects(claimBackgroundStartRequest({
      stateRoot,
      platform: "darwin",
      backgroundIdentity: "com.heige.codex-skin-controller",
      maxAgeMs: 30_000,
      clock: () => NOW.getTime() + 30_001,
    }), /stale|fresh/i);
    assert.equal(await readBackgroundStartRequest({ stateRoot }), null);
  });

  await t.test("wrong background identity is consumed and rejected", async () => {
    const stateRoot = await privateRoot();
    await publishBackgroundStartRequest({ stateRoot, ...startRequest() }, { now: () => NOW });
    await assert.rejects(claimBackgroundStartRequest({
      stateRoot,
      platform: "darwin",
      backgroundIdentity: "com.example.foreign",
      clock: () => NOW.getTime(),
    }), /identity|mismatch/i);
    assert.equal(await readBackgroundStartRequest({ stateRoot }), null);
  });

  await t.test("malformed nonce", async () => {
    const stateRoot = await privateRoot();
    await writeFile(backgroundStartRequestPath(stateRoot), JSON.stringify({
      schemaVersion: 2,
      ...startRequest({ transitionNonce: "wrong nonce" }),
      createdAt: NOW.toISOString(),
    }), { mode: 0o600 });
    await assert.rejects(claimBackgroundStartRequest({
      stateRoot,
      platform: "darwin",
      backgroundIdentity: "com.heige.codex-skin-controller",
      clock: () => NOW.getTime(),
    }), /nonce/i);
  });

  await t.test("malformed outer transaction", async () => {
    const stateRoot = await privateRoot();
    await writeFile(backgroundStartRequestPath(stateRoot), JSON.stringify({
      schemaVersion: 2,
      ...startRequest({
        outerTransaction: {
          transactionId: "123e4567-e89b-42d3-a456-426614174000",
          journalPath: join(stateRoot, "foreign-install.json"),
        },
      }),
      createdAt: NOW.toISOString(),
    }), { mode: 0o600 });
    await assert.rejects(claimBackgroundStartRequest({
      stateRoot,
      platform: "darwin",
      backgroundIdentity: "com.heige.codex-skin-controller",
      clock: () => NOW.getTime(),
    }), /outer transaction/i);
    assert.equal(await readBackgroundStartRequest({ stateRoot }), null);
  });

  await t.test("symlink", async () => {
    const stateRoot = await privateRoot();
    const target = join(stateRoot, "request-target.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, backgroundStartRequestPath(stateRoot));
    await assert.rejects(claimBackgroundStartRequest({
      stateRoot,
      platform: "darwin",
      backgroundIdentity: "com.heige.codex-skin-controller",
      clock: () => NOW.getTime(),
    }), /regular|symbolic|symlink/i);
  });
});

test("handshake reader rejects unknown fields, permissive modes, and symlinks", async (t) => {
  await t.test("unknown field", async () => {
    const stateRoot = await privateRoot();
    const path = backgroundHandshakePath(stateRoot);
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      ...handshake(),
      createdAt: NOW.toISOString(),
      controlToken: "must-never-appear",
    }), { mode: 0o600 });
    await assert.rejects(readBackgroundHandshake({ stateRoot }), /schema|field|unknown/i);
  });

  await t.test("mode", async () => {
    const stateRoot = await privateRoot();
    await writeFile(backgroundHandshakePath(stateRoot), "{}", { mode: 0o644 });
    await assert.rejects(readBackgroundHandshake({ stateRoot }), /0600/);
  });

  await t.test("duplicate field", async () => {
    const stateRoot = await privateRoot();
    const valid = JSON.stringify({
      schemaVersion: 1,
      ...handshake(),
      createdAt: NOW.toISOString(),
    });
    await writeFile(
      backgroundHandshakePath(stateRoot),
      valid.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      { mode: 0o600 },
    );
    await assert.rejects(readBackgroundHandshake({ stateRoot }), /duplicate|canonical/i);
  });

  await t.test("symlink", async () => {
    const stateRoot = await privateRoot();
    const target = join(stateRoot, "target.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, backgroundHandshakePath(stateRoot));
    await assert.rejects(readBackgroundHandshake({ stateRoot }), /regular|symbolic|symlink/i);
  });
});

test("handshake wait accepts only the exact fresh request and a live non-foreground PID", async () => {
  const stateRoot = await privateRoot();
  await publishBackgroundHandshake({ stateRoot, ...handshake() }, { now: () => NOW });
  const observed = await waitForBackgroundHandshake({
    stateRoot,
    expected: {
      revision: 6,
      transitionNonce: "controller-transition-7",
      platform: "darwin",
      backgroundIdentity: "com.heige.codex-skin-controller",
      outcome: "ready",
    },
    forbiddenPid: 1000,
    notBefore: NOW.getTime(),
    timeoutMs: 50,
    pollIntervalMs: 1,
    readProcessIdentity: async () => ({
      pid: 73001,
      startedAt: "Fri Jul 17 16:00:00 2026",
    }),
    clock: () => NOW.getTime(),
  });
  assert.equal(observed.pid, 73001);
});

test("an exact handshake is atomically consumed once after wait verification", async () => {
  const stateRoot = await privateRoot();
  await publishBackgroundHandshake({ stateRoot, ...handshake() }, { now: () => NOW });
  const input = {
    stateRoot,
    expected: {
      revision: 6,
      transitionNonce: "controller-transition-7",
      platform: "darwin",
      backgroundIdentity: "com.heige.codex-skin-controller",
      outcome: "ready",
    },
    forbiddenPid: 1000,
    notBefore: NOW.getTime(),
    readProcessIdentity: async () => ({
      pid: 73001,
      startedAt: "Fri Jul 17 16:00:00 2026",
    }),
    clock: () => NOW.getTime(),
  };
  assert.equal((await consumeBackgroundHandshake(input)).pid, 73001);
  assert.equal(await readBackgroundHandshake({ stateRoot }), null);
  await assert.rejects(
    consumeBackgroundHandshake(input),
    (error) => error.code === "BACKGROUND_HANDSHAKE_MISSING",
  );
});

test("an old controller handshake is rejected while a later exact process may replace it", async () => {
  const stateRoot = await privateRoot();
  await publishBackgroundHandshake({
    stateRoot,
    ...handshake({ transitionNonce: "old-controller" }),
  }, { now: () => NOW });
  let waits = 0;
  const observed = await waitForBackgroundHandshake({
    stateRoot,
    expected: {
      revision: 6,
      transitionNonce: "controller-transition-7",
      platform: "darwin",
      backgroundIdentity: "com.heige.codex-skin-controller",
      outcome: "ready",
    },
    forbiddenPid: 1000,
    notBefore: NOW.getTime(),
    timeoutMs: 50,
    pollIntervalMs: 1,
    readProcessIdentity: async () => ({
      pid: 73001,
      startedAt: "Fri Jul 17 16:00:00 2026",
    }),
    wait: async () => {
      waits += 1;
      await publishBackgroundHandshake({ stateRoot, ...handshake() }, { now: () => NOW });
    },
    clock: () => NOW.getTime(),
  });
  assert.equal(waits, 1);
  assert.equal(observed.transitionNonce, "controller-transition-7");
});

for (const [name, changed, message] of [
  ["revision", { revision: 5 }, /revision|mismatch/i],
  ["nonce", { transitionNonce: "old-transition" }, /nonce|mismatch/i],
  ["identity", { backgroundIdentity: "old-controller" }, /identity|mismatch/i],
  ["outcome", { outcome: "unregister" }, /outcome|mismatch/i],
  ["stale", { createdAt: "2026-07-17T07:59:59.000Z" }, /stale|createdAt/i],
]) {
  test(`handshake wait rejects a wrong or ${name} document`, async () => {
    const stateRoot = await privateRoot();
    const document = {
      schemaVersion: 1,
      ...handshake(),
      createdAt: NOW.toISOString(),
      ...changed,
    };
    await writeFile(backgroundHandshakePath(stateRoot), `${JSON.stringify(document)}\n`, { mode: 0o600 });
    await assert.rejects(waitForBackgroundHandshake({
      stateRoot,
      expected: {
        revision: 6,
        transitionNonce: "controller-transition-7",
        platform: "darwin",
        backgroundIdentity: "com.heige.codex-skin-controller",
        outcome: "ready",
      },
      forbiddenPid: 1000,
      notBefore: NOW.getTime(),
      timeoutMs: 20,
      pollIntervalMs: 1,
      readProcessIdentity: async () => ({
        pid: 73001,
        startedAt: "Fri Jul 17 16:00:00 2026",
      }),
      clock: () => NOW.getTime(),
    }), message);
  });
}

test("handshake wait rejects the requesting foreground PID and PID reuse", async (t) => {
  for (const [name, forbiddenPid, observed] of [
    ["foreground", 73001, { pid: 73001, startedAt: "Fri Jul 17 16:00:00 2026" }],
    ["PID reuse", 1000, { pid: 73001, startedAt: "Fri Jul 17 16:01:00 2026" }],
  ]) {
    await t.test(name, async () => {
      const stateRoot = await privateRoot();
      await publishBackgroundHandshake({ stateRoot, ...handshake() }, { now: () => NOW });
      await assert.rejects(waitForBackgroundHandshake({
        stateRoot,
        expected: {
          revision: 6,
          transitionNonce: "controller-transition-7",
          platform: "darwin",
          backgroundIdentity: "com.heige.codex-skin-controller",
          outcome: "ready",
        },
        forbiddenPid,
        notBefore: NOW.getTime(),
        timeoutMs: 20,
        pollIntervalMs: 1,
        readProcessIdentity: async () => observed,
        clock: () => NOW.getTime(),
      }), /PID|process|foreground|identity/i);
    });
  }
});

test("missing handshake times out and stale files can be safely removed", async () => {
  const stateRoot = await privateRoot();
  await assert.rejects(waitForBackgroundHandshake({
    stateRoot,
    expected: {
      revision: 6,
      transitionNonce: "controller-transition-7",
      platform: "darwin",
      backgroundIdentity: "com.heige.codex-skin-controller",
      outcome: "ready",
    },
    forbiddenPid: 1000,
    notBefore: NOW.getTime(),
    timeoutMs: 3,
    pollIntervalMs: 1,
    readProcessIdentity: async () => null,
  }), /timed out|timeout/i);

  await publishBackgroundHandshake({ stateRoot, ...handshake() }, { now: () => NOW });
  assert.equal(await removeBackgroundHandshake({ stateRoot }), true);
  assert.equal(await readBackgroundHandshake({ stateRoot }), null);
  assert.equal(await removeBackgroundHandshake({ stateRoot }), false);
});
