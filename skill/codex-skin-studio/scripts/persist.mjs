#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  appInfoSync,
  delay,
  discover,
  evaluateAll,
  injectTheme,
  injectionVerified,
  isPidRunning,
  processIds,
  readState,
  savedTheme,
  selectMainTarget,
  STATUS_EXPRESSION,
  targets,
  waitForProcessExit,
  writeState,
} from "./apply.mjs";

const execFileAsync = promisify(execFile);
const LABEL = "com.openai.chatgpt.codex-skin-studio";
const PORT = 9341;
const BUNDLE_ID = "com.openai.codex";
const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG_DIR = join(homedir(), "Library", "Logs", "CodexSkinStudio");

function parseArgs(argv) {
  const command = argv.shift() || "status";
  let port = PORT;
  let jsonOutput = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") jsonOutput = true;
    else if (argument === "--port") port = Number(argv[++index]);
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("port must be an integer from 1024 through 65535");
  return { command, port, jsonOutput };
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function buildPlist({ nodePath = process.execPath, scriptPath = fileURLToPath(import.meta.url), port = PORT } = {}) {
  const workerArgs = [nodePath, scriptPath, "persistence-worker", "--port", String(port)];
  const argumentsXml = workerArgs.map((value) => `    <string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xml(join(LOG_DIR, "persistence.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(LOG_DIR, "persistence.error.log"))}</string>
</dict>
</plist>
`;
}

function launchctlTarget() {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!uid) throw new Error("the current macOS user session could not be resolved");
  return `gui/${uid}`;
}

async function launchctl(args, { ignoreFailure = false } = {}) {
  try {
    return await execFileAsync("/bin/launchctl", args, { timeout: 5000 });
  } catch (error) {
    if (ignoreFailure) return null;
    throw error;
  }
}

async function installPersistence({ port = PORT, nodePath = process.execPath, scriptPath = fileURLToPath(import.meta.url) } = {}) {
  if (platform() !== "darwin") throw new Error("ChatGPT Skin Studio persistence is macOS-only");
  await mkdir(dirname(PLIST_PATH), { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });
  await writeFile(PLIST_PATH, buildPlist({ nodePath, scriptPath, port }), "utf8");
  const target = launchctlTarget();
  await launchctl(["bootout", target, PLIST_PATH], { ignoreFailure: true });
  await launchctl(["bootstrap", target, PLIST_PATH]);
  return { status: "enabled", label: LABEL, plistPath: PLIST_PATH, port };
}

async function uninstallPersistence() {
  if (platform() !== "darwin") throw new Error("ChatGPT Skin Studio persistence is macOS-only");
  await launchctl(["bootout", launchctlTarget(), PLIST_PATH], { ignoreFailure: true });
  await rm(PLIST_PATH, { force: true });
  return { status: "disabled", label: LABEL, plistPath: PLIST_PATH };
}

async function persistenceStatus() {
  let installed = false;
  try {
    await readFile(PLIST_PATH, "utf8");
    installed = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let loaded = false;
  let running = false;
  if (installed && platform() === "darwin") {
    const result = await launchctl(["print", `${launchctlTarget()}/${LABEL}`], { ignoreFailure: true });
    loaded = Boolean(result);
    running = Boolean(result?.stdout && /state = running/.test(result.stdout));
  }
  return { status: running ? "enabled" : installed ? "installed" : "disabled", label: LABEL, plistPath: PLIST_PATH, loaded, running };
}

function launchDebug(app, port) {
  const child = spawn("/usr/bin/open", ["-na", app, "--args", "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`], { detached: true, stdio: "ignore" });
  child.unref();
}

async function quitChatGPT() {
  await execFileAsync("/usr/bin/osascript", ["-e", `tell application id ${JSON.stringify(BUNDLE_ID)} to quit`], { timeout: 5000 });
}

async function persistenceWorker({ port = PORT, pollMs = 1500, normalLaunchGraceMs = 5000, launchFn = launchDebug, quitFn = quitChatGPT } = {}) {
  if (platform() !== "darwin") throw new Error("ChatGPT Skin Studio persistence is macOS-only");
  let noCdpSince = 0;
  while (true) {
    try {
      const state = await readState();
      if (!state?.themeDir || typeof state.themeId !== "string") {
        noCdpSince = 0;
        await delay(pollMs * 2);
        continue;
      }
      const list = await targets(port).catch(() => []);
      if (list.length) {
        const main = await selectMainTarget(list, undefined, { allowTransient: true });
        if (main) {
          const live = (await evaluateAll([main], STATUS_EXPRESSION))[0];
          if (!injectionVerified(live, state.themeId, state.assetFlags)) {
            const saved = await savedTheme(state);
            await injectTheme(list, saved);
            await writeState({ ...state, active: true, restartPending: false, restartWorkerPid: null, reappliedAt: new Date().toISOString() });
          }
        }
        noCdpSince = 0;
        await delay(pollMs);
        continue;
      }

      const app = discover();
      const info = app ? appInfoSync(app) : null;
      const pids = info?.executable ? await processIds(info.executable) : [];
      if (!pids.length) {
        if (app) launchFn(app, port);
        noCdpSince = Date.now();
      } else if (!noCdpSince) {
        noCdpSince = Date.now();
      } else if (Date.now() - noCdpSince >= normalLaunchGraceMs) {
        await quitFn();
        await waitForProcessExit(pids, { isPidRunning, timeoutMs: 10000, intervalMs: 250 });
        if (app) launchFn(app, port);
        noCdpSince = Date.now();
      }
    } catch {
      noCdpSince = 0;
    }
    await delay(pollMs);
  }
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    let result;
    if (args.command === "install") result = await installPersistence({ port: args.port });
    else if (args.command === "uninstall") result = await uninstallPersistence();
    else if (args.command === "status") result = await persistenceStatus();
    else if (args.command === "persistence-worker") return persistenceWorker({ port: args.port });
    else throw new Error("usage: persist.mjs install|uninstall|status|persistence-worker [--port PORT] [--json]");
    process.stdout.write(`${args.jsonOutput ? JSON.stringify(result, null, 2) : result.status}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "failed", message: error.message })}\n`);
    process.exitCode = 1;
  }
}

export { buildPlist, installPersistence, LABEL, parseArgs, persistenceStatus, persistenceWorker, PLIST_PATH, uninstallPersistence };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
