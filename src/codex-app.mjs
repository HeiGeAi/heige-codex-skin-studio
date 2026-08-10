import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { promisify } from "node:util";

import {
  productAppCandidates,
  productBundledNodeCandidates,
  productExecutablePath,
  productProfile,
} from "./products.mjs";
import {
  isolatedWindowsPowerShellEnvironment,
  trustedWindowsPowerShellPath,
} from "./windows-secure-fs.mjs";

const execFileAsync = promisify(execFile);

// 宿主应用的各平台安装位点。Windows 覆盖 electron-builder 常见目录，
// doctor 逐个探测并报告命中的那一个。具体路径来自产品档案，本模块不认产品。
export function codexAppCandidates({
  platform = process.platform,
  env = process.env,
  home = homedir(),
  product = undefined,
} = {}) {
  return productAppCandidates(product, { platform, env, home });
}

export function bundledNodeCandidates(appPath, { platform = process.platform, product = undefined } = {}) {
  return productBundledNodeCandidates(product, appPath, { platform });
}

export function codexInstallation(appPath, { platform = process.platform, product = undefined } = {}) {
  const candidates = bundledNodeCandidates(appPath, { platform, product });
  return {
    appPath,
    executablePath: productExecutablePath(product, appPath, { platform }),
    // 宿主不带可执行 node 时（WorkBuddy）这里是 null，常驻回落到系统 node
    bundledNodePath: candidates[0] ?? null,
    bundledNodeCandidates: candidates,
  };
}

async function firstExisting(paths, exists) {
  for (const path of paths) {
    if (await exists(path)) return path;
  }
  return null;
}

export async function resolveCodexApp({
  platform = process.platform,
  env = process.env,
  home = homedir(),
  exists = (path) => access(path).then(() => true, () => false),
  product = undefined,
} = {}) {
  const profile = productProfile(product);
  const explicit = env[profile.appPathEnvVar];
  if (explicit) {
    if (!(await exists(explicit))) {
      throw new Error(`${profile.appPathEnvVar} does not exist: ${explicit}`);
    }
    return {
      platform,
      ...codexInstallation(explicit, { platform, product }),
      source: "env",
    };
  }

  const candidates = codexAppCandidates({ platform, env, home, product });
  const userCount = platform === "win32" ? candidates.length / 2 : 1;
  for (let index = 0; index < candidates.length; index += 1) {
    const appPath = candidates[index];
    if (await exists(appPath)) {
      // Windows 前半段是用户安装位，macOS 偶数位是 /Applications（系统位）
      const source = platform === "win32"
        ? (index < userCount ? "user" : "system")
        : (index % 2 === 0 ? "system" : "user");
      return {
        platform,
        ...codexInstallation(appPath, { platform, product }),
        source,
      };
    }
  }

  throw new Error(`${profile.label} app was not found in: ${candidates.join(", ")}`);
}

function isValidProcessIdentity(identity) {
  return identity !== null &&
    typeof identity === "object" &&
    Number.isInteger(identity.pid) &&
    identity.pid > 0 &&
    typeof identity.executablePath === "string" &&
    identity.executablePath.length > 0 &&
    typeof identity.startedAt === "string" &&
    identity.startedAt.length > 0;
}

export function sameProcessIdentity(left, right) {
  return isValidProcessIdentity(left) &&
    isValidProcessIdentity(right) &&
    left.pid === right.pid &&
    left.executablePath === right.executablePath &&
    left.startedAt === right.startedAt;
}

// lstart 尾部 HH:MM:SS YYYY 在常见 locale 下稳定；前缀则随区域变化：
// 英文 C：Thu Jul 16 16:49:24 2026（weekday month day）
// 中文：  六  7月/18 21:47:13 2026（weekday +「月/日」合并为一字段）
// 勿再假设固定英文五段，否则会漏掉刚启动的 Codex，表现为「端口就绪但进程验证失败」。
const PS_LSTART_TAIL = String.raw`\d{2}:\d{2}:\d{2}\s+\d{4}`;
const PS_PID_LSTART_COMMAND = new RegExp(
  String.raw`^\s*(\d+)\s+(.+?\s+${PS_LSTART_TAIL})\s+(.*)$`,
);
const PS_PID_PPID_LSTART_COMMAND = new RegExp(
  String.raw`^\s*(\d+)\s+(\d+)\s+(.+?\s+${PS_LSTART_TAIL})\s+(.*)$`,
);

export function parseMacPsLstartRow(line) {
  const match = PS_PID_LSTART_COMMAND.exec(String(line));
  if (!match) return null;
  return {
    pid: Number(match[1]),
    startedAt: match[2],
    commandLine: match[3],
  };
}

export function parseMacPsTreeRow(line) {
  const match = PS_PID_PPID_LSTART_COMMAND.exec(String(line));
  if (!match) return null;
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    startedAt: match[3],
    commandLine: match[4],
  };
}

export function parseMacPsTable(output) {
  const rows = [];
  for (const line of String(output).split(/\r?\n/)) {
    const row = parseMacPsLstartRow(line);
    if (row) rows.push(row);
  }
  return rows;
}

export function parseMacPsTreeTable(output) {
  const rows = [];
  for (const line of String(output).split(/\r?\n/)) {
    const row = parseMacPsTreeRow(line);
    if (row) rows.push(row);
  }
  return rows;
}

export function parseCodexProcessTable(output, app, { product = undefined } = {}) {
  const profile = productProfile(product);
  const executablePath = app.executablePath;
  // Electron 应用会拿同一个主可执行文件跑内部脚本子进程：WorkBuddy 真机上
  // daemon / sidecar / CLI 预热都是 `Electron <app.asar 里的脚本> …`。这些子进程
  // 参与识别会让唯一主进程被误判成多实例，进而拒绝接管。判据取第一个参数：
  // 位置参数（脚本路径）只有子进程才有，主进程要么零参数要么以 --flag 开头。
  const isMainInvocation = (commandLine) => {
    if (commandLine === executablePath) return true;
    const firstArgument = commandLine
      .slice(executablePath.length + 1)
      .split(/\s+/)
      .find(Boolean);
    return firstArgument === undefined || firstArgument.startsWith("--");
  };
  return parseMacPsTable(output)
    .filter(({ commandLine }) =>
      (commandLine === executablePath || commandLine.startsWith(`${executablePath} `)) &&
      isMainInvocation(commandLine))
    .map(({ pid, startedAt, commandLine }) => {
      const portMatch = commandLine.match(/(?:^|\s)--remote-debugging-port(?:=|\s+)(\d+)(?=\s|$)/);
      // WorkBuddy 从环境变量读端口，主进程自己 appendSwitch，ps 里看不到这个参数。
      // 这类产品一律报 null（未知），由 lsof 的端口归属去认人，不能当成「没开调试」。
      if (!profile.cdpPortVisibleInArgs) {
        return { pid, executablePath, startedAt, commandLine, hasCdp: null, cdpPort: null };
      }
      return {
        pid,
        executablePath,
        startedAt,
        commandLine,
        hasCdp: /(?:^|\s)--remote-debugging-port(?:=|\s|$)/.test(commandLine),
        cdpPort: portMatch ? Number(portMatch[1]) : null,
      };
    });
}

export async function listCodexProcesses({ app, exec = execFileAsync, product = undefined } = {}) {
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,lstart=,command="]);
  return parseCodexProcessTable(stdout, app, { product });
}

// 运行态诊断：版本号、进程是否带调试参数、端口是否开放。
// 报障时一份 JSON 说清「参数被接管丢弃 / 版本禁用端口 / 未运行」三类问题。
export async function runtimeDiagnostics({
  platform = process.platform,
  appPath = "/Applications/ChatGPT.app",
  port = 9341,
  exec = execFileAsync,
  env = process.env,
  fetchImpl = globalThis.fetch,
  product = undefined,
} = {}) {
  const profile = productProfile(product);
  const result = {
    appVersion: null,
    processRunning: false,
    // 命令行看不到端口的产品报 null，表示「无法从进程参数判断」，别和 false 混
    processHasDebugFlag: profile.cdpPortVisibleInArgs ? false : null,
    portOpen: false,
    portBrowser: null,
  };

  if (platform === "darwin") {
    try {
      const { stdout } = await exec("/usr/bin/defaults", [
        "read",
        posix.join(appPath, "Contents", "Info"),
        "CFBundleShortVersionString",
      ]);
      result.appVersion = stdout.trim() || null;
    } catch {}
    try {
      const { stdout } = await exec("/bin/ps", ["-axo", "command"]);
      const mainPrefix = posix.join(appPath, "Contents", "MacOS") + "/";
      const mains = stdout.split("\n").filter((line) => line.startsWith(mainPrefix));
      result.processRunning = mains.length > 0;
      if (profile.cdpPortVisibleInArgs) {
        result.processHasDebugFlag = mains.some((line) => line.includes("--remote-debugging-port"));
      }
    } catch {}
  }

  if (platform === "win32") {
    const filter = profile.windowsExecutableNames.map((name) => `Name='${name}'`).join(" or ");
    try {
      const { stdout } = await exec(trustedWindowsPowerShellPath(env), [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object -ExpandProperty CommandLine`,
      ], {
        env: isolatedWindowsPowerShellEnvironment(env),
      });
      const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
      result.processRunning = lines.length > 0;
      if (profile.cdpPortVisibleInArgs) {
        result.processHasDebugFlag = lines.some((line) => line.includes("--remote-debugging-port"));
      }
    } catch {}
  }

  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    if (response.ok) {
      result.portOpen = true;
      const version = await response.json().catch(() => null);
      result.portBrowser = version?.Browser ?? null;
    }
  } catch {}

  return result;
}

export function classifyInjection(diag, { product = undefined } = {}) {
  const profile = productProfile(product);
  if (diag.portOpen) return "ok：端口开放，可直接注入";
  if (diag.processRunning && diag.processHasDebugFlag) {
    return "flag-present-port-closed：进程已带调试参数但端口未开放，当前版本可能禁用了调试端口，请附本 JSON 开 Issue";
  }
  if (diag.processRunning && diag.processHasDebugFlag === null) {
    return `running-flag-not-observable：${profile.label} 的调试端口走环境变量传入，命令行看不到，端口没开就说明当前实例不是本工具启动的，请完全退出 ${profile.label} 后重跑 apply.command`;
  }
  if (diag.processRunning) {
    return `running-no-flag：实例未带调试参数（可能被旧实例接管或参数被丢弃），请完全退出 ${profile.label} 后重跑 apply.command`;
  }
  return `not-running：${profile.label} 未在运行`;
}

export async function discoverCodex({
  platform = process.platform,
  env = process.env,
  home = homedir(),
  exists = (path) => access(path).then(() => true, () => false),
  product = undefined,
} = {}) {
  const candidates = codexAppCandidates({ platform, env, home, product });
  const app = await firstExisting(candidates, exists);
  const nodeCandidates = app ? bundledNodeCandidates(app, { platform, product }) : [];
  const bundledNode = app ? await firstExisting(nodeCandidates, exists) : null;
  return {
    platform,
    app: app ?? candidates[0],
    appFound: app !== null,
    candidates,
    bundledNode: bundledNode ?? nodeCandidates[0] ?? null,
    bundledNodeFound: bundledNode !== null,
  };
}
