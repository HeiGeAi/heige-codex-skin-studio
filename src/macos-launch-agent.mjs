import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCallback);

export const CONTROLLER_LAUNCH_AGENT_LABEL = "com.heige.codex-skin-controller";
export const LEGACY_WATCHDOG_LABEL = "com.heige.codex-skin-watchdog";

const TEST_LABEL_PREFIX = `${CONTROLLER_LAUNCH_AGENT_LABEL}.test.`;
const LEGACY_TEST_LABEL_PREFIX = `${LEGACY_WATCHDOG_LABEL}.test.`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NOT_FOUND_CODES = new Set([3, 113, "3", "113"]);
const PLIST_BACKUP_MAX_BYTES = 256 * 1024;
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
  "rollbackFaultAt",
  "journalPath",
  "oldPlistPath",
];

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

async function resolveStableRuntime(options) {
  if (!options.runtimePathsExplicit) {
    throw new Error("production registration requires explicit trusted nodePath and controllerPath");
  }
  assertAbsolutePath(options.nodePath, "nodePath");
  assertAbsolutePath(options.controllerPath, "controllerPath");
  assertAbsolutePath(options.stableInstallRoot, "stableInstallRoot");

  const expectedController = resolve(join(options.stableInstallRoot, "src", "cli.mjs"));
  if (resolve(options.controllerPath) !== expectedController) {
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

  const controllerInfo = await options.fs.lstat(options.controllerPath);
  if (controllerInfo.isSymbolicLink() || !controllerInfo.isFile()) {
    throw new Error("stable controller entrypoint must be a regular file");
  }
  const realController = await options.fs.realpath(options.controllerPath);
  if (realController !== join(realRoot, "src", "cli.mjs")) {
    throw new Error("production LaunchAgent must use the stable controller entrypoint");
  }

  const realNode = await options.fs.realpath(options.nodePath);
  const nodeInfo = await options.fs.lstat(realNode);
  if (!nodeInfo.isFile() || (nodeInfo.mode & 0o111) === 0) {
    throw new Error("nodePath must resolve to a regular executable");
  }
  if (!options.testMode && isTemporaryPath(realNode)) {
    throw new Error("nodePath must resolve to a stable non-temporary executable");
  }
  const { stdout } = await command(options, realNode, ["--version"]);
  const version = /^v(\d+)\.(\d+)\.(\d+)\s*$/.exec(String(stdout));
  if (!version || Number(version[1]) < 22) {
    throw new Error("controller runtime requires Node 22 or newer");
  }
  return { nodePath: realNode, controllerPath: realController };
}

async function resolveProgramArguments(options) {
  const explicit = options.programArguments;
  if (explicit !== undefined) {
    validateProgramArguments(explicit);
    if (!options.testMode) {
      throw new Error("production LaunchAgent must use the stable controller entrypoint");
    }
    return [...explicit];
  }
  const runtime = await resolveStableRuntime(options);
  return [runtime.nodePath, runtime.controllerPath, "controller"];
}

function normalizedOptions(options = {}) {
  assertProductionPlatformIsNotInjected(options);
  const testMode = options.testMode === true;
  const home = testMode ? (options.home ?? homedir()) : homedir();
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
  };
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

function isLaunchctlNotFound(error, options, label) {
  if (!NOT_FOUND_CODES.has(error?.code)) return false;
  const expected = `Could not find service "${label}" in domain for user gui: ${options.processUid}`;
  return `${error?.message ?? ""}\n${error?.stderr ?? ""}`
    .replaceAll("\r\n", "\n")
    .split("\n")
    .some((line) => line.trim() === expected);
}

async function isLoaded(options, label = options.label) {
  try {
    await command(options, "/bin/launchctl", ["print", launchTarget(options, label)]);
    return true;
  } catch (error) {
    if (isLaunchctlNotFound(error, options, label)) return false;
    throw error;
  }
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

async function ensurePrivateDirectory(fs, path) {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`private state path is not a real directory: ${path}`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`private state directory has a different owner: ${path}`);
  }
  await fs.chmod(path, 0o700);
  const secured = await fs.lstat(path);
  if ((secured.mode & 0o777) !== 0o700) {
    throw new Error(`private state directory mode is not 0700: ${path}`);
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
  try {
    handle = await fs.open(temporaryPath, "wx", mode);
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, path);
    await syncDirectory(fs, parent);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
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

async function removeAndSync(fs, path) {
  try {
    await fs.rm(path);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  await syncDirectory(fs, dirname(path));
  return true;
}

function fileChangedError(path) {
  const error = new Error(`file changed during validation: ${path}`);
  error.code = "FILE_CHANGED_DURING_VALIDATION";
  return error;
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
  let stdout;
  try {
    await exclusiveWrite(options.fs, immutablePath, snapshot.bytes, 0o600);
    const immutableSnapshot = await snapshotFile(options.fs, immutablePath, { required: true });
    ({ stdout } = await command(options, "/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      immutablePath,
    ]));
    await assertSnapshotCurrent(options.fs, immutablePath, immutableSnapshot);
  } finally {
    await removeAndSync(options.fs, immutablePath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
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

function assertControllerPlistAttribution(options, plist, programArguments) {
  const expectedStdout = join(options.stateDir, "controller.log");
  const expectedStderr = join(options.stateDir, "controller.error.log");
  const matchesArguments = Array.isArray(plist.ProgramArguments) &&
    plist.ProgramArguments.length === programArguments.length &&
    plist.ProgramArguments.every((value, index) => value === programArguments[index]);
  if (
    plist.Label !== options.label ||
    !matchesArguments ||
    plist.RunAtLoad !== true ||
    plist.KeepAlive?.SuccessfulExit !== false ||
    plist.ProcessType !== "Background" ||
    plist.StandardOutPath !== expectedStdout ||
    plist.StandardErrorPath !== expectedStderr
  ) {
    const error = new Error("existing controller plist attribution failed");
    error.code = "CONTROLLER_PRESTATE_INVALID";
    throw error;
  }
}

function injectedFailure(phase) {
  const error = new Error(`INJECTED_MIGRATION_FAILURE at ${phase}`);
  error.code = "INJECTED_MIGRATION_FAILURE";
  error.phase = phase;
  return error;
}

function inject(options, phase, { rollback = false } = {}) {
  const selected = rollback ? options.rollbackFaultAt : options.faultAt;
  if (selected === phase) throw injectedFailure(phase);
}

async function writeJournal(options, journalPath, journal) {
  await atomicWrite(
    options.fs,
    journalPath,
    `${JSON.stringify(journal, null, 2)}\n`,
    0o600,
  );
}

async function createMigrationJournal(options, journalPath, journal) {
  try {
    await exclusiveWrite(
      options.fs,
      journalPath,
      `${JSON.stringify(journal, null, 2)}\n`,
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
  if (args[1]?.includes(sep)) assertAbsolutePath(args[1], "ProgramArguments[1]");

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

async function restoreRegistration(options, snapshot, loadedBefore, rollbackErrors) {
  try {
    if (await isLoaded(options)) await bootout(options, options.label);
  } catch (error) {
    rollbackErrors.push(error);
  }
  try {
    if (snapshot) {
      await atomicWrite(options.fs, options.plistPath, snapshot.bytes, snapshot.mode);
    } else {
      await removeAndSync(options.fs, options.plistPath);
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
  await ensurePrivateDirectory(options.fs, options.stateDir);
  await ensureDirectory(options.fs, options.launchAgentsDir);
  await assertCanonicalDirectory(options.fs, options.launchAgentsDir);

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
  const stagedPath = `${options.plistPath}.staged.${randomUUID()}`;
  let stagedSnapshot;

  await assertSnapshotCurrent(options.fs, options.plistPath, previous);
  try {
    await atomicWrite(options.fs, stagedPath, plist, 0o600);
    stagedSnapshot = await snapshotFile(options.fs, stagedPath, { required: true });
    await lintPlist(options, stagedPath);
    await assertSnapshotCurrent(options.fs, stagedPath, stagedSnapshot);
  } catch (error) {
    await options.fs.rm(stagedPath, { force: true }).catch(() => {});
    throw error;
  }

  try {
    if (loadedBefore) await bootout(options, options.label);
    await publishStagedPlist(options, stagedPath, options.plistPath, stagedSnapshot);
    await bootstrap(options, options.label, options.plistPath);
  } catch (primaryError) {
    const rollbackErrors = [];
    await restoreRegistration(options, previous, loadedBefore, rollbackErrors);
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
    await options.fs.rm(stagedPath, { force: true }).catch(() => {});
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
  await assertSnapshotCurrent(options.fs, options.plistPath, snapshot);
  if (loaded) {
    await bootout(options, options.label, { knownLoaded: true });
  }
  await assertSnapshotCurrent(options.fs, options.plistPath, snapshot);
  const removed = snapshot ? await removeAndSync(options.fs, options.plistPath) : false;
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
  const allowedRoots = [
    options.stableInstallRoot,
    ...(options.legacyRoots ?? []),
    ...(options.identifiedLegacyRoots ?? []),
  ].filter((value, index, values) => typeof value === "string" && values.indexOf(value) === index);
  if (!allowedRoots.some((root) => resolve(root) === resolve(scriptRoot)) || isTemporaryPath(scriptRoot)) {
    throw new Error("legacy attribution failed: executable root is not positively identified");
  }
  const scriptInfo = await options.fs.lstat(scriptPath);
  if (scriptInfo.isSymbolicLink() || !scriptInfo.isFile()) {
    throw new Error("legacy attribution failed: executable is not a regular file");
  }
  const actualScript = await options.fs.realpath(scriptPath);
  const approvedRealRoots = [];
  for (const root of allowedRoots) {
    try {
      approvedRealRoots.push(await options.fs.realpath(root));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (
    isTemporaryPath(actualScript) ||
    !approvedRealRoots.some((root) =>
      isWithin(root, actualScript) &&
      actualScript === join(root, "scripts", "lib", "skin-watchdog.zsh")
    )
  ) {
    throw new Error("legacy attribution failed: executable resolves outside its approved real root");
  }
}

async function advanceMigration(options, journalPath, journal, phase) {
  journal.phase = phase;
  await writeJournal(options, journalPath, journal);
  inject(options, phase);
}

async function publishStagedPlist(options, stagedPath, targetPath, stagedSnapshot) {
  await assertSnapshotCurrent(options.fs, stagedPath, stagedSnapshot);
  await options.fs.rename(stagedPath, targetPath);
  await syncDirectory(options.fs, dirname(targetPath));
}

async function rollbackMigration({
  options,
  primaryError,
  journal,
  journalPath,
  stagedPath,
  oldPlistPath,
  oldSnapshot,
  oldLoaded,
  oldLabel,
  newSnapshot,
  newLoadedBefore,
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
    if (newSnapshot) {
      await atomicWrite(options.fs, options.plistPath, newSnapshot.bytes, newSnapshot.mode);
    } else {
      await removeAndSync(options.fs, options.plistPath);
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
    await atomicWrite(options.fs, oldPlistPath, oldSnapshot.bytes, oldSnapshot.mode);
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
    await options.fs.rm(stagedPath, { force: true });
  });

  if (rollbackErrors.length === 0) {
    await attempt(async () => {
      inject(options, "before-journal-cleanup", { rollback: true });
      await removeAndSync(options.fs, journalPath);
    });
    if (rollbackErrors.length === 0) return null;
  }

  journal.phase = "rollback-failed";
  journal.primaryError = safeError(primaryError);
  journal.rollbackErrors = rollbackErrors.map(safeError);
  try {
    await writeJournal(options, journalPath, journal);
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

export async function migrateLegacyWatchdog(input = {}) {
  const options = normalizedOptions(input);
  assertMutationLabel(options.label, options.testMode === true);
  assertProductionLocations(options);
  const oldLabel = input.oldLabel ?? LEGACY_WATCHDOG_LABEL;
  assertLegacyMutationLabel(oldLabel, options.testMode === true);
  launchDomain(options);
  await ensurePrivateDirectory(options.fs, options.stateDir);
  await ensureDirectory(options.fs, options.launchAgentsDir);
  await assertCanonicalDirectory(options.fs, options.launchAgentsDir);

  const oldPlistPath = input.oldPlistPath ?? join(
    options.home,
    "Library",
    "LaunchAgents",
    `${LEGACY_WATCHDOG_LABEL}.plist`,
  );
  const oldSnapshot = await snapshotFile(options.fs, oldPlistPath);
  const oldLoaded = await isLoaded(options, oldLabel);
  if (!oldSnapshot) {
    if (oldLoaded) {
      const error = new Error("loaded legacy watchdog has no canonical plist snapshot");
      error.code = "LEGACY_PRESTATE_INVALID";
      throw error;
    }
    return {
      legacyFound: false,
      legacyRemoved: false,
      controllerRegistered: false,
    };
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
    assertControllerPlistAttribution(options, newPlist, programArguments);
  }
  await assertSnapshotCurrent(options.fs, oldPlistPath, oldSnapshot);
  await assertSnapshotCurrent(options.fs, options.plistPath, newSnapshot);
  const journalPath = input.journalPath ?? join(options.stateDir, "launch-agent-migration.json");
  const stagedPath = `${options.plistPath}.staged.${randomUUID()}`;
  let stagedSnapshot;
  const journal = {
    schemaVersion: 2,
    operation: "migrate-legacy-watchdog",
    phase: "prepared",
    createdAt: new Date().toISOString(),
    oldLabel,
    newLabel: options.label,
    oldBackup: recoveryBackup(oldPlistPath, oldSnapshot, oldLoaded),
    newBackup: recoveryBackup(options.plistPath, newSnapshot, newLoadedBefore),
  };
  const plist = renderControllerPlist({
    label: options.label,
    programArguments,
    stateDir: options.stateDir,
  });

  await createMigrationJournal(options, journalPath, journal);
  try {
    await advanceMigration(options, journalPath, journal, "after-journal");
    await atomicWrite(options.fs, stagedPath, plist, 0o600);
    stagedSnapshot = await snapshotFile(options.fs, stagedPath, { required: true });
    await advanceMigration(options, journalPath, journal, "after-new-stage");
    await assertSnapshotCurrent(options.fs, stagedPath, stagedSnapshot);
    await lintPlist(options, stagedPath);
    await assertSnapshotCurrent(options.fs, stagedPath, stagedSnapshot);
    await advanceMigration(options, journalPath, journal, "after-new-lint");
    await assertSnapshotCurrent(options.fs, options.plistPath, newSnapshot);
    if (newLoadedBefore) {
      await bootout(options, options.label);
      await advanceMigration(options, journalPath, journal, "after-existing-new-bootout");
    }
    await publishStagedPlist(options, stagedPath, options.plistPath, stagedSnapshot);
    await advanceMigration(options, journalPath, journal, "after-new-publish");
    await command(options, "/bin/launchctl", [
      "bootstrap",
      launchDomain(options),
      options.plistPath,
    ]);
    await advanceMigration(options, journalPath, journal, "after-new-bootstrap");
    if (!(await isLoaded(options, options.label))) {
      throw new Error("new controller failed launchctl verification");
    }
    await advanceMigration(options, journalPath, journal, "after-new-verify");

    await assertSnapshotCurrent(options.fs, oldPlistPath, oldSnapshot);
    if (oldLoaded) {
      await command(options, "/bin/launchctl", [
        "bootout",
        launchTarget(options, oldLabel),
      ]);
    }
    await advanceMigration(options, journalPath, journal, "after-old-bootout");
    if (await isLoaded(options, oldLabel)) {
      throw new Error("legacy watchdog remained loaded after bootout");
    }
    await advanceMigration(options, journalPath, journal, "after-old-verify");
    await assertSnapshotCurrent(options.fs, oldPlistPath, oldSnapshot);
    await removeAndSync(options.fs, oldPlistPath);
    await advanceMigration(options, journalPath, journal, "after-old-remove");
    await removeAndSync(options.fs, journalPath);
    return {
      legacyFound: true,
      legacyRemoved: true,
      controllerRegistered: true,
    };
  } catch (primaryError) {
    const rollbackError = await rollbackMigration({
      options,
      primaryError,
      journal,
      journalPath,
      stagedPath,
      oldPlistPath,
      oldSnapshot,
      oldLoaded,
      oldLabel,
      newSnapshot,
      newLoadedBefore,
    });
    if (rollbackError) throw rollbackError;
    throw primaryError;
  }
}
