#!/usr/bin/env node
import { constants as fsConstants, createWriteStream } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import yazl from "yazl";

const execFile = promisify(execFileCallback);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "scripts/skill-package-manifest.json");
const trackedOutput = join(root, "output/heige-codex-skin-studio.skill");
const archiveRoot = "heige-codex-skin-studio";
export const TRACKED_PACKAGE_SOURCE_DATE_EPOCH = 1_704_067_200;
const exactManifestKeys = ["entries", "schemaVersion"];
const exactEntryKeys = ["destination", "exclude", "recursive", "source"];
const runtimeScriptNames = ["apply", "doctor", "list", "status"];
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_INPUT_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function safeRelativePath(value, label, { allowEmpty = false } = {}) {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || isAbsolute(value)
    || value.includes("\\")
    || value.includes("\0")
  ) throw new TypeError(`${label} 必须是安全的 POSIX 相对路径`);
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new TypeError(`${label} 含有无效路径段`);
  }
  return value;
}

function parseEpoch(value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 315_532_800 || number > 2_147_483_647) {
    throw new TypeError("source date epoch 必须是 1980 到 2038 之间的整数秒");
  }
  return number;
}

function parseManifest(input) {
  if (!exactKeys(input, exactManifestKeys) || input.schemaVersion !== 1 || !Array.isArray(input.entries)) {
    throw new TypeError("skill package manifest 结构无效");
  }
  return input.entries.map((entry, index) => {
    if (!exactKeys(entry, exactEntryKeys) || typeof entry.recursive !== "boolean" || !Array.isArray(entry.exclude)) {
      throw new TypeError(`skill package manifest entry ${index} 结构无效`);
    }
    const source = safeRelativePath(entry.source, `entry ${index} source`);
    const destination = safeRelativePath(entry.destination, `entry ${index} destination`);
    const exclude = entry.exclude.map((path) => safeRelativePath(path, `entry ${index} exclude`));
    if (new Set(exclude).size !== exclude.length) throw new TypeError(`entry ${index} exclude 含重复路径`);
    return { source, destination, recursive: entry.recursive, exclude: new Set(exclude) };
  });
}

function archivePath(destination) {
  const path = `${archiveRoot}/${destination}`;
  safeRelativePath(path, "archive destination");
  return path;
}

async function regularFile(path, label) {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile()) throw new TypeError(`${label} 必须是普通文件且不得是符号链接`);
  return info;
}

async function assertNoSymlinkAncestors(path, label) {
  const relativePath = relative(root, path);
  if (relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
    throw new TypeError(`${label} 超出仓库根目录`);
  }
  let current = root;
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const info = await lstat(current, { bigint: true });
    if (info.isSymbolicLink()) throw new TypeError(`${label} 的路径祖先不得是符号链接`);
  }
}

async function readStableFile(path, label) {
  await assertNoSymlinkAncestors(path, label);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_ENTRY_BYTES)) {
      throw new RangeError(`${label} 不是普通文件或超过 ${MAX_ENTRY_BYTES} bytes`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || BigInt(bytes.byteLength) !== before.size
    ) throw new Error(`${label} 在打包读取期间发生变化`);
    return bytes;
  } finally {
    await handle.close();
  }
}

function repositoryRelative(path) {
  const value = relative(root, path).split(sep).join("/");
  if (value === "" || value === ".." || value.startsWith("../") || isAbsolute(value)) {
    throw new TypeError("package source 超出仓库根目录");
  }
  return value;
}

async function trackedSourceIndex() {
  const { stdout } = await execFile("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const files = new Set(stdout.split("\0").filter(Boolean));
  const directories = new Set();
  for (const path of files) {
    const segments = path.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      directories.add(segments.slice(0, length).join("/"));
    }
  }
  return { files, directories };
}

function assertTrackedSource(path, kind, tracked) {
  const source = repositoryRelative(path);
  const allowed = kind === "directory"
    ? tracked.directories.has(source)
    : tracked.files.has(source);
  if (!allowed) throw new Error(`package source 不是 Git 已跟踪的${kind === "directory" ? "目录" : "文件"}：${source}`);
}

function consumeEntryBudget(budget) {
  budget.count += 1;
  if (budget.count > MAX_ARCHIVE_ENTRIES) {
    throw new RangeError(`package entries 超过 ${MAX_ARCHIVE_ENTRIES}`);
  }
}

async function collectDirectory(sourceRoot, destinationRoot, exclude, tracked, budget) {
  const result = [];
  const visit = async (directory, prefix = "") => {
    const directoryInfo = await lstat(directory, { bigint: true });
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new TypeError(`package source 目录无效：${relative(root, directory)}`);
    }
    assertTrackedSource(directory, "directory", tracked);
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const childRelative = prefix ? `${prefix}/${name}` : name;
      if (exclude.has(childRelative)) continue;
      const path = join(directory, name);
      const info = await lstat(path, { bigint: true });
      if (info.isSymbolicLink()) throw new TypeError(`package source 不得包含符号链接：${childRelative}`);
      if (info.isDirectory()) await visit(path, childRelative);
      else if (info.isFile()) {
        assertTrackedSource(path, "file", tracked);
        consumeEntryBudget(budget);
        result.push({ source: path, destination: archivePath(`${destinationRoot}/${childRelative}`) });
      } else throw new TypeError(`package source 只允许普通文件：${childRelative}`);
    }
  };
  await visit(sourceRoot);
  for (const excluded of exclude) {
    const path = join(sourceRoot, ...excluded.split("/"));
    try { await lstat(path, { bigint: true }); } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
  }
  return result;
}

async function collectFiles(manifest, tracked) {
  const files = [];
  const budget = { count: 0 };
  for (const entry of manifest) {
    const source = join(root, ...entry.source.split("/"));
    await assertNoSymlinkAncestors(source, entry.source);
    if (entry.recursive) {
      files.push(...await collectDirectory(source, entry.destination, entry.exclude, tracked, budget));
    } else {
      if (entry.exclude.size !== 0) throw new TypeError(`单文件 entry 不得含 exclude：${entry.source}`);
      await regularFile(source, entry.source);
      assertTrackedSource(source, "file", tracked);
      consumeEntryBudget(budget);
      files.push({ source, destination: archivePath(entry.destination) });
    }
  }
  const rootPackage = JSON.parse((await readStableFile(join(root, "package.json"), "package.json")).toString("utf8"));
  const runtimePackage = {
    name: rootPackage.name,
    version: rootPackage.version,
    type: rootPackage.type,
    engines: rootPackage.engines,
    bin: rootPackage.bin,
    scripts: Object.fromEntries(runtimeScriptNames
      .filter((name) => typeof rootPackage.scripts?.[name] === "string")
      .map((name) => [name, rootPackage.scripts[name]])),
    ...(rootPackage.dependencies === undefined ? {} : { dependencies: rootPackage.dependencies }),
  };
  if (
    typeof runtimePackage.name !== "string"
    || typeof runtimePackage.version !== "string"
    || runtimePackage.type !== "module"
    || runtimePackage.engines?.node !== ">=22"
    || exactKeys(runtimePackage.bin, ["heige-codex-skin"]) === false
  ) throw new TypeError("root package.json 缺少受支持的 runtime 字段");
  consumeEntryBudget(budget);
  files.push({
    bytes: Buffer.from(`${JSON.stringify(runtimePackage, null, 2)}\n`, "utf8"),
    destination: archivePath("payload/package.json"),
  });
  if (files.length !== budget.count) throw new Error("package entry budget 计数不一致");
  files.sort((left, right) => left.destination < right.destination ? -1 : left.destination > right.destination ? 1 : 0);
  const seen = new Set();
  for (const file of files) {
    if (seen.has(file.destination)) throw new TypeError(`archive destination 重复：${file.destination}`);
    seen.add(file.destination);
  }
  return files;
}

async function readExact(handle, length, position, label) {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error(`${label} 截断`);
    offset += bytesRead;
  }
  return buffer;
}

async function writeExact(handle, buffer, position, label) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, position + offset);
    if (bytesWritten === 0) throw new Error(`${label} 写入失败`);
    offset += bytesWritten;
  }
}

function canonicalDosTimestamp(epoch) {
  const date = new Date(epoch * 1000);
  const time = (Math.floor(date.getUTCSeconds() / 2) & 0x1f)
    | ((date.getUTCMinutes() & 0x3f) << 5)
    | ((date.getUTCHours() & 0x1f) << 11);
  const day = (date.getUTCDate() & 0x1f)
    | (((date.getUTCMonth() + 1) & 0xf) << 5)
    | (((date.getUTCFullYear() - 1980) & 0x7f) << 9);
  const result = Buffer.allocUnsafe(4);
  result.writeUInt16LE(time, 0);
  result.writeUInt16LE(day, 2);
  return result;
}

function unixMtimeFromExtra(extra, label) {
  let timestamp = null;
  for (let cursor = 0; cursor < extra.length;) {
    if (cursor + 4 > extra.length) throw new Error(`${label} extra field 截断`);
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    const next = cursor + 4 + size;
    if (next > extra.length) throw new Error(`${label} extra field 长度无效`);
    if (id === 0x5455) {
      if (timestamp !== null || size !== 5 || extra[cursor + 4] !== 3) {
        throw new Error(`${label} extended timestamp 无效`);
      }
      timestamp = extra.readUInt32LE(cursor + 5);
    }
    cursor = next;
  }
  return timestamp;
}

async function normalizeZipDosTimestamps(path, epoch, files) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(path, fsConstants.O_RDWR | noFollow);
  try {
    const { size } = await handle.stat();
    if (!Number.isSafeInteger(size) || size < 22) throw new Error("ZIP archive size 无效");
    const tailLength = Math.min(size, 65_557);
    const tailPosition = size - tailLength;
    const tail = await readExact(handle, tailLength, tailPosition, "ZIP EOCD");
    let eocd = tail.length - 22;
    while (eocd >= 0 && tail.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
    if (eocd < 0) throw new Error("ZIP EOCD 缺失");

    const disk = tail.readUInt16LE(eocd + 4);
    const directoryDisk = tail.readUInt16LE(eocd + 6);
    const diskEntries = tail.readUInt16LE(eocd + 8);
    const entries = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    const commentLength = tail.readUInt16LE(eocd + 20);
    const absoluteEocd = tailPosition + eocd;
    if (
      disk !== 0
      || directoryDisk !== 0
      || diskEntries !== entries
      || entries !== files.length
      || entries > MAX_ARCHIVE_ENTRIES
      || entries === 0xffff
      || directorySize === 0xffffffff
      || directoryOffset === 0xffffffff
      || absoluteEocd + 22 + commentLength !== size
      || directoryOffset + directorySize !== absoluteEocd
    ) throw new Error("ZIP central directory 结构无效或需要 ZIP64");

    const timestamp = canonicalDosTimestamp(epoch);
    let cursor = directoryOffset;
    let expectedLocalOffset = 0;
    for (let index = 0; index < entries; index += 1) {
      const central = await readExact(handle, 46, cursor, `ZIP central entry ${index}`);
      if (central.readUInt32LE(0) !== 0x02014b50) throw new Error(`ZIP central entry ${index} signature 无效`);
      const centralFlags = central.readUInt16LE(8);
      const centralMethod = central.readUInt16LE(10);
      const centralCrc = central.readUInt32LE(16);
      const centralCompressedSize = central.readUInt32LE(20);
      const centralUncompressedSize = central.readUInt32LE(24);
      const nameLength = central.readUInt16LE(28);
      const extraLength = central.readUInt16LE(30);
      const entryCommentLength = central.readUInt16LE(32);
      const localOffset = central.readUInt32LE(42);
      const next = cursor + 46 + nameLength + extraLength + entryCommentLength;
      if (
        next > absoluteEocd
        || entryCommentLength !== 0
        || localOffset !== expectedLocalOffset
        || localOffset + 30 > directoryOffset
        || centralCompressedSize > MAX_ARCHIVE_INPUT_BYTES
        || centralUncompressedSize > MAX_ENTRY_BYTES
      ) {
        throw new Error(`ZIP entry ${index} 边界无效`);
      }
      const centralVariable = await readExact(
        handle,
        nameLength + extraLength,
        cursor + 46,
        `ZIP central entry ${index} metadata`,
      );
      const centralName = centralVariable.subarray(0, nameLength);
      const centralExtra = centralVariable.subarray(nameLength);
      const expectedName = Buffer.from(files[index].destination, "utf8");
      if (!centralName.equals(expectedName) || unixMtimeFromExtra(centralExtra, `ZIP central entry ${index}`) !== epoch) {
        throw new Error(`ZIP central entry ${index} 名称或 UTC 时间无效`);
      }

      const local = await readExact(handle, 30, localOffset, `ZIP local entry ${index}`);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`ZIP local entry ${index} signature 无效`);
      const localFlags = local.readUInt16LE(6);
      const localMethod = local.readUInt16LE(8);
      const localCrc = local.readUInt32LE(14);
      const localCompressedSize = local.readUInt32LE(18);
      const localUncompressedSize = local.readUInt32LE(22);
      const localNameLength = local.readUInt16LE(26);
      const localExtraLength = local.readUInt16LE(28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataOffset + localCompressedSize;
      if (
        centralFlags !== localFlags
        || (localFlags & 0x0008) !== 0
        || centralMethod !== localMethod
        || ![0, 8].includes(localMethod)
        || centralCrc !== localCrc
        || centralCompressedSize !== localCompressedSize
        || centralUncompressedSize !== localUncompressedSize
        || localNameLength !== nameLength
        || localExtraLength !== 0
        || dataEnd > directoryOffset
      ) throw new Error(`ZIP local entry ${index} 与 central directory 不一致`);
      const localName = await readExact(handle, localNameLength, localOffset + 30, `ZIP local entry ${index} name`);
      if (!localName.equals(centralName)) throw new Error(`ZIP entry ${index} 名称不一致`);
      await writeExact(handle, timestamp, localOffset + 10, `ZIP local timestamp ${index}`);
      await writeExact(handle, timestamp, cursor + 12, `ZIP central timestamp ${index}`);
      expectedLocalOffset = dataEnd;
      cursor = next;
    }
    if (cursor !== absoluteEocd || expectedLocalOffset !== directoryOffset) {
      throw new Error("ZIP central directory 或 local entries 长度不一致");
    }
  } finally {
    await handle.close();
  }
}

function pathIsWithin(rootPath, candidate) {
  const child = relative(resolve(rootPath), resolve(candidate));
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function assertOutputPolicy({ insideRepository, trackedAlias, allowTrackedOutput }) {
  if (!insideRepository) return;
  if (trackedAlias && allowTrackedOutput) return;
  if (trackedAlias) {
    throw new Error("tracked package output 仅可在 HEIGE_ALLOW_TRACKED_PACKAGE_OUTPUT=1 时刷新");
  }
  throw new Error("output 不得位于仓库根目录内");
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function nearestExistingDirectory(path) {
  let current = path;
  const missing = [];
  while (true) {
    try {
      await lstat(current, { bigint: true });
      const canonical = await realpath(current);
      const info = await lstat(canonical, { bigint: true });
      if (!info.isDirectory()) throw new Error("output ancestor 必须是目录");
      return { path: canonical, info, missing };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error("output parent 不存在且无法创建");
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

async function directoryHasAncestorIdentity(path, identity) {
  let current = path;
  while (true) {
    const canonical = await realpath(current);
    const info = await lstat(canonical, { bigint: true });
    if (!info.isDirectory()) throw new Error("output ancestor 必须是目录");
    if (sameFileIdentity(info, identity)) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function physicalOutputPolicy(output, allowTrackedOutput) {
  const [candidate, canonicalRoot, trackedParent] = await Promise.all([
    nearestExistingDirectory(dirname(output)),
    realpath(root),
    realpath(dirname(trackedOutput)),
  ]);
  const [rootInfo, trackedParentInfo] = await Promise.all([
    lstat(canonicalRoot, { bigint: true }),
    lstat(trackedParent, { bigint: true }),
  ]);
  if (!rootInfo.isDirectory() || !trackedParentInfo.isDirectory()) {
    throw new Error("repository output identity 无效");
  }
  const insideRepository = await directoryHasAncestorIdentity(candidate.path, rootInfo);
  const trackedAlias = candidate.missing.length === 0
    && sameFileIdentity(candidate.info, trackedParentInfo)
    && basename(output) === basename(trackedOutput);
  assertOutputPolicy({ insideRepository, trackedAlias, allowTrackedOutput });
  return candidate;
}

async function assertOutputParentUnchanged(output, capability) {
  const canonical = await realpath(dirname(output));
  const info = await lstat(canonical, { bigint: true });
  if (
    canonical !== capability.path
    || !info.isDirectory()
    || info.dev !== capability.dev
    || info.ino !== capability.ino
  ) throw new Error("output parent 在打包期间发生变化");
}

function archiveMode(destination) {
  return /\.(?:command|zsh)$/.test(destination) ? 0o100755 : 0o100644;
}

async function writeArchive(output, files, epoch, parentCapability) {
  await assertOutputParentUnchanged(output, parentCapability);
  const temporary = join(dirname(output), `.${output.split(sep).at(-1)}.${process.pid}.${Date.now()}.tmp`);
  const zip = new yazl.ZipFile();
  const sink = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  const writing = pipeline(zip.outputStream, sink);
  try {
    const options = {
      mtime: new Date(epoch * 1000),
      mode: 0o100644,
      compress: true,
      compressionLevel: 9,
    };
    let inputBytes = 0;
    for (const file of files) {
      const bytes = file.bytes ?? await readStableFile(file.source, relative(root, file.source));
      inputBytes += bytes.byteLength;
      if (!Number.isSafeInteger(inputBytes) || inputBytes > MAX_ARCHIVE_INPUT_BYTES) {
        throw new RangeError(`package input 超过 ${MAX_ARCHIVE_INPUT_BYTES} bytes`);
      }
      zip.addBuffer(bytes, file.destination, {
        ...options,
        mode: archiveMode(file.destination),
      });
    }
    zip.end();
    await writing;
    await normalizeZipDosTimestamps(temporary, epoch, files);
    await chmod(temporary, 0o644);
    await assertOutputParentUnchanged(output, parentCapability);
    await rename(temporary, output);
  } catch (error) {
    try { zip.end(); } catch {}
    await writing.catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function packageSkill(output, {
  sourceDateEpoch,
  allowTrackedOutput = process.env.HEIGE_ALLOW_TRACKED_PACKAGE_OUTPUT === "1",
} = {}) {
  if (typeof output !== "string" || !isAbsolute(output) || output.includes("\0")) {
    throw new TypeError("output 必须是非空绝对路径");
  }
  output = resolve(output);
  const epoch = parseEpoch(sourceDateEpoch);
  assertOutputPolicy({
    insideRepository: pathIsWithin(root, output),
    trackedAlias: output === resolve(trackedOutput),
    allowTrackedOutput,
  });
  await physicalOutputPolicy(output, allowTrackedOutput);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const parent = await physicalOutputPolicy(output, allowTrackedOutput);
  if (parent.missing.length !== 0) throw new Error("output parent 创建后仍不存在");
  const parentCapability = { path: parent.path, dev: parent.info.dev, ino: parent.info.ino };
  try {
    const outputInfo = await lstat(output, { bigint: true });
    if (outputInfo.isSymbolicLink() || !outputInfo.isFile()) throw new TypeError("output 现有目标必须是普通文件且不得是符号链接");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const manifest = parseManifest(JSON.parse((await readStableFile(manifestPath, "skill package manifest")).toString("utf8")));
  const files = await collectFiles(manifest, await trackedSourceIndex());
  await writeArchive(output, files, epoch, parentCapability);
  return output;
}

function parseArguments(argv, environment) {
  let output = null;
  let epoch = environment.SOURCE_DATE_EPOCH ?? null;
  let explicitEpoch = false;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || (flag !== "--output" && flag !== "--source-date-epoch")) {
      throw new TypeError("usage: package-skill.mjs --output /absolute/file.skill --source-date-epoch SECONDS");
    }
    if (flag === "--output") {
      if (output !== null) throw new TypeError("duplicate output argument");
      output = value;
    } else {
      if (explicitEpoch) throw new TypeError("duplicate source date epoch argument");
      explicitEpoch = true;
      epoch = value;
    }
  }
  if (output === null || epoch === null) throw new TypeError("output and source date epoch are required");
  return { output, epoch };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { output, epoch } = parseArguments(process.argv.slice(2), process.env);
    console.log(await packageSkill(output, { sourceDateEpoch: epoch }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 64;
  }
}
