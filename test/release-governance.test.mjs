import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  packageSkill,
  TRACKED_PACKAGE_SOURCE_DATE_EPOCH,
} from "../scripts/package-skill.mjs";
import { updateReleaseHash } from "../scripts/update-release-hash.mjs";

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

test("tracked skill artifact is the exact deterministic build of current source", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "heige-tracked-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const candidate = join(directory, "candidate.skill");
  await packageSkill(candidate, { sourceDateEpoch: TRACKED_PACKAGE_SOURCE_DATE_EPOCH });
  const expected = await readFile(candidate);
  const tracked = await readFile(new URL("../output/heige-codex-skin-studio.skill", import.meta.url));
  const expectedHash = createHash("sha256").update(expected).digest("hex");
  const trackedHash = createHash("sha256").update(tracked).digest("hex");

  assert.equal(
    tracked.equals(expected),
    true,
    `tracked .skill is stale; expected ${expectedHash}, observed ${trackedHash}`,
  );
});

test("every tracked visual asset has exactly one provenance row", async () => {
  await execFileAsync(process.execPath, ["scripts/check-asset-provenance.mjs", "--check"], {
    cwd: root,
    encoding: "utf8",
  });
});

test("public Release accepts the project owner's explicit distribution decision", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/check-asset-provenance.mjs", "--release"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  assert.match(stdout, /public release provenance accepted: 36 visual assets/i);
});

test("notice does not pretend a disclaimer grants redistribution rights", async () => {
  const text = await readFile(new URL("../NOTICE.md", import.meta.url), "utf8");
  assert.match(text, /MIT.*软件|software.*only/is);
  assert.match(text, /不.*授权|does not.*permission/is);
  assert.match(text, /发布风险|release risk/is);
});

test("remote disposition records the read-only snapshot and one package hash marker", async () => {
  const [text, artifact] = await Promise.all([
    readFile(
      new URL("../docs/release/2026-07-16-audit-hardening-disposition.md", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../output/heige-codex-skin-studio.skill", import.meta.url)),
  ]);
  const markers = text.match(/^<!-- heige-package-sha256 --> Package SHA-256: [a-f0-9]{64}$/gm) ?? [];
  assert.equal(markers.length, 1);
  const expectedHash = createHash("sha256").update(artifact).digest("hex");
  assert.equal(markers[0], `<!-- heige-package-sha256 --> Package SHA-256: ${expectedHash}`);
  for (const fact of [
    "fdf374e2123e3b47183ff86af62aded8f69c0096",
    "4a8283276db8f7ec999ce49ca489113c2ac82888cab93cce00b232540e54e537",
    "976e107e5cecfdb3f02de3caf3a113521181056f",
    "Private vulnerability reporting",
    "mergeable: false",
    "codex 已解决",
  ]) assert.match(text, new RegExp(escapeRegExp(fact), "i"));
  assert.match(text, /建议.*不.*直接修改|本轮不直接修改/s);
});

test("release hash updater replaces exactly one marker atomically and rejects aliases", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "heige-release-hash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifact = join(root, "candidate.skill");
  const disposition = join(root, "disposition.md");
  const bytes = Buffer.from("deterministic candidate\n");
  await writeFile(artifact, bytes, { mode: 0o644 });
  await writeFile(
    disposition,
    "# Release\n\n<!-- heige-package-sha256 --> Package SHA-256: pending final build\n",
    { mode: 0o640 },
  );
  const expected = createHash("sha256").update(bytes).digest("hex");
  assert.equal(await updateReleaseHash({ artifact, disposition }), expected);
  assert.match(await readFile(disposition, "utf8"), new RegExp(`${expected}$`, "m"));
  assert.equal((await lstat(disposition)).mode & 0o777, 0o640);
  assert.equal(await updateReleaseHash({ artifact, disposition }), expected, "idempotent refresh");

  const duplicate = join(root, "duplicate.md");
  const line = "<!-- heige-package-sha256 --> Package SHA-256: pending final build\n";
  await writeFile(duplicate, `${line}${line}`);
  await assert.rejects(updateReleaseHash({ artifact, disposition: duplicate }), /恰好包含一个/);

  const linked = join(root, "linked.md");
  await symlink(disposition, linked);
  await assert.rejects(updateReleaseHash({ artifact, disposition: linked }), /符号链接/);
  assert.equal(await readFile(disposition, "utf8"), `# Release\n\n${MARKER_FOR_TEST(expected)}\n`);
});

function MARKER_FOR_TEST(digest) {
  return `<!-- heige-package-sha256 --> Package SHA-256: ${digest}`;
}

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
  assert.match(
    workflow,
    /windows:\s[\s\S]*?output\\heige-codex-skin-studio\.skill[\s\S]*?package-skill\.mjs[\s\S]*?scripts\\install\.ps1[\s\S]*?-SkipApply[\s\S]*?scripts\\windows\\restore\.ps1/,
    "Windows must rebuild, install, and offline-restore the exact tracked candidate",
  );
  const fakeAppBinding = workflow.indexOf("$env:HEIGE_CODEX_APP = $fakeApp");
  const packagedInstall = workflow.indexOf('& (Join-Path $candidateRoot "scripts\\install.ps1")');
  assert.ok(
    fakeAppBinding >= 0 && fakeAppBinding < packagedInstall,
    "the package smoke test must bind its isolated fake app before invoking the installer",
  );
  assert.match(
    workflow,
    /Unregister-ScheduledTask[\s\S]*?Get-ScheduledTask[\s\S]*?cleanup failed/,
    "Scheduled Task cleanup must be verified rather than swallowed",
  );
  assert.match(
    workflow,
    /cmp "\$RUNNER_TEMP\/a\.skill" output\/heige-codex-skin-studio\.skill/,
    "CI must bind the tracked user-facing artifact to the deterministic candidate",
  );
  assert.match(
    workflow,
    /node:\s[\s\S]*?actions\/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10[^\n]*\n\s*with:\s*\n\s*fetch-depth: 0/,
    "the full Node suite needs public migration history such as 79b03dc",
  );
  assert.equal(
    (workflow.match(/actions\/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10/g) ?? []).length,
    4,
  );
  assert.equal(
    (workflow.match(/actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/g) ?? []).length,
    4,
  );
  assert.equal((workflow.match(/node-version: "22\.22\.3"/g) ?? []).length, 4);
  for (const runner of ["ubuntu-24.04", "macos-15", "windows-2025"]) {
    assert.match(workflow, new RegExp(`runs-on: ${runner.replace(".", "\\.")}`));
  }
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
    const bareLf = bytes.findIndex((byte, index) => byte === 0x0a && bytes[index - 1] !== 0x0d);
    assert.equal(bareLf, -1, `${path} must not contain bare LF line endings`);
  }
});
