import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Window } from "happy-dom";
import { CdpSession, fetchRendererTargets } from "../src/cdp-client.mjs";
import { COMPAT_ANCHORS } from "../src/compat-anchors.mjs";
import { runCompat } from "../src/compat.mjs";
import { executeCli, runCli } from "../src/cli.mjs";
import { readCodexVersion } from "../src/codex-app.mjs";
import { buildSkinCss } from "../src/skin-css.mjs";

const fixtureHtml = (surface) => `
  <div id="root"><aside class="app-shell-left-panel"></aside>
  <main ${surface}>
    <div class="composer-surface-chrome"></div>
    <div data-user-message-bubble></div>
    <div data-local-conversation-final-assistant data-response-annotation-conversation></div>
  </main></div>`;

// 使用真实 CdpSession 和发现函数，仅替换底层网络为内存中的 CDP。
function fixture({ surface = 'data-app-shell-main-surface="default"', missing = null, mode = null, mainCount = 1 } = {}) {
  const window = new Window();
  window.document.documentElement.setAttribute("data-codex-window-type", "electron");
  window.document.body.innerHTML = fixtureHtml(surface);
  if (missing) window.document.querySelector(missing).remove();
  const sockets = [];
  const targets = [
    { id: "overlay", url: "app://-/index.html?initialRoute=/avatar-overlay" },
    { id: "foreign", url: "https://example.com/" },
    ...Array.from({ length: mainCount }, (_, index) => ({ id: `main${index}`, url: "app://-/index.html" })),
  ].map((target) => ({ ...target, type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:49341/devtools/page/${target.id}` }));
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.commands = [];
      this.closed = false;
      sockets.push(this);
      queueMicrotask(() => this.onopen());
    }
    send(text) {
      const message = JSON.parse(text);
      this.commands.push(message.method);
      let result = {};
      if (message.method === "Runtime.evaluate") {
        if (mode === "evaluate-error" || (mode === "second-error" && this.url.endsWith("main1"))) {
          result = { exceptionDetails: { text: "fake evaluation failure" } };
        } else {
          result = { result: { value: mode === "malformed" ? [] : window.eval(message.params.expression) } };
        }
      }
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id: message.id, result }) }));
    }
    close() { this.closed = true; this.readyState = 3; }
  }
  const deps = {
    now: () => new Date("2026-09-28T00:00:00.000Z"),
    readVersion: async () => "26.908.4834.0",
    fetchRendererTargets: (port) => fetchRendererTargets(port, {
      fetchImpl: async (url) => {
        assert.equal(url, "http://127.0.0.1:49341/json/list");
        if (mode === "discovery-error") throw new Error("fake connection refused");
        return { ok: true, json: async () => targets };
      },
    }),
    Session: class extends CdpSession {
      constructor(url) { super(url, { WebSocketImpl: FakeSocket }); }
    },
  };
  return { deps, sockets, window };
}

test("every compat candidate is a real skin selector and anchor ids are unique", async () => {
  const css = buildSkinCss({ theme: { id: "test" }, heroDataUrl: "data:image/png;base64,AA" });
  const menu = await readFile(new URL("../src/skin-menu.mjs", import.meta.url), "utf8");
  assert.equal(new Set(COMPAT_ANCHORS.map((anchor) => anchor.id)).size, COMPAT_ANCHORS.length);
  for (const anchor of COMPAT_ANCHORS) {
    assert.ok(anchor.description && anchor.impact && anchor.selectors.length);
    for (const selector of anchor.selectors) {
      assert.ok(css.includes(selector) || menu.includes(selector), `${anchor.id}: ${selector} drifted`);
    }
  }
});

for (const surface of ['class="main-surface"', 'class="browser-main-surface"', 'data-app-shell-main-surface="default"', 'class="_MainContentSurface_abc" data-app-shell-main-surface="default"']) {
  test(`compat accepts supported main surface ${surface}`, async (t) => {
    const fx = fixture({ surface });
    t.after(() => fx.window.happyDOM.close());
    const before = fx.window.document.documentElement.outerHTML;
    const report = await runCompat({ port: 49341, deps: fx.deps });
    assert.equal(report.ok, true);
    assert.equal(report.codexVersion, "26.908.4834.0");
    assert.equal(report.timestamp, "2026-09-28T00:00:00.000Z");
    assert.equal(report.targets.length, 1);
    const anchors = report.targets[0].anchors;
    assert.equal(anchors.find((anchor) => anchor.id === "assistant-response").count, 1, "overlapping candidates count distinct nodes");
    assert.equal(anchors.find((anchor) => anchor.id === "main-surface").candidates.length, 3);
    assert.equal(fx.sockets.length, 1, "overlay and foreign pages must never be connected");
    assert.deepEqual(fx.sockets[0].commands, ["Runtime.enable", "Page.enable", "Runtime.evaluate"]);
    assert.equal(fx.sockets[0].closed, true);
    assert.equal(fx.window.document.documentElement.outerHTML, before);
  });
}

test("renamed-only surface fails while other anchors remain available", async (t) => {
  const fx = fixture({ surface: 'class="_MainContentSurface_changed"' });
  t.after(() => fx.window.happyDOM.close());
  const report = await runCompat({ port: 49341, deps: fx.deps });
  assert.equal(report.ok, false);
  assert.deepEqual(report.targets[0].anchors.filter((anchor) => !anchor.ok).map((anchor) => anchor.id), ["main-surface"]);
});

for (const mode of ["discovery-error", "evaluate-error", "malformed", "second-error"]) {
  test(`compat reports ${mode} without a false pass and closes sessions`, async (t) => {
    const fx = fixture({ mode, mainCount: 2 });
    t.after(() => fx.window.happyDOM.close());
    const report = await runCompat({ port: 49341, deps: fx.deps });
    assert.equal(report.ok, false);
    assert.ok(report.error || report.targets.some((target) => target.error));
    assert.ok(fx.sockets.every((socket) => socket.closed));
    if (mode === "second-error") {
      assert.equal(report.targets[0].ok, true);
      assert.equal(report.targets[1].ok, false);
    }
  });
}

test("no main target fails; unavailable version remains explicit", async (t) => {
  const fx = fixture({ mainCount: 0 });
  t.after(() => fx.window.happyDOM.close());
  fx.deps.readVersion = async () => { throw new Error("missing metadata"); };
  const report = await runCompat({ port: 49341, deps: fx.deps });
  assert.equal(report.ok, false);
  assert.equal(report.codexVersion, null);
  assert.equal(report.warnings.length, 1);
  assert.match(report.error, /主窗口/);
  assert.equal(fx.sockets.length, 0);
});

for (const json of [false, true]) {
  for (const missing of [null, ".composer-surface-chrome"]) {
    test(`CLI output and exit code json=${json}, missing=${missing}`, async (t) => {
      const fx = fixture({ missing });
      t.after(() => fx.window.happyDOM.close());
      let output = "";
      const io = { stdout: { write: (value) => { output += value; } }, stderr: { write: assert.fail }, exitCode: 0 };
      await executeCli(["compat", "--app", "codex", "--port", "49341", ...(json ? ["--json"] : [])], { compatDeps: fx.deps }, io);
      assert.equal(io.exitCode, missing ? 1 : 0);
      if (json) assert.equal(JSON.parse(output).ok, !missing);
      else {
        assert.match(output, /Codex DOM 兼容巡检/);
        assert.match(output, missing ? /❌ composer：0/ : /✅ composer：1/);
      }
    });
  }
}

test("CLI advertises compat, rejects wrong product and invalid flags before connecting", async () => {
  assert.ok((await runCli(["help"])).commands.includes("compat [--port 9341] [--json]"));
  await assert.rejects(runCli(["compat", "--app", "workbuddy"]), /只支持 Codex/);
  await assert.rejects(runCli(["compat", "--port", "1"]), /port|端口/);
  await assert.rejects(runCli(["compat", "--json", "--json"]), /重复参数/);
  await assert.rejects(runCli(["compat", "--restart"]), /无法识别/);
  let output = "";
  const io = { stdout: { write: (value) => { output += value; } }, stderr: { write: assert.fail }, exitCode: 0 };
  await executeCli(["compat", "--json", "--port", "invalid"], {}, io);
  assert.equal(io.exitCode, 1);
  assert.equal(JSON.parse(output).ok, false);
});

test("doctor adds a hint without changing diagnosis", async () => {
  const report = await runCli(["doctor"], {
    platform: "darwin",
    discoverCodex: async () => ({ app: "/fake/Codex.app" }),
    runtimeDiagnostics: async () => ({ processRunning: false, portOpen: false }),
  });
  assert.match(report.compatHint, /compat/);
  assert.match(report.diagnosis, /not-running/);
});

test("version reader reuses plist key and distinguishes MSIX metadata from executable version", async () => {
  assert.equal(await readCodexVersion({
    platform: "darwin", appPath: "/fake/Codex.app",
    exec: async (command, args) => {
      assert.equal(command, "/usr/bin/defaults");
      assert.deepEqual(args, ["read", "/fake/Codex.app/Contents/Info", "CFBundleShortVersionString"]);
      return { stdout: "26.908.4834.0\n" };
    },
  }), "26.908.4834.0");
  assert.equal(await readCodexVersion({ platform: "win32", packageFullName: "OpenAI.Codex_26.908.4834.0_x64__abc", exec: assert.fail }), "26.908.4834.0");
  assert.equal(await readCodexVersion({ platform: "darwin", appPath: "/fake", exec: async () => { throw new Error("missing"); } }), null);
  assert.equal(await readCodexVersion({ platform: "win32", executablePath: "C:\\Apps\\O'Brien\\Codex.exe", env: { SystemRoot: "C:\\Windows" }, exec: async (command, args) => {
    assert.match(command, /powershell\.exe$/i);
    assert.ok(args.at(-1).includes("O''Brien"));
    return { stdout: "1.2.3\r\n" };
  } }), "1.2.3");
});

test("Windows canary statically preserves JSON and native exit code without lifecycle calls", async () => {
  const bytes = await readFile(new URL("../scripts/windows/compat-canary.ps1", import.meta.url));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const script = bytes.toString("utf8");
  assert.match(script, /Get-NodeRuntime -App \$app/);
  assert.match(script, /"compat", "--app", "codex"/);
  assert.match(script, /\$cliArguments \+= "--json"/);
  assert.match(script, /exit \$LASTEXITCODE/);
  assert.doesNotMatch(script, /Invoke-HeiGeBatEntrypoint|Start-Process|Stop-Process|Protect-HeiGeStateDirectory/);
});
