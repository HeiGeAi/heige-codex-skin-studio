import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  acquireMacosLauncherInstallLock,
  finalizeMacosLauncher,
  installMacosLauncher,
  MACOS_LAUNCHER_SCHEMA_VERSION,
  prepareMacosLauncher,
  publishMacosLauncher,
  registerMacosLauncher,
  renderMacosLauncherExecutable,
  renderMacosLauncherPlist,
  rollbackMacosLauncher,
} from "../src/macos-launcher.mjs";

const execFileAsync = promisify(execFile);
const launcherModuleUrl = new URL("../src/macos-launcher.mjs", import.meta.url).href;
const launcherIconUrl = new URL("../assets/launcher/AppIcon.icns", import.meta.url);
const launcherLogoUrl = new URL("../assets/launcher/LauncherLogo.png", import.meta.url);
const launcherBinaryUrl = new URL("../assets/launcher/HeiGeSkinLauncher.bin", import.meta.url);

async function populateRuntime(installRoot, version = "5.5.13") {
  const entrypoint = join(installRoot, "scripts", "apply.command");
  const launcherEntrypoint = join(installRoot, "scripts", "launch-skin.command");
  await Promise.all([
    mkdir(join(installRoot, "scripts"), { recursive: true }),
    mkdir(join(installRoot, "assets", "launcher"), { recursive: true }),
  ]);
  await writeFile(entrypoint, "#!/bin/zsh\nexit 0\n", { mode: 0o755 });
  await chmod(entrypoint, 0o755);
  await writeFile(launcherEntrypoint, "#!/bin/zsh\nexit 0\n", { mode: 0o755 });
  await chmod(launcherEntrypoint, 0o755);
  await writeFile(join(installRoot, "package.json"), `${JSON.stringify({ version })}\n`);
  await writeFile(
    join(installRoot, "assets", "launcher", "AppIcon.icns"),
    await readFile(launcherIconUrl),
  );
  await writeFile(
    join(installRoot, "assets", "launcher", "LauncherLogo.png"),
    await readFile(launcherLogoUrl),
  );
  await writeFile(
    join(installRoot, "assets", "launcher", "HeiGeSkinLauncher.bin"),
    await readFile(launcherBinaryUrl),
    { mode: 0o755 },
  );
  await chmod(join(installRoot, "assets", "launcher", "HeiGeSkinLauncher.bin"), 0o755);
  return { entrypoint, launcherEntrypoint };
}

async function fixture(t, suffix = "用户 空格") {
  const root = await mkdtemp(join(tmpdir(), `heige-launcher-${suffix}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "家 目录");
  const installRoot = join(home, ".codex", "heige-codex-skin-studio");
  const { entrypoint, launcherEntrypoint } = await populateRuntime(installRoot);
  return { root, home, installRoot, entrypoint, launcherEntrypoint };
}

async function waitForPath(child, path, stderr) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      if (child.exitCode !== null) break;
      await delay(10);
    }
  }
  throw new Error(`child did not reach launcher prepare boundary: ${stderr()}`);
}

test("creates a Finder-visible schema 5 app with separate Dock icon and window logo", async (t) => {
  const { home, installRoot } = await fixture(t);
  const result = await installMacosLauncher({ home, installRoot });
  assert.equal(MACOS_LAUNCHER_SCHEMA_VERSION, 5);
  assert.equal(result.appPath, join(home, "Applications", "HeiGe 皮肤启动器.app"));
  assert.equal(result.executablePath, join(result.appPath, "Contents", "MacOS", "HeiGe Skin Launcher"));
  const executable = await readFile(result.executablePath);
  const plist = await readFile(join(result.appPath, "Contents", "Info.plist"), "utf8");
  assert.equal(executable.readUInt32BE(0), 0xcafebabe);
  assert.match(plist, /com\.heige\.codex-skin-launcher/);
  assert.match(plist, /HeiGe 皮肤启动器/);
  assert.match(plist, /<key>HeiGeLauncherSchemaVersion<\/key>\s*<integer>5<\/integer>/);
  assert.match(plist, /<key>CFBundleIconFile<\/key>\s*<string>AppIcon\.icns<\/string>/);
  assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>5\.5\.13<\/string>/);
  assert.match(plist, /<key>LSMinimumSystemVersion<\/key>\s*<string>13\.0<\/string>/);
  assert.deepEqual(
    await readFile(join(result.appPath, "Contents", "Resources", "AppIcon.icns")),
    await readFile(launcherIconUrl),
  );
  assert.deepEqual(
    await readFile(join(result.appPath, "Contents", "Resources", "LauncherLogo.png")),
    await readFile(launcherLogoUrl),
  );
  assert.deepEqual(
    (await readdir(join(result.appPath, "Contents", "_CodeSignature"))).sort(),
    ["CodeResources"],
  );
  await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--", result.appPath]);
  assert.equal((await stat(result.executablePath)).mode & 0o777, 0o755);
  assert.equal((await stat(join(result.appPath, "Contents", "Info.plist"))).mode & 0o777, 0o644);
});

test("creates canonical launcher signature resources under a private umask", async (t) => {
  const { root, home, installRoot } = await fixture(t, "private-umask");
  const childScript = join(root, "install-private-umask.mjs");
  await writeFile(childScript, `
process.umask(0o077);
const { installMacosLauncher } = await import(${JSON.stringify(launcherModuleUrl)});
const result = await installMacosLauncher({ home: process.argv[2], installRoot: process.argv[3] });
process.stdout.write(JSON.stringify(result));
`);
  const { stdout } = await execFileAsync(process.execPath, [childScript, home, installRoot]);
  const result = JSON.parse(stdout);
  assert.equal(
    (await stat(join(result.appPath, "Contents", "_CodeSignature"))).mode & 0o777,
    0o755,
  );
  for (const name of ["CodeResources"]) {
    assert.equal(
      (await stat(join(result.appPath, "Contents", "_CodeSignature", name))).mode & 0o777,
      0o644,
    );
  }
});

for (const hook of ["afterStageCreated", "afterPrepare"]) {
  test(`SIGKILL at launcher ${hook} recovers its durable preparation intent`, async (t) => {
    const { root, home, installRoot } = await fixture(t);
    const markerPath = join(root, `${hook}.marker`);
    const childScript = join(root, `${hook}.mjs`);
    await writeFile(childScript, `
import { writeFile } from "node:fs/promises";
const { prepareMacosLauncher } = await import(${JSON.stringify(launcherModuleUrl)});
await prepareMacosLauncher({
  home: process.argv[2],
  installRoot: process.argv[3],
  hooks: { [process.argv[5]]: async () => {
    await writeFile(process.argv[4], "ready\\n");
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
  } },
});
`);
    const child = spawn(process.execPath, [childScript, home, installRoot, markerPath, hook], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    await waitForPath(child, markerPath, () => stderr);
    const exited = once(child, "exit");
    assert.equal(child.kill("SIGKILL"), true);
    const [, signal] = await exited;
    assert.equal(signal, "SIGKILL");

    assert.equal((await lstat(join(home, ".heige-codex-skin-launcher-prepare.json"))).isFile(), true);
    const lock = await acquireMacosLauncherInstallLock({ home });
    await lock.release();
    await assert.rejects(lstat(join(home, ".heige-codex-skin-launcher-prepare.json")), /ENOENT/);
    await assert.rejects(lstat(join(home, "Applications")), /ENOENT/);
  });
}

test("serializable launcher participant retains the old bundle until outer finalize", async (t) => {
  const { home, installRoot } = await fixture(t);
  const original = await installMacosLauncher({ home, installRoot });
  const originalExecutable = await readFile(original.executablePath);
  const nextInstallRoot = join(home, ".codex", "heige-codex-skin-studio-next");
  await populateRuntime(nextInstallRoot);

  const participant = JSON.parse(JSON.stringify(await prepareMacosLauncher({
    home,
    installRoot: nextInstallRoot,
  })));
  await publishMacosLauncher(participant);

  assert.equal((await lstat(participant.backupPath)).isDirectory(), true);
  assert.match(
    await readFile(join(participant.appPath, "Contents", "Info.plist"), "utf8"),
    /heige-codex-skin-studio-next/,
  );
  await rollbackMacosLauncher(participant);
  assert.deepEqual(await readFile(original.executablePath), originalExecutable);
  await assert.rejects(lstat(participant.stagePath), /ENOENT/);
  await assert.rejects(lstat(participant.backupPath), /ENOENT/);

  const committed = JSON.parse(JSON.stringify(await prepareMacosLauncher({
    home,
    installRoot: nextInstallRoot,
  })));
  await publishMacosLauncher(committed);
  await finalizeMacosLauncher(committed, { registerLauncher: async () => {} });
  assert.match(
    await readFile(join(committed.appPath, "Contents", "Info.plist"), "utf8"),
    /heige-codex-skin-studio-next/,
  );
  await assert.rejects(lstat(committed.backupPath), /ENOENT/);
});

test("launcher participant rollback removes a newly published app when no app existed before", async (t) => {
  const { home, installRoot } = await fixture(t);
  const participant = JSON.parse(JSON.stringify(await prepareMacosLauncher({ home, installRoot })));
  assert.equal(participant.schemaVersion, 2);
  assert.equal(participant.afterVersion, "5.5.13");
  for (const field of [
    "afterExecutableSha256",
    "afterIconSha256",
    "afterPlistSha256",
    "afterSignatureSha256",
  ]) assert.match(participant[field], /^[a-f0-9]{64}$/);

  await publishMacosLauncher(participant);
  assert.equal((await lstat(participant.appPath)).isDirectory(), true);
  await rollbackMacosLauncher(participant);

  await assert.rejects(lstat(participant.appPath), /ENOENT/);
  await assert.rejects(lstat(participant.stagePath), /ENOENT/);
});

test("launcher staging reads release inputs from source while binding the app to the stable target", async (t) => {
  const { root, home } = await fixture(t);
  const sourceRoot = join(root, "5.5.13 发布源码");
  const targetRoot = join(home, ".codex", "heige-codex-skin-studio-target");
  await populateRuntime(sourceRoot);

  const participant = await prepareMacosLauncher({
    home,
    installRoot: targetRoot,
    validationRoot: sourceRoot,
  });
  const stagedExecutable = await readFile(
    join(participant.stagePath, "Contents", "MacOS", "HeiGe Skin Launcher"),
  );
  const stagedPlist = await readFile(join(participant.stagePath, "Contents", "Info.plist"), "utf8");

  assert.equal(participant.installRoot, targetRoot);
  assert.equal(participant.afterVersion, "5.5.13");
  assert.equal(stagedExecutable.readUInt32BE(0), 0xcafebabe);
  assert.match(stagedPlist, new RegExp(targetRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(stagedPlist, new RegExp(sourceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await rollbackMacosLauncher(participant);
});

test("registers only an exact attributed launcher bundle with LaunchServices", async (t) => {
  const { home, installRoot } = await fixture(t);
  const result = await installMacosLauncher({ home, installRoot });
  const calls = [];

  const registered = await registerMacosLauncher(result.appPath, {
    execFileImpl: async (...args) => { calls.push(args); },
  });

  assert.equal(registered, result.appPath);
  assert.deepEqual(calls, [[
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    ["-f", result.appPath],
    { maxBuffer: 1024 * 1024 },
  ]]);
});

test("launcher finalization keeps its durable intent until LaunchServices registration succeeds", async (t) => {
  const { home, installRoot } = await fixture(t);
  const participant = await prepareMacosLauncher({ home, installRoot });
  await publishMacosLauncher(participant);

  await assert.rejects(
    finalizeMacosLauncher(participant, {
      registerLauncher: async () => { throw new Error("SIMULATED_LAUNCHSERVICES_FAILURE"); },
    }),
    /SIMULATED_LAUNCHSERVICES_FAILURE/,
  );
  assert.equal((await lstat(participant.intentPath)).isFile(), true);

  const registered = [];
  await finalizeMacosLauncher(participant, {
    registerLauncher: async (appPath) => { registered.push(appPath); },
  });
  assert.deepEqual(registered, [participant.appPath]);
  await assert.rejects(lstat(participant.intentPath), /ENOENT/);
});

test("launcher participant can be reconstructed after a publisher process is SIGKILLed", async (t) => {
  const { root, home, installRoot } = await fixture(t);
  const original = await installMacosLauncher({ home, installRoot });
  const originalExecutable = await readFile(original.executablePath);
  const nextInstallRoot = join(home, ".codex", "cross-process-next");
  await populateRuntime(nextInstallRoot);
  const participant = await prepareMacosLauncher({ home, installRoot: nextInstallRoot });
  const descriptorPath = join(root, "launcher-participant.json");
  const markerPath = join(root, "launcher-published.marker");
  const childScript = join(root, "publish-launcher-participant.mjs");
  await writeFile(descriptorPath, `${JSON.stringify(participant)}\n`);
  await writeFile(childScript, `
import { readFile, writeFile } from "node:fs/promises";
const { publishMacosLauncher } = await import(${JSON.stringify(launcherModuleUrl)});
const participant = JSON.parse(await readFile(process.argv[2], "utf8"));
await publishMacosLauncher(participant, {
  hooks: { afterPublish: async () => {
    await writeFile(process.argv[3], "ready\\n");
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
  } },
});
`);
  const child = spawn(process.execPath, [childScript, descriptorPath, markerPath], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let ready = false;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await access(markerPath);
      ready = true;
      break;
    } catch {
      if (child.exitCode !== null) break;
      await delay(10);
    }
  }
  assert.equal(ready, true, stderr);
  const exited = once(child, "exit");
  assert.equal(child.kill("SIGKILL"), true);
  const [, signal] = await exited;
  assert.equal(signal, "SIGKILL");

  const reconstructed = JSON.parse(await readFile(descriptorPath, "utf8"));
  await rollbackMacosLauncher(reconstructed);
  assert.deepEqual(await readFile(original.executablePath), originalExecutable);
  await assert.rejects(lstat(reconstructed.backupPath), /ENOENT/);
  await assert.rejects(lstat(reconstructed.stagePath), /ENOENT/);
});

test("escapes plist XML for a stable path with punctuation", async (t) => {
  const { root } = await fixture(t, "base");
  const home = join(root, "家 & <目录>");
  const installRoot = join(home, ".codex", "HeiGe's $studio");
  await populateRuntime(installRoot);
  const result = await installMacosLauncher({ home, installRoot });
  const plist = await readFile(join(result.appPath, "Contents", "Info.plist"), "utf8");
  assert.match(plist, /家 &amp; &lt;目录&gt;/);
  assert.match(plist, /HeiGe&apos;s \$studio/);
  assert.doesNotMatch(plist, /家 & <目录>/);
});

test("replaces only an attributed generated bundle and restores it after publish failure", async (t) => {
  const { home, installRoot } = await fixture(t);
  const first = await installMacosLauncher({ home, installRoot });
  const oldExecutable = await readFile(first.executablePath);
  await assert.rejects(
    installMacosLauncher({
      home,
      installRoot,
      hooks: { afterBackup: async () => { throw new Error("SIMULATED_PUBLISH_FAILURE"); } },
    }),
    /SIMULATED_PUBLISH_FAILURE/,
  );
  assert.deepEqual(await readFile(first.executablePath), oldExecutable);
  const leftovers = (await readdir(join(home, "Applications")))
    .filter((name) => name.includes(".staged.") || name.includes(".backup."));
  assert.deepEqual(leftovers, []);
});

for (const legacySchema of [1, 2]) {
  test(`upgrades an attributed Schema ${legacySchema} bundle and moves its stable install root`, async (t) => {
    const { home, installRoot } = await fixture(t);
    const first = await installMacosLauncher({ home, installRoot });
    const legacyEntrypointName = legacySchema === 1 ? "enable-skin.command" : "apply.command";
    const legacyEntrypoint = join(installRoot, "scripts", legacyEntrypointName);
    await writeFile(legacyEntrypoint, "#!/bin/zsh\nexit 0\n", { mode: 0o755 });
    await chmod(legacyEntrypoint, 0o755);
    await rm(first.appPath, { recursive: true });
    const legacyMacos = join(first.appPath, "Contents", "MacOS");
    await mkdir(legacyMacos, { recursive: true });
    const shellQuotedEntrypoint = `'${legacyEntrypoint.replaceAll("'", `'\"'\"'`)}'`;
    await writeFile(
      join(legacyMacos, "HeiGe Skin Launcher"),
      `#!/bin/zsh\n# HeiGe generated launcher schema ${legacySchema}\nset -euo pipefail\nexec ${shellQuotedEntrypoint}\n`,
      { mode: 0o755 },
    );
    await chmod(join(legacyMacos, "HeiGe Skin Launcher"), 0o755);
    const legacyPlist = renderMacosLauncherPlist(installRoot)
      .replace(/    <key>CFBundleIconFile<\/key>\n    <string>AppIcon\.icns<\/string>\n/, "")
      .replace("<string>5.5.13</string>", "<string>1.0</string>")
      .replace("<string>5.5.13</string>", "<string>1</string>")
      .replace(
        `<key>HeiGeLauncherSchemaVersion</key>\n    <integer>5</integer>`,
        `<key>HeiGeLauncherSchemaVersion</key>\n    <integer>${legacySchema}</integer>`,
      )
      .replace(/    <key>LSMinimumSystemVersion<\/key>\n    <string>13\.0<\/string>\n/, "")
      .replace(/    <key>NSHighResolutionCapable<\/key>\n    <true\/>\n/, "");
    await writeFile(join(first.appPath, "Contents", "Info.plist"), legacyPlist, { mode: 0o644 });
    await chmod(join(first.appPath, "Contents", "Info.plist"), 0o644);

    const nextInstallRoot = join(home, ".codex", `heige-codex-skin-studio-v${legacySchema}`);
    await populateRuntime(nextInstallRoot);
    const upgraded = await installMacosLauncher({ home, installRoot: nextInstallRoot });
    const executable = await readFile(upgraded.executablePath);
    const upgradedPlist = await readFile(upgraded.plistPath, "utf8");
    assert.equal(executable.readUInt32BE(0), 0xcafebabe);
    assert.match(upgradedPlist, /<integer>5<\/integer>/);
    assert.match(upgradedPlist, new RegExp(nextInstallRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(
      upgradedPlist,
      new RegExp(`<string>${installRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<\\/string>`),
    );
    assert.match(upgradedPlist, /<string>5\.5\.13<\/string>/);
    await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--", upgraded.appPath]);
  });
}

test("upgrades an installed Schema 4 launcher that predates the dedicated window logo", async (t) => {
  const { home, installRoot } = await fixture(t, "schema-4-upgrade");
  const first = await installMacosLauncher({ home, installRoot });
  const plistPath = join(first.appPath, "Contents", "Info.plist");
  const resourcesPath = join(first.appPath, "Contents", "Resources");
  const schema4Plist = (await readFile(plistPath, "utf8")).replace(
    `<key>HeiGeLauncherSchemaVersion</key>\n    <integer>5</integer>`,
    `<key>HeiGeLauncherSchemaVersion</key>\n    <integer>4</integer>`,
  );
  await writeFile(plistPath, schema4Plist, { mode: 0o644 });
  await rm(join(resourcesPath, "LauncherLogo.png"));
  await execFileAsync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--", first.appPath]);

  const upgraded = await installMacosLauncher({ home, installRoot });
  assert.match(await readFile(upgraded.plistPath, "utf8"), /<integer>5<\/integer>/);
  assert.deepEqual(
    await readFile(join(resourcesPath, "LauncherLogo.png")),
    await readFile(launcherLogoUrl),
  );
});

test("refuses a foreign destination, symlinked entrypoint, and non-executable entrypoint", async (t) => {
  await t.test("foreign destination", async (t) => {
    const { home, installRoot } = await fixture(t);
    const app = join(home, "Applications", "HeiGe 皮肤启动器.app");
    await mkdir(app, { recursive: true });
    await writeFile(join(app, "foreign.txt"), "do not replace\n");
    await assert.rejects(installMacosLauncher({ home, installRoot }), /归属|generated|bundle/i);
    assert.equal(await readFile(join(app, "foreign.txt"), "utf8"), "do not replace\n");
  });

  await t.test("symlinked entrypoint", async (t) => {
    const { root, home, installRoot, launcherEntrypoint } = await fixture(t);
    const outside = join(root, "outside.command");
    await writeFile(outside, "#!/bin/zsh\n", { mode: 0o755 });
    await rm(launcherEntrypoint);
    await symlink(outside, launcherEntrypoint);
    await assert.rejects(installMacosLauncher({ home, installRoot }), /符号链接|symlink|regular/i);
  });

  await t.test("non-executable entrypoint", async (t) => {
    const { home, installRoot, launcherEntrypoint } = await fixture(t);
    await chmod(launcherEntrypoint, 0o644);
    await assert.rejects(installMacosLauncher({ home, installRoot }), /可执行|executable/i);
  });
});

test("refuses a symlink at the canonical launcher path without touching its target", async (t) => {
  const { root, home, installRoot } = await fixture(t);
  const applications = join(home, "Applications");
  const outside = join(root, "outside-app");
  await mkdir(applications, { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "foreign\n");
  await symlink(outside, join(applications, "HeiGe 皮肤启动器.app"));
  await assert.rejects(installMacosLauncher({ home, installRoot }), /符号链接|symlink/i);
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "foreign\n");
  assert.equal((await lstat(join(applications, "HeiGe 皮肤启动器.app"))).isSymbolicLink(), true);
});

test("refuses extra bundle content and a nested directory symlink without deleting foreign data", async (t) => {
  await t.test("extra content", async (t) => {
    const { home, installRoot } = await fixture(t);
    const result = await installMacosLauncher({ home, installRoot });
    const extra = join(result.appPath, "Contents", "foreign.txt");
    await writeFile(extra, "preserve me\n");
    await assert.rejects(installMacosLauncher({ home, installRoot }), /额外内容|归属|generated/i);
    assert.equal(await readFile(extra, "utf8"), "preserve me\n");
  });

  await t.test("nested directory symlink", async (t) => {
    const { root, home, installRoot } = await fixture(t);
    const result = await installMacosLauncher({ home, installRoot });
    const macos = join(result.appPath, "Contents", "MacOS");
    const outside = join(root, "foreign-macos");
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "preserve me\n");
    await rm(macos, { recursive: true });
    await symlink(outside, macos);
    await assert.rejects(installMacosLauncher({ home, installRoot }), /符号链接|归属|generated/i);
    assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "preserve me\n");
    assert.equal((await lstat(macos)).isSymbolicLink(), true);
  });

  await t.test("nested executable symlink", async (t) => {
    const { root, home, installRoot } = await fixture(t);
    const result = await installMacosLauncher({ home, installRoot });
    const outside = join(root, "foreign-executable");
    await writeFile(outside, "#!/bin/zsh\nexit 0\n", { mode: 0o755 });
    await rm(result.executablePath);
    await symlink(outside, result.executablePath);
    await assert.rejects(installMacosLauncher({ home, installRoot }), /归属|generated|符号链接/i);
    assert.equal(await readFile(outside, "utf8"), "#!/bin/zsh\nexit 0\n");
    assert.equal((await lstat(result.executablePath)).isSymbolicLink(), true);
  });

  await t.test("signature content injected after signing", async (t) => {
    const { home, installRoot } = await fixture(t);
    const result = await installMacosLauncher({ home, installRoot });
    const extra = join(result.appPath, "Contents", "_CodeSignature", "foreign.signature");
    await writeFile(extra, "foreign\n");
    await assert.rejects(
      installMacosLauncher({ home, installRoot }),
      /signature|额外内容|归属|generated/i,
    );
    assert.equal(await readFile(extra, "utf8"), "foreign\n");
  });

  await t.test("icon changed after signing", async (t) => {
    const { home, installRoot } = await fixture(t);
    const result = await installMacosLauncher({ home, installRoot });
    const iconPath = join(result.appPath, "Contents", "Resources", "AppIcon.icns");
    const changed = Buffer.from(await readFile(iconPath));
    changed[changed.length - 1] ^= 0xff;
    await writeFile(iconPath, changed);
    await assert.rejects(
      installMacosLauncher({ home, installRoot }),
      /codesign|signature|归属|generated/i,
    );
    assert.deepEqual(await readFile(iconPath), changed);
  });

  await t.test("window logo changed after signing", async (t) => {
    const { home, installRoot } = await fixture(t);
    const result = await installMacosLauncher({ home, installRoot });
    const logoPath = join(result.appPath, "Contents", "Resources", "LauncherLogo.png");
    const changed = Buffer.from(await readFile(logoPath));
    changed[changed.length - 1] ^= 0xff;
    await writeFile(logoPath, changed);
    await assert.rejects(
      installMacosLauncher({ home, installRoot }),
      /codesign|signature|归属|generated/i,
    );
    assert.deepEqual(await readFile(logoPath), changed);
  });
});

test("rejects path control characters and lone UTF-16 surrogates before writing output", async () => {
  assert.throws(() => renderMacosLauncherExecutable("/tmp/bad\npath"), /控制字符/);
  assert.throws(() => renderMacosLauncherPlist("/tmp/bad\u0001path"), /控制字符/);
  assert.throws(() => renderMacosLauncherPlist("/tmp/bad\ud800path"), /控制字符/);
});

test("serializes concurrent installers with an owned cross-process lock", async (t) => {
  const { home, installRoot } = await fixture(t);
  await installMacosLauncher({ home, installRoot });
  let signalBackup;
  let continuePublish;
  const reachedBackup = new Promise((resolve) => { signalBackup = resolve; });
  const publishGate = new Promise((resolve) => { continuePublish = resolve; });
  const first = installMacosLauncher({
    home,
    installRoot,
    hooks: {
      afterBackup: async () => {
        signalBackup();
        await publishGate;
      },
    },
  });
  await reachedBackup;
  try {
    await assert.rejects(
      installMacosLauncher({ home, installRoot }),
      /另一个 HeiGe 皮肤启动器安装仍在进行/,
    );
  } finally {
    continuePublish();
  }
  await first;
});

test("launcher lock reclaims a reused live PID with a different start identity", async (t) => {
  const { home } = await fixture(t);
  const applications = join(home, "Applications");
  const lockPath = join(applications, ".heige-codex-skin-launcher-install.lock");
  await mkdir(lockPath, { recursive: true, mode: 0o700 });
  await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({
    schemaVersion: 2,
    pid: process.pid,
    startedAt: "old-process-start",
    nonce: "123e4567-e89b-42d3-a456-426614174000",
  })}\n`, { mode: 0o600 });
  const current = { pid: process.pid, startedAt: "new-process-start" };

  const lock = await acquireMacosLauncherInstallLock({
    home,
    readProcessIdentity: async () => current,
  });
  await lock.release();
  await assert.rejects(lstat(lockPath), /ENOENT/);
});

for (const scenario of ["dead", "live", "unreadable"]) {
  test(`launcher lock handles schema-1 ${scenario} owners fail-closed`, async (t) => {
    const { home } = await fixture(t);
    const applications = join(home, "Applications");
    const lockPath = join(applications, ".heige-codex-skin-launcher-install.lock");
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    const legacyPid = 991002;
    await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({
      schemaVersion: 1,
      pid: legacyPid,
      nonce: "123e4567-e89b-42d3-a456-426614174000",
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
      const lock = await acquireMacosLauncherInstallLock({ home, readProcessIdentity: identityReader });
      const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
      assert.equal(owner.schemaVersion, 2);
      await lock.release();
      return;
    }
    await assert.rejects(
      acquireMacosLauncherInstallLock({ home, readProcessIdentity: identityReader }),
      scenario === "live"
        ? /仍在进行/
        : (error) => error?.code === "EACCES" || error?.cause?.code === "EACCES",
    );
    assert.equal((await lstat(lockPath)).isDirectory(), true);
  });
}

test("recovers a backed-up launcher and stale lock after the installer is SIGKILLed", async (t) => {
  const { root, home, installRoot } = await fixture(t);
  const initial = await installMacosLauncher({ home, installRoot });
  const original = await readFile(initial.executablePath);
  const marker = join(root, "after-backup.marker");
  const childScript = join(root, "crash-installer.mjs");
  await writeFile(childScript, `
import { writeFile } from "node:fs/promises";
const { installMacosLauncher } = await import(${JSON.stringify(launcherModuleUrl)});
const [home, installRoot, marker] = process.argv.slice(2);
await installMacosLauncher({
  home,
  installRoot,
  hooks: { afterBackup: async () => {
    await writeFile(marker, "ready\\n");
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  } },
});
`);
  const child = spawn(process.execPath, [childScript, home, installRoot, marker], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let markerReady = false;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await access(marker);
      markerReady = true;
      break;
    } catch {
      if (child.exitCode !== null) break;
      await delay(10);
    }
  }
  assert.equal(markerReady, true, `child did not reach backup phase: ${stderr}`);
  const exited = once(child, "exit");
  assert.equal(child.kill("SIGKILL"), true);
  const [, signal] = await exited;
  assert.equal(signal, "SIGKILL");

  const recovered = await installMacosLauncher({ home, installRoot });
  assert.deepEqual(await readFile(recovered.executablePath), original);
  const leftovers = (await readdir(join(home, "Applications"))).filter((name) => (
    name.includes(".backup.")
    || name.includes(".staged.")
    || name === ".heige-codex-skin-launcher-transaction.json"
    || name === ".heige-codex-skin-launcher-install.lock"
  ));
  assert.deepEqual(leftovers, []);
});

test("generated Info.plist passes the macOS plist validator", {
  skip: process.platform !== "darwin" && "requires macOS plutil",
}, async (t) => {
  const { home, installRoot } = await fixture(t);
  const result = await installMacosLauncher({ home, installRoot });
  const { stdout } = await execFileAsync("plutil", ["-lint", result.plistPath]);
  assert.match(stdout, /OK/);
});

test("preserves both the operation and lock-release errors", async (t) => {
  const { home, installRoot } = await fixture(t);
  await installMacosLauncher({ home, installRoot });
  const ownerPath = join(
    home,
    "Applications",
    ".heige-codex-skin-launcher-install.lock",
    "owner.json",
  );
  await assert.rejects(
    installMacosLauncher({
      home,
      installRoot,
      hooks: {
        afterPublish: async () => {
          await writeFile(ownerPath, '{"foreign":true}\n', { mode: 0o600 });
          throw new Error("SIMULATED_OPERATION_FAILURE");
        },
      },
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.match(error.message, /operation.*lock/i);
      assert.equal(error.errors.length, 2);
      assert.match(error.errors[0].message, /SIMULATED_OPERATION_FAILURE/);
      assert.match(error.errors[1].message, /ownership|安全释放/);
      return true;
    },
  );
});
