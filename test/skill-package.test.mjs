import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const skillRoot = new URL("../skill/codex-miku-theme/", import.meta.url);
const repoRoot = new URL("../", import.meta.url);
const execFileAsync = promisify(execFile);

async function text(path) {
  return readFile(new URL(path, skillRoot), "utf8");
}

test("ships a standard Codex skill with the complete v5 theme payload", async () => {
  const required = [
    "SKILL.md",
    "agents/openai.yaml",
    "scripts/check.command",
    "scripts/install-after-quit.command",
    "scripts/install-now.command",
    "scripts/restore-after-quit.command",
    "scripts/lib/write-launch-agent.zsh",
    "payload/package.json",
    "payload/src/asar.mjs",
    "payload/src/theme-patch.mjs",
    "payload/src/theme.css",
    "payload/assets/miku-full-canvas.png",
    "payload/assets/miku-character.png",
    "payload/assets/miku-sidebar-wash.png",
    "payload/assets/miku-polaroid.png",
    "payload/custom-pet/miku-future/pet.json",
    "payload/custom-pet/miku-future/spritesheet.webp",
    "scripts/install-pet.command",
  ];

  await Promise.all(required.map((path) => access(new URL(path, skillRoot), fsConstants.R_OK)));
});

test("describes precise triggers and keeps the reusable skill free of author paths", async () => {
  const skill = await text("SKILL.md");
  assert.match(skill, /^---\nname: codex-miku-theme\ndescription: Use when /);
  assert.equal((skill.match(/^---$/gm) ?? []).length, 2);
  assert.doesNotMatch(skill.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "", /^compatibility:/m);
  assert.match(skill, /初音未来|Miku/);
  assert.match(skill, /install-after-quit\.command/);
  assert.match(skill, /restore-after-quit\.command/);
  assert.doesNotMatch(skill, /\/Users\/blakexu/);
});

test("ships concise Codex UI metadata without auxiliary Skill documentation", async () => {
  const metadata = await text("agents/openai.yaml");
  assert.match(metadata, /display_name: "Codex 初音未来主题"/);
  assert.match(metadata, /short_description: ".{25,64}"/u);
  assert.match(metadata, /default_prompt: ".*\$codex-miku-theme/);
  await assert.rejects(access(new URL("README.md", skillRoot)), { code: "ENOENT" });
});

test("queued installer waits for Codex to quit and never bypasses compatibility checks", async () => {
  const installer = await text("scripts/install-after-quit.command");
  const restorer = await text("scripts/restore-after-quit.command");
  const runner = await text("scripts/lib/run-after-quit.zsh");
  const writer = await text("scripts/lib/write-launch-agent.zsh");
  assert.match(runner, /ChatGPT\.app\/Contents/);
  assert.match(installer, /"\$NODE_BIN" "\$ROOT\/payload\/src\/theme-patch\.mjs" check/);
  assert.match(installer, /launchctl bootstrap "\$DOMAIN" "\$PLIST_PATH"/);
  assert.match(restorer, /launchctl bootstrap "\$DOMAIN" "\$PLIST_PATH"/);
  assert.doesNotMatch(`${installer}\n${restorer}`, /launchctl submit/);
  assert.match(`${installer}\n${restorer}`, /com\.heigeai\.codex-miku-theme/);
  assert.match(`${installer}\n${restorer}`, /STAGING_ROOT/);
  assert.match(`${installer}\n${restorer}`, /Library\/Application Support\/Codex Miku Theme\/installer/);
  assert.doesNotMatch(`${installer}\n${restorer}`, /nohup/);
  assert.match(`${installer}\n${restorer}`, /"\$LABEL"/);
  assert.match(`${installer}\n${restorer}`, /write-launch-agent\.zsh/);
  assert.match(writer, /plutil -insert RunAtLoad -bool true/);
  assert.match(writer, /plutil -insert KeepAlive -bool false/);
  assert.match(writer, /plutil -insert ProgramArguments -array/);
  assert.match(runner, /LABEL="\$5"/);
  assert.match(runner, /PLIST_PATH="\$6"/);
  assert.match(runner, /trap 'cleanup \$\?' EXIT/);
  assert.match(runner, /trap 'exit 129' HUP/);
  assert.match(runner, /trap 'exit 130' INT/);
  assert.match(runner, /trap 'exit 143' TERM/);
  assert.match(runner, /launchctl bootout "\$DOMAIN\/\$LABEL"/);
  assert.match(runner, /rm -f "\$PLIST_PATH"/);
  assert.match(runner, /run_patch install/);
  assert.match(runner, /run_patch restore/);
  assert.match(runner, /MAX_PATCH_ATTEMPTS=300/);
  assert.match(runner, /Fully quit Codex with Command\+Q/);
  assert.match(runner, /output=.*"\$NODE_BIN" "\$PATCHER" "\$operation"/);
  assert.match(runner, /"\$output" != \*"Fully quit Codex with Command\+Q"\*/);
  assert.doesNotMatch(runner, /if \/usr\/bin\/pgrep[\s\S]+retrying \$operation/);
  assert.doesNotMatch(runner, /local status=/);
  assert.match(runner, /return "\$exit_code"/);
  assert.match(runner, /sleep 0\.2/);
  const cleanupBody = runner.match(/cleanup\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const openBranches = cleanupBody.match(
    /if \(\( exit_code == 0 \)\); then([\s\S]*?)else([\s\S]*?)fi/,
  );
  assert.match(openBranches?.[1] ?? "", /open \/Applications\/ChatGPT\.app/);
  assert.doesNotMatch(
    openBranches?.[2] ?? "",
    /open \/Applications\/ChatGPT\.app/,
    "a failed installer must leave Codex closed instead of creating a reconnect loop",
  );
  assert.doesNotMatch(`${installer}\n${runner}`, /killall|pkill|codesign/);
});

test("Skill never terminates an active response stream on the user's behalf", async () => {
  const skill = await text("SKILL.md");
  assert.match(skill, /Never quit Codex on the user's behalf/);
  assert.match(skill, /current response is complete/);
  assert.match(skill, /ask the user to press `Command \+ Q`/);
});

test(
  "generated LaunchAgent is explicit one-shot and removes its label after completion",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "codex-miku-launch-agent-"));
    const label = `com.heigeai.codex-miku-theme.test.${process.pid}.${Date.now()}`;
    const domain = `gui/${process.getuid()}`;
    const plist = join(root, `${label}.plist`);
    const runner = join(root, "test runner.zsh");
    const log = join(root, "runner.log");
    const writer = fileURLToPath(new URL("scripts/lib/write-launch-agent.zsh", skillRoot));

    t.after(async () => {
      await execFileAsync("/bin/launchctl", ["bootout", `${domain}/${label}`]).catch(() => {});
      await rm(root, { force: true, recursive: true });
    });
    await writeFile(
      runner,
      `#!/bin/zsh\nset -euo pipefail\nlabel="$5"\nplist="$6"\n/bin/rm -f "$plist"\n/bin/launchctl bootout "gui/$(/usr/bin/id -u)/$label" >/dev/null 2>&1 || true\n`,
    );
    await chmod(runner, 0o755);

    await execFileAsync("/bin/zsh", [
      writer,
      plist,
      label,
      runner,
      "restore",
      join(root, "unused-patcher.mjs"),
      log,
      "/usr/bin/true",
    ]);

    const raw = async (key) =>
      (await execFileAsync("/usr/bin/plutil", ["-extract", key, "raw", plist])).stdout.trim();
    assert.equal(await raw("Label"), label);
    assert.equal(await raw("RunAtLoad"), "true");
    assert.equal(await raw("KeepAlive"), "false");
    assert.equal(await raw("ProgramArguments.0"), "/bin/zsh");
    assert.equal(await raw("ProgramArguments.1"), runner);

    await execFileAsync("/bin/launchctl", ["bootstrap", domain, plist]);
    let loaded = true;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await delay(100);
      loaded = await execFileAsync("/bin/launchctl", ["print", `${domain}/${label}`])
        .then(() => true)
        .catch(() => false);
      if (!loaded) break;
    }

    assert.equal(loaded, false, "completed one-shot LaunchAgent label must be unloaded");
    await assert.rejects(access(plist), { code: "ENOENT" });
  },
);

test("pet installer selects the independent Miku Future avatar", async () => {
  const installer = await text("scripts/install-pet.command");
  assert.match(installer, /custom:miku-future/);
  assert.match(installer, /\.codex\/pets\/miku-future/);
});

test("pet installer appends the selection when config has no avatar key", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "codex-miku-pet-"));
  t.after(() => rm(home, { force: true, recursive: true }));
  const codexDir = join(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  await writeFile(join(codexDir, "config.toml"), 'model = "gpt-5"\n');

  const { stdout } = await execFileAsync(
    "/bin/zsh",
    [fileURLToPath(new URL("scripts/install-pet.command", skillRoot))],
    { env: { ...process.env, HOME: home } },
  );
  const config = await readFile(join(codexDir, "config.toml"), "utf8");
  const files = await readdir(codexDir);

  assert.match(config, /^model = "gpt-5"\n(?:\n)?selected-avatar-id = "custom:miku-future"\n$/);
  assert.equal((config.match(/^selected-avatar-id = /gm) ?? []).length, 1);
  assert.ok(files.some((name) => name.startsWith("config.toml.bak-miku-pet-")));
  assert.match(stdout, /已追加并设为当前宠物/);
});

test("pet installer replaces an existing avatar key and reports the update", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "codex-miku-pet-"));
  t.after(() => rm(home, { force: true, recursive: true }));
  const codexDir = join(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  await writeFile(join(codexDir, "config.toml"), 'selected-avatar-id = "custom:old"\n');

  const { stdout } = await execFileAsync(
    "/bin/zsh",
    [fileURLToPath(new URL("scripts/install-pet.command", skillRoot))],
    { env: { ...process.env, HOME: home } },
  );
  const config = await readFile(join(codexDir, "config.toml"), "utf8");

  assert.equal(config, 'selected-avatar-id = "custom:miku-future"\n');
  assert.match(stdout, /已更新并设为当前宠物/);
});

test("pet installer leaves the already selected avatar unchanged and reports truthfully", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "codex-miku-pet-"));
  t.after(() => rm(home, { force: true, recursive: true }));
  const codexDir = join(home, ".codex");
  await mkdir(codexDir, { recursive: true });
  const original = 'selected-avatar-id = "custom:miku-future"\n';
  await writeFile(join(codexDir, "config.toml"), original);

  const { stdout } = await execFileAsync(
    "/bin/zsh",
    [fileURLToPath(new URL("scripts/install-pet.command", skillRoot))],
    { env: { ...process.env, HOME: home } },
  );
  const config = await readFile(join(codexDir, "config.toml"), "utf8");
  const files = await readdir(codexDir);

  assert.equal(config, original);
  assert.equal(files.some((name) => name.startsWith("config.toml.bak-miku-pet-")), false);
  assert.match(stdout, /已经是当前宠物，无需修改/);
  assert.doesNotMatch(stdout, /已更新|已追加/);
});

test("all distributed pet installers handle missing and existing avatar keys", async () => {
  const paths = [
    new URL("scripts/install-pet.command", repoRoot),
    new URL("scripts/install-pet.command", skillRoot),
    new URL("custom-pet/install.command", repoRoot),
  ];

  for (const path of paths) {
    const installer = await readFile(path, "utf8");
    assert.match(installer, /mkdir -p "\$HOME\/\.codex"/);
    assert.match(installer, /grep -q '\^selected-avatar-id = '/);
    assert.match(installer, /printf .*selected-avatar-id = \\"custom:miku-future\\"/);
    assert.match(installer, /已追加并设为当前宠物/);
    assert.match(installer, /已更新并设为当前宠物/);
    assert.match(installer, /已经是当前宠物，无需修改/);
  }
});

test("bundled theme stays self-contained and includes the full-canvas marker", async () => {
  const css = await text("payload/src/theme.css");
  const patcher = await text("payload/src/theme-patch.mjs");
  assert.match(css, /CODEX_MIKU_THEME v5 488137 SIDEBAR/);
  assert.match(patcher, /CODEX_MIKU_THEME v5 488137 SIDEBAR/);
  assert.doesNotMatch(css, /https?:\/\//i);
  assert.doesNotMatch(patcher, /\/Users\/blakexu/);
});
