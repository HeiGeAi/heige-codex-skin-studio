import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCallback);

export const CONTROLLER_LAUNCH_AGENT_LABEL = "com.heige.codex-skin-controller";
export const LEGACY_WATCHDOG_LABEL = "com.heige.codex-skin-watchdog";

const TEST_LABEL_PREFIX = `${CONTROLLER_LAUNCH_AGENT_LABEL}.test.`;
const LEGACY_TEST_LABEL_PREFIX = `${LEGACY_WATCHDOG_LABEL}.test.`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HANDSHAKE_NONCE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const NOT_FOUND_CODES = new Set([3, 113, "3", "113"]);
const PLIST_BACKUP_MAX_BYTES = 256 * 1024;
const MIGRATION_JOURNAL_MAX_BYTES = 1024 * 1024;
const OUTER_JOURNAL_MAX_BYTES = 128 * 1024;
const MIGRATION_PHASES = new Set([
  "prepared",
  "after-journal",
  "after-new-stage",
  "after-new-lint",
  "after-existing-new-bootout",
  "after-new-publish",
  "after-new-bootstrap",
  "after-new-verify",
  "after-old-bootout",
  "after-old-verify",
  "after-old-remove",
  "awaiting-outer-commit",
  "outer-commit-decided",
  "rollback-failed",
]);
const DEFERRED_MIGRATIONS = new WeakMap();
const PRODUCTION_PLATFORM_OVERRIDE_KEYS = [
  "home",
  "launchAgentsDir",
  "stateDir",
  "stableInstallRoot",
  "processUid",
  "fs",
  "execFile",
  "readPlist",
  "faultAt",
  "hardCrashAt",
  "rollbackFaultAt",
  "processExists",
  "wait",
  "journalPath",
  "freezeJournalPath",
  "oldPlistPath",
  "nodePath",
  "controllerPath",
  "legacyRoots",
  "identifiedLegacyRoots",
];

const CONTROLLER_PLIST_KEYS = new Set([
  "KeepAlive",
  "Label",
  "ProcessType",
  "ProgramArguments",
  "RunAtLoad",
  "StandardErrorPath",
  "StandardOutPath",
]);

export function trustedUserHome() {
  const home = userInfo().homedir;
  assertAbsolutePath(home, "trusted user home");
  return home;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function assertLabel(label) {
  if (typeof label !== "string" || !LABEL_PATTERN.test(label)) {
    throw new TypeError("LaunchAgent label is invalid");
  }
}

function assertMutationLabel(label, testMode) {
  assertLabel(label);
  if (testMode) {
    if (label === CONTROLLER_LAUNCH_AGENT_LABEL || label === LEGACY_WATCHDOG_LABEL) {
      throw new Error("test mode refuses a production label");
    }
    const suffix = label.startsWith(TEST_LABEL_PREFIX)
      ? label.slice(TEST_LABEL_PREFIX.length)
      : "";
    if (!UUID_PATTERN.test(suffix)) {
      throw new Error("test mode requires a random UUID controller label");
    }
    return;
  }
  if (label !== CONTROLLER_LAUNCH_AGENT_LABEL) {
    throw new Error(`production controller label must be ${CONTROLLER_LAUNCH_AGENT_LABEL}`);
  }
}

function assertLegacyMutationLabel(label, testMode) {
  assertLabel(label);
  if (!testMode) {
    if (label !== LEGACY_WATCHDOG_LABEL) {
      throw new Error(`production legacy label must be ${LEGACY_WATCHDOG_LABEL}`);
    }
    return;
  }
  const suffix = label.startsWith(LEGACY_TEST_LABEL_PREFIX)
    ? label.slice(LEGACY_TEST_LABEL_PREFIX.length)
    : "";
  if (!UUID_PATTERN.test(suffix)) {
    throw new Error("test mode requires a random UUID legacy label");
  }
}

function assertProductionLocations(options) {
  if (options.testMode === true) return;
  const canonicalLaunchAgentsDir = join(options.home, "Library", "LaunchAgents");
  const canonicalStateDir = join(
    options.home,
    "Library",
    "Application Support",
    "HeiGeCodexSkinStudio",
  );
  const canonicalInstallRoot = join(
    options.home,
    ".codex",
    "heige-codex-skin-studio",
  );
  if (
    resolve(options.launchAgentsDir) !== resolve(canonicalLaunchAgentsDir) ||
    resolve(options.stateDir) !== resolve(canonicalStateDir) ||
    resolve(options.stableInstallRoot) !== resolve(canonicalInstallRoot)
  ) {
    throw new Error("production LaunchAgent must use canonical production locations");
  }
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function validateOuterTransaction(value) {
  if (!hasExactKeys(value, ["journalPath", "transactionId"])) {
    throw migrationJournalError("outer transaction schema is invalid");
  }
  if (!UUID_PATTERN.test(value.transactionId)) {
    throw migrationJournalError("outer transaction id is invalid");
  }
  assertAbsolutePath(value.journalPath, "outer transaction journalPath");
  if (resolve(value.journalPath) !== value.journalPath) {
    throw migrationJournalError("outer transaction journalPath must be canonical");
  }
  return {
    transactionId: value.transactionId,
    journalPath: value.journalPath,
  };
}

function assertProductionPlatformIsNotInjected(input) {
  if (input.testMode === true) return;
  if (PRODUCTION_PLATFORM_OVERRIDE_KEYS.some((key) => hasOwn(input, key))) {
    const error = new Error("production platform context cannot be overridden");
    error.code = "PRODUCTION_CONTEXT_OVERRIDE";
    throw error;
  }
}

function assertAbsolutePath(path, name) {
  if (typeof path !== "string" || path.includes("\0") || !isAbsolute(path)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
}

function isWithin(root, candidate) {
  const child = relative(resolve(root), resolve(candidate));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function isTemporaryPath(path) {
  const roots = [tmpdir(), "/tmp", "/private/tmp", "/var/tmp"];
  return roots.some((root) => isWithin(root, path));
}

function validateProgramArguments(programArguments) {
  if (!Array.isArray(programArguments) || programArguments.length === 0) {
    throw new TypeError("programArguments must be a non-empty array");
  }
  for (const argument of programArguments) {
    if (typeof argument !== "string" || argument.length === 0 || argument.includes("\0")) {
      throw new TypeError("programArguments must contain non-empty strings");
    }
  }
  assertAbsolutePath(programArguments[0], "ProgramArguments[0]");
  if (programArguments[1]?.includes(sep)) {
    assertAbsolutePath(programArguments[1], "ProgramArguments[1]");
  }
}

async function validateControllerRuntime(options, {
  nodePath,
  controllerPath,
  requireCanonicalNode = false,
}) {
  assertAbsolutePath(nodePath, "nodePath");
  assertAbsolutePath(controllerPath, "controllerPath");
  const nodePathInfo = await options.fs.lstat(nodePath);
  if (
    nodePathInfo.isSymbolicLink() ||
    !nodePathInfo.isFile() ||
    (nodePathInfo.mode & 0o111) === 0
  ) {
    throw new Error("nodePath must be a real regular executable");
  }
  const realNode = await options.fs.realpath(nodePath);
  if (requireCanonicalNode && realNode !== resolve(nodePath)) {
    throw new Error("nodePath must be canonical");
  }
  const nodeInfo = await options.fs.lstat(realNode);
  if (!nodeInfo.isFile() || (nodeInfo.mode & 0o111) === 0) {
    throw new Error("nodePath must resolve to a regular executable");
  }
  if (!options.testMode && isTemporaryPath(realNode)) {
    throw new Error("nodePath must resolve to a stable non-temporary executable");
  }

  const controllerInfo = await options.fs.lstat(controllerPath);
  if (controllerInfo.isSymbolicLink() || !controllerInfo.isFile()) {
    throw new Error("stable controller entrypoint must be a regular file");
  }
  const realController = await options.fs.realpath(controllerPath);
  const nonce = randomUUID();
  let health;
  try {
    const { stdout } = await command(options, realNode, [
      "--input-type=module",
      "--eval",
      `import { pathToFileURL } from "node:url";
const controllerPath = process.argv[2];
const nonce = process.argv[3];
await import(pathToFileURL(controllerPath).href);
process.stdout.write(JSON.stringify({
  nonce,
  pid: process.pid,
  execPath: process.execPath,
  version: process.version,
  release: process.release?.name,
  controllerPath,
}));`,
      "heige-runtime-health-probe",
      realController,
      nonce,
    ]);
    health = JSON.parse(String(stdout).trim());
  } catch (cause) {
    throw new Error("controller runtime health probe failed", { cause });
  }
  if (!Number.isInteger(health?.pid) || health.pid <= 0) {
    throw new Error("controller runtime health response is missing a valid PID");
  }
  const version = /^v(\d+)\.(\d+)\.(\d+)$/.exec(String(health.version));
  if (
    health.nonce !== nonce ||
    health.execPath !== realNode ||
    health.controllerPath !== realController ||
    health.release !== "node" ||
    !version
  ) {
    throw new Error("controller runtime health response is invalid");
  }
  if (Number(version[1]) < 22) {
    throw new Error("controller runtime requires Node 22 or newer");
  }
  return { nodePath: realNode, controllerPath: realController };
}

async function resolveStableRuntime(options) {
  const resolvedRuntime = options.runtimePathsExplicit
    ? { nodePath: options.nodePath, controllerPath: options.controllerPath }
    : await resolveTrustedProductionRuntime(options);
  assertAbsolutePath(resolvedRuntime.nodePath, "nodePath");
  assertAbsolutePath(resolvedRuntime.controllerPath, "controllerPath");
  assertAbsolutePath(options.stableInstallRoot, "stableInstallRoot");

  const expectedController = resolve(join(options.stableInstallRoot, "src", "cli.mjs"));
  if (resolve(resolvedRuntime.controllerPath) !== expectedController) {
    throw new Error("production LaunchAgent must use the stable controller entrypoint");
  }

  const rootInfo = await options.fs.lstat(options.stableInstallRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("stable controller entrypoint root must be a real directory");
  }
  const realRoot = await options.fs.realpath(options.stableInstallRoot);
  if (realRoot !== resolve(options.stableInstallRoot)) {
    throw new Error("stable controller entrypoint root must be canonical");
  }

  const runtime = await validateControllerRuntime(options, {
    nodePath: resolvedRuntime.nodePath,
    controllerPath: resolvedRuntime.controllerPath,
  });
  if (runtime.controllerPath !== join(realRoot, "src", "cli.mjs")) {
    throw new Error("production LaunchAgent must use the stable controller entrypoint");
  }
  return runtime;
}

async function commandText(options, file, args, stream = "stdout") {
  const result = await command(options, file, args);
  return String(result?.[stream] ?? "");
}

async function resolveTrustedProductionRuntime(options) {
  if (options.testMode) {
    throw new Error("test mode requires explicit runtime paths");
  }
  const appCandidates = [
    "/Applications/ChatGPT.app",
    "/Applications/Codex.app",
    join(options.home, "Applications", "ChatGPT.app"),
    join(options.home, "Applications", "Codex.app"),
  ];
  const failures = [];
  for (const appPath of appCandidates) {
    try {
      const appInfo = await options.fs.lstat(appPath);
      if (appInfo.isSymbolicLink() || !appInfo.isDirectory()) {
        throw new Error("Codex app is not a real directory");
      }
      const realApp = await options.fs.realpath(appPath);
      if (realApp !== resolve(appPath)) {
        throw new Error("Codex app path is not canonical");
      }
      const bundleId = (await commandText(options, "/usr/bin/plutil", [
        "-extract",
        "CFBundleIdentifier",
        "raw",
        "-o",
        "-",
        join(realApp, "Contents", "Info.plist"),
      ])).trim();
      if (bundleId !== "com.openai.codex") {
        throw new Error(`unexpected Codex bundle identifier: ${bundleId}`);
      }
      const nodePath = join(realApp, "Contents", "Resources", "cua_node", "bin", "node");
      const nodeInfo = await options.fs.lstat(nodePath);
      if (nodeInfo.isSymbolicLink() || !nodeInfo.isFile() || (nodeInfo.mode & 0o111) === 0) {
        throw new Error("bundled Node is not a real executable");
      }
      const realNode = await options.fs.realpath(nodePath);
      if (realNode !== nodePath || !isWithin(realApp, realNode)) {
        throw new Error("bundled Node resolves outside the trusted Codex app");
      }
      await command(options, "/usr/bin/codesign", ["--verify", "--strict", realNode]);
      const signature = await commandText(
        options,
        "/usr/bin/codesign",
        ["-dv", "--verbose=4", realNode],
        "stderr",
      );
      if (
        !/^TeamIdentifier=2DC432GLL2$/m.test(signature) ||
        !/^Authority=Developer ID Application: OpenAI OpCo, LLC \(2DC432GLL2\)$/m.test(signature)
      ) {
        throw new Error("bundled Node signer is not the trusted OpenAI identity");
      }
      return {
        nodePath: realNode,
        controllerPath: join(options.stableInstallRoot, "src", "cli.mjs"),
      };
    } catch (error) {
      failures.push(error);
    }
  }
  const error = new AggregateError(
    failures,
    "trusted Codex runtime is unavailable or failed signature validation",
  );
  error.code = "TRUSTED_RUNTIME_UNAVAILABLE";
  throw error;
}

export async function inspectTrustedProductionRuntime() {
  const home = trustedUserHome();
  return resolveStableRuntime({
    home,
    stableInstallRoot: join(home, ".codex", "heige-codex-skin-studio"),
    testMode: false,
    runtimePathsExplicit: false,
    fs: nodeFs,
    execFile: execFileAsync,
  });
}

async function resolveProgramArguments(options) {
  const explicit = options.programArguments;
  let resolved;
  if (explicit !== undefined) {
    validateProgramArguments(explicit);
    if (!options.testMode) {
      throw new Error("production LaunchAgent must use the stable controller entrypoint");
    }
    resolved = [...explicit];
  } else {
    const runtime = await resolveStableRuntime(options);
    resolved = [runtime.nodePath, runtime.controllerPath, "controller"];
  }
  resolved.push(
    "--background",
    "--platform",
    "darwin",
    "--task-name",
    options.label,
  );
  return resolved;
}

function normalizedOptions(options = {}) {
  assertProductionPlatformIsNotInjected(options);
  const testMode = options.testMode === true;
  const home = testMode ? (options.home ?? homedir()) : trustedUserHome();
  const label = options.label ?? CONTROLLER_LAUNCH_AGENT_LABEL;
  assertMutationLabel(label, testMode);
  const launchAgentsDir = testMode
    ? (options.launchAgentsDir ?? join(home, "Library", "LaunchAgents"))
    : join(home, "Library", "LaunchAgents");
  const stateDir = testMode ? (options.stateDir ?? join(
    home,
    "Library",
    "Application Support",
    "HeiGeCodexSkinStudio",
  )) : join(home, "Library", "Application Support", "HeiGeCodexSkinStudio");
  const stableInstallRoot = testMode ? (options.stableInstallRoot ?? join(
    home,
    ".codex",
    "heige-codex-skin-studio",
  )) : join(home, ".codex", "heige-codex-skin-studio");
  const controllerPath = options.controllerPath;
  const nodePath = options.nodePath;
  assertAbsolutePath(home, "home");
  assertAbsolutePath(launchAgentsDir, "launchAgentsDir");
  assertAbsolutePath(stateDir, "stateDir");
  return {
    ...options,
    home,
    label,
    launchAgentsDir,
    stateDir,
    stableInstallRoot,
    controllerPath,
    nodePath,
    testMode,
    runtimePathsExplicit: hasOwn(options, "nodePath") && hasOwn(options, "controllerPath"),
    plistPath: join(launchAgentsDir, `${label}.plist`),
    processUid: testMode ? (options.processUid ?? process.getuid?.()) : process.getuid?.(),
    execFile: testMode ? (options.execFile ?? execFileAsync) : execFileAsync,
    fs: testMode ? (options.fs ?? nodeFs) : nodeFs,
    readPlist: testMode ? options.readPlist : undefined,
    processExists: testMode ? (options.processExists ?? defaultProcessExists) : defaultProcessExists,
    wait: testMode
      ? (options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))
      : ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  };
}

function defaultProcessExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function launchDomain(options) {
  if (!Number.isInteger(options.processUid) || options.processUid < 0) {
    throw new Error("a numeric macOS uid is required");
  }
  return `gui/${options.processUid}`;
}

function launchTarget(options, label = options.label) {
  return `${launchDomain(options)}/${label}`;
}

async function command(options, file, args) {
  return options.execFile(file, args);
}

export function isExactLaunchctlPrintNotFound(error, { label, processUid }) {
  if (!NOT_FOUND_CODES.has(error?.code)) return false;
  const target = `gui/${processUid}/${label}`;
  const stderr = `Bad request.\nCould not find service "${label}" in domain for user gui: ${processUid}\n`;
  return error?.stdout === "" &&
    error?.stderr === stderr &&
    error?.message === `Command failed: /bin/launchctl print ${target}\n${stderr}`;
}

async function isLoaded(options, label = options.label) {
  try {
    await command(options, "/bin/launchctl", ["print", launchTarget(options, label)]);
    return true;
  } catch (error) {
    if (isExactLaunchctlPrintNotFound(error, {
      label,
      processUid: options.processUid,
    })) return false;
    throw error;
  }
}

async function inspectLoadedJob(options, label) {
  try {
    const result = await command(options, "/bin/launchctl", [
      "print",
      launchTarget(options, label),
    ]);
    const match = /(?:^|\n)\s*pid\s*=\s*(\d+)\s*(?:\n|$)/.exec(String(result?.stdout ?? ""));
    const pid = match === null ? null : Number(match[1]);
    return { loaded: true, pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null };
  } catch (error) {
    if (isExactLaunchctlPrintNotFound(error, {
      label,
      processUid: options.processUid,
    })) return { loaded: false, pid: null };
    throw error;
  }
}

async function waitForFrozenPidExit(options, pid) {
  if (pid === null) return;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!options.processExists(pid)) return;
    await options.wait(50);
  }
  const error = new Error(`LaunchAgent process ${pid} remained alive after bootout`);
  error.code = "LAUNCH_AGENT_PROCESS_STILL_ALIVE";
  throw error;
}

async function bootstrap(options, label, plistPath) {
  await command(options, "/bin/launchctl", ["bootstrap", launchDomain(options), plistPath]);
  if (!(await isLoaded(options, label))) {
    const error = new Error(`LaunchAgent ${label} was not loaded after bootstrap`);
    error.code = "LAUNCH_AGENT_NOT_LOADED";
    throw error;
  }
}

async function bootout(options, label, { knownLoaded = false } = {}) {
  if (!knownLoaded && !(await isLoaded(options, label))) return false;
  await command(options, "/bin/launchctl", ["bootout", launchTarget(options, label)]);
  if (await isLoaded(options, label)) {
    const error = new Error(`LaunchAgent ${label} remained loaded after bootout`);
    error.code = "LAUNCH_AGENT_STILL_LOADED";
    throw error;
  }
  return true;
}

async function syncDirectory(fs, path) {
  const handle = await fs.open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function directoryPathError(path, cause, code = "STATE_PATH_UNTRUSTED") {
  const error = new Error(`directory capability is untrusted: ${path}`, { cause });
  error.code = code;
  return error;
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

async function assertDirectoryCapability(fs, capability) {
  try {
    for (const component of capability.components) {
      const current = await fs.lstat(component.path);
      if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(component, current)) {
        throw directoryPathError(component.path, undefined, capability.code);
      }
    }
  } catch (error) {
    if (error?.code === capability.code) throw error;
    throw directoryPathError(capability.path, error, capability.code);
  }
}

async function captureDirectoryCapability(fs, path, code) {
  const canonical = resolve(path);
  const root = parse(canonical).root;
  const parts = relative(root, canonical).split(sep).filter(Boolean);
  const components = [];
  let currentPath = root;
  try {
    for (const part of parts) {
      currentPath = join(currentPath, part);
      const info = await fs.lstat(currentPath);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw directoryPathError(currentPath, undefined, code);
      }
      const handle = await fs.open(currentPath, "r");
      try {
        const opened = await handle.stat();
        if (!opened.isDirectory() || !sameIdentity(info, opened)) {
          throw directoryPathError(currentPath, undefined, code);
        }
      } finally {
        await handle.close();
      }
      components.push({ path: currentPath, dev: info.dev, ino: info.ino });
    }
    const capability = { path: canonical, code, components };
    await assertDirectoryCapability(fs, capability);
    return capability;
  } catch (error) {
    if (error?.code === code) throw error;
    throw directoryPathError(currentPath, error, code);
  }
}

async function ensurePrivateDirectory(fs, path) {
  const canonical = resolve(path);
  const root = parse(canonical).root;
  const parts = relative(root, canonical).split(sep).filter(Boolean);
  const components = [];
  let currentPath = root;
  try {
    for (const part of parts) {
      currentPath = join(currentPath, part);
      let info;
      try {
        info = await fs.lstat(currentPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        try {
          await fs.mkdir(currentPath, { mode: 0o700 });
        } catch (mkdirError) {
          if (mkdirError.code !== "EEXIST") throw mkdirError;
        }
        info = await fs.lstat(currentPath);
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw directoryPathError(currentPath);
      }
      const handle = await fs.open(currentPath, "r");
      try {
        const opened = await handle.stat();
        if (!opened.isDirectory() || !sameIdentity(info, opened)) {
          throw directoryPathError(currentPath);
        }
      } finally {
        await handle.close();
      }
      components.push({ path: currentPath, dev: info.dev, ino: info.ino });
    }

    const finalHandle = await fs.open(canonical, "r");
    try {
      const opened = await finalHandle.stat();
      const finalComponent = components.at(-1);
      if (!opened.isDirectory() || !sameIdentity(finalComponent, opened)) {
        throw directoryPathError(canonical);
      }
      if (typeof process.getuid === "function" && opened.uid !== process.getuid()) {
        throw directoryPathError(canonical);
      }
      await finalHandle.chmod(0o700);
      const secured = await finalHandle.stat();
      if ((secured.mode & 0o777) !== 0o700 || !sameIdentity(opened, secured)) {
        throw directoryPathError(canonical);
      }
    } finally {
      await finalHandle.close();
    }
    const capability = { path: canonical, code: "STATE_PATH_UNTRUSTED", components };
    await assertDirectoryCapability(fs, capability);
    return capability;
  } catch (error) {
    if (error?.code === "STATE_PATH_UNTRUSTED") throw error;
    throw directoryPathError(currentPath, error);
  }
}

async function ensureDirectory(fs, path) {
  await fs.mkdir(path, { recursive: true });
  const info = await fs.lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`directory path is not a real directory: ${path}`);
  }
}

async function assertCanonicalDirectory(fs, path) {
  const actual = await fs.realpath(path);
  if (actual !== resolve(path)) {
    throw new Error(`directory resolves outside its canonical path: ${path}`);
  }
}

async function atomicWrite(fs, path, bytes, mode = 0o600) {
  const parent = dirname(path);
  await ensureDirectory(fs, parent);
  const temporaryPath = `${path}.tmp.${randomUUID()}`;
  let handle;
  let temporarySnapshot;
  try {
    handle = await fs.open(temporaryPath, "wx", mode);
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    temporarySnapshot = await snapshotFile(fs, temporaryPath, { required: true });
    const published = await publishSnapshotPath(
      fs,
      temporaryPath,
      temporarySnapshot,
      path,
      null,
      "FILE_CAPABILITY_CONFLICT",
    );
    return published.published;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (temporarySnapshot) {
      await cleanupSnapshotIfCurrent(fs, temporaryPath, temporarySnapshot).catch(() => {});
    }
    throw error;
  }
}

async function exclusiveWrite(fs, path, bytes, mode = 0o600) {
  const parent = dirname(path);
  await ensureDirectory(fs, parent);
  let handle;
  try {
    handle = await fs.open(path, "wx", mode);
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(fs, parent);
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

function fileChangedError(path) {
  const error = new Error(`file changed during validation: ${path}`);
  error.code = "FILE_CHANGED_DURING_VALIDATION";
  return error;
}

function capabilityConflict(path, cause, code = "FILE_CAPABILITY_CONFLICT") {
  const error = new Error(`file capability conflict: ${path}`, { cause });
  error.code = code;
  return error;
}

function sameFileSnapshot(left, right) {
  return Boolean(left && right) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.sha256 === right.sha256;
}

function assertSnapshotInfo(path, before, after) {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.mode !== after.mode
  ) {
    throw fileChangedError(path);
  }
}

async function snapshotFile(fs, path, {
  required = false,
  maxBytes = PLIST_BACKUP_MAX_BYTES,
} = {}) {
  let pathInfo;
  try {
    pathInfo = await fs.lstat(path);
  } catch (error) {
    if (error.code === "ENOENT" && !required) return null;
    throw error;
  }
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
    throw new Error(`refusing a non-regular file: ${path}`);
  }
  if (typeof process.getuid === "function" && pathInfo.uid !== process.getuid()) {
    throw new Error(`refusing a file with a different owner: ${path}`);
  }
  if (pathInfo.size > maxBytes) {
    const error = new Error(`plist recovery snapshot exceeds ${maxBytes} bytes: ${path}`);
    error.code = "PLIST_BACKUP_TOO_LARGE";
    throw error;
  }

  let handle;
  try {
    handle = await fs.open(path, "r");
    const opened = await handle.stat();
    assertSnapshotInfo(path, pathInfo, opened);
    const bytes = await handle.readFile();
    const completed = await handle.stat();
    assertSnapshotInfo(path, opened, completed);
    if (bytes.length !== completed.size || bytes.length > maxBytes) {
      const error = bytes.length > maxBytes
        ? Object.assign(
          new Error(`plist recovery snapshot exceeds ${maxBytes} bytes: ${path}`),
          { code: "PLIST_BACKUP_TOO_LARGE" },
        )
        : fileChangedError(path);
      throw error;
    }
    return {
      bytes,
      mode: completed.mode & 0o777,
      dev: completed.dev,
      ino: completed.ino,
      size: completed.size,
      mtimeMs: completed.mtimeMs,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    await handle?.close();
  }
}

async function assertSnapshotCurrent(fs, path, snapshot) {
  let current;
  try {
    current = await snapshotFile(fs, path);
  } catch (error) {
    if (error.code === "ENOENT") throw fileChangedError(path);
    throw error;
  }
  if (snapshot === null) {
    if (current !== null) throw fileChangedError(path);
    return;
  }
  if (
    current === null ||
    snapshot.dev !== current.dev ||
    snapshot.ino !== current.ino ||
    snapshot.mode !== current.mode ||
    snapshot.sha256 !== current.sha256
  ) {
    throw fileChangedError(path);
  }
}

async function linkSnapshotExclusively(fs, sourcePath, sourceSnapshot, targetPath, code) {
  await assertSnapshotCurrent(fs, sourcePath, sourceSnapshot);
  try {
    await fs.link(sourcePath, targetPath);
  } catch (cause) {
    throw capabilityConflict(targetPath, cause, code);
  }
  await syncDirectory(fs, dirname(targetPath));
  const linked = await snapshotFile(fs, targetPath, { required: true });
  if (!sameFileSnapshot(sourceSnapshot, linked)) {
    throw capabilityConflict(targetPath, undefined, code);
  }
  return linked;
}

async function restoreDetachedPath(fs, detached, targetPath, code) {
  if (!detached) return null;
  const linked = await linkSnapshotExclusively(
    fs,
    detached.path,
    detached.snapshot,
    targetPath,
    code,
  );
  await deleteDetachedPath(fs, detached, code);
  return linked;
}

async function detachSnapshotPath(fs, path, expected, code = "FILE_CAPABILITY_CONFLICT") {
  if (expected === null) {
    let current;
    try {
      current = await snapshotFile(fs, path);
    } catch (cause) {
      throw capabilityConflict(path, cause, code);
    }
    if (current !== null) throw capabilityConflict(path, undefined, code);
    return null;
  }
  const detachedPath = join(dirname(path), `.heige-detached.${randomUUID()}`);
  try {
    await fs.rename(path, detachedPath);
  } catch (cause) {
    throw capabilityConflict(path, cause, code);
  }
  await syncDirectory(fs, dirname(path));
  let moved;
  try {
    moved = await snapshotFile(fs, detachedPath, { required: true });
  } catch (cause) {
    throw capabilityConflict(path, cause, code);
  }
  const detached = { path: detachedPath, snapshot: moved };
  if (!sameFileSnapshot(expected, moved)) {
    try {
      await restoreDetachedPath(fs, detached, path, code);
    } catch (restoreError) {
      throw capabilityConflict(path, restoreError, code);
    }
    throw capabilityConflict(path, undefined, code);
  }
  return detached;
}

async function deleteDetachedPath(fs, detached, code = "FILE_CAPABILITY_CONFLICT") {
  if (!detached) return false;
  await assertSnapshotCurrent(fs, detached.path, detached.snapshot).catch((cause) => {
    throw capabilityConflict(detached.path, cause, code);
  });
  const removalPath = join(dirname(detached.path), `.heige-removing.${randomUUID()}`);
  try {
    await fs.rename(detached.path, removalPath);
  } catch (cause) {
    throw capabilityConflict(detached.path, cause, code);
  }
  const moved = await snapshotFile(fs, removalPath, { required: true });
  if (!sameFileSnapshot(detached.snapshot, moved)) {
    const foreign = { path: removalPath, snapshot: moved };
    try {
      await restoreDetachedPath(fs, foreign, detached.path, code);
    } catch (restoreError) {
      throw capabilityConflict(detached.path, restoreError, code);
    }
    throw capabilityConflict(detached.path, undefined, code);
  }
  await fs.rm(removalPath);
  await syncDirectory(fs, dirname(removalPath));
  return true;
}

async function removeSnapshotPath(fs, path, snapshot, code = "FILE_CAPABILITY_CONFLICT") {
  if (snapshot === null) return false;
  const detached = await detachSnapshotPath(fs, path, snapshot, code);
  await deleteDetachedPath(fs, detached, code);
  return true;
}

async function cleanupSnapshotIfCurrent(fs, path, snapshot, code = "FILE_CAPABILITY_CONFLICT") {
  if (!snapshot) return false;
  const current = await snapshotFile(fs, path);
  if (!sameFileSnapshot(current, snapshot)) return false;
  return removeSnapshotPath(fs, path, snapshot, code);
}

async function publishSnapshotPath(fs, sourcePath, sourceSnapshot, targetPath, targetSnapshot, code) {
  await assertSnapshotCurrent(fs, sourcePath, sourceSnapshot);
  const displaced = await detachSnapshotPath(fs, targetPath, targetSnapshot, code);
  let published = null;
  try {
    published = await linkSnapshotExclusively(fs, sourcePath, sourceSnapshot, targetPath, code);
    await removeSnapshotPath(fs, sourcePath, sourceSnapshot, code);
    return { targetPath, published, displaced };
  } catch (primaryError) {
    const rollbackErrors = [];
    if (published) {
      await removeSnapshotPath(fs, targetPath, published, code).catch((error) => {
        rollbackErrors.push(error);
      });
    }
    if (displaced) {
      await restoreDetachedPath(fs, displaced, targetPath, code).catch((error) => {
        rollbackErrors.push(error);
      });
    }
    if (rollbackErrors.length > 0) {
      const error = new AggregateError([primaryError, ...rollbackErrors], primaryError.message, {
        cause: primaryError,
      });
      error.code = code ?? "FILE_CAPABILITY_CONFLICT";
      throw error;
    }
    throw primaryError;
  }
}

async function commitPublishedPath(fs, transaction, code = "FILE_CAPABILITY_CONFLICT") {
  if (transaction?.displaced) {
    await deleteDetachedPath(fs, transaction.displaced, code);
    transaction.displaced = null;
  }
}

async function rollbackPublishedPath(fs, transaction, code = "FILE_CAPABILITY_CONFLICT") {
  if (!transaction) return;
  await removeSnapshotPath(fs, transaction.targetPath, transaction.published, code);
  if (transaction.displaced) {
    await restoreDetachedPath(fs, transaction.displaced, transaction.targetPath, code);
    transaction.displaced = null;
  }
}

async function readPlistSnapshot(options, path, snapshot) {
  if (!snapshot) throw new Error(`plist snapshot is required: ${path}`);
  if (options.readPlist) {
    return options.readPlist(path, {
      bytes: Buffer.from(snapshot.bytes),
      mode: snapshot.mode,
      sha256: snapshot.sha256,
    });
  }
  const immutablePath = `${path}.validated.${randomUUID()}`;
  let immutableSnapshot;
  let stdout;
  try {
    await exclusiveWrite(options.fs, immutablePath, snapshot.bytes, 0o600);
    immutableSnapshot = await snapshotFile(options.fs, immutablePath, { required: true });
    ({ stdout } = await command(options, "/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      immutablePath,
    ]));
    await assertSnapshotCurrent(options.fs, immutablePath, immutableSnapshot);
  } finally {
    await cleanupSnapshotIfCurrent(options.fs, immutablePath, immutableSnapshot);
  }
  let value;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`plutil returned invalid JSON for ${path}`, { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`plist root is not a dictionary: ${path}`);
  }
  return value;
}

async function lintPlist(options, path) {
  await command(options, "/usr/bin/plutil", ["-lint", path]);
}

function safeError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "ERROR",
    message: String(error?.message ?? error),
  };
}

function controllerPlistShapeMatches(options, plist) {
  const expectedStdout = join(options.stateDir, "controller.log");
  const expectedStderr = join(options.stateDir, "controller.error.log");
  const exactTopLevelKeys = Object.keys(plist).length === CONTROLLER_PLIST_KEYS.size &&
    Object.keys(plist).every((key) => CONTROLLER_PLIST_KEYS.has(key));
  const exactKeepAliveKeys = plist.KeepAlive !== null &&
    typeof plist.KeepAlive === "object" &&
    !Array.isArray(plist.KeepAlive) &&
    Object.keys(plist.KeepAlive).length === 1 &&
    hasOwn(plist.KeepAlive, "SuccessfulExit");
  return exactTopLevelKeys &&
    exactKeepAliveKeys &&
    plist.Label === options.label &&
    plist.RunAtLoad === true &&
    plist.KeepAlive?.SuccessfulExit === false &&
    plist.ProcessType === "Background" &&
    plist.StandardOutPath === expectedStdout &&
    plist.StandardErrorPath === expectedStderr;
}

function assertControllerPlistAttribution(options, plist, programArguments) {
  const actualArguments = plist.ProgramArguments;
  const exactArguments = Array.isArray(actualArguments) &&
    actualArguments.length === programArguments.length &&
    actualArguments.every((value, index) => value === programArguments[index]);
  const controllerBase = programArguments.length >= 3 && programArguments[2] === "controller"
    ? programArguments.slice(0, 3)
    : null;
  const safeHandshakeArguments = controllerBase !== null &&
    Array.isArray(actualArguments) &&
    actualArguments.length === 7 &&
    actualArguments.slice(0, 3).every((value, index) => value === controllerBase[index]) &&
    actualArguments[3] === "--handshake-revision" &&
    /^(?:0|[1-9]\d*)$/.test(actualArguments[4]) &&
    Number.isSafeInteger(Number(actualArguments[4])) &&
    actualArguments[5] === "--handshake-nonce" &&
    HANDSHAKE_NONCE_PATTERN.test(actualArguments[6]);
  const baseControllerArguments = controllerBase !== null &&
    Array.isArray(actualArguments) &&
    actualArguments.length === 3 &&
    actualArguments.every((value, index) => value === controllerBase[index]);
  const matchesArguments = exactArguments || safeHandshakeArguments || baseControllerArguments;
  if (
    !matchesArguments ||
    !controllerPlistShapeMatches(options, plist)
  ) {
    const error = new Error("existing controller plist attribution failed");
    error.code = "CONTROLLER_PRESTATE_INVALID";
    throw error;
  }
}

async function assertMigrationControllerPlistAttribution(options, plist, programArguments) {
  try {
    assertControllerPlistAttribution(options, plist, programArguments);
    return "current";
  } catch (error) {
    if (error?.code !== "CONTROLLER_PRESTATE_INVALID") throw error;
  }

  const expectedNode = resolve(join(options.home, ".hermes", "node", "bin", "node"));
  const expectedController = resolve(join(options.stableInstallRoot, "src", "cli.mjs"));
  const actualArguments = plist.ProgramArguments;
  const exactKnownLegacyTuple = Array.isArray(actualArguments) &&
    actualArguments.length === 3 &&
    actualArguments[0] === expectedNode &&
    actualArguments[1] === expectedController &&
    actualArguments[2] === "controller";
  if (!exactKnownLegacyTuple || !controllerPlistShapeMatches(options, plist)) {
    const error = new Error("existing controller plist attribution failed");
    error.code = "CONTROLLER_PRESTATE_INVALID";
    throw error;
  }
  const runtime = await validateControllerRuntime(options, {
    nodePath: expectedNode,
    controllerPath: expectedController,
    requireCanonicalNode: true,
  });
  if (runtime.nodePath !== expectedNode || runtime.controllerPath !== expectedController) {
    const error = new Error("known Hermes controller runtime attribution failed");
    error.code = "CONTROLLER_PRESTATE_INVALID";
    throw error;
  }
  return "legacy-hermes";
}

function injectedFailure(phase) {
  const error = new Error(`INJECTED_MIGRATION_FAILURE at ${phase}`);
  error.code = "INJECTED_MIGRATION_FAILURE";
  error.phase = phase;
  return error;
}

function injectedHardCrash(phase) {
  const error = new Error(`SIMULATED_HARD_CRASH at ${phase}`);
  error.code = "SIMULATED_HARD_CRASH";
  error.phase = phase;
  error.simulatedHardCrash = true;
  return error;
}

function inject(options, phase, { rollback = false } = {}) {
  const selected = rollback ? options.rollbackFaultAt : options.faultAt;
  if (selected === phase) throw injectedFailure(phase);
}

function serializedJournal(journal) {
  return `${JSON.stringify(journal, null, 2)}\n`;
}

async function createMigrationJournal(options, journalPath, journal) {
  const initial = {
    ...journal,
    nonce: randomUUID(),
    revision: 0,
  };
  try {
    if (options.stateCapability) {
      await assertDirectoryCapability(options.fs, options.stateCapability);
    }
    await exclusiveWrite(
      options.fs,
      journalPath,
      serializedJournal(initial),
      0o600,
    );
  } catch (error) {
    if (error.code === "EEXIST") {
      const incomplete = new Error(
        `unfinished LaunchAgent migration journal already exists: ${journalPath}`,
      );
      incomplete.code = "MIGRATION_INCOMPLETE";
      throw incomplete;
    }
    throw error;
  }
  const snapshot = await snapshotFile(options.fs, journalPath, { required: true });
  if (options.stateCapability) {
    await assertDirectoryCapability(options.fs, options.stateCapability);
  }
  return {
    path: journalPath,
    journal: initial,
    snapshot,
  };
}

async function updateMigrationJournal(options, transaction, changes) {
  if (options.stateCapability) {
    await assertDirectoryCapability(options.fs, options.stateCapability);
  }
  const next = {
    ...transaction.journal,
    ...changes,
    previousNonce: transaction.journal.nonce,
    nonce: randomUUID(),
    revision: transaction.journal.revision + 1,
  };
  const nextPath = `${transaction.path}.next.${randomUUID()}`;
  await exclusiveWrite(options.fs, nextPath, serializedJournal(next), 0o600);
  const nextSnapshot = await snapshotFile(options.fs, nextPath, { required: true });
  let published;
  try {
    published = await publishSnapshotPath(
      options.fs,
      nextPath,
      nextSnapshot,
      transaction.path,
      transaction.snapshot,
      "JOURNAL_CONFLICT",
    );
    await commitPublishedPath(options.fs, published, "JOURNAL_CONFLICT");
    if (options.stateCapability) {
      await assertDirectoryCapability(options.fs, options.stateCapability);
    }
  } catch (error) {
    const currentNext = await snapshotFile(options.fs, nextPath).catch(() => null);
    if (currentNext && sameFileSnapshot(currentNext, nextSnapshot)) {
      await removeSnapshotPath(
        options.fs,
        nextPath,
        nextSnapshot,
        "JOURNAL_CONFLICT",
      ).catch(() => {});
    }
    if (error?.code === "JOURNAL_CONFLICT") throw error;
    throw capabilityConflict(transaction.path, error, "JOURNAL_CONFLICT");
  }
  transaction.journal = next;
  transaction.snapshot = published.published;
  return transaction;
}

async function removeMigrationJournal(options, transaction) {
  if (options.stateCapability) {
    await assertDirectoryCapability(options.fs, options.stateCapability);
  }
  return removeSnapshotPath(
    options.fs,
    transaction.path,
    transaction.snapshot,
    "JOURNAL_CONFLICT",
  );
}

function recoveryBackup(path, snapshot, loaded) {
  return {
    path,
    existed: snapshot !== null,
    bytesBase64: snapshot ? snapshot.bytes.toString("base64") : null,
    sha256: snapshot?.sha256 ?? null,
    mode: snapshot?.mode ?? null,
    loaded,
  };
}

function migrationJournalError(message, cause = undefined) {
  const error = new Error(`invalid LaunchAgent migration journal: ${message}`, cause === undefined
    ? undefined
    : { cause });
  error.code = "MIGRATION_INCOMPLETE";
  return error;
}

function decodeJournalBytes(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw migrationJournalError(`${field} is not canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > PLIST_BACKUP_MAX_BYTES || bytes.toString("base64") !== value) {
    throw migrationJournalError(`${field} is not canonical bounded base64`);
  }
  return bytes;
}

function validateJournalBackup(value, expectedPath, field) {
  const keys = ["bytesBase64", "existed", "loaded", "mode", "path", "sha256"];
  if (!hasExactKeys(value, keys) || value.path !== expectedPath || typeof value.loaded !== "boolean") {
    throw migrationJournalError(`${field} schema or path is invalid`);
  }
  if (typeof value.existed !== "boolean") {
    throw migrationJournalError(`${field}.existed is invalid`);
  }
  if (!value.existed) {
    if (
      value.bytesBase64 !== null ||
      value.sha256 !== null ||
      value.mode !== null ||
      value.loaded
    ) {
      throw migrationJournalError(`${field} absent-state invariant is invalid`);
    }
    return { ...value, bytes: null };
  }
  if (!Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o777) {
    throw migrationJournalError(`${field}.mode is invalid`);
  }
  const bytes = decodeJournalBytes(value.bytesBase64, `${field}.bytesBase64`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(value.sha256) || value.sha256 !== digest) {
    throw migrationJournalError(`${field}.sha256 is invalid`);
  }
  return { ...value, bytes };
}

function validateJournalForward(value, options) {
  const keys = ["bytesBase64", "plistPath", "programArguments", "sha256", "stagedPath"];
  if (!hasExactKeys(value, keys) || value.plistPath !== options.plistPath) {
    throw migrationJournalError("forward schema or plistPath is invalid");
  }
  const stagedPrefix = `${options.plistPath}.staged.`;
  const stagedNonce = typeof value.stagedPath === "string" && value.stagedPath.startsWith(stagedPrefix)
    ? value.stagedPath.slice(stagedPrefix.length)
    : "";
  if (!UUID_PATTERN.test(stagedNonce) || dirname(value.stagedPath) !== options.launchAgentsDir) {
    throw migrationJournalError("forward stagedPath is outside the attributed path");
  }
  const args = value.programArguments;
  const expectedController = resolve(join(options.stableInstallRoot, "src", "cli.mjs"));
  if (
    !Array.isArray(args) ||
    args.length !== 8 ||
    typeof args[0] !== "string" ||
    !isAbsolute(args[0]) ||
    args[1] !== expectedController ||
    args[2] !== "controller" ||
    args[3] !== "--background" ||
    args[4] !== "--platform" ||
    args[5] !== "darwin" ||
    args[6] !== "--task-name" ||
    args[7] !== options.label
  ) {
    throw migrationJournalError("forward programArguments are invalid");
  }
  const bytes = decodeJournalBytes(value.bytesBase64, "forward.bytesBase64");
  const expectedBytes = Buffer.from(renderControllerPlist({
    label: options.label,
    programArguments: args,
    stateDir: options.stateDir,
  }));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (
    !bytes.equals(expectedBytes) ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    value.sha256 !== digest
  ) {
    throw migrationJournalError("forward bytes or digest are invalid");
  }
  return { ...value, bytes };
}

function validateMigrationJournal(value, options, { oldLabel, oldPlistPath }) {
  const baseKeys = [
    "createdAt",
    "forward",
    "newBackup",
    "newLabel",
    "nonce",
    "oldBackup",
    "oldLabel",
    "operation",
    "phase",
    "revision",
    "schemaVersion",
  ];
  const optionalKeys = new Set([
    "outerTransaction",
    "previousNonce",
    "primaryError",
    "rollbackErrors",
  ]);
  if (
    !isRecord(value) ||
    baseKeys.some((key) => !hasOwn(value, key)) ||
    Object.keys(value).some((key) => !baseKeys.includes(key) && !optionalKeys.has(key))
  ) {
    throw migrationJournalError("top-level schema has unknown or missing fields");
  }
  if (
    value.schemaVersion !== 2 ||
    value.operation !== "migrate-legacy-watchdog" ||
    !MIGRATION_PHASES.has(value.phase) ||
    value.oldLabel !== oldLabel ||
    value.newLabel !== options.label ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !UUID_PATTERN.test(value.nonce) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  ) {
    throw migrationJournalError("identity, phase, nonce, revision, or timestamp is invalid");
  }
  if (
    (value.revision === 0 && hasOwn(value, "previousNonce")) ||
    (value.revision > 0 && (!UUID_PATTERN.test(value.previousNonce) || value.previousNonce === value.nonce))
  ) {
    throw migrationJournalError("nonce chain is invalid");
  }
  if (value.phase === "rollback-failed") {
    if (
      !hasExactKeys(value.primaryError, ["code", "message"]) ||
      typeof value.primaryError.code !== "string" ||
      typeof value.primaryError.message !== "string" ||
      !Array.isArray(value.rollbackErrors) ||
      value.rollbackErrors.some((entry) =>
        !hasExactKeys(entry, ["code", "message"]) ||
        typeof entry.code !== "string" ||
        typeof entry.message !== "string")
    ) {
      throw migrationJournalError("rollback failure detail is invalid");
    }
  } else if (hasOwn(value, "primaryError") || hasOwn(value, "rollbackErrors")) {
    throw migrationJournalError("rollback fields are not valid in this phase");
  }
  const outerTransaction = hasOwn(value, "outerTransaction")
    ? validateOuterTransaction(value.outerTransaction)
    : null;
  if (
    ["awaiting-outer-commit", "outer-commit-decided"].includes(value.phase) &&
    outerTransaction === null
  ) {
    throw migrationJournalError("deferred migration is missing its outer transaction binding");
  }
  return {
    ...value,
    ...(outerTransaction === null ? {} : { outerTransaction }),
    oldBackup: validateJournalBackup(value.oldBackup, oldPlistPath, "oldBackup"),
    newBackup: validateJournalBackup(value.newBackup, options.plistPath, "newBackup"),
    forward: validateJournalForward(value.forward, options),
  };
}

async function readMigrationJournal(options, journalPath, identity) {
  const snapshot = await snapshotFile(options.fs, journalPath, {
    required: true,
    maxBytes: MIGRATION_JOURNAL_MAX_BYTES,
  });
  if (snapshot.mode !== 0o600) {
    throw migrationJournalError("journal mode must be 0600");
  }
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes);
  } catch (cause) {
    throw migrationJournalError("journal is not valid UTF-8", cause);
  }
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch (cause) {
    throw migrationJournalError("journal is not valid JSON", cause);
  }
  if (decoded !== serializedJournal(parsed)) {
    throw migrationJournalError("journal JSON is not canonical or contains duplicate fields");
  }
  const journal = validateMigrationJournal(parsed, options, identity);
  await assertSnapshotCurrent(options.fs, journalPath, snapshot);
  return { path: journalPath, journal, snapshot };
}

async function readOuterTransactionDecision(options, outerTransaction) {
  let snapshot;
  try {
    snapshot = await snapshotFile(options.fs, outerTransaction.journalPath, {
      required: true,
      maxBytes: OUTER_JOURNAL_MAX_BYTES,
    });
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
  if (snapshot.mode !== 0o600) {
    throw migrationJournalError("outer transaction journal mode must be 0600");
  }
  let document;
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes);
    document = JSON.parse(decoded);
  } catch (cause) {
    throw migrationJournalError("outer transaction journal is invalid JSON", cause);
  }
  if (decoded !== `${JSON.stringify(document)}\n`) {
    throw migrationJournalError("outer transaction journal JSON is not canonical");
  }
  const installKeys = [
    "createdAt",
    "decision",
    "nonce",
    "operation",
    "participant",
    "phase",
    "previousNonce",
    "product",
    "revision",
    "schemaVersion",
    "transactionId",
  ];
  const lifecycleKeys = [
    "createdAt",
    "decision",
    "nonce",
    "operation",
    "phase",
    "previousNonce",
    "product",
    "revision",
    "schemaVersion",
    "serviceParticipant",
    "stateParticipant",
    "transactionId",
  ];
  const knownShape = document?.operation === "install-tree"
    ? hasExactKeys(document, installKeys)
    : document?.operation === "legacy-migration" && hasExactKeys(document, lifecycleKeys);
  if (
    !knownShape ||
    document.schemaVersion !== 1 ||
    document.product !== "heige-codex-skin-studio" ||
    !UUID_PATTERN.test(document.transactionId) ||
    !["undecided", "rollback", "commit"].includes(document.decision) ||
    !Number.isSafeInteger(document.revision) ||
    document.revision < 0 ||
    !UUID_PATTERN.test(document.nonce) ||
    !(document.previousNonce === null || UUID_PATTERN.test(document.previousNonce)) ||
    typeof document.createdAt !== "string" ||
    !Number.isFinite(Date.parse(document.createdAt))
  ) {
    throw migrationJournalError("outer transaction journal schema is invalid");
  }
  if (document.transactionId !== outerTransaction.transactionId) {
    const error = new Error("outer transaction id does not match the migration participant");
    error.code = "OUTER_TRANSACTION_CONFLICT";
    throw error;
  }
  await assertSnapshotCurrent(options.fs, outerTransaction.journalPath, snapshot);
  return document.decision;
}

function snapshotMatchesBytes(snapshot, bytes, mode) {
  return snapshot !== null &&
    snapshot.mode === mode &&
    snapshot.size === bytes.length &&
    snapshot.sha256 === createHash("sha256").update(bytes).digest("hex");
}

function assertRecoveryPathState(path, snapshot, accepted, { allowAbsent = true } = {}) {
  if (snapshot === null && allowAbsent) return;
  if (accepted.some(({ bytes, mode }) => snapshotMatchesBytes(snapshot, bytes, mode))) return;
  const error = new Error(`migration recovery found a foreign path: ${path}`);
  error.code = "MIGRATION_RECOVERY_CONFLICT";
  throw error;
}

async function restoreJournalBackup(options, backup, accepted) {
  let current = await snapshotFile(options.fs, backup.path);
  assertRecoveryPathState(backup.path, current, accepted);
  if (backup.existed && snapshotMatchesBytes(current, backup.bytes, backup.mode)) return;
  if (current !== null) {
    await removeSnapshotPath(
      options.fs,
      backup.path,
      current,
      "MIGRATION_RECOVERY_CONFLICT",
    );
  }
  if (!backup.existed) return;
  await atomicWrite(options.fs, backup.path, backup.bytes, backup.mode);
  current = await snapshotFile(options.fs, backup.path, { required: true });
  if (!snapshotMatchesBytes(current, backup.bytes, backup.mode)) {
    const error = new Error(`migration recovery failed to restore: ${backup.path}`);
    error.code = "MIGRATION_RECOVERY_CONFLICT";
    throw error;
  }
}

async function recoverMigrationJournal(options, {
  journalPath,
  oldLabel,
  oldPlistPath,
}) {
  const existing = await snapshotFile(options.fs, journalPath, {
    maxBytes: MIGRATION_JOURNAL_MAX_BYTES,
  });
  if (existing === null) return { recovered: false };
  const transaction = await readMigrationJournal(options, journalPath, {
    oldLabel,
    oldPlistPath,
  });
  const { journal } = transaction;
  const outerDecision = journal.outerTransaction === undefined
    ? null
    : await readOuterTransactionDecision(options, journal.outerTransaction);
  const rollForward = journal.phase === "outer-commit-decided" ||
    (journal.phase === "awaiting-outer-commit" && outerDecision === "commit");
  const forwardState = { bytes: journal.forward.bytes, mode: 0o600 };
  const oldAccepted = journal.oldBackup.existed
    ? [{ bytes: journal.oldBackup.bytes, mode: journal.oldBackup.mode }]
    : [];
  const newAccepted = [forwardState];
  if (journal.newBackup.existed) {
    newAccepted.push({ bytes: journal.newBackup.bytes, mode: journal.newBackup.mode });
  }

  await assertDirectoryCapability(options.fs, options.stateCapability);
  await assertDirectoryCapability(options.fs, options.launchAgentsCapability);
  const oldCurrent = await snapshotFile(options.fs, oldPlistPath);
  const newCurrent = await snapshotFile(options.fs, options.plistPath);
  const stagedCurrent = await snapshotFile(options.fs, journal.forward.stagedPath);
  if (rollForward) {
    assertRecoveryPathState(oldPlistPath, oldCurrent, oldAccepted, { allowAbsent: true });
    assertRecoveryPathState(options.plistPath, newCurrent, [forwardState], {
      allowAbsent: false,
    });
    assertRecoveryPathState(journal.forward.stagedPath, stagedCurrent, [forwardState]);
    await assertSnapshotCurrent(options.fs, journalPath, transaction.snapshot);
    if (await isLoaded(options, oldLabel)) {
      await bootout(options, oldLabel, { knownLoaded: true });
    }
    const oldAfterBootout = await snapshotFile(options.fs, oldPlistPath);
    if (oldAfterBootout !== null) {
      assertRecoveryPathState(oldPlistPath, oldAfterBootout, oldAccepted, {
        allowAbsent: false,
      });
      await removeSnapshotPath(
        options.fs,
        oldPlistPath,
        oldAfterBootout,
        "MIGRATION_RECOVERY_CONFLICT",
      );
    }
    if (!(await isLoaded(options, options.label))) {
      await bootstrap(options, options.label, options.plistPath);
    }
    const staged = await snapshotFile(options.fs, journal.forward.stagedPath);
    if (staged !== null) {
      await removeSnapshotPath(
        options.fs,
        journal.forward.stagedPath,
        staged,
        "MIGRATION_RECOVERY_CONFLICT",
      );
    }
    await removeMigrationJournal(options, transaction);
    return { recovered: true, action: "roll-forward", phase: journal.phase };
  }
  assertRecoveryPathState(oldPlistPath, oldCurrent, oldAccepted);
  assertRecoveryPathState(options.plistPath, newCurrent, newAccepted);
  assertRecoveryPathState(journal.forward.stagedPath, stagedCurrent, [forwardState]);
  await assertSnapshotCurrent(options.fs, journalPath, transaction.snapshot);

  if (await isLoaded(options, options.label)) {
    await bootout(options, options.label, { knownLoaded: true });
  }
  await restoreJournalBackup(options, journal.newBackup, newAccepted);
  if (journal.newBackup.loaded) {
    await bootstrap(options, options.label, options.plistPath);
  }
  if ((await isLoaded(options, options.label)) !== journal.newBackup.loaded) {
    throw new Error("migration recovery did not restore controller loaded state");
  }

  if (await isLoaded(options, oldLabel)) {
    await bootout(options, oldLabel, { knownLoaded: true });
  }
  await restoreJournalBackup(options, journal.oldBackup, oldAccepted);
  if (journal.oldBackup.loaded) {
    await bootstrap(options, oldLabel, oldPlistPath);
  }
  if ((await isLoaded(options, oldLabel)) !== journal.oldBackup.loaded) {
    throw new Error("migration recovery did not restore legacy loaded state");
  }

  const staged = await snapshotFile(options.fs, journal.forward.stagedPath);
  if (staged !== null) {
    assertRecoveryPathState(journal.forward.stagedPath, staged, [forwardState], {
      allowAbsent: false,
    });
    await removeSnapshotPath(
      options.fs,
      journal.forward.stagedPath,
      staged,
      "MIGRATION_RECOVERY_CONFLICT",
    );
  }
  await assertDirectoryCapability(options.fs, options.stateCapability);
  await assertDirectoryCapability(options.fs, options.launchAgentsCapability);
  await removeMigrationJournal(options, transaction);
  return { recovered: true, phase: journal.phase };
}

export function renderControllerPlist({
  label = CONTROLLER_LAUNCH_AGENT_LABEL,
  programArguments,
  nodePath,
  controllerPath,
  stateDir,
} = {}) {
  assertLabel(label);
  assertAbsolutePath(stateDir, "stateDir");
  const args = programArguments ?? [nodePath, controllerPath, "controller"];
  if (!Array.isArray(args) || args.length === 0) {
    throw new TypeError("programArguments must be a non-empty array");
  }
  for (const argument of args) {
    if (typeof argument !== "string" || argument.length === 0 || argument.includes("\0")) {
      throw new TypeError("programArguments must contain non-empty strings");
    }
  }
  assertAbsolutePath(args[0], "ProgramArguments[0]");
  if (args.length >= 2 && (controllerPath !== undefined || args[2] === "controller")) {
    assertAbsolutePath(args[1], "controllerPath");
  } else if (args[1]?.includes(sep)) {
    assertAbsolutePath(args[1], "ProgramArguments[1]");
  }

  const stdoutPath = join(stateDir, "controller.log");
  const stderrPath = join(stateDir, "controller.error.log");
  const argumentXml = args.map((argument) => `        <string>${xmlEscape(argument)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(label)}</string>
    <key>ProgramArguments</key>
    <array>
${argumentXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xmlEscape(stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(stderrPath)}</string>
</dict>
</plist>
`;
}

export async function inspectLaunchAgent(input = {}) {
  const options = normalizedOptions(input);
  assertLabel(options.label);
  launchDomain(options);
  const snapshot = await snapshotFile(options.fs, options.plistPath);
  const plist = snapshot
    ? await readPlistSnapshot(options, options.plistPath, snapshot)
    : null;
  await assertSnapshotCurrent(options.fs, options.plistPath, snapshot);
  return {
    label: options.label,
    plistPath: options.plistPath,
    plistExists: snapshot !== null,
    plistLabel: plist?.Label ?? null,
    loaded: await isLoaded(options),
  };
}

export async function wakeControllerAgent(input = {}) {
  const options = normalizedOptions(input);
  assertMutationLabel(options.label, options.testMode === true);
  assertProductionLocations(options);
  launchDomain(options);
  if (!(await isLoaded(options))) {
    const error = new Error(`LaunchAgent ${options.label} is not loaded`);
    error.code = "LAUNCH_AGENT_NOT_LOADED";
    throw error;
  }
  await command(options, "/bin/launchctl", ["kickstart", "-k", launchTarget(options)]);
  if (!(await isLoaded(options))) {
    const error = new Error(`LaunchAgent ${options.label} was not loaded after kickstart`);
    error.code = "LAUNCH_AGENT_NOT_LOADED";
    throw error;
  }
  return { label: options.label, loaded: true, woken: true };
}

async function restoreRegistration(
  options,
  snapshot,
  loadedBefore,
  publishedTransaction,
  rollbackErrors,
) {
  try {
    if (await isLoaded(options)) await bootout(options, options.label);
  } catch (error) {
    rollbackErrors.push(error);
  }
  try {
    if (publishedTransaction) {
      await rollbackPublishedPath(options.fs, publishedTransaction);
    } else if (snapshot) {
      await assertSnapshotCurrent(options.fs, options.plistPath, snapshot);
    }
  } catch (error) {
    rollbackErrors.push(error);
  }
  if (loadedBefore && snapshot) {
    try {
      await bootstrap(options, options.label, options.plistPath);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
}

export async function registerControllerAgent(input = {}) {
  const options = normalizedOptions(input);
  assertMutationLabel(options.label, options.testMode === true);
  assertProductionLocations(options);
  launchDomain(options);
  const programArguments = await resolveProgramArguments(options);
  options.stateCapability = await ensurePrivateDirectory(options.fs, options.stateDir);
  await ensureDirectory(options.fs, options.launchAgentsDir);
  await assertCanonicalDirectory(options.fs, options.launchAgentsDir);
  options.launchAgentsCapability = await captureDirectoryCapability(
    options.fs,
    options.launchAgentsDir,
    "LAUNCH_AGENTS_PATH_UNTRUSTED",
  );

  const previous = await snapshotFile(options.fs, options.plistPath);
  const loadedBefore = await isLoaded(options);
  if (loadedBefore && !previous) {
    const error = new Error("loaded controller has no restorable canonical plist");
    error.code = "CONTROLLER_PRESTATE_INVALID";
    throw error;
  }
  if (previous) {
    assertControllerPlistAttribution(
      options,
      await readPlistSnapshot(options, options.plistPath, previous),
      programArguments,
    );
  }
  const plist = renderControllerPlist({
    label: options.label,
    programArguments,
    stateDir: options.stateDir,
  });
  if (
    loadedBefore &&
    previous?.mode === 0o600 &&
    previous.bytes.equals(Buffer.from(plist))
  ) {
    await assertSnapshotCurrent(options.fs, options.plistPath, previous);
    return {
      label: options.label,
      plistPath: options.plistPath,
      loaded: true,
    };
  }
  const stagedPath = `${options.plistPath}.staged.${randomUUID()}`;
  let stagedSnapshot;
  let publishedTransaction;

  await assertSnapshotCurrent(options.fs, options.plistPath, previous);
  try {
    await atomicWrite(options.fs, stagedPath, plist, 0o600);
    stagedSnapshot = await snapshotFile(options.fs, stagedPath, { required: true });
    await lintPlist(options, stagedPath);
    await assertSnapshotCurrent(options.fs, stagedPath, stagedSnapshot);
  } catch (error) {
    await cleanupSnapshotIfCurrent(options.fs, stagedPath, stagedSnapshot).catch(() => {});
    throw error;
  }

  try {
    await assertDirectoryCapability(options.fs, options.stateCapability);
    await assertDirectoryCapability(options.fs, options.launchAgentsCapability);
    if (loadedBefore) await bootout(options, options.label);
    publishedTransaction = await publishStagedPlist(
      options,
      stagedPath,
      options.plistPath,
      stagedSnapshot,
      previous,
    );
    await assertDirectoryCapability(options.fs, options.stateCapability);
    await assertDirectoryCapability(options.fs, options.launchAgentsCapability);
    await bootstrap(options, options.label, options.plistPath);
    await assertDirectoryCapability(options.fs, options.stateCapability);
    await assertDirectoryCapability(options.fs, options.launchAgentsCapability);
    await commitPublishedPath(options.fs, publishedTransaction);
  } catch (primaryError) {
    const rollbackErrors = [];
    await restoreRegistration(
      options,
      previous,
      loadedBefore,
      publishedTransaction,
      rollbackErrors,
    );
    if (rollbackErrors.length > 0) {
      const error = new AggregateError(
        [primaryError, ...rollbackErrors],
        `LaunchAgent registration failed and rollback also failed: ${primaryError.message}`,
      );
      error.code = "REGISTRATION_ROLLBACK_FAILED";
      error.primaryError = primaryError;
      error.rollbackErrors = rollbackErrors;
      throw error;
    }
    throw primaryError;
  } finally {
    await cleanupSnapshotIfCurrent(options.fs, stagedPath, stagedSnapshot).catch(() => {});
  }

  return {
    label: options.label,
    plistPath: options.plistPath,
    loaded: true,
  };
}

export async function unregisterControllerAgent(input = {}) {
  const options = normalizedOptions(input);
  assertMutationLabel(options.label, options.testMode === true);
  assertProductionLocations(options);
  launchDomain(options);
  const programArguments = await resolveProgramArguments(options);
  const snapshot = await snapshotFile(options.fs, options.plistPath);
  const loaded = await isLoaded(options);
  if (loaded && !snapshot) {
    const error = new Error("loaded controller has no trusted canonical plist");
    error.code = "CONTROLLER_PRESTATE_INVALID";
    throw error;
  }
  if (snapshot) {
    const plist = await readPlistSnapshot(options, options.plistPath, snapshot);
    assertControllerPlistAttribution(options, plist, programArguments);
  }
  const launchAgentsCapability = snapshot
    ? await captureDirectoryCapability(
      options.fs,
      options.launchAgentsDir,
      "LAUNCH_AGENTS_PATH_UNTRUSTED",
    )
    : null;
  await assertSnapshotCurrent(options.fs, options.plistPath, snapshot);
  if (launchAgentsCapability) {
    await assertDirectoryCapability(options.fs, launchAgentsCapability);
  }
  if (loaded) {
    await bootout(options, options.label, { knownLoaded: true });
  }
  await assertSnapshotCurrent(options.fs, options.plistPath, snapshot);
  if (launchAgentsCapability) {
    await assertDirectoryCapability(options.fs, launchAgentsCapability);
  }
  const removed = snapshot
    ? await removeSnapshotPath(options.fs, options.plistPath, snapshot)
    : false;
  if (launchAgentsCapability) {
    await assertDirectoryCapability(options.fs, launchAgentsCapability);
  }
  return {
    label: options.label,
    plistPath: options.plistPath,
    loaded: false,
    removed,
  };
}

async function assertCanonicalLegacyPlist(options, oldPlistPath, oldLabel) {
  const canonical = join(
    options.home,
    "Library",
    "LaunchAgents",
    `${oldLabel}.plist`,
  );
  if (resolve(oldPlistPath) !== resolve(canonical)) {
    throw new Error("legacy attribution failed: plist is not at the canonical path");
  }
  const actual = await options.fs.realpath(oldPlistPath);
  if (actual !== resolve(canonical)) {
    throw new Error("legacy attribution failed: canonical plist resolves elsewhere");
  }
}

async function resolveLegacyRootCapabilities(options) {
  const declaredRoots = options.testMode
    ? [
      options.stableInstallRoot,
      ...(options.legacyRoots ?? []),
      ...(options.identifiedLegacyRoots ?? []),
    ]
    : [options.stableInstallRoot];
  const roots = declaredRoots.filter((value, index, values) =>
    typeof value === "string" && values.indexOf(value) === index
  );
  const capabilities = [];
  for (const root of roots) {
    assertAbsolutePath(root, "legacy root");
    try {
      const info = await options.fs.lstat(root);
      if (info.isSymbolicLink() || !info.isDirectory()) continue;
      const realRoot = await options.fs.realpath(root);
      if (realRoot !== resolve(root) || isTemporaryPath(realRoot)) continue;
      const handle = await options.fs.open(realRoot, "r");
      try {
        const opened = await handle.stat();
        if (!opened.isDirectory() || !sameIdentity(info, opened)) continue;
        capabilities.push({ path: realRoot, dev: opened.dev, ino: opened.ino });
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return capabilities;
}

async function assertLegacyRootCapability(options, capability) {
  const current = await options.fs.lstat(capability.path);
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    !sameIdentity(current, capability) ||
    await options.fs.realpath(capability.path) !== capability.path
  ) {
    throw new Error("legacy attribution failed: approved root capability changed");
  }
}

async function assertLegacyAttribution(options, oldPlistPath, plist, oldLabel) {
  if (
    plist.Label !== oldLabel ||
    plist.RunAtLoad !== true ||
    plist.StartInterval !== 15 ||
    plist.AbandonProcessGroup !== true ||
    !Array.isArray(plist.ProgramArguments) ||
    plist.ProgramArguments.length !== 2 ||
    plist.ProgramArguments[0] !== "/bin/zsh" ||
    !(
      plist.EnvironmentVariables?.HEIGE_CODEX_SKIN_PORT === "9341" ||
      plist.EnvironmentVariables?.HEIGE_CODEX_SKIN_PORT === 9341
    )
  ) {
    throw new Error("legacy attribution failed: fixed feature tuple mismatch");
  }
  await assertCanonicalLegacyPlist(options, oldPlistPath, oldLabel);

  const scriptPath = plist.ProgramArguments[1];
  assertAbsolutePath(scriptPath, "legacy watchdog executable");
  if (isTemporaryPath(scriptPath)) {
    throw new Error("legacy attribution failed: executable is under a temporary path");
  }
  const scriptRoot = dirname(dirname(dirname(scriptPath)));
  if (resolve(scriptPath) !== resolve(join(scriptRoot, "scripts", "lib", "skin-watchdog.zsh"))) {
    throw new Error("legacy attribution failed: executable suffix mismatch");
  }
  const allowedRoots = await resolveLegacyRootCapabilities(options);
  const rootCapability = allowedRoots.find((root) => root.path === resolve(scriptRoot));
  if (!rootCapability || isTemporaryPath(scriptRoot)) {
    throw new Error("legacy attribution failed: executable root is not positively identified");
  }
  const scriptInfo = await options.fs.lstat(scriptPath);
  if (scriptInfo.isSymbolicLink() || !scriptInfo.isFile()) {
    throw new Error("legacy attribution failed: executable is not a regular file");
  }
  const actualScript = await options.fs.realpath(scriptPath);
  if (
    isTemporaryPath(actualScript) ||
    !isWithin(rootCapability.path, actualScript) ||
    actualScript !== join(rootCapability.path, "scripts", "lib", "skin-watchdog.zsh")
  ) {
    throw new Error("legacy attribution failed: executable resolves outside its approved real root");
  }
  await assertLegacyRootCapability(options, rootCapability);
}

async function advanceMigration(options, journalTransaction, phase) {
  await updateMigrationJournal(options, journalTransaction, { phase });
  if (options.hardCrashAt === phase) throw injectedHardCrash(phase);
  inject(options, phase);
}

async function assertLoadedPrestate(options, label, expected) {
  if ((await isLoaded(options, label)) !== expected) {
    const error = new Error(`LaunchAgent loaded state changed before mutation: ${label}`);
    error.code = "MIGRATION_PRESTATE_CHANGED";
    throw error;
  }
}

async function publishStagedPlist(
  options,
  stagedPath,
  targetPath,
  stagedSnapshot,
  targetSnapshot,
) {
  return publishSnapshotPath(
    options.fs,
    stagedPath,
    stagedSnapshot,
    targetPath,
    targetSnapshot,
    "FILE_CAPABILITY_CONFLICT",
  );
}

async function rollbackMigration({
  options,
  primaryError,
  journalTransaction,
  stagedPath,
  oldPlistPath,
  oldSnapshot,
  oldLoaded,
  oldLabel,
  newSnapshot,
  newLoadedBefore,
  newPublishedTransaction,
  oldDetached,
  stagedSnapshot,
}) {
  const rollbackErrors = [];
  const attempt = async (action) => {
    try {
      await action();
    } catch (error) {
      rollbackErrors.push(error);
    }
  };

  await attempt(async () => {
    inject(options, "before-new-bootout", { rollback: true });
    if (await isLoaded(options, options.label)) {
      await bootout(options, options.label);
    }
  });
  await attempt(async () => {
    inject(options, "before-new-plist-restore", { rollback: true });
    await assertDirectoryCapability(options.fs, options.launchAgentsCapability);
    if (newPublishedTransaction) {
      await rollbackPublishedPath(options.fs, newPublishedTransaction);
    } else if (newSnapshot) {
      await assertSnapshotCurrent(options.fs, options.plistPath, newSnapshot);
    }
  });
  await attempt(async () => {
    const currentlyLoaded = await isLoaded(options, options.label);
    if (newLoadedBefore && !currentlyLoaded) {
      if (!newSnapshot) throw new Error("loaded controller had no restorable plist snapshot");
      inject(options, "before-new-rebootstrap", { rollback: true });
      await bootstrap(options, options.label, options.plistPath);
    } else if (!newLoadedBefore && currentlyLoaded) {
      await bootout(options, options.label);
    }
    if ((await isLoaded(options, options.label)) !== newLoadedBefore) {
      throw new Error("controller loaded state was not restored");
    }
  });
  await attempt(async () => {
    inject(options, "before-old-plist-restore", { rollback: true });
    await assertDirectoryCapability(options.fs, options.launchAgentsCapability);
    if (oldDetached) {
      await restoreDetachedPath(options.fs, oldDetached, oldPlistPath);
    } else {
      await assertSnapshotCurrent(options.fs, oldPlistPath, oldSnapshot);
    }
  });
  await attempt(async () => {
    const currentlyLoaded = await isLoaded(options, oldLabel);
    if (oldLoaded && !currentlyLoaded) {
      inject(options, "before-old-rebootstrap", { rollback: true });
      await bootstrap(options, oldLabel, oldPlistPath);
    } else if (!oldLoaded && currentlyLoaded) {
      await bootout(options, oldLabel);
    }
    if ((await isLoaded(options, oldLabel)) !== oldLoaded) {
      throw new Error("legacy loaded state was not restored");
    }
  });
  await attempt(async () => {
    inject(options, "before-stage-cleanup", { rollback: true });
    if (stagedSnapshot && await snapshotFile(options.fs, stagedPath)) {
      await removeSnapshotPath(options.fs, stagedPath, stagedSnapshot);
    }
  });

  if (rollbackErrors.length === 0) {
    await attempt(async () => {
      inject(options, "before-journal-cleanup", { rollback: true });
      await removeMigrationJournal(options, journalTransaction);
    });
    if (rollbackErrors.length === 0) return null;
  }

  try {
    await updateMigrationJournal(options, journalTransaction, {
      phase: "rollback-failed",
      primaryError: safeError(primaryError),
      rollbackErrors: rollbackErrors.map(safeError),
    });
  } catch (journalError) {
    rollbackErrors.push(journalError);
  }
  const error = new AggregateError(
    [primaryError, ...rollbackErrors],
    `migration failed and rollback also failed: ${primaryError.message}`,
  );
  error.code = "MIGRATION_ROLLBACK_FAILED";
  error.primaryError = primaryError;
  error.rollbackErrors = rollbackErrors;
  return error;
}

function validateFreezeJournal(value, options, {
  controllerPlistPath,
  watchdogLabel,
  watchdogPlistPath,
}) {
  const keys = [
    "controllerBackup",
    "controllerLabel",
    "createdAt",
    "nonce",
    "operation",
    "outerTransaction",
    "phase",
    "revision",
    "schemaVersion",
    "watchdogBackup",
    "watchdogLabel",
  ];
  if (
    !hasExactKeys(value, keys) ||
    value.schemaVersion !== 1 ||
    value.operation !== "freeze-stable-services" ||
    value.phase !== "frozen" ||
    value.controllerLabel !== options.label ||
    value.watchdogLabel !== watchdogLabel ||
    value.revision !== 0 ||
    !UUID_PATTERN.test(value.nonce) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw migrationJournalError("stable service freeze journal is invalid");
  }
  return {
    ...value,
    outerTransaction: validateOuterTransaction(value.outerTransaction),
    controllerBackup: validateJournalBackup(
      value.controllerBackup,
      controllerPlistPath,
      "controllerBackup",
    ),
    watchdogBackup: validateJournalBackup(
      value.watchdogBackup,
      watchdogPlistPath,
      "watchdogBackup",
    ),
  };
}

async function readFreezeJournal(options, path, identity, { allowMissing = false } = {}) {
  let snapshot;
  try {
    snapshot = await snapshotFile(options.fs, path, {
      required: !allowMissing,
      maxBytes: MIGRATION_JOURNAL_MAX_BYTES,
    });
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
  if (snapshot === null) return null;
  if (snapshot.mode !== 0o600) {
    throw migrationJournalError("stable service freeze journal mode must be 0600");
  }
  let parsed;
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes);
    parsed = JSON.parse(decoded);
  } catch (cause) {
    throw migrationJournalError("stable service freeze journal is invalid JSON", cause);
  }
  if (decoded !== serializedJournal(parsed)) {
    throw migrationJournalError("stable service freeze journal is not canonical");
  }
  return {
    path,
    snapshot,
    journal: validateFreezeJournal(parsed, options, identity),
  };
}

function freezeDescriptor({
  outerTransaction,
  journalPath,
  controllerLabel,
  controllerPlistPath,
  watchdogLabel,
  watchdogPlistPath,
}) {
  return Object.freeze({
    schemaVersion: 1,
    operation: "freeze-stable-services",
    transactionId: outerTransaction.transactionId,
    coordinatorJournalPath: outerTransaction.journalPath,
    participantJournalPath: journalPath,
    controllerLabel,
    controllerPlistPath,
    watchdogLabel,
    watchdogPlistPath,
  });
}

function validateFreezeDescriptor(value) {
  const keys = [
    "controllerLabel",
    "controllerPlistPath",
    "coordinatorJournalPath",
    "operation",
    "participantJournalPath",
    "schemaVersion",
    "transactionId",
    "watchdogLabel",
    "watchdogPlistPath",
  ];
  if (
    !hasExactKeys(value, keys) ||
    value.schemaVersion !== 1 ||
    value.operation !== "freeze-stable-services" ||
    !UUID_PATTERN.test(value.transactionId)
  ) {
    throw new Error("stable service freeze descriptor is invalid");
  }
  assertLabel(value.controllerLabel);
  assertLabel(value.watchdogLabel);
  for (const [field, path] of [
    ["controllerPlistPath", value.controllerPlistPath],
    ["coordinatorJournalPath", value.coordinatorJournalPath],
    ["participantJournalPath", value.participantJournalPath],
    ["watchdogPlistPath", value.watchdogPlistPath],
  ]) {
    assertAbsolutePath(path, field);
    if (resolve(path) !== path) throw new Error(`${field} must be canonical`);
  }
  return value;
}

async function freezeRuntimeContext(input, descriptor = null) {
  const options = normalizedOptions(input);
  assertMutationLabel(options.label, options.testMode === true);
  assertProductionLocations(options);
  const watchdogLabel = descriptor?.watchdogLabel ?? input.oldLabel ?? LEGACY_WATCHDOG_LABEL;
  assertLegacyMutationLabel(watchdogLabel, options.testMode === true);
  launchDomain(options);
  options.stateCapability = await ensurePrivateDirectory(options.fs, options.stateDir);
  await ensureDirectory(options.fs, options.launchAgentsDir);
  await assertCanonicalDirectory(options.fs, options.launchAgentsDir);
  options.launchAgentsCapability = await captureDirectoryCapability(
    options.fs,
    options.launchAgentsDir,
    "LAUNCH_AGENTS_PATH_UNTRUSTED",
  );
  const controllerPlistPath = options.plistPath;
  const watchdogPlistPath = input.oldPlistPath ?? join(
    options.launchAgentsDir,
    `${watchdogLabel}.plist`,
  );
  const journalPath = input.freezeJournalPath ?? join(options.stateDir, "stable-service-freeze.json");
  if (descriptor !== null && (
    descriptor.controllerLabel !== options.label ||
    descriptor.controllerPlistPath !== controllerPlistPath ||
    descriptor.watchdogPlistPath !== watchdogPlistPath ||
    descriptor.participantJournalPath !== journalPath
  )) {
    throw new Error("stable service freeze descriptor does not match canonical runtime paths");
  }
  return {
    options,
    watchdogLabel,
    watchdogPlistPath,
    controllerPlistPath,
    journalPath,
  };
}

export async function createStableServiceFreezeDescriptor(input = {}) {
  const outerTransaction = validateOuterTransaction(input.outerTransaction);
  const context = await freezeRuntimeContext(input);
  return freezeDescriptor({
    outerTransaction,
    journalPath: context.journalPath,
    controllerLabel: context.options.label,
    controllerPlistPath: context.controllerPlistPath,
    watchdogLabel: context.watchdogLabel,
    watchdogPlistPath: context.watchdogPlistPath,
  });
}

export async function prepareStableServiceFreeze(input = {}) {
  const outerTransaction = validateOuterTransaction(input.outerTransaction);
  const context = await freezeRuntimeContext(input);
  const {
    options,
    watchdogLabel,
    watchdogPlistPath,
    controllerPlistPath,
    journalPath,
  } = context;
  const controllerSnapshot = await snapshotFile(options.fs, controllerPlistPath);
  const controllerJob = await inspectLoadedJob(options, options.label);
  if (controllerJob.loaded && controllerSnapshot === null) {
    throw new Error("loaded controller has no canonical plist to freeze");
  }
  if (controllerSnapshot !== null) {
    const programArguments = await resolveProgramArguments(options);
    const plist = await readPlistSnapshot(options, controllerPlistPath, controllerSnapshot);
    await assertMigrationControllerPlistAttribution(options, plist, programArguments);
  }

  const watchdogSnapshot = await snapshotFile(options.fs, watchdogPlistPath);
  const watchdogJob = await inspectLoadedJob(options, watchdogLabel);
  if (watchdogJob.loaded && watchdogSnapshot === null) {
    throw new Error("loaded legacy watchdog has no canonical plist to freeze");
  }
  if (watchdogSnapshot !== null) {
    const plist = await readPlistSnapshot(options, watchdogPlistPath, watchdogSnapshot);
    await assertLegacyAttribution(options, watchdogPlistPath, plist, watchdogLabel);
  }
  if (controllerSnapshot === null && watchdogSnapshot === null) {
    return { servicesFound: false, servicesFrozen: 0, transaction: null };
  }
  await assertSnapshotCurrent(options.fs, controllerPlistPath, controllerSnapshot);
  await assertSnapshotCurrent(options.fs, watchdogPlistPath, watchdogSnapshot);
  const journal = {
    schemaVersion: 1,
    operation: "freeze-stable-services",
    phase: "frozen",
    createdAt: new Date().toISOString(),
    outerTransaction,
    controllerLabel: options.label,
    watchdogLabel,
    controllerBackup: recoveryBackup(
      controllerPlistPath,
      controllerSnapshot,
      controllerJob.loaded,
    ),
    watchdogBackup: recoveryBackup(
      watchdogPlistPath,
      watchdogSnapshot,
      watchdogJob.loaded,
    ),
  };
  const transaction = await createMigrationJournal(options, journalPath, journal);
  const frozen = [];
  try {
    if (options.hardCrashAt === "after-freeze-journal") {
      throw injectedHardCrash("after-freeze-journal");
    }
    for (const service of [
      { label: options.label, path: controllerPlistPath, snapshot: controllerSnapshot, job: controllerJob },
      { label: watchdogLabel, path: watchdogPlistPath, snapshot: watchdogSnapshot, job: watchdogJob },
    ]) {
      await assertSnapshotCurrent(options.fs, service.path, service.snapshot);
      if (service.job.loaded) {
        await bootout(options, service.label, { knownLoaded: true });
        await waitForFrozenPidExit(options, service.job.pid);
        frozen.push(service);
      }
      if ((await inspectLoadedJob(options, service.label)).loaded) {
        throw new Error(`LaunchAgent ${service.label} was not frozen`);
      }
      const phase = service.label === options.label
        ? "after-controller-freeze"
        : "after-watchdog-freeze";
      if (options.hardCrashAt === phase) throw injectedHardCrash(phase);
      inject(options, phase);
    }
    return {
      servicesFound: true,
      servicesFrozen: frozen.length,
      transaction: freezeDescriptor({
        outerTransaction,
        journalPath,
        controllerLabel: options.label,
        controllerPlistPath,
        watchdogLabel,
        watchdogPlistPath,
      }),
    };
  } catch (primaryError) {
    if (primaryError?.simulatedHardCrash === true) throw primaryError;
    const rollbackErrors = [];
    for (const service of [...frozen].reverse()) {
      await bootstrap(options, service.label, service.path).catch((error) => rollbackErrors.push(error));
    }
    if (rollbackErrors.length === 0) {
      await removeMigrationJournal(options, transaction).catch((error) => rollbackErrors.push(error));
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...rollbackErrors],
        "stable service freeze failed and rollback did not finish",
      );
    }
    throw primaryError;
  }
}

async function reconstructFreeze(transaction, input) {
  const descriptor = validateFreezeDescriptor(transaction);
  const context = await freezeRuntimeContext(input, descriptor);
  const journalTransaction = await readFreezeJournal(context.options, context.journalPath, {
    controllerPlistPath: context.controllerPlistPath,
    watchdogLabel: context.watchdogLabel,
    watchdogPlistPath: context.watchdogPlistPath,
  }, { allowMissing: true });
  if (journalTransaction !== null && (
    journalTransaction.journal.outerTransaction.transactionId !== descriptor.transactionId ||
    journalTransaction.journal.outerTransaction.journalPath !== descriptor.coordinatorJournalPath
  )) {
    throw new Error("stable service freeze descriptor does not match its journal");
  }
  return { descriptor, context, journalTransaction };
}

export async function rollbackStableServiceFreeze(transaction, input = {}) {
  const { descriptor, context, journalTransaction } = await reconstructFreeze(transaction, input);
  const outerDecision = await readOuterTransactionDecision(context.options, {
    transactionId: descriptor.transactionId,
    journalPath: descriptor.coordinatorJournalPath,
  });
  if (outerDecision === "commit") {
    throw new Error("stable service freeze cannot roll back after outer commit");
  }
  if (journalTransaction === null) return { rolledBack: false };
  const services = [
    {
      label: descriptor.controllerLabel,
      path: descriptor.controllerPlistPath,
      backup: journalTransaction.journal.controllerBackup,
    },
    {
      label: descriptor.watchdogLabel,
      path: descriptor.watchdogPlistPath,
      backup: journalTransaction.journal.watchdogBackup,
    },
  ];
  for (const service of services) {
    const snapshot = await snapshotFile(context.options.fs, service.path);
    const accepted = service.backup.existed
      ? [{ bytes: service.backup.bytes, mode: service.backup.mode }]
      : [];
    assertRecoveryPathState(service.path, snapshot, accepted);
    const current = await inspectLoadedJob(context.options, service.label);
    if (service.backup.loaded && !current.loaded) {
      await bootstrap(context.options, service.label, service.path);
    } else if (!service.backup.loaded && current.loaded) {
      await bootout(context.options, service.label, { knownLoaded: true });
      await waitForFrozenPidExit(context.options, current.pid);
    }
    if ((await isLoaded(context.options, service.label)) !== service.backup.loaded) {
      throw new Error(`stable service ${service.label} prestate was not restored`);
    }
  }
  await removeMigrationJournal(context.options, journalTransaction);
  return { rolledBack: true };
}

export async function finalizeStableServiceFreeze(transaction, input = {}) {
  const { descriptor, context, journalTransaction } = await reconstructFreeze(transaction, input);
  const outerDecision = await readOuterTransactionDecision(context.options, {
    transactionId: descriptor.transactionId,
    journalPath: descriptor.coordinatorJournalPath,
  });
  if (outerDecision !== "commit") {
    throw new Error("stable service freeze cannot finalize before outer commit");
  }
  if (journalTransaction !== null) {
    await removeMigrationJournal(context.options, journalTransaction);
  }
  return { committed: true };
}

export async function recoverLegacyWatchdogMigration(input = {}) {
  const options = normalizedOptions(input);
  assertMutationLabel(options.label, options.testMode === true);
  assertProductionLocations(options);
  const oldLabel = input.oldLabel ?? LEGACY_WATCHDOG_LABEL;
  assertLegacyMutationLabel(oldLabel, options.testMode === true);
  launchDomain(options);
  options.stateCapability = await ensurePrivateDirectory(options.fs, options.stateDir);
  await ensureDirectory(options.fs, options.launchAgentsDir);
  await assertCanonicalDirectory(options.fs, options.launchAgentsDir);
  options.launchAgentsCapability = await captureDirectoryCapability(
    options.fs,
    options.launchAgentsDir,
    "LAUNCH_AGENTS_PATH_UNTRUSTED",
  );
  const oldPlistPath = input.oldPlistPath ?? join(
    options.home,
    "Library",
    "LaunchAgents",
    `${oldLabel}.plist`,
  );
  const journalPath = input.journalPath ?? join(options.stateDir, "launch-agent-migration.json");
  return recoverMigrationJournal(options, {
    journalPath,
    oldLabel,
    oldPlistPath,
  });
}

export async function migrateLegacyWatchdog(input = {}) {
  const options = normalizedOptions(input);
  if (input.deferCommit !== undefined && typeof input.deferCommit !== "boolean") {
    throw new TypeError("deferCommit must be boolean");
  }
  const deferCommit = input.deferCommit === true;
  const outerTransaction = deferCommit
    ? validateOuterTransaction(input.outerTransaction)
    : null;
  if (!deferCommit && input.outerTransaction !== undefined) {
    throw new Error("outerTransaction requires deferCommit");
  }
  assertMutationLabel(options.label, options.testMode === true);
  assertProductionLocations(options);
  const oldLabel = input.oldLabel ?? LEGACY_WATCHDOG_LABEL;
  assertLegacyMutationLabel(oldLabel, options.testMode === true);
  launchDomain(options);
  options.stateCapability = await ensurePrivateDirectory(options.fs, options.stateDir);
  await ensureDirectory(options.fs, options.launchAgentsDir);
  await assertCanonicalDirectory(options.fs, options.launchAgentsDir);
  options.launchAgentsCapability = await captureDirectoryCapability(
    options.fs,
    options.launchAgentsDir,
    "LAUNCH_AGENTS_PATH_UNTRUSTED",
  );

  const oldPlistPath = input.oldPlistPath ?? join(
    options.home,
    "Library",
    "LaunchAgents",
    `${oldLabel}.plist`,
  );
  const journalPath = input.journalPath ?? join(options.stateDir, "launch-agent-migration.json");
  await recoverMigrationJournal(options, {
    journalPath,
    oldLabel,
    oldPlistPath,
  });
  const oldSnapshot = await snapshotFile(options.fs, oldPlistPath);
  const oldLoaded = await isLoaded(options, oldLabel);
  if (!oldSnapshot) {
    if (oldLoaded) {
      const error = new Error("loaded legacy watchdog has no canonical plist snapshot");
      error.code = "LEGACY_PRESTATE_INVALID";
      throw error;
    }
    const result = {
      legacyFound: false,
      legacyRemoved: false,
      controllerRegistered: false,
    };
    return deferCommit
      ? { ...result, legacyLoadedBefore: false, transaction: null }
      : result;
  }
  const oldPlist = await readPlistSnapshot(options, oldPlistPath, oldSnapshot);
  await assertLegacyAttribution(options, oldPlistPath, oldPlist, oldLabel);
  const programArguments = await resolveProgramArguments(options);
  const newSnapshot = await snapshotFile(options.fs, options.plistPath);
  const newLoadedBefore = await isLoaded(options, options.label);
  if (newLoadedBefore && !newSnapshot) {
    const error = new Error("loaded controller has no canonical plist snapshot");
    error.code = "CONTROLLER_PRESTATE_INVALID";
    throw error;
  }
  if (newSnapshot) {
    const newPlist = await readPlistSnapshot(options, options.plistPath, newSnapshot);
    await assertMigrationControllerPlistAttribution(options, newPlist, programArguments);
  }
  await assertSnapshotCurrent(options.fs, oldPlistPath, oldSnapshot);
  await assertSnapshotCurrent(options.fs, options.plistPath, newSnapshot);
  const stagedPath = `${options.plistPath}.staged.${randomUUID()}`;
  let stagedSnapshot;
  let newPublishedTransaction;
  let oldDetached;
  let canonicalMutationStarted = false;
  const plist = renderControllerPlist({
    label: options.label,
    programArguments,
    stateDir: options.stateDir,
  });
  const plistBytes = Buffer.from(plist);
  const journal = {
    schemaVersion: 2,
    operation: "migrate-legacy-watchdog",
    phase: "prepared",
    createdAt: new Date().toISOString(),
    oldLabel,
    newLabel: options.label,
    ...(outerTransaction === null ? {} : { outerTransaction }),
    oldBackup: recoveryBackup(oldPlistPath, oldSnapshot, oldLoaded),
    newBackup: recoveryBackup(options.plistPath, newSnapshot, newLoadedBefore),
    forward: {
      plistPath: options.plistPath,
      stagedPath,
      programArguments: [...programArguments],
      bytesBase64: plistBytes.toString("base64"),
      sha256: createHash("sha256").update(plistBytes).digest("hex"),
    },
  };

  const journalTransaction = await createMigrationJournal(options, journalPath, journal);
  try {
    await advanceMigration(options, journalTransaction, "after-journal");
    await atomicWrite(options.fs, stagedPath, plist, 0o600);
    stagedSnapshot = await snapshotFile(options.fs, stagedPath, { required: true });
    await advanceMigration(options, journalTransaction, "after-new-stage");
    await assertSnapshotCurrent(options.fs, stagedPath, stagedSnapshot);
    await lintPlist(options, stagedPath);
    await assertSnapshotCurrent(options.fs, stagedPath, stagedSnapshot);
    await advanceMigration(options, journalTransaction, "after-new-lint");
    await assertSnapshotCurrent(options.fs, options.plistPath, newSnapshot);
    await assertLoadedPrestate(options, options.label, newLoadedBefore);
    await assertLoadedPrestate(options, oldLabel, oldLoaded);
    await assertSnapshotCurrent(options.fs, options.plistPath, newSnapshot);
    await assertSnapshotCurrent(options.fs, oldPlistPath, oldSnapshot);
    if (newLoadedBefore) {
      await assertLoadedPrestate(options, options.label, true);
      await bootout(options, options.label);
      canonicalMutationStarted = true;
      await advanceMigration(options, journalTransaction, "after-existing-new-bootout");
    }
    await assertDirectoryCapability(options.fs, options.launchAgentsCapability);
    newPublishedTransaction = await publishStagedPlist(
      options,
      stagedPath,
      options.plistPath,
      stagedSnapshot,
      newSnapshot,
    );
    await assertDirectoryCapability(options.fs, options.launchAgentsCapability);
    canonicalMutationStarted = true;
    await advanceMigration(options, journalTransaction, "after-new-publish");
    await command(options, "/bin/launchctl", [
      "bootstrap",
      launchDomain(options),
      options.plistPath,
    ]);
    canonicalMutationStarted = true;
    await advanceMigration(options, journalTransaction, "after-new-bootstrap");
    if (!(await isLoaded(options, options.label))) {
      throw new Error("new controller failed launchctl verification");
    }
    await advanceMigration(options, journalTransaction, "after-new-verify");

    if (deferCommit) {
      await advanceMigration(options, journalTransaction, "awaiting-outer-commit");
      const transaction = Object.freeze({
        schemaVersion: 1,
        operation: "migrate-legacy-watchdog",
        transactionId: outerTransaction.transactionId,
        coordinatorJournalPath: outerTransaction.journalPath,
        participantJournalPath: journalPath,
        oldLabel,
        newLabel: options.label,
        oldPlistPath,
        newPlistPath: options.plistPath,
      });
      DEFERRED_MIGRATIONS.set(transaction, {
        options,
        journalTransaction,
        stagedPath,
        oldPlistPath,
        oldSnapshot,
        oldLoaded,
        oldLabel,
        newSnapshot,
        newLoadedBefore,
        newPublishedTransaction,
        oldDetached: null,
        stagedSnapshot,
      });
      return {
        legacyFound: true,
        legacyRemoved: false,
        controllerRegistered: true,
        legacyLoadedBefore: oldLoaded,
        transaction,
      };
    }

    await assertSnapshotCurrent(options.fs, oldPlistPath, oldSnapshot);
    await assertLoadedPrestate(options, oldLabel, oldLoaded);
    if (oldLoaded) {
      await command(options, "/bin/launchctl", [
        "bootout",
        launchTarget(options, oldLabel),
      ]);
      canonicalMutationStarted = true;
    }
    await advanceMigration(options, journalTransaction, "after-old-bootout");
    if (await isLoaded(options, oldLabel)) {
      throw new Error("legacy watchdog remained loaded after bootout");
    }
    await advanceMigration(options, journalTransaction, "after-old-verify");
    await assertDirectoryCapability(options.fs, options.launchAgentsCapability);
    await assertSnapshotCurrent(options.fs, oldPlistPath, oldSnapshot);
    oldDetached = await detachSnapshotPath(options.fs, oldPlistPath, oldSnapshot);
    await assertDirectoryCapability(options.fs, options.launchAgentsCapability);
    canonicalMutationStarted = true;
    await advanceMigration(options, journalTransaction, "after-old-remove");
    await deleteDetachedPath(options.fs, oldDetached);
    oldDetached = null;
    await commitPublishedPath(options.fs, newPublishedTransaction);
    await removeMigrationJournal(options, journalTransaction);
    return {
      legacyFound: true,
      legacyRemoved: true,
      controllerRegistered: true,
    };
  } catch (primaryError) {
    if (primaryError?.simulatedHardCrash === true) throw primaryError;
    if (primaryError?.code === "MIGRATION_PRESTATE_CHANGED" && !canonicalMutationStarted) {
      if (stagedSnapshot) {
        await removeSnapshotPath(options.fs, stagedPath, stagedSnapshot).catch(() => {});
      }
      await removeMigrationJournal(options, journalTransaction);
      throw primaryError;
    }
    if (primaryError?.code === "JOURNAL_CONFLICT" && !canonicalMutationStarted) {
      if (stagedSnapshot) {
        await removeSnapshotPath(options.fs, stagedPath, stagedSnapshot).catch(() => {});
      }
      throw primaryError;
    }
    const rollbackError = await rollbackMigration({
      options,
      primaryError,
      journalTransaction,
      stagedPath,
      oldPlistPath,
      oldSnapshot,
      oldLoaded,
      oldLabel,
      newSnapshot,
      newLoadedBefore,
      newPublishedTransaction,
      oldDetached,
      stagedSnapshot,
    });
    if (rollbackError) throw rollbackError;
    throw primaryError;
  }
}

function validateMigrationDescriptor(value) {
  const keys = [
    "coordinatorJournalPath",
    "newLabel",
    "newPlistPath",
    "oldLabel",
    "oldPlistPath",
    "operation",
    "participantJournalPath",
    "schemaVersion",
    "transactionId",
  ];
  if (
    !hasExactKeys(value, keys) ||
    value.schemaVersion !== 1 ||
    value.operation !== "migrate-legacy-watchdog" ||
    !UUID_PATTERN.test(value.transactionId)
  ) {
    throw new Error("legacy migration descriptor is invalid");
  }
  for (const [field, path] of [
    ["coordinatorJournalPath", value.coordinatorJournalPath],
    ["participantJournalPath", value.participantJournalPath],
    ["oldPlistPath", value.oldPlistPath],
    ["newPlistPath", value.newPlistPath],
  ]) {
    assertAbsolutePath(path, field);
    if (resolve(path) !== path) throw new Error(`${field} must be canonical`);
  }
  assertLabel(value.oldLabel);
  assertLabel(value.newLabel);
  return value;
}

async function reconstructDeferredMigrationContext(transaction, input) {
  const descriptor = validateMigrationDescriptor(transaction);
  const active = DEFERRED_MIGRATIONS.get(transaction);
  if (active) return active;
  const options = normalizedOptions(input);
  assertMutationLabel(options.label, options.testMode === true);
  assertProductionLocations(options);
  assertLegacyMutationLabel(descriptor.oldLabel, options.testMode === true);
  if (
    descriptor.newLabel !== options.label ||
    descriptor.newPlistPath !== options.plistPath ||
    descriptor.oldPlistPath !== join(options.launchAgentsDir, `${descriptor.oldLabel}.plist`) ||
    descriptor.participantJournalPath !== join(options.stateDir, "launch-agent-migration.json")
  ) {
    throw new Error("legacy migration descriptor does not match canonical runtime paths");
  }
  options.stateCapability = await ensurePrivateDirectory(options.fs, options.stateDir);
  await ensureDirectory(options.fs, options.launchAgentsDir);
  await assertCanonicalDirectory(options.fs, options.launchAgentsDir);
  options.launchAgentsCapability = await captureDirectoryCapability(
    options.fs,
    options.launchAgentsDir,
    "LAUNCH_AGENTS_PATH_UNTRUSTED",
  );
  const journalTransaction = await readMigrationJournal(
    options,
    descriptor.participantJournalPath,
    { oldLabel: descriptor.oldLabel, oldPlistPath: descriptor.oldPlistPath },
  );
  const expectedOuter = {
    transactionId: descriptor.transactionId,
    journalPath: descriptor.coordinatorJournalPath,
  };
  if (
    journalTransaction.journal.outerTransaction?.transactionId !== expectedOuter.transactionId ||
    journalTransaction.journal.outerTransaction?.journalPath !== expectedOuter.journalPath
  ) {
    throw new Error("legacy migration descriptor does not match its participant journal");
  }
  return {
    options,
    journalTransaction,
    oldPlistPath: descriptor.oldPlistPath,
    oldLoaded: journalTransaction.journal.oldBackup.loaded,
    oldLabel: descriptor.oldLabel,
    newPublishedTransaction: null,
    oldDetached: null,
  };
}

export async function finalizeLegacyWatchdogMigration(transaction, input = {}) {
  const context = await reconstructDeferredMigrationContext(transaction, input);
  const {
    options,
    journalTransaction,
    newPublishedTransaction,
    oldPlistPath,
    oldLoaded,
    oldLabel,
  } = context;
  const outerDecision = await readOuterTransactionDecision(
    options,
    journalTransaction.journal.outerTransaction,
  );
  if (
    journalTransaction.journal.phase !== "outer-commit-decided" &&
    outerDecision !== "commit"
  ) {
    throw new Error("legacy migration cannot finalize before the durable outer commit decision");
  }
  await advanceMigration(options, journalTransaction, "outer-commit-decided");
  const oldSnapshot = await snapshotFile(options.fs, oldPlistPath);
  const oldBackup = journalTransaction.journal.oldBackup;
  const oldBackupBytes = oldBackup.bytes ?? (oldBackup.existed
    ? decodeJournalBytes(oldBackup.bytesBase64, "oldBackup.bytesBase64")
    : null);
  assertRecoveryPathState(
    oldPlistPath,
    oldSnapshot,
    oldBackup.existed ? [{ bytes: oldBackupBytes, mode: oldBackup.mode }] : [],
  );
  await assertSnapshotCurrent(options.fs, oldPlistPath, oldSnapshot);
  await assertLoadedPrestate(options, oldLabel, oldLoaded);
  if (oldLoaded) {
    await bootout(options, oldLabel, { knownLoaded: true });
  }
  if (await isLoaded(options, oldLabel)) {
    throw new Error("legacy watchdog remained loaded after outer commit decision");
  }
  const oldDetached = await detachSnapshotPath(options.fs, oldPlistPath, oldSnapshot);
  await deleteDetachedPath(options.fs, oldDetached);
  await commitPublishedPath(options.fs, newPublishedTransaction);
  await removeMigrationJournal(options, journalTransaction);
  DEFERRED_MIGRATIONS.delete(transaction);
  return { committed: true };
}

export async function rollbackLegacyWatchdogMigration(transaction, input = {}) {
  const context = await reconstructDeferredMigrationContext(transaction, input);
  const {
    options,
    journalTransaction,
    oldLabel,
    oldPlistPath,
    newPublishedTransaction,
    oldDetached,
  } = context;
  if (journalTransaction.journal.phase === "outer-commit-decided") {
    throw new Error("legacy migration already has a durable outer commit decision");
  }
  const outerDecision = await readOuterTransactionDecision(
    options,
    journalTransaction.journal.outerTransaction,
  );
  if (outerDecision === "commit") {
    throw new Error("legacy migration cannot roll back after the durable outer commit decision");
  }
  const recovered = await recoverMigrationJournal(options, {
    journalPath: journalTransaction.path,
    oldLabel,
    oldPlistPath,
  });
  if (recovered.recovered !== true) {
    throw new Error("legacy migration rollback journal disappeared before recovery");
  }
  const cleanupErrors = [];
  await deleteDetachedPath(options.fs, oldDetached).catch((error) => cleanupErrors.push(error));
  await commitPublishedPath(options.fs, newPublishedTransaction).catch((error) => {
    cleanupErrors.push(error);
  });
  DEFERRED_MIGRATIONS.delete(transaction);
  if (cleanupErrors.length > 0) {
    const error = new AggregateError(cleanupErrors, "legacy migration rolled back but backup cleanup failed");
    error.code = "MIGRATION_BACKUP_CLEANUP_FAILED";
    throw error;
  }
  return { rolledBack: true };
}
