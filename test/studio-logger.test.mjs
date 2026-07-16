import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createStudioLogger } from "../src/studio-logger.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "heige-logger-")));
  t.after(async () => {
    await chmod(join(root, "state"), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return { root, logPath: join(root, "state", "controller.jsonl") };
}

async function readAllLogs(logPath) {
  const texts = [];
  for (const path of [`${logPath}.3`, `${logPath}.2`, `${logPath}.1`, logPath]) {
    try { texts.push(await readFile(path, "utf8")); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return texts.join("");
}

test("writes bounded JSONL and redacts token home sensitive values and stack", async (t) => {
  const { logPath } = await fixture(t);
  const token = Buffer.alloc(32, 9).toString("base64url");
  const home = "/Users/example";
  const logger = createStudioLogger({
    path: logPath,
    token,
    home,
    sensitiveValues: ["secret-api-key"],
    now: () => new Date("2026-07-16T12:00:00.000Z"),
  });
  const error = new Error(`token=${token} path=${home}/private key=secret-api-key`);
  error.code = "CONTROLLER_FAILURE";
  error.stack = `STACK ${token} ${home} process.env API_KEY=secret-api-key`;

  assert.equal(await logger.error("controller_failure", error), true);
  const text = await readFile(logPath, "utf8");
  assert.equal(text.endsWith("\n"), true);
  const entry = JSON.parse(text);
  assert.deepEqual(Object.keys(entry).sort(), ["code", "event", "level", "message", "timestamp"]);
  assert.equal(entry.timestamp, "2026-07-16T12:00:00.000Z");
  assert.equal(entry.event, "controller_failure");
  assert.equal(entry.code, "CONTROLLER_FAILURE");
  assert.match(entry.message, /~\/private/);
  assert.doesNotMatch(text, new RegExp(token));
  assert.doesNotMatch(text, /\/Users\/example/);
  assert.doesNotMatch(text, /secret-api-key|STACK|process\.env|API_KEY/);
  assert.equal((await lstat(logPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(dirname(logPath))).mode & 0o777, 0o700);
});

test("rotates before the configured bound and retains only the requested backups", async (t) => {
  const { logPath } = await fixture(t);
  let tick = 0;
  const logger = createStudioLogger({
    path: logPath,
    maxBytes: 210,
    backups: 3,
    now: () => new Date(1_700_000_000_000 + tick++),
  });
  for (let index = 0; index < 20; index += 1) {
    assert.equal(await logger.info("tick", `entry-${index}-${"x".repeat(35)}`), true);
  }
  const files = (await readdir(dirname(logPath))).sort();
  assert.deepEqual(files, [
    "controller.jsonl",
    "controller.jsonl.1",
    "controller.jsonl.2",
    "controller.jsonl.3",
  ]);
  for (const file of files) {
    assert.ok((await lstat(join(dirname(logPath), file))).size <= 210);
  }
  const all = await readAllLogs(logPath);
  assert.match(all, /entry-19/);
  assert.doesNotMatch(all, /entry-0-/);
});

test("serializes concurrent writes without producing partial JSON lines", async (t) => {
  const { logPath } = await fixture(t);
  const logger = createStudioLogger({ path: logPath, maxBytes: 64 * 1024 });
  await Promise.all(Array.from({ length: 50 }, (_, index) => logger.info("parallel", `line-${index}`)));
  const lines = (await readFile(logPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 50);
  assert.equal(lines.every((line) => JSON.parse(line).event === "parallel"), true);
});

test("write and path failures are contained and never mutate a symlink target", async (t) => {
  const { root, logPath } = await fixture(t);
  const outside = join(root, "outside.log");
  await writeFile(outside, "untouched", { mode: 0o600 });
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
  await symlink(outside, logPath);
  const logger = createStudioLogger({ path: logPath });
  assert.equal(await logger.error("failure", new Error("primary")), false);
  assert.equal(await readFile(outside, "utf8"), "untouched");

  await chmod(dirname(logPath), 0o500);
  assert.equal(await logger.info("still_primary", "must not throw"), false);
});

test("invalid event names and unsafe option bounds fail before filesystem access", async (t) => {
  const { logPath } = await fixture(t);
  assert.throws(() => createStudioLogger({ path: "relative.log" }), /绝对路径/);
  assert.throws(() => createStudioLogger({ path: logPath, maxBytes: 10 }), /maxBytes/);
  assert.throws(() => createStudioLogger({ path: logPath, backups: 99 }), /backups/);
  const logger = createStudioLogger({ path: logPath });
  assert.equal(await logger.info("Bad Event", "ignored"), false);
  await assert.rejects(readFile(logPath), (error) => error.code === "ENOENT");
});
