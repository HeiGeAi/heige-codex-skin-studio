import { isDeepStrictEqual } from "node:util";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCT = "heige-codex-skin-studio";

const SHAPES = Object.freeze({
  "install-tree": {
    keys: [
      "createdAt", "decision", "nonce", "operation", "participant", "phase",
      "previousNonce", "product", "revision", "schemaVersion", "transactionId",
    ],
    phases: new Set([
      "staged", "backup-detached", "target-published", "rollback-decided",
      "commit-decided",
    ]),
  },
  "legacy-migration": {
    keys: [
      "ack", "createdAt", "decision", "nonce", "operation", "phase", "previousNonce",
      "product", "revision", "schemaVersion", "serviceParticipant",
      "stateParticipant", "transactionId",
    ],
    phases: new Set([
      "prepared", "state-prepared", "service-prepared", "ready-acked",
      "rollback-decided", "commit-decided",
    ]),
  },
  "macos-install": {
    keys: [
      "ack", "activation", "createdAt", "decision", "freezeParticipant", "home",
      "launcherParticipant", "nonce", "operation", "phase", "previousNonce",
      "product", "revision", "schemaVersion", "sourceRoot", "stateParticipant",
      "stateRoot", "targetRoot", "transactionId", "treeParticipant",
    ],
    phases: new Set([
      "skeleton", "tree-prepared", "launcher-prepared", "state-prepared",
      "freeze-intent", "services-frozen", "tree-published", "launcher-published",
      "state-published", "activation-planned", "activation-skipped",
      "service-prepared", "ready-acked", "rollback-decided", "commit-decided",
      "freeze-rollback-restored",
    ]),
  },
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function validExactAck(value) {
  return exactKeys(value, ["persistenceEnabled", "processIdentity", "revision"]) &&
    value.persistenceEnabled === true &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    exactKeys(value.processIdentity, ["pid", "startedAt"]) &&
    Number.isSafeInteger(value.processIdentity.pid) &&
    value.processIdentity.pid > 0 &&
    typeof value.processIdentity.startedAt === "string" &&
    value.processIdentity.startedAt.length > 0;
}

function conflict(message) {
  const error = new Error(message);
  error.code = "OUTER_TRANSACTION_CONFLICT";
  return error;
}

export function validateKnownOuterTransactionDocument(document, {
  transactionId = null,
  participant = null,
} = {}) {
  const shape = SHAPES[document?.operation];
  if (
    shape === undefined ||
    !exactKeys(document, shape.keys) ||
    document.schemaVersion !== 1 ||
    document.product !== PRODUCT ||
    !UUID.test(document.transactionId) ||
    !["undecided", "rollback", "commit"].includes(document.decision) ||
    !shape.phases.has(document.phase) ||
    !Number.isSafeInteger(document.revision) ||
    document.revision < 0 ||
    !UUID.test(document.nonce) ||
    !(document.previousNonce === null || UUID.test(document.previousNonce)) ||
    typeof document.createdAt !== "string" ||
    !Number.isFinite(Date.parse(document.createdAt)) ||
    (document.decision === "commit") !== (document.phase === "commit-decided") ||
    (document.decision === "rollback") !== [
      "rollback-decided",
      "freeze-rollback-restored",
    ].includes(document.phase)
  ) {
    throw new Error("outer transaction journal schema or terminal decision is invalid");
  }
  if (transactionId !== null && document.transactionId !== transactionId) {
    throw conflict("outer transaction id does not match the participant");
  }
  if (
    document.operation === "legacy-migration" &&
    !(document.ack === null || validExactAck(document.ack))
  ) {
    throw new Error("outer legacy migration exact ACK schema is invalid");
  }
  if (participant !== null) {
    if (!isRecord(participant) || participant.transactionId !== document.transactionId) {
      throw conflict("outer transaction participant identity is invalid");
    }
    const recorded = participant.operation === "freeze-stable-services" &&
      document.operation === "macos-install"
      ? document.freezeParticipant
      : participant.operation === "migrate-legacy-watchdog" &&
          document.operation === "legacy-migration"
        ? document.serviceParticipant
        : undefined;
    if (recorded === undefined || !isDeepStrictEqual(recorded, participant)) {
      throw conflict("outer transaction does not bind the exact participant descriptor");
    }
  }
  return document;
}
