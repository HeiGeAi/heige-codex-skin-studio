import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const sourceUrl = new URL("../native/macos-launcher/main.swift", import.meta.url);
const buildUrl = new URL("../scripts/build-macos-launcher.command", import.meta.url);
const binaryUrl = new URL("../assets/launcher/HeiGeSkinLauncher.bin", import.meta.url);
const binaryPath = fileURLToPath(binaryUrl);

test("native launcher source owns the exact two-product AppKit contract", async () => {
  const source = await readFile(sourceUrl, "utf8");

  for (const expected of [
    "import AppKit",
    'case codex = "codex"',
    'case workbuddy = "workbuddy"',
    'bundleIdentifier: "com.openai.codex"',
    'bundleIdentifier: "com.workbuddy.workbuddy"',
    '"launcher-state.command"',
    '"launch-skin.command"',
    "ProductCardView",
    "正在恢复",
    "恢复失败",
    "查看诊断与日志",
    "HeiGeInstallRoot",
    "CFBundleShortVersionString",
    "schemaVersion == 1",
  ]) assert.match(source, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  for (const forbidden of ["URLSession", '"/bin/sh"', '"/bin/zsh"', "app.asar", "eval("]) {
    assert.doesNotMatch(source, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("native launcher header uses the bundled Miku app icon instead of a letter placeholder", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /Bundle\.main\.url\(forResource: "AppIcon", withExtension: "icns"\)/);
  assert.match(source, /NSImageView/);
  assert.match(source, /\.scaleProportionallyUpOrDown/);
  assert.doesNotMatch(source, /labelWithString:\s*"H"/);
});

test("native launcher re-resolves every layer surface when macOS appearance changes", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /class AppearanceSurfaceView: NSView/);
  assert.match(source, /override func viewDidChangeEffectiveAppearance\(\)/);
  assert.match(source, /effectiveAppearance\.performAsCurrentDrawingAppearance/);
  assert.match(source, /AppearanceSurfaceView\(backgroundColor: \.windowBackgroundColor/);
  assert.match(source, /AppearanceSurfaceView\(backgroundColor: \.controlBackgroundColor/);
  assert.match(source, /super\.init\([\s\S]*backgroundColor: \.windowBackgroundColor/);

  for (const staleColor of [
    "NSColor.windowBackgroundColor.cgColor",
    "NSColor.controlBackgroundColor.cgColor",
    "NSColor.separatorColor.withAlphaComponent(0.55).cgColor",
  ]) {
    assert.doesNotMatch(source, new RegExp(staleColor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("native launcher build is reproducible for both supported Mac architectures", async () => {
  const script = await readFile(buildUrl, "utf8");
  assert.match(script, /arm64-apple-macos13\.0/);
  assert.match(script, /x86_64-apple-macos13\.0/);
  assert.match(script, /lipo/);
  assert.match(script, /mktemp -d/);
  assert.doesNotMatch(script, /curl|wget|sudo/);

  const info = await stat(binaryUrl);
  assert.equal(info.isFile(), true);
  assert.equal(info.mode & 0o111, 0o111);
  assert.ok(info.size > 32_000);

  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("/usr/bin/lipo", ["-archs", binaryPath]);
    const architectures = new Set(stdout.trim().split(/\s+/));
    assert.deepEqual(architectures, new Set(["x86_64", "arm64"]));
  }
});
