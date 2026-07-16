import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const packager = fileURLToPath(new URL("../scripts/package-skill.command", import.meta.url));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("rebuilds the Skill deterministically from tracked files only", async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), "codex-miku-skill-"));
  t.after(() => rm(outputDir, { force: true, recursive: true }));
  const first = join(outputDir, "first.skill");
  const second = join(outputDir, "second.skill");

  await execFileAsync("/bin/zsh", [packager, first], { cwd: repoRoot });
  await execFileAsync("/bin/zsh", [packager, second], { cwd: repoRoot });

  const [firstBytes, secondBytes] = await Promise.all([readFile(first), readFile(second)]);
  assert.equal(sha256(firstBytes), sha256(secondBytes));

  const [{ stdout: archiveList }, { stdout: trackedList }] = await Promise.all([
    execFileAsync("/usr/bin/unzip", ["-Z1", first]),
    execFileAsync("/usr/bin/git", ["ls-files", "skill/codex-miku-theme"], {
      cwd: repoRoot,
    }),
  ]);
  const packaged = archiveList.trim().split("\n").filter(Boolean).sort();
  const expected = trackedList
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((path) => path.replace(/^skill\//, ""))
    .sort();

  assert.deepEqual(packaged, expected);
  assert.equal(packaged.some((path) => path.includes("/payload/pet/")), false);
  assert.equal(packaged.some((path) => path.includes(".before-")), false);
  assert.equal(packaged.some((path) => path.endsWith(".DS_Store")), false);
});
