import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function source(relativePath) {
  return readFile(join(repositoryRoot, relativePath), "utf8");
}

test("Windows PowerShell carries one immutable app identity through entrypoint task and Node", async () => {
  const [entrypoints, scheduledTask, controller] = await Promise.all([
    source("scripts/windows/lib/entrypoints.ps1"),
    source("scripts/windows/lib/scheduled-task.ps1"),
    source("scripts/windows/controller.ps1"),
  ]);
  assert.match(entrypoints, /HEIGE_WINDOWS_APP_IDENTITY/);
  assert.match(scheduledTask, /-AppIdentityToken/);
  assert.match(controller, /Resolve-HeiGeBoundCodexApp/);
  assert.match(controller, /AppIdentityToken/);
  assert.match(controller, /HEIGE_WINDOWS_APP_IDENTITY/);
  assert.match(scheduledTask, /ConvertFrom-HeiGeCodexAppIdentityToken/);
});

test("Windows icacls fallback sets owner with a starred SID in a separate invocation", async () => {
  const [common, secureFs] = await Promise.all([
    source("scripts/windows/lib/common.ps1"),
    source("src/windows-secure-fs.mjs"),
  ]);
  assert.match(common, /\/inheritance:r \/grant:r \$grant/);
  assert.match(common, /\/setowner "\*\$\{UserSid\}"/);
  assert.equal(common.includes("/inheritance:r /setowner"), false);
  assert.match(secureFs, /\/inheritance:r \/grant:r \$grant/);
  assert.match(secureFs, /\/setowner \('\*\{0\}' -f \$sidText\)/);
  assert.equal(secureFs.includes("/inheritance:r /setowner"), false);
});

test("Windows bound resolver is token-directed and the runtime rejects foreign app processes", async () => {
  const [common, runtime] = await Promise.all([
    source("scripts/windows/lib/common.ps1"),
    source("src/windows-runtime.mjs"),
  ]);
  assert.match(common, /PackageFullName/);
  assert.match(common, /InstallLocation/);
  assert.match(common, /Aumid/);
  assert.match(common, /OverridePath\s+\(\[string\]\$expected\.ExecutablePath\)/i);
  assert.match(runtime, /foreign Windows Codex process/i);
});

test("Windows session controller breakaway starter only launches ephemeral controller argv", async () => {
  const [common, starter] = await Promise.all([
    source("scripts/windows/lib/common.ps1"),
    source("scripts/windows/start-session-controller.ps1"),
  ]);
  assert.match(common, /function Start-HeiGeBreakawayNodeProcess/);
  assert.match(common, /CREATE_BREAKAWAY_FROM_JOB|CreateBreakawayFromJob/);
  assert.match(common, /HeiGeSession-/);
  assert.match(starter, /Start-HeiGeBreakawayNodeProcess/);
  assert.match(starter, /ArgumentsJson/);
});
