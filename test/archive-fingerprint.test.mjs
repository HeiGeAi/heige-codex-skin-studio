import assert from "node:assert/strict";
import test from "node:test";

import {
  SUPPORTED_BASE_ARCHIVE_SHA256,
  validateSupportedArchiveFingerprint,
} from "../src/theme-patch.mjs";

const appAsar = "/Applications/ChatGPT.app/Contents/Resources/app.asar";

test("accepts the verified official and prior-theme Codex resource baselines", () => {
  assert.deepEqual(SUPPORTED_BASE_ARCHIVE_SHA256, [
    "b5da51e5df6e996076e4cb19045cec46dd4c08cf61c19cdbc5cb426b8413b73c",
    "e9f0c1defb583c414e14ac81c301f15abb533dea080501ddd329846b1a67d239",
  ]);
  for (const archiveSha256 of SUPPORTED_BASE_ARCHIVE_SHA256) {
    assert.equal(
      validateSupportedArchiveFingerprint({
        archiveSha256,
        asarPath: appAsar,
        currentHtml: "<html>official or verified migration baseline</html>",
        state: null,
      }),
      archiveSha256,
    );
  }
});

test("accepts an installed theme only when state traces it to a verified baseline", () => {
  const themedArchiveSha256 = "a".repeat(64);
  assert.equal(
    validateSupportedArchiveFingerprint({
      archiveSha256: themedArchiveSha256,
      asarPath: appAsar,
      currentHtml: "/* CODEX_MIKU_THEME v5 488137 SIDEBAR */",
      state: {
        appAsar,
        installedVersion: 5,
        originalArchiveSha256: SUPPORTED_BASE_ARCHIVE_SHA256[0],
        themedArchiveSha256,
      },
    }),
    SUPPORTED_BASE_ARCHIVE_SHA256[0],
  );
});

test("rejects same-version resource drift and unverified themed archives", () => {
  assert.throws(
    () =>
      validateSupportedArchiveFingerprint({
        archiveSha256: "c".repeat(64),
        asarPath: appAsar,
        currentHtml: "<html>same plist version, different resources</html>",
        state: null,
      }),
    /Unsupported Codex resource fingerprint/,
  );
  assert.throws(
    () =>
      validateSupportedArchiveFingerprint({
        archiveSha256: "d".repeat(64),
        asarPath: appAsar,
        currentHtml: "/* CODEX_MIKU_THEME v5 488137 SIDEBAR */",
        state: {
          appAsar,
          originalArchiveSha256: "e".repeat(64),
          themedArchiveSha256: "d".repeat(64),
        },
      }),
    /Unsupported Codex resource fingerprint/,
  );
});
