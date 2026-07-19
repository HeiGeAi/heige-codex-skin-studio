import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyWindowsPreflightSnapshot,
  decodeWindowsAppIdentityToken,
  queryWindowsRuntimeSnapshot,
} from "../src/windows-runtime.mjs";
import {
  createWindowsSecurityAdapter,
  windowsAclPowerShellScript,
} from "../src/windows-secure-fs.mjs";

const APP = Object.freeze({
  kind: "Win32",
  executablePath: "C:\\Program Files\\Codex\\Codex.exe",
  installPath: "C:\\Program Files\\Codex",
  productName: "Codex",
  packageFullName: null,
  aumid: null,
  launchTarget: "C:\\Program Files\\Codex\\Codex.exe",
});

function processRecord(overrides = {}) {
  return {
    pid: 4242,
    parentProcessId: 100,
    executablePath: APP.executablePath,
    startedAt: "2026-07-17T08:00:00.0000000Z",
    ...overrides,
  };
}

function listenerRecord(overrides = {}) {
  const process = processRecord();
  return {
    pid: process.pid,
    executablePath: process.executablePath,
    startedAt: process.startedAt,
    processName: "Codex",
    localAddress: "127.0.0.1",
    localPort: 9341,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    app: APP,
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    processes: [],
    listeners: [],
    ...overrides,
  };
}

function appIdentityToken(app = APP) {
  const document = {
    schemaVersion: 1,
    product: "heige-codex-skin-studio",
    kind: app.kind,
    executablePath: app.executablePath,
    installPath: app.installPath,
    productName: app.productName,
    packageFullName: app.packageFullName,
    aumid: app.aumid,
  };
  return Buffer.from(JSON.stringify(document), "utf8").toString("base64url");
}

test("Windows runtime query uses one trusted PowerShell command and accepts only strict JSON", async () => {
  const calls = [];
  const expected = snapshot();
  const env = {
    SystemRoot: "C:\\Windows",
    PATH: "C:\\Windows\\System32",
    PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules",
  };
  const result = await queryWindowsRuntimeSnapshot({
    port: 9341,
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    commonScriptPath: "C:\\repo\\scripts\\windows\\lib\\common.ps1",
    env,
    execFileImpl: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: `${JSON.stringify(expected)}\r\n`, stderr: "" };
    },
  });
  assert.deepEqual(result, expected);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(calls[0].args.includes("C:\\repo\\scripts\\windows\\lib\\common.ps1"), true);
  assert.equal(calls[0].args.includes("9341"), true);
  assert.deepEqual(calls[0].options, {
    env: {
      SystemRoot: "C:\\Windows",
      PATH: "C:\\Windows\\System32",
    },
    timeout: 15_000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
  assert.equal(env.PSModulePath, "C:\\Program Files\\PowerShell\\7\\Modules");

  await assert.rejects(queryWindowsRuntimeSnapshot({
    port: 9341,
    powershellPath: calls[0].file,
    commonScriptPath: "C:\\repo\\scripts\\windows\\lib\\common.ps1",
    execFileImpl: async () => ({ stdout: `${JSON.stringify(expected)}\nnoise`, stderr: "" }),
  }), /JSON|stdout|snapshot/i);
  await assert.rejects(queryWindowsRuntimeSnapshot({
    port: 9341,
    powershellPath: calls[0].file,
    commonScriptPath: "C:\\repo\\scripts\\windows\\lib\\common.ps1",
    execFileImpl: async () => ({
      stdout: JSON.stringify({ ...expected, unexpected: true }),
      stderr: "",
    }),
  }), /schema|field|snapshot/i);
});

test("Windows runtime binds every query to the immutable PowerShell app identity", async () => {
  const expected = snapshot();
  const token = appIdentityToken();
  const calls = [];
  const result = await queryWindowsRuntimeSnapshot({
    port: 9341,
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    commonScriptPath: "C:\\repo\\scripts\\windows\\lib\\common.ps1",
    env: { HEIGE_WINDOWS_APP_IDENTITY: token },
    execFileImpl: async (file, args) => {
      calls.push({ file, args });
      return { stdout: JSON.stringify(expected), stderr: "" };
    },
  });
  assert.deepEqual(result.app, APP);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.at(-1), token);

  await assert.rejects(queryWindowsRuntimeSnapshot({
    port: 9341,
    powershellPath: calls[0].file,
    commonScriptPath: "C:\\repo\\scripts\\windows\\lib\\common.ps1",
    env: { HEIGE_WINDOWS_APP_IDENTITY: token },
    execFileImpl: async () => ({
      stdout: JSON.stringify(snapshot({
        app: {
          ...APP,
          executablePath: "C:\\Program Files\\ChatGPT\\ChatGPT.exe",
          installPath: "C:\\Program Files\\ChatGPT",
          productName: "ChatGPT",
          launchTarget: "C:\\Program Files\\ChatGPT\\ChatGPT.exe",
        },
      })),
      stderr: "",
    }),
  }), /identity|attribution|app/i);

  await assert.rejects(queryWindowsRuntimeSnapshot({
    port: 9341,
    powershellPath: calls[0].file,
    commonScriptPath: "C:\\repo\\scripts\\windows\\lib\\common.ps1",
    env: { HEIGE_WINDOWS_APP_IDENTITY: "not-canonical+base64" },
    execFileImpl: async () => {
      throw new Error("malformed identity must fail before PowerShell");
    },
  }), /identity|token|base64/i);

  await assert.rejects(queryWindowsRuntimeSnapshot({
    port: 9341,
    powershellPath: calls[0].file,
    commonScriptPath: "C:\\repo\\scripts\\windows\\lib\\common.ps1",
    env: { HEIGE_WINDOWS_APP_IDENTITY: token },
    execFileImpl: async () => ({
      stdout: JSON.stringify(snapshot({
        processes: [processRecord({
          executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_2.0.0.0_x64__abc\\Codex.exe",
        })],
      })),
      stderr: "",
    }),
  }), /process path|belong|identity|app/i);
});

test("Windows identity token rejects duplicate and unknown JSON fields", () => {
  const canonical = Buffer.from(appIdentityToken(), "base64url").toString("utf8");
  const duplicate = canonical.replace(
    '"schemaVersion":1',
    '"schemaVersion":1,"schemaVersion":1',
  );
  const unknown = canonical.replace(
    '"product":"heige-codex-skin-studio"',
    '"product":"heige-codex-skin-studio","unknown":true',
  );
  for (const document of [duplicate, unknown]) {
    const token = Buffer.from(document, "utf8").toString("base64url");
    assert.throws(() => decodeWindowsAppIdentityToken(token), /canonical|schema|unknown|identity/i);
  }
});

test("Windows ACL adapter protects files explicitly and bounds trusted PowerShell", async () => {
  const calls = [];
  const path = "C:\\Users\\Alice\\AppData\\Roaming\\HeiGeCodexSkinStudio\\owner.json";
  const adapter = createWindowsSecurityAdapter({
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    execFileImpl: async (file, args, options) => {
      calls.push({ file, args, options });
      const payload = JSON.parse(Buffer.from(args.at(-1), "base64").toString("utf8"));
      return {
        stdout: JSON.stringify({
          schemaVersion: 1,
          results: payload.operations.map((operation) => ({
            schemaVersion: 1,
            action: operation.action,
            path: operation.path,
            ownerSid: "S-1-5-21-1",
            private: true,
          })),
        }),
        stderr: "",
      };
    },
  });
  await adapter.protectFile(path);
  await adapter.migrateFile(path);
  await adapter.verifyFile(path);
  assert.deepEqual(
    calls.map((entry) => JSON.parse(Buffer.from(entry.args.at(-1), "base64").toString("utf8")).operations[0].action),
    ["protect-file", "migrate-file", "verify-file"],
  );
  assert.equal(calls.every((entry) => entry.file.endsWith("\\powershell.exe")), true);
  assert.equal(calls.every((entry) => entry.options.timeout === 15_000), true);
  assert.equal(calls.every((entry) => entry.options.maxBuffer === 256 * 1024), true);
  assert.equal(calls.every((entry) => entry.options.windowsHide === true), true);
});

test("Windows ACL adapter isolates Windows PowerShell modules from the parent runtime", async () => {
  const calls = [];
  const path = "C:\\Users\\Alice\\AppData\\Roaming\\HeiGeCodexSkinStudio";
  const adapter = createWindowsSecurityAdapter({
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    env: {
      SystemRoot: "C:\\Windows",
      PATH: "C:\\Windows\\System32",
      PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules",
      psMODULEpath: "C:\\Users\\Alice\\Documents\\PowerShell\\Modules",
    },
    execFileImpl: async (file, args, options) => {
      calls.push({ file, args, options });
      const payload = JSON.parse(Buffer.from(args.at(-1), "base64").toString("utf8"));
      return {
        stdout: JSON.stringify({
          schemaVersion: 1,
          results: payload.operations.map((operation) => ({
            schemaVersion: 1,
            action: operation.action,
            path: operation.path,
            ownerSid: "S-1-5-21-1",
            private: true,
          })),
        }),
        stderr: "",
      };
    },
  });

  await adapter.verifyDirectory(path);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env.SystemRoot, "C:\\Windows");
  assert.equal(calls[0].options.env.PATH, "C:\\Windows\\System32");
  assert.equal(
    Object.keys(calls[0].options.env).some((key) => key.toLowerCase() === "psmodulepath"),
    false,
  );
  assert.match(
    windowsAclPowerShellScript,
    /Import-Module[^\n]+\$PSHOME[^\n]+Microsoft\.PowerShell\.Security/,
  );
  assert.match(windowsAclPowerShellScript, /Microsoft\.PowerShell\.Security\\Get-Acl/);
  assert.match(windowsAclPowerShellScript, /Microsoft\.PowerShell\.Security\\Set-Acl/);
});

test("Windows ACL adapter preserves the canonical request path instead of rewriting 8.3 aliases", async () => {
  const path = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\heige-state";
  const ownerPath = `${path}\\owner.json`;
  const powershellPath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const directoryResult = {
    schemaVersion: 1,
    action: "verify-directory",
    path,
    ownerSid: "S-1-5-21-1",
    private: true,
  };
  const fileResult = {
    schemaVersion: 1,
    action: "protect-file",
    path: ownerPath,
    ownerSid: "S-1-5-21-1",
    private: true,
  };
  const adapter = createWindowsSecurityAdapter({
    powershellPath,
    execFileImpl: async (_file, args) => {
      const payload = JSON.parse(Buffer.from(args.at(-1), "base64").toString("utf8"));
      assert.equal(payload.schemaVersion, 1);
      assert.ok(Array.isArray(payload.operations));
      const results = payload.operations.map((operation) => ({
        schemaVersion: 1,
        action: operation.action,
        path: operation.path,
        ownerSid: "S-1-5-21-1",
        private: true,
      }));
      return {
        stdout: JSON.stringify({ schemaVersion: 1, results }),
        stderr: "",
      };
    },
  });

  assert.deepEqual(await adapter.verifyDirectory(path), directoryResult);
  assert.deepEqual(await adapter.batch([
    { action: "verify-directory", path },
    { action: "protect-file", path: ownerPath },
  ]), [directoryResult, fileResult]);
  assert.match(windowsAclPowerShellScript, /\[Console\]::OutputEncoding\s*=\s*\[System\.Text\.Encoding\]::UTF8/);
  assert.match(windowsAclPowerShellScript, /\/inheritance:r\s+\/grant:r\s+\$grant/);
  assert.doesNotMatch(windowsAclPowerShellScript, /\/setowner/);
  assert.match(windowsAclPowerShellScript, /path = \$TargetPath/);
  assert.doesNotMatch(windowsAclPowerShellScript, /path = \[System\.IO\.Path\]::GetFullPath/);
});

test("Windows ACL adapter rejects a rewritten path without reflecting sensitive values", async () => {
  const path = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\heige-state";
  const adapter = createWindowsSecurityAdapter({
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    execFileImpl: async () => ({
      stdout: JSON.stringify({
        schemaVersion: 1,
        results: [{
          schemaVersion: 1,
          action: "verify-directory",
          path: "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\heige-state",
          ownerSid: "S-1-5-21-1",
          private: true,
        }],
      }),
      stderr: "",
    }),
  });

  await assert.rejects(
    adapter.verifyDirectory(path),
    (error) => {
      assert.match(error.message, /invalid result: path$/);
      assert.doesNotMatch(error.message, /RUNNER|runneradmin|S-1-/);
      return true;
    },
  );
});

test("Windows preflight selects one exact root and exact loopback owner", () => {
  const root = processRecord();
  const child = processRecord({ pid: 5252, parentProcessId: root.pid });
  const observed = classifyWindowsPreflightSnapshot(snapshot({
    processes: [root, child],
    listeners: [listenerRecord()],
  }), { port: 9341, requirePort: true });
  assert.deepEqual(observed, {
    appPath: APP.launchTarget,
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    process: {
      pid: root.pid,
      executablePath: root.executablePath,
      startedAt: root.startedAt,
    },
  });
});

test("Windows preflight treats closed and one native root as offline only when the port is free", () => {
  assert.deepEqual(classifyWindowsPreflightSnapshot(snapshot(), {
    port: 9341,
    requirePort: false,
  }).process, null);
  assert.deepEqual(classifyWindowsPreflightSnapshot(snapshot({
    processes: [processRecord()],
  }), { port: 9341, requirePort: false }).process, {
    pid: 4242,
    executablePath: APP.executablePath,
    startedAt: "2026-07-17T08:00:00.0000000Z",
  });
  assert.throws(() => classifyWindowsPreflightSnapshot(snapshot({
    listeners: [listenerRecord()],
  }), { port: 9341, requirePort: false }), /occupied|listener|port/i);
  for (const value of [snapshot(), snapshot({ processes: [processRecord()] })]) {
    assert.throws(
      () => classifyWindowsPreflightSnapshot(value, { port: 9341, requirePort: true }),
      (error) => error.code === "CDP_NOT_OWNED",
    );
  }
});

test("Windows preflight fails closed for ambiguous roots and non-exact listener ownership", () => {
  const root = processRecord();
  for (const value of [
    snapshot({ processes: [root, processRecord({ pid: 5252, parentProcessId: 101 })] }),
    snapshot({ processes: [root], listeners: [listenerRecord({ localAddress: "0.0.0.0" })] }),
    snapshot({ processes: [root], listeners: [listenerRecord(), listenerRecord({ pid: 5252 })] }),
    snapshot({ processes: [root], listeners: [listenerRecord({ startedAt: "2026-07-17T08:01:00.0000000Z" })] }),
    snapshot({ processes: [root], listeners: [listenerRecord({ executablePath: "C:\\Temp\\ChatGPT.exe" })] }),
    snapshot({
      processes: [
        processRecord({ pid: 4242, parentProcessId: 5252 }),
        processRecord({ pid: 5252, parentProcessId: 4242 }),
      ],
    }),
    snapshot({
      processes: [
        root,
        processRecord({ pid: 5252, parentProcessId: 6262 }),
        processRecord({ pid: 6262, parentProcessId: 5252 }),
      ],
    }),
  ]) {
    assert.throws(() => classifyWindowsPreflightSnapshot(value, {
      port: 9341,
      requirePort: value.listeners.length > 0,
    }), /ambiguous|unique|loopback|owner|identity|process/i);
  }
});

test("Windows StoreAumid closed snapshots remain valid with null executablePath", () => {
  const store = snapshot({
    app: {
      kind: "StoreAumid",
      executablePath: null,
      installPath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0.0_x64__abc",
      productName: "Codex",
      packageFullName: "OpenAI.Codex_1.0.0.0_x64__abc",
      aumid: "OpenAI.Codex_abc!App",
      launchTarget: "aumid:OpenAI.Codex_abc!App",
    },
  });
  const result = classifyWindowsPreflightSnapshot(store, { port: 9341, requirePort: false });
  assert.equal(result.appPath, "aumid:OpenAI.Codex_abc!App");
  assert.equal(result.process, null);
});
