import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";

import {
  inspectTrustedProductionRuntime,
  inspectLaunchAgent,
  isExactLaunchctlPrintNotFound,
  registerControllerAgent,
  trustedUserHome,
  unregisterControllerAgent,
} from "../src/macos-launch-agent.mjs";

const execFileAsync = promisify(execFile);
const enabled = process.platform === "darwin" && process.env.HEIGE_RUN_LAUNCHD_INTEGRATION === "1";
const liveRuntimeEnabled = process.platform === "darwin" && process.env.HEIGE_RUN_LIVE_MAC_RUNTIME === "1";

test("the current Mac resolves a trusted signed production runtime", { skip: !liveRuntimeEnabled }, async () => {
  const trustedRuntime = await inspectTrustedProductionRuntime();
  assert.match(trustedRuntime.nodePath, /\/Contents\/Resources\/cua_node\/bin\/node$/);
  assert.equal(
    trustedRuntime.controllerPath,
    join(trustedUserHome(), ".codex", "heige-codex-skin-studio", "src", "cli.mjs"),
  );
});

test("isolated random-label LaunchAgent can be registered and removed", { skip: !enabled }, async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "heige-launchd-integration-")),
  );
  const label = `com.heige.codex-skin-controller.test.${randomUUID()}`;
  const processUid = process.getuid();
  const options = {
    home: root,
    launchAgentsDir: join(root, "Library", "LaunchAgents"),
    stateDir: join(root, "state"),
    label,
    processUid,
    programArguments: ["/bin/sleep", "60"],
    testMode: true,
  };

  t.after(async () => {
    const errors = [];
    let loaded = false;
    try {
      await execFileAsync("/bin/launchctl", ["print", `gui/${processUid}/${label}`]);
      loaded = true;
    } catch (error) {
      if (!isExactLaunchctlPrintNotFound(error, { label, processUid })) errors.push(error);
    }
    if (loaded) {
      try {
        await execFileAsync("/bin/launchctl", ["bootout", `gui/${processUid}/${label}`]);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await unregisterControllerAgent(options);
    } catch (error) {
      errors.push(error);
    }
    try {
      await execFileAsync("/bin/launchctl", ["print", `gui/${processUid}/${label}`]);
      errors.push(new Error(`cleanup left LaunchAgent loaded: ${label}`));
    } catch (error) {
      if (!isExactLaunchctlPrintNotFound(error, { label, processUid })) errors.push(error);
    }
    try {
      await rm(root, { recursive: true, force: true });
      await assert.rejects(stat(root), (error) => error.code === "ENOENT");
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `isolated LaunchAgent cleanup failed for ${label}`);
    }
  });

  await registerControllerAgent(options);
  assert.equal((await inspectLaunchAgent(options)).loaded, true);
  await unregisterControllerAgent(options);
  assert.equal((await inspectLaunchAgent(options)).loaded, false);
});
