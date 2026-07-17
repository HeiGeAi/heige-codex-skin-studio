import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("packages the independent native v2 Miku Future custom pet", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../custom-pet/miku-future/pet.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(manifest, {
    id: "miku-future",
    displayName: "Miku Future",
    description: "与主题壁纸同款的初音未来 Q 版动画桌面宠物",
    spriteVersionNumber: 2,
    spritesheetPath: "spritesheet.webp",
  });

  const bytes = await readFile(
    new URL("../custom-pet/miku-future/spritesheet.webp", import.meta.url),
  );
  const crops = JSON.parse(
    await readFile(new URL("../assets/miku-crops.json", import.meta.url), "utf8"),
  );
  assert.ok(bytes.length > 100_000, "pet spritesheet is unexpectedly empty");
  assert.equal(
    sha256(bytes),
    "3452954a055640cc6b116f4d4c99c0dbf8928674899900ccb238bc2601ba41ec",
    "the packaged pet must match the latest local Miku Future revision",
  );
  assert.equal(sha256(bytes), crops.pet.sha256, "pet manifest hash drifted");
  assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
  assert.equal(bytes.subarray(8, 12).toString(), "WEBP");
  assert.equal(bytes.subarray(12, 16).toString(), "VP8L");
  assert.equal(bytes[20], 0x2f, "lossless WebP signature drifted");
  const sizeBits = bytes.readUInt32LE(21);
  assert.equal((sizeBits & 0x3fff) + 1, 1536, "pet spritesheet width drifted");
  assert.equal(((sizeBits >>> 14) & 0x3fff) + 1, 2288, "pet spritesheet height drifted");
});

test("both pet entrypoints are syntax-valid thin CLI wrappers", async () => {
  const wrappers = ["scripts/install-pet.command", "custom-pet/install.command"];
  await execFileAsync("/bin/zsh", ["-n", ...wrappers.map((path) => join(repoRoot, path))]);

  for (const relative of wrappers) {
    const body = await readFile(join(repoRoot, relative), "utf8");
    assert.match(body, /src\/cli\.mjs" install-pet --source/);
    assert.doesNotMatch(body, /\bcp\b|\bsed\b|selected-avatar-id|已安装/);
  }
});

test("custom-pet wrapper reports success only after installing files and config", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "heige-custom-pet-wrapper-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const { stdout, stderr } = await execFileAsync(join(repoRoot, "custom-pet/install.command"), [], {
    env: { ...process.env, HOME: home, HEIGE_NODE: process.execPath },
  });
  const result = JSON.parse(stdout);

  assert.equal(stderr, "");
  assert.equal(result.installed, true);
  assert.equal(result.petId, "miku-future");
  assert.equal(result.restartRequired, true);
  assert.equal(result.effectivePetId, "custom:miku-future");
  assert.match(result.nextAction, /重启 Codex/);
  assert.deepEqual(
    await readFile(join(home, ".codex/pets/miku-future/pet.json")),
    await readFile(join(repoRoot, "custom-pet/miku-future/pet.json")),
  );
  assert.match(
    await readFile(join(home, ".codex/config.toml"), "utf8"),
    /^selected-avatar-id = "custom:miku-future"$/m,
  );
});
