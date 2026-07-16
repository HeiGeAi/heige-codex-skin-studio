import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const skillRoot = new URL("../skill/codex-miku-theme/", import.meta.url);

async function text(path) {
  return readFile(new URL(path, skillRoot), "utf8");
}

test("keeps the reusable skill free of author paths", async () => {
  const skill = await text("SKILL.md");

  assert.match(skill, /^---\nname: codex-miku-theme\ndescription: Use when /);
  assert.doesNotMatch(skill, /\/Users\/blakexu/);
});

test("installs the bundled Miku Future custom pet as the selected avatar", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "codex-miku-skill-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const codexRoot = join(home, ".codex");
  const configPath = join(codexRoot, "config.toml");
  await mkdir(codexRoot, { recursive: true });
  await writeFile(configPath, `model = "gpt-5"\n`);

  await execFileAsync(
    fileURLToPath(new URL("scripts/install-pet.command", skillRoot)),
    [],
    { env: { ...process.env, HOME: home } },
  );

  const installedRoot = join(codexRoot, "pets", "miku-future");
  const sourceRoot = new URL("payload/custom-pet/miku-future/", skillRoot);
  assert.deepEqual(
    await readFile(join(installedRoot, "pet.json")),
    await readFile(new URL("pet.json", sourceRoot)),
  );
  assert.deepEqual(
    await readFile(join(installedRoot, "spritesheet.webp")),
    await readFile(new URL("spritesheet.webp", sourceRoot)),
  );
  assert.match(
    await readFile(configPath, "utf8"),
    /^selected-avatar-id = "custom:miku-future"$/m,
  );
});
