import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { listThemes } from "../src/theme-store.mjs";
import { renderThemeCount } from "../scripts/sync-derived.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const execFileAsync = promisify(execFile);
const disposition = "docs/release/2026-07-16-audit-hardening-disposition.md";
const artifact = "output/heige-codex-skin-studio.skill";
const derived = ["README.md", "README.en.md", "docs/manual.md", "llms-full.txt", artifact, disposition];

for (const path of derived.slice(0, 3)) {
  test(`theme count updates only the marked number in ${path}`, async () => {
    const original = await readFile(join(root, path), "utf8");
    const updated = renderThemeCount(path, original, 987);
    assert.notEqual(updated, original);
    assert.equal(renderThemeCount(path, updated, 987), updated);
    assert.equal(renderThemeCount(path, updated, (await listThemes({ roots: [join(root, "themes")] })).length), original);
  });
}

test("theme count rejects missing or duplicate anchors before updating", async () => {
  const path = "README.md";
  const text = await readFile(join(root, path), "utf8");
  assert.throws(() => renderThemeCount(path, text.replace("heige-bundled-theme-count", "removed"), 14), /恰好包含一个/);
  assert.throws(() => renderThemeCount(path, `${text}\n${text}`, 14), /恰好包含一个/);
});

async function fixture(t) {
  const staging = join(root, ".staging");
  await mkdir(staging, { recursive: true });
  const directory = await mkdtemp(join(staging, "sync-derived-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const subdir of ["scripts", "docs/release", "output", "themes/broken", "themes/incomplete"]) {
    await mkdir(join(directory, subdir), { recursive: true });
  }
  for (const path of [
    "package.json", "README.md", "README.en.md", "docs/manual.md", "llms.txt", disposition,
    "scripts/sync-derived.mjs", "scripts/sync-llms.mjs", "scripts/package-skill.mjs",
    "scripts/update-release-hash.mjs",
  ]) await cp(join(root, path), join(directory, path));
  await cp(join(root, "src"), join(directory, "src"), { recursive: true });
  await cp(join(root, "themes/caishen-readable"), join(directory, "themes/caishen-readable"), { recursive: true });
  await writeFile(join(directory, "themes/broken/theme.json"), "{broken");
  await writeFile(join(directory, "themes/incomplete/theme.json"), JSON.stringify({ id: "incomplete" }));
  await writeFile(join(directory, "scripts/skill-package-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    entries: [{ source: "themes", destination: "payload/themes", recursive: true, exclude: [] }],
  }));
  await execFileAsync("git", ["init", "--quiet"], { cwd: directory });
  await execFileAsync("git", ["add", "."], { cwd: directory });
  return directory;
}

async function run(directory, ...args) {
  return execFileAsync(process.execPath, ["scripts/sync-derived.mjs", ...args], { cwd: directory });
}

async function snapshot(directory) {
  return Promise.all(derived.map(async (path) => {
    const fullPath = join(directory, path);
    return [path, createHash("sha256").update(await readFile(fullPath)).digest("hex"), (await stat(fullPath)).mtimeMs];
  }));
}

test("sync command counts listed themes and is idempotent across all derived outputs", async (t) => {
  const directory = await fixture(t);
  const { stdout } = await run(directory);
  assert.match(stdout, /1 个内置主题/);
  assert.match(await readFile(join(directory, "README.md"), "utf8"), /## 内置 1 套主题/);
  assert.match(await readFile(join(directory, "README.en.md"), "utf8"), /1 built-in presets/);
  assert.match(await readFile(join(directory, "docs/manual.md"), "utf8"), /-->1 个/);
  const first = await snapshot(directory);
  await run(directory);
  assert.deepEqual(await snapshot(directory), first, "a second sync must not rewrite even unchanged files");
  await run(directory, "--check");
  assert.deepEqual(await snapshot(directory), first, "check must not modify files or mtimes");
  assert.deepEqual(await readdir(join(directory, "output")), ["heige-codex-skin-studio.skill"]);
});

test("check detects and sync repairs each kind of derived drift without check writes", async (t) => {
  const directory = await fixture(t);
  await run(directory);
  for (const path of derived) {
    await t.test(path, async () => {
      const fullPath = join(directory, path);
      const previous = await readFile(fullPath);
      if (path === artifact) {
        await writeFile(fullPath, "stale package");
      } else if (path === disposition) {
        await writeFile(fullPath, previous.toString().replace(/(Package SHA-256: )[a-f0-9]{64}/, `$1${"0".repeat(64)}`));
      } else if (path === "llms-full.txt") {
        await writeFile(fullPath, "stale llms\n");
      } else {
        await writeFile(fullPath, renderThemeCount(path, previous.toString(), 999));
      }
      const drifted = await snapshot(directory);
      await assert.rejects(run(directory, "--check"), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /npm run sync/);
        return true;
      });
      assert.deepEqual(await snapshot(directory), drifted);
      assert.deepEqual(await readdir(join(directory, "output")), ["heige-codex-skin-studio.skill"]);
      await run(directory);
      assert.deepEqual(await readFile(fullPath), previous);
      await run(directory, "--check");
    });
  }
});

test("new tracked theme changes counts and package hash through the real sync command", async (t) => {
  const directory = await fixture(t);
  await run(directory);
  const previous = await readFile(join(directory, artifact));
  const newTheme = join(directory, "themes/contributor-theme");
  await cp(join(directory, "themes/caishen-readable"), newTheme, { recursive: true });
  const manifest = JSON.parse(await readFile(join(newTheme, "theme.json"), "utf8"));
  await writeFile(join(newTheme, "theme.json"), JSON.stringify({ ...manifest, id: "contributor-theme", name: "投稿主题" }));
  await execFileAsync("git", ["add", "themes/contributor-theme"], { cwd: directory });
  await assert.rejects(run(directory, "--check"), /npm run sync/);
  await run(directory);
  assert.match(await readFile(join(directory, "README.md"), "utf8"), /## 内置 2 套主题/);
  const current = await readFile(join(directory, artifact));
  assert.equal(current.equals(previous), false);
  const hash = createHash("sha256").update(current).digest("hex");
  assert.match(await readFile(join(directory, disposition), "utf8"), new RegExp(`Package SHA-256: ${hash}`));
  await run(directory, "--check");
});
