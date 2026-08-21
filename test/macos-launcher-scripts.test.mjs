import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "heige-launcher-scripts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts", "lib"), { recursive: true });
  for (const name of [
    "launch-skin.command",
    "close-skin.command",
    "repair-skin.command",
    "launcher-state.command",
  ]) {
    const source = join(repositoryRoot, "scripts", name);
    try {
      await writeFile(join(root, "scripts", name), await readFile(source), { mode: 0o755 });
      await chmod(join(root, "scripts", name), 0o755);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const recorder = join(root, "record.txt");
  await writeFile(join(root, "scripts", "lib", "run-cli.zsh"), `#!/bin/zsh
print -r -- "product=\${HEIGE_SKIN_PRODUCT:-codex}" > "\${HEIGE_TEST_RECORD}"
print -r -- "$@" >> "\${HEIGE_TEST_RECORD}"
`, { mode: 0o755 });
  await chmod(join(root, "scripts", "lib", "run-cli.zsh"), 0o755);
  return { root, recorder };
}

async function recorded(root, recorder, script, args) {
  await execFileAsync(join(root, "scripts", script), args, {
    env: { ...process.env, HEIGE_TEST_RECORD: recorder },
  });
  return readFile(recorder, "utf8");
}

test("Codex launcher action uses the version-bound 9341 route", async (t) => {
  const { root, recorder } = await fixture(t);
  assert.equal(
    await recorded(root, recorder, "launch-skin.command", ["5.5.10", "codex"]),
    "product=codex\nlauncher-apply --launcher-version 5.5.10 --port 9341\n",
  );
});

test("WorkBuddy launcher action stays on its isolated one-shot 9342 route", async (t) => {
  const { root, recorder } = await fixture(t);
  assert.equal(
    await recorded(root, recorder, "launch-skin.command", ["5.5.10", "workbuddy"]),
    "product=workbuddy\nlauncher-apply --launcher-version 5.5.10 --app workbuddy --port 9342\n",
  );
});

test("launcher close routes both products through version-bound pause commands", async (t) => {
  const { root, recorder } = await fixture(t);
  assert.equal(
    await recorded(root, recorder, "close-skin.command", ["5.5.13", "codex"]),
    "product=codex\nlauncher-close --launcher-version 5.5.13 --port 9341\n",
  );
  assert.equal(
    await recorded(root, recorder, "close-skin.command", ["5.5.13", "workbuddy"]),
    "product=workbuddy\nlauncher-close --launcher-version 5.5.13 --app workbuddy --port 9342\n",
  );
});

test("launcher repair routes both products through isolated version-bound repairs", async (t) => {
  const { root, recorder } = await fixture(t);
  assert.equal(
    await recorded(root, recorder, "repair-skin.command", ["5.5.13", "codex"]),
    "product=codex\nlauncher-repair --launcher-version 5.5.13 --port 9341\n",
  );
  assert.equal(
    await recorded(root, recorder, "repair-skin.command", ["5.5.13", "workbuddy"]),
    "product=workbuddy\nlauncher-repair --launcher-version 5.5.13 --app workbuddy --port 9342\n",
  );
});

test("launcher state script exposes only the selected product", async (t) => {
  const { root, recorder } = await fixture(t);
  assert.equal(
    await recorded(root, recorder, "launcher-state.command", ["workbuddy"]),
    "product=workbuddy\nlauncher-state --app workbuddy\n",
  );
});

for (const script of [
  "launch-skin.command",
  "close-skin.command",
  "repair-skin.command",
  "launcher-state.command",
]) {
  test(`${script} rejects an unknown product before invoking Node`, async (t) => {
    const { root, recorder } = await fixture(t);
    await assert.rejects(
      execFileAsync(join(root, "scripts", script),
        script === "launcher-state.command" ? ["other"] : ["5.5.10", "other"], {
          env: { ...process.env, HEIGE_TEST_RECORD: recorder },
        }),
      /不支持的产品/,
    );
    await assert.rejects(readFile(recorder), /ENOENT/);
  });
}
