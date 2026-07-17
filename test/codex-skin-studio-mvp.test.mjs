import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const require = createRequire(import.meta.url);
let sharp = null;
try { sharp = require("sharp"); } catch { /* Optional Pet image processor is bundled with ChatGPT Desktop. */ }

import { appCandidates, appInfoSync, commandApply, commandErrorCode, commandRestore, commandStatus, css, EXPECTED_TEAM_ID, injectTheme, injectionVerified, isPidRunning, MAIN_TARGET_PROBE, parseArgs, persist, processIds, readState, restartWorker, restartWorkerCore, selectMainTarget, Session, STATUS_EXPRESSION, styleExpression, targets, validateManifest, waitForProcessExit, waitForProcessStart, windowsStoreCandidates } from "../skill/codex-skin-studio/scripts/apply.mjs";
import { applyPort, parseArgs as parseCreateArgs } from "../skill/codex-skin-studio/scripts/create-theme.mjs";
import { buildPlist, buildTaskXml, createControlServer, parseArgs as parsePersistArgs } from "../skill/codex-skin-studio/scripts/persist.mjs";
import { createPet, defaultPetsDir, DEFAULT_PET_CONTRACT, installPet, petStatus, validateContract, validatePetDirectory } from "../skill/codex-skin-studio/scripts/pet.mjs";
import { buildMacOpenSettingsScript, buildWindowsOpenSettingsScript, OPEN_ACCOUNT_MENU_EXPRESSION, OPEN_PETS_PANEL_EXPRESSION, OPEN_SETTINGS_EXPRESSION, PET_UI_STATE_EXPRESSION, petSelectionStateExpression, REFRESH_PETS_EXPRESSION, selectPetExpression } from "../skill/codex-skin-studio/scripts/pet-desktop.mjs";
import { parseArgs as parseVerifyPetContractArgs, verifyPetContract } from "../skill/codex-skin-studio/scripts/verify-pet-contract.mjs";
import { parseArgs as parseVerifyPetArgs, verifyPetDesktop } from "../skill/codex-skin-studio/scripts/verify-pet-desktop.mjs";
import { createPairBundle, switchPairBundle, validatePairBundle } from "../skill/codex-skin-studio/scripts/paired.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const skillRoot = join(repoRoot, "skill/codex-skin-studio");
const applyScript = join(skillRoot, "scripts/apply.mjs");
const createThemeScript = join(skillRoot, "scripts/create-theme.mjs");
const packageScript = join(repoRoot, "scripts/package-codex-skin-studio.mjs");

const validManifest = {
  schemaVersion: 1,
  id: "cyberpunk-night",
  name: "Cyberpunk Night",
  hero: "hero.png",
  colors: { accent: "#00aaff", secondary: "#ff00aa", surface: "#101018", text: "#ffffff" },
};

const observedPetContract = {
  schemaVersion: 1,
  contractVersion: "observed-test-v2",
  status: "observed",
  source: "test",
  spriteVersionNumber: 2,
  grid: { columns: 8, rows: 11 },
  frame: { width: 16, height: 16 },
  spritesheet: { format: ["webp", "png"], colorMode: "rgba" },
  rows: [
    { name: "idle", frames: 6 },
    { name: "running-right", frames: 8 },
    { name: "running-left", frames: 8 },
    { name: "waving", frames: 4 },
    { name: "jumping", frames: 5 },
    { name: "failed", frames: 8 },
    { name: "waiting", frames: 6 },
    { name: "running", frames: 6 },
    { name: "review", frames: 6 },
    { name: "look-000-to-157.5", frames: 8 },
    { name: "look-180-to-337.5", frames: 8 },
  ],
  neutralLookFrame: { row: 0, column: 6 },
  lookDirections: ["000", "022.5", "045", "067.5", "090", "112.5", "135", "157.5", "180", "202.5", "225", "247.5", "270", "292.5", "315", "337.5"],
};

async function withTempDir(prefix, callback) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function makeTheme(root, manifest = validManifest) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "theme.json"), JSON.stringify(manifest));
  await writeFile(join(root, "hero.png"), Buffer.from([1]));
}

async function makePetFrames(root, contract = observedPetContract) {
  const framesRoot = join(root, "frames");
  await mkdir(framesRoot, { recursive: true });
  const pixel = await sharp(Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\"><circle cx=\"8\" cy=\"6\" r=\"4\" fill=\"#ffccaa\"/><rect x=\"5\" y=\"10\" width=\"6\" height=\"5\" rx=\"2\" fill=\"#6750a4\"/></svg>")).png().toBuffer();
  const rows = Object.fromEntries(contract.rows.map((row) => [row.name, { frames: Array.from({ length: row.frames }, (_, index) => `${row.name}-${String(index).padStart(2, "0")}.png`) }]));
  for (const row of contract.rows) for (const frame of rows[row.name].frames) await writeFile(join(framesRoot, frame), pixel);
  const manifestPath = join(framesRoot, "frames.json");
  await writeFile(manifestPath, JSON.stringify({ contractVersion: contract.contractVersion, neutralFrame: rows.idle.frames[0], rows }));
  return manifestPath;
}

test("accepts and normalizes a valid theme manifest", () => {
  assert.deepEqual(validateManifest({ ...validManifest, name: "  Cyberpunk Night  " }), {
    ...validManifest,
    name: "Cyberpunk Night",
    colors: { accent: "#00AAFF", secondary: "#FF00AA", surface: "#101018", text: "#FFFFFF" },
  });
});

test("rejects unsupported fields and invalid manifest values", () => {
  assert.throws(() => validateManifest({ ...validManifest, layers: [] }), /unsupported theme field/);
  assert.throws(() => validateManifest({ ...validManifest, id: "Cyberpunk Night" }), /theme id/);
  assert.throws(() => validateManifest({ ...validManifest, hero: "../hero.png" }), /hero must be/);
  assert.throws(() => validateManifest({ ...validManifest, colors: { ...validManifest.colors, accent: "red" } }), /accent must be/);
  assert.throws(() => validateManifest({ ...validManifest, copy: { brand: "Brand", brandStyle: { preset: "unknown" } } }), /copy.brandStyle.preset/);
});

test("parses command, theme directory, flags, and port", () => {
  assert.deepEqual(parseArgs(["validate", "/tmp/theme", "--port", "1234", "--json", "--restart-normal"]), {
    command: "validate", themeDir: "/tmp/theme", port: 1234, jsonOutput: true, restartNormal: true,
  });
});

test("parses restart-worker arguments without starting a worker", () => {
  assert.deepEqual(parseArgs(["restart-worker", "--port", "4567"]), {
    command: "restart-worker", themeDir: null, port: 4567, jsonOutput: false, restartNormal: false,
  });
});

test("rejects unknown arguments and unsafe ports", () => {
  assert.throws(() => parseArgs(["status", "--wat"]), /unknown argument/);
  assert.throws(() => parseArgs(["status", "--port", "1023"]), /port must be an integer/);
  assert.throws(() => parseArgs(["status", "--port"]), /port must be an integer/);
});

test("parses one-shot theme creation and apply flags", () => {
  const values = parseCreateArgs(["--id", "one-shot", "--apply", "--replace", "--port", "9341"]);
  assert.equal(values.get("apply"), true);
  assert.equal(values.get("replace"), true);
  assert.equal(applyPort(values), 9341);
  assert.throws(() => applyPort(new Map([["port", "1023"]])), /port must be an integer/);
});

test("maps command failures to stable CLI error codes and preserves explicit codes", () => {
  assert.equal(commandErrorCode(new Error("port must be an integer from 1024 through 65535")), "INVALID_PORT");
  assert.equal(commandErrorCode(new Error("theme manifest must be an object")), "THEME_INVALID");
  assert.equal(commandErrorCode(new Error("ChatGPT Desktop application validation failed")), "APP_UNAVAILABLE");
  assert.equal(commandErrorCode(new Error("Codex application validation failed")), "APP_UNAVAILABLE");
  assert.equal(commandErrorCode(new Error("CDP discovery returned HTTP 503")), "CDP_ERROR");
  assert.equal(commandErrorCode(new Error("injection verification failed")), "INJECTION_FAILED");
  assert.equal(commandErrorCode(new Error("main Codex renderer was not found")), "NO_ELIGIBLE_RENDERER");
  assert.equal(commandErrorCode(new Error("unexpected failure")), "COMMAND_FAILED");
  assert.equal(commandErrorCode(Object.assign(new Error("no renderer"), { code: "NO_ELIGIBLE_RENDERER" })), "NO_ELIGIBLE_RENDERER");
  assert.equal(commandErrorCode(Object.assign(new Error("restore failed"), { code: "RESTORE_FAILED" })), "RESTORE_FAILED");
});

test("emits dark CSS variables and a quoted hero URL", () => {
  const value = css(validManifest, "data:image/png;base64,AA\"BB");
  assert.match(value, /color-scheme: dark/);
  assert.match(value, /--codex-skin-accent: #00aaff/);
  assert.match(value, /url\("data:image\/png;base64,AA\\\"BB"\)/);
  assert.match(value, /linear-gradient\(180deg, transparent 0 40%, color-mix\(in srgb, var\(--codex-skin-surface\) 74%, transparent\) 100%\)/);
  assert.match(value, /background: color-mix\(in srgb, var\(--codex-skin-surface\) 88%, transparent\)/);
  assert.match(value, /backdrop-filter: blur\(20px\) saturate\(1\.12\)/);
  assert.match(value, /backdrop-filter: blur\(18px\) saturate\(1\.08\)/);
  const expression = styleExpression(validManifest, `data:image/png;base64,${"A".repeat(600001)}`);
  assert.match(expression, /canvas\.toDataURL\("image\/webp", 0\.82\)/);
  assert.match(expression, /replace\("__CODEX_SKIN_HERO_URL__", heroUrl\)/);
});

test("emits high-contrast workbench tokens for controls, menus, and previews", () => {
  const value = css(validManifest, "data:image/png;base64,AA");
  assert.match(value, /--codex-skin-on-accent: /);
  assert.match(value, /--color-token-dropdown-background: var\(--codex-skin-panel-surface\)/);
  assert.match(value, /--color-token-input-foreground: var\(--codex-skin-text\)/);
  assert.match(value, /button\.size-token-button-composer\.bg-token-foreground/);
  assert.match(value, /\[data-slot="thread-summary-panel-item-button"\]/);
  assert.match(value, /\[data-testid\*="file" i\]/);
  assert.match(value, /::selection/);
});

test("emits the local skin switcher button and control routes", () => {
  const value = css(validManifest, "data:image/png;base64,AA");
  const expression = styleExpression(validManifest, "data:image/png;base64,AA", null, null, [{ id: "miku", name: "Miku" }]);
  assert.match(value, /#codex-skin-studio-switcher/);
  assert.match(value, /top: clamp\(88px, 12vh, 112px\)/);
  assert.match(value, /right: clamp\(156px, 14vw, 208px\)/);
  assert.match(value, /min-width: 104px/);
  assert.match(value, /min-height: 40px/);
  assert.match(value, /z-index: 90/);
  assert.match(value, /z-index: 1000 !important/);
  assert.match(value, /cursor: grab/);
  assert.match(value, /touch-action: none/);
  assert.match(value, /data-native-overlay="true"/);
  assert.match(value, /pointer-events: none/);
  assert.match(expression, /codex-skin-studio-switcher/);
  assert.match(expression, /127\.0\.0\.1:9342\/apply/);
  assert.match(expression, /127\.0\.0\.1:9342\/themes/);
  assert.match(expression, /Miku/);
  assert.match(expression, /window\.open/);
  assert.match(expression, /Switch ChatGPT Desktop skin/);
  assert.match(expression, /shell\?\.remove\(\);\s+shell = null/);
  assert.match(expression, /MutationObserver/);
  assert.match(expression, /aria-haspopup="menu"\]\[aria-expanded="true"/);
  assert.match(expression, /localStorage/);
  assert.match(expression, /pointerdown/);
  assert.match(expression, /pointermove/);
  assert.match(expression, /suppressClick/);
  assert.match(expression, /refreshThemes/);
  assert.match(expression, /cache: "no-store"/);
  assert.match(expression, /setInterval/);
  assert.match(expression, /clearInterval/);
  assert.match(expression, /Local themes \(cached\)/);
});

test("parses the local switcher control port and exposes a loopback control server", async (t) => {
  assert.deepEqual(parsePersistArgs(["persistence-worker", "--port", "9341", "--control-port", "9342", "--json"]), {
    command: "persistence-worker", port: 9341, controlPort: 9342, jsonOutput: true,
  });
  const applied = [];
  const server = createControlServer({
    listThemesFn: async () => [{ id: "miku", name: "Miku", themeDir: "/tmp/miku", colors: validManifest.colors }],
    applyThemeFn: async (themeDir, port) => { applied.push({ themeDir, port }); return { status: "applied", themeId: "miku" }; },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const themes = await (await fetch(`${base}/themes`)).json();
  assert.deepEqual(themes.map(({ id, name }) => ({ id, name })), [{ id: "miku", name: "Miku" }]);
  const response = await fetch(`${base}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "miku" }) });
  assert.deepEqual(await response.json(), { status: "applied", themeId: "miku" });
  const popup = await fetch(`${base}/apply?id=miku`);
  assert.match(await popup.text(), /window\.close/);
  assert.deepEqual(applied, [{ themeDir: "/tmp/miku", port: 9341 }, { themeDir: "/tmp/miku", port: 9341 }]);
});

test("serializes control-server skin applications with the shared apply lock", async (t) => {
  let started;
  const applyStarted = new Promise((resolve) => { started = resolve; });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const applyLock = { active: false };
  const server = createControlServer({
    applyLock,
    listThemesFn: async () => [{ id: "miku", name: "Miku", themeDir: "/tmp/miku", colors: validManifest.colors }],
    applyThemeFn: async () => {
      started();
      await pending;
      return { status: "applied", themeId: "miku" };
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const first = fetch(`${base}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "miku" }) });
  await applyStarted;
  assert.equal(applyLock.active, true);
  const second = await fetch(`${base}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "miku" }) });
  assert.equal(second.status, 400);
  assert.deepEqual(await second.json(), { status: "failed", message: "another skin is being applied" });
  release();
  assert.deepEqual(await (await first).json(), { status: "applied", themeId: "miku" });
  assert.equal(applyLock.active, false);
});

test("emits optional brand logo and polaroid asset layers", () => {
  const value = css(validManifest, "data:image/png;base64,AA", "data:image/png;base64,LOGO", "data:image/png;base64,POLAROID");
  assert.match(value, /nav > div:first-child > div:first-child > button\[aria-haspopup="menu"\]/);
  assert.doesNotMatch(value, /button\[aria-haspopup="menu"\]:first-child/);
  assert.match(value, /background: url\("data:image\/png;base64,LOGO"\)/);
  assert.match(value, /body::after/);
  assert.match(value, /data:image\/png;base64,POLAROID/);
  const expression = styleExpression(validManifest, "data:image/png;base64,AA", "data:image/png;base64,LOGO", "data:image/png;base64,POLAROID");
  assert.match(expression, /logoImage\.decode/);
  assert.match(expression, /polaroidImage\.decode/);
  assert.equal(injectionVerified({ connected: true, themeId: "x", heroLoaded: true, logoLoaded: true, polaroidLoaded: true, cssText: "body{}", cssRules: 1, rootBackground: true }, "x", { logo: true, polaroid: true }), true);
  assert.equal(injectionVerified({ connected: true, themeId: "x", heroLoaded: true, logoLoaded: false, polaroidLoaded: true, cssText: "body{}", cssRules: 1, rootBackground: true }, "x", { logo: true, polaroid: true }), false);
});

test("emits inert brand workbench copy", () => {
  const value = css({ ...validManifest, copy: { brand: "Love Workbench", headline: "Build something personal", tagline: "A layered workbench" } }, "data:image/png;base64,AA");
  assert.match(value, /body::before/);
  assert.match(value, /right: max\(24px, 4vw\)/);
  assert.match(value, /white-space: pre-line/);
  assert.match(value, /content: "Build something personal/);
  assert.match(value, /Build something personal/);
  assert.match(value, /A layered workbench/);
});

test("uses the brand copy as a left navigation fallback without a logo", () => {
  const value = css({ ...validManifest, copy: { brand: "SLAYERS // XELLOS" } }, "data:image/png;base64,AA");
  assert.match(value, /nav > div:first-child > div:first-child > button\[aria-haspopup="menu"\]/);
  assert.match(value, /font-family: "SFMono-Regular"/);
  assert.match(value, /background-clip: text/);
  assert.match(value, /content: "SLAYERS \/\/ XELLOS"/);
  assert.match(value, /box-shadow: 0 0 8px/);
  assert.doesNotMatch(value, /body::before/);
});

test("renders distinct brand typography for selected visual presets", () => {
  const military = css({ ...validManifest, copy: { brand: "PATRIOT // GOLD", brandStyle: { preset: "military" } } }, "data:image/png;base64,AA");
  const romantic = css({ ...validManifest, copy: { brand: "LOVE // DEEPSPACE", brandStyle: { preset: "romantic" } } }, "data:image/png;base64,AA");
  assert.match(military, /font-family: "Arial Narrow"/);
  assert.match(military, /border-top: 1px solid var\(--codex-skin-accent\)/);
  assert.match(romantic, /font-family: "Snell Roundhand"/);
  assert.match(romantic, /font-size: 18px/);
  assert.notEqual(military, romantic);
});

test("emits light color scheme for a light surface", () => {
  const value = css({ ...validManifest, colors: { ...validManifest.colors, surface: "#ffffff", text: "#000000" } }, "data:image/png;base64,AA");
  assert.match(value, /color-scheme: light/);
});

test("validates a local non-empty theme without applying it", async () => {
  await withTempDir("codex-skin-theme-", async (root) => {
    await makeTheme(root);
    const { stdout } = await execFileAsync(process.execPath, [applyScript, "validate", root, "--json"]);
    assert.deepEqual(JSON.parse(stdout), { status: "valid", themeId: validManifest.id, themeDir: root, hero: validManifest.hero });
  });
});

test("validates optional logo and polaroid assets", async () => {
  await withTempDir("codex-skin-assets-", async (root) => {
    await makeTheme(root, { ...validManifest, logo: "logo.png", polaroid: "polaroid.png" });
    await writeFile(join(root, "logo.png"), Buffer.from([2]));
    await writeFile(join(root, "polaroid.png"), Buffer.from([3]));
    const { stdout } = await execFileAsync(process.execPath, [applyScript, "validate", root, "--json"]);
    assert.deepEqual(JSON.parse(stdout), { status: "valid", themeId: validManifest.id, themeDir: root, hero: validManifest.hero, logo: "logo.png", polaroid: "polaroid.png" });
  });
});

test("validates and returns optional brand workbench copy", async () => {
  await withTempDir("codex-skin-copy-", async (root) => {
    await makeTheme(root, { ...validManifest, copy: { brand: "  Brand Lab  ", headline: "  Build with intent  " } });
    const { stdout } = await execFileAsync(process.execPath, [applyScript, "validate", root, "--json"]);
    assert.deepEqual(JSON.parse(stdout).copy, { brand: "Brand Lab", headline: "Build with intent" });
  });
});

test("creates a complete theme directory in one deterministic command", async () => {
  await withTempDir("codex-skin-create-", async (root) => {
    const hero = join(root, "source.webp");
    const logo = join(root, "source-logo.png");
    const themeDir = join(root, "theme");
    const validImage = await readFile(join(skillRoot, "examples/slayers-xellos-night/hero.webp"));
    await writeFile(hero, validImage);
    await writeFile(logo, validImage);
    const { stdout } = await execFileAsync(process.execPath, [createThemeScript,
      "--id", "one-shot-skin", "--name", "One Shot Skin", "--out", themeDir,
      "--hero", hero, "--logo", logo,
      "--accent", "#00AAFF", "--secondary", "#FF00AA", "--surface", "#101018", "--text", "#FFFFFF",
      "--brand", "One Shot", "--headline", "A complete theme", "--tagline", "Ready to apply",
    ]);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "created");
    assert.deepEqual((await readdir(themeDir)).sort(), ["hero.webp", "logo.webp", "theme.json"]);
    assert.equal(JSON.parse(await readFile(join(themeDir, "theme.json"), "utf8")).hero, "hero.webp");
    assert.equal(JSON.parse(await readFile(join(themeDir, "theme.json"), "utf8")).logo, "logo.webp");
    assert.deepEqual(JSON.parse(await readFile(join(themeDir, "theme.json"), "utf8")).copy, { brand: "One Shot", headline: "A complete theme", tagline: "Ready to apply" });
  });
});

test("defaults the generated brand label to the theme name without a logo", async () => {
  await withTempDir("codex-skin-default-brand-", async (root) => {
    const themeDir = join(root, "theme");
    const hero = join(root, "source.webp");
    await writeFile(hero, await readFile(join(skillRoot, "examples/slayers-xellos-night/hero.webp")));
    const { stdout } = await execFileAsync(process.execPath, [createThemeScript,
      "--id", "default-brand", "--name", "Patriot Gold Workbench", "--out", themeDir,
      "--hero", hero,
      "--accent", "#D9A441", "--secondary", "#B5312B", "--surface", "#050D20", "--text", "#FFFFFF",
    ]);
    assert.deepEqual(JSON.parse(stdout).manifest.copy, { brand: "Patriot Gold Workbench", brandStyle: { preset: "military" } });
  });
});

test("removes synthetic slash separators from an inferred brand label", async () => {
  await withTempDir("codex-skin-brand-clean-", async (root) => {
    const themeDir = join(root, "theme");
    const hero = join(root, "source.webp");
    await writeFile(hero, await readFile(join(skillRoot, "examples/slayers-xellos-night/hero.webp")));
    const { stdout } = await execFileAsync(process.execPath, [createThemeScript,
      "--id", "clean-brand", "--name", "PATRIOT // GOLD", "--out", themeDir,
      "--hero", hero,
      "--accent", "#D9A441", "--secondary", "#B5312B", "--surface", "#050D20", "--text", "#FFFFFF",
    ]);
    assert.equal(JSON.parse(stdout).manifest.copy.brand, "PATRIOT GOLD");
  });
});

test("builds an opt-in launch agent that keeps the renderer debuggable", () => {
  const plist = buildPlist({ nodePath: "/usr/local/bin/node", scriptPath: "/tmp/apply.mjs", port: 9341 });
  assert.match(plist, /com\.openai\.chatgpt\.codex-skin-studio/);
  assert.match(plist, /persistence-worker/);
  assert.match(plist, /<string>--port<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s+<true\/>/);
  assert.match(plist, /<key>LimitLoadToSessionType<\/key>\s+<string>Aqua<\/string>/);
  assert.match(plist, /<string>--control-port<\/string>\s+<string>9342<\/string>/);
  assert.match(buildPlist(), /persist\.mjs/);
});

test("builds a Windows Task Scheduler worker with quoted paths", () => {
  const task = buildTaskXml({ nodePath: "C:\\Program Files\\nodejs\\node.exe", scriptPath: "C:\\Users\\Test User\\codex-skin-studio\\scripts\\persist.mjs", port: 9341, controlPort: 9342 });
  assert.match(task, /<LogonTrigger>/);
  assert.match(task, /<Command>C:\\Program Files\\nodejs\\node\.exe<\/Command>/);
  assert.match(task, /persist\.mjs/);
  assert.match(task, /persistence-worker/);
});

test("discovers a Windows executable candidate and parses tasklist output", async () => {
  await withTempDir("codex-skin-win-", async (root) => {
    const executable = join(root, "ChatGPT.exe");
    await writeFile(executable, Buffer.from([0]));
    assert.equal(appInfoSync(executable, "win32").valid, true);
    assert.ok(appCandidates("win32").some((candidate) => candidate.toLowerCase().endsWith("chatgpt.exe")));
  });
  const pids = await processIds("ChatGPT.exe", {
    platformFn: () => "win32",
    execFileFn: async () => ({ stdout: '"ChatGPT.exe","4120","Console","1","100,000 K"\r\n"ChatGPT.exe","8120","Console","1","110,000 K"\r\n' }),
  });
  assert.deepEqual(pids, [4120, 8120]);
});

test("discovers Microsoft Store ChatGPT package executable candidates", () => {
  const candidates = windowsStoreCandidates((command, args) => {
    assert.equal(command, "powershell.exe");
    assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
    return { stdout: "C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT\\app\\ChatGPT.exe\r\n" };
  });
  assert.deepEqual(candidates, ["C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT\\app\\ChatGPT.exe"]);
});

test("rejects a hero symlink that resolves outside the theme directory", async (t) => {
  await withTempDir("codex-skin-outside-", async (outside) => {
    await writeFile(join(outside, "hero.png"), Buffer.from([1]));
    await withTempDir("codex-skin-theme-", async (root) => {
      await writeFile(join(root, "theme.json"), JSON.stringify({ ...validManifest, hero: "linked/hero.png" }));
      try {
        await symlink(outside, join(root, "linked"));
      } catch (error) {
        if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
          t.skip("Windows symlink creation requires Developer Mode or elevated privileges");
          return;
        }
        throw error;
      }
      await assert.rejects(execFileAsync(process.execPath, [applyScript, "validate", root, "--json"]), /hero escapes the theme directory/);
    });
  });
});

test("filters loopback app pages from a local discovery endpoint", async (t) => {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/json/list");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify([
      { type: "page", url: "app://codex/home", webSocketDebuggerUrl: `ws://127.0.0.1:${server.address()?.port || 0}/devtools/page/good` },
      { type: "page", url: "app://codex/avatar-overlay", webSocketDebuggerUrl: `ws://127.0.0.1:${server.address()?.port || 0}/devtools/page/avatar` },
      { type: "page", url: "app://codex/remote", webSocketDebuggerUrl: "ws://192.0.2.1:1/devtools/page/remote" },
      { type: "worker", url: "app://codex/worker", webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/worker" },
    ]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const result = await targets(port);
  assert.deepEqual(result.map(({ url }) => url), ["app://codex/home"]);
});

test("selects only the main renderer through a DOM probe", async () => {
  const calls = [];
  const main = await selectMainTarget([
    { id: "overlay", webSocketDebuggerUrl: "ws://127.0.0.1:1/overlay" },
    { id: "main", webSocketDebuggerUrl: "ws://127.0.0.1:1/main" },
  ], async (target, expression) => {
    calls.push({ id: target.id, expression });
    return { main: target.id === "main", root: target.id === "main" };
  });
  assert.equal(main.id, "main");
  assert.equal(calls[0].expression, MAIN_TARGET_PROBE);
  assert.equal(calls.length, 2);
  assert.match(MAIN_TARGET_PROBE, /app:\/\/-\/index\.html/);
});

test("transient main-target probe errors are opt-in", async () => {
  const target = { id: "main", webSocketDebuggerUrl: "ws://127.0.0.1:1/main" };
  const transient = Object.assign(new Error("target closed"), { code: "ECONNRESET" });
  await assert.rejects(selectMainTarget([target], async () => { throw transient; }), /main Codex renderer probes failed/);
  assert.equal(await selectMainTarget([target], async () => { throw transient; }, { allowTransient: true }), null);
});

test("injection verification requires connected style, decoded hero, rules, theme id, and root background", () => {
  assert.equal(injectionVerified({ connected: true, themeId: "x", heroLoaded: true, cssText: "body{}", cssRules: 1, rootBackground: true }, "x"), true);
  assert.equal(injectionVerified({ connected: true, themeId: "x", cssText: "body{}", cssRules: 0, rootBackground: true }, "x"), false);
  assert.match(STATUS_EXPRESSION, /getComputedStyle/);
});

test("injects one selected target and verifies its postconditions with a fake evaluator", async () => {
  await withTempDir("codex-skin-atomic-", async (root) => {
    await makeTheme(root);
    const saved = { destination: root, manifest: validManifest };
    const evaluated = [];
    const result = await injectTheme([
      { id: "overlay", webSocketDebuggerUrl: "ws://127.0.0.1:1/overlay" },
      { id: "main", webSocketDebuggerUrl: "ws://127.0.0.1:1/main" },
    ], saved, {
      evaluateTarget: async (target, expression) => {
        evaluated.push({ id: target.id, expression });
        if (expression === MAIN_TARGET_PROBE) return { main: target.id === "main", root: target.id === "main" };
        return { connected: true, themeId: validManifest.id, heroLoaded: true, cssText: "#root{}", cssRules: 1, rootBackground: true };
      },
    });
    assert.deepEqual(evaluated.map(({ id }) => id), ["main", "overlay", "main"]);
    assert.equal(result.rendererCount, 1);
});
});

test("atomically replaces a saved theme and removes stale files", async () => {
  await withTempDir("codex-skin-themes-", async (root) => {
    const source = join(root, "source");
    const themes = join(root, "themes");
    await mkdir(source, { recursive: true });
    await makeTheme(source);
    const first = await persist({ root: source, hero: join(source, "hero.png"), manifest: validManifest }, { themesDir: themes });
    await writeFile(join(first.destination, "stale.png"), Buffer.from([2]));
    const second = await persist({ root: source, hero: join(source, "hero.png"), manifest: validManifest }, { themesDir: themes });
    assert.deepEqual((await readdir(second.destination)).sort(), ["hero.png", "theme.json"]);
    assert.deepEqual(JSON.parse(await readFile(join(second.destination, "theme.json"), "utf8")).id, validManifest.id);
  });
});

test("atomically persists optional logo and polaroid assets", async () => {
  await withTempDir("codex-skin-asset-persist-", async (root) => {
    const source = join(root, "source");
    const themes = join(root, "themes");
    await mkdir(source, { recursive: true });
    const manifest = validateManifest({ ...validManifest, logo: "logo.png", polaroid: "polaroid.png" });
    await makeTheme(source, manifest);
    await writeFile(join(source, "logo.png"), Buffer.from([2]));
    await writeFile(join(source, "polaroid.png"), Buffer.from([3]));
    const saved = await persist({ root: source, hero: join(source, "hero.png"), logo: join(source, "logo.png"), polaroid: join(source, "polaroid.png"), manifest }, { themesDir: themes });
    assert.deepEqual((await readdir(saved.destination)).sort(), ["hero.png", "logo.png", "polaroid.png", "theme.json"]);
    assert.deepEqual(JSON.parse(await readFile(join(saved.destination, "theme.json"), "utf8")).logo, "logo.png");
  });
});

test("waits for the exact old PIDs to exit with bounded polling", async () => {
  const states = [true, true, false];
  const waits = [];
  assert.equal(await waitForProcessExit([41], { isPidRunning: async () => states.shift(), delayFn: async (ms) => waits.push(ms), timeoutMs: 1000, intervalMs: 7 }), true);
  assert.deepEqual(waits, [7, 7]);
});

test("waits for the relaunched process to start before clearing restart pending", async () => {
  const states = [false, true];
  const waits = [];
  assert.equal(await waitForProcessStart("Codex", { processIdsFn: async () => states.shift() ? [41] : [], delayFn: async (ms) => waits.push(ms), timeoutMs: 1000, intervalMs: 11 }), true);
  assert.deepEqual(waits, [11]);
});

test("process-query failures are not treated as stopped", async () => {
  const queryError = new Error("process query failed");
  await assert.rejects(waitForProcessExit([41], { isPidRunning: async () => { throw queryError; } }), queryError);
  await assert.rejects(waitForProcessStart("Codex", { processIdsFn: async () => { throw queryError; } }), queryError);
});

test("PID probing treats EPERM as running and propagates unexpected errors", () => {
  const denied = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  const unexpected = Object.assign(new Error("unexpected probe failure"), { code: "EIO" });
  assert.equal(isPidRunning(41, { processKillFn: () => { throw denied; } }), true);
  assert.throws(() => isPidRunning(41, { processKillFn: () => { throw unexpected; } }), unexpected);
});

test("restart worker delays, quits, waits, relaunches with loopback CDP, and injects", async () => {
  const events = [];
  let probes = 0;
  let processPolls = 0;
  let reads = 0;
  const stateWrites = [];
  await restartWorker(9341, {
    delayFn: async (ms) => events.push(`wait:${ms}`),
    platformFn: () => "darwin",
    discoverFn: () => "/Applications/Codex.app",
    appInfoFn: () => ({ valid: true, executable: "Codex" }),
    quitFn: async () => events.push("quit"),
    processIdsFn: async () => { events.push("poll"); return processPolls++ < 1 ? [101] : []; },
    isPidRunning: async () => false,
    launchFn: async (args) => events.push(args.join(" ")),
    targetsFn: async () => (probes++ > 1 ? [{ id: "main" }] : []),
    selectTargetFn: async (list) => list[0] || null,
    savedThemeFn: async () => ({ destination: "/tmp/theme", manifest: validManifest }),
    injectFn: async () => events.push("inject"),
    readStateFn: async () => { reads += 1; return {}; },
    writeStateFn: async (value) => { stateWrites.push(value); events.push("state"); },
  });
  assert.equal(events[0], "wait:1500");
  assert.ok(events.includes("quit"));
  assert.ok(events.some((event) => event.includes("--remote-debugging-address=127.0.0.1")));
  assert.ok(events.includes("inject"));
  assert.equal(reads, 2);
  assert.equal(stateWrites.length, 2);
  assert.equal(stateWrites[0].active, false);
  assert.equal(stateWrites[0].restartPending, true);
  assert.equal(stateWrites[1].active, true);
  assert.equal(stateWrites[1].restartPending, false);
});

test("restart worker uses Windows executable launch arguments", async () => {
  const events = [];
  await restartWorker(9341, {
    platformFn: () => "win32",
    delayFn: async () => {},
    discoverFn: () => "C:\\Users\\Test User\\AppData\\Local\\Programs\\ChatGPT\\ChatGPT.exe",
    appInfoFn: () => ({ valid: true, executable: "ChatGPT.exe" }),
    quitFn: async () => events.push("quit"),
    processIdsFn: async () => [],
    launchFn: async (args) => events.push(args),
    targetsFn: async () => [{ id: "main" }],
    selectTargetFn: async (list) => list[0],
    savedThemeFn: async () => ({ destination: "/tmp/theme", manifest: validManifest }),
    injectFn: async () => events.push("inject"),
    readStateFn: async () => ({}),
    writeStateFn: async () => {},
  });
  assert.deepEqual(events[0], "quit");
  assert.deepEqual(events[1], ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9341"]);
  assert.equal(events[2], "inject");
});

test("restart worker does not mark active when every ready-target injection fails", async () => {
  let now = 0;
  const writes = [];
  await assert.rejects(restartWorker(9341, {
    delayFn: async (ms) => { now += ms; },
    nowFn: () => now,
    restartTimeoutMs: 500,
    platformFn: () => "darwin",
    discoverFn: () => "/Applications/Codex.app",
    appInfoFn: () => ({ valid: true, executable: "Codex" }),
    quitFn: async () => {},
    processIdsFn: async () => [],
    launchFn: async () => {},
    targetsFn: async () => [{ id: "main" }],
    selectTargetFn: async (list) => list[0],
    savedThemeFn: async () => ({ destination: "/tmp/theme", manifest: validManifest }),
    injectFn: async () => { throw new Error("injection verification failed"); },
    readStateFn: async () => ({ active: false }),
    writeStateFn: async (value) => writes.push(value),
  }), /did not become ready.*injection verification failed/);
  assert.equal(writes.at(-1).active, false);
  assert.equal(writes.at(-1).restartPending, false);
});

test("restart worker preserves active state when it fails before old PIDs exit", async () => {
  const writes = [];
  await assert.rejects(restartWorker(9341, {
    delayFn: async () => {},
    platformFn: () => "darwin",
    discoverFn: () => "/Applications/Codex.app",
    appInfoFn: () => ({ valid: true, executable: "Codex" }),
    quitFn: async () => { throw new Error("quit failed"); },
    processIdsFn: async () => [101],
    readStateFn: async () => ({ active: true, themeId: "old" }),
    writeStateFn: async (value) => writes.push(value),
  }), /quit failed/);
  assert.equal(writes.at(-1).active, true);
  assert.equal(writes.at(-1).processExited, false);
});

test("restart worker marks post-exit failures inactive without an exit callback", async () => {
  const coreError = new Error("launch failed");
  await assert.rejects(restartWorkerCore(9341, {
    delayFn: async () => {},
    platformFn: () => "darwin",
    discoverFn: () => "/Applications/Codex.app",
    appInfoFn: () => ({ valid: true, executable: "Codex" }),
    quitFn: async () => {},
    processIdsFn: async () => [],
    launchFn: async () => { throw coreError; },
    readStateFn: async () => ({ active: true }),
    writeStateFn: async () => {},
  }), (error) => error === coreError && error.processExited === true);

  let state = { active: true };
  let nowCalls = 0;
  await assert.rejects(restartWorker(9341, {
    delayFn: async () => {},
    platformFn: () => "darwin",
    discoverFn: () => "/Applications/Codex.app",
    appInfoFn: () => ({ valid: true, executable: "Codex" }),
    quitFn: async () => {},
    processIdsFn: async () => [],
    launchFn: async () => {},
    savedThemeFn: async () => ({ destination: "/tmp/theme", manifest: validManifest }),
    targetsFn: async () => { throw new Error("readiness failed"); },
    nowFn: () => nowCalls++,
    restartTimeoutMs: 1,
    readStateFn: async () => state,
    writeStateFn: async (value) => { state = value; },
  }), /did not become ready/);
  assert.equal(state.active, false);
  assert.equal(state.processExited, true);
});

test("restart worker normal uses only injected state callbacks and confirms process start", async () => {
  const events = [];
  let running = false;
  await restartWorker(9341, {
    normal: true,
    delayFn: async () => {},
    platformFn: () => "darwin",
    discoverFn: () => "/Applications/Codex.app",
    appInfoFn: () => ({ valid: true, executable: "Codex" }),
    quitFn: async () => {},
    processIdsFn: async () => running ? [101] : [],
    launchFn: async () => { running = true; },
    readStateFn: async () => { events.push("fake-read"); return { restartPending: true }; },
    writeStateFn: async (value) => { events.push({ type: "fake-write", value }); },
  });
  assert.equal(events[1].value.restartPending, true);
  assert.equal(events.at(-1).value.restartPending, false);
  assert.equal(events.at(-1).value.restartWorkerPid, null);
  assert.equal(events.some((event) => event === "real-state-write"), false);
});

test("restart worker default platform gate performs no state access on unsupported platforms", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  let reads = 0;
  let writes = 0;
  try {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    await assert.rejects(restartWorker(9341, {
      readStateFn: async () => { reads += 1; return {}; },
      writeStateFn: async () => { writes += 1; },
    }), /macOS and Windows only/);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test("ordinary restore is idempotent when the reachable style is already absent", async () => {
  const writes = [];
  const result = await commandRestore(9341, false, {
    platformFn: () => "darwin",
    targetsFn: async () => [{ id: "main" }],
    selectTargetFn: async () => ({ id: "main" }),
    evaluateListFn: async () => [0],
    readStateFn: async () => ({ active: true, restartWorkerPid: 12 }),
    writeStateFn: async (value) => writes.push(value),
  });
  assert.equal(result.status, "restored");
  assert.equal(result.removed, 0);
  assert.equal(writes[0].active, false);
  assert.equal(writes[0].restartWorkerPid, null);
});

test("Session rejects pending commands on malformed messages and socket close", async () => {
  class FakeSocket {
    static instances = [];
    constructor() { this.sent = []; FakeSocket.instances.push(this); }
    send(value) { const request = JSON.parse(value); this.sent.push(request); queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: request.id, result: {} }) })); }
    close() { this.onclose?.(); }
  }
  const session = new Session("ws://127.0.0.1:9341/devtools/page/fake", { WebSocketImpl: FakeSocket });
  const opening = session.open();
  const socket = FakeSocket.instances[0];
  socket.onopen();
  for (const request of socket.sent) socket.onmessage({ data: JSON.stringify({ id: request.id, result: {} }) });
  await opening;
  const first = session.send("Test.one");
  socket.onmessage({ data: "{" });
  await assert.rejects(first, /malformed message/);
  const second = session.send("Test.two");
  socket.onclose();
  await assert.rejects(second, /WebSocket closed/);
});

test("Session.open closes a stalled socket and clears connection state on timeout", async () => {
  class StalledSocket {
    static instance;
    constructor() { StalledSocket.instance = this; }
    close() { this.closed = true; }
  }
  const session = new Session("ws://127.0.0.1:9341/devtools/page/stalled", { WebSocketImpl: StalledSocket, openTimeoutMs: 15 });
  await assert.rejects(session.open(), /CDP connection timed out/);
  const socket = StalledSocket.instance;
  assert.equal(socket.closed, true);
  assert.equal(socket.onopen, null);
  assert.equal(socket.onerror, null);
  assert.equal(socket.onclose, null);
  assert.equal(socket.onmessage, null);
  assert.equal(session.pending.size, 0);
});

test("Session rejects invalid integer-id envelopes and socket errors", async () => {
  class FakeSocket {
    static instances = [];
    constructor() { FakeSocket.instances.push(this); }
    send(value) {
      this.request = JSON.parse(value);
      if (["Runtime.enable", "Page.enable"].includes(this.request.method)) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: this.request.id, result: {} }) }));
    }
    close() { this.onclose?.(); }
  }
  const session = new Session("ws://127.0.0.1:9341/devtools/page/fake", { WebSocketImpl: FakeSocket });
  const opening = session.open();
  const socket = FakeSocket.instances[0];
  socket.onopen();
  await opening;
  for (const response of [{ result: {}, error: { message: "both" } }, {}, { error: "bad" }, { error: {} }]) {
    const pending = session.send("Invalid.envelope");
    const id = socket.request.id;
    socket.onmessage({ data: JSON.stringify({ id, ...response }) });
    await assert.rejects(pending, response.error && Object.keys(response).length === 1 ? /malformed error payload/ : /invalid response envelope/);
  }
  const socketPending = session.send("Socket.failure");
  socket.onerror?.();
  await assert.rejects(socketPending, /WebSocket error/);
});

test("Session accepts CDP events but rejects other non-id messages", async () => {
  class FakeSocket {
    static instances = [];
    constructor() { FakeSocket.instances.push(this); }
    send(value) {
      this.request = JSON.parse(value);
      if (["Runtime.enable", "Page.enable"].includes(this.request.method)) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: this.request.id, result: {} }) }));
    }
    close() { this.onclose?.(); }
  }
  const session = new Session("ws://127.0.0.1:9341/devtools/page/fake", { WebSocketImpl: FakeSocket });
  const opening = session.open();
  const socket = FakeSocket.instances[0];
  socket.onopen();
  await opening;
  socket.onmessage({ data: JSON.stringify({ method: "Runtime.executionContextCreated", params: {} }) });
  socket.onmessage({ data: JSON.stringify({ method: "Runtime.executionContextCreated" }) });
  for (const params of ["bad", [], null]) {
    const malformed = session.send("Event.malformed");
    socket.onmessage({ data: JSON.stringify({ method: "Runtime.executionContextCreated", params }) });
    await assert.rejects(malformed, /invalid message envelope/);
  }
  const pending = session.send("Event.check");
  socket.onmessage({ data: JSON.stringify({ method: "not-an-event", result: {} }) });
  await assert.rejects(pending, /invalid message envelope/);
});

test("fake CDP lifecycle covers discovery, Session injection, status, and restart cleanup", async (t) => {
  const runtime = { installed: false, themeId: null };
  class FakeSocket {
    static instances = [];
    constructor() { FakeSocket.instances.push(this); queueMicrotask(() => this.onopen?.()); }
    send(value) {
      const request = JSON.parse(value);
      let result = {};
      if (request.method === "Runtime.evaluate") {
        const expression = request.params.expression;
        if (expression === MAIN_TARGET_PROBE) result = { result: { value: { main: true, root: true, shell: true, title: "Codex", url: "app://codex/home" } } };
        else if (expression.includes("heroImage.decode")) { runtime.installed = true; runtime.themeId = validManifest.id; result = { result: { value: { connected: true, themeId: validManifest.id, heroLoaded: true, cssText: "#root{}", cssRules: 1, rootBackground: true } } }; }
        else if (expression === STATUS_EXPRESSION) result = { result: { value: { connected: runtime.installed, themeId: runtime.themeId, heroLoaded: runtime.installed, cssText: runtime.installed ? "#root{}" : "", cssRules: runtime.installed ? 1 : 0, rootBackground: runtime.installed } } };
      }
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: request.id, result }) }));
    }
    close() { this.onclose?.(); }
  }
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify([{ type: "page", url: "app://codex/home", webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/main` }]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const root = await mkdtemp(join(tmpdir(), "codex-skin-fake-cdp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeTheme(root);
  const saved = { destination: root, manifest: validManifest };
  let state = { active: false, themeId: validManifest.id, themeDir: saved.destination, restartWorkerPid: 77 };
  const evaluateTarget = async (target, expression) => {
    const session = new Session(target.webSocketDebuggerUrl, { WebSocketImpl: FakeSocket });
    try { await session.open(); return await session.evaluate(expression); } finally { session.close(); }
  };
  const inject = (list, theme) => injectTheme(list, theme, { evaluateTarget });
  const applied = await commandApply(root, port, {
    platformFn: () => "darwin",
    persistFn: async () => saved,
    readStateFn: async () => state,
    writeStateFn: async (value) => { state = value; },
    targetsFn: (requestedPort) => targets(requestedPort),
    injectFn: inject,
  });
  assert.equal(applied.rendererCount, 1);
  assert.equal(state.active, true);
  const status = await commandStatus(port, {
    platformFn: () => "darwin",
    targetsFn: (requestedPort) => targets(requestedPort),
    selectTargetFn: (list) => selectMainTarget(list, evaluateTarget),
    evaluateListFn: (list, expression) => evaluateAllWithSession(list, expression, evaluateTarget),
    readStateFn: async () => state,
  });
  assert.equal(status.status, "active");
  const writes = [];
  await restartWorkerCore(port, {
    platformFn: () => "darwin",
    delayFn: async () => {},
    discoverFn: () => "/Applications/Codex.app",
    appInfoFn: () => ({ valid: true, executable: "Codex" }),
    quitFn: async () => {},
    processIdsFn: async () => [],
    launchFn: async () => {},
    targetsFn: async () => targets(port),
    selectTargetFn: (list) => selectMainTarget(list, evaluateTarget),
    savedThemeFn: async () => saved,
    injectFn: inject,
    readStateFn: async () => state,
    writeStateFn: async (value) => { state = value; writes.push(value); },
  });
  assert.equal(writes[0].active, false);
  assert.equal(writes[0].restartPending, true);
  assert.equal(state.active, true);
  assert.equal(state.restartPending, false);
  assert.equal(state.restartWorkerPid, null);
});

async function evaluateAllWithSession(list, expression, evaluateTarget) {
  const values = [];
  for (const target of list) values.push(await evaluateTarget(target, expression));
  return values;
}

test("status reports live injection truth and stale persisted state", async () => {
  const result = await commandStatus(9341, {
    platformFn: () => "darwin",
    targetsFn: async () => [{ id: "main" }],
    selectTargetFn: async (list) => list[0],
    evaluateListFn: async () => [{ installed: false, connected: false, themeId: null, cssText: "", cssRules: 0, rootBackground: false }],
    readStateFn: async () => ({ active: true, themeId: validManifest.id }),
  });
  assert.equal(result.status, "stale");
  assert.equal(result.state.active, false);
});

test("apply schedules only for a confirmed unavailable CDP listener", async () => {
  await withTempDir("codex-skin-apply-", async (root) => {
    await makeTheme(root);
    const saved = { destination: root, manifest: validManifest };
    const common = {
      persistFn: async () => saved,
      writeStateFn: async () => {},
      spawnWorker: async () => 77,
      platformFn: () => "darwin",
    };
    await assert.rejects(commandApply(root, 9341, { ...common, targetsFn: async () => { throw new Error("CDP discovery returned HTTP 503"); } }), /HTTP 503/);
    await assert.rejects(commandApply(root, 9341, { ...common, targetsFn: async () => { throw new TypeError("failed to fetch"); } }), /failed to fetch/);
    await assert.rejects(commandApply(root, 9341, { ...common, targetsFn: async () => [] }), /no eligible Codex renderer/);
    const result = await commandApply(root, 9341, { ...common, targetsFn: async () => { const error = new Error("fetch failed"); error.cause = { code: "ECONNREFUSED" }; throw error; } });
    assert.equal(result.status, "scheduled");
  });
});

test("successful apply clears stale failure diagnostics", async () => {
  await withTempDir("codex-skin-apply-clear-failure-", async (root) => {
    await makeTheme(root);
    const writes = [];
    await commandApply(root, 9341, {
      platformFn: () => "darwin",
      persistFn: async () => ({ destination: root, manifest: validManifest }),
      readStateFn: async () => ({ themeId: "old-theme", active: true, failedAt: "yesterday", error: "old failure", processExited: true }),
      writeStateFn: async (value) => writes.push(value),
      targetsFn: async () => [{ id: "main" }],
      injectFn: async () => ({ rendererCount: 1 }),
    });
    assert.equal(writes.at(-1).active, true);
    assert.equal(writes.at(-1).failedAt, undefined);
    assert.equal(writes.at(-1).error, undefined);
    assert.equal(writes.at(-1).processExited, undefined);
  });
});

test("apply preserves verified state until injection or worker spawn succeeds", async () => {
  await withTempDir("codex-skin-apply-state-", async (root) => {
    await makeTheme(root);
    const prior = { themeId: "old-theme", themeDir: "/old/theme", active: true, restartWorkerPid: 12 };
    const writes = [];
    const common = {
      platformFn: () => "darwin",
      persistFn: async () => ({ destination: root, manifest: validManifest }),
      readStateFn: async () => prior,
      writeStateFn: async (value) => writes.push(value),
    };
    await assert.rejects(commandApply(root, 9341, { ...common, targetsFn: async () => [{ id: "main" }], injectFn: async () => { throw new Error("replacement failed"); } }), /replacement failed/);
    assert.deepEqual(writes, []);
    await assert.rejects(commandApply(root, 9341, { ...common, targetsFn: async () => { const error = new Error("connection refused"); error.code = "ECONNREFUSED"; throw error; }, spawnWorker: async () => { throw new Error("spawn failed"); } }), /spawn failed/);
    assert.deepEqual(writes, []);
    await commandApply(root, 9341, { ...common, targetsFn: async () => { const error = new Error("connection refused"); error.code = "ECONNREFUSED"; throw error; }, spawnWorker: async () => 91 });
    assert.equal(writes.at(-1).restartPending, true);
    assert.equal(writes.at(-1).restartWorkerPid, 91);
  });
});

test("same-ID failed replacement rolls back the old hero and theme manifest", async () => {
  await withTempDir("codex-skin-rollback-", async (root) => {
    const themes = join(root, "themes");
    const oldSource = join(root, "old-source");
    const newSource = join(root, "new-source");
    await mkdir(oldSource, { recursive: true });
    await mkdir(newSource, { recursive: true });
    await makeTheme(oldSource, { ...validManifest, name: "Old Theme" });
    await makeTheme(newSource, { ...validManifest, name: "New Theme" });
    await persist({ root: oldSource, hero: join(oldSource, "hero.png"), manifest: { ...validManifest, name: "Old Theme" } }, { themesDir: themes });
    await assert.rejects(commandApply(newSource, 9341, {
      platformFn: () => "darwin",
      persistFn: (theme, options) => persist(theme, { ...options, themesDir: themes }),
      targetsFn: async () => [{ id: "main" }],
      injectFn: async () => { throw new Error("replacement failed"); },
      readStateFn: async () => ({ active: true, themeId: validManifest.id }),
      writeStateFn: async () => {},
    }), /replacement failed/);
    assert.equal(await readFile(join(themes, validManifest.id, "hero.png"), "utf8"), "\x01");
    assert.equal(JSON.parse(await readFile(join(themes, validManifest.id, "theme.json"), "utf8")).name, "Old Theme");
  });
});

test("apply compensates live injection, state, and files when commit fails", async () => {
  await withTempDir("codex-skin-apply-compensation-", async (root) => {
    await makeTheme(root);
    const prior = { themeId: "old-theme", themeDir: "/old/theme", active: true };
    const events = [];
    await assert.rejects(commandApply(root, 9341, {
      platformFn: () => "darwin",
      persistFn: async () => ({
        destination: root,
        manifest: validManifest,
        commit: async () => { events.push("commit"); throw new Error("commit failed"); },
        rollback: async () => events.push("files-rollback"),
      }),
      targetsFn: async () => [{ id: "main" }, { id: "secondary" }],
      injectFn: async () => ({ rendererCount: 1, rollback: async () => events.push("style-rollback") }),
      readStateFn: async () => prior,
      writeStateFn: async (value) => events.push(value === prior ? "state-restore" : "state-write"),
    }), /commit failed/);
    assert.deepEqual(events, ["state-write", "commit", "style-rollback", "state-restore", "files-rollback"]);
  });
});

test("apply preserves original failure when compensation also fails", async () => {
  await withTempDir("codex-skin-apply-compensation-error-", async (root) => {
    await makeTheme(root);
    await assert.rejects(commandApply(root, 9341, {
      platformFn: () => "darwin",
      persistFn: async () => ({ destination: root, manifest: validManifest, rollback: async () => { throw new Error("file rollback failed"); } }),
      targetsFn: async () => [{ id: "main" }],
      injectFn: async () => ({ rendererCount: 1, rollback: async () => { throw new Error("style rollback failed"); } }),
      writeStateFn: async () => { throw new Error("state write failed"); },
      readStateFn: async () => ({ active: true }),
    }), (error) => error instanceof AggregateError && error.errors.some((item) => /state write failed/.test(item.message)) && error.errors.some((item) => /style rollback failed/.test(item.message)) && error.errors.some((item) => /file rollback failed/.test(item.message)));
  });
});

test("status marks a connected mismatched theme stale and preserves diagnostics", async () => {
  const options = { platformFn: () => "darwin", targetsFn: async () => [{ id: "main" }], selectTargetFn: async (list) => list[0], evaluateListFn: async () => [{ connected: true, themeId: "different", heroLoaded: true, cssText: "body{}", cssRules: 1, rootBackground: true }], readStateFn: async () => ({ active: false, themeId: validManifest.id }) };
  assert.equal((await commandStatus(9341, options)).status, "stale");
  await assert.rejects(commandStatus(9341, { ...options, targetsFn: async () => { throw new Error("CDP discovery returned HTTP 502"); } }), /HTTP 502/);
  const refused = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
  assert.equal((await commandStatus(9341, { ...options, targetsFn: async () => { throw refused; } })).status, "unavailable");
});

test("status reports connected mismatch as stale while preserving restart pending", async () => {
  const state = { active: false, restartPending: true, restartWorkerPid: 91, themeId: validManifest.id };
  const result = await commandStatus(9341, {
    platformFn: () => "darwin",
    targetsFn: async () => [{ id: "main" }],
    selectTargetFn: async (list) => list[0],
    evaluateListFn: async () => [{ connected: true, themeId: "different", heroLoaded: true, cssText: "body{}", cssRules: 1, rootBackground: true }],
    readStateFn: async () => state,
  });
  assert.equal(result.status, "stale");
  assert.equal(result.state.restartPending, true);
  assert.equal(result.state.restartWorkerPid, 91);
});

test("targets requires the requested debugger port", async (t) => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify([
      { type: "page", url: "app://codex/right", webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/right` },
      { type: "page", url: "app://codex/wrong", webSocketDebuggerUrl: "ws://127.0.0.1:1/wrong" },
    ]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const result = await targets(server.address().port);
  assert.deepEqual(result.map(({ url }) => url), ["app://codex/right"]);
});

test("spawnRestartWorker confirms spawn, validates PID, and rejects errors", async () => {
  const { spawnRestartWorker } = await import("../skill/codex-skin-studio/scripts/apply.mjs");
  class Child {
    constructor(pid, error) { this.pid = pid; this.listeners = new Map(); queueMicrotask(() => this.emit(error ? "error" : "spawn", error)); }
    once(name, callback) { this.listeners.set(name, callback); }
    removeListener(name) { this.listeners.delete(name); }
    emit(name, value) { this.listeners.get(name)?.(value); }
    unref() { this.unrefed = true; }
  }
  const child = new Child(321);
  assert.equal(await spawnRestartWorker(9341, { spawnFn: () => child }), 321);
  assert.equal(child.unrefed, true);
  await assert.rejects(spawnRestartWorker(9341, { spawnFn: () => new Child(0) }), /invalid PID/);
  await assert.rejects(spawnRestartWorker(9341, { spawnFn: () => new Child(321, new Error("spawn failed")) }), /spawn failed/);
});

test("scheduled apply persists pending worker state and status preserves it", async () => {
  await withTempDir("codex-skin-composed-", async (root) => {
    await makeTheme(root);
    let state = null;
    const options = {
      platformFn: () => "darwin",
      persistFn: async () => ({ destination: root, manifest: validManifest }),
      writeStateFn: async (value) => { state = value; },
      spawnWorker: async () => 707,
      targetsFn: async () => { const error = new Error("connection refused"); error.cause = { code: "ECONNREFUSED" }; throw error; },
    };
    await commandApply(root, 9341, options);
    assert.equal(state.restartPending, true);
    assert.equal(state.restartWorkerPid, 707);
    const result = await commandStatus(9341, {
      platformFn: () => "darwin",
      targetsFn: async () => [],
      readStateFn: async () => state,
    });
    assert.equal(result.status, "pending");
    assert.equal(result.state.restartPending, true);
  });
});

test("restore scheduling is reflected by status until the worker completes", async () => {
  let state = { themeId: "x", themeDir: "/tmp/x", active: true };
  await commandRestore(9341, true, {
    platformFn: () => "darwin",
    targetsFn: async () => [],
    spawnWorker: async () => 808,
    readStateFn: async () => state,
    writeStateFn: async (value) => { state = value; },
  });
  const pending = await commandStatus(9341, { platformFn: () => "darwin", targetsFn: async () => [], readStateFn: async () => state });
  assert.equal(pending.status, "pending");
  state = { ...state, restartPending: false, active: false };
  const restored = await commandStatus(9341, { platformFn: () => "darwin", targetsFn: async () => [], readStateFn: async () => state });
  assert.equal(restored.status, "unavailable");
});

test("unsupported-platform commands reject before side effects", async () => {
  for (const command of [
    () => commandApply("/tmp/theme", 9341, { platformFn: () => "linux", persistFn: async () => { throw new Error("side effect"); } }),
    () => commandStatus(9341, { platformFn: () => "linux", targetsFn: async () => { throw new Error("side effect"); } }),
    () => commandRestore(9341, false, { platformFn: () => "linux", targetsFn: async () => { throw new Error("side effect"); } }),
    () => restartWorker(9341, { platformFn: () => "linux", discoverFn: () => { throw new Error("side effect"); } }),
  ]) await assert.rejects(command, /macOS and Windows only/);
});

test("readState only treats missing state as empty", async () => {
  await withTempDir("codex-skin-state-", async (root) => {
    const path = join(root, "state.json");
    assert.equal(await readState(path), null);
    await writeFile(path, "{broken");
    await assert.rejects(readState(path), SyntaxError);
  });
});

test("malformed hero data fails renderer decode before injection verification", async () => {
  await withTempDir("codex-skin-decode-", async (root) => {
    await makeTheme(root);
    await assert.rejects(injectTheme([{ id: "main", webSocketDebuggerUrl: "ws://127.0.0.1:1/main" }], { destination: root, manifest: validManifest }, {
      evaluateTarget: async (target, expression) => expression === MAIN_TARGET_PROBE ? { main: true, root: true } : (() => { throw new Error("The source image could not be decoded"); })(),
    }), /could not be decoded/);
    assert.match(styleExpression(validManifest, "data:image/png;base64,malformed"), /heroImage\.decode/);
  });
});

test("renderer verification failure carries an exact prior-style rollback", async () => {
  await withTempDir("codex-skin-renderer-rollback-", async (root) => {
    await makeTheme(root);
    const expressions = [];
    let failure;
    await assert.rejects(injectTheme([{ id: "main", webSocketDebuggerUrl: "ws://127.0.0.1:1/main" }], { destination: root, manifest: validManifest }, {
      evaluateTarget: async (target, expression) => {
        expressions.push(expression);
        if (expression === MAIN_TARGET_PROBE) return { main: true, root: true };
        if (expression.startsWith("(() => { const node")) return 1;
        return { rollback: { present: true, textContent: "old-css", themeId: "old", heroLoaded: "false" }, connected: true, themeId: validManifest.id, heroLoaded: true, cssText: "", cssRules: 0, rootBackground: false };
      },
    }), (error) => { failure = error; return /injection verification failed/.test(error.message) && typeof error.rollback === "function"; });
    await failure.rollback();
    assert.match(expressions.at(-1), /old-css/);
    assert.match(expressions.at(-1), /old/);
    assert.equal(expressions.length, 3);
  });
});

test("apply removes newly-created state when later commit fails", async () => {
  await withTempDir("codex-skin-null-state-", async (root) => {
    await makeTheme(root);
    let removed = 0;
    await assert.rejects(commandApply(root, 9341, {
      platformFn: () => "darwin",
      persistFn: async () => ({ destination: root, manifest: validManifest, commit: async () => { throw new Error("commit failed"); } }),
      readStateFn: async () => null,
      writeStateFn: async () => {},
      removeStateFn: async () => { removed += 1; },
      targetsFn: async () => [{ id: "main" }],
      injectFn: async () => ({ rendererCount: 1, rollback: async () => {} }),
    }), /commit failed/);
    assert.equal(removed, 1);
  });
});

test("unarmed restart worker never discovers or quits Codex", async () => {
  let discovered = false;
  let quit = false;
  await restartWorkerCore(9341, {
    requireArmed: true,
    processPidFn: () => 321,
    platformFn: () => "darwin",
    readStateFn: async () => ({ restartPending: false, restartWorkerPid: 321 }),
    discoverFn: () => { discovered = true; return "/Applications/Codex.app"; },
    quitFn: async () => { quit = true; },
  });
  assert.equal(discovered, false);
  assert.equal(quit, false);
});

test("failed apply scheduling cancels the spawned worker callback", async () => {
  await withTempDir("codex-skin-worker-cancel-", async (root) => {
    await makeTheme(root);
    let workerAlive = false;
    let callbackRan = false;
    await assert.rejects(commandApply(root, 9341, {
      platformFn: () => "darwin",
      persistFn: async () => ({ destination: root, manifest: validManifest }),
      readStateFn: async () => null,
      targetsFn: async () => { const error = new Error("connection refused"); error.code = "ECONNREFUSED"; throw error; },
      spawnWorker: async () => { workerAlive = true; setImmediate(() => { if (workerAlive) callbackRan = true; }); return 321; },
      writeStateFn: async () => { throw new Error("state arm failed"); },
      cancelWorkerFn: async () => { workerAlive = false; },
      removeStateFn: async () => {},
    }), /state arm failed/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(workerAlive, false);
    assert.equal(callbackRan, false);
  });
});

test("restore scheduling restores prior state after pending-state write failure", async () => {
  const prior = { themeId: "x", themeDir: "/tmp/x", active: true };
  const writes = [];
  let cancelled = false;
  await assert.rejects(commandRestore(9341, true, {
    platformFn: () => "darwin",
    targetsFn: async () => [],
    spawnWorker: async () => 808,
    cancelWorkerFn: async () => { cancelled = true; },
    readStateFn: async () => prior,
    writeStateFn: async (value) => { if (!writes.length) { writes.push("failed"); throw new Error("pending state failed"); } writes.push(value); },
  }), /pending state failed/);
  assert.equal(cancelled, true);
  assert.deepEqual(writes.at(-1), prior);
});

test("doctor exposes the expected Team ID contract", () => {
  assert.equal(EXPECTED_TEAM_ID, "2DC432GLL2");
});

test("restart-normal restore schedules a fake worker and never touches a real app", async () => {
  const writes = [];
  const result = await commandRestore(9341, true, {
    platformFn: () => "darwin",
    targetsFn: async () => [],
    spawnWorker: async (port, options) => { writes.push({ port, options }); return 42; },
    readStateFn: async () => ({ themeId: "x", themeDir: "/tmp/x", active: true }),
    writeStateFn: async (value) => writes.push(value),
  });
  assert.equal(result.status, "scheduled");
  assert.deepEqual(writes.find((value) => value?.options)?.options, { normal: true });
  assert.equal(writes.at(-1).restartPending, true);
  assert.equal(writes.at(-1).active, true);
});

test("restart-normal state reflects confirmed removal on pending and spawn failure", async () => {
  const pendingWrites = [];
  await commandRestore(9341, true, {
    platformFn: () => "darwin",
    targetsFn: async () => [{ id: "main" }],
    selectTargetFn: async (list) => list[0],
    evaluateListFn: async () => [0],
    spawnWorker: async () => 42,
    readStateFn: async () => ({ active: true }),
    writeStateFn: async (value) => pendingWrites.push(value),
  });
  assert.equal(pendingWrites.at(-1).active, false);
  assert.equal(pendingWrites.at(-1).restartPending, true);

  for (const confirmed of [true, false]) {
    const writes = [];
    const result = await commandRestore(9341, true, {
      platformFn: () => "darwin",
      targetsFn: async () => confirmed ? [{ id: "main" }] : [],
      selectTargetFn: async (list) => list[0] || null,
      evaluateListFn: async () => [1],
      spawnWorker: async () => { throw new Error("spawn failed"); },
      readStateFn: async () => ({ active: true }),
      writeStateFn: async (value) => writes.push(value),
    });
    assert.equal(result.code, "RESTART_SCHEDULE_FAILED");
    assert.equal(writes.at(-1).active, !confirmed);
    assert.equal(writes.at(-1).restartPending, false);
  }
});

test("pet contracts reject provisional data until the observed contract is supplied", () => {
  assert.throws(() => validateContract({ ...observedPetContract, status: "provisional" }), /provisional/);
  assert.deepEqual(validateContract(observedPetContract), observedPetContract);
  assert.throws(() => validateContract({ ...observedPetContract, grid: { columns: 4, rows: 11 } }), /8x11/);
  assert.throws(() => validateContract({ ...observedPetContract, spriteVersionNumber: 1 }), /spriteVersionNumber 2/);
});

test("resolves Pet roots for macOS and Windows without hard-coded user paths", () => {
  assert.equal(defaultPetsDir({ platform: "darwin", env: { HOME: "/Users/tester" } }), join("/Users/tester", ".codex", "pets"));
  assert.equal(defaultPetsDir({ platform: "win32", env: { USERPROFILE: "C:\\Users\\Tester" } }), "C:\\Users\\Tester\\.codex\\pets");
  assert.equal(defaultPetsDir({ platform: "win32", env: { CODEX_HOME: "D:\\Codex" } }), "D:\\Codex\\pets");
});

test("creates, validates, installs, and reports a deterministic Pet atlas", { skip: !sharp && "sharp is unavailable" }, async () => {
  await withTempDir("codex-pet-", async (root) => {
    const frames = await makePetFrames(root);
    const created = await createPet({ id: "test-pet", displayName: "Test Pet", frames, out: join(root, "pet"), contract: observedPetContract });
    assert.equal(created.status, "created");
    const createdManifest = JSON.parse(await readFile(join(root, "pet", "pet.json"), "utf8"));
    assert.deepEqual(createdManifest, {
      id: "test-pet",
      displayName: "Test Pet",
      description: "A cute anthropomorphic desktop companion.",
      spriteVersionNumber: 2,
      spritesheetPath: createdManifest.spritesheetPath,
    });
    assert.ok(["spritesheet.webp", "spritesheet.png"].includes(createdManifest.spritesheetPath));
    const validated = await validatePetDirectory(join(root, "pet"), { contract: observedPetContract });
    assert.deepEqual(validated.dimensions, { width: 128, height: 176, hasAlpha: true, cornerAlpha: [0, 0, 0, 0], cornersTransparent: true, transparentRgbResidue: 0 });
    const installed = await installPet(join(root, "pet"), { petsDir: join(root, "pets"), contract: observedPetContract });
    assert.equal(installed.status, "installed");
    assert.equal(installed.selection, "refresh-required");
    await assert.rejects(installPet(join(root, "pet"), { petsDir: join(root, "pets"), contract: observedPetContract }), /pass --replace/);
    const status = await petStatus({ petsDir: join(root, "pets") });
    assert.equal(status.active, "test-pet");
    assert.equal(status.pets[0].id, "test-pet");
  });
});

test("example Pet matches the observed v2 1536x2288 and 20 MiB contract", { skip: !sharp && "sharp is unavailable" }, async () => {
  const validation = await validatePetDirectory(join(skillRoot, "examples/pets/mascot"), { contract: DEFAULT_PET_CONTRACT, allowProvisional: true });
  assert.deepEqual(validation.dimensions, { width: 1536, height: 2288, hasAlpha: true, cornerAlpha: [0, 0, 0, 0], cornersTransparent: true, transparentRgbResidue: 0 });
  assert.ok((await readFile(validation.spritesheet)).length <= 20 * 1024 * 1024);
});

test("creates and validates a paired theme and Pet bundle", { skip: !sharp && "sharp is unavailable" }, async () => {
  await withTempDir("codex-paired-", async (root) => {
    const frames = await makePetFrames(root);
    const pet = await createPet({ id: "paired-demo", displayName: "Paired Demo", frames, out: join(root, "pet"), contract: observedPetContract });
    const theme = join(root, "theme");
    await makeTheme(theme, { ...validManifest, id: "paired-demo", name: "Paired Demo" });
    const bundle = await createPairBundle({ id: "paired-demo", displayName: "Paired Demo", themeDir: theme, petDir: pet.directory, out: join(root, "bundle"), contract: observedPetContract });
    assert.equal(bundle.status, "created");
    await assert.rejects(createPairBundle({ id: "paired-demo", displayName: "Paired Demo", themeDir: theme, petDir: pet.directory, out: join(root, "bundle"), contract: observedPetContract }), /pass --replace/);
    const validated = await validatePairBundle(bundle.directory, { contract: observedPetContract });
    assert.equal(validated.bundle.themeId, "paired-demo");
    assert.equal(validated.bundle.petId, "paired-demo");
  });
});

test("uses visible ChatGPT Desktop Pets controls instead of private app state", () => {
  assert.match(buildMacOpenSettingsScript(), /keystroke "," using \{command down\}/);
  assert.match(buildWindowsOpenSettingsScript(), /SendKeys\('\^,'\)/);
  assert.match(buildWindowsOpenSettingsScript(), /AppActivate\('Codex'\)/);
  assert.match(OPEN_PETS_PANEL_EXPRESSION, /data-settings-panel-slug/);
  assert.match(OPEN_PETS_PANEL_EXPRESSION, /slug === 'pets'/);
  assert.match(OPEN_PETS_PANEL_EXPRESSION, /slug === 'appearance'/);
  assert.match(OPEN_PETS_PANEL_EXPRESSION, /getBoundingClientRect/);
  assert.match(OPEN_SETTINGS_EXPRESSION, /settings|preferences/);
  assert.match(OPEN_SETTINGS_EXPRESSION, /data-testid/);
  assert.match(OPEN_SETTINGS_EXPRESSION, /candidates/);
  assert.match(OPEN_ACCOUNT_MENU_EXPRESSION, /account|profile|avatar/);
  assert.match(OPEN_ACCOUNT_MENU_EXPRESSION, /aria-haspopup/);
  assert.match(OPEN_ACCOUNT_MENU_EXPRESSION, /account-menu-not-found/);
  assert.match(PET_UI_STATE_EXPRESSION, /h1,h2,h3/);
  assert.match(PET_UI_STATE_EXPRESSION, /settings-panel/);
  assert.match(REFRESH_PETS_EXPRESSION, /button,\[role=\\?\"button/);
  assert.match(REFRESH_PETS_EXPRESSION, /custom\\s/);
  assert.match(selectPetExpression("paired-demo"), /custom:paired-demo/);
  assert.match(selectPetExpression("paired-demo"), /data-pet-id/);
  assert.match(petSelectionStateExpression("paired-demo"), /已选/);
  assert.match(petSelectionStateExpression("paired-demo"), /assetLoaded/);
  assert.match(petSelectionStateExpression("paired-demo"), /naturalWidth/);
});

test("Windows Pet evidence command requires native selection and loaded asset", async () => {
  assert.deepEqual(parseVerifyPetArgs(["--pet-id", "paired-demo", "--port", "9341", "--json"]), { petId: "paired-demo", port: 9341, restoreApp: true });
  assert.deepEqual(parseVerifyPetArgs(["--pet-id", "paired-demo", "--no-restore"]), { petId: "paired-demo", port: 9341, restoreApp: false });
  const verified = await verifyPetDesktop({ petId: "paired-demo", port: 9341, restoreApp: true }, async () => ({ selection: "native-ui-confirmed", assetLoaded: true }));
  assert.equal(verified.status, "verified");
  await assert.rejects(verifyPetDesktop({ petId: "paired-demo", port: 9341 }, async () => ({ selection: "refresh-required", assetLoaded: false })), /did not confirm native Pet selection/);
});

test("verifies the official hatch-pet contract independently of native UI selection", async () => {
  await withTempDir("codex-pet-contract-", async (root) => {
    const source = join(root, "codex-pet-contract.md");
    const markdown = `# Codex V2 Pet Contract\n\n- Version: \`spriteVersionNumber: 2\`.\n- Dimensions: \`1536x2288\`.\n- Grid: 8 columns x 11 rows.\n- Cell: \`192x208\`.\n- Background: transparent.\n- Rows \`0-8\`: standard animation states.\n- Rows \`9-10\`: 16 clockwise look directions.\n- \`000\` means up / 12 o'clock, not neutral/front.\n- The 8x9 \`1536x1872\` atlas is an intermediate assembly artifact only.\n- Directions: 000, 022.5, 045, 067.5, 090, 112.5, 135, 157.5, 180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5.`;
    await writeFile(source, markdown);
    const contract = join(root, "contract.json");
    await writeFile(contract, JSON.stringify(observedPetContract));
    assert.deepEqual(parseVerifyPetContractArgs(["--source", source, "--contract", contract, "--platform", "win32", "--json"]), { source, contract, platform: "win32" });
    const result = await verifyPetContract({ source, contract, platform: "win32" });
    assert.equal(result.status, "verified");
    assert.equal(result.platform, "win32");
    assert.equal(result.evidence.dimensions, "128x176");
    assert.equal(result.evidence.lookDirections, 16);
  });
});

test("paired switch records a native Pet selection postcondition", async () => {
  await withTempDir("codex-paired-switch-", async (root) => {
    const frames = await makePetFrames(root);
    const pet = await createPet({ id: "paired-demo", displayName: "Paired Demo", frames, out: join(root, "pet"), contract: observedPetContract });
    const theme = join(root, "theme");
    await makeTheme(theme, { ...validManifest, id: "paired-demo", name: "Paired Demo" });
    const bundle = await createPairBundle({ id: "paired-demo", displayName: "Paired Demo", themeDir: theme, petDir: pet.directory, out: join(root, "bundle"), contract: observedPetContract });
    const result = await switchPairBundle(bundle.directory, {
      contract: observedPetContract,
      petsDir: join(root, "pets"),
      commandApplyFn: async () => ({ status: "applied", themeId: "paired-demo" }),
      selectPetFn: async ({ petId }) => ({ status: "selected", selection: "native-ui-confirmed", petId, adapterVersion: "test", refreshed: true, assetLoaded: true }),
      appDataRootFn: () => join(root, "app-data"),
    });
    assert.equal(result.status, "theme-applied-pet-selected");
    assert.equal(result.pairedState.petSelection, "native-ui-confirmed");
    assert.equal((await petStatus({ petsDir: join(root, "pets") })).selection, "native-ui-confirmed");
    assert.equal((await petStatus({ petsDir: join(root, "pets") })).assetLoaded, true);
    assert.equal(JSON.parse(await readFile(join(root, "app-data", "paired-state.json"), "utf8")).petUi.selection, "native-ui-confirmed");
  });
});

test("paired switch preserves an explicit manual-refresh fallback when native UI is unavailable", async () => {
  await withTempDir("codex-paired-fallback-", async (root) => {
    const frames = await makePetFrames(root);
    const pet = await createPet({ id: "paired-demo", displayName: "Paired Demo", frames, out: join(root, "pet"), contract: observedPetContract });
    const theme = join(root, "theme");
    await makeTheme(theme, { ...validManifest, id: "paired-demo", name: "Paired Demo" });
    const bundle = await createPairBundle({ id: "paired-demo", displayName: "Paired Demo", themeDir: theme, petDir: pet.directory, out: join(root, "bundle"), contract: observedPetContract });
    const result = await switchPairBundle(bundle.directory, {
      contract: observedPetContract,
      petsDir: join(root, "pets"),
      commandApplyFn: async () => ({ status: "scheduled", themeId: "paired-demo" }),
      selectPetFn: async () => { throw Object.assign(new Error("settings unavailable"), { code: "PET_NATIVE_UI_UNAVAILABLE" }); },
      appDataRootFn: () => join(root, "app-data"),
    });
    assert.equal(result.status, "theme-scheduled-pet-refresh-required");
    assert.equal(result.pairedState.petSelection, "refresh-required");
    assert.equal(result.petSelection.code, "PET_NATIVE_UI_UNAVAILABLE");
  });
});

test("distribution files are English ASCII text and SKILL has valid frontmatter", async () => {
  const textExpected = ["SKILL.md", "agents/openai.yaml", "examples/cyberpunk/prompt.md", "examples/cyberpunk/theme.json", "examples/pets/mascot/pet.json", "examples/slayers-xellos-night/theme.json", "scripts/apply.mjs", "scripts/create-paired.mjs", "scripts/create-pet.mjs", "scripts/create-theme.mjs", "scripts/install-pet.mjs", "scripts/paired-status.mjs", "scripts/paired.mjs", "scripts/pet-desktop.mjs", "scripts/pet.mjs", "scripts/persist.mjs", "scripts/switch-paired.mjs", "scripts/validate-pet.mjs", "scripts/verify-pet-contract.mjs", "scripts/verify-pet-desktop.mjs", "scripts/windows/apply.ps1", "templates/pet-contract.json", "templates/pet.json", "templates/theme.json"].sort((a, b) => a.localeCompare(b));
  const binaryExpected = ["examples/pets/mascot/spritesheet.webp", "examples/slayers-xellos-night/hero.webp"];
  assert.deepEqual((await listFiles(skillRoot)).map((value) => value.replaceAll("\\", "/")), [...textExpected, ...binaryExpected].sort((a, b) => a.localeCompare(b)));
  const skill = await readFile(join(skillRoot, "SKILL.md"), "utf8");
  assert.match(skill, /^---\r?\nname: codex-skin-studio\r?\ndescription: [^\r\n]+\r?\n---\r?\n/);
  assert.match(skill, /invoke `\$imagegen` before creating theme files/);
  assert.match(skill, /native `image_gen` tool/);
  assert.match(skill, /404 Not Found/);
  assert.match(skill, /no conversation images are available/);
  assert.match(skill, /brand workbench composition contract/);
  assert.match(skill, /brand logo and the dedicated navigation system/);
  assert.match(skill, /immersive background scene and preserve room for the runtime gradient safety layer/);
  assert.match(skill, /optional brand information card/);
  assert.match(skill, /dedicated input workbench/);
  assert.match(skill, /optional portrait card as a secondary non-core accent/);
  assert.match(skill, /One-shot theme output contract/);
  assert.match(skill, /create-theme\.mjs/);
  assert.match(skill, /persist\.mjs.*install/);
  assert.match(skill, /Skill installation itself only copies files/);
  assert.match(skill, /Do not use a ChatGPT Scheduled Task/);
  assert.match(skill, /status.*active/);
  assert.match(skill, /large-head and small-body/);
  assert.match(skill, /PET_CONTRACT_MISMATCH/);
  assert.match(skill, /create-paired\.mjs/);
  assert.match(skill, /theme-applied-pet-refresh-required/);
  assert.match(await readFile(join(skillRoot, "agents/openai.yaml"), "utf8"), /invoke \$imagegen first/);
  for (const relative of textExpected) {
    const bytes = await readFile(join(skillRoot, relative));
    assert.ok(bytes.every((byte) => byte < 128), `${relative} must be ASCII-only`);
  }
  for (const relative of binaryExpected) {
    const image = await readFile(join(skillRoot, relative));
    assert.ok(image.length > 0);
    assert.equal(image.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(image.subarray(8, 12).toString("ascii"), "WEBP");
  }
});

test("package script creates exactly the new Skill folder contents", async () => {
  await execFileAsync(process.execPath, [packageScript]);
  const archive = join(repoRoot, "output/codex-skin-studio.skill");
  const firstHash = createHash("sha256").update(await readFile(archive)).digest("hex");
  await execFileAsync(process.execPath, [packageScript]);
  const secondHash = createHash("sha256").update(await readFile(archive)).digest("hex");
  assert.equal(secondHash, firstHash, "packaging should be byte-for-byte deterministic");
  const entries = zipEntries(await readFile(archive));
  const expectedEntries = [
    "codex-skin-studio/",
    "codex-skin-studio/SKILL.md",
    "codex-skin-studio/agents/",
    "codex-skin-studio/agents/openai.yaml",
    "codex-skin-studio/examples/",
    "codex-skin-studio/examples/cyberpunk/",
    "codex-skin-studio/examples/cyberpunk/prompt.md",
    "codex-skin-studio/examples/cyberpunk/theme.json",
    "codex-skin-studio/examples/pets/",
    "codex-skin-studio/examples/pets/mascot/",
    "codex-skin-studio/examples/pets/mascot/pet.json",
    "codex-skin-studio/examples/pets/mascot/spritesheet.webp",
    "codex-skin-studio/examples/slayers-xellos-night/",
    "codex-skin-studio/examples/slayers-xellos-night/hero.webp",
    "codex-skin-studio/examples/slayers-xellos-night/theme.json",
    "codex-skin-studio/scripts/",
    "codex-skin-studio/scripts/apply.mjs",
    "codex-skin-studio/scripts/create-paired.mjs",
    "codex-skin-studio/scripts/create-pet.mjs",
    "codex-skin-studio/scripts/create-theme.mjs",
    "codex-skin-studio/scripts/install-pet.mjs",
    "codex-skin-studio/scripts/paired-status.mjs",
    "codex-skin-studio/scripts/paired.mjs",
    "codex-skin-studio/scripts/pet.mjs",
    "codex-skin-studio/scripts/persist.mjs",
    "codex-skin-studio/scripts/pet-desktop.mjs",
    "codex-skin-studio/scripts/windows/",
    "codex-skin-studio/scripts/windows/apply.ps1",
    "codex-skin-studio/scripts/switch-paired.mjs",
    "codex-skin-studio/scripts/validate-pet.mjs",
    "codex-skin-studio/scripts/verify-pet-contract.mjs",
    "codex-skin-studio/scripts/verify-pet-desktop.mjs",
    "codex-skin-studio/templates/",
    "codex-skin-studio/templates/pet-contract.json",
    "codex-skin-studio/templates/pet.json",
    "codex-skin-studio/templates/theme.json",
  ];
  assert.equal(entries.length, expectedEntries.length);
  assert.deepEqual(new Set(entries), new Set(expectedEntries));
  assert.ok(entries.every((entry) => !/README|custom-pet|themes\//i.test(entry)));
});

async function listFiles(root, prefix = "") {
  const result = [];
  for (const name of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = join(prefix, name.name);
    if (name.isDirectory()) result.push(...await listFiles(root, relative));
    else result.push(relative);
  }
  return result;
}

function zipEntries(archive) {
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const end = archive.lastIndexOf(signature);
  assert.ok(end >= 0, "ZIP end record is missing");
  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(archive.readUInt32LE(offset), 0x02014b50, "ZIP central directory entry is invalid");
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    entries.push(archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries.sort((left, right) => left.localeCompare(right));
}
