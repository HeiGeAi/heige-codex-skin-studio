import assert from "node:assert/strict";
import test from "node:test";

import {
  parseImageMetadata,
  validateImageMetadata,
} from "../src/image-metadata.mjs";
import { RESOURCE_LIMITS } from "../src/resource-limits.mjs";

function png(width, height, bytes = 24) {
  const result = Buffer.alloc(Math.max(bytes, 24));
  Buffer.from("89504e470d0a1a0a", "hex").copy(result, 0);
  result.writeUInt32BE(13, 8);
  result.write("IHDR", 12, "ascii");
  result.writeUInt32BE(width, 16);
  result.writeUInt32BE(height, 20);
  return result;
}

function jpeg(width, height) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc2, 0x00, 0x0b, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00,
  ]);
}

function webpVp8x(width, height) {
  const result = Buffer.alloc(30);
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(22, 4);
  result.write("WEBPVP8X", 8, "ascii");
  result.writeUInt32LE(10, 16);
  result.writeUIntLE(width - 1, 24, 3);
  result.writeUIntLE(height - 1, 27, 3);
  return result;
}

function webpVp8l(width, height) {
  const result = Buffer.alloc(25);
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(17, 4);
  result.write("WEBPVP8L", 8, "ascii");
  result.writeUInt32LE(5, 16);
  result[20] = 0x2f;
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  result[21] = widthMinusOne & 0xff;
  result[22] = ((widthMinusOne >>> 8) & 0x3f) | ((heightMinusOne & 0x03) << 6);
  result[23] = (heightMinusOne >>> 2) & 0xff;
  result[24] = (heightMinusOne >>> 10) & 0x0f;
  return result;
}

function webpVp8(width, height) {
  const result = Buffer.alloc(30);
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(22, 4);
  result.write("WEBPVP8 ", 8, "ascii");
  result.writeUInt32LE(10, 16);
  result[23] = 0x9d;
  result[24] = 0x01;
  result[25] = 0x2a;
  result.writeUInt16LE(width, 26);
  result.writeUInt16LE(height, 28);
  return result;
}

test("parses PNG JPEG and all supported WebP dimension headers", () => {
  assert.deepEqual(parseImageMetadata(png(488, 137)), {
    mime: "image/png", width: 488, height: 137,
  });
  assert.deepEqual(parseImageMetadata(jpeg(1920, 1080)), {
    mime: "image/jpeg", width: 1920, height: 1080,
  });
  assert.deepEqual(parseImageMetadata(webpVp8x(2048, 1024)), {
    mime: "image/webp", width: 2048, height: 1024,
  });
  assert.deepEqual(parseImageMetadata(webpVp8l(321, 123)), {
    mime: "image/webp", width: 321, height: 123,
  });
  assert.deepEqual(parseImageMetadata(webpVp8(640, 360)), {
    mime: "image/webp", width: 640, height: 360,
  });
});

test("rejects unsupported malformed and truncated image headers", () => {
  for (const bytes of [
    Buffer.from("not an image"),
    png(1, 1).subarray(0, 23),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x20]),
    webpVp8x(2, 2).subarray(0, 29),
    Buffer.from("524946460000000057454250", "hex"),
  ]) {
    assert.throws(() => parseImageMetadata(bytes), /图片|PNG|JPEG|WebP|header/i);
  }
});

test("validates MIME bytes dimensions pixels and aspect ratio at exact boundaries", () => {
  assert.equal(validateImageMetadata(png(8192, 82), { expectedMime: "image/png" }).width, 8192);
  assert.equal(validateImageMetadata(png(1000, 10), { expectedMime: "image/png" }).height, 10);
  assert.throws(() => validateImageMetadata(png(8193, 82)), /宽度|width/i);
  assert.throws(() => validateImageMetadata(png(82, 8193)), /高度|height/i);
  assert.throws(() => validateImageMetadata(png(8000, 8000)), /像素|pixel/i);
  assert.throws(() => validateImageMetadata(png(1001, 10)), /纵横比|aspect/i);
  assert.throws(
    () => validateImageMetadata(png(10, 10), { expectedMime: "image/jpeg" }),
    /MIME|image\/jpeg.*image\/png/i,
  );
});

test("rejects image assets above the configured resource budget before returning metadata", () => {
  const exact = png(10, 10, RESOURCE_LIMITS.assetBytes);
  assert.equal(validateImageMetadata(exact).mime, "image/png");
  const tooLarge = png(10, 10, RESOURCE_LIMITS.assetBytes + 1);
  assert.throws(() => validateImageMetadata(tooLarge), /64 MiB|67108864/);
});
