import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";

export const RESOURCE_LIMITS = Object.freeze({
  manifestBytes: 64 * 1024,
  jsonDepth: 12,
  assetBytes: 64 * 1024 * 1024,
  themeBytes: 65 * 1024 * 1024,
  menuBytes: 195 * 1024 * 1024,
  imageWidth: 8192,
  imageHeight: 8192,
  imagePixels: 32_000_000,
  aspectRatio: 100,
  processedCanvasSide: 2048,
  processedCanvasPixels: 4_000_000,
  browserOperationMs: 5000,
});

export async function readBoundedFile(
  path,
  {
    maxBytes,
    label = "文件",
    requireNonEmpty = true,
  },
) {
  if (maxBytes !== null) requireNonNegativeSafeInteger(maxBytes, label + "字节上限");
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError(label + "路径无效");
  }
  const noFollow = Number.isInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new TypeError(label + "必须是普通文件");
    if (!Number.isSafeInteger(info.size) || info.size < 0) throw new RangeError(label + "大小无效");
    if (maxBytes !== null && info.size > maxBytes) {
      throw new RangeError(label + "超过 " + maxBytes + " bytes");
    }

    const allocation = maxBytes === null ? info.size : maxBytes;
    const buffer = Buffer.allocUnsafe(allocation);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (maxBytes !== null && offset > maxBytes) throw new RangeError(label + "超过 " + maxBytes + " bytes");
    if (offset !== info.size) throw new Error(label + "在读取期间发生变化");
    if (requireNonEmpty && offset === 0) throw new RangeError(label + "不能为空");
    return { bytes: Buffer.from(buffer.subarray(0, offset)), stat: info };
  } finally {
    await handle.close();
  }
}

function requireNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label}必须是安全整数`);
  }
  if (value < 0) {
    throw new RangeError(`${label}必须是非负数`);
  }
}

function asBytes(input) {
  if (input instanceof Uint8Array) {
    return input;
  }
  throw new TypeError("JSON 输入必须是 Uint8Array 或 Buffer");
}

function assertJsonDepth(value, maxDepth) {
  if (value === null || typeof value !== "object") {
    return;
  }

  const stack = [{ value, depth: 1 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.depth > maxDepth) {
      throw new RangeError(`JSON nesting depth exceeds ${maxDepth}`);
    }
    for (const child of Object.values(current.value)) {
      if (child !== null && typeof child === "object") {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

export function parseBoundedJson(
  input,
  {
    maxBytes = RESOURCE_LIMITS.manifestBytes,
    maxDepth = RESOURCE_LIMITS.jsonDepth,
  } = {},
) {
  requireNonNegativeSafeInteger(maxBytes, "JSON 字节上限");
  requireNonNegativeSafeInteger(maxDepth, "JSON 深度上限");
  if (maxDepth < 1) {
    throw new RangeError("JSON 深度上限必须是正整数");
  }

  const bytes = asBytes(input);
  if (bytes.byteLength > maxBytes) {
    throw new RangeError(`JSON exceeds ${maxBytes} bytes (64 KiB manifest limit)`);
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SyntaxError("JSON 不是有效的 UTF-8");
  }

  const value = JSON.parse(text);
  assertJsonDepth(value, maxDepth);
  return value;
}

export function sumWithinLimit(values, limit, label = "总大小") {
  requireNonNegativeSafeInteger(limit, `${label}上限`);
  let total = 0;
  for (const value of values) {
    requireNonNegativeSafeInteger(value, `${label}项目`);
    if (value > Number.MAX_SAFE_INTEGER - total) {
      throw new RangeError(`${label}总和超出安全整数范围`);
    }
    total += value;
    if (total > limit) {
      throw new RangeError(`${label} total ${total} exceeds limit ${limit}`);
    }
  }
  return total;
}

export function fitProcessedCanvas(
  width,
  height,
  {
    side = RESOURCE_LIMITS.processedCanvasSide,
    pixels = RESOURCE_LIMITS.processedCanvasPixels,
  } = {},
) {
  for (const [value, label] of [[width, "宽度"], [height, "高度"], [side, "边长上限"], [pixels, "像素上限"]]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${label}必须是正整数`);
    }
  }

  const sideFactor = Math.max(Math.ceil(width / side), Math.ceil(height / side));
  const pixelFactor = Math.ceil(Math.sqrt((width / pixels) * height));
  let factor = Math.max(1, sideFactor, pixelFactor);
  while (true) {
    const outputWidth = Math.max(1, Math.ceil(width / factor));
    const outputHeight = Math.max(1, Math.ceil(height / factor));
    if (
      outputWidth <= side
      && outputHeight <= side
      && outputWidth <= Math.floor(pixels / outputHeight)
    ) {
      return { width: outputWidth, height: outputHeight, scale: 1 / factor };
    }
    factor += 1;
  }
}
