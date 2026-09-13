import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  acquireInstallTreeParticipantLock,
  finalizeInstallTree,
  INSTALL_MARKER_NAME,
  MAX_INSTALL_SOURCE_FILE_BYTES,
  MAX_INSTALL_SOURCE_TREE_DEPTH,
  MAX_INSTALL_SOURCE_TREE_BYTES,
  MAX_INSTALL_SOURCE_TREE_ENTRIES,
  installTree,
  prepareInstallTree,
  publishInstallTree,
  recoverInstallTree,
  rollbackInstallTree,
} from "../src/install-transaction.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const installModule = fileURLToPath(new URL("../src/install-transaction.mjs", import.meta.url));
const option1DeprecatedEnableEntrypoint = join(repoRoot, "scripts", "enable-persist.command");
const PUBLIC_MARKERLESS_COMMIT = "79b03dccf246134ff3b28e9d9afc7751fee8812b";

async function sourceFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "heige-install-source-")));
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "home", ".codex", "heige-codex-skin-studio");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(sourceRoot, "package.json"), `${JSON.stringify({
    name: "heige-codex-skin-studio",
    version: "1.0.0",
    type: "module",
    bin: { "heige-codex-skin": "src/cli.mjs" },
  })}\n`);
  for (const directory of ["src", "themes", "scripts", "custom-pet"]) {
    await mkdir(join(sourceRoot, directory), { recursive: true });
    await writeFile(join(sourceRoot, directory, `${directory}.txt`), `${directory}\n`);
  }
  await writeFile(join(sourceRoot, "src", "cli.mjs"), "#!/usr/bin/env node\n", { mode: 0o755 });
  await writeFile(join(sourceRoot, "scripts", "enable-skin.command"), "#!/bin/zsh\nexit 0\n", {
    mode: 0o755,
  });
  await writeFile(
    join(sourceRoot, "scripts", "enable-persist.command"),
    "#!/bin/zsh\nexec \"$ROOT/scripts/lib/run-cli.zsh\" enable-skin\n",
    { mode: 0o755 },
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, sourceRoot, targetRoot };
}

async function legacyFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "heige-install-legacy-")));
  const home = join(root, "user-home");
  const sourceRoot = join(root, "source");
  const targetRoot = join(home, ".codex", "heige-codex-skin-studio");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(sourceRoot, "package.json"), `${JSON.stringify({
    name: "heige-codex-skin-studio",
    version: "2.0.0",
    type: "module",
    bin: { "heige-codex-skin": "src/cli.mjs" },
  })}\n`);
  for (const directory of ["src", "themes", "scripts", "custom-pet"]) {
    await mkdir(join(sourceRoot, directory), { recursive: true });
    await writeFile(join(sourceRoot, directory, `${directory}.txt`), `${directory}-v2\n`);
  }
  await writeFile(
    join(sourceRoot, "src", "cli.mjs"),
    "#!/usr/bin/env node\nimport { resolveStudioPaths } from \"./constants.mjs\";\nvoid resolveStudioPaths;\n",
    { mode: 0o755 },
  );
  await writeFile(join(sourceRoot, "scripts", "enable-skin.command"), "#!/bin/zsh\nexit 0\n", {
    mode: 0o755,
  });
  await writeFile(
    join(sourceRoot, "scripts", "enable-persist.command"),
    "#!/bin/zsh\nexec \"$ROOT/scripts/lib/run-cli.zsh\" enable-skin\n",
    { mode: 0o755 },
  );
  await mkdir(targetRoot, { recursive: true });
  for (const entry of ["package.json", "src", "themes", "scripts", "custom-pet"]) {
    await cp(join(sourceRoot, entry), join(targetRoot, entry), {
      recursive: entry !== "package.json",
      preserveTimestamps: true,
    });
  }
  await writeFile(
    join(targetRoot, "INSTALLED_COMMIT"),
    "79b03dccf246134ff3b28e9d9afc7751fee8812b\n",
    { mode: 0o644 },
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, home, sourceRoot, targetRoot };
}

async function hasPublicMarkerlessCommit() {
  try {
    await execFileAsync("git", [
      "cat-file",
      "-e",
      PUBLIC_MARKERLESS_COMMIT + "^{commit}",
    ], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

async function publicMarkerlessLegacyFixture(t) {
  if (!await hasPublicMarkerlessCommit()) return null;
  const fixture = await sourceFixture(t);
  const archivePath = join(fixture.root, `${PUBLIC_MARKERLESS_COMMIT}.tar`);
  await mkdir(fixture.targetRoot, { recursive: true });
  await execFileAsync("git", [
    "archive",
    "--format=tar",
    `--output=${archivePath}`,
    PUBLIC_MARKERLESS_COMMIT,
    "--",
    "package.json",
    "src",
    "themes",
    "scripts",
    "custom-pet",
  ], { cwd: repoRoot });
  await execFileAsync("tar", ["-xf", archivePath, "-C", fixture.targetRoot]);
  return { ...fixture, home: join(fixture.root, "home") };
}

async function execLegacyInstall({ root, home, sourceRoot, targetRoot }, faultAt = "") {
  const script = join(root, "legacy-install.mjs");
  await writeFile(script, `
import { installTree } from ${JSON.stringify(installModule)};
const result = await installTree({
  sourceRoot: process.argv[2],
  targetRoot: process.argv[3],
  testMode: { currentUserHome: process.argv[4] },
  faultAt: process.argv[5] || undefined,
});
process.stdout.write(JSON.stringify(result) + "\\n");
`);
  return execFileAsync(process.execPath, [script, sourceRoot, targetRoot, home, faultAt], {
    encoding: "utf8",
  });
}

test("installs an absent stable tree with an exact ownership marker", async (t) => {
  const { sourceRoot, targetRoot } = await sourceFixture(t);

  const result = await installTree({ sourceRoot, targetRoot });

  assert.equal(result.installed, true);
  assert.equal(await readFile(join(targetRoot, "src", "src.txt"), "utf8"), "src\n");
  const marker = JSON.parse(await readFile(join(targetRoot, INSTALL_MARKER_NAME), "utf8"));
  assert.deepEqual(Object.keys(marker).sort(), [
    "kind",
    "manifestSha256",
    "product",
    "schemaVersion",
  ]);
  assert.equal(marker.schemaVersion, 1);
  assert.equal(marker.product, "heige-codex-skin-studio");
  assert.equal(marker.kind, "stable-tree");
  assert.match(marker.manifestSha256, /^[a-f0-9]{64}$/);
});

test("heals a drifted owned tree at the current-user canonical target", async (t) => {
  const { root, sourceRoot, targetRoot } = await sourceFixture(t);
  const home = join(root, "home");
  await mkdir(home, { recursive: true });

  const first = await installTree({
    sourceRoot,
    targetRoot,
    testMode: { currentUserHome: home },
  });
  assert.equal(first.installed, true);

  await writeFile(join(targetRoot, "scripts", "scripts.txt"), "drifted-by-hand\n");
  await assert.rejects(
    prepareInstallTree({ sourceRoot, targetRoot }),
    /owned tree manifest does not match its ownership marker/,
  );

  const healed = await installTree({
    sourceRoot,
    targetRoot,
    testMode: { currentUserHome: home },
  });
  assert.equal(healed.installed, true);
  assert.equal(await readFile(join(targetRoot, "scripts", "scripts.txt"), "utf8"), "scripts\n");
  const marker = JSON.parse(await readFile(join(targetRoot, INSTALL_MARKER_NAME), "utf8"));
  assert.match(marker.manifestSha256, /^[a-f0-9]{64}$/);

  const again = await installTree({
    sourceRoot,
    targetRoot,
    testMode: { currentUserHome: home },
  });
  assert.equal(again.unchanged, true);
  assert.equal(again.installed, false);
});

test("refuses a foreign target without deleting its sentinel", async (t) => {
  const { sourceRoot, targetRoot } = await sourceFixture(t);
  await mkdir(targetRoot, { recursive: true });
  const sentinel = join(targetRoot, "do-not-delete.txt");
  await writeFile(sentinel, "foreign\n");

  await assert.rejects(
    installTree({ sourceRoot, targetRoot }),
    /ownership marker|legacy install adoption/i,
  );

  assert.equal(await readFile(sentinel, "utf8"), "foreign\n");
});

test("rejects an oversized source file before reading it into memory", async (t) => {
  const { sourceRoot, targetRoot } = await sourceFixture(t);
  const oversized = join(sourceRoot, "custom-pet", "oversized.bin");
  await writeFile(oversized, "");
  await truncate(oversized, MAX_INSTALL_SOURCE_FILE_BYTES + 1);

  await assert.rejects(
    installTree({ sourceRoot, targetRoot }),
    /source file.*limit|exceeds.*bytes/i,
  );

  await assert.rejects(lstat(targetRoot), /ENOENT/);
  const leftovers = await readdir(join(targetRoot, ".."));
  assert.equal(
    leftovers.some((name) => name.includes(".staged.") || name.endsWith(".install-prepare.json")),
    false,
  );
});

test("rejects a source tree whose bounded aggregate exceeds the install budget", async (t) => {
  const { sourceRoot, targetRoot } = await sourceFixture(t);
  const each = Math.floor(MAX_INSTALL_SOURCE_TREE_BYTES / 3) + 1;
  assert.ok(each <= MAX_INSTALL_SOURCE_FILE_BYTES);
  for (const directory of ["src", "themes", "scripts"]) {
    const path = join(sourceRoot, directory, "budget.bin");
    await writeFile(path, "");
    await truncate(path, each);
  }

  await assert.rejects(
    installTree({ sourceRoot, targetRoot }),
    /source tree.*limit|aggregate.*bytes/i,
  );

  await assert.rejects(lstat(targetRoot), /ENOENT/);
});

test("rejects a zero-byte source tree that exceeds the inode entry budget", async (t) => {
  const { sourceRoot, targetRoot } = await sourceFixture(t);
  const directory = join(sourceRoot, "themes", "many-empty-files");
  await mkdir(directory);
  for (let offset = 0; offset <= MAX_INSTALL_SOURCE_TREE_ENTRIES; offset += 128) {
    await Promise.all(
      Array.from(
        { length: Math.min(128, MAX_INSTALL_SOURCE_TREE_ENTRIES + 1 - offset) },
        (_, index) => writeFile(join(directory, `empty-${offset + index}`), ""),
      ),
    );
  }

  await assert.rejects(
    installTree({ sourceRoot, targetRoot }),
    /entry limit/i,
  );
  await assert.rejects(lstat(targetRoot), /ENOENT/);
  const leftovers = await readdir(join(targetRoot, ".."));
  assert.equal(
    leftovers.some((name) => name.includes(".staged.") || name.endsWith(".install-prepare.json")),
    false,
  );
});

test("rejects source nesting beyond the bounded traversal depth", async (t) => {
  const { sourceRoot, targetRoot } = await sourceFixture(t);
  let directory = join(sourceRoot, "themes");
  for (let depth = 0; depth <= MAX_INSTALL_SOURCE_TREE_DEPTH; depth += 1) {
    directory = join(directory, `d${depth}`);
    await mkdir(directory);
  }
  await writeFile(join(directory, "empty"), "");

  await assert.rejects(
    installTree({ sourceRoot, targetRoot }),
    /depth limit/i,
  );
  await assert.rejects(lstat(targetRoot), /ENOENT/);
});

test("fails closed when a source file mutates after its stable descriptor is opened", async (t) => {
  const { sourceRoot, targetRoot } = await sourceFixture(t);
  const mutable = join(sourceRoot, "src", "src.txt");
  await writeFile(mutable, "a".repeat(8_192));
  let mutated = false;

  await assert.rejects(
    installTree({
      sourceRoot,
      targetRoot,
      hooks: {
        afterSourceFileOpened: async ({ path }) => {
          if (!mutated && path === mutable) {
            mutated = true;
            await writeFile(mutable, "b".repeat(8_192));
          }
        },
      },
    }),
    /changed while it was read/i,
  );

  assert.equal(mutated, true);
  await assert.rejects(lstat(targetRoot), /ENOENT/);
});

test("fails closed when a source directory is swapped after enumeration", async (t) => {
  const { root, sourceRoot, targetRoot } = await sourceFixture(t);
  const themes = join(sourceRoot, "themes");
  const originalThemes = join(sourceRoot, "themes-original");
  const outside = join(root, "outside-themes");
  await mkdir(outside);
  await writeFile(join(outside, "foreign.txt"), "foreign\n");
  let swapped = false;

  await assert.rejects(
    installTree({
      sourceRoot,
      targetRoot,
      hooks: {
        afterSourceDirectoryOpened: async ({ relativePath }) => {
          if (!swapped && relativePath === "themes") {
            swapped = true;
            await rename(themes, originalThemes);
            await symlink(outside, themes);
          }
        },
      },
    }),
    /source directory.*changed|source directory.*trusted|symlink/i,
  );

  assert.equal(swapped, true);
  assert.equal(await readFile(join(outside, "foreign.txt"), "utf8"), "foreign\n");
  await assert.rejects(lstat(targetRoot), /ENOENT/);
});

test("repeated installation accepts only the exact owned tree", async (t) => {
  const { sourceRoot, targetRoot } = await sourceFixture(t);
  const first = await installTree({ sourceRoot, targetRoot });

  const second = await installTree({ sourceRoot, targetRoot });

  assert.equal(second.installed, false);
  assert.equal(second.unchanged, true);
  assert.equal(second.manifestSha256, first.manifestSha256);
  assert.equal(await readFile(join(targetRoot, "scripts", "scripts.txt"), "utf8"), "scripts\n");
});

test("adopts only the strict current-user legacy tree and replaces it with a marked tree", async (t) => {
  const fixture = await legacyFixture(t);
  const { targetRoot } = fixture;

  const { stdout } = await execLegacyInstall(fixture);

  const result = JSON.parse(stdout);
  assert.equal(result.installed, true);
  assert.equal(result.migratedLegacy, true);
  assert.equal(await readFile(join(targetRoot, "src", "src.txt"), "utf8"), "src-v2\n");
  assert.equal((await lstat(join(targetRoot, INSTALL_MARKER_NAME))).isFile(), true);
  await assert.rejects(lstat(join(targetRoot, "INSTALLED_COMMIT")), /ENOENT/);
});

test("adopts a legacy tree containing the exact strict option 1 deprecated enable entrypoint", async (t) => {
  const fixture = await legacyFixture(t);
  const targetEntrypoint = join(fixture.targetRoot, "scripts", "enable-persist.command");
  await cp(option1DeprecatedEnableEntrypoint, targetEntrypoint, {
    force: true,
    preserveTimestamps: true,
  });

  const { stdout } = await execLegacyInstall(fixture);

  const result = JSON.parse(stdout);
  assert.equal(result.installed, true);
  assert.equal(result.migratedLegacy, true);
  assert.equal((await lstat(join(fixture.targetRoot, INSTALL_MARKER_NAME))).isFile(), true);
  await assert.rejects(lstat(join(fixture.targetRoot, "INSTALLED_COMMIT")), /ENOENT/);
});

test("rejects a legacy tree whose strict option 1 deprecated enable entrypoint was altered", async (t) => {
  const fixture = await legacyFixture(t);
  const targetEntrypoint = join(fixture.targetRoot, "scripts", "enable-persist.command");
  const exactEntrypoint = await readFile(option1DeprecatedEnableEntrypoint, "utf8");
  assert.match(exactEntrypoint, /HEIGE_OPTION1_MENU_ONLY=1/);
  await writeFile(
    targetEntrypoint,
    exactEntrypoint.replace("HEIGE_OPTION1_MENU_ONLY=1", "HEIGE_OPTION1_MENU_ONLY=0"),
  );

  await assert.rejects(
    execLegacyInstall(fixture),
    /legacy enable entrypoint identity signature is invalid/i,
  );
  assert.equal((await lstat(fixture.targetRoot)).isDirectory(), true);
  assert.equal(
    await readFile(targetEntrypoint, "utf8"),
    exactEntrypoint.replace("HEIGE_OPTION1_MENU_ONLY=1", "HEIGE_OPTION1_MENU_ONLY=0"),
  );
});

test("migrates the real markerless tree installed by public commit 79b03dc", async (t) => {
  const fixture = await publicMarkerlessLegacyFixture(t);
  if (fixture === null) {
    t.skip("public commit " + PUBLIC_MARKERLESS_COMMIT + " is missing (shallow clone); fetch full history to run this test");
    return;
  }

  const { stdout } = await execLegacyInstall(fixture);

  const result = JSON.parse(stdout);
  assert.equal(result.installed, true);
  assert.equal(result.migratedLegacy, true);
  assert.equal((await lstat(join(fixture.targetRoot, INSTALL_MARKER_NAME))).isFile(), true);
  await assert.rejects(lstat(join(fixture.targetRoot, "INSTALLED_COMMIT")), /ENOENT/);
});

test("a precommit failure restores the real markerless public tree", async (t) => {
  const fixture = await publicMarkerlessLegacyFixture(t);
  if (fixture === null) {
    t.skip("public commit " + PUBLIC_MARKERLESS_COMMIT + " is missing (shallow clone); fetch full history to run this test");
    return;
  }
  const beforeRoot = await lstat(fixture.targetRoot);
  const beforeCli = await readFile(join(fixture.targetRoot, "src", "cli.mjs"));

  await assert.rejects(
    execLegacyInstall(fixture, "after-target-published"),
    /INJECTED_INSTALL_FAILURE/,
  );

  const afterRoot = await lstat(fixture.targetRoot);
  assert.equal(afterRoot.ino, beforeRoot.ino);
  assert.deepEqual(await readFile(join(fixture.targetRoot, "src", "cli.mjs")), beforeCli);
  assert.deepEqual((await readdir(fixture.targetRoot)).sort(), [
    "custom-pet",
    "package.json",
    "scripts",
    "src",
    "themes",
  ]);
  await assert.rejects(lstat(join(fixture.targetRoot, INSTALL_MARKER_NAME)), /ENOENT/);
  await assert.rejects(lstat(join(fixture.targetRoot, "INSTALLED_COMMIT")), /ENOENT/);
  await assert.rejects(lstat(`${fixture.targetRoot}.install-journal.json`), /ENOENT/);
});

test("a precommit failure restores the exact legacy tree and its commit attribution", async (t) => {
  const fixture = await legacyFixture(t);
  const { targetRoot } = fixture;

  await assert.rejects(
    execLegacyInstall(fixture, "after-target-published"),
    /INJECTED_INSTALL_FAILURE/,
  );

  assert.equal(
    await readFile(join(targetRoot, "INSTALLED_COMMIT"), "utf8"),
    "79b03dccf246134ff3b28e9d9afc7751fee8812b\n",
  );
  await assert.rejects(lstat(join(targetRoot, INSTALL_MARKER_NAME)), /ENOENT/);
  await assert.rejects(lstat(`${targetRoot}.install-journal.json`), /ENOENT/);
});

test("legacy attribution rejects extra content, malformed commit, and nested symlinks", async (t) => {
  for (const mutate of [
    async ({ targetRoot }) => writeFile(join(targetRoot, "foreign-extra"), "preserve\n"),
    async ({ targetRoot }) => writeFile(join(targetRoot, "INSTALLED_COMMIT"), "main\n"),
    async ({ root, targetRoot }) => {
      const outside = join(root, "outside-legacy.txt");
      await writeFile(outside, "preserve\n");
      await rm(join(targetRoot, "src", "src.txt"));
      await symlink(outside, join(targetRoot, "src", "src.txt"));
    },
  ]) {
    await t.test(mutate.toString().slice(0, 48), async (t) => {
      const fixture = await legacyFixture(t);
      await mutate(fixture);
      await assert.rejects(
        execLegacyInstall(fixture),
        /legacy|ownership|symlink|unexpected|commit/i,
      );
      assert.equal((await lstat(fixture.targetRoot)).isDirectory(), true);
    });
  }
});

test("participant rollback restores the old tree after publication stops at the backup boundary", async (t) => {
  const { sourceRoot, targetRoot } = await sourceFixture(t);
  await installTree({ sourceRoot, targetRoot });
  await writeFile(join(sourceRoot, "src", "src.txt"), "src-v2\n");
  const participant = await prepareInstallTree({ sourceRoot, targetRoot });

  await assert.rejects(
    publishInstallTree(participant, { faultAt: "after-backup-detached" }),
    /INJECTED_INSTALL_FAILURE/,
  );
  await rollbackInstallTree(participant);

  assert.equal(await readFile(join(targetRoot, "src", "src.txt"), "utf8"), "src\n");
  await assert.rejects(lstat(participant.stagePath), /ENOENT/);
  await assert.rejects(lstat(participant.backupPath), /ENOENT/);

  const retry = await prepareInstallTree({ sourceRoot, targetRoot });
  await publishInstallTree(retry);
  assert.equal(await readFile(join(targetRoot, "src", "src.txt"), "utf8"), "src-v2\n");
  assert.equal((await readFile(join(retry.backupPath, "src", "src.txt"), "utf8")), "src\n");
  await finalizeInstallTree(retry);
  await assert.rejects(lstat(retry.backupPath), /ENOENT/);
});

test("standalone install journals a failure and restores the old tree before clearing recovery files", async (t) => {
  const { sourceRoot, targetRoot } = await sourceFixture(t);
  await installTree({ sourceRoot, targetRoot });
  await writeFile(join(sourceRoot, "src", "src.txt"), "broken-upgrade\n");

  await assert.rejects(
    installTree({ sourceRoot, targetRoot, faultAt: "after-target-published" }),
    /INJECTED_INSTALL_FAILURE/,
  );

  assert.equal(await readFile(join(targetRoot, "src", "src.txt"), "utf8"), "src\n");
  await assert.rejects(lstat(`${targetRoot}.install-journal.json`), /ENOENT/);
  await assert.rejects(lstat(`${targetRoot}.install.lock`), /ENOENT/);
});

test("a failure before journal creation removes only its attributed staged tree", async (t) => {
  const { sourceRoot, targetRoot } = await sourceFixture(t);

  await assert.rejects(
    installTree({ sourceRoot, targetRoot, faultAt: "before-journal-created" }),
    /INJECTED_INSTALL_FAILURE/,
  );

  await assert.rejects(lstat(targetRoot), /ENOENT/);
  await assert.rejects(lstat(`${targetRoot}.install-journal.json`), /ENOENT/);
  await assert.rejects(lstat(`${targetRoot}.install.lock`), /ENOENT/);
  const names = await readdir(join(targetRoot, ".."));
  assert.equal(names.some((name) => name.includes(".staged.") || name.includes(".backup.")), false);
});

test("an exception after the durable commit decision is recovered by roll-forward", async (t) => {
  const { sourceRoot, targetRoot } = await sourceFixture(t);
  await installTree({ sourceRoot, targetRoot });
  await writeFile(join(sourceRoot, "src", "src.txt"), "committed-v2\n");

  await assert.rejects(
    installTree({
      sourceRoot,
      targetRoot,
      hooks: {
        afterCommitDecision: async () => {
          throw new Error("cleanup interrupted after commit");
        },
      },
    }),
    /cleanup interrupted after commit/,
  );

  assert.equal(await readFile(join(targetRoot, "src", "src.txt"), "utf8"), "committed-v2\n");
  assert.equal((await lstat(`${targetRoot}.install-journal.json`)).isFile(), true);
  const result = await installTree({ sourceRoot, targetRoot });
  assert.equal(result.recovered, true);
  assert.equal(result.unchanged, true);
  await assert.rejects(lstat(`${targetRoot}.install-journal.json`), /ENOENT/);
});

test("a failure after the commit journal write cannot reverse the durable decision", async (t) => {
  const { sourceRoot, targetRoot } = await sourceFixture(t);
  await installTree({ sourceRoot, targetRoot });
  await writeFile(join(sourceRoot, "src", "src.txt"), "journal-committed-v2\n");

  await assert.rejects(
    installTree({ sourceRoot, targetRoot, faultAt: "after-commit-journal-write" }),
    /INJECTED_INSTALL_FAILURE/,
  );

  assert.equal(
    await readFile(join(targetRoot, "src", "src.txt"), "utf8"),
    "journal-committed-v2\n",
  );
  const journal = JSON.parse(await readFile(`${targetRoot}.install-journal.json`, "utf8"));
  assert.equal(journal.decision, "commit");
  const recovery = await recoverInstallTree({ targetRoot });
  assert.deepEqual(recovery, { recovered: true, action: "roll-forward" });
  assert.equal(
    await readFile(join(targetRoot, "src", "src.txt"), "utf8"),
    "journal-committed-v2\n",
  );
});

test("standalone recovery rejects a commit decision paired with a nonterminal phase", async (t) => {
  const { sourceRoot, targetRoot } = await sourceFixture(t);
  await installTree({ sourceRoot, targetRoot });
  await writeFile(join(sourceRoot, "src", "src.txt"), "tampered-v2\n");
  await assert.rejects(
    installTree({ sourceRoot, targetRoot, faultAt: "after-commit-journal-write" }),
    /INJECTED_INSTALL_FAILURE/,
  );
  const path = `${targetRoot}.install-journal.json`;
  const journal = JSON.parse(await readFile(path, "utf8"));
  journal.phase = "target-published";
  await writeFile(path, `${JSON.stringify(journal)}\n`);

  await assert.rejects(recoverInstallTree({ targetRoot }), /journal fields/i);
  assert.equal(await readFile(join(targetRoot, "src", "src.txt"), "utf8"), "tampered-v2\n");
  assert.equal((await lstat(path)).isFile(), true);
});

test("standalone recovery rejects duplicate-key noncanonical journals", async (t) => {
  const { sourceRoot, targetRoot } = await sourceFixture(t);
  await installTree({ sourceRoot, targetRoot });
  await writeFile(join(sourceRoot, "src", "src.txt"), "duplicate-v2\n");
  await assert.rejects(
    installTree({ sourceRoot, targetRoot, faultAt: "after-commit-journal-write" }),
    /INJECTED_INSTALL_FAILURE/,
  );
  const path = `${targetRoot}.install-journal.json`;
  const canonical = await readFile(path, "utf8");
  await writeFile(path, canonical.replace('{', '{"decision":"rollback",'));

  await assert.rejects(recoverInstallTree({ targetRoot }), /canonical/i);
  assert.equal((await lstat(path)).isFile(), true);
});

test("a live install lock excludes a concurrent stable tree writer and uses private modes", async (t) => {
  const { sourceRoot, targetRoot } = await sourceFixture(t);
  let enterBoundary;
  const atBoundary = new Promise((resolve) => { enterBoundary = resolve; });
  let releaseBoundary;
  const holdBoundary = new Promise((resolve) => { releaseBoundary = resolve; });
  t.after(() => releaseBoundary?.());

  const first = installTree({
    sourceRoot,
    targetRoot,
    hooks: {
      afterTargetPublished: async () => {
        enterBoundary();
        await holdBoundary;
      },
    },
  });
  await atBoundary;

  assert.equal((await lstat(`${targetRoot}.install.lock`)).mode & 0o777, 0o700);
  assert.equal((await lstat(`${targetRoot}.install.lock/owner.json`)).mode & 0o777, 0o600);
  assert.equal((await lstat(`${targetRoot}.install-journal.json`)).mode & 0o777, 0o600);
  await assert.rejects(
    installTree({ sourceRoot, targetRoot }),
    /another stable tree installation/i,
  );

  releaseBoundary();
  await first;
});

test("stable tree lock reclaims a reused live PID with a different start identity", async (t) => {
  const { targetRoot } = await sourceFixture(t);
  await mkdir(join(targetRoot, ".."), { recursive: true });
  const lockPath = `${targetRoot}.install.lock`;
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({
    schemaVersion: 2,
    pid: process.pid,
    startedAt: "old-process-start",
    nonce: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const current = { pid: process.pid, startedAt: "new-process-start" };

  const lock = await acquireInstallTreeParticipantLock({
    targetRoot,
    readProcessIdentity: async () => current,
  });
  await lock.release();
  await assert.rejects(lstat(lockPath), /ENOENT/);
});

for (const scenario of ["dead", "live", "unreadable"]) {
  test(`stable tree lock handles schema-1 ${scenario} owners fail-closed`, async (t) => {
    const { targetRoot } = await sourceFixture(t);
    const lockPath = `${targetRoot}.install.lock`;
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    const legacyPid = 991001;
    await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({
      schemaVersion: 1,
      pid: legacyPid,
      nonce: "123e4567-e89b-42d3-a456-426614174000",
      createdAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    const identityReader = async (pid) => {
      if (pid === process.pid) return { pid, startedAt: "current-installer" };
      if (scenario === "dead") return null;
      if (scenario === "live") return { pid, startedAt: "unknown-legacy-start" };
      const error = new Error("permission denied");
      error.code = "EACCES";
      throw error;
    };

    if (scenario === "dead") {
      const lock = await acquireInstallTreeParticipantLock({ targetRoot, readProcessIdentity: identityReader });
      const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
      assert.equal(owner.schemaVersion, 2);
      await lock.release();
      return;
    }
    await assert.rejects(
      acquireInstallTreeParticipantLock({ targetRoot, readProcessIdentity: identityReader }),
      scenario === "live"
        ? /still running/i
        : (error) => error?.code === "EACCES" || error?.cause?.code === "EACCES",
    );
    assert.equal((await lstat(lockPath)).isDirectory(), true);
  });
}

test("rejects source and target symlinks without following their sentinels", async (t) => {
  const sourceCase = await sourceFixture(t);
  const outsideFile = join(sourceCase.root, "outside-source.txt");
  await writeFile(outsideFile, "outside-source\n");
  await rm(join(sourceCase.sourceRoot, "src", "src.txt"));
  await symlink(outsideFile, join(sourceCase.sourceRoot, "src", "src.txt"));

  await assert.rejects(
    installTree({ sourceRoot: sourceCase.sourceRoot, targetRoot: sourceCase.targetRoot }),
    /source symlink/i,
  );
  assert.equal(await readFile(outsideFile, "utf8"), "outside-source\n");

  const targetCase = await sourceFixture(t);
  const outsideDirectory = join(targetCase.root, "outside-target");
  await mkdir(outsideDirectory);
  await writeFile(join(outsideDirectory, "sentinel.txt"), "outside-target\n");
  await mkdir(join(targetCase.root, "home", ".codex"), { recursive: true });
  await symlink(outsideDirectory, targetCase.targetRoot);

  await assert.rejects(
    installTree({ sourceRoot: targetCase.sourceRoot, targetRoot: targetCase.targetRoot }),
    /owned real directory|legacy install adoption/i,
  );
  assert.equal(await readFile(join(outsideDirectory, "sentinel.txt"), "utf8"), "outside-target\n");
});

test("canonicalizes a target path through an ancestor alias before deriving transaction paths", async (t) => {
  const { root, sourceRoot } = await sourceFixture(t);
  const realHome = join(root, "real-home");
  const aliasHome = join(root, "alias-home");
  await mkdir(realHome);
  await symlink(realHome, aliasHome);
  const aliasedTarget = join(aliasHome, ".codex", "heige-codex-skin-studio");
  const canonicalTarget = join(realHome, ".codex", "heige-codex-skin-studio");

  const result = await installTree({ sourceRoot, targetRoot: aliasedTarget });

  assert.equal(result.targetRoot, canonicalTarget);
  assert.equal(await readFile(join(canonicalTarget, "src", "src.txt"), "utf8"), "src\n");
  await assert.rejects(lstat(`${canonicalTarget}.install.lock`), /ENOENT/);
  await assert.rejects(lstat(`${canonicalTarget}.install-journal.json`), /ENOENT/);
});

test("refuses an owned marker when the stable tree has foreign extra content", async (t) => {
  const { sourceRoot, targetRoot } = await sourceFixture(t);
  await installTree({ sourceRoot, targetRoot });
  const sentinel = join(targetRoot, "foreign-extra.txt");
  await writeFile(sentinel, "foreign\n");

  await assert.rejects(
    installTree({ sourceRoot, targetRoot }),
    /unexpected top-level content/i,
  );

  assert.equal(await readFile(sentinel, "utf8"), "foreign\n");
});

test("the executable transaction entry works from a path containing non-ASCII characters", async (t) => {
  const { sourceRoot, targetRoot } = await sourceFixture(t);

  const { stdout } = await execFileAsync(process.execPath, [
    installModule,
    "install",
    "--source", sourceRoot,
    "--target", targetRoot,
  ], { encoding: "utf8" });

  const result = JSON.parse(stdout);
  assert.equal(result.installed, true);
  assert.equal(await readFile(join(targetRoot, "src", "src.txt"), "utf8"), "src\n");
});

test("the executable participant protocol never makes its own commit decision", async (t) => {
  const { sourceRoot, targetRoot } = await sourceFixture(t);
  const transactionId = "123e4567-e89b-42d3-a456-426614174000";
  const prepared = await execFileAsync(process.execPath, [
    installModule,
    "participant-prepare",
    "--source", sourceRoot,
    "--target", targetRoot,
    "--transaction-id", transactionId,
  ], { encoding: "utf8" });
  const participant = JSON.parse(prepared.stdout);
  assert.equal(participant.transactionId, transactionId);
  await assert.rejects(lstat(targetRoot), /ENOENT/);

  await execFileAsync(process.execPath, [
    installModule,
    "participant-publish",
    "--participant-json", JSON.stringify(participant),
  ]);
  assert.equal(await readFile(join(targetRoot, "src", "src.txt"), "utf8"), "src\n");
  assert.equal((await lstat(participant.intentPath)).isFile(), true);

  await execFileAsync(process.execPath, [
    installModule,
    "participant-rollback",
    "--participant-json", JSON.stringify(participant),
  ]);
  await assert.rejects(lstat(targetRoot), /ENOENT/);
  await assert.rejects(lstat(participant.intentPath), /ENOENT/);
  await assert.rejects(lstat(`${targetRoot}.install-journal.json`), /ENOENT/);
});

test("install wrappers route Darwin through the outer coordinator and keep Linux tree-only", async () => {
  for (const relativePath of [
    "scripts/install.command",
    "skill/heige-codex-skin-studio/scripts/install.command",
  ]) {
    const source = await readFile(join(repoRoot, relativePath), "utf8");
    assert.match(source, /uname -s[\s\S]*Darwin[\s\S]*src\/macos-install-coordinator\.mjs/);
    assert.match(source, /else[\s\S]*src\/install-transaction\.mjs/);
    assert.match(source, /\binstall\b[\s\S]*--source[\s\S]*--target/);
    assert.match(source, /HEIGE_SKIP_APPLY/);
    assert.match(source, /codesign[\s\S]*--deep[\s\S]*--strict/);
    assert.match(source, /TeamIdentifier=2DC432GLL2/);
    assert.doesNotMatch(source, /(^|[;&|]\s*)\b(?:cp|rm|mv)\b/m);
  }

  const windowsBytes = await readFile(join(repoRoot, "scripts/windows/install.ps1"));
  assert.equal(windowsBytes[0], 0xef);
  assert.equal(windowsBytes[1], 0xbb);
  assert.equal(windowsBytes[2], 0xbf);
  const windows = windowsBytes.subarray(3).toString("utf8");
  assert.match(windows, /src[\\/]install-transaction\.mjs/);
  assert.match(windows, /participant-prepare[\s\S]*--source[\s\S]*--target/);
  assert.match(windows, /HEIGE_SKIP_APPLY/);
  assert.doesNotMatch(windows, /\bCopy-Item\b/i);
  assert.doesNotMatch(windows, /\b(?:Remove-Item|Move-Item)\b[^\r\n]*(?:\$target|\$InstallRoot)/i);
});
