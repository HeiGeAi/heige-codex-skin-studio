import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { packageSkill } from "../scripts/package-skill.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const skillRoot = new URL("../skill/heige-codex-skin-studio/", import.meta.url);
const fixedEpoch = 1_704_067_200;

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function gitStatus() {
  const { stdout } = await execFileAsync("git", ["status", "--short"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return stdout;
}

function centralDirectory(buffer) {
  let end = buffer.length - 22;
  const minimum = Math.max(0, buffer.length - 65_557);
  while (end >= minimum && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < minimum) throw new Error("ZIP EOCD not found");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "central directory signature");
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const dosTime = buffer.readUInt16LE(offset + 12);
    const dosDate = buffer.readUInt16LE(offset + 14);
    const nameStart = offset + 46;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const extra = buffer.subarray(nameStart + nameLength, nameStart + nameLength + extraLength);
    let unixMtime = null;
    for (let cursor = 0; cursor + 4 <= extra.length;) {
      const id = extra.readUInt16LE(cursor);
      const size = extra.readUInt16LE(cursor + 2);
      if (cursor + 4 + size > extra.length) throw new Error(`truncated extra field: ${name}`);
      if (id === 0x5455 && size >= 5 && (extra[cursor + 4] & 1) === 1) {
        unixMtime = extra.readUInt32LE(cursor + 5);
      }
      cursor += 4 + size;
    }
    entries.push({
      name,
      mode: (externalAttributes >>> 16) & 0o777,
      dosTime,
      dosDate,
      unixMtime,
    });
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function zipEntries(path) {
  return centralDirectory(await readFile(path));
}

async function readZipText(path, entry) {
  const { stdout } = await execFileAsync("/usr/bin/unzip", ["-p", path, entry], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

test("keeps the reusable skill free of author paths", async () => {
  const skill = await readFile(new URL("SKILL.md", skillRoot), "utf8");
  assert.match(skill, /^---\nname: heige-codex-skin-studio\n/);
  assert.doesNotMatch(skill, /\/Users\/blakexu/);
});

test("pins the extensionless packaged license to LF checkouts", async () => {
  const { stdout } = await execFileAsync("git", [
    "check-attr",
    "text",
    "eol",
    "--",
    "LICENSE",
  ], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.match(stdout, /^LICENSE: text: set\r?\nLICENSE: eol: lf\r?\n$/);
});

test("two allowlisted builds are byte-identical and do not touch tracked output", async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), "heige-package-test-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const beforeStatus = await gitStatus();
  const first = join(outputRoot, "first.skill");
  const second = join(outputRoot, "second.skill");
  await packageSkill(first, { sourceDateEpoch: fixedEpoch });
  await packageSkill(second, { sourceDateEpoch: fixedEpoch });
  assert.equal(await sha256(first), await sha256(second));
  assert.equal(await gitStatus(), beforeStatus);
});

test("allowlisted builds are byte-identical across host timezones", async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), "heige-package-timezone-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const script = join(repoRoot, "scripts/package-skill.mjs");
  const utc = join(outputRoot, "utc.skill");
  const shanghai = join(outputRoot, "shanghai.skill");
  for (const [timezone, output] of [["UTC", utc], ["Asia/Shanghai", shanghai]]) {
    await execFileAsync(process.execPath, [
      script,
      "--output", output,
      "--source-date-epoch", String(fixedEpoch),
    ], { env: { ...process.env, TZ: timezone } });
  }
  assert.equal(await sha256(utc), await sha256(shanghai));
});

test("packager rejects an untracked file inside a recursive release root", async (t) => {
  const fixtureAlias = await mkdtemp(join(tmpdir(), "heige-package-untracked-"));
  const fixture = await realpath(fixtureAlias);
  const outputRoot = await mkdtemp(join(tmpdir(), "heige-package-untracked-output-"));
  const candidate = join(outputRoot, "candidate.skill");
  t.after(() => rm(fixtureAlias, { recursive: true, force: true }));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  await mkdir(join(fixture, "scripts"), { recursive: true });
  await mkdir(join(fixture, "payload"), { recursive: true });
  await mkdir(join(fixture, "output"), { recursive: true });
  await symlink(join(repoRoot, "node_modules"), join(fixture, "node_modules"), "dir");
  await copyFile(join(repoRoot, "scripts/package-skill.mjs"), join(fixture, "scripts/package-skill.mjs"));
  await writeFile(join(fixture, "scripts/skill-package-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    entries: [{ source: "payload", destination: "payload", recursive: true, exclude: [] }],
  })}\n`);
  await writeFile(join(fixture, "package.json"), `${JSON.stringify({
    name: "heige-package-fixture",
    version: "1.0.0",
    type: "module",
    engines: { node: ">=22" },
    bin: { "heige-codex-skin": "payload/tracked.txt" },
    scripts: {},
  })}\n`);
  await writeFile(join(fixture, "payload/tracked.txt"), "tracked\n");
  await execFileAsync("git", ["init", "--quiet"], { cwd: fixture });
  await execFileAsync("git", ["add", "package.json", "scripts", "payload/tracked.txt"], { cwd: fixture });
  await writeFile(join(fixture, "payload/local-secret.txt"), "must not ship\n");
  const { stdout: tracked } = await execFileAsync("git", ["ls-files"], { cwd: fixture, encoding: "utf8" });
  assert.match(tracked, /^payload\/tracked\.txt$/m);
  assert.doesNotMatch(tracked, /local-secret/);

  let failure = null;
  try {
    await execFileAsync(process.execPath, [
      join(fixture, "scripts/package-skill.mjs"),
      "--output", candidate,
      "--source-date-epoch", String(fixedEpoch),
    ]);
  } catch (error) {
    failure = error;
  }
  if (failure === null) {
    const { stdout } = await execFileAsync("/usr/bin/unzip", [
      "-Z1", candidate,
    ], { encoding: "utf8" });
    assert.fail(`packager accepted an untracked recursive source:\n${stdout}`);
  }
  assert.match(String(failure.stderr ?? failure.message), /Git.*tracked|Git.*跟踪|not.*tracked|package source/i);
});

test("archive is a strict runtime allowlist with fixed metadata", async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), "heige-package-allowlist-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const archive = join(outputRoot, "candidate.skill");
  await packageSkill(archive, { sourceDateEpoch: fixedEpoch });
  const entries = await zipEntries(archive);
  const names = entries.map(({ name }) => name);
  assert.deepEqual(names, [...names].sort(), "central directory must be lexicographically ordered");
  assert.equal(names.some((name) => name.endsWith("/")), false, "archive has no directory entries");
  for (const required of [
    "heige-codex-skin-studio/LICENSE",
    "heige-codex-skin-studio/NOTICE",
    "heige-codex-skin-studio/SECURITY.md",
    "heige-codex-skin-studio/ASSET_PROVENANCE.md",
    "heige-codex-skin-studio/SKILL.md",
    "heige-codex-skin-studio/README.md",
    "heige-codex-skin-studio/payload/src/cli.mjs",
    "heige-codex-skin-studio/payload/src/update-check.mjs",
    "heige-codex-skin-studio/payload/src/lifecycle-helper.mjs",
    "heige-codex-skin-studio/payload/src/macos-launcher.mjs",
    "heige-codex-skin-studio/payload/src/theme-center-style.mjs",
    "heige-codex-skin-studio/payload/scripts/enable-skin.command",
    "heige-codex-skin-studio/payload/scripts/resume.command",
    "heige-codex-skin-studio/payload/scripts/windows/install.bat",
    "heige-codex-skin-studio/payload/scripts/windows/install.ps1",
    "heige-codex-skin-studio/payload/scripts/windows/controller.ps1",
    "heige-codex-skin-studio/payload/scripts/windows/restore.ps1",
    "heige-codex-skin-studio/payload/scripts/windows/lib/entrypoints.ps1",
    "heige-codex-skin-studio/payload/scripts/windows/lib/scheduled-task.ps1",
    "heige-codex-skin-studio/payload/package.json",
  ]) assert.ok(names.includes(required), required);
  assert.equal(
    names.some((name) => /\.before-|reports\/|package-skill|check-asset-provenance|sync-llms|update-release-hash|\.git\/|node_modules\/|test\//.test(name)),
    false,
  );
  const executableArchiveEntry = (name) => /\.(?:command|zsh)$/.test(name);
  for (const entry of entries) {
    assert.equal(entry.unixMtime, fixedEpoch, `fixed UTC mtime: ${entry.name}`);
    assert.equal(entry.dosTime, 0, `fixed UTC DOS time: ${entry.name}`);
    assert.equal(entry.dosDate, 0x5821, `fixed UTC DOS date: ${entry.name}`);
    assert.equal(
      entry.mode,
      executableArchiveEntry(entry.name) ? 0o755 : 0o644,
      `fixed mode: ${entry.name}`,
    );
  }
  assert.equal(
    entries.find(({ name }) => name.endsWith("/payload/scripts/lib/run-cli.zsh"))?.mode,
    0o755,
  );
  const runtimePackage = JSON.parse(await readZipText(
    archive,
    "heige-codex-skin-studio/payload/package.json",
  ));
  assert.equal("devDependencies" in runtimePackage, false);
  assert.equal(JSON.stringify(runtimePackage).includes("happy-dom"), false);
  assert.equal(JSON.stringify(runtimePackage).includes("yazl"), false);
  assert.deepEqual(Object.keys(runtimePackage), ["name", "version", "type", "engines", "bin", "scripts"]);
  const packagedLauncher = await readZipText(
    archive,
    "heige-codex-skin-studio/payload/scripts/apply.command",
  );
  assert.equal(
    packagedLauncher,
    await readFile(join(repoRoot, "scripts/apply.command"), "utf8"),
    "the reusable skill must carry the audited launcher byte-for-byte",
  );
  assert.match(packagedLauncher, /apply "\$\{RESTART_ARGS\[@\]\}" --prefer-stored --port/);
  assert.match(packagedLauncher, /--restart/);
  assert.doesNotMatch(packagedLauncher, /\$\{1:-miku-488137\}/);

  const packagedMacosLauncher = await readZipText(
    archive,
    "heige-codex-skin-studio/payload/src/macos-launcher.mjs",
  );
  assert.equal(
    packagedMacosLauncher,
    await readFile(join(repoRoot, "src/macos-launcher.mjs"), "utf8"),
    "the reusable skill must carry the audited macOS launcher byte-for-byte",
  );
  assert.match(packagedMacosLauncher, /MACOS_LAUNCHER_SCHEMA_VERSION = 2/);
  assert.match(packagedMacosLauncher, /const entrypoint = join\(scripts, "apply\.command"\);/);

  const packagedSkill = await readZipText(
    archive,
    "heige-codex-skin-studio/SKILL.md",
  );
  assert.match(packagedSkill, /只会调用 `apply\.command`/);
  assert.match(packagedSkill, /保持 `persistenceEnabled=false`/);
});

test("CLI requires exact explicit absolute output and epoch arguments", async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), "heige-package-cli-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const script = join(repoRoot, "scripts/package-skill.mjs");
  const output = join(outputRoot, "cli.skill");
  const { stdout } = await execFileAsync(process.execPath, [
    script,
    "--output", output,
    "--source-date-epoch", String(fixedEpoch),
  ], { encoding: "utf8" });
  assert.equal(stdout.trim(), output);
  await access(output);
  for (const args of [
    [],
    ["--output", "relative.skill", "--source-date-epoch", String(fixedEpoch)],
    ["--output", output],
    ["--output", output, "--source-date-epoch", "2147483648"],
    ["--output", output, "--source-date-epoch", String(fixedEpoch), "--extra"],
  ]) {
    await assert.rejects(execFileAsync(process.execPath, [script, ...args]), /output|absolute|epoch|argument|usage/i);
  }
});

test("tracked candidate output needs an explicit release-only override", async () => {
  const tracked = join(repoRoot, "output/heige-codex-skin-studio.skill");
  assert.equal(isAbsolute(tracked), true);
  await assert.rejects(
    packageSkill(tracked, { sourceDateEpoch: fixedEpoch, allowTrackedOutput: false }),
    /tracked|HEIGE_ALLOW_TRACKED_PACKAGE_OUTPUT/,
  );
});

test("packager refuses every other repository-internal output, including parent aliases", async (t) => {
  const aliasRoot = await mkdtemp(join(tmpdir(), "heige-package-output-alias-"));
  t.after(() => rm(aliasRoot, { recursive: true, force: true }));
  const victim = join(repoRoot, "output", `.output-guard-${randomUUID()}.skill`);
  t.after(() => rm(victim, { force: true }));
  await assert.rejects(
    packageSkill(victim, { sourceDateEpoch: fixedEpoch }),
    /仓库根目录/,
  );
  await assert.rejects(access(victim), (error) => error.code === "ENOENT");

  const alias = join(aliasRoot, "repo-output");
  await symlink(join(repoRoot, "output"), alias, "dir");
  const aliasedName = `.aliased-${randomUUID()}.skill`;
  const aliased = join(alias, aliasedName);
  await assert.rejects(
    packageSkill(aliased, { sourceDateEpoch: fixedEpoch }),
    /仓库根目录/,
  );
  await assert.rejects(
    access(join(repoRoot, "output", aliasedName)),
    (error) => error.code === "ENOENT",
  );

  const nestedName = `.nested-${randomUUID()}`;
  await assert.rejects(
    packageSkill(join(alias, nestedName, "child", "candidate.skill"), { sourceDateEpoch: fixedEpoch }),
    /仓库根目录/,
  );
  await assert.rejects(
    access(join(repoRoot, "output", nestedName)),
    (error) => error.code === "ENOENT",
  );
});

test("macOS firmlink aliases cannot bypass repository output authorization", {
  skip: process.platform !== "darwin" || !repoRoot.startsWith("/Users/"),
}, async (t) => {
  const dataAliasRoot = `/System/Volumes/Data${repoRoot}`;
  const [rootInfo, aliasInfo] = await Promise.all([
    lstat(repoRoot, { bigint: true }),
    lstat(dataAliasRoot, { bigint: true }).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
  ]);
  if (aliasInfo === null) {
    t.skip("host does not expose the macOS Data-volume firmlink path");
    return;
  }
  assert.equal(typeof rootInfo.dev, "bigint");
  assert.equal(typeof rootInfo.ino, "bigint");
  if (rootInfo.dev !== aliasInfo.dev || rootInfo.ino !== aliasInfo.ino) {
    t.skip("host does not expose the macOS Data-volume firmlink alias");
    return;
  }
  const artifact = join(repoRoot, "output", "heige-codex-skin-studio.skill");
  const aliasArtifact = join(dataAliasRoot, "output", "heige-codex-skin-studio.skill");
  const before = await sha256(artifact);
  await assert.rejects(
    packageSkill(aliasArtifact, { sourceDateEpoch: fixedEpoch, allowTrackedOutput: false }),
    /tracked|HEIGE_ALLOW_TRACKED_PACKAGE_OUTPUT/,
  );
  assert.equal(await sha256(artifact), before);
});

test("shell wrapper requires output and forwards an explicit epoch", async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), "heige-package-wrapper-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const script = join(repoRoot, "scripts/package-skill.command");
  await assert.rejects(execFileAsync(script, []), (error) => error.code === 64);
  const output = join(outputRoot, "wrapper.skill");
  const { stdout } = await execFileAsync(script, [output, String(fixedEpoch)]);
  assert.equal(stdout.trim(), output);
  assert.equal((await stat(output)).isFile(), true);
});
