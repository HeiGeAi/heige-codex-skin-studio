import { RESOURCE_LIMITS } from "./resource-limits.mjs";

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

function asBytes(input) {
  if (input instanceof Uint8Array) {
    return input;
  }
  throw new TypeError("图片必须是 Uint8Array 或 Buffer");
}

function matches(bytes, offset, expected) {
  if (offset + expected.length > bytes.byteLength) {
    return false;
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected[index]) {
      return false;
    }
  }
  return true;
}

function ascii(bytes, offset, length) {
  if (offset < 0 || length < 0 || offset + length > bytes.byteLength) {
    throw new RangeError("图片 header 已截断");
  }
  let result = "";
  for (let index = 0; index < length; index += 1) {
    result += String.fromCharCode(bytes[offset + index]);
  }
  return result;
}

function readUInt16BE(bytes, offset) {
  if (offset + 2 > bytes.byteLength) {
    throw new RangeError("图片 header 已截断");
  }
  return (bytes[offset] * 0x100) + bytes[offset + 1];
}

function readUInt16LE(bytes, offset) {
  if (offset + 2 > bytes.byteLength) {
    throw new RangeError("图片 header 已截断");
  }
  return bytes[offset] + (bytes[offset + 1] * 0x100);
}

function readUInt24LE(bytes, offset) {
  if (offset + 3 > bytes.byteLength) {
    throw new RangeError("图片 header 已截断");
  }
  return bytes[offset] + (bytes[offset + 1] * 0x100) + (bytes[offset + 2] * 0x10000);
}

function readUInt32BE(bytes, offset) {
  if (offset + 4 > bytes.byteLength) {
    throw new RangeError("图片 header 已截断");
  }
  return (bytes[offset] * 0x1000000)
    + (bytes[offset + 1] * 0x10000)
    + (bytes[offset + 2] * 0x100)
    + bytes[offset + 3];
}

function readUInt32LE(bytes, offset) {
  if (offset + 4 > bytes.byteLength) {
    throw new RangeError("图片 header 已截断");
  }
  return (bytes[offset]
    + (bytes[offset + 1] * 0x100)
    + (bytes[offset + 2] * 0x10000)
    + (bytes[offset + 3] * 0x1000000)) >>> 0;
}

function dimensions(mime, width, height, format) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`${format} 图片尺寸无效`);
  }
  return { mime, width, height };
}

function parsePng(bytes) {
  if (bytes.byteLength < 24) {
    throw new RangeError("PNG header 已截断");
  }
  if (readUInt32BE(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== "IHDR") {
    throw new TypeError("PNG 缺少有效 IHDR header");
  }
  return dimensions("image/png", readUInt32BE(bytes, 16), readUInt32BE(bytes, 20), "PNG");
}

function parseJpeg(bytes) {
  let offset = 2;
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      throw new TypeError("JPEG marker header 无效");
    }
    while (offset < bytes.byteLength && bytes[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= bytes.byteLength) {
      throw new RangeError("JPEG header 已截断");
    }

    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x00) {
      throw new TypeError("JPEG marker header 无效");
    }
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }

    const segmentLength = readUInt16BE(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) {
      throw new RangeError("JPEG segment header 已截断");
    }
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 7) {
        throw new RangeError("JPEG SOF header 已截断");
      }
      return dimensions(
        "image/jpeg",
        readUInt16BE(bytes, offset + 5),
        readUInt16BE(bytes, offset + 3),
        "JPEG",
      );
    }
    offset += segmentLength;
  }
  throw new TypeError("JPEG 缺少尺寸 SOF header");
}

function parseWebp(bytes) {
  if (bytes.byteLength < 20 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
    throw new TypeError("WebP RIFF header 无效");
  }
  const riffEnd = readUInt32LE(bytes, 4) + 8;
  if (riffEnd < 20 || riffEnd > bytes.byteLength) {
    throw new RangeError("WebP RIFF header 已截断");
  }

  let offset = 12;
  while (offset + 8 <= riffEnd) {
    const chunkType = ascii(bytes, offset, 4);
    const chunkLength = readUInt32LE(bytes, offset + 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + chunkLength;
    if (!Number.isSafeInteger(dataEnd) || dataEnd > riffEnd) {
      throw new RangeError("WebP chunk header 已截断");
    }

    if (chunkType === "VP8X") {
      if (chunkLength < 10) {
        throw new RangeError("WebP VP8X header 已截断");
      }
      return dimensions(
        "image/webp",
        readUInt24LE(bytes, dataOffset + 4) + 1,
        readUInt24LE(bytes, dataOffset + 7) + 1,
        "WebP",
      );
    }
    if (chunkType === "VP8L") {
      if (chunkLength < 5 || bytes[dataOffset] !== 0x2f) {
        throw new TypeError("WebP VP8L header 无效");
      }
      const first = bytes[dataOffset + 1];
      const second = bytes[dataOffset + 2];
      const third = bytes[dataOffset + 3];
      const fourth = bytes[dataOffset + 4];
      return dimensions(
        "image/webp",
        1 + first + ((second & 0x3f) << 8),
        1 + ((second & 0xc0) >>> 6) + (third << 2) + ((fourth & 0x0f) << 10),
        "WebP",
      );
    }
    if (chunkType === "VP8 ") {
      if (
        chunkLength < 10
        || bytes[dataOffset + 3] !== 0x9d
        || bytes[dataOffset + 4] !== 0x01
        || bytes[dataOffset + 5] !== 0x2a
      ) {
        throw new TypeError("WebP VP8 header 无效");
      }
      return dimensions(
        "image/webp",
        readUInt16LE(bytes, dataOffset + 6) & 0x3fff,
        readUInt16LE(bytes, dataOffset + 8) & 0x3fff,
        "WebP",
      );
    }

    offset = dataEnd + (chunkLength & 1);
  }
  throw new TypeError("WebP 缺少受支持的尺寸 header");
}

export function parseImageMetadata(input) {
  const bytes = asBytes(input);
  if (matches(bytes, 0, PNG_SIGNATURE)) {
    return parsePng(bytes);
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return parseJpeg(bytes);
  }
  if (bytes.byteLength >= 4 && ascii(bytes, 0, 4) === "RIFF") {
    return parseWebp(bytes);
  }
  throw new TypeError("不支持或无法识别的图片 header");
}

export function validateImageMetadata(
  input,
  {
    expectedMime,
    limits = RESOURCE_LIMITS,
  } = {},
) {
  const bytes = asBytes(input);
  if (bytes.byteLength > limits.assetBytes) {
    throw new RangeError(`图片超过 ${limits.assetBytes} bytes`);
  }

  const metadata = parseImageMetadata(bytes);
  if (expectedMime !== undefined && metadata.mime !== expectedMime) {
    throw new TypeError(`MIME 不匹配：期望 ${expectedMime}，实际 ${metadata.mime}`);
  }
  if (metadata.width > limits.imageWidth) {
    throw new RangeError(`图片宽度 width 超过 ${limits.imageWidth}`);
  }
  if (metadata.height > limits.imageHeight) {
    throw new RangeError(`图片高度 height 超过 ${limits.imageHeight}`);
  }
  if (metadata.width > Math.floor(limits.imagePixels / metadata.height)) {
    throw new RangeError(`图片像素 pixel 总数超过 ${limits.imagePixels}`);
  }
  const shorter = Math.min(metadata.width, metadata.height);
  const longer = Math.max(metadata.width, metadata.height);
  if (longer > shorter * limits.aspectRatio) {
    throw new RangeError(`图片纵横比 aspect ratio 超过 ${limits.aspectRatio}:1`);
  }
  return metadata;
}
