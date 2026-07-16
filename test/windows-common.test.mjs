import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("windows helper discovers MSIX Codex and avoids its blocked bundled Node", { skip: process.platform !== "win32" }, async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "heige-msix-"));
  const commonPath = join(root, "scripts", "windows", "lib", "common.ps1");
  const quote = (value) => value.replaceAll("'", "''");

  const script = `
$fixtureRoot = '${quote(fixtureRoot)}'
$installLocation = Join-Path $fixtureRoot 'WindowsApps\\OpenAI.Codex_1.0.0.0_x64__test'
$entryPoint = Join-Path $installLocation 'app\\ChatGPT.exe'
New-Item -ItemType File -Path $entryPoint -Force | Out-Null
$env:LOCALAPPDATA = Join-Path $fixtureRoot 'LocalAppData'
$env:ProgramFiles = Join-Path $fixtureRoot 'ProgramFiles'

. '${quote(commonPath)}'

function Get-AppxPackage {
    param([string]$Name)
    [pscustomobject]@{
        Name = $Name
        Version = [version]'1.0.0.0'
        InstallLocation = $installLocation
        PackageFamilyName = 'OpenAI.Codex_test'
    }
}

$app = Get-CodexApp
if ($app -ne $entryPoint) { throw "unexpected app path: $app" }

$expectedNode = (Get-Command node -ErrorAction Stop).Source
$node = Get-NodeRuntime -AppPath $app
if ($node -ne $expectedNode) { throw "unexpected Node path: $node" }

Write-Output 'MSIX_DISCOVERY_OK'
`;

  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
    });
    assert.match(stdout, /MSIX_DISCOVERY_OK/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
