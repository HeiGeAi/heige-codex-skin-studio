import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = new URL("../", import.meta.url);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function gitLines(...args) {
  const { stdout } = await execFileAsync("git", args, { cwd: root, encoding: "utf8" });
  return stdout.split(/\r?\n/).filter(Boolean);
}

test("security documentation states the real CDP and control-channel boundary", async () => {
  const text = await readFile(new URL("../SECURITY.md", import.meta.url), "utf8");
  for (const phrase of [
    "Runtime.evaluate",
    "127.0.0.1",
    "无认证的 CDP",
    "X-HeiGe-Control-Token",
    "不读取 Codex 对话",
    "restore",
  ]) assert.match(text, new RegExp(escapeRegExp(phrase), "i"));
  assert.match(text, /Report a vulnerability/);
  assert.match(text, /不要.*公开.*Issue/s);
});

test("tracked source contains no backup assets or ignored reports", async () => {
  const tracked = await gitLines("ls-files");
  assert.equal(tracked.some((path) => path.includes(".before-")), false);
  assert.equal(tracked.some((path) => path.startsWith("reports/")), false);
});

test("every tracked visual asset has exactly one provenance row", async () => {
  await execFileAsync(process.execPath, ["scripts/check-asset-provenance.mjs", "--check"], {
    cwd: root,
    encoding: "utf8",
  });
});

test("notice does not pretend a disclaimer grants redistribution rights", async () => {
  const text = await readFile(new URL("../NOTICE.md", import.meta.url), "utf8");
  assert.match(text, /MIT.*软件|software.*only/is);
  assert.match(text, /不.*授权|does not.*permission/is);
  assert.match(text, /发布风险|release risk/is);
});

test("CI has independent Node macOS Windows and package gates", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /^on:\s*$/m);
  assert.match(workflow, /^  pull_request:\s*$/m);
  assert.match(workflow, /^  workflow_dispatch:\s*$/m);
  for (const job of ["node:", "macos:", "windows:", "package:"]) {
    assert.match(workflow, new RegExp(`^  ${job}`, "m"));
  }
  assert.match(workflow, /permissions:\s*\n\s*contents: read/s);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.match(workflow, /powershell\.exe.*run-tests\.ps1/s);
  assert.match(workflow, /pwsh.*run-tests\.ps1/s);
  assert.match(workflow, /SysWOW64.*resolver\.test\.ps1/s);
  assert.match(workflow, /scheduled-task\.test\.ps1.*-Integration/s);
  assert.ok((workflow.match(/git status --porcelain/g) ?? []).length >= 4);
  assert.doesNotMatch(workflow, /^  push:/m);
  assert.doesNotMatch(workflow, /actions\/[^\s]*release|gh release|upload-artifact|git push/i);
});

test("line endings are fixed and every tracked PowerShell file retains its UTF-8 BOM", async () => {
  const attributes = await readFile(new URL("../.gitattributes", import.meta.url), "utf8");
  for (const phrase of [
    "*.ps1 text eol=crlf",
    "*.bat text eol=crlf",
    "*.mjs text eol=lf",
    "*.command text eol=lf",
    "*.zsh text eol=lf",
    "*.md text eol=lf",
    "*.json text eol=lf",
    "*.yml text eol=lf",
  ]) assert.match(attributes, new RegExp(escapeRegExp(phrase)));
  const powershell = (await gitLines("ls-files")).filter((path) => path.endsWith(".ps1"));
  assert.ok(powershell.length > 0);
  for (const path of powershell) {
    const bytes = await readFile(new URL(`../${path}`, import.meta.url));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${path} must retain UTF-8 BOM`);
  }
});
