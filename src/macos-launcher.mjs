import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { readProcessIdentity, sameProcessIdentity } from "./process-identity.mjs";

export const MACOS_LAUNCHER_NAME = "HeiGe 皮肤启动器";
export const MACOS_LAUNCHER_BUNDLE_ID = "com.heige.codex-skin-launcher";
export const MACOS_LAUNCHER_SCHEMA_VERSION = 4;
const EXECUTABLE_NAME = "HeiGe Skin Launcher";
const ICON_NAME = "AppIcon.icns";
const NATIVE_EXECUTABLE_ASSET = "HeiGeSkinLauncher.bin";
const LEGACY_SIGNATURE_FILE_NAMES = [
  "CodeDirectory",
  "CodeRequirements",
  "CodeResources",
  "CodeSignature",
];
const NATIVE_SIGNATURE_FILE_NAMES = ["CodeResources"];
const GENERATOR_ID = "heige-codex-skin-studio";
const MAX_GENERATED_FILE_BYTES = 64 * 1024;
const MAX_ICON_BYTES = 8 * 1024 * 1024;
const MAX_NATIVE_EXECUTABLE_BYTES = 4 * 1024 * 1024;
const TRANSACTION_FILE = ".heige-codex-skin-launcher-transaction.json";
const PREPARATION_FILE = ".heige-codex-skin-launcher-prepare.json";
const LOCK_DIRECTORY = ".heige-codex-skin-launcher-install.lock";
const LAUNCH_SERVICES_REGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PARTICIPANT_KEYS = [
  "afterExecutableSha256",
  "afterIconSha256",
  "afterPlistSha256",
  "afterSignatureSha256",
  "afterVersion",
  "appPath",
  "applications",
  "applicationsPriorExisted",
  "backupPath",
  "beforeExecutableSha256",
  "beforeExisted",
  "beforeIconSha256",
  "beforeInstallRoot",
  "beforePlistSha256",
  "beforeSignatureSha256",
  "beforeVersion",
  "home",
  "intentPath",
  "installRoot",
  "product",
  "schemaVersion",
  "stagePath",
  "transactionId",
  "unchanged",
];
const LEGACY_PLIST_KEYS = [
  "CFBundleDevelopmentRegion",
  "CFBundleDisplayName",
  "CFBundleExecutable",
  "CFBundleIdentifier",
  "CFBundleInfoDictionaryVersion",
  "CFBundleName",
  "CFBundlePackageType",
  "CFBundleShortVersionString",
  "CFBundleVersion",
  "HeiGeGeneratedBy",
  "HeiGeGeneratedLauncher",
  "HeiGeInstallRoot",
  "HeiGeLauncherSchemaVersion",
].sort();
const SCHEMA_3_PLIST_KEYS = [
  ...LEGACY_PLIST_KEYS,
  "CFBundleIconFile",
  "LSMinimumSystemVersion",
  "NSHighResolutionCapable",
].sort();
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const execFile = promisify(execFileCallback);

function exactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertTextCharacters(value, label) {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (
      point < 0x20
      || point === 0x7f
      || (point >= 0xd800 && point <= 0xdfff)
      || point === 0xfffe
      || point === 0xffff
    ) {
      throw new TypeError(`${label} 含有 XML 或 shell 不允许的控制字符`);
    }
  }
}

function assertXmlDocumentCharacters(value, label) {
  for (const character of value) {
    const point = character.codePointAt(0);
    const allowedWhitespace = point === 0x09 || point === 0x0a || point === 0x0d;
    if (
      (!allowedWhitespace && point < 0x20)
      || point === 0x7f
      || (point >= 0xd800 && point <= 0xdfff)
      || point === 0xfffe
      || point === 0xffff
    ) {
      throw new TypeError(`${label} 含有 XML 1.0 不允许的控制字符`);
    }
  }
}

function assertAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new TypeError(`${label} 必须是绝对路径`);
  }
  assertTextCharacters(value, label);
  return resolve(value);
}

function xmlEscape(value) {
  assertTextCharacters(String(value), "XML value");
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlUnescape(value) {
  if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(value)) {
    throw new Error("Info.plist 含有不支持的 XML entity");
  }
  const decoded = value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", "\"")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
  if (xmlEscape(decoded) !== value) throw new Error("Info.plist XML 字符串不是 canonical encoding");
  return decoded;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function renderMacosLauncherExecutableVersion(entrypoint, schema, version = null) {
  entrypoint = assertAbsolutePath(entrypoint, "launcher entrypoint");
  const argument = schema === 3 ? ` ${shellQuote(validateLauncherVersion(version))}` : "";
  return `#!/bin/zsh\n# HeiGe generated launcher schema ${schema}\nset -euo pipefail\nexec ${shellQuote(entrypoint)}${argument}\n`;
}

function validateLauncherVersion(value) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new TypeError("launcher version 必须是规范三段 semver");
  }
  return value;
}

export function renderMacosLauncherExecutable(entrypoint, version = "5.5.4") {
  return renderMacosLauncherExecutableVersion(
    entrypoint,
    3,
    version,
  );
}

export function renderMacosLauncherPlist(installRoot, version = "5.5.4") {
  installRoot = assertAbsolutePath(installRoot, "installRoot");
  version = validateLauncherVersion(version);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>zh_CN</string>
    <key>CFBundleDisplayName</key>
    <string>${MACOS_LAUNCHER_NAME}</string>
    <key>CFBundleExecutable</key>
    <string>${EXECUTABLE_NAME}</string>
    <key>CFBundleIdentifier</key>
    <string>${MACOS_LAUNCHER_BUNDLE_ID}</string>
    <key>CFBundleIconFile</key>
    <string>${ICON_NAME}</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>${MACOS_LAUNCHER_NAME}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>${version}</string>
    <key>CFBundleVersion</key>
    <string>${version}</string>
    <key>HeiGeGeneratedBy</key>
    <string>${GENERATOR_ID}</string>
    <key>HeiGeGeneratedLauncher</key>
    <true/>
    <key>HeiGeInstallRoot</key>
    <string>${xmlEscape(installRoot)}</string>
    <key>HeiGeLauncherSchemaVersion</key>
    <integer>${MACOS_LAUNCHER_SCHEMA_VERSION}</integer>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
`;
}

async function requireRealDirectory(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} 必须是真实目录且不得是符号链接`);
  }
  return realpath(path);
}

async function requireStableEntrypoint(installRoot) {
  const canonicalRoot = await requireRealDirectory(installRoot, "installRoot");
  const scripts = join(installRoot, "scripts");
  const canonicalScripts = await requireRealDirectory(scripts, "scripts");
  if (canonicalScripts !== join(canonicalRoot, "scripts")) {
    throw new Error("scripts 必须位于 stable installRoot 内");
  }
  const entrypoint = join(scripts, "launch-skin.command");
  const info = await lstat(entrypoint);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("launch-skin.command 必须是 regular file 且不得是符号链接");
  }
  if ((info.mode & 0o111) === 0) throw new Error("launch-skin.command 必须可执行");
  if (await realpath(entrypoint) !== join(canonicalRoot, "scripts", "launch-skin.command")) {
    throw new Error("launch-skin.command 必须位于 stable installRoot 内");
  }
  return entrypoint;
}

async function pathInfo(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readSmallRegular(path, label) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(MAX_GENERATED_FILE_BYTES)) {
      throw new Error(`${label} 不是受支持的 generated bundle 文件`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || BigInt(bytes.byteLength) !== before.size
    ) throw new Error(`${label} 在归属校验期间发生变化`);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error(`${label} 不是有效 UTF-8`);
    return { info: { mode: Number(before.mode) }, text };
  } finally {
    await handle.close();
  }
}

async function readBoundedBinary(
  path,
  label,
  maxBytes = MAX_ICON_BYTES,
  { allowEmpty = false } = {},
) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile()
      || (!allowEmpty && before.size <= 0n)
      || before.size > BigInt(maxBytes)
    ) {
      throw new Error(`${label} 不是受支持的 regular file`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || BigInt(bytes.byteLength) !== before.size
    ) throw new Error(`${label} 在归属校验期间发生变化`);
    return { bytes, info: { mode: Number(before.mode) } };
  } finally {
    await handle.close();
  }
}

function signatureResourcesSha256(resources, names) {
  const hash = createHash("sha256");
  for (const name of names) {
    const bytes = resources.get(name);
    if (!Buffer.isBuffer(bytes)) throw new Error(`签名资源缺少 ${name}`);
    hash.update(name, "utf8");
    hash.update("\0");
    hash.update(String(bytes.byteLength), "ascii");
    hash.update("\0");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function validateIcns(bytes) {
  if (
    !Buffer.isBuffer(bytes)
    || bytes.byteLength < 16
    || bytes.subarray(0, 4).toString("ascii") !== "icns"
    || bytes.readUInt32BE(4) !== bytes.byteLength
  ) throw new Error("AppIcon.icns 文件头或长度无效");
  return bytes;
}

function validateNativeLauncherExecutable(bytes) {
  if (
    !Buffer.isBuffer(bytes)
    || bytes.byteLength < 32 * 1024
    || bytes.readUInt32BE(0) !== 0xcafebabe
  ) throw new Error("原生启动器不是受支持的 universal Mach-O");
  const architectureCount = bytes.readUInt32BE(4);
  if (architectureCount !== 2 || 8 + architectureCount * 20 > bytes.byteLength) {
    throw new Error("原生启动器必须只包含 arm64 与 x86_64 两个架构");
  }
  const architectures = new Set();
  const slices = [];
  for (let index = 0; index < architectureCount; index += 1) {
    const entry = 8 + index * 20;
    const cpuType = bytes.readUInt32BE(entry);
    const offset = bytes.readUInt32BE(entry + 8);
    const size = bytes.readUInt32BE(entry + 12);
    if (size < 16 * 1024 || offset < 8 + architectureCount * 20 || offset + size > bytes.byteLength) {
      throw new Error("原生启动器架构切片越界或过小");
    }
    architectures.add(cpuType);
    slices.push({ offset, size });
  }
  slices.sort((left, right) => left.offset - right.offset);
  if (
    architectures.size !== 2
    || !architectures.has(0x01000007)
    || !architectures.has(0x0100000c)
    || slices[0].offset + slices[0].size > slices[1].offset
  ) throw new Error("原生启动器架构集合或切片布局无效");
  return bytes;
}

async function readLauncherInputs(validationRoot) {
  const canonicalRoot = await requireRealDirectory(validationRoot, "validationRoot");
  const packagePath = join(validationRoot, "package.json");
  const iconPath = join(validationRoot, "assets", "launcher", ICON_NAME);
  const executablePath = join(validationRoot, "assets", "launcher", NATIVE_EXECUTABLE_ASSET);
  const [{ text }, { bytes: icon }, { bytes: executable, info: executableInfo }] = await Promise.all([
    readSmallRegular(packagePath, "package.json"),
    readBoundedBinary(iconPath, ICON_NAME),
    readBoundedBinary(
      executablePath,
      NATIVE_EXECUTABLE_ASSET,
      MAX_NATIVE_EXECUTABLE_BYTES,
    ),
  ]);
  if (await realpath(packagePath) !== join(canonicalRoot, "package.json")) {
    throw new Error("package.json 必须位于 validationRoot 内");
  }
  if (await realpath(iconPath) !== join(canonicalRoot, "assets", "launcher", ICON_NAME)) {
    throw new Error("AppIcon.icns 必须位于 validationRoot 内");
  }
  if (await realpath(executablePath) !== join(
    canonicalRoot,
    "assets",
    "launcher",
    NATIVE_EXECUTABLE_ASSET,
  )) throw new Error("原生启动器必须位于 validationRoot 内");
  if ((executableInfo.mode & 0o111) === 0) throw new Error("原生启动器资源必须可执行");
  let packageJson;
  try {
    packageJson = JSON.parse(text);
  } catch (cause) {
    throw new Error("package.json 不是有效 JSON", { cause });
  }
  return {
    executable: validateNativeLauncherExecutable(executable),
    icon: validateIcns(icon),
    version: validateLauncherVersion(packageJson?.version),
  };
}

function oneMatch(text, expression, label) {
  const matches = [...text.matchAll(expression)];
  if (matches.length !== 1) throw new Error(`Info.plist ${label} 缺失或重复`);
  return matches[0][1];
}

function plistString(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return xmlUnescape(oneMatch(
    text,
    new RegExp(`<key>${escaped}<\\/key>\\s*<string>([^<]*)<\\/string>`, "g"),
    key,
  ));
}

function parseAttributedPlist(text) {
  assertXmlDocumentCharacters(text, "Info.plist");
  const schema = Number(oneMatch(
    text,
    /<key>HeiGeLauncherSchemaVersion<\/key>\s*<integer>(\d+)<\/integer>/g,
    "HeiGeLauncherSchemaVersion",
  ));
  if (![1, 2, 3, MACOS_LAUNCHER_SCHEMA_VERSION].includes(schema)) {
    throw new Error("不支持的 generated launcher schema");
  }
  const keys = [...text.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]).sort();
  const expectedKeys = schema >= 3 ? SCHEMA_3_PLIST_KEYS : LEGACY_PLIST_KEYS;
  if (
    keys.length !== expectedKeys.length
    || !keys.every((key, index) => key === expectedKeys[index])
  ) {
    throw new Error("Info.plist keys 不符合 generated launcher schema");
  }
  if (!/<key>HeiGeGeneratedLauncher<\/key>\s*<true\/>/.test(text)) {
    throw new Error("Info.plist 缺少 generated launcher 标识");
  }
  if (plistString(text, "CFBundleIdentifier") !== MACOS_LAUNCHER_BUNDLE_ID) {
    throw new Error("generated launcher bundle id 不匹配");
  }
  if (plistString(text, "CFBundleExecutable") !== EXECUTABLE_NAME) {
    throw new Error("generated launcher executable 不匹配");
  }
  if (plistString(text, "HeiGeGeneratedBy") !== GENERATOR_ID) {
    throw new Error("generated launcher producer 不匹配");
  }
  const installRoot = assertAbsolutePath(plistString(text, "HeiGeInstallRoot"), "attributed installRoot");
  if (schema < 3) return { installRoot, schema, version: null };
  const version = validateLauncherVersion(plistString(text, "CFBundleShortVersionString"));
  if (plistString(text, "CFBundleVersion") !== version) {
    throw new Error("generated launcher Bundle 版本字段不一致");
  }
  if (plistString(text, "CFBundleIconFile") !== ICON_NAME) {
    throw new Error("generated launcher icon 字段不匹配");
  }
  if (plistString(text, "LSMinimumSystemVersion") !== "13.0") {
    throw new Error("generated launcher 最低系统版本不匹配");
  }
  if (!/<key>NSHighResolutionCapable<\/key>\s*<true\/>/.test(text)) {
    throw new Error("generated launcher 缺少高分辨率标识");
  }
  return { installRoot, schema, version };
}

async function assertExactDirectory(path, names, label) {
  const canonical = await requireRealDirectory(path, label);
  const actual = (await readdir(path)).sort();
  const expected = [...names].sort();
  if (actual.length !== expected.length || !actual.every((name, index) => name === expected[index])) {
    throw new Error(`${label} 含有未归属的额外内容`);
  }
  return canonical;
}

async function signMacosLauncherBundle(appPath) {
  await execFile("/usr/bin/codesign", ["--force", "--sign", "-", "--", appPath], {
    maxBuffer: 1024 * 1024,
  });
}

async function verifyMacosLauncherSignature(appPath) {
  await execFile("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--", appPath], {
    maxBuffer: 1024 * 1024,
  });
}

async function validateAttributedBundle(appPath, expected = null) {
  try {
    const canonicalApp = await assertExactDirectory(appPath, ["Contents"], "launcher app");
    const contents = join(appPath, "Contents");
    const preliminaryContents = await requireRealDirectory(contents, "launcher Contents");
    if (preliminaryContents !== join(canonicalApp, "Contents")) {
      throw new Error("launcher Contents escaped bundle");
    }
    const plistPath = join(contents, "Info.plist");
    const { info: plistInfo, text: plist } = await readSmallRegular(plistPath, "Info.plist");
    const attribution = parseAttributedPlist(plist);
    const contentNames = attribution.schema >= 3
      ? ["Info.plist", "MacOS", "Resources", "_CodeSignature"]
      : ["Info.plist", "MacOS"];
    const canonicalContents = await assertExactDirectory(contents, contentNames, "launcher Contents");
    if (canonicalContents !== join(canonicalApp, "Contents")) throw new Error("launcher Contents escaped bundle");
    const macos = join(contents, "MacOS");
    const canonicalMacos = await assertExactDirectory(macos, [EXECUTABLE_NAME], "launcher MacOS");
    if (canonicalMacos !== join(canonicalContents, "MacOS")) throw new Error("launcher MacOS escaped bundle");
    const executablePath = join(macos, EXECUTABLE_NAME);
    let executable;
    let executableInfo;
    if (attribution.schema === 4) {
      const snapshot = await readBoundedBinary(
        executablePath,
        "launcher executable",
        MAX_NATIVE_EXECUTABLE_BYTES,
      );
      executable = validateNativeLauncherExecutable(snapshot.bytes);
      executableInfo = snapshot.info;
    } else {
      const snapshot = await readSmallRegular(executablePath, "launcher executable");
      executable = snapshot.text;
      executableInfo = snapshot.info;
    }
    const entrypointName = attribution.schema === 1
      ? "enable-skin.command"
      : attribution.schema === 2
        ? "apply.command"
        : "launch-skin.command";
    if (
      attribution.schema !== 4
      && executable !== renderMacosLauncherExecutableVersion(join(
        attribution.installRoot,
        "scripts",
        entrypointName,
      ), attribution.schema, attribution.version)
    ) {
      throw new Error("generated launcher executable 与 attributed installRoot 不匹配");
    }
    if ((executableInfo.mode & 0o777) !== 0o755 || (plistInfo.mode & 0o777) !== 0o644) {
      throw new Error("generated bundle 权限不正确");
    }
    let icon = null;
    let iconPath = null;
    let iconSha256 = null;
    let codeResourcesPath = null;
    let signatureSha256 = null;
    if (attribution.schema >= 3) {
      const resources = join(contents, "Resources");
      const signature = join(contents, "_CodeSignature");
      if (await assertExactDirectory(resources, [ICON_NAME], "launcher Resources") !==
          join(canonicalContents, "Resources")) {
        throw new Error("launcher Resources escaped bundle");
      }
      const signatureFileNames = attribution.schema === 4
        ? NATIVE_SIGNATURE_FILE_NAMES
        : LEGACY_SIGNATURE_FILE_NAMES;
      if (await assertExactDirectory(signature, signatureFileNames, "launcher signature") !==
          join(canonicalContents, "_CodeSignature")) {
        throw new Error("launcher signature escaped bundle");
      }
      iconPath = join(resources, ICON_NAME);
      codeResourcesPath = join(signature, "CodeResources");
      const [iconSnapshot, ...signatureSnapshots] = await Promise.all([
        readBoundedBinary(iconPath, ICON_NAME),
        ...signatureFileNames.map((name) => readBoundedBinary(
          join(signature, name),
          name,
          1024 * 1024,
          { allowEmpty: name === "CodeSignature" },
        )),
      ]);
      icon = validateIcns(iconSnapshot.bytes);
      if (
        (iconSnapshot.info.mode & 0o777) !== 0o644
        || signatureSnapshots.some(({ info }) => (info.mode & 0o777) !== 0o644)
      ) throw new Error("generated bundle resource 权限不正确");
      await verifyMacosLauncherSignature(appPath);
      iconSha256 = sha256(icon);
      const signatureResources = new Map(signatureFileNames.map(
        (name, index) => [name, signatureSnapshots[index].bytes],
      ));
      signatureSha256 = signatureResourcesSha256(signatureResources, signatureFileNames);
    }
    if (
      expected !== null
      && (
        plist !== expected.plist
        || !Buffer.isBuffer(icon)
        || !icon.equals(expected.icon)
      )
    ) {
      throw new Error("staged generated bundle 与期望字节不一致");
    }
    return {
      ...attribution,
      executable,
      executablePath,
      executableSha256: sha256(executable),
      plist,
      plistPath,
      plistSha256: sha256(plist),
      icon,
      iconPath,
      iconSha256,
      codeResourcesPath,
      signatureSha256,
    };
  } catch (cause) {
    throw new Error(
      `launcher 目标归属校验失败，不是完整的 generated bundle：${cause?.message ?? "unknown"}`,
      { cause },
    );
  }
}

export async function registerMacosLauncher(appPath, { execFileImpl = execFile } = {}) {
  appPath = assertAbsolutePath(appPath, "appPath");
  if (typeof execFileImpl !== "function") throw new TypeError("execFileImpl must be a function");
  await validateAttributedBundle(appPath);
  await execFileImpl(LAUNCH_SERVICES_REGISTER, ["-f", appPath], {
    maxBuffer: 1024 * 1024,
  });
  return appPath;
}

async function stageBundle(stagePath, expected, hooks = {}) {
  const contents = join(stagePath, "Contents");
  const macos = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  await Promise.all([
    mkdir(macos, { recursive: true, mode: 0o755 }),
    mkdir(resources, { recursive: true, mode: 0o755 }),
  ]);
  await chmod(stagePath, 0o755);
  await chmod(contents, 0o755);
  await chmod(macos, 0o755);
  await chmod(resources, 0o755);
  await syncDirectory(macos);
  await syncDirectory(contents);
  await syncDirectory(stagePath);
  await syncDirectory(dirname(stagePath));
  await hooks.afterStageCreated?.({ stagePath });
  await writeFile(join(contents, "Info.plist"), expected.plist, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });
  await writeFile(join(macos, EXECUTABLE_NAME), expected.executable, {
    flag: "wx",
    mode: 0o755,
  });
  await writeFile(join(resources, ICON_NAME), expected.icon, {
    flag: "wx",
    mode: 0o644,
  });
  await chmod(join(contents, "Info.plist"), 0o644);
  await chmod(join(macos, EXECUTABLE_NAME), 0o755);
  await chmod(join(resources, ICON_NAME), 0o644);
  for (const path of [
    join(contents, "Info.plist"),
    join(macos, EXECUTABLE_NAME),
    join(resources, ICON_NAME),
  ]) {
    const handle = await open(path, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
  }
  const unsignedExecutable = await readBoundedBinary(
    join(macos, EXECUTABLE_NAME),
    "staged unsigned launcher executable",
    MAX_NATIVE_EXECUTABLE_BYTES,
  );
  if (
    !Buffer.isBuffer(expected.executable)
    || !unsignedExecutable.bytes.equals(expected.executable)
  ) throw new Error("staged unsigned launcher executable 与发布源不一致");
  await syncDirectory(macos);
  await syncDirectory(resources);
  await syncDirectory(contents);
  await syncDirectory(stagePath);
  await syncDirectory(dirname(stagePath));
  await signMacosLauncherBundle(stagePath);
  const signature = join(contents, "_CodeSignature");
  await chmod(signature, 0o755);
  await Promise.all(NATIVE_SIGNATURE_FILE_NAMES.map(
    (name) => chmod(join(signature, name), 0o644),
  ));
  await syncDirectory(signature);
  await syncDirectory(contents);
  await syncDirectory(stagePath);
  await syncDirectory(dirname(stagePath));
  return validateAttributedBundle(stagePath, expected);
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeDurableJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    const handle = await open(temporary, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function preparationIntentPath(home) {
  return join(home, PREPARATION_FILE);
}

function assertPreparationIntent(value, home = value?.home) {
  const keys = [
    "appPath",
    "applications",
    "applicationsPriorExisted",
    "backupPath",
    "home",
    "installRoot",
    "operation",
    "product",
    "schemaVersion",
    "stagePath",
    "transactionId",
  ];
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || !exactKeys(value, keys)
    || value.schemaVersion !== 1
    || value.product !== GENERATOR_ID
    || value.operation !== "prepare-macos-launcher"
    || typeof value.applicationsPriorExisted !== "boolean"
    || typeof value.transactionId !== "string"
    || !UUID_PATTERN.test(value.transactionId)
  ) throw new Error("launcher preparation intent schema 无效");
  home = assertAbsolutePath(home, "launcher preparation home");
  const installRoot = assertAbsolutePath(value.installRoot, "launcher preparation installRoot");
  const applications = join(home, "Applications");
  const appPath = join(applications, `${MACOS_LAUNCHER_NAME}.app`);
  const { stagePath, backupPath } = transactionPaths(appPath, value.transactionId);
  if (
    value.home !== home
    || value.installRoot !== installRoot
    || value.applications !== applications
    || value.appPath !== appPath
    || value.stagePath !== stagePath
    || value.backupPath !== backupPath
  ) throw new Error("launcher preparation intent 路径无效");
  return value;
}

async function writeExclusiveDurableJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, path);
    await syncDirectory(dirname(path));
    await unlink(temporary);
    await syncDirectory(dirname(path));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readPreparationIntent(home) {
  const path = preparationIntentPath(home);
  const info = await pathInfo(path);
  if (info === null) return null;
  if (
    info.isSymbolicLink()
    || !info.isFile()
    || info.size <= 0
    || info.size > MAX_GENERATED_FILE_BYTES
    || (info.mode & 0o777) !== 0o600
  ) throw new Error("launcher preparation intent 不是 mode 0600 regular file");
  const snapshot = await readSmallRegular(path, "launcher preparation intent");
  let value;
  try {
    value = JSON.parse(snapshot.text);
  } catch (cause) {
    throw new Error("launcher preparation intent JSON 无效", { cause });
  }
  if (snapshot.text !== `${JSON.stringify(value)}\n`) {
    throw new Error("launcher preparation intent JSON 不是 canonical document");
  }
  return assertPreparationIntent(value, home);
}

async function createPreparationIntent({
  home,
  installRoot,
  applicationsPriorExisted,
  transactionId,
}) {
  const applications = join(home, "Applications");
  const appPath = join(applications, `${MACOS_LAUNCHER_NAME}.app`);
  const { stagePath, backupPath } = transactionPaths(appPath, transactionId);
  const intent = assertPreparationIntent({
    schemaVersion: 1,
    product: GENERATOR_ID,
    operation: "prepare-macos-launcher",
    transactionId,
    home,
    applications,
    applicationsPriorExisted,
    appPath,
    stagePath,
    backupPath,
    installRoot,
  }, home);
  await writeExclusiveDurableJson(preparationIntentPath(home), intent);
  return intent;
}

async function clearPreparationIntent(home, transactionId) {
  const intent = await readPreparationIntent(home);
  if (intent === null) return false;
  if (intent.transactionId !== transactionId) {
    throw new Error("launcher preparation intent transaction 发生变化");
  }
  await unlink(preparationIntentPath(home));
  await syncDirectory(home);
  return true;
}

async function validatePartialBundleStage(intent) {
  const app = await pathInfo(intent.stagePath);
  if (
    app === null
    || app.isSymbolicLink()
    || !app.isDirectory()
    || await realpath(intent.stagePath) !== join(
      await realpath(dirname(intent.stagePath)),
      intent.stagePath.slice(dirname(intent.stagePath).length + 1),
    )
  ) throw new Error("partial launcher stage 不是 canonical real directory");
  const appNames = (await readdir(intent.stagePath)).sort();
  if (appNames.some((name) => name !== "Contents")) {
    throw new Error("partial launcher stage 含有未归属顶层内容");
  }
  if (!appNames.includes("Contents")) return;
  const contents = join(intent.stagePath, "Contents");
  const contentsInfo = await lstat(contents);
  if (contentsInfo.isSymbolicLink() || !contentsInfo.isDirectory()) {
    throw new Error("partial launcher Contents 不安全");
  }
  const contentNames = (await readdir(contents)).sort();
  if (contentNames.some((name) => ![
    "Info.plist",
    "MacOS",
    "Resources",
    "_CodeSignature",
  ].includes(name))) {
    throw new Error("partial launcher Contents 含有未归属内容");
  }
  if (contentNames.includes("Info.plist")) {
    const info = await lstat(join(contents, "Info.plist"));
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_GENERATED_FILE_BYTES) {
      throw new Error("partial launcher Info.plist 不安全");
    }
  }
  if (contentNames.includes("MacOS")) {
    const macos = join(contents, "MacOS");
    const macosInfo = await lstat(macos);
    if (macosInfo.isSymbolicLink() || !macosInfo.isDirectory()) {
      throw new Error("partial launcher MacOS 不安全");
    }
    const executableNames = await readdir(macos);
    if (executableNames.some((name) => name !== EXECUTABLE_NAME)) {
      throw new Error("partial launcher MacOS 含有未归属内容");
    }
    if (executableNames.includes(EXECUTABLE_NAME)) {
      const info = await lstat(join(macos, EXECUTABLE_NAME));
      if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_NATIVE_EXECUTABLE_BYTES) {
        throw new Error("partial launcher executable 不安全");
      }
    }
  }
  if (contentNames.includes("Resources")) {
    const resources = join(contents, "Resources");
    const resourcesInfo = await lstat(resources);
    if (resourcesInfo.isSymbolicLink() || !resourcesInfo.isDirectory()) {
      throw new Error("partial launcher Resources 不安全");
    }
    const resourceNames = await readdir(resources);
    if (resourceNames.some((name) => name !== ICON_NAME)) {
      throw new Error("partial launcher Resources 含有未归属内容");
    }
    if (resourceNames.includes(ICON_NAME)) {
      const info = await lstat(join(resources, ICON_NAME));
      if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_ICON_BYTES) {
        throw new Error("partial launcher icon 不安全");
      }
    }
  }
  if (contentNames.includes("_CodeSignature")) {
    const signature = join(contents, "_CodeSignature");
    const signatureInfo = await lstat(signature);
    if (signatureInfo.isSymbolicLink() || !signatureInfo.isDirectory()) {
      throw new Error("partial launcher signature 不安全");
    }
    const signatureNames = await readdir(signature);
    const knownSignatureNames = new Set([
      ...LEGACY_SIGNATURE_FILE_NAMES,
      ...NATIVE_SIGNATURE_FILE_NAMES,
    ]);
    if (signatureNames.some((name) => !knownSignatureNames.has(name))) {
      throw new Error("partial launcher signature 含有未归属内容");
    }
    for (const name of signatureNames) {
      const info = await lstat(join(signature, name));
      if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) {
        throw new Error("partial launcher signature file 不安全");
      }
    }
  }
}

async function removeApplicationsIfCreatedAndEmpty(intent, { lockMayExist = false } = {}) {
  if (intent.applicationsPriorExisted) return false;
  const info = await pathInfo(intent.applications);
  if (info === null) return false;
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("本次创建的 Applications 路径已变成非目录");
  }
  const names = await readdir(intent.applications);
  const allowed = lockMayExist ? new Set([LOCK_DIRECTORY]) : new Set();
  if (names.some((name) => !allowed.has(name))) return false;
  if (names.length !== 0) return false;
  await rmdir(intent.applications);
  await syncDirectory(intent.home);
  return true;
}

async function recoverPreparationIntent(home, { lockMayExist = false } = {}) {
  const intent = await readPreparationIntent(home);
  if (intent === null) return { recovered: false, applicationsPriorExisted: true };
  if (await pathInfo(intent.backupPath)) {
    throw new Error("launcher prepare 在 publish 前意外创建了 backup");
  }
  if (await pathInfo(intent.stagePath)) {
    let staged = null;
    try {
      staged = await validateAttributedBundle(intent.stagePath);
    } catch {
      await validatePartialBundleStage(intent);
    }
    if (staged !== null && staged.installRoot !== intent.installRoot) {
      throw new Error("launcher stage installRoot 与 preparation intent 不匹配");
    }
    await rm(intent.stagePath, { recursive: true, force: false });
    await syncDirectory(intent.applications);
  }
  await clearPreparationIntent(home, intent.transactionId);
  await removeApplicationsIfCreatedAndEmpty(intent, { lockMayExist });
  return {
    recovered: true,
    action: "prepare-cleanup",
    applicationsPriorExisted: intent.applicationsPriorExisted,
  };
}

async function readTransaction(path) {
  const info = await pathInfo(path);
  if (info === null) return null;
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_GENERATED_FILE_BYTES || (info.mode & 0o777) !== 0o600) {
    throw new Error("launcher transaction journal 不是 mode 0600 regular file");
  }
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); } catch (cause) {
    throw new Error("launcher transaction journal JSON 无效", { cause });
  }
  if (
    !exactKeys(value, ["hadExisting", "phase", "schemaVersion", "transactionId"])
    || value.schemaVersion !== 1
    || typeof value.hadExisting !== "boolean"
    || !["prepared", "backed-up", "published"].includes(value.phase)
    || typeof value.transactionId !== "string"
    || !UUID_PATTERN.test(value.transactionId)
  ) throw new Error("launcher transaction journal schema 无效");
  return value;
}

async function clearTransaction(path) {
  try { await unlink(path); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  await syncDirectory(dirname(path));
}

function transactionPaths(appPath, transactionId) {
  if (!UUID_PATTERN.test(transactionId)) throw new Error("launcher transaction id 无效");
  return {
    backupPath: `${appPath}.backup.${transactionId}`,
    stagePath: `${appPath}.staged.${transactionId}`,
  };
}

async function removeAttributedBundle(path) {
  await validateAttributedBundle(path);
  await rm(path, { recursive: true, force: true });
  await syncDirectory(dirname(path));
}

async function recoverTransaction({ appPath, journalPath }) {
  const journal = await readTransaction(journalPath);
  if (journal === null) return false;
  const { backupPath, stagePath } = transactionPaths(appPath, journal.transactionId);
  const [app, backup, stage] = await Promise.all([
    pathInfo(appPath),
    pathInfo(backupPath),
    pathInfo(stagePath),
  ]);

  if (backup !== null) {
    await validateAttributedBundle(backupPath);
    if (app !== null) await removeAttributedBundle(appPath);
    await rename(backupPath, appPath);
    await syncDirectory(dirname(appPath));
    if (stage !== null) await removeAttributedBundle(stagePath);
  } else if (app !== null) {
    await validateAttributedBundle(appPath);
    if (stage !== null) await removeAttributedBundle(stagePath);
  } else if (stage !== null && journal.hadExisting === false) {
    await validateAttributedBundle(stagePath);
    await rename(stagePath, appPath);
    await syncDirectory(dirname(appPath));
  } else if (journal.hadExisting) {
    throw new Error("launcher crash recovery 缺少原 bundle 与 backup，拒绝继续");
  }

  await clearTransaction(journalPath);
  return true;
}

async function acquireInstallLock(applications, identityReader = readProcessIdentity) {
  const lockPath = join(applications, LOCK_DIRECTORY);
  const identity = await identityReader(process.pid);
  if (
    identity?.pid !== process.pid ||
    typeof identity.startedAt !== "string" ||
    identity.startedAt.length === 0
  ) throw new Error("launcher installer process identity is unavailable");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let created = false;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    if (created) {
      const owner = {
        nonce: randomUUID(),
        pid: process.pid,
        schemaVersion: 2,
        startedAt: identity.startedAt,
      };
      try {
        await writeDurableJson(join(lockPath, "owner.json"), owner);
      } catch (error) {
        try {
          await rm(lockPath, { recursive: true, force: true });
          await syncDirectory(applications);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "launcher install lock 初始化与清理同时失败");
        }
        throw error;
      }
      return async () => {
        const ownerPath = join(lockPath, "owner.json");
        let current;
        try {
          const lockInfo = await lstat(lockPath);
          const ownerInfo = await lstat(ownerPath);
          if (
            lockInfo.isSymbolicLink()
            || !lockInfo.isDirectory()
            || (lockInfo.mode & 0o777) !== 0o700
            || ownerInfo.isSymbolicLink()
            || !ownerInfo.isFile()
            || ownerInfo.size > MAX_GENERATED_FILE_BYTES
            || (ownerInfo.mode & 0o777) !== 0o600
          ) throw new Error("launcher install lock ownership 无效");
          current = JSON.parse(await readFile(ownerPath, "utf8"));
        } catch (cause) {
          throw new Error("launcher install lock 无法安全释放", { cause });
        }
        if (!exactKeys(current, ["nonce", "pid", "schemaVersion", "startedAt"])
          || current.nonce !== owner.nonce
          || current.pid !== owner.pid
          || current.startedAt !== owner.startedAt
          || current.schemaVersion !== owner.schemaVersion) {
          throw new Error("launcher install lock ownership 已变化，拒绝删除");
        }
        await rm(lockPath, { recursive: true, force: true });
        await syncDirectory(applications);
      };
    }

    try {
      const lockInfo = await lstat(lockPath);
      if (
        lockInfo.isSymbolicLink()
        || !lockInfo.isDirectory()
        || (lockInfo.mode & 0o777) !== 0o700
        || await realpath(lockPath) !== join(await realpath(applications), LOCK_DIRECTORY)
      ) throw new Error("launcher install lock 不是 mode 0700 real directory");
      const ownerPath = join(lockPath, "owner.json");
      let owner;
      const info = await lstat(ownerPath);
      if (
        info.isSymbolicLink()
        || !info.isFile()
        || info.size > MAX_GENERATED_FILE_BYTES
        || (info.mode & 0o777) !== 0o600
      ) {
        throw new Error("launcher install lock owner 无效");
      }
      owner = JSON.parse(await readFile(ownerPath, "utf8"));
      const schema1 = exactKeys(owner, ["nonce", "pid", "schemaVersion"])
        && owner.schemaVersion === 1;
      const schema2 = exactKeys(owner, ["nonce", "pid", "schemaVersion", "startedAt"])
        && owner.schemaVersion === 2;
      if (
        (!schema1 && !schema2)
        || !Number.isSafeInteger(owner.pid)
        || owner.pid <= 0
        || typeof owner.nonce !== "string"
        || !UUID_PATTERN.test(owner.nonce)
        || (schema2 && (
          typeof owner.startedAt !== "string"
          || owner.startedAt.length === 0
        ))
      ) throw new Error("launcher install lock owner schema 无效");
      const observedIdentity = await identityReader(owner.pid);
      if (
        (schema1 && observedIdentity !== null) ||
        (schema2 && sameProcessIdentity(observedIdentity, owner))
      ) {
        throw new Error("另一个 HeiGe 皮肤启动器安装仍在进行");
      }
      const stale = `${lockPath}.stale.${randomUUID()}`;
      try { await rename(lockPath, stale); } catch (failure) {
        if (failure?.code === "ENOENT") continue;
        throw failure;
      }
      await rm(stale, { recursive: true, force: true });
      await syncDirectory(applications);
    } catch (cause) {
      if (cause?.code === "ENOENT") continue;
      if (cause?.message === "另一个 HeiGe 皮肤启动器安装仍在进行") throw cause;
      throw new Error("launcher install lock 无法归属，拒绝抢占", { cause });
    }
  }
  throw new Error("无法取得 launcher install lock");
}

export async function acquireMacosLauncherInstallLock({
  home,
  readProcessIdentity: identityReader,
  recover = true,
} = {}) {
  home = assertAbsolutePath(home, "home");
  const canonicalHome = await requireRealDirectory(home, "home");
  const applications = join(home, "Applications");
  const applicationsInfo = await pathInfo(applications);
  const applicationsPriorExisted = applicationsInfo !== null;
  if (applicationsInfo !== null) {
    const observed = await requireRealDirectory(applications, "Applications");
    if (observed !== join(canonicalHome, "Applications")) {
      throw new Error("Applications 必须位于用户 home 内");
    }
  }
  await mkdir(applications, { recursive: true, mode: 0o755 });
  const canonicalApplications = await requireRealDirectory(applications, "Applications");
  if (canonicalApplications !== join(canonicalHome, "Applications")) {
    throw new Error("Applications 必须位于用户 home 内");
  }
  const releaseLock = await acquireInstallLock(applications, identityReader);
  let removeApplicationsAfterRelease = !applicationsPriorExisted;
  try {
    if (recover) {
      await recoverTransaction({
        appPath: join(applications, `${MACOS_LAUNCHER_NAME}.app`),
        journalPath: join(applications, TRANSACTION_FILE),
      });
      const preparationRecovery = await recoverPreparationIntent(home, { lockMayExist: true });
      if (preparationRecovery.recovered && !preparationRecovery.applicationsPriorExisted) {
        removeApplicationsAfterRelease = true;
      }
    }
  } catch (error) {
    try {
      await releaseLock();
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "launcher standalone recovery 与 participant lock 释放同时失败",
      );
    }
    throw error;
  }
  const release = async () => {
    await releaseLock();
    if (!removeApplicationsAfterRelease) return;
    const info = await pathInfo(applications);
    if (info === null) return;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("Applications 在 launcher lock 释放前变成非目录");
    }
    if ((await readdir(applications)).length !== 0) return;
    await rmdir(applications);
    await syncDirectory(home);
  };
  return { applications, applicationsPriorExisted, home, release };
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} 不是有效 SHA-256`);
  }
}

function expectedLauncher(installRoot, { executable, icon, version }) {
  installRoot = assertAbsolutePath(installRoot, "expected launcher installRoot");
  version = validateLauncherVersion(version);
  validateNativeLauncherExecutable(executable);
  validateIcns(icon);
  const plist = renderMacosLauncherPlist(installRoot, version);
  return {
    executable,
    executableSha256: sha256(executable),
    icon,
    iconSha256: sha256(icon),
    plist,
    plistSha256: sha256(plist),
    version,
  };
}

function assertLauncherParticipant(value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || !exactKeys(value, PARTICIPANT_KEYS)
    || value.schemaVersion !== 2
    || value.product !== GENERATOR_ID
  ) throw new Error("launcher participant schema 无效");
  const home = assertAbsolutePath(value.home, "participant home");
  const installRoot = assertAbsolutePath(value.installRoot, "participant installRoot");
  if (typeof value.transactionId !== "string" || !UUID_PATTERN.test(value.transactionId)) {
    throw new Error("launcher participant transactionId 无效");
  }
  const applications = join(home, "Applications");
  const appPath = join(applications, `${MACOS_LAUNCHER_NAME}.app`);
  const { backupPath, stagePath } = transactionPaths(appPath, value.transactionId);
  if (
    value.applications !== applications
    || value.intentPath !== preparationIntentPath(home)
    || value.appPath !== appPath
    || value.backupPath !== backupPath
    || value.stagePath !== stagePath
  ) throw new Error("launcher participant 路径未由 home 和 transactionId 严格派生");
  if (typeof value.beforeExisted !== "boolean" || typeof value.unchanged !== "boolean") {
    throw new Error("launcher participant flags 无效");
  }
  if (typeof value.applicationsPriorExisted !== "boolean") {
    throw new Error("launcher participant Applications prestate 无效");
  }
  assertSha256(value.afterExecutableSha256, "after executable");
  assertSha256(value.afterIconSha256, "after icon");
  assertSha256(value.afterPlistSha256, "after plist");
  assertSha256(value.afterSignatureSha256, "after signature");
  validateLauncherVersion(value.afterVersion);
  if (value.beforeExisted) {
    assertAbsolutePath(value.beforeInstallRoot, "participant beforeInstallRoot");
    assertSha256(value.beforeExecutableSha256, "before executable");
    assertSha256(value.beforePlistSha256, "before plist");
    if (value.beforeVersion === null) {
      if (value.beforeIconSha256 !== null || value.beforeSignatureSha256 !== null) {
        throw new Error("legacy launcher prestate 含有 Schema 3 摘要");
      }
    } else {
      validateLauncherVersion(value.beforeVersion);
      assertSha256(value.beforeIconSha256, "before icon");
      assertSha256(value.beforeSignatureSha256, "before signature");
    }
  } else if (
    value.beforeInstallRoot !== null
    || value.beforeExecutableSha256 !== null
    || value.beforeIconSha256 !== null
    || value.beforePlistSha256 !== null
    || value.beforeSignatureSha256 !== null
    || value.beforeVersion !== null
    || value.unchanged
  ) throw new Error("不存在的 launcher prestate 含有无效归属字段");
  return value;
}

export function validateMacosLauncherParticipant(value) {
  return assertLauncherParticipant(value);
}

export async function recoverMacosLauncherPreparationUnderLock({ home } = {}) {
  home = assertAbsolutePath(home, "home");
  return recoverPreparationIntent(home, { lockMayExist: true });
}

async function validateParticipantContext(participant) {
  const canonicalHome = await requireRealDirectory(participant.home, "participant home");
  const canonicalApplications = await requireRealDirectory(
    participant.applications,
    "participant Applications",
  );
  if (canonicalApplications !== join(canonicalHome, "Applications")) {
    throw new Error("participant Applications 必须位于用户 home 内");
  }
}

async function validateParticipantBeforeBundle(participant, path) {
  if (!participant.beforeExisted) throw new Error("不存在 launcher prestate");
  const actual = await validateAttributedBundle(path);
  if (
    actual.installRoot !== participant.beforeInstallRoot
    || actual.executableSha256 !== participant.beforeExecutableSha256
    || actual.plistSha256 !== participant.beforePlistSha256
    || actual.iconSha256 !== participant.beforeIconSha256
    || actual.signatureSha256 !== participant.beforeSignatureSha256
    || actual.version !== participant.beforeVersion
  ) throw new Error("launcher before bundle 与 participant 归属不匹配");
  return actual;
}

async function validateParticipantAfterBundle(participant, path) {
  const actual = await validateAttributedBundle(path);
  if (
    actual.schema !== MACOS_LAUNCHER_SCHEMA_VERSION
    || actual.installRoot !== participant.installRoot
    || actual.executableSha256 !== participant.afterExecutableSha256
    || actual.plistSha256 !== participant.afterPlistSha256
    || actual.iconSha256 !== participant.afterIconSha256
    || actual.signatureSha256 !== participant.afterSignatureSha256
    || actual.version !== participant.afterVersion
  ) throw new Error("launcher after bundle 与 participant 归属不匹配");
  return actual;
}

async function removeParticipantAfterBundle(participant, path) {
  await validateParticipantAfterBundle(participant, path);
  await rm(path, { recursive: true, force: false });
  await syncDirectory(dirname(path));
}

async function removeParticipantBeforeBundle(participant, path) {
  await validateParticipantBeforeBundle(participant, path);
  await rm(path, { recursive: true, force: false });
  await syncDirectory(dirname(path));
}

export async function prepareMacosLauncher({
  home,
  installRoot,
  validationRoot = installRoot,
  transactionId = randomUUID(),
  applicationsPriorExisted,
  hooks = {},
} = {}) {
  home = assertAbsolutePath(home, "home");
  installRoot = assertAbsolutePath(installRoot, "installRoot");
  validationRoot = assertAbsolutePath(validationRoot, "validationRoot");
  if (!UUID_PATTERN.test(transactionId)) throw new Error("launcher transaction id 无效");
  const canonicalHome = await requireRealDirectory(home, "home");
  await requireStableEntrypoint(validationRoot);
  const launcherInputs = await readLauncherInputs(validationRoot);
  const applications = join(home, "Applications");
  const applicationsInfo = await pathInfo(applications);
  if (applicationsPriorExisted === undefined) {
    applicationsPriorExisted = applicationsInfo !== null;
  } else if (typeof applicationsPriorExisted !== "boolean") {
    throw new Error("applicationsPriorExisted 必须是布尔值");
  }
  if (applicationsPriorExisted && applicationsInfo === null) {
    throw new Error("Applications prestate 声称存在但当前缺失");
  }
  if (applicationsInfo !== null) {
    const canonicalApplications = await requireRealDirectory(applications, "Applications");
    if (canonicalApplications !== join(canonicalHome, "Applications")) {
      throw new Error("Applications 必须位于用户 home 内");
    }
  }
  if (applicationsInfo !== null && await pathInfo(join(applications, TRANSACTION_FILE))) {
    throw new Error("存在未完成的 standalone launcher transaction journal");
  }
  const appPath = join(applications, `${MACOS_LAUNCHER_NAME}.app`);
  const { backupPath, stagePath } = transactionPaths(appPath, transactionId);
  if (await pathInfo(stagePath) || await pathInfo(backupPath)) {
    throw new Error("launcher participant stage 或 backup 已存在");
  }
  const expected = expectedLauncher(installRoot, launcherInputs);
  let intent = null;
  try {
    intent = await createPreparationIntent({
      home,
      installRoot,
      applicationsPriorExisted,
      transactionId,
    });
    await hooks.afterPreparationIntent?.({ intent });
    await mkdir(applications, { recursive: true, mode: 0o755 });
    const canonicalApplications = await requireRealDirectory(applications, "Applications");
    if (canonicalApplications !== join(canonicalHome, "Applications")) {
      throw new Error("Applications 必须位于用户 home 内");
    }
    const existingInfo = await pathInfo(appPath);
    const before = existingInfo === null ? null : await validateAttributedBundle(appPath);
    const staged = await stageBundle(stagePath, expected, hooks);
    const unchanged = before !== null
      && before.executableSha256 === expected.executableSha256
      && before.plistSha256 === expected.plistSha256
      && before.iconSha256 === expected.iconSha256
      && before.signatureSha256 === staged.signatureSha256
      && before.version === expected.version;
    const participant = assertLauncherParticipant({
      schemaVersion: 2,
      product: GENERATOR_ID,
      transactionId,
      home,
      applications,
      applicationsPriorExisted,
      intentPath: preparationIntentPath(home),
      appPath,
      stagePath,
      backupPath,
      installRoot,
      beforeExisted: before !== null,
      beforeInstallRoot: before?.installRoot ?? null,
      beforeExecutableSha256: before?.executableSha256 ?? null,
      beforeIconSha256: before?.iconSha256 ?? null,
      beforePlistSha256: before?.plistSha256 ?? null,
      beforeSignatureSha256: before?.signatureSha256 ?? null,
      beforeVersion: before?.version ?? null,
      afterExecutableSha256: staged.executableSha256,
      afterIconSha256: staged.iconSha256,
      afterPlistSha256: staged.plistSha256,
      afterSignatureSha256: staged.signatureSha256,
      afterVersion: staged.version,
      unchanged,
    });
    if (unchanged) await removeParticipantAfterBundle(participant, stagePath);
    if (unchanged) await clearPreparationIntent(home, transactionId);
    await hooks.afterPrepare?.({ participant });
    return participant;
  } catch (error) {
    let cleanupError = null;
    try {
      if (intent !== null) {
        await recoverPreparationIntent(home, { lockMayExist: true });
      } else if (await pathInfo(stagePath)) {
        throw new Error("launcher stage 在 durable preparation intent 前出现");
      }
    } catch (failure) {
      cleanupError = failure;
    }
    if (cleanupError !== null) {
      throw new AggregateError(
        [error, cleanupError],
        "launcher prepare 与 cleanup 同时失败",
      );
    }
    throw error;
  }
}

export async function publishMacosLauncher(value, { hooks = {} } = {}) {
  const participant = assertLauncherParticipant(value);
  await validateParticipantContext(participant);
  if (participant.unchanged) {
    const paths = await validateParticipantAfterBundle(participant, participant.appPath);
    return { ...participant, published: false, executablePath: paths.executablePath, plistPath: paths.plistPath };
  }
  await validateParticipantAfterBundle(participant, participant.stagePath);
  if (await pathInfo(participant.backupPath)) throw new Error("launcher participant backup 已存在");
  const app = await pathInfo(participant.appPath);
  if (participant.beforeExisted) {
    if (app === null) throw new Error("launcher target 在 publish 前消失");
    await validateParticipantBeforeBundle(participant, participant.appPath);
    await rename(participant.appPath, participant.backupPath);
    await syncDirectory(participant.applications);
    await hooks.afterBackup?.({ participant });
  } else if (app !== null) {
    throw new Error("launcher target 在首次 publish 前出现");
  }
  await rename(participant.stagePath, participant.appPath);
  await syncDirectory(participant.applications);
  const paths = await validateParticipantAfterBundle(participant, participant.appPath);
  await hooks.afterPublish?.({ participant, ...paths });
  return {
    ...participant,
    published: true,
    executablePath: paths.executablePath,
    plistPath: paths.plistPath,
  };
}

export async function rollbackMacosLauncher(value) {
  const participant = assertLauncherParticipant(value);
  await validateParticipantContext(participant);
  if (participant.unchanged) {
    await validateParticipantAfterBundle(participant, participant.appPath);
    await clearPreparationIntent(participant.home, participant.transactionId);
    return { ...participant, rolledBack: false };
  }
  const backup = await pathInfo(participant.backupPath);
  const app = await pathInfo(participant.appPath);
  if (backup !== null) {
    if (!participant.beforeExisted) throw new Error("无 prestate 的 launcher participant 出现 backup");
    await validateParticipantBeforeBundle(participant, participant.backupPath);
    if (app !== null) await removeParticipantAfterBundle(participant, participant.appPath);
    await rename(participant.backupPath, participant.appPath);
    await syncDirectory(participant.applications);
  } else if (participant.beforeExisted) {
    if (app === null) throw new Error("launcher rollback 缺少 app 与 backup");
    await validateParticipantBeforeBundle(participant, participant.appPath);
  } else if (app !== null) {
    await removeParticipantAfterBundle(participant, participant.appPath);
  }
  if (await pathInfo(participant.stagePath)) {
    await removeParticipantAfterBundle(participant, participant.stagePath);
  }
  if (participant.beforeExisted) {
    await validateParticipantBeforeBundle(participant, participant.appPath);
  } else if (await pathInfo(participant.appPath)) {
    throw new Error("launcher rollback 遗留了原本不存在的 app");
  }
  await clearPreparationIntent(participant.home, participant.transactionId);
  await removeApplicationsIfCreatedAndEmpty(participant, { lockMayExist: true });
  return { ...participant, rolledBack: true };
}

export async function finalizeMacosLauncher(
  value,
  { registerLauncher = registerMacosLauncher } = {},
) {
  const participant = assertLauncherParticipant(value);
  if (typeof registerLauncher !== "function") {
    throw new TypeError("registerLauncher must be a function");
  }
  await validateParticipantContext(participant);
  const paths = await validateParticipantAfterBundle(participant, participant.appPath);
  await registerLauncher(participant.appPath);
  if (await pathInfo(participant.stagePath)) {
    await removeParticipantAfterBundle(participant, participant.stagePath);
  }
  if (await pathInfo(participant.backupPath)) {
    if (!participant.beforeExisted) throw new Error("无 prestate 的 launcher participant 出现 backup");
    await removeParticipantBeforeBundle(participant, participant.backupPath);
  }
  await clearPreparationIntent(participant.home, participant.transactionId);
  return {
    ...participant,
    finalized: true,
    executablePath: paths.executablePath,
    plistPath: paths.plistPath,
  };
}

export async function installMacosLauncher({
  home,
  installRoot,
  hooks = {},
  readProcessIdentity: identityReader,
} = {}) {
  home = assertAbsolutePath(home, "home");
  installRoot = assertAbsolutePath(installRoot, "installRoot");
  await requireStableEntrypoint(installRoot);
  const launcherInputs = await readLauncherInputs(installRoot);
  const launcherLock = await acquireMacosLauncherInstallLock({
    home,
    readProcessIdentity: identityReader,
  });
  const { applications } = launcherLock;

  const appPath = join(applications, `${MACOS_LAUNCHER_NAME}.app`);
  const journalPath = join(applications, TRANSACTION_FILE);
  const releaseLock = launcherLock.release;
  let operationError = null;
  try {
    const existing = await pathInfo(appPath);
    if (existing !== null) await validateAttributedBundle(appPath);
    const transactionId = randomUUID();
    const { backupPath, stagePath } = transactionPaths(appPath, transactionId);
    const expected = expectedLauncher(installRoot, launcherInputs);
    let journal = {
      schemaVersion: 1,
      transactionId,
      hadExisting: existing !== null,
      phase: "prepared",
    };
    await writeDurableJson(journalPath, journal);

    try {
      await stageBundle(stagePath, expected);
      await hooks.beforePublish?.({ appPath, stagePath });
      if (existing !== null) {
        await rename(appPath, backupPath);
        await syncDirectory(applications);
        journal = { ...journal, phase: "backed-up" };
        await writeDurableJson(journalPath, journal);
        await hooks.afterBackup?.({ appPath, backupPath, stagePath });
      }
      await rename(stagePath, appPath);
      await syncDirectory(applications);
      journal = { ...journal, phase: "published" };
      await writeDurableJson(journalPath, journal);
      const paths = await validateAttributedBundle(appPath, expected);
      await hooks.afterPublish?.({ appPath, ...paths });
      if (existing !== null) {
        await removeAttributedBundle(backupPath);
      }
      await clearTransaction(journalPath);
      return {
        appPath,
        executablePath: paths.executablePath,
        plistPath: paths.plistPath,
      };
    } catch (error) {
      try {
        await recoverTransaction({ appPath, journalPath });
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], "launcher publish 与 crash recovery 同时失败");
      }
      throw error;
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await releaseLock();
    } catch (releaseError) {
      if (operationError !== null) {
        throw new AggregateError(
          [operationError, releaseError],
          "launcher operation 与 install lock 释放同时失败",
        );
      }
      throw releaseError;
    }
  }
}
