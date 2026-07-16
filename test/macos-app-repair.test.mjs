import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  recoverMacAppRepair,
  repairMacApp,
} from "../src/macos-app-repair.mjs";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeFixtureApp(path, asar, { signed = false } = {}) {
  await mkdir(join(path, "Contents", "Resources"), { recursive: true });
  await mkdir(join(path, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(path, "Contents", "Resources", "app.asar"), asar);
  await writeFile(join(path, "Contents", "MacOS", "ChatGPT"), "executable\n", { mode: 0o755 });
  await writeFile(join(path, "Contents", "Info.plist"), "plist\n");
  await writeFile(join(path, ".fixture-signature"), signed ? "official\n" : "polluted\n");
}

async function inspectFixtureApp(path) {
  const root = await lstat(path, { bigint: true });
  if (root.isSymbolicLink() || !root.isDirectory()) throw new Error("fixture app is not real");
  const asar = await readFile(join(path, "Contents", "Resources", "app.asar"));
  const signature = (await readFile(join(path, ".fixture-signature"), "utf8")).trim();
  const executable = await readFile(join(path, "Contents", "MacOS", "ChatGPT"));
  return {
    rootDev: String(root.dev),
    rootIno: String(root.ino),
    bundleIdentifier: "com.openai.codex",
    version: signature === "official" ? "26.707.91948" : "26.707.72221",
    build: signature === "official" ? "5440" : "5311",
    executableSha256: digest(executable),
    executableSize: executable.byteLength,
    signatureValid: signature === "official",
    teamIdentifier: signature === "official" ? "2DC432GLL2" : null,
    asarSha256: digest(asar),
    asarSize: asar.byteLength,
  };
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "heige-app-repair-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const applications = join(root, "Applications");
  const stateRoot = join(root, "state");
  const currentAppPath = join(applications, "ChatGPT.app");
  const stagedAppPath = join(applications, ".ChatGPT.app.heige-official-stage-test");
  const journalPath = join(stateRoot, "app-repair.json");
  await mkdir(applications, { recursive: true });
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await writeFixtureApp(currentAppPath, "polluted-asar\n");
  await writeFixtureApp(stagedAppPath, "official-asar\n", { signed: true });
  const dependencies = {
    inspectApp: inspectFixtureApp,
    assertAppStopped: async () => true,
    readProcessIdentity: async (pid) => (pid === process.pid
      ? { pid, startedAt: "Thu Jul 16 12:00:00 2026" }
      : null),
  };
  return {
    currentAppPath,
    dependencies,
    expectedBeforeAsarSha256: digest("polluted-asar\n"),
    expectedOfficialAsarSha256: digest("official-asar\n"),
    journalPath,
    stagedAppPath,
    testMode: { allowAnyPaths: true },
  };
}

async function exists(path) {
  return lstat(path).then(() => true, (error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
}

async function appBody(path) {
  return readFile(join(path, "Contents", "Resources", "app.asar"), "utf8");
}

test("committed app repair leaves only the exact official signed app", async (t) => {
  const fx = await fixture(t);
  const result = await repairMacApp(fx);
  assert.equal(result.status, "repaired");
  assert.equal(await appBody(fx.currentAppPath), "official-asar\n");
  assert.equal(await exists(fx.stagedAppPath), false);
  assert.equal(await exists(fx.journalPath), false);
  assert.equal(result.after.teamIdentifier, "2DC432GLL2");
});

for (const boundary of ["after-backup-detached", "after-target-published"]) {
  test(`a hard crash ${boundary} rolls back the exact app and preserves the stage`, async (t) => {
    const fx = await fixture(t);
    await assert.rejects(
      repairMacApp({
        ...fx,
        hooks: {
          [boundary]: async () => {
            const error = new Error(`simulated crash at ${boundary}`);
            error.simulatedHardCrash = true;
            throw error;
          },
        },
      }),
      /simulated crash/,
    );
    assert.equal(await exists(fx.journalPath), true);
    const recovered = await recoverMacAppRepair(fx);
    assert.equal(recovered.action, "rollback");
    assert.equal(await appBody(fx.currentAppPath), "polluted-asar\n");
    assert.equal(await appBody(fx.stagedAppPath), "official-asar\n");
    assert.equal(await exists(fx.journalPath), false);
  });
}

test("a hard crash after the durable commit rolls forward and never revives pollution", async (t) => {
  const fx = await fixture(t);
  await assert.rejects(
    repairMacApp({
      ...fx,
      hooks: {
        "after-commit-decision": async () => {
          const error = new Error("simulated post-commit crash");
          error.simulatedHardCrash = true;
          throw error;
        },
      },
    }),
    /post-commit crash/,
  );
  const recovered = await recoverMacAppRepair(fx);
  assert.equal(recovered.action, "roll-forward");
  assert.equal(await appBody(fx.currentAppPath), "official-asar\n");
  assert.equal(await exists(fx.stagedAppPath), false);
  assert.equal(await exists(fx.journalPath), false);
});

test("repair refuses drifted pollution, unsigned stages, live apps, and path aliases", async (t) => {
  const drifted = await fixture(t);
  await writeFile(
    join(drifted.currentAppPath, "Contents", "Resources", "app.asar"),
    "changed\n",
  );
  await assert.rejects(repairMacApp(drifted), /current app\.asar digest mismatch/);

  const unsigned = await fixture(t);
  await writeFile(join(unsigned.stagedAppPath, ".fixture-signature"), "polluted\n");
  await assert.rejects(repairMacApp(unsigned), /official stage must retain the OpenAI signature/);

  const running = await fixture(t);
  running.dependencies = {
    ...running.dependencies,
    assertAppStopped: async () => false,
  };
  await assert.rejects(repairMacApp(running), /must be fully stopped/);

  const linked = await fixture(t);
  const alias = `${linked.stagedAppPath}.alias`;
  await symlink(linked.stagedAppPath, alias);
  await assert.rejects(repairMacApp({ ...linked, stagedAppPath: alias }), /canonical real directory/);
});

for (const boundary of [
  { name: "after detaching the polluted app", rejectCall: 3 },
  { name: "after publishing the official app", rejectCall: 5 },
]) {
  test(`repair rolls back when Codex starts ${boundary.name}`, async (t) => {
    const fx = await fixture(t);
    let calls = 0;
    fx.dependencies = {
      ...fx.dependencies,
      assertAppStopped: async () => {
        calls += 1;
        return calls !== boundary.rejectCall;
      },
    };

    await assert.rejects(
      repairMacApp(fx),
      /must be fully stopped and remain stopped/,
    );
    assert.equal(await appBody(fx.currentAppPath), "polluted-asar\n");
    assert.equal(await appBody(fx.stagedAppPath), "official-asar\n");
    assert.equal(await exists(fx.journalPath), false);
  });
}
