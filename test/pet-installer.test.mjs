import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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

import { runCli } from "../src/cli.mjs";
import { installPet, setSelectedPet } from "../src/pet-installer.mjs";

const execFileAsync = promisify(execFile);
const sourceRoot = fileURLToPath(new URL("../custom-pet/miku-future", import.meta.url));
const cliPath = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

async function fixture(t, { config, configMode = 0o600 } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "heige-pet-installer-")));
  const home = join(root, "home");
  const codexRoot = join(home, ".codex");
  const configPath = join(codexRoot, "config.toml");
  const targetRoot = join(codexRoot, "pets/miku-future");
  await mkdir(codexRoot, { recursive: true });
  if (config !== undefined) {
    await writeFile(configPath, config, { mode: configMode });
    await chmod(configPath, configMode);
  }
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, home, codexRoot, configPath, targetRoot };
}

async function backupPaths(codexRoot) {
  return (await readdir(codexRoot))
    .filter((name) => name.startsWith("config.toml.bak-miku-pet-"))
    .sort();
}

test("missing config gets one desktop section and selected pet", async (t) => {
  const paths = await fixture(t);

  const result = await installPet({ sourceRoot, home: paths.home });
  const config = await readFile(paths.configPath, "utf8");

  assert.equal((config.match(/^\[desktop\]$/gm) ?? []).length, 1);
  assert.match(config, /^selected-avatar-id = "custom:miku-future"$/m);
  assert.equal((await stat(paths.configPath)).mode & 0o777, 0o600);
  assert.deepEqual(await backupPaths(paths.codexRoot), []);
  assert.equal(result.configChanged, true);
  assert.equal(result.restartRequired, true);
  assert.equal(result.effectivePetId, "custom:miku-future");
  assert.match(result.nextAction, /重启 Codex/);
});

test("setSelectedPet adds a missing desktop section without changing other keys", () => {
  const original = 'model = "gpt-5"\nselected-avatar-id = "root-value"\n';
  const result = setSelectedPet(original, "custom:miku-future");

  assert.equal(
    result,
    'model = "gpt-5"\nselected-avatar-id = "root-value"\n\n[desktop]\nselected-avatar-id = "custom:miku-future"\n',
  );
});

test("existing desktop section is updated before the next section", () => {
  const result = setSelectedPet(
    '[desktop]\nfoo = true\n[projects."x"]\ntrust = true\n',
    "custom:miku-future",
  );

  assert.equal(
    result,
    '[desktop]\nfoo = true\nselected-avatar-id = "custom:miku-future"\n[projects."x"]\ntrust = true\n',
  );
});

test("only the selected-avatar-id inside desktop is replaced", () => {
  const result = setSelectedPet(
    'selected-avatar-id = "root"\n[desktop]\nselected-avatar-id = "custom:old"\n[projects."x"]\nselected-avatar-id = "project"\n',
    "custom:miku-future",
  );

  assert.equal(
    result,
    'selected-avatar-id = "root"\n[desktop]\nselected-avatar-id = "custom:miku-future"\n[projects."x"]\nselected-avatar-id = "project"\n',
  );
});

test("already-selected config and installed files make repeated installation idempotent", async (t) => {
  const paths = await fixture(t);
  await installPet({ sourceRoot, home: paths.home });
  const before = await lstat(paths.targetRoot);

  const result = await installPet({ sourceRoot, home: paths.home });
  const after = await lstat(paths.targetRoot);

  assert.equal(result.configChanged, false);
  assert.equal(result.petChanged, false);
  assert.equal(result.restartRequired, false);
  assert.equal(result.effectivePetId, "custom:miku-future");
  assert.equal(result.nextAction, null);
  assert.equal(after.ino, before.ino, "an identical pet directory must not be replaced");
  assert.deepEqual(await backupPaths(paths.codexRoot), []);
  assert.deepEqual(
    (await readdir(join(paths.codexRoot, "pets"))).sort(),
    ["miku-future"],
    "temporary and retired siblings must be cleaned",
  );
});

test("only a config content change creates one timestamped backup and preserves mode", async (t) => {
  const paths = await fixture(t, {
    config: '[desktop]\nselected-avatar-id = "custom:old"\n[projects."x"]\ntrust = true\n',
    configMode: 0o640,
  });
  await mkdir(paths.targetRoot, { recursive: true });
  await cp(join(sourceRoot, "pet.json"), join(paths.targetRoot, "pet.json"));
  await cp(join(sourceRoot, "spritesheet.webp"), join(paths.targetRoot, "spritesheet.webp"));
  let observedTemporaryMode = null;

  const result = await installPet({
    sourceRoot,
    home: paths.home,
    hooks: {
      afterConfigTempWrite: async ({ path }) => {
        observedTemporaryMode = (await stat(path)).mode & 0o777;
      },
    },
  });

  const backups = await backupPaths(paths.codexRoot);
  assert.equal(result.petChanged, false);
  assert.equal(result.configChanged, true);
  assert.equal(observedTemporaryMode, 0o600, "config temp must stay private while being written");
  assert.equal(backups.length, 1);
  assert.equal(
    await readFile(join(paths.codexRoot, backups[0]), "utf8"),
    '[desktop]\nselected-avatar-id = "custom:old"\n[projects."x"]\ntrust = true\n',
  );
  assert.equal((await stat(paths.configPath)).mode & 0o777, 0o640);
  assert.equal(
    await readFile(paths.configPath, "utf8"),
    '[desktop]\nselected-avatar-id = "custom:miku-future"\n[projects."x"]\ntrust = true\n',
  );
});

test("copied manifest and spritesheet exactly match the validated source", async (t) => {
  const paths = await fixture(t);

  await installPet({ sourceRoot, home: paths.home });

  assert.deepEqual(
    await readFile(join(paths.targetRoot, "pet.json")),
    await readFile(join(sourceRoot, "pet.json")),
  );
  assert.deepEqual(
    await readFile(join(paths.targetRoot, "spritesheet.webp")),
    await readFile(join(sourceRoot, "spritesheet.webp")),
  );
});

test("rejects a source manifest that is not the exact v2 pet shape", async (t) => {
  const paths = await fixture(t);
  const badSource = join(paths.root, "bad-source");
  await mkdir(badSource);
  const manifest = JSON.parse(await readFile(join(sourceRoot, "pet.json"), "utf8"));
  manifest.unexpected = true;
  await writeFile(join(badSource, "pet.json"), JSON.stringify(manifest));
  await cp(join(sourceRoot, "spritesheet.webp"), join(badSource, "spritesheet.webp"));

  await assert.rejects(
    installPet({ sourceRoot: badSource, home: paths.home }),
    /宠物源校验失败.*pet\.json.*精确字段/,
  );
  await assert.rejects(lstat(paths.targetRoot), { code: "ENOENT" });
});

for (const fault of [
  { hook: "beforeCopy", message: "宠物复制失败", error: "copy fault" },
  { hook: "beforePetRename", message: "宠物目录替换失败", error: "rename fault" },
  { hook: "beforeConfigRename", message: "配置写入失败", error: "config fault" },
]) {
  test(`${fault.hook} failure rejects before success and rolls back`, async (t) => {
    const paths = await fixture(t, { config: 'model = "gpt-5"\n' });
    const hooks = {
      [fault.hook]: async () => {
        throw new Error(fault.error);
      },
    };

    await assert.rejects(
      installPet({ sourceRoot, home: paths.home, hooks }),
      new RegExp(`${fault.message}.*${fault.error}`),
    );
    assert.equal(await readFile(paths.configPath, "utf8"), 'model = "gpt-5"\n');
    await assert.rejects(lstat(paths.targetRoot), { code: "ENOENT" });
  });
}

test("config preparation failure removes private temp and rolls the pet back", async (t) => {
  const paths = await fixture(t, { config: 'model = "gpt-5"\n' });

  await assert.rejects(
    installPet({
      sourceRoot,
      home: paths.home,
      hooks: {
        afterConfigTempWrite: async () => {
          throw new Error("temp fsync fault");
        },
      },
    }),
    /配置写入失败.*temp fsync fault/,
  );

  assert.equal(await readFile(paths.configPath, "utf8"), 'model = "gpt-5"\n');
  await assert.rejects(lstat(paths.targetRoot), { code: "ENOENT" });
  assert.deepEqual(
    (await readdir(paths.codexRoot)).sort(),
    ["config.toml", "pets"],
    "a failed config preparation must not leave a temp or backup",
  );
});

test("final verification failure rejects and restores files plus config", async (t) => {
  const original = '[desktop]\nselected-avatar-id = "custom:old"\n';
  const paths = await fixture(t, { config: original });

  await assert.rejects(
    installPet({
      sourceRoot,
      home: paths.home,
      hooks: {
        beforeFinalVerify: async ({ targetRoot }) => {
          await writeFile(join(targetRoot, "pet.json"), "{}\n");
        },
      },
    }),
    /最终验证失败/,
  );

  assert.equal(await readFile(paths.configPath, "utf8"), original);
  await assert.rejects(lstat(paths.targetRoot), { code: "ENOENT" });
});

test("install-pet CLI delegates once and direct failures never print success JSON", async (t) => {
  const paths = await fixture(t);
  const calls = [];
  const delegated = await runCli(
    ["install-pet", "--source", "/bundle/custom-pet/example"],
    {
      home: paths.home,
      installPet: async (input) => {
        calls.push(input);
        return { installed: true, petId: "example" };
      },
    },
  );
  assert.deepEqual(delegated, { installed: true, petId: "example" });
  assert.deepEqual(calls, [{ sourceRoot: "/bundle/custom-pet/example", home: paths.home }]);

  const missing = join(paths.root, "missing-source");
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "install-pet", "--source", missing], {
      env: { ...process.env, HOME: paths.home },
    }),
    (error) => {
      assert.equal(String(error.stdout), "", "a failed installer must not emit success JSON");
      assert.match(String(error.stderr), /宠物源校验失败/);
      return true;
    },
  );
});
