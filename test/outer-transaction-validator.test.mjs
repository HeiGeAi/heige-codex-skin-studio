import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { validateKnownOuterTransactionDocument } from "../src/outer-transaction-validator.mjs";

function fixture() {
  const transactionId = randomUUID();
  const freezeParticipant = {
    schemaVersion: 1,
    operation: "freeze-stable-services",
    transactionId,
    coordinatorJournalPath: "/state/macos-install.json",
    participantJournalPath: "/state/stable-service-freeze.json",
    controllerLabel: "com.heige.codex-skin-controller",
    controllerPlistPath: "/Users/test/Library/LaunchAgents/com.heige.codex-skin-controller.plist",
    watchdogLabel: "com.heige.codex-skin-watchdog",
    watchdogPlistPath: "/Users/test/Library/LaunchAgents/com.heige.codex-skin-watchdog.plist",
  };
  return {
    freezeParticipant,
    document: {
      schemaVersion: 1,
      product: "heige-codex-skin-studio",
      operation: "macos-install",
      transactionId,
      revision: 8,
      nonce: randomUUID(),
      previousNonce: randomUUID(),
      decision: "commit",
      phase: "commit-decided",
      createdAt: new Date().toISOString(),
      sourceRoot: "/source",
      targetRoot: "/Users/test/.codex/heige-codex-skin-studio",
      home: "/Users/test",
      stateRoot: "/state",
      activation: "controller",
      treeParticipant: {},
      launcherParticipant: {},
      stateParticipant: {},
      freezeParticipant,
      ack: {
        persistenceEnabled: true,
        revision: 1,
        processIdentity: { pid: 8201, startedAt: "Fri Jul 17 16:40:00 2026" },
      },
    },
  };
}

test("outer decision validator binds the exact freeze capability", () => {
  const { document, freezeParticipant } = fixture();
  assert.equal(
    validateKnownOuterTransactionDocument(document, {
      transactionId: document.transactionId,
      participant: freezeParticipant,
    }).decision,
    "commit",
  );
});

test("outer decision validator rejects a commit paired with a nonterminal phase", () => {
  const { document, freezeParticipant } = fixture();
  assert.throws(
    () => validateKnownOuterTransactionDocument({
      ...document,
      phase: "state-published",
    }, {
      transactionId: document.transactionId,
      participant: freezeParticipant,
    }),
    /terminal decision/i,
  );
});

test("outer decision validator accepts the durable freeze rollback restoration phase", () => {
  const { document, freezeParticipant } = fixture();
  const rollback = {
    ...document,
    decision: "rollback",
    phase: "freeze-rollback-restored",
  };
  assert.equal(
    validateKnownOuterTransactionDocument(rollback, {
      transactionId: document.transactionId,
      participant: freezeParticipant,
    }).phase,
    "freeze-rollback-restored",
  );
});

test("outer decision validator rejects a descriptor that differs by one canonical path", () => {
  const { document, freezeParticipant } = fixture();
  assert.throws(
    () => validateKnownOuterTransactionDocument(document, {
      transactionId: document.transactionId,
      participant: {
        ...freezeParticipant,
        participantJournalPath: "/state/foreign-freeze.json",
      },
    }),
    (error) => error.code === "OUTER_TRANSACTION_CONFLICT",
  );
});

test("outer decision validator rejects unknown top-level authority fields", () => {
  const { document, freezeParticipant } = fixture();
  assert.throws(
    () => validateKnownOuterTransactionDocument({ ...document, trusted: true }, {
      transactionId: document.transactionId,
      participant: freezeParticipant,
    }),
    /schema/i,
  );
});

test("outer decision validator accepts exact ACK legacy commit and precommit rollback documents", () => {
  const transactionId = randomUUID();
  const base = {
    schemaVersion: 1,
    product: "heige-codex-skin-studio",
    operation: "legacy-migration",
    transactionId,
    revision: 3,
    nonce: randomUUID(),
    previousNonce: randomUUID(),
    createdAt: new Date().toISOString(),
    stateParticipant: {},
    serviceParticipant: null,
  };
  const commit = {
    ...base,
    decision: "commit",
    phase: "commit-decided",
    ack: {
      persistenceEnabled: true,
      revision: 1,
      processIdentity: { pid: 8301, startedAt: "Fri Jul 17 16:50:00 2026" },
    },
  };
  assert.equal(validateKnownOuterTransactionDocument(commit).decision, "commit");
  assert.equal(validateKnownOuterTransactionDocument({
    ...base,
    decision: "rollback",
    phase: "rollback-decided",
    ack: null,
  }).decision, "rollback");
});

test("outer decision validator rejects missing or malformed legacy ACK authority fields", () => {
  const transactionId = randomUUID();
  const document = {
    schemaVersion: 1,
    product: "heige-codex-skin-studio",
    operation: "legacy-migration",
    transactionId,
    revision: 3,
    nonce: randomUUID(),
    previousNonce: randomUUID(),
    decision: "commit",
    phase: "commit-decided",
    createdAt: new Date().toISOString(),
    stateParticipant: {},
    serviceParticipant: null,
  };
  assert.throws(() => validateKnownOuterTransactionDocument(document), /schema/i);
  assert.throws(() => validateKnownOuterTransactionDocument({
    ...document,
    ack: { persistenceEnabled: true, revision: 1 },
  }), /ACK schema/i);
});
