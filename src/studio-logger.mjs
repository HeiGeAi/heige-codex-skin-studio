import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, sep } from "node:path";

const EVENT_CODE = /^[a-z][a-z0-9_.-]{0,63}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function requireInteger(value, name, { min, max }) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return value;
}

function pathSegments(path) {
  const root = parse(path).root;
  const result = [];
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    result.push(current);
  }
  return result;
}

async function assertNoSymlinkAncestors(path) {
  for (const current of pathSegments(path)) {
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) throw new Error(`日志路径祖先不得是符号链接：${current}`);
      if (!stats.isDirectory()) throw new Error(`日志路径祖先不是目录：${current}`);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }
}

async function ensurePrivateParent(path) {
  const parent = dirname(path);
  await assertNoSymlinkAncestors(parent);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const stats = await lstat(parent);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("日志目录类型无效");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("日志目录不属于当前用户");
  }
  await chmod(parent, 0o700);
  return parent;
}

async function inspectRegularFile(path) {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`日志文件类型无效：${path}`);
    }
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw new Error(`日志文件不属于当前用户：${path}`);
    }
    return stats;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function unlinkRegularIfPresent(path) {
  if (await inspectRegularFile(path) === null) return;
  await unlink(path);
}

async function rotate(path, backups) {
  if (backups === 0) {
    await unlinkRegularIfPresent(path);
    return;
  }
  await unlinkRegularIfPresent(`${path}.${backups}`);
  for (let index = backups - 1; index >= 1; index -= 1) {
    const source = `${path}.${index}`;
    if (await inspectRegularFile(source) === null) continue;
    await rename(source, `${path}.${index + 1}`);
  }
  if (await inspectRegularFile(path) !== null) await rename(path, `${path}.1`);
}

function readOnce(object, key) {
  try { return object?.[key]; } catch { return undefined; }
}

function sanitizedCode(error) {
  const code = readOnce(error, "code");
  return typeof code === "string" && ERROR_CODE.test(code) ? code : null;
}

function sanitizedMessage(value, redact, maxLength) {
  let message;
  if (typeof value === "string") message = value;
  else {
    const candidate = readOnce(value, "message");
    message = typeof candidate === "string" ? candidate : String(value ?? "");
  }
  return redact(message).replace(/[\r\n\t]+/g, " ").slice(0, maxLength);
}

function timestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("日志时间无效");
  return date.toISOString();
}

function buildRedactor({ token, home, sensitiveValues }) {
  const secrets = [token, ...sensitiveValues]
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.length - left.length);
  return (input) => {
    let output = String(input);
    if (home) output = output.split(home).join("~");
    for (const secret of secrets) output = output.split(secret).join("[已隐去]");
    return output;
  };
}

async function appendSecure(path, line) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(
    path,
    fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("日志目标不是普通文件");
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw new Error("日志文件不属于当前用户");
    }
    await handle.chmod(0o600);
    await handle.writeFile(line, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function createStudioLogger({
  path,
  token = "",
  home = homedir(),
  sensitiveValues = [],
  maxBytes = 1024 * 1024,
  backups = 3,
  now = () => new Date(),
} = {}) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error("日志 path 必须是绝对路径");
  }
  if (typeof token !== "string") throw new Error("token 必须是字符串");
  if (typeof home !== "string") throw new Error("home 必须是字符串");
  if (!Array.isArray(sensitiveValues) || sensitiveValues.some((value) => typeof value !== "string")) {
    throw new Error("sensitiveValues 必须是字符串数组");
  }
  if (typeof now !== "function") throw new Error("now 必须是函数");
  maxBytes = requireInteger(maxBytes, "maxBytes", { min: 128, max: 64 * 1024 * 1024 });
  backups = requireInteger(backups, "backups", { min: 0, max: 10 });

  const redact = buildRedactor({ token, home, sensitiveValues });
  const messageLimit = Math.max(16, Math.min(4096, Math.floor(maxBytes / 2)));
  let tail = Promise.resolve();

  const write = (level, event, value, code = null) => {
    if (!EVENT_CODE.test(event)) return Promise.resolve(false);
    const operation = tail.then(async () => {
      try {
        const entry = {
          timestamp: timestamp(now),
          level,
          event,
          code,
          message: sanitizedMessage(value, redact, messageLimit),
        };
        let line = `${JSON.stringify(entry)}\n`;
        if (Buffer.byteLength(line) > maxBytes) {
          entry.message = "[日志条目过长，已截断]";
          line = `${JSON.stringify(entry)}\n`;
        }
        if (Buffer.byteLength(line) > maxBytes) return false;

        await ensurePrivateParent(path);
        const current = await inspectRegularFile(path);
        if (current !== null && current.size + Buffer.byteLength(line) > maxBytes) {
          await rotate(path, backups);
        }
        await appendSecure(path, line);
        return true;
      } catch {
        return false;
      }
    });
    tail = operation.then(() => undefined, () => undefined);
    return operation;
  };

  return Object.freeze({
    info: (event, message = "") => write("info", event, message),
    warn: (event, message = "") => write("warn", event, message),
    error: (event, error) => write("error", event, error, sanitizedCode(error)),
  });
}
