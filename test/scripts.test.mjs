import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  launchMacosAppExecutable,
  readMacCdpProcess,
  requestNormalQuit,
  runLifecycleActionFile,
  spawnDetachedLifecycle,
  writeLifecycleActionFile,
} from "../src/lifecycle-helper.mjs";

const run = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const wrapperPath = join(repositoryRoot, "scripts", "lib", "run-cli.zsh");

async function fakeNode(path, version = "v24.14.0") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/zsh
if [[ "\${1:-}" == "--version" ]]; then
  print -r -- "${version}"
  exit 0
fi
if [[ -n "\${HEIGE_NODE_CAPTURE:-}" ]]; then print -r -- "$0" > "$HEIGE_NODE_CAPTURE"; fi
exec "$HEIGE_REAL_NODE" "$@"
`);
  await chmod(path, 0o755);
  return path;
}

async function fakeApp(home, { relativeNode = "Contents/Resources/cua_node/bin/node", version } = {}) {
  const appPath = join(home, "Applications", "ChatGPT.app");
  await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(appPath, "Contents", "MacOS", "ChatGPT"), "fake app\n");
  await fakeNode(join(appPath, relativeNode), version);
  return appPath;
}

test("run-cli accepts a validated explicit app whose path contains Chinese and spaces", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "用户 空格-"));
  const appPath = await fakeApp(home);
  const capture = join(home, "selected-node.txt");
  const { stdout } = await run("/bin/zsh", [wrapperPath, "help"], {
    env: {
      HOME: home,
      PATH: "/usr/bin:/bin",
      HEIGE_CODEX_APP: appPath,
      HEIGE_NODE_CAPTURE: capture,
      HEIGE_REAL_NODE: process.execPath,
    },
  });
  t.after(async () => {});
  assert.match(stdout, /commands/);
  assert.equal((await readFile(capture, "utf8")).trim(), join(appPath, "Contents/Resources/cua_node/bin/node"));
});

test("run-cli checks the second bundled Node location", async () => {
  const home = await mkdtemp(join(tmpdir(), "heige-node-second-"));
  const appPath = await fakeApp(home, { relativeNode: "Contents/Resources/cua_node/node" });
  const capture = join(home, "selected-node.txt");
  await run("/bin/zsh", [wrapperPath, "help"], {
    env: {
      HOME: home,
      PATH: "/usr/bin:/bin",
      HEIGE_CODEX_APP: appPath,
      HEIGE_NODE_CAPTURE: capture,
      HEIGE_REAL_NODE: process.execPath,
    },
  });
  assert.equal((await readFile(capture, "utf8")).trim(), join(appPath, "Contents/Resources/cua_node/node"));
});

test("an invalid first bundled candidate does not hide a valid second candidate", async () => {
  const home = await mkdtemp(join(tmpdir(), "heige-node-fallback-"));
  const appPath = await fakeApp(home, {
    relativeNode: "Contents/Resources/cua_node/bin/node",
    version: "v20.19.4",
  });
  await fakeNode(join(appPath, "Contents/Resources/cua_node/node"), "v24.14.0");
  const capture = join(home, "selected-node.txt");
  const { stdout } = await run("/bin/zsh", [wrapperPath, "help"], {
    env: {
      HOME: home,
      PATH: "/usr/bin:/bin",
      HEIGE_CODEX_APP: appPath,
      HEIGE_NODE_CAPTURE: capture,
      HEIGE_REAL_NODE: process.execPath,
    },
  });
  assert.match(stdout, /commands/);
  assert.equal((await readFile(capture, "utf8")).trim(), join(appPath, "Contents/Resources/cua_node/node"));
});

test("an invalid explicit Node fails closed without falling back", async () => {
  await assert.rejects(
    run("/bin/zsh", [wrapperPath, "help"], {
      env: {
        HOME: "/tmp",
        PATH: dirname(process.execPath),
        HEIGE_NODE: "/missing/explicit-node",
      },
    }),
    (error) => {
      assert.match(error.stderr, /HEIGE_NODE/);
      return true;
    },
  );
});

test("an invalid explicit app fails closed without probing another runtime", async () => {
  await assert.rejects(
    run("/bin/zsh", [wrapperPath, "help"], {
      env: {
        HOME: "/tmp",
        PATH: dirname(process.execPath),
        HEIGE_CODEX_APP: "/missing/ChatGPT.app",
      },
    }),
    (error) => {
      assert.match(error.stderr, /HEIGE_CODEX_APP/);
      return true;
    },
  );
});

test("a valid HEIGE_NODE cannot hide an invalid explicit app", async () => {
  await assert.rejects(
    run("/bin/zsh", [wrapperPath, "help"], {
      env: {
        HOME: "/tmp",
        PATH: "/usr/bin:/bin",
        HEIGE_NODE: process.execPath,
        HEIGE_CODEX_APP: "/missing/ChatGPT.app",
      },
    }),
    (error) => {
      assert.match(error.stderr, /HEIGE_CODEX_APP/);
      return true;
    },
  );
});

test("run-cli rejects Node 20 and accepts Node 22", async () => {
  const home = await mkdtemp(join(tmpdir(), "heige-node-version-"));
  const oldNode = await fakeNode(join(home, "node20"), "v20.19.4");
  await assert.rejects(
    run("/bin/zsh", [wrapperPath, "help"], {
      env: { HOME: home, PATH: "/usr/bin:/bin", HEIGE_NODE: oldNode },
    }),
    (error) => {
      assert.match(error.stderr, /Node\.js 22/);
      return true;
    },
  );

  const currentNode = await fakeNode(join(home, "node22"), "v22.0.0");
  const capture = join(home, "accepted.txt");
  const { stdout } = await run("/bin/zsh", [wrapperPath, "help"], {
    env: {
      HOME: home,
      PATH: "/usr/bin:/bin",
      HEIGE_NODE: currentNode,
      HEIGE_NODE_CAPTURE: capture,
      HEIGE_REAL_NODE: process.execPath,
    },
  });
  assert.match(stdout, /commands/);
  assert.equal((await readFile(capture, "utf8")).trim(), currentNode);
});

test("lifecycle action files require mode 0600 before any process action", async () => {
  const root = await mkdtemp(join(tmpdir(), "heige-lifecycle-mode-"));
  const path = join(root, "action.json");
  await writeFile(path, JSON.stringify({}), { mode: 0o644 });
  const calls = [];
  await assert.rejects(
    runLifecycleActionFile(path, { requestQuit: async () => calls.push("quit") }),
    /0600/,
  );
  assert.deepEqual(calls, []);
});

test("lifecycle helper quits and launches only the recorded exact process identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "heige-lifecycle-exact-"));
  const path = join(root, "action.json");
  const processIdentity = {
    pid: 4242,
    executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    startedAt: "Fri Jul 17 12:00:00 2026",
  };
  await writeLifecycleActionFile(path, {
    process: processIdentity,
    appPath: "/Applications/ChatGPT.app",
    launchMode: "cdp",
    port: 9341,
  });
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  let probes = 0;
  const calls = [];
  const result = await runLifecycleActionFile(path, {
    readProcessIdentity: async () => (++probes === 1 ? processIdentity : null),
    requestQuit: async (input) => calls.push(["quit", input]),
    launchApp: async (input) => calls.push(["launch", input]),
    wait: async () => {},
    waitForPort: async () => {},
    readCdpProcess: async () => ({
      ...processIdentity,
      pid: 5252,
      startedAt: "Fri Jul 17 12:01:00 2026",
    }),
  });
  assert.deepEqual(result, { launchMode: "cdp", port: 9341, restarted: true });
  assert.equal(calls[0][0], "quit");
  assert.deepEqual(calls[0][1].process, processIdentity);
  assert.deepEqual(calls[1], ["launch", {
    appPath: "/Applications/ChatGPT.app",
    args: ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9341"],
  }]);
});

test("the default normal quit request is PID-bound and never addresses a bundle ID", async () => {
  const calls = [];
  const target = {
    pid: 4242,
    executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    startedAt: "Fri Jul 17 12:00:00 2026",
  };
  await requestNormalQuit({ process: target }, {
    execFile: async (file, args) => calls.push([file, args]),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/usr/bin/osascript");
  assert.equal(calls[0][1].at(-1), "4242");
  assert.doesNotMatch(calls[0][1].join(" "), /com\.openai\.codex|application id/i);
});

test("the default macOS launcher directly spawns the exact app executable", async () => {
  const calls = [];
  const child = new EventEmitter();
  child.pid = 5252;
  child.unref = () => calls.push(["unref"]);
  const launched = launchMacosAppExecutable({
    appPath: "/Applications/ChatGPT.app",
    args: [
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=9341",
    ],
  }, {
    spawnImpl: (command, args, options) => {
      calls.push(["spawn", command, args, options]);
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });

  assert.deepEqual(await launched, { pid: 5252 });
  assert.deepEqual(calls, [
    ["spawn",
      "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      [
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=9341",
      ],
      { detached: true, shell: false, stdio: "ignore" }],
    ["unref"],
  ]);
});

test("lifecycle compensation accepts inherited CDP listener FDs inside the exact app tree", async () => {
  const appPath = "/Applications/ChatGPT.app";
  const executablePath = `${appPath}/Contents/MacOS/ChatGPT`;
  const root = {
    pid: 7001,
    executablePath,
    startedAt: "Fri Jul 17 09:00:00 2026",
    commandLine: `${executablePath} --remote-debugging-port=9341`,
    hasCdp: true,
    cdpPort: 9341,
  };
  const processTable = [
    ` 7001 1 Fri Jul 17 09:00:00 2026 ${root.commandLine}`,
    " 7002 7001 Fri Jul 17 09:00:01 2026 /Users/example/.codex/computer-use/service",
    "",
  ].join("\n");
  const observed = await readMacCdpProcess({ appPath, port: 9341 }, {
    run: async (file) => {
      if (file === "/usr/sbin/lsof") return { stdout: "7001\n7002\n" };
      if (file === "/bin/ps") return { stdout: processTable };
      throw new Error(`unexpected command ${file}`);
    },
    listProcesses: async () => [root],
    readIdentity: async () => ({
      pid: root.pid,
      executablePath: root.executablePath,
      startedAt: root.startedAt,
    }),
  });
  assert.deepEqual(observed, {
    pid: root.pid,
    executablePath: root.executablePath,
    startedAt: root.startedAt,
  });
});

test("lifecycle compensation rejects a CDP listener outside the exact app tree", async () => {
  const appPath = "/Applications/ChatGPT.app";
  const executablePath = `${appPath}/Contents/MacOS/ChatGPT`;
  const root = {
    pid: 7001,
    executablePath,
    startedAt: "Fri Jul 17 09:00:00 2026",
    commandLine: `${executablePath} --remote-debugging-port=9341`,
    hasCdp: true,
    cdpPort: 9341,
  };
  const processTable = [
    ` 7001 1 Fri Jul 17 09:00:00 2026 ${root.commandLine}`,
    " 8001 1 Fri Jul 17 09:00:01 2026 /tmp/foreign-listener",
    "",
  ].join("\n");
  await assert.rejects(readMacCdpProcess({ appPath, port: 9341 }, {
    run: async (file) => {
      if (file === "/usr/sbin/lsof") return { stdout: "7001\n8001\n" };
      if (file === "/bin/ps") return { stdout: processTable };
      throw new Error(`unexpected command ${file}`);
    },
    listProcesses: async () => [root],
    readIdentity: async () => root,
  }), /foreign owner/);
});

test("lifecycle CDP owner attribution rejects incomplete cyclic and drifted process graphs", async (t) => {
  const appPath = "/Applications/ChatGPT.app";
  const executablePath = `${appPath}/Contents/MacOS/ChatGPT`;
  const root = {
    pid: 7001,
    executablePath,
    startedAt: "Fri Jul 17 09:00:00 2026",
    commandLine: `${executablePath} --remote-debugging-port=9341`,
    hasCdp: true,
    cdpPort: 9341,
  };
  const cases = [
    {
      name: "root owner absent",
      owners: [7002],
      rows: [` 7001 1 Fri Jul 17 09:00:00 2026 ${root.commandLine}`],
      pattern: /根进程不唯一/,
    },
    {
      name: "missing ancestor",
      owners: [7001, 7002],
      rows: [
        ` 7001 1 Fri Jul 17 09:00:00 2026 ${root.commandLine}`,
        " 7002 9000 Fri Jul 17 09:00:01 2026 /tmp/inherited-listener",
      ],
      pattern: /foreign owner/,
    },
    {
      name: "cyclic ancestry",
      owners: [7001, 7002],
      rows: [
        ` 7001 1 Fri Jul 17 09:00:00 2026 ${root.commandLine}`,
        " 7002 7003 Fri Jul 17 09:00:01 2026 /tmp/inherited-listener",
        " 7003 7002 Fri Jul 17 09:00:02 2026 /tmp/cycle",
      ],
      pattern: /cyclic/,
    },
    {
      name: "root start identity drift",
      owners: [7001],
      rows: [` 7001 1 Fri Jul 17 09:05:00 2026 ${root.commandLine}`],
      pattern: /identity changed/,
    },
    {
      name: "root command drift",
      owners: [7001],
      rows: [" 7001 1 Fri Jul 17 09:00:00 2026 /tmp/foreign-root"],
      pattern: /identity changed/,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      await assert.rejects(readMacCdpProcess({ appPath, port: 9341 }, {
        run: async (file) => {
          if (file === "/usr/sbin/lsof") {
            return { stdout: `${scenario.owners.join("\n")}\n` };
          }
          if (file === "/bin/ps") return { stdout: `${scenario.rows.join("\n")}\n` };
          throw new Error(`unexpected command ${file}`);
        },
        listProcesses: async () => [root],
        readIdentity: async () => root,
      }), scenario.pattern);
    });
  }
});

test("a replaced PID aborts before quit or launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "heige-lifecycle-replaced-"));
  const path = join(root, "action.json");
  const expected = {
    pid: 4242,
    executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    startedAt: "Fri Jul 17 12:00:00 2026",
  };
  await writeLifecycleActionFile(path, {
    process: expected,
    appPath: "/Applications/ChatGPT.app",
    launchMode: "native",
    port: null,
  });
  const calls = [];
  await assert.rejects(runLifecycleActionFile(path, {
    readProcessIdentity: async () => ({ ...expected, startedAt: "Fri Jul 17 12:01:00 2026" }),
    requestQuit: async () => calls.push("quit"),
    launchApp: async () => calls.push("launch"),
  }), /进程身份/);
  assert.deepEqual(calls, []);
});

test("a detached restart can run only the exact allowlisted CLI continuation after CDP is ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "heige-lifecycle-after-"));
  const path = join(root, "action.json");
  const processIdentity = {
    pid: 4242,
    executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    startedAt: "Fri Jul 17 12:00:00 2026",
  };
  const { action } = await writeLifecycleActionFile(path, {
    process: processIdentity,
    appPath: "/Applications/ChatGPT.app",
    launchMode: "cdp",
    port: 9341,
    afterLaunch: {
      command: "apply",
      cliPath: "/trusted/src/cli.mjs",
      nodePath: "/trusted/node",
      port: 9341,
      themeId: "miku-488137",
    },
  });
  const launchedProcess = {
    ...processIdentity,
    pid: 5252,
    startedAt: "Fri Jul 17 12:01:00 2026",
  };
  let probes = 0;
  const calls = [];
  const result = await runLifecycleActionFile(path, {
    readProcessIdentity: async () => (++probes === 1 ? processIdentity : null),
    requestQuit: async () => calls.push("quit"),
    launchApp: async () => calls.push("launch"),
    wait: async () => {},
    waitForPort: async (port) => calls.push(["port", port]),
    readCdpProcess: async (input) => {
      calls.push(["owner", input]);
      return launchedProcess;
    },
    runAfterLaunch: async (input) => calls.push(["after", input]),
  });
  assert.deepEqual(result, {
    launchMode: "cdp",
    port: 9341,
    restarted: true,
    continuation: "apply",
  });
  assert.deepEqual(calls.slice(-3), [
    ["port", 9341],
    ["owner", {
      appPath: "/Applications/ChatGPT.app",
      port: 9341,
    }],
    ["after", {
      command: "apply",
      cliPath: "/trusted/src/cli.mjs",
      nodePath: "/trusted/node",
      port: 9341,
      themeId: "miku-488137",
    }],
  ]);
  const sidecar = JSON.parse(await readFile(`${path}.result.json`, "utf8"));
  assert.deepEqual(sidecar, {
    schemaVersion: 1,
    action: {
      createdAt: action.createdAt,
      nonce: action.nonce,
      operation: "restart",
    },
    outcome: "succeeded",
    compensated: false,
    error: null,
    completedAt: sidecar.completedAt,
  });
  assert.equal((await stat(`${path}.result.json`)).mode & 0o777, 0o600);
});

test("a detached lifecycle action rejects the removed persistence-enable continuation", async () => {
  const root = await mkdtemp(join(tmpdir(), "heige-lifecycle-legacy-enable-"));
  const path = join(root, "action.json");

  await assert.rejects(writeLifecycleActionFile(path, {
    process: null,
    appPath: "/Applications/ChatGPT.app",
    launchMode: "cdp",
    port: 9341,
    afterLaunch: {
      command: "enable-after-restart",
      cliPath: "/trusted/src/cli.mjs",
      nodePath: "/trusted/node",
      port: 9341,
      themeId: "miku-488137",
    },
  }), /command 不在允许列表/);
});

test("a failed detached continuation restores the exact native prestate and rethrows the original error", async () => {
  const root = await mkdtemp(join(tmpdir(), "heige-lifecycle-native-compensation-"));
  const path = join(root, "action.json");
  const original = {
    pid: 4242,
    executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    startedAt: "Fri Jul 17 12:00:00 2026",
  };
  const launched = {
    pid: 5252,
    executablePath: original.executablePath,
    startedAt: "Fri Jul 17 12:01:00 2026",
  };
  const native = {
    pid: 6262,
    executablePath: original.executablePath,
    startedAt: "Fri Jul 17 12:02:00 2026",
    commandLine: original.executablePath,
    hasCdp: false,
    cdpPort: null,
  };
  const { action } = await writeLifecycleActionFile(path, {
    process: original,
    appPath: "/Applications/ChatGPT.app",
    launchMode: "cdp",
    port: 9341,
    afterLaunch: {
      command: "apply",
      cliPath: "/trusted/src/cli.mjs",
      nodePath: "/trusted/node",
      port: 9341,
      themeId: "miku-488137",
    },
  });
  const continuationError = new Error("apply failed with secret token and /private/input");
  const calls = [];
  let originalProbes = 0;
  let launchedProbes = 0;
  let releaseProbes = 0;
  await assert.rejects(runLifecycleActionFile(path, {
    readProcessIdentity: async (pid) => {
      calls.push(["process", pid]);
      if (pid === original.pid) return ++originalProbes === 1 ? original : null;
      if (pid === launched.pid) return ++launchedProbes === 1 ? launched : null;
      throw new Error(`unexpected pid ${pid}`);
    },
    requestQuit: async ({ process }) => calls.push(["quit", process.pid]),
    launchApp: async ({ args }) => calls.push(["launch", args]),
    wait: async (milliseconds) => calls.push(["wait", milliseconds]),
    waitForPort: async (port) => calls.push(["port", port]),
    runAfterLaunch: async () => { throw continuationError; },
    readCdpProcess: async ({ port }) => {
      calls.push(["cdp-process", port]);
      return launched;
    },
    verifyPortReleased: async (port) => {
      calls.push(["port-released", port]);
      return ++releaseProbes > 1;
    },
    readAppProcesses: async () => {
      calls.push(["app-processes"]);
      return [native];
    },
  }), (error) => error === continuationError);
  assert.deepEqual(calls, [
    ["process", 4242],
    ["quit", 4242],
    ["process", 4242],
    ["launch", ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9341"]],
    ["port", 9341],
    ["cdp-process", 9341],
    ["cdp-process", 9341],
    ["process", 5252],
    ["quit", 5252],
    ["process", 5252],
    ["port-released", 9341],
    ["wait", 250],
    ["port-released", 9341],
    ["launch", []],
    ["app-processes"],
    ["port-released", 9341],
  ]);
  const sidecarText = await readFile(`${path}.result.json`, "utf8");
  assert.doesNotMatch(sidecarText, /secret token|\/private\/input/);
  const sidecar = JSON.parse(sidecarText);
  assert.deepEqual(sidecar, {
    schemaVersion: 1,
    action: {
      createdAt: action.createdAt,
      nonce: action.nonce,
      operation: "restart",
    },
    outcome: "failed",
    compensated: true,
    error: {
      code: "CONTINUATION_FAILED_COMPENSATED",
      message: "皮肤应用失败，已恢复启动前状态。",
    },
    stage: "compensated",
    diagnostics: {
      launchMode: "cdp",
      hadOriginalProcess: true,
      oldProcessExited: true,
      launchStarted: true,
      portReady: true,
      processVerified: true,
      continuationStarted: true,
      compensationAttempted: true,
    },
    completedAt: sidecar.completedAt,
  });
  assert.equal((await stat(`${path}.result.json`)).mode & 0o777, 0o600);
});

test("a failed detached continuation restores the exact closed prestate and rethrows the original error", async () => {
  const root = await mkdtemp(join(tmpdir(), "heige-lifecycle-closed-compensation-"));
  const path = join(root, "action.json");
  const launched = {
    pid: 5252,
    executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    startedAt: "Fri Jul 17 12:01:00 2026",
  };
  await writeLifecycleActionFile(path, {
    process: null,
    appPath: "/Applications/ChatGPT.app",
    launchMode: "cdp",
    port: 9341,
    afterLaunch: {
      command: "apply",
      cliPath: "/trusted/src/cli.mjs",
      nodePath: "/trusted/node",
      port: 9341,
      themeId: "miku-488137",
    },
  });
  const continuationError = new Error("closed apply failed");
  const calls = [];
  let launchedProbes = 0;
  await assert.rejects(runLifecycleActionFile(path, {
    readProcessIdentity: async (pid) => {
      calls.push(["process", pid]);
      return ++launchedProbes === 1 ? launched : null;
    },
    requestQuit: async ({ process }) => calls.push(["quit", process.pid]),
    launchApp: async ({ args }) => calls.push(["launch", args]),
    wait: async () => {},
    waitForPort: async (port) => calls.push(["port", port]),
    runAfterLaunch: async () => { throw continuationError; },
    readCdpProcess: async ({ port }) => {
      calls.push(["cdp-process", port]);
      return launched;
    },
    verifyPortReleased: async (port) => {
      calls.push(["port-released", port]);
      return true;
    },
    readAppProcesses: async () => {
      calls.push(["app-processes"]);
      return [];
    },
  }), (error) => error === continuationError);
  assert.deepEqual(calls, [
    ["launch", ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9341"]],
    ["port", 9341],
    ["cdp-process", 9341],
    ["cdp-process", 9341],
    ["process", 5252],
    ["quit", 5252],
    ["process", 5252],
    ["port-released", 9341],
    ["app-processes"],
    ["port-released", 9341],
  ]);
});

test("a detached compensation failure preserves both errors and writes only a safe failure sidecar", async () => {
  const root = await mkdtemp(join(tmpdir(), "heige-lifecycle-compensation-failed-"));
  const path = join(root, "action.json");
  const launched = {
    pid: 5252,
    executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    startedAt: "Fri Jul 17 12:01:00 2026",
  };
  await writeLifecycleActionFile(path, {
    process: null,
    appPath: "/Applications/ChatGPT.app",
    launchMode: "cdp",
    port: 9341,
    afterLaunch: {
      command: "apply",
      cliPath: "/trusted/src/cli.mjs",
      nodePath: "/trusted/node",
      port: 9341,
      themeId: "miku-488137",
    },
  });
  const continuationError = new Error("original token=private-value");
  const compensationError = new Error("compensation path=/private/user/input");
  await assert.rejects(runLifecycleActionFile(path, {
    launchApp: async () => {},
    waitForPort: async () => {},
    runAfterLaunch: async () => { throw continuationError; },
    readCdpProcess: async () => launched,
    readProcessIdentity: async () => launched,
    requestQuit: async () => { throw compensationError; },
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [continuationError, compensationError]);
    return true;
  });
  const sidecarText = await readFile(`${path}.result.json`, "utf8");
  assert.doesNotMatch(sidecarText, /private-value|\/private\/user\/input/);
  const sidecar = JSON.parse(sidecarText);
  assert.equal(sidecar.outcome, "failed");
  assert.equal(sidecar.compensated, false);
  assert.equal(sidecar.stage, "compensating");
  assert.deepEqual(sidecar.diagnostics, {
    launchMode: "cdp",
    hadOriginalProcess: false,
    oldProcessExited: true,
    launchStarted: true,
    portReady: true,
    processVerified: true,
    continuationStarted: true,
    compensationAttempted: true,
  });
  assert.deepEqual(sidecar.error, {
    code: "CONTINUATION_COMPENSATION_FAILED",
    message: "皮肤应用失败，且未能确认已恢复启动前状态。",
  });
});

test("a launch-only action starts a closed Codex without issuing a quit request", async () => {
  const root = await mkdtemp(join(tmpdir(), "heige-lifecycle-closed-"));
  const path = join(root, "action.json");
  await writeLifecycleActionFile(path, {
    process: null,
    appPath: "/Applications/ChatGPT.app",
    launchMode: "cdp",
    port: 9341,
    afterLaunch: {
      command: "apply",
      cliPath: "/trusted/src/cli.mjs",
      nodePath: "/trusted/node",
      port: 9341,
      themeId: "miku-488137",
    },
  });
  const calls = [];
  const result = await runLifecycleActionFile(path, {
    readProcessIdentity: async () => calls.push("probe"),
    requestQuit: async () => calls.push("quit"),
    launchApp: async () => calls.push("launch"),
    waitForPort: async () => calls.push("port"),
    readCdpProcess: async () => ({
      pid: 5252,
      executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      startedAt: "Fri Jul 17 12:01:00 2026",
    }),
    runAfterLaunch: async () => calls.push("after"),
  });
  assert.equal(result.continuation, "apply");
  assert.deepEqual(calls, ["launch", "port", "after"]);
});

test("native restore fails when the old CDP port remains occupied", async () => {
  const root = await mkdtemp(join(tmpdir(), "heige-lifecycle-native-port-"));
  const path = join(root, "action.json");
  const processIdentity = {
    pid: 4242,
    executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    startedAt: "Fri Jul 17 12:00:00 2026",
  };
  await writeLifecycleActionFile(path, {
    process: processIdentity,
    appPath: "/Applications/ChatGPT.app",
    launchMode: "native",
    port: null,
    verifyPort: 9341,
  });
  let probes = 0;
  await assert.rejects(runLifecycleActionFile(path, {
    readProcessIdentity: async () => (++probes === 1 ? processIdentity : null),
    requestQuit: async () => {},
    launchApp: async () => {},
    wait: async () => {},
    verifyPortReleased: async () => false,
  }), /CDP 端口 9341 仍被占用/);
});

test("detached lifecycle spawn cannot inherit the caller terminal", async () => {
  const calls = [];
  const child = new EventEmitter();
  child.pid = 73001;
  child.unref = () => calls.push("unref");
  const resultPromise = spawnDetachedLifecycle({
    nodePath: "/trusted/node",
    helperPath: "/trusted/lifecycle-helper.mjs",
    actionPath: "/trusted/action.json",
    spawnImpl: (file, args, options) => {
      calls.push({ file, args, options });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  const result = await resultPromise;
  assert.deepEqual(result, { queued: true });
  assert.deepEqual(calls[0], {
    file: "/trusted/node",
    args: ["/trusted/lifecycle-helper.mjs", "/trusted/action.json"],
    options: { detached: true, stdio: "ignore" },
  });
  assert.equal(calls[1], "unref");
});

test("detached lifecycle never reports queued when the child was not spawned", async () => {
  await assert.rejects(spawnDetachedLifecycle({
    nodePath: "/trusted/node",
    helperPath: "/trusted/lifecycle-helper.mjs",
    actionPath: "/trusted/action.json",
    spawnImpl: () => ({ pid: undefined, unref() {} }),
  }), /无法创建 detached/);
});

test("detached lifecycle propagates an asynchronous spawn error", async () => {
  const child = new EventEmitter();
  child.unref = () => assert.fail("failed child must not be detached");
  const queued = spawnDetachedLifecycle({
    nodePath: "/trusted/node",
    helperPath: "/trusted/lifecycle-helper.mjs",
    actionPath: "/trusted/action.json",
    spawnImpl: () => {
      queueMicrotask(() => child.emit("error", new Error("ENOENT")));
      return child;
    },
  });
  await assert.rejects(queued, /ENOENT/);
});

test("detached lifecycle main shows only a bounded safe dialog and rethrows the original error", async () => {
  const module = await import("../src/lifecycle-helper.mjs");
  assert.equal(typeof module.runLifecycleMain, "function");
  assert.equal(typeof module.showLifecycleFailureDialog, "function");
  const original = new Error("token=top-secret path=/private/user/input");
  const dialogs = [];
  await assert.rejects(module.runLifecycleMain("/trusted/action.json", {
    runAction: async () => { throw original; },
    showDialog: async (error) => dialogs.push(error),
  }), (error) => error === original);
  assert.deepEqual(dialogs, [original]);

  const calls = [];
  await module.showLifecycleFailureDialog(original, {
    execFile: async (file, args) => calls.push([file, args]),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/usr/bin/osascript");
  assert.match(calls[0][1].join(" "), /皮肤启动流程失败/);
  assert.match(calls[0][1].join(" "), /displayDialog/);
  assert.doesNotMatch(calls[0][1].join(" "), /top-secret|\/private\/user\/input/);
});

test("macOS launcher defaults to the stored theme and uses an explicit theme only when supplied", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "heige-apply-launcher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scriptsRoot = join(root, "scripts");
  const launcher = join(scriptsRoot, "apply.command");
  const runner = join(scriptsRoot, "lib/run-cli.zsh");
  const capture = join(root, "arguments.txt");
  await mkdir(dirname(runner), { recursive: true });
  await writeFile(
    launcher,
    await readFile(join(repositoryRoot, "scripts/apply.command"), "utf8"),
  );
  await writeFile(runner, '#!/bin/zsh\nprint -rl -- "$@" > "$HEIGE_CAPTURE"\n');
  await chmod(launcher, 0o755);
  await chmod(runner, 0o755);

  await run("/bin/zsh", [launcher], {
    env: { PATH: "/usr/bin:/bin", HEIGE_CAPTURE: capture },
  });
  assert.deepEqual((await readFile(capture, "utf8")).trim().split("\n"), [
    "apply",
    "--prefer-stored",
    "--port",
    "9341",
  ]);

  await run("/bin/zsh", [launcher, "genshin-night"], {
    env: { PATH: "/usr/bin:/bin", HEIGE_CAPTURE: capture },
  });
  assert.deepEqual((await readFile(capture, "utf8")).trim().split("\n"), [
    "apply",
    "--theme",
    "genshin-night",
    "--port",
    "9341",
  ]);
  await run("/bin/zsh", [launcher, "--restart"], {
    env: { PATH: "/usr/bin:/bin", HEIGE_CAPTURE: capture },
  });
  assert.deepEqual((await readFile(capture, "utf8")).trim().split("\n"), [
    "apply",
    "--restart",
    "--prefer-stored",
    "--port",
    "9341",
  ]);

  await run("/bin/zsh", [launcher, "--restart", "genshin-night"], {
    env: { PATH: "/usr/bin:/bin", HEIGE_CAPTURE: capture },
  });
  assert.deepEqual((await readFile(capture, "utf8")).trim().split("\n"), [
    "apply",
    "--restart",
    "--theme",
    "genshin-night",
    "--port",
    "9341",
  ]);

  await assert.rejects(
    run("/bin/zsh", [launcher, "one", "two"], {
      env: { PATH: "/usr/bin:/bin", HEIGE_CAPTURE: capture },
    }),
    (error) => error.code === 64,
  );

  await assert.rejects(
    run("/bin/zsh", [launcher, "--restart", "one", "two"], {
      env: { PATH: "/usr/bin:/bin", HEIGE_CAPTURE: capture },
    }),
    (error) => error.code === 64,
  );
});

test("macOS legacy enable-skin is session-only and enable-persist refuses to fake success", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "heige-option1-launchers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scriptsRoot = join(root, "scripts");
  const libraryRoot = join(scriptsRoot, "lib");
  const capture = join(root, "arguments.txt");
  await mkdir(libraryRoot, { recursive: true });
  for (const name of ["apply.command", "enable-skin.command", "enable-persist.command"]) {
    const destination = join(scriptsRoot, name);
    await writeFile(
      destination,
      await readFile(join(repositoryRoot, "scripts", name), "utf8"),
      { mode: 0o755 },
    );
    await chmod(destination, 0o755);
  }
  const runner = join(libraryRoot, "run-cli.zsh");
  await writeFile(
    runner,
    '#!/bin/zsh\nprint -rl -- "$@" > "$HEIGE_CAPTURE"\n',
    { mode: 0o755 },
  );
  await chmod(runner, 0o755);

  await run("/bin/zsh", [join(scriptsRoot, "enable-skin.command")], {
    env: { PATH: "/usr/bin:/bin", HEIGE_CAPTURE: capture },
  });
  assert.deepEqual((await readFile(capture, "utf8")).trim().split("\n"), [
    "apply",
    "--prefer-stored",
    "--port",
    "9341",
  ]);

  await assert.rejects(
    run("/bin/zsh", [join(scriptsRoot, "enable-persist.command")], {
      env: { PATH: "/usr/bin:/bin", HEIGE_CAPTURE: capture },
    }),
    (error) => {
      assert.match(error.stderr, /顶部.*皮肤常驻.*开关/);
      assert.equal(error.code, 64);
      return true;
    },
  );
});

test("lifecycle shell entrypoints contain no independent process or service mutation", async () => {
  const wrappers = [
    "apply.command",
    "customize.command",
    "pause.command",
    "resume.command",
    "restore.command",
    "disable-persist.command",
    "lib/launch-codex.zsh",
  ];
  for (const relative of wrappers) {
    const source = await readFile(join(repositoryRoot, "scripts", relative), "utf8");
    assert.match(source, /run-cli\.zsh/, relative);
    assert.doesNotMatch(source, /\b(?:launchctl|osascript|curl|pgrep|pkill|kill|nohup|open)\b/, relative);
  }
  const compatibilityEnable = await readFile(join(repositoryRoot, "scripts/enable-skin.command"), "utf8");
  assert.match(compatibilityEnable, /scripts\/apply\.command/);
  assert.doesNotMatch(compatibilityEnable, /set-persistence|enable-after-restart|launchctl/);
  const deprecatedEnable = await readFile(join(repositoryRoot, "scripts/enable-persist.command"), "utf8");
  assert.match(deprecatedEnable, /HEIGE_OPTION1_MENU_ONLY=1/);
  assert.match(deprecatedEnable, /exit 64/);
  assert.doesNotMatch(deprecatedEnable, /run-cli\.zsh|launchctl|set-persistence/);
  const customize = await readFile(join(repositoryRoot, "scripts/customize.command"), "utf8");
  assert.match(customize, /run-cli\.zsh" customize/);
  await assert.rejects(readFile(join(repositoryRoot, "scripts/lib/skin-watchdog.zsh"), "utf8"), /ENOENT/);
  const disabled = await readFile(join(repositoryRoot, "scripts/disable-persist.command"), "utf8");
  assert.match(disabled, /本次皮肤继续使用/);
  assert.match(disabled, /下次启动完全原生/);
});
