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

test("Windows bound resolver is token-directed and the runtime rejects foreign app processes", async () => {
  const [common, runtime] = await Promise.all([
    source("scripts/windows/lib/common.ps1"),
    source("src/windows-runtime.mjs"),
  ]);
  assert.match(common, /PackageFullName/);
  assert.match(common, /InstallLocation/);
  assert.match(common, /Aumid/);
  assert.match(common, /OverridePath\s+\(\[string\]\$expected\.ExecutablePath\)/i);
  assert.match(runtime, /Test-HeiGeCodexInternalBackendPath\s+-Path\s+\$path/i);
  assert.match(runtime, /foreign Windows Codex process/i);
  assert.ok(
    runtime.indexOf("Test-HeiGeCodexInternalBackendPath -Path $path")
      < runtime.indexOf("foreign Windows Codex process"),
    "known internal/editor CLIs must be excluded before immutable desktop identity enforcement",
  );
});

test("Windows PowerShell process mode traverses every owned node and rejects cycles", async () => {
  const entrypoints = await source("scripts/windows/lib/entrypoints.ps1");
  assert.match(entrypoints, /ownership cycle|归属环|进程图.*环/i);
  assert.match(entrypoints, /orphan component|孤立.*组件|进程图.*孤立/i);
  assert.match(entrypoints, /不属于已绑定|foreign.*identity/i);
  assert.match(entrypoints, /visited/i);
});
