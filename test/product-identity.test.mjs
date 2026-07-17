import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("exposes the approved product identity and studio paths", async () => {
  const {
    CODEX_RENDERER_ORIGIN,
    DEFAULT_CDP_PORT,
    DEFAULT_THEME_ID,
    EXPECTED_BUNDLE_ID,
    EXPECTED_TEAM_ID,
    NATIVE_THEME_ID,
    PRODUCT_ID,
    PRODUCT_NAME,
    STATE_SCHEMA_VERSION,
    THEME_SCHEMA_VERSION,
    resolveStudioPaths,
  } = await import("../src/constants.mjs");

  assert.equal(PRODUCT_ID, "heige-codex-skin-studio");
  assert.equal(PRODUCT_NAME, "HeiGe Codex Skin Studio");
  assert.equal(STATE_SCHEMA_VERSION, 2);
  assert.equal(THEME_SCHEMA_VERSION, 1);
  assert.equal(NATIVE_THEME_ID, "__heige_native__");
  assert.equal(CODEX_RENDERER_ORIGIN, "app://-");
  assert.equal(DEFAULT_THEME_ID, "miku-488137");
  assert.equal(DEFAULT_CDP_PORT, 9341);
  assert.equal(EXPECTED_BUNDLE_ID, "com.openai.codex");
  assert.equal(EXPECTED_TEAM_ID, "2DC432GLL2");
  assert.deepEqual(resolveStudioPaths({ home: "/Users/example" }), {
    installRoot: "/Users/example/.codex/heige-codex-skin-studio",
    stateRoot: "/Users/example/Library/Application Support/HeiGeCodexSkinStudio",
    statePath: "/Users/example/Library/Application Support/HeiGeCodexSkinStudio/state.json",
    sessionPath: "/Users/example/Library/Application Support/HeiGeCodexSkinStudio/session.json",
    transitionPath: "/Users/example/Library/Application Support/HeiGeCodexSkinStudio/transition.json",
    lockPath: "/Users/example/Library/Application Support/HeiGeCodexSkinStudio/operation.lock",
    logPath: "/Users/example/Library/Application Support/HeiGeCodexSkinStudio/injector.log",
    userThemesRoot: "/Users/example/Library/Application Support/HeiGeCodexSkinStudio/themes",
  });
});

test("uses the approved package identity without ASAR runtime modules", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

  assert.equal(packageJson.name, "heige-codex-skin-studio");
  assert.equal(packageJson.version, "5.1.0");
  assert.equal(packageJson.type, "module");
  assert.equal(existsSync(join(root, "src/asar.mjs")), false);
  assert.equal(existsSync(join(root, "src/theme-patch.mjs")), false);
});
