#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "<!-- heige-package-sha256 --> Package SHA-256: ";
const MARKER_PATTERN = /^<!-- heige-package-sha256 --> Package SHA-256: (?:pending final build|[a-f0-9]{64})$/gm;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_DISPOSITION_BYTES = 2 * 1024 * 1024;

function requirePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} 必须是非空文件路径`);
  }
  return resolve(value);
}

async function readStableRegular(path, label, maxBytes) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(maxBytes)) {
      throw new Error(`${label} 必须是非空普通文件且不得超过 ${maxBytes} bytes`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || BigInt(bytes.byteLength) !== before.size
    ) throw new Error(`${label} 在读取期间发生变化`);
    return { bytes, snapshot: before };
  } finally {
    await handle.close();
  }
}

function sameSnapshot(info, snapshot) {
  return info.dev === snapshot.dev
    && info.ino === snapshot.ino
    && info.size === snapshot.size
    && info.mtimeNs === snapshot.mtimeNs;
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } catch (error) {
    // Windows permits opening directories but does not support fsync on them.
    // The file itself was already synced before the atomic rename.
    if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error?.code)) throw error;
  } finally {
    await handle.close();
  }
}

export async function updateReleaseHash({ artifact, disposition } = {}) {
  artifact = requirePath(artifact, "artifact");
  disposition = requirePath(disposition, "disposition");
  const artifactInfo = await lstat(artifact);
  const dispositionInfo = await lstat(disposition);
  if (artifactInfo.isSymbolicLink() || !artifactInfo.isFile()) {
    throw new Error("artifact 必须是普通文件且不得是符号链接");
  }
  if (dispositionInfo.isSymbolicLink() || !dispositionInfo.isFile()) {
    throw new Error("disposition 必须是普通文件且不得是符号链接");
  }
  const [{ bytes: artifactBytes }, { bytes: dispositionBytes, snapshot }] = await Promise.all([
    readStableRegular(artifact, "artifact", MAX_ARTIFACT_BYTES),
    readStableRegular(disposition, "disposition", MAX_DISPOSITION_BYTES),
  ]);
  const digest = createHash("sha256").update(artifactBytes).digest("hex");
  const text = dispositionBytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(dispositionBytes)) {
    throw new Error("disposition 不是有效 UTF-8 文本");
  }
  const markers = text.match(MARKER_PATTERN) ?? [];
  if (markers.length !== 1) {
    throw new Error(`disposition 必须恰好包含一个 ${MARKER.trim()} marker`);
  }
  const updated = text.replace(MARKER_PATTERN, `${MARKER}${digest}`);
  const temporary = `${disposition}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, updated, {
      encoding: "utf8",
      flag: "wx",
      mode: dispositionInfo.mode & 0o777,
    });
    await chmod(temporary, dispositionInfo.mode & 0o777);
    const temporaryHandle = await open(temporary, "r+");
    try { await temporaryHandle.sync(); } finally { await temporaryHandle.close(); }
    const current = await stat(disposition, { bigint: true });
    if (!sameSnapshot(current, snapshot)) {
      throw new Error("disposition 在更新期间发生变化");
    }
    await rename(temporary, disposition);
    await syncDirectory(dirname(disposition));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return digest;
}

function parseArguments(argv) {
  if (argv.length !== 4 || argv[0] !== "--artifact" || argv[2] !== "--disposition") {
    throw new Error("usage: update-release-hash.mjs --artifact FILE --disposition FILE");
  }
  return { artifact: argv[1], disposition: argv[3] };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
}

if (isMainModule()) {
  try {
    const digest = await updateReleaseHash(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${digest}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
