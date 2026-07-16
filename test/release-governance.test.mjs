import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = new URL("../", import.meta.url);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function gitLines(...args) {
  const { stdout } = await execFileAsync("git", args, { cwd: root, encoding: "utf8" });
  return stdout.split(/\r?\n/).filter(Boolean);
}

test("security documentation states the real CDP and control-channel boundary", async () => {
  const text = await readFile(new URL("../SECURITY.md", import.meta.url), "utf8");
  for (const phrase of [
    "Runtime.evaluate",
    "127.0.0.1",
    "无认证的 CDP",
    "X-HeiGe-Control-Token",
    "不读取 Codex 对话",
    "restore",
  ]) assert.match(text, new RegExp(escapeRegExp(phrase), "i"));
  assert.match(text, /Report a vulnerability/);
  assert.match(text, /不要.*公开.*Issue/s);
});

test("tracked source contains no backup assets or ignored reports", async () => {
  const tracked = await gitLines("ls-files");
  assert.equal(tracked.some((path) => path.includes(".before-")), false);
  assert.equal(tracked.some((path) => path.startsWith("reports/")), false);
});

test("every tracked visual asset has exactly one provenance row", async () => {
  await execFileAsync(process.execPath, ["scripts/check-asset-provenance.mjs", "--check"], {
    cwd: root,
    encoding: "utf8",
  });
});

test("notice does not pretend a disclaimer grants redistribution rights", async () => {
  const text = await readFile(new URL("../NOTICE.md", import.meta.url), "utf8");
  assert.match(text, /MIT.*软件|software.*only/is);
  assert.match(text, /不.*授权|does not.*permission/is);
  assert.match(text, /发布风险|release risk/is);
});
