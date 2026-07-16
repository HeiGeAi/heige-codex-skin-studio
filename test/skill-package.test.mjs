import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const skillRoot = new URL("../skill/heige-codex-skin-studio/", import.meta.url);

test("keeps the reusable skill free of author paths", async () => {
  const skill = await readFile(new URL("SKILL.md", skillRoot), "utf8");

  assert.match(skill, /^---\nname: heige-codex-skin-studio\n/);
  assert.doesNotMatch(skill, /\/Users\/blakexu/);
});

test("packages only to a temporary output and installs a self-contained distribution", async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), "heige-skill-output-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));

  const tracked = join(repoRoot, "output/heige-codex-skin-studio.skill");
  const trackedBytes = await readFile(tracked);
  const trackedMode = (await stat(tracked)).mode;
  t.after(async () => {
    const currentBytes = await readFile(tracked).catch(() => null);
    const currentMode = await stat(tracked).then(
      ({ mode }) => mode,
      () => null,
    );
    if (
      currentBytes === null ||
      !currentBytes.equals(trackedBytes) ||
      currentMode !== trackedMode
    ) {
      await writeFile(tracked, trackedBytes);
      await chmod(tracked, trackedMode);
    }
  });

  const trackedSha256 = createHash("sha256").update(trackedBytes).digest("hex");
  const archive = join(outputRoot, "smoke.skill");
  const packageScript = join(repoRoot, "scripts/package-skill.command");
  const home = await realpath(await mkdtemp(join(tmpdir(), "heige-skin-skill-")));
  t.after(() => rm(home, { recursive: true, force: true }));

  await assert.rejects(
    execFileAsync(packageScript, [], {
      env: { ...process.env, HEIGE_SKILL_OUTPUT: "" },
    }),
    (error) => {
      assert.match(String(error.stderr), /HEIGE_SKILL_OUTPUT must not be empty/);
      return true;
    },
  );

  await execFileAsync(packageScript, [], {
    env: { ...process.env, HEIGE_SKILL_OUTPUT: archive },
  });

  const actualTrackedSha256 = createHash("sha256")
    .update(await readFile(tracked))
    .digest("hex");
  const temporaryArchiveExists = await access(archive).then(
    () => true,
    () => false,
  );
  assert.deepEqual(
    {
      trackedSha256: actualTrackedSha256,
      temporaryArchiveExists,
    },
    {
      trackedSha256,
      temporaryArchiveExists: true,
    },
  );

  await execFileAsync("/usr/bin/unzip", ["-q", archive, "-d", home]);

  const unpacked = join(home, "heige-codex-skin-studio");
  await execFileAsync(join(unpacked, "scripts/install.command"), [], {
    env: { ...process.env, HOME: home, HEIGE_SKIP_APPLY: "1" },
  });

  const installed = join(home, ".codex/heige-codex-skin-studio");
  for (const relative of [
    "src/cli.mjs",
    "themes/miku-488137/theme.json",
    "custom-pet/install.command",
    "scripts/apply.command",
    "scripts/pause.command",
    "scripts/enable-persist.command",
    "scripts/disable-persist.command",
    "scripts/lib/skin-watchdog.zsh",
    "scripts/windows/apply.ps1",
    "scripts/windows/apply.bat",
    "scripts/windows/install.ps1",
    "scripts/windows/lib/common.ps1",
  ]) {
    await access(join(installed, relative));
  }

  const { stdout } = await execFileAsync(
    process.execPath,
    [join(installed, "src/cli.mjs"), "list"],
    { env: { ...process.env, HOME: home } },
  );
  const themes = JSON.parse(stdout);
  assert.ok(
    themes.some((theme) => theme.id === "miku-488137"),
    "installed copy must ship the Miku preset",
  );
});
