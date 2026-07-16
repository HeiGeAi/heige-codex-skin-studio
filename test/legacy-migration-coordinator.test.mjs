import assert from "node:assert/strict";
import { lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_THEME_ID } from "../src/constants.mjs";
import {
  clearLegacyMigrationCoordinator,
  createLegacyMigrationCoordinator,
  legacyMigrationJournalPath,
  readLegacyMigrationCoordinator,
  updateLegacyMigrationCoordinator,
} from "../src/legacy-migration-coordinator.mjs";
import { acquireOperationLock } from "../src/operation-lock.mjs";
import { createDefaultStudioState } from "../src/state-store.mjs";

const TRANSACTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const CONTROL_TOKEN = Buffer.alloc(32, 17).toString("base64url");

async function fixture(t, name = "state") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "heige-legacy-coordinator-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, name);
  const identity = {
    pid: process.pid,
    startedAt: "2026-07-17T08:00:00.000Z",
  };
  const lease = await acquireOperationLock({
    lockPath: join(stateRoot, "operation.lock"),
    stateRoot,
    operation: "legacy-coordinator-test",
    identity,
    readProcessIdentity: async (pid) => (pid === identity.pid ? identity : null),
  });
  t.after(() => lease.release());
  return {
    journalPath: legacyMigrationJournalPath(stateRoot),
    lease,
    statePath: join(stateRoot, "state.json"),
    stateRoot,
  };
}

function participant(statePath, afterState = null) {
  return {
    statePath,
    beforeState: null,
    afterState,
    expectedControlToken: CONTROL_TOKEN,
  };
}

test("coordinator publishes one canonical private journal and removes it only under the bound lease", async (t) => {
  const fx = await fixture(t);
  const state = {
    ...createDefaultStudioState({ themeId: DEFAULT_THEME_ID, token: CONTROL_TOKEN }),
    persistenceEnabled: true,
    revision: 1,
  };
  let document = await createLegacyMigrationCoordinator({
    journalPath: fx.journalPath,
    transactionId: TRANSACTION_ID,
    stateParticipant: participant(fx.statePath),
    lease: fx.lease,
  });
  assert.equal((await lstat(fx.journalPath)).mode & 0o777, 0o600);
  assert.equal(
    (await readdir(fx.stateRoot)).some((name) => name.startsWith("legacy-migration.json.next.")),
    false,
  );

  document = await updateLegacyMigrationCoordinator(
    fx.journalPath,
    document,
    {
      phase: "state-prepared",
      stateParticipant: participant(fx.statePath, state),
    },
    { lease: fx.lease },
  );
  document = await updateLegacyMigrationCoordinator(
    fx.journalPath,
    document,
    { decision: "commit", phase: "commit-decided" },
    { lease: fx.lease },
  );
  assert.deepEqual(
    await readLegacyMigrationCoordinator(fx.journalPath, { lease: fx.lease }),
    document,
  );
  await clearLegacyMigrationCoordinator(fx.journalPath, document, { lease: fx.lease });
  assert.equal(await readLegacyMigrationCoordinator(fx.journalPath, { lease: fx.lease }), null);
});

test("coordinator rejects a lease from another canonical state root and immutable transaction changes", async (t) => {
  const first = await fixture(t, "first");
  const second = await fixture(t, "second");
  const document = await createLegacyMigrationCoordinator({
    journalPath: first.journalPath,
    transactionId: TRANSACTION_ID,
    stateParticipant: participant(first.statePath),
    lease: first.lease,
  });

  await assert.rejects(
    readLegacyMigrationCoordinator(first.journalPath, { lease: second.lease }),
    /not bound to the leased stateRoot/,
  );
  await assert.rejects(
    updateLegacyMigrationCoordinator(
      first.journalPath,
      document,
      { transactionId: "7ba0a1ce-cbd2-49f8-8f40-bd3ae80ced96" },
      { lease: first.lease },
    ),
    /immutable fields/,
  );
});
