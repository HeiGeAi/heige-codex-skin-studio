#!/usr/bin/env node

import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const PORT = 9341;
const SWITCHER_PORT = 9342;
const STYLE_ID = "codex-skin-studio-style";
const SWITCHER_ID = "codex-skin-studio-switcher";
const BUNDLE_ID = "com.openai.codex";
const APP_DISPLAY_NAME = "ChatGPT Desktop";
const EXPECTED_TEAM_ID = "2DC432GLL2";
const ROOT = join(homedir(), "Library", "Application Support", "CodexSkinStudio");
const THEMES = join(ROOT, "themes");
const STATE = join(ROOT, "state.json");
const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const execFileAsync = promisify(execFile);

function fail(code, message, extra = {}) {
  return { status: "failed", code, message, ...extra };
}

function commandErrorCode(error) {
  const preservedCodes = new Set(["NO_ELIGIBLE_RENDERER", "RESTORE_FAILED", "RESTART_SCHEDULE_FAILED"]);
  const explicit = error?.code || (error instanceof AggregateError ? error.errors.find((item) => preservedCodes.has(item?.code))?.code : null);
  if (preservedCodes.has(explicit)) return explicit;
  const message = String(error?.message || error || "").toLowerCase();
  if (/port must be an integer/.test(message)) return "INVALID_PORT";
  if (/theme manifest|theme schema|theme id|theme name|hero must|logo must|polaroid must|theme colors|theme copy|copy\.|six-digit hex|contrast ratio|theme directory|theme\.json|hero escapes/.test(message)) return "THEME_INVALID";
  if (/chatgpt desktop application was not found|chatgpt desktop application validation failed|codex application was not found|codex application validation failed|application discovery|application validation/.test(message)) return "APP_UNAVAILABLE";
  if (/main codex renderer was not found|no eligible codex renderer/.test(message)) return "NO_ELIGIBLE_RENDERER";
  if (/injection|renderer evaluation failed|hero.*decoded|renderer did not become ready/.test(message)) return "INJECTION_FAILED";
  if (/cdp|websocket|target list|target.*(closed|disappeared)|protocol|fetch failed|connection refused|http \d{3}/.test(message)) return "CDP_ERROR";
  return "COMMAND_FAILED";
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

function inside(root, file) {
  const relativePath = relative(root, file);
  return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function portOf(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("port must be an integer from 1024 through 65535");
  }
  return port;
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() || "help";
  let themeDir = null;
  if (command === "validate" || command === "apply") {
    themeDir = args.shift();
  }
  let port = PORT;
  let jsonOutput = false;
  let restartNormal = false;
  for (let i = 0; i < args.length; i += 1) {
    const argument = args[i];
    if (argument === "--json") {
      jsonOutput = true;
    } else if (argument === "--restart-normal") {
      restartNormal = true;
    } else if (argument === "--port") {
      port = portOf(args[++i]);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return { command, themeDir, port, jsonOutput, restartNormal };
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("theme manifest must be an object");
  const allowed = new Set(["schemaVersion", "id", "name", "hero", "logo", "polaroid", "colors", "copy"]);
  for (const key of Object.keys(manifest)) if (!allowed.has(key)) throw new Error(`unsupported theme field: ${key}`);
  if (manifest.schemaVersion !== 1) throw new Error("unsupported theme schema");
  if (typeof manifest.id !== "string" || !ID.test(manifest.id)) throw new Error("theme id must use lowercase letters, numbers, and hyphens");
  if (typeof manifest.name !== "string" || !manifest.name.trim() || manifest.name.trim().length > 80) throw new Error("theme name must be 1 to 80 characters");
  const assetPath = (value, field, optional = false) => {
    if (optional && (value === undefined || value === null)) return undefined;
    if (typeof value !== "string" || !MIME[extname(value).toLowerCase()] || value.includes("..") || value.startsWith("/") || value.includes("\\")) throw new Error(`${field} must be a relative PNG, JPEG, or WebP path`);
    return value;
  };
  const hero = assetPath(manifest.hero, "hero");
  const logo = assetPath(manifest.logo, "logo", true);
  const polaroid = assetPath(manifest.polaroid, "polaroid", true);
  if (!manifest.colors || typeof manifest.colors !== "object" || Array.isArray(manifest.colors)) throw new Error("theme colors must be an object");
  for (const key of ["accent", "secondary", "surface", "text"]) if (typeof manifest.colors[key] !== "string" || !HEX.test(manifest.colors[key])) throw new Error(`${key} must be a six-digit hex color`);
  let copy;
  if (manifest.copy !== undefined && manifest.copy !== null) {
    if (typeof manifest.copy !== "object" || Array.isArray(manifest.copy)) throw new Error("theme copy must be an object");
    const copyKeys = new Set(["brand", "headline", "tagline"]);
    for (const key of Object.keys(manifest.copy)) if (!copyKeys.has(key)) throw new Error(`unsupported copy field: ${key}`);
    const limits = { brand: 80, headline: 140, tagline: 120 };
    copy = {};
    for (const key of copyKeys) {
      if (manifest.copy[key] === undefined) continue;
      if (typeof manifest.copy[key] !== "string" || !manifest.copy[key].trim() || manifest.copy[key].trim().length > limits[key]) throw new Error(`copy.${key} must be 1 to ${limits[key]} characters`);
      copy[key] = manifest.copy[key].trim();
    }
    if (!Object.keys(copy).length) copy = undefined;
  }
  return {
    schemaVersion: 1,
    id: manifest.id,
    name: manifest.name.trim(),
    hero,
    ...(logo ? { logo } : {}),
    ...(polaroid ? { polaroid } : {}),
    ...(copy ? { copy } : {}),
    colors: Object.fromEntries(["accent", "secondary", "surface", "text"].map((key) => [key, manifest.colors[key].toUpperCase()])),
  };
}

function luminance(hex) {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function contrastRatio(left, right) {
  const brighter = Math.max(luminance(left), luminance(right));
  const darker = Math.min(luminance(left), luminance(right));
  return (brighter + 0.05) / (darker + 0.05);
}

function readableOn(background, candidates) {
  return candidates.reduce((best, candidate) => contrastRatio(background, candidate) > contrastRatio(background, best) ? candidate : best);
}

async function loadTheme(themeDir) {
  if (!themeDir) throw new Error("theme directory is required");
  const root = resolve(themeDir);
  const manifest = validateManifest(JSON.parse(await readFile(join(root, "theme.json"), "utf8")));
  const realRoot = await realpath(root);
  const resolveAsset = async (relativePath, field) => {
    if (!relativePath) return null;
    const asset = resolve(root, relativePath);
    if (!inside(root, asset) || !inside(realRoot, await realpath(asset))) throw new Error(`${field} escapes the theme directory`);
    const info = await lstat(asset);
    if (!info.isFile() || info.size < 1) throw new Error(`${field} must be a non-empty regular file`);
    return asset;
  };
  const hero = await resolveAsset(manifest.hero, "hero");
  const logo = await resolveAsset(manifest.logo, "logo");
  const polaroid = await resolveAsset(manifest.polaroid, "polaroid");
  if ((Math.max(luminance(manifest.colors.surface), luminance(manifest.colors.text)) + 0.05) / (Math.min(luminance(manifest.colors.surface), luminance(manifest.colors.text)) + 0.05) < 4.5) throw new Error("surface and text colors must have a contrast ratio of at least 4.5");
  return { root, hero, logo, polaroid, manifest };
}

async function listThemes(themesDir = THEMES) {
  let entries;
  try {
    entries = await readdir(themesDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const themes = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    try {
      const theme = await loadTheme(join(themesDir, entry.name));
      if (themes.some((item) => item.id === theme.manifest.id)) continue;
      themes.push({
        themeDir: theme.root,
        id: theme.manifest.id,
        name: theme.manifest.name,
        colors: theme.manifest.colors,
      });
    } catch {
      // Ignore incomplete or invalid directories so one failed draft cannot hide valid skins.
    }
  }
  return themes;
}

function appCandidates() {
  return [
    "/Applications/ChatGPT.app",
    "/Applications/Codex.app",
    join(homedir(), "Applications/ChatGPT.app"),
    join(homedir(), "Applications/Codex.app"),
  ];
}

function appPath() {
  for (const path of appCandidates()) {
    if (appInfoSync(path)?.valid) return path;
  }
  return null;
}

function appInfoSync(path) {
  try {
    const bundleId = execFileSync("/usr/bin/defaults", ["read", join(path, "Contents/Info.plist"), "CFBundleIdentifier"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const executable = execFileSync("/usr/bin/defaults", ["read", join(path, "Contents/Info.plist"), "CFBundleExecutable"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const executablePath = join(path, "Contents", "MacOS", executable);
    execFileSync("/bin/test", ["-x", executablePath]);
    let teamId = null;
    const signature = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", path], { encoding: "utf8" });
    teamId = `${signature.stdout || ""}\n${signature.stderr || ""}`.match(/TeamIdentifier=([^\n]+)/)?.[1] || null;
    const signatureValid = signature.status === 0 && teamId === EXPECTED_TEAM_ID;
    return { valid: bundleId === BUNDLE_ID && signatureValid, bundleId, executable, executablePath, teamId, signatureValid };
  } catch {
    return null;
  }
}

function discover() {
  try {
    const paths = execFileSync("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${BUNDLE_ID}'`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().split("\n").filter(Boolean);
    for (const path of paths) if (appInfoSync(path)?.valid) return path;
  } catch {
    // Spotlight is optional; the fixed candidate scan remains the compatibility path.
  }
  return appPath();
}

async function targets(port, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { redirect: "error", signal: controller.signal });
    if (!response.ok) throw new Error(`CDP discovery returned HTTP ${response.status}`);
    const list = await response.json();
    if (!Array.isArray(list)) throw new Error("CDP discovery returned malformed target list");
    return list.filter((target) => {
      if (!target || target.type !== "page" || typeof target.url !== "string" || !target.url.startsWith("app://") || typeof target.webSocketDebuggerUrl !== "string" || isSecondaryTarget(target)) return false;
      try {
        const debuggerUrl = new URL(target.webSocketDebuggerUrl);
        return debuggerUrl.protocol === "ws:" && debuggerUrl.hostname === "127.0.0.1" && debuggerUrl.port === String(port) && debuggerUrl.pathname.startsWith("/");
      } catch {
        return false;
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

function isSecondaryTarget(target) {
  return /avatar-overlay|notification|permission|settings\/popup/i.test(target?.url || "");
}

function isUnavailableListenerError(error) {
  const refusedCodes = new Set(["ECONNREFUSED", "ERR_CONNECTION_REFUSED"]);
  const seen = new Set();
  for (let value = error; value && !seen.has(value); value = value.cause) {
    seen.add(value);
    if (refusedCodes.has(value.code)) return true;
  }
  return false;
}

class Session {
  constructor(url, { WebSocketImpl = globalThis.WebSocket, openTimeoutMs = 5000 } = {}) {
    if (!/^ws:\/\/127\.0\.0\.1:\d+\//.test(url)) {
      throw new Error("CDP WebSocket must be loopback-only");
    }
    this.url = url;
    this.next = 1;
    this.pending = new Map();
    this.WebSocketImpl = WebSocketImpl;
    this.openTimeoutMs = openTimeoutMs;
  }

  async open() {
    if (typeof this.WebSocketImpl !== "function") throw new Error("WebSocket is unavailable");
    this.socket = new this.WebSocketImpl(this.url);
    const rejectPending = (error) => {
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(error);
      }
      this.pending.clear();
    };
    const clearSocket = () => {
      if (!this.socket) return;
      this.socket.onopen = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      this.socket.onmessage = null;
    };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error("CDP connection timed out");
        rejectPending(error);
        clearSocket();
        try { this.socket.close(); } catch { /* best effort during connection teardown */ }
        reject(error);
      }, this.openTimeoutMs);
      this.socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.socket.onerror = () => {
        clearTimeout(timer);
        const error = new Error("CDP WebSocket error");
        rejectPending(error);
        reject(error);
      };
      this.socket.onclose = () => {
        clearTimeout(timer);
        const error = new Error("CDP WebSocket closed");
        rejectPending(error);
        reject(error);
      };
    });
    this.socket.onmessage = (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch {
        rejectAll(new Error("CDP WebSocket returned malformed message"));
        return;
      }
      const hasId = Object.prototype.hasOwnProperty.call(message || {}, "id");
      const hasResult = Object.prototype.hasOwnProperty.call(message || {}, "result");
      const hasError = Object.prototype.hasOwnProperty.call(message || {}, "error");
      const validEventParams = !Object.prototype.hasOwnProperty.call(message || {}, "params") || (message.params && typeof message.params === "object" && !Array.isArray(message.params) && Object.getPrototypeOf(message.params) === Object.prototype);
      if (!hasId && typeof message?.method === "string" && !hasResult && !hasError && validEventParams) return;
      if (!message || !Number.isInteger(message.id)) {
        rejectAll(new Error("CDP WebSocket returned an invalid message envelope"));
        return;
      }
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id);
      clearTimeout(item.timer);
      if (hasResult === hasError) {
        item.reject(new Error(`CDP ${item.method} returned an invalid response envelope`));
      } else if (hasError) {
        if (!message.error || typeof message.error !== "object" || Array.isArray(message.error) || typeof message.error.message !== "string" || !message.error.message) {
          item.reject(new Error(`CDP ${item.method} returned a malformed error payload`));
        } else {
          item.reject(new Error(`CDP ${item.method} failed: ${message.error.message}`));
        }
      } else {
        item.resolve(message.result);
      }
    };
    const rejectAll = (error) => {
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
      this.pending.clear();
    };
    this.socket.onerror = () => rejectAll(new Error("CDP WebSocket error"));
    this.socket.onclose = () => rejectAll(new Error("CDP WebSocket closed"));
    await this.send("Runtime.enable");
    await this.send("Page.enable");
  }

  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.socket.send(JSON.stringify({ id, method, params })); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result?.exceptionDetails) throw new Error("renderer evaluation failed");
    return result?.result?.value;
  }

  close() {
    this.socket?.close();
  }
}

async function evaluateAll(list, expression) {
  const values = [];
  for (const target of list) {
    const session = new Session(target.webSocketDebuggerUrl);
    try {
      await session.open();
      values.push(await session.evaluate(expression));
    } finally {
      session.close();
    }
  }
  return values;
}

const MAIN_TARGET_PROBE = `(() => { const root = document.getElementById("root"); const shell = document.querySelector(".app-shell-left-panel, .main-surface, .browser-main-surface, .composer-surface-chrome"); const title = document.title || ""; return { main: Boolean(root && shell), root: Boolean(root), shell: Boolean(shell), title, url: location.href }; })()`;
const STATUS_EXPRESSION = `(() => { const node = document.getElementById(${JSON.stringify(STYLE_ID)}); const root = document.getElementById("root"); const computed = root ? getComputedStyle(root) : null; return { installed: Boolean(node), connected: Boolean(node?.isConnected), themeId: node?.dataset.themeId || null, heroLoaded: node?.dataset.heroLoaded === "true", logoLoaded: node?.dataset.logoLoaded === "true", polaroidLoaded: node?.dataset.polaroidLoaded === "true", cssText: node?.textContent?.trim() || "", cssRules: node?.sheet ? node.sheet.cssRules.length : 0, rootBackground: Boolean(computed && computed.backgroundImage && computed.backgroundImage !== "none") }; })()`;
const REMOVE_STYLE_EXPRESSION = `(() => { const node = document.getElementById(${JSON.stringify(STYLE_ID)}); const switcher = document.getElementById(${JSON.stringify(SWITCHER_ID)}); switcher?.remove(); if (!node) return 0; node.remove(); return node.isConnected ? 0 : 1; })()`;

function injectionVerified(value, themeId, assets = {}) {
  return Boolean(value && value.connected && value.themeId === themeId && value.heroLoaded === true && (!assets.logo || value.logoLoaded === true) && (!assets.polaroid || value.polaroidLoaded === true) && value.cssText && value.cssRules > 0 && value.rootBackground);
}

async function selectMainTarget(list, evaluate = async (target, expression) => {
  const session = new Session(target.webSocketDebuggerUrl);
  try { await session.open(); return await session.evaluate(expression); } finally { session.close(); }
}, { allowTransient = false } = {}) {
  const candidates = [...list].filter((target) => !isSecondaryTarget(target)).sort((left, right) => `${left.url || ""}\n${left.title || ""}\n${left.id || ""}`.localeCompare(`${right.url || ""}\n${right.title || ""}\n${right.id || ""}`));
  const valid = [];
  const probeErrors = [];
  for (const target of candidates) {
    try {
      const probe = await evaluate(target, MAIN_TARGET_PROBE);
      if (probe?.main && probe.root) valid.push({ target, probe });
    } catch (error) {
      if (!allowTransient || !isTransientProbeError(error)) probeErrors.push(error);
    }
  }
  valid.sort((left, right) => ((right.probe.shell ? 100 : 0) + (/codex/i.test(right.probe.title || "") ? 20 : 0) + (/index\.html|main/i.test(right.probe.url || "") ? 10 : 0)) - ((left.probe.shell ? 100 : 0) + (/codex/i.test(left.probe.title || "") ? 20 : 0) + (/index\.html|main/i.test(left.probe.url || "") ? 10 : 0)) || `${left.target.url || ""}\n${left.target.id || ""}`.localeCompare(`${right.target.url || ""}\n${right.target.id || ""}`));
  if (!valid.length && probeErrors.length) throw new AggregateError(probeErrors, "main Codex renderer probes failed");
  return valid[0]?.target || null;
}

function isTransientProbeError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return error?.code === "ECONNRESET" || /websocket closed|target closed|target disappeared|context destroyed|session closed/.test(message);
}

async function dataUrl(file) {
  const type = MIME[extname(file).toLowerCase()];
  const contents = await readFile(file);
  return `data:${type};base64,${contents.toString("base64")}`;
}

function css(theme, hero, logo = null, polaroid = null) {
  const dark = luminance(theme.colors.surface) < 0.35;
  const onAccent = readableOn(theme.colors.accent, [theme.colors.surface, theme.colors.text]);
  const copyText = theme.copy ? [theme.copy.headline, theme.copy.tagline].filter(Boolean).join("\\A ") : "";
  const brandButtonSelector = '.app-shell-left-panel nav > div:first-child > div:first-child > button[aria-haspopup="menu"]';
  const brandFallbackCss = theme.copy?.brand && !logo ? `
${brandButtonSelector} {
  position: relative;
  width: 214px;
  min-width: 0;
  overflow: visible !important;
  color: var(--codex-skin-text) !important;
}

${brandButtonSelector} > span.truncate {
  display: inline-block;
  width: 100%;
  max-width: calc(100% - 18px);
  overflow: visible !important;
  color: transparent !important;
  font-size: 0 !important;
  white-space: nowrap;
}

${brandButtonSelector} > span.truncate::after {
  content: ${JSON.stringify(theme.copy.brand)};
  display: block;
  overflow: visible;
  background: linear-gradient(110deg, var(--codex-skin-accent), var(--codex-skin-text) 48%, var(--codex-skin-secondary));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  font-family: "Baskerville", "Iowan Old Style", "Palatino Linotype", Georgia, serif;
  font-size: 17px;
  font-style: italic;
  font-weight: 700;
  letter-spacing: 0.015em;
  line-height: 1.25;
  text-shadow: 0 0 10px color-mix(in srgb, var(--codex-skin-accent) 42%, transparent);
  white-space: nowrap;
}

${brandButtonSelector}::after {
  position: absolute;
  right: 26px;
  bottom: 1px;
  left: 8px;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--codex-skin-accent), var(--codex-skin-secondary), transparent);
  box-shadow: 0 0 8px color-mix(in srgb, var(--codex-skin-accent) 58%, transparent);
  content: "";
  pointer-events: none;
}
` : "";
  const logoCss = logo ? `
${brandButtonSelector} {
  background: url(${JSON.stringify(logo)}) left center / contain no-repeat !important;
  width: 214px;
  height: 78px !important;
  margin: 4px 0 0;
}

${brandButtonSelector} > span,
${brandButtonSelector} > svg {
  visibility: hidden;
}
` : "";
  const polaroidCss = polaroid ? `
body::after {
  content: "";
  position: fixed;
  right: 20px;
  bottom: 24px;
  width: 200px;
  height: 300px;
  background: url(${JSON.stringify(polaroid)}) center / contain no-repeat;
  pointer-events: none;
  z-index: 15;
  filter: drop-shadow(0 12px 26px color-mix(in srgb, var(--codex-skin-text) 24%, transparent));
}
` : "";
  const copyCss = theme.copy && (theme.copy.headline || theme.copy.tagline) ? `
body::before {
  position: fixed;
  z-index: 20;
  top: clamp(88px, 16vh, 180px);
  right: max(24px, 4vw);
  width: min(280px, 23vw);
  box-sizing: border-box;
  padding: 16px 18px;
  border: 1px solid color-mix(in srgb, var(--codex-skin-accent) 52%, transparent);
  border-radius: 12px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--codex-skin-surface) 82%, transparent), color-mix(in srgb, var(--codex-skin-secondary) 16%, transparent));
  box-shadow: 0 12px 32px color-mix(in srgb, var(--codex-skin-surface) 48%, transparent);
  backdrop-filter: blur(16px) saturate(1.12);
  content: ${JSON.stringify(copyText)};
  color: var(--codex-skin-text);
  white-space: pre-line;
  font: 650 14px/1.45 ui-rounded, system-ui;
  pointer-events: none;
}
` : "";
  return `:root {
  color-scheme: ${dark ? "dark" : "light"} !important;
  --codex-skin-accent: ${theme.colors.accent};
  --codex-skin-secondary: ${theme.colors.secondary};
  --codex-skin-surface: ${theme.colors.surface};
  --codex-skin-text: ${theme.colors.text};
  --codex-skin-on-accent: ${onAccent};
  --codex-skin-control-surface: color-mix(in srgb, var(--codex-skin-surface) 94%, var(--codex-skin-text) 6%);
  --codex-skin-panel-surface: color-mix(in srgb, var(--codex-skin-surface) 98%, var(--codex-skin-text) 2%);
  --codex-skin-control-hover: color-mix(in srgb, var(--codex-skin-accent) 22%, var(--codex-skin-control-surface) 78%);
  --codex-skin-muted-text: color-mix(in srgb, var(--codex-skin-text) 78%, var(--codex-skin-surface) 22%);
  --color-background-surface: color-mix(in srgb, var(--codex-skin-surface) 90%, transparent) !important;
  --color-background-panel: var(--codex-skin-panel-surface) !important;
  --color-background-control: var(--codex-skin-control-surface) !important;
  --color-background-control-opaque: var(--codex-skin-control-surface) !important;
  --color-background-editor-opaque: var(--codex-skin-panel-surface) !important;
  --color-background-elevated-primary: var(--codex-skin-panel-surface) !important;
  --color-background-elevated-primary-opaque: var(--codex-skin-panel-surface) !important;
  --color-background-elevated-secondary: var(--codex-skin-control-surface) !important;
  --color-background-elevated-secondary-opaque: var(--codex-skin-control-surface) !important;
  --color-background-button-primary: var(--codex-skin-accent) !important;
  --color-background-button-primary-hover: var(--codex-skin-control-hover) !important;
  --color-background-button-primary-active: var(--codex-skin-control-hover) !important;
  --color-text-button-primary: var(--codex-skin-on-accent) !important;
  --color-text-button-secondary: var(--codex-skin-text) !important;
  --color-text-foreground: var(--codex-skin-text) !important;
  --color-text-foreground-secondary: var(--codex-skin-muted-text) !important;
  --color-text-foreground-tertiary: var(--codex-skin-muted-text) !important;
  --color-text-on-accent: var(--codex-skin-on-accent) !important;
  --color-border: color-mix(in srgb, var(--codex-skin-accent) 45%, transparent) !important;
  --color-border-focus: var(--codex-skin-accent) !important;
  --color-token-dropdown-background: var(--codex-skin-panel-surface) !important;
  --color-token-dropdown-foreground: var(--codex-skin-text) !important;
  --color-token-menu-background: var(--codex-skin-panel-surface) !important;
  --color-token-menu-border: color-mix(in srgb, var(--codex-skin-accent) 62%, var(--codex-skin-panel-surface)) !important;
  --color-token-main-surface-primary: var(--codex-skin-panel-surface) !important;
  --color-token-side-bar-background: var(--codex-skin-control-surface) !important;
  --color-token-button-background: var(--codex-skin-accent) !important;
  --color-token-button-foreground: var(--codex-skin-on-accent) !important;
  --color-token-on-accent: var(--codex-skin-on-accent) !important;
  --color-token-input-background: var(--codex-skin-control-surface) !important;
  --color-token-input-foreground: var(--codex-skin-text) !important;
  --color-token-input-placeholder-foreground: var(--codex-skin-muted-text) !important;
  --color-token-text-primary: var(--codex-skin-text) !important;
  --color-token-text-secondary: var(--codex-skin-muted-text) !important;
  --color-token-text-tertiary: var(--codex-skin-muted-text) !important;
  --color-token-foreground: var(--codex-skin-text) !important;
  --color-token-list-hover-background: var(--codex-skin-control-hover) !important;
  --color-token-list-active-selection-background: var(--codex-skin-control-hover) !important;
  --color-token-list-active-selection-foreground: var(--codex-skin-text) !important;
  --color-token-focus-border: var(--codex-skin-accent) !important;
  --vscode-button-background: var(--codex-skin-accent) !important;
  --vscode-button-foreground: var(--codex-skin-on-accent) !important;
  --vscode-button-secondaryBackground: var(--codex-skin-control-surface) !important;
  --vscode-button-secondaryForeground: var(--codex-skin-text) !important;
  --vscode-dropdown-background: var(--codex-skin-panel-surface) !important;
  --vscode-dropdown-foreground: var(--codex-skin-text) !important;
  --vscode-editor-background: var(--codex-skin-panel-surface) !important;
  --vscode-editor-foreground: var(--codex-skin-text) !important;
  --vscode-editorWidget-background: var(--codex-skin-panel-surface) !important;
  --vscode-editorWidget-foreground: var(--codex-skin-text) !important;
  --vscode-input-background: var(--codex-skin-control-surface) !important;
  --vscode-input-foreground: var(--codex-skin-text) !important;
  --vscode-list-activeSelectionBackground: var(--codex-skin-control-hover) !important;
  --vscode-list-activeSelectionForeground: var(--codex-skin-text) !important;
  --vscode-list-hoverBackground: var(--codex-skin-control-hover) !important;
  --vscode-sideBar-background: var(--codex-skin-control-surface) !important;
  --vscode-sideBar-foreground: var(--codex-skin-text) !important;
}

#root {
  color: var(--codex-skin-text) !important;
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--codex-skin-surface) 96%, transparent) 0 22%, transparent 46%),
    linear-gradient(180deg, transparent 0 45%, color-mix(in srgb, var(--codex-skin-surface) 78%, transparent) 78% 100%),
    url(${JSON.stringify(hero)}) right center / cover no-repeat fixed !important;
}

.app-shell-left-panel {
  background: color-mix(in srgb, var(--codex-skin-surface) 88%, transparent) !important;
  border-right: 1px solid color-mix(in srgb, var(--codex-skin-accent) 45%, transparent) !important;
  backdrop-filter: blur(20px) saturate(1.12);
}

.main-surface,
.browser-main-surface {
  background: linear-gradient(180deg, transparent 0 40%, color-mix(in srgb, var(--codex-skin-surface) 74%, transparent) 100%) !important;
}

.composer-surface-chrome,
[data-user-message-bubble],
[data-local-conversation-final-assistant],
[data-codex-approval-surface] {
  color: var(--codex-skin-text) !important;
  border-color: color-mix(in srgb, var(--codex-skin-accent) 48%, transparent) !important;
  background: color-mix(in srgb, var(--codex-skin-surface) 88%, transparent) !important;
  box-shadow: 0 8px 24px color-mix(in srgb, var(--codex-skin-accent) 18%, transparent) !important;
  backdrop-filter: blur(18px) saturate(1.08);
}

button.size-token-button-composer {
  color: var(--codex-skin-text) !important;
  border-color: color-mix(in srgb, var(--codex-skin-accent) 48%, var(--codex-skin-control-surface)) !important;
  background: var(--codex-skin-control-surface) !important;
  opacity: 1 !important;
}

button.size-token-button-composer.bg-token-foreground,
button.size-token-button-composer.bg-token-button-background {
  color: var(--codex-skin-on-accent) !important;
  background: var(--codex-skin-accent) !important;
  border: 1px solid color-mix(in srgb, var(--codex-skin-on-accent) 58%, var(--codex-skin-accent)) !important;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--codex-skin-accent) 24%, transparent), 0 6px 16px color-mix(in srgb, var(--codex-skin-accent) 30%, transparent) !important;
}

button.size-token-button-composer.bg-token-foreground svg,
button.size-token-button-composer.bg-token-button-background svg {
  color: var(--codex-skin-on-accent) !important;
}

[role="menu"],
[data-radix-menu-content],
[class~="bg-token-dropdown-background"],
[class~="bg-token-menu-background"],
[role="dialog"] {
  color: var(--codex-skin-text) !important;
  background: var(--codex-skin-panel-surface) !important;
  border-color: color-mix(in srgb, var(--codex-skin-accent) 58%, var(--codex-skin-panel-surface)) !important;
  box-shadow: 0 16px 42px color-mix(in srgb, var(--codex-skin-surface) 58%, transparent) !important;
}

[role="menuitem"],
[data-radix-menu-item],
[data-slot="thread-summary-panel-item-button"],
[data-slot="thread-summary-panel-icon-button"] {
  color: var(--codex-skin-text) !important;
}

[role="menuitem"]:hover,
[role="menuitem"][data-highlighted="true"],
[data-radix-menu-item]:hover,
[data-radix-menu-item][data-highlighted],
[data-slot="thread-summary-panel-item-button"]:hover,
[data-slot="thread-summary-panel-item-button"]:focus-visible {
  color: var(--codex-skin-text) !important;
  background: var(--codex-skin-control-hover) !important;
}

[data-testid*="file" i],
[data-testid*="attachment" i],
[data-testid*="preview" i],
[data-slot*="file" i],
[data-slot*="attachment" i],
[data-slot*="preview" i],
[class*="file-preview" i],
[class*="attachment-preview" i] {
  color: var(--codex-skin-text) !important;
  background-color: var(--codex-skin-panel-surface) !important;
  border-color: color-mix(in srgb, var(--codex-skin-accent) 52%, var(--codex-skin-panel-surface)) !important;
}

mark,
[aria-selected="true"],
[data-selected="true"],
[data-state="checked"] {
  color: var(--codex-skin-text) !important;
  background: var(--codex-skin-control-hover) !important;
}

::selection {
  color: var(--codex-skin-on-accent) !important;
  background: var(--codex-skin-accent) !important;
}

#${SWITCHER_ID} {
  position: fixed;
  top: 8px;
  right: clamp(96px, 11vw, 148px);
  z-index: 80;
  color: var(--codex-skin-text);
  font: 600 12px/1.2 ui-rounded, system-ui, sans-serif;
}

#${SWITCHER_ID}[data-native-overlay="true"] {
  visibility: hidden;
  pointer-events: none;
}

#${SWITCHER_ID} > button {
  display: inline-flex;
  min-height: 30px;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--codex-skin-accent) 58%, var(--codex-skin-panel-surface));
  border-radius: 9px;
  color: var(--codex-skin-text);
  background: color-mix(in srgb, var(--codex-skin-panel-surface) 92%, transparent);
  box-shadow: 0 5px 18px color-mix(in srgb, var(--codex-skin-surface) 44%, transparent), 0 0 0 1px color-mix(in srgb, var(--codex-skin-accent) 12%, transparent);
  backdrop-filter: blur(14px) saturate(1.15);
  cursor: pointer;
}

#${SWITCHER_ID} > button:hover,
#${SWITCHER_ID} > button[aria-expanded="true"] {
  color: var(--codex-skin-on-accent);
  background: var(--codex-skin-accent);
}

#${SWITCHER_ID} > button svg {
  width: 15px;
  height: 15px;
  flex: 0 0 auto;
  fill: currentColor;
}

#${SWITCHER_ID}-menu {
  position: absolute;
  top: 36px;
  right: 0;
  display: grid;
  width: min(240px, calc(100vw - 24px));
  gap: 4px;
  padding: 8px;
  border: 1px solid color-mix(in srgb, var(--codex-skin-accent) 58%, var(--codex-skin-panel-surface));
  border-radius: 12px;
  color: var(--codex-skin-text);
  background: var(--codex-skin-panel-surface);
  box-shadow: 0 16px 42px color-mix(in srgb, var(--codex-skin-surface) 64%, transparent);
  backdrop-filter: blur(18px) saturate(1.15);
}

#${SWITCHER_ID}-menu[hidden] {
  display: none;
}

#${SWITCHER_ID}-menu [data-theme-item] {
  display: flex;
  width: 100%;
  min-height: 32px;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 9px;
  border: 0;
  border-radius: 7px;
  color: var(--codex-skin-text);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

#${SWITCHER_ID}-menu [data-theme-item]:hover,
#${SWITCHER_ID}-menu [data-theme-item][aria-checked="true"] {
  color: var(--codex-skin-text);
  background: var(--codex-skin-control-hover);
}

#${SWITCHER_ID}-menu [data-theme-item][disabled] {
  color: var(--codex-skin-muted-text);
  cursor: wait;
}

#${SWITCHER_ID}-status {
  max-width: 220px;
  padding: 4px 8px 2px;
  color: var(--codex-skin-muted-text);
  font-size: 11px;
}

[data-app-action-sidebar-thread-active="true"] {
  background: linear-gradient(90deg, color-mix(in srgb, var(--codex-skin-accent) 22%, transparent), color-mix(in srgb, var(--codex-skin-secondary) 16%, transparent)) !important;
}
${brandFallbackCss}${logoCss}${polaroidCss}${copyCss}`;
}

async function persist(theme, { themesDir = THEMES, deferred = false } = {}) {
  const destination = join(themesDir, theme.manifest.id);
  const temporary = join(themesDir, `.${theme.manifest.id}.${process.pid}.${Date.now()}.tmp`);
  await mkdir(themesDir, { recursive: true });
  await mkdir(temporary);
  const assetFiles = [["hero", theme.hero], ["logo", theme.logo], ["polaroid", theme.polaroid]].filter(([, file]) => file);
  const saved = { ...theme.manifest, hero: basename(theme.hero) };
  for (const [field, file] of assetFiles) saved[field] = basename(file);
  for (const field of ["logo", "polaroid"]) if (!theme[field]) delete saved[field];
  try {
    for (const [field, file] of assetFiles) await copyFile(file, join(temporary, basename(file)));
    await writeFile(join(temporary, "theme.json"), `${json(saved)}\n`, "utf8");
    const backup = `${destination}.old-${process.pid}-${Date.now()}`;
    let hadDestination = false;
    try { await rename(destination, backup); hadDestination = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
    try {
      await rename(temporary, destination);
    } catch (error) {
      const rollbackErrors = [];
      if (hadDestination) {
        try { await rename(backup, destination); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "persist replacement and rollback failed");
      throw error;
    }
    if (!deferred) {
      try {
        if (hadDestination) await rm(backup, { recursive: true, force: true });
      } catch (error) {
        const rollbackErrors = [];
        try { await rm(destination, { recursive: true, force: true }); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        if (hadDestination) {
          try { await rename(backup, destination); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        }
        if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "persist commit and rollback failed");
        throw error;
      }
    } else {
      let settled = false;
      const rollback = async () => {
        if (settled) return;
        await rm(destination, { recursive: true, force: true });
        if (hadDestination) await rename(backup, destination);
        settled = true;
      };
      const commit = async () => {
        if (settled) return;
        if (hadDestination) await rm(backup, { recursive: true, force: true });
        settled = true;
      };
      return { destination, manifest: saved, commit, rollback };
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return { destination, manifest: saved };
}

async function writeState(value) {
  await mkdir(ROOT, { recursive: true });
  const temporary = `${STATE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${json({ schemaVersion: 1, ...value })}\n`, "utf8");
  await rename(temporary, STATE);
}
async function removeState(statePath = STATE) {
  const temporary = `${statePath}.${process.pid}.${Date.now()}.removed`;
  try { await rename(statePath, temporary); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  await rm(temporary, { force: true });
}
async function readState(statePath = STATE) {
  try { return JSON.parse(await readFile(statePath, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function switcherExpression(themes = []) {
  const switcherId = JSON.stringify(SWITCHER_ID);
  const styleId = JSON.stringify(STYLE_ID);
  const applyUrl = JSON.stringify(`http://127.0.0.1:${SWITCHER_PORT}/apply`);
  const localThemes = JSON.stringify(themes.map(({ id, name }) => ({ id, name })));
  return `await (async () => {
    try {
      const body = document.body;
      if (!body) return;
      let shell = document.getElementById(${switcherId});
      shell?.__codexSkinNativeOverlayObserver?.disconnect();
      shell?.remove();
      shell = null;
      if (!shell) {
        shell = document.createElement("div");
        shell.id = ${switcherId};
        shell.setAttribute("data-codex-skin-studio-switcher", "true");
        shell.innerHTML = '<button type="button" data-switcher-button aria-expanded="false" title="Switch ChatGPT Desktop skin"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Zm0 1.5a6 6 0 1 1 0 12 6 6 0 0 1 0-12Zm-3.25 5.25a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Zm6.5 0a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5ZM6.5 12c.72 1.4 1.9 2.1 3.5 2.1s2.78-.7 3.5-2.1c-.45-.35-.9-.52-1.36-.52-.7 0-1.4.28-2.14.84-.74-.56-1.45-.84-2.14-.84-.46 0-.91.17-1.36.52Z"/></svg><span>Skins</span></button><div id="${SWITCHER_ID}-menu" role="menu" hidden><div data-switcher-list></div><div id="${SWITCHER_ID}-status" role="status">Loading local skins...</div></div>';
        body.appendChild(shell);
      }
      const button = shell.querySelector("[data-switcher-button]");
      const menu = shell.querySelector("#${SWITCHER_ID}-menu");
      const list = shell.querySelector("[data-switcher-list]");
      const status = shell.querySelector("#${SWITCHER_ID}-status");
      const styleNode = () => document.getElementById(${styleId});
      const localThemes = ${localThemes};
      const nativeOverlayOpen = () => [...document.querySelectorAll('[aria-haspopup="menu"][aria-expanded="true"], [aria-haspopup="listbox"][aria-expanded="true"], [data-state="open"][aria-haspopup="menu"], [role="menu"], [role="listbox"], [data-radix-menu-content], [data-radix-popper-content-wrapper], [role="dialog"]')].some((node) => {
        if (shell.contains(node) || node === shell) return false;
        const rect = node.getBoundingClientRect();
        const computed = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && computed.visibility !== "hidden" && computed.display !== "none";
      });
      const syncNativeOverlay = () => {
        shell.dataset.nativeOverlay = nativeOverlayOpen() ? "true" : "false";
      };
      const renderThemes = () => {
        if (!list || !status) return;
        list.replaceChildren();
        const activeId = styleNode()?.dataset.themeId || null;
        for (const theme of Array.isArray(localThemes) ? localThemes : []) {
          const item = document.createElement("button");
          item.type = "button";
          item.setAttribute("role", "menuitemradio");
          item.dataset.themeItem = "true";
          item.dataset.themeId = theme.id;
          item.setAttribute("aria-checked", theme.id === activeId ? "true" : "false");
          const label = document.createElement("span");
          label.textContent = theme.name || theme.id;
          const marker = document.createElement("span");
          marker.textContent = theme.id === activeId ? "Active" : "";
          item.append(label, marker);
          item.addEventListener("click", () => {
            const items = [...list.querySelectorAll("[data-theme-item]")];
            items.forEach((entry) => { entry.disabled = true; });
            status.textContent = "Applying...";
            window.open(${applyUrl} + "?id=" + encodeURIComponent(theme.id), "codex-skin-studio-apply", "popup,width=320,height=180");
            status.textContent = "Switch request sent";
            menu.hidden = true;
            button.setAttribute("aria-expanded", "false");
          });
          list.appendChild(item);
        }
        status.textContent = localThemes.length ? "Local themes" : "No local themes yet";
      };
      if (button && menu && !shell.dataset.bound) {
        button.addEventListener("click", () => {
          menu.hidden = !menu.hidden;
          button.setAttribute("aria-expanded", String(!menu.hidden));
          if (!menu.hidden) renderThemes();
        });
        document.addEventListener("click", (event) => {
          if (!shell.contains(event.target)) {
            menu.hidden = true;
            button.setAttribute("aria-expanded", "false");
          }
        }, true);
        document.addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            menu.hidden = true;
            button.setAttribute("aria-expanded", "false");
          }
        });
        shell.dataset.bound = "true";
      }
      const observer = new MutationObserver(syncNativeOverlay);
      observer.observe(body, { subtree: true, attributes: true, attributeFilter: ["aria-expanded", "data-state", "hidden", "style", "class"] });
      shell.__codexSkinNativeOverlayObserver = observer;
      syncNativeOverlay();
      renderThemes();
    } catch {
      // The visual skin must still apply when the optional local switcher is unavailable.
    }
  })();`;
}

function styleExpression(theme, hero, logo = null, polaroid = null, themes = []) {
  const style = css(theme, hero, logo, polaroid);
  const logoLoad = logo ? `const logoImage = new Image(); logoImage.src = ${JSON.stringify(logo)}; await logoImage.decode();` : "";
  const polaroidLoad = polaroid ? `const polaroidImage = new Image(); polaroidImage.src = ${JSON.stringify(polaroid)}; await polaroidImage.decode();` : "";
  return `(async () => { const previous = document.getElementById(${JSON.stringify(STYLE_ID)}); const snapshot = previous ? { present: true, textContent: previous.textContent, themeId: previous.dataset.themeId ?? null, heroLoaded: previous.dataset.heroLoaded ?? null, logoLoaded: previous.dataset.logoLoaded ?? null, polaroidLoaded: previous.dataset.polaroidLoaded ?? null } : { present: false }; const result = { rollback: snapshot }; try { const heroImage = new Image(); heroImage.src = ${JSON.stringify(hero)}; await heroImage.decode(); ${logoLoad} ${polaroidLoad} let node = previous; if (!node) { node = document.createElement("style"); node.id = ${JSON.stringify(STYLE_ID)}; document.head.appendChild(node); } node.dataset.themeId = ${JSON.stringify(theme.id)}; node.dataset.heroLoaded = "true"; node.dataset.logoLoaded = ${JSON.stringify(Boolean(logo))}; node.dataset.polaroidLoaded = ${JSON.stringify(Boolean(polaroid))}; node.textContent = ${JSON.stringify(style)}; ${switcherExpression(themes)} const root = document.getElementById("root"); const computed = root ? getComputedStyle(root) : null; return { ...result, connected: Boolean(node.isConnected), themeId: node.dataset.themeId, heroLoaded: node.dataset.heroLoaded === "true", logoLoaded: node.dataset.logoLoaded === "true", polaroidLoaded: node.dataset.polaroidLoaded === "true", cssText: node.textContent.trim(), cssRules: node.sheet ? node.sheet.cssRules.length : 0, rootBackground: Boolean(computed && computed.backgroundImage && computed.backgroundImage !== "none") }; } catch (error) { return { ...result, error: String(error?.message || error) }; } })()`;
}
function restoreStyleExpression(snapshot) {
  return `(() => { const node = document.getElementById(${JSON.stringify(STYLE_ID)}); const snapshot = ${JSON.stringify(snapshot)}; if (!snapshot.present) { node?.remove(); return node && node.isConnected ? 0 : 1; } const restored = node || document.createElement("style"); restored.id = ${JSON.stringify(STYLE_ID)}; if (!restored.isConnected) document.head.appendChild(restored); restored.textContent = snapshot.textContent; for (const key of ["themeId", "heroLoaded", "logoLoaded", "polaroidLoaded"]) { const value = snapshot[key] ?? null; if (value === null) delete restored.dataset[key]; else restored.dataset[key] = value; } return restored.isConnected && restored.textContent === snapshot.textContent && (restored.dataset.themeId ?? null) === snapshot.themeId && (restored.dataset.heroLoaded ?? null) === snapshot.heroLoaded && (restored.dataset.logoLoaded ?? null) === (snapshot.logoLoaded ?? null) && (restored.dataset.polaroidLoaded ?? null) === (snapshot.polaroidLoaded ?? null) ? 1 : 0; })()`;
}
async function injectTheme(list, saved, { evaluateTarget } = {}) {
  const evaluate = evaluateTarget || (async (candidate, expression) => {
    const session = new Session(candidate.webSocketDebuggerUrl);
    try { await session.open(); return await session.evaluate(expression); } finally { session.close(); }
  });
  const target = await selectMainTarget(list, evaluate);
  if (!target) throw new Error("main Codex renderer was not found");
  const hero = await dataUrl(join(saved.destination, saved.manifest.hero));
  const logo = saved.manifest.logo ? await dataUrl(join(saved.destination, saved.manifest.logo)) : null;
  const polaroid = saved.manifest.polaroid ? await dataUrl(join(saved.destination, saved.manifest.polaroid)) : null;
  const themes = await listThemes();
  const expression = styleExpression(saved.manifest, hero, logo, polaroid, themes);
  const values = [await evaluate(target, expression)];
  const rollback = typeof values[0]?.rollback === "object" ? async () => {
    const result = await evaluate(target, restoreStyleExpression(values[0].rollback));
    if (result !== 0 && result !== 1) throw new Error("style rollback was not confirmed");
    return result;
  } : null;
  if (values[0]?.error) {
    const error = new Error(values[0].error);
    if (rollback) error.rollback = rollback;
    throw error;
  }
  if (values.length !== 1 || !injectionVerified(values[0], saved.manifest.id, { logo: Boolean(logo), polaroid: Boolean(polaroid) })) {
    const error = new Error("injection verification failed");
    if (rollback) error.rollback = rollback;
    throw error;
  }
  return {
    rendererCount: 1,
    rollback: rollback || (async () => { const result = await evaluate(target, REMOVE_STYLE_EXPRESSION); if (result !== 0 && result !== 1) throw new Error("style removal was not confirmed"); return result; }),
  };
}
async function savedTheme(state) {
  if (!state?.themeDir || typeof state.themeId !== "string") throw new Error("persisted theme state is missing");
  const theme = await loadTheme(state.themeDir);
  if (theme.manifest.id !== state.themeId) throw new Error("persisted theme state does not match theme files");
  return { destination: theme.root, manifest: theme.manifest };
}
function assetFlags(manifest) {
  return { logo: Boolean(manifest?.logo), polaroid: Boolean(manifest?.polaroid) };
}
async function spawnRestartWorker(port, { normal = false, spawnFn = spawn } = {}) {
  const workerArgs = [fileURLToPath(import.meta.url), "restart-worker", "--port", String(port), ...(normal ? ["--restart-normal"] : [])];
  const child = spawnFn(process.execPath, workerArgs, { detached: true, stdio: "ignore" });
  await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      child.removeListener?.("spawn", onSpawn);
      child.removeListener?.("error", onError);
    };
    const onSpawn = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!Number.isInteger(child.pid) || child.pid <= 0) return reject(new Error("restart worker spawn returned an invalid PID"));
      resolve();
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    child.once?.("spawn", onSpawn);
    child.once?.("error", onError);
    if (!child.once) {
      child.on("spawn", onSpawn);
      child.on("error", onError);
    }
  });
  child.unref?.();
  return child.pid;
}

async function processIds(executable) {
  try { return (await execFileAsync("/usr/bin/pgrep", ["-x", executable], { timeout: 2000 })).stdout.trim().split("\n").filter(Boolean).map(Number); } catch (error) {
    if (error.code === 1) return [];
    throw error;
  }
}

function isPidRunning(pid, { processKillFn = process.kill } = {}) {
  try { processKillFn(pid, 0); return true; } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessExit(pids, { isPidRunning: isPidRunningFn = isPidRunning, delayFn = delay, timeoutMs = 10000, intervalMs = 250 } = {}) {
  if (!pids.length) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let running = false;
    for (const pid of pids) if (await isPidRunningFn(pid)) { running = true; break; }
    if (!running) return true;
    await delayFn(intervalMs);
  }
  for (const pid of pids) if (await isPidRunningFn(pid)) return false;
  return true;
}

async function waitForProcessStart(executable, { processIdsFn = processIds, delayFn = delay, timeoutMs = 10000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await processIdsFn(executable)).length) return true;
    await delayFn(intervalMs);
  }
  return (await processIdsFn(executable)).length > 0;
}

async function cancelWorker(pid, { processKillFn = process.kill, isPidRunning: isPidRunningFn = isPidRunning, delayFn = delay } = {}) {
  try { processKillFn(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  if (!await waitForProcessExit([pid], { isPidRunning: isPidRunningFn, delayFn, timeoutMs: 2000, intervalMs: 25 })) throw new Error("restart worker did not exit after cancellation");
}

async function restartWorkerCoreImpl(port, { normal = false, requireArmed = false, processPidFn = () => process.pid, delayFn = delay, nowFn = Date.now, restartTimeoutMs = 20000, platformFn = platform, discoverFn = discover, appInfoFn = appInfoSync, quitFn, launchFn, targetsFn = targets, selectTargetFn = selectMainTarget, injectFn = injectTheme, savedThemeFn = savedTheme, readStateFn = readState, writeStateFn = writeState, processIdsFn = processIds, isPidRunning, processExitConfirmedFn } = {}) {
  if (platformFn() !== "darwin") throw new Error("Codex Skin Studio is macOS-only");
  await delayFn(1500);
  if (requireArmed) {
    const armed = await readStateFn();
    if (!armed?.restartPending || armed.restartWorkerPid !== processPidFn()) return;
  }
  const app = discoverFn();
  if (!app) throw new Error(`${APP_DISPLAY_NAME} application was not found`);
  const info = appInfoFn(app);
  if (!info?.valid) throw new Error(`${APP_DISPLAY_NAME} application validation failed`);
  const quit = quitFn || (() => execFileAsync("/usr/bin/osascript", ["-e", `tell application id ${JSON.stringify(BUNDLE_ID)} to quit`], { timeout: 5000 }));
  const oldPids = await processIdsFn(info.executable);
  await quit();
  if (!await waitForProcessExit(oldPids, { isPidRunning, delayFn })) throw new Error("Codex process did not exit after quit request");
  let processExited = true;
  try {
    processExitConfirmedFn?.();
    const prior = await readStateFn();
    await writeStateFn({ ...(prior || {}), active: false, restartPending: true });
    const args = normal ? ["-na", app] : ["-na", app, "--args", "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`];
    const launch = launchFn || (() => { const child = spawn("/usr/bin/open", args, { detached: true, stdio: "ignore" }); child.unref(); });
    await launch(args);
    if (normal) {
      if (!await waitForProcessStart(info.executable, { processIdsFn, delayFn })) throw new Error("Codex process did not start after launch");
      await writeStateFn({ ...(await readStateFn()), active: false, restartPending: false, restartWorkerPid: null, restartedAt: new Date().toISOString() });
      return;
    }
    const deadline = nowFn() + restartTimeoutMs;
    const saved = await savedThemeFn(prior);
    let list = [];
    let injectionSucceeded = false;
    let lastError = null;
    while (nowFn() < deadline) {
      try {
        list = await targetsFn(port);
        const readyTarget = await selectTargetFn(list, undefined, { allowTransient: true });
        if (readyTarget) {
          await injectFn(list, saved);
          injectionSucceeded = true;
          break;
        }
      } catch (error) {
        lastError = error;
      }
      await delayFn(250);
    }
    if (!injectionSucceeded) throw new Error(`Codex renderer did not become ready on port ${port}${lastError ? `: ${lastError.message}` : ""}`);
    await writeStateFn({ ...(await readStateFn()), themeId: saved.manifest.id, themeDir: saved.destination, assetFlags: assetFlags(saved.manifest), appliedAt: new Date().toISOString(), active: true, restartPending: false, restartWorkerPid: null });
  } catch (error) {
    if (processExited) error.processExited = true;
    throw error;
  }
}

async function restartWorkerCore(port, options = {}) {
  let processExited = false;
  try {
    return await restartWorkerCoreImpl(port, { ...options, processExitConfirmedFn: () => { processExited = true; } });
  } catch (error) {
    error.processExited = processExited;
    throw error;
  }
}

async function restartWorker(port, options = {}) {
  const platformFn = options.platformFn || platform;
  if (platformFn() !== "darwin") throw new Error("Codex Skin Studio is macOS-only");
  try {
    return await restartWorkerCore(port, { ...options, platformFn });
  } catch (error) {
    const readStateFn = options.readStateFn || readState;
    const writeStateFn = options.writeStateFn || writeState;
    let prior = null;
    const cleanupErrors = [];
    try { prior = await readStateFn(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    try {
      if (!cleanupErrors.length) await writeStateFn({ ...(prior || {}), active: error.processExited ? false : Boolean(prior?.active), restartPending: false, restartWorkerPid: null, failedAt: new Date().toISOString(), error: error.message, processExited: Boolean(error.processExited) });
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], "restart failed and state cleanup was incomplete");
    throw error;
  }
}

async function commandDoctor() {
  const currentPlatform = platform();
  const app = currentPlatform === "darwin" ? discover() : null;
  const info = app ? appInfoSync(app) : null;
  const runtime = { fetch: typeof fetch === "function", webSocket: typeof WebSocket === "function" };
  const valid = currentPlatform === "darwin" && Boolean(info?.valid) && runtime.fetch && runtime.webSocket;
  return {
    status: valid ? "ok" : "failed",
    platform: currentPlatform,
    bundleId: BUNDLE_ID,
    appPath: app,
    executable: info?.executable || null,
    executablePath: info?.executablePath || null,
    signatureTeamId: info?.teamId || null,
    signatureValid: info?.signatureValid ?? null,
    expectedTeamId: EXPECTED_TEAM_ID,
    runtime,
    cdpLoopbackOnly: true,
    asarModification: false,
  };
}

async function commandValidate(dir) {
  let theme;
  try { theme = await loadTheme(dir); } catch (error) { error.code = "THEME_INVALID"; throw error; }
  return { status: "valid", themeId: theme.manifest.id, themeDir: theme.root, hero: theme.manifest.hero, ...(theme.manifest.logo ? { logo: theme.manifest.logo } : {}), ...(theme.manifest.polaroid ? { polaroid: theme.manifest.polaroid } : {}), ...(theme.manifest.copy ? { copy: theme.manifest.copy } : {}) };
}

async function commandApply(dir, port, { persistFn = persist, writeStateFn = writeState, readStateFn = readState, removeStateFn = removeState, targetsFn = targets, spawnWorker = spawnRestartWorker, cancelWorkerFn = cancelWorker, injectFn = injectTheme, platformFn = platform } = {}) {
  if (platformFn() !== "darwin") throw new Error("Codex Skin Studio is macOS-only");
  let theme;
  try { theme = await loadTheme(dir); } catch (error) { error.code = "THEME_INVALID"; throw error; }
  const saved = await persistFn(theme, { deferred: true });
  const rollback = typeof saved.rollback === "function" ? saved.rollback : async () => {};
  const commit = typeof saved.commit === "function" ? saved.commit : async () => {};
  let injection = null;
  let stateWritten = false;
  let prior = null;
  try {
    prior = await readStateFn();
    let list;
    try {
      list = await targetsFn(port);
    } catch (error) {
      if (!isUnavailableListenerError(error)) throw error;
      const workerPid = await spawnWorker(port);
      try {
        await writeStateFn({ ...(prior || {}), themeId: saved.manifest.id, themeDir: saved.destination, assetFlags: assetFlags(saved.manifest), appliedAt: new Date().toISOString(), active: false, restartPending: true, restartWorkerPid: workerPid });
        stateWritten = true;
        await commit();
      } catch (error) {
        const cancellationErrors = [];
        try { await cancelWorkerFn(workerPid); } catch (cancelError) { cancellationErrors.push(cancelError); }
        try { if (prior === null) await removeStateFn(); else await writeStateFn(prior); } catch (cleanupError) { cancellationErrors.push(cleanupError); }
        if (cancellationErrors.length) throw new AggregateError([error, ...cancellationErrors], "apply scheduling and worker cancellation failed");
        throw error;
      }
      return { status: "scheduled", themeId: saved.manifest.id, themeDir: saved.destination, restartRequired: true, workerPid, statePath: STATE };
    }
    if (!list.length) {
      const error = new Error("CDP discovery found no eligible Codex renderer");
      error.code = "NO_ELIGIBLE_RENDERER";
      throw error;
    }
    try { injection = await injectFn(list, saved); } catch (injectionError) {
      if (!injectionError.code) injectionError.code = "INJECTION_FAILED";
      if (typeof injectionError?.rollback === "function") injection = { rollback: injectionError.rollback };
      throw injectionError;
    }
    await writeStateFn({ ...(prior || {}), themeId: saved.manifest.id, themeDir: saved.destination, assetFlags: assetFlags(saved.manifest), appliedAt: new Date().toISOString(), active: true, restartPending: false, restartWorkerPid: null });
    stateWritten = true;
    await commit();
    return { status: "applied", themeId: saved.manifest.id, rendererCount: injection?.rendererCount ?? 1, restartRequired: false };
  } catch (error) {
    const compensationErrors = [];
    if (typeof injection?.rollback === "function") {
      try { await injection.rollback(); } catch (rollbackError) { compensationErrors.push(rollbackError); }
    }
    if (stateWritten) {
      try { if (prior === null) await removeStateFn(); else await writeStateFn(prior); } catch (restoreError) { compensationErrors.push(restoreError); }
    }
    try { await rollback(); } catch (rollbackError) { compensationErrors.push(rollbackError); }
    if (compensationErrors.length) throw new AggregateError([error, ...compensationErrors], "apply failed and compensation was incomplete");
    throw error;
  }
}

async function commandStatus(port, { targetsFn = targets, selectTargetFn = selectMainTarget, evaluateListFn = evaluateAll, readStateFn = readState, platformFn = platform } = {}) {
  if (platformFn() !== "darwin") throw new Error("Codex Skin Studio is macOS-only");
  const state = await readStateFn();
  let live = [];
  try {
    const list = await targetsFn(port);
    const target = await selectTargetFn(list);
    live = target ? await evaluateListFn([target], STATUS_EXPRESSION) : [];
  } catch (error) {
    if (isUnavailableListenerError(error)) live = [];
    else throw error;
  }
  const reachable = live.length > 0;
  const verified = reachable && injectionVerified(live[0], state?.themeId, state?.assetFlags);
  const stale = reachable && (Boolean(state?.active) !== verified || (live[0]?.connected === true && live[0]?.themeId !== state?.themeId));
  const pending = Boolean(state?.restartPending);
  return { status: stale ? "stale" : pending ? "pending" : !reachable ? "unavailable" : verified ? "active" : "inactive", state: reachable ? { ...state, active: verified, restartPending: pending } : state, renderers: live };
}

async function commandRestore(port, restartNormal, { spawnWorker = spawnRestartWorker, cancelWorkerFn = cancelWorker, targetsFn = targets, selectTargetFn = selectMainTarget, evaluateListFn = evaluateAll, readStateFn = readState, writeStateFn = writeState, removeStateFn = removeState, platformFn = platform } = {}) {
  if (platformFn() !== "darwin") throw new Error("Codex Skin Studio is macOS-only");
  let removed = 0;
  let restoreError = null;
  let removalConfirmed = false;
  try {
    const list = await targetsFn(port);
    const expression = REMOVE_STYLE_EXPRESSION;
    const target = await selectTargetFn(list);
    if (!target) throw new Error("main Codex renderer was not found");
    const values = await evaluateListFn([target], expression);
    if (!values.length || values.some((value) => value !== 0 && value !== 1)) throw new Error("style removal was not confirmed");
    removed = values.reduce((sum, value) => sum + value, 0);
    removalConfirmed = true;
  } catch (error) {
    // Restore is local-state-safe even when no live renderer can be reached.
    removed = 0;
    restoreError = error.message;
  }

  const state = await readStateFn();
  if (state) {
    if (!restartNormal && !restoreError) await writeStateFn({ ...state, active: false, restartPending: false, restartWorkerPid: null, restoredAt: new Date().toISOString() });
  }
  if (!restartNormal && restoreError) {
    return fail("RESTORE_FAILED", restoreError || "injected style was not removed", { removed, restoreError: restoreError || "injected style was not removed", restartNormalRequested: false, restartRequired: false });
  }
  if (restartNormal) {
    const restartState = { ...(state || {}), active: removalConfirmed ? false : Boolean(state?.active) };
    if (removalConfirmed) restartState.restoredAt = new Date().toISOString();
    let workerPid;
    try { workerPid = await spawnWorker(port, { normal: true }); } catch (error) {
      await writeStateFn({ ...restartState, restartPending: false, restartWorkerPid: null, failedAt: new Date().toISOString(), error: error.message });
      return fail("RESTART_SCHEDULE_FAILED", error.message, { removed, restoreError });
    }
    try {
      await writeStateFn({ ...restartState, restartPending: true, restartWorkerPid: workerPid });
    } catch (error) {
      const cleanupErrors = [];
      try { await cancelWorkerFn(workerPid); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      try { if (state) await writeStateFn(state); else await removeStateFn(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
      if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], "restore scheduling and cleanup failed");
      throw error;
    }
    return { status: "scheduled", removed, restoreError, restartNormalRequested: true, restartRequired: true, workerPid, statePath: STATE };
  }
  return { status: "restored", removed, restoreError, restartNormalRequested: false, restartRequired: false };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "restart-worker") {
    try {
      await restartWorker(args.port, { normal: args.restartNormal, requireArmed: true });
    } catch (error) {
      console.error(json(fail(commandErrorCode(error), error.message)));
      process.exitCode = 1;
    }
    return;
  }

  let result;
  if (args.command === "doctor") {
    result = await commandDoctor();
  } else if (args.command === "validate") {
    result = await commandValidate(args.themeDir);
  } else if (args.command === "apply") {
    result = await commandApply(args.themeDir, args.port);
  } else if (args.command === "status") {
    result = await commandStatus(args.port);
  } else if (args.command === "restore") {
    result = await commandRestore(args.port, args.restartNormal);
  } else {
    throw new Error("usage: apply.mjs doctor|validate <theme-dir>|apply <theme-dir>|status|restore [--port PORT] [--json]");
  }
  console.log(args.jsonOutput ? json(result) : result.message || json(result));
}

export { appInfoSync, assetFlags, cancelWorker, commandApply, commandDoctor, commandErrorCode, commandRestore, commandStatus, css, delay, discover, evaluateAll, injectTheme, injectionVerified, isPidRunning, listThemes, loadTheme, MAIN_TARGET_PROBE, parseArgs, persist, readState, removeState, processIds, restartWorker, restartWorkerCore, savedTheme, selectMainTarget, spawnRestartWorker, STATUS_EXPRESSION, styleExpression, targets, validateManifest, waitForProcessExit, waitForProcessStart, writeState, EXPECTED_TEAM_ID, Session };
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const result = fail(commandErrorCode(error), error.message);
    console.error(json(result));
    process.exitCode = 1;
  });
}
