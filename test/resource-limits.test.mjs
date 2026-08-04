import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RESOURCE_LIMITS,
  fitProcessedCanvas,
  parseBoundedJson,
  readBoundedFile,
  sumWithinLimit,
} from "../src/resource-limits.mjs";

test("exports the approved immutable resource budget", () => {
  assert.deepEqual(RESOURCE_LIMITS, {
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
  assert.equal(Object.isFrozen(RESOURCE_LIMITS), true);
});

test("bounded JSON accepts exact bytes and depth then rejects plus one", () => {
  const exactDepth = JSON.stringify({ a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: { l: 1 } } } } } } } } } } } });
  assert.equal(parseBoundedJson(Buffer.from(exactDepth), { maxDepth: 12 }).a.b.c.d.e.f.g.h.i.j.k.l, 1);
  const tooDeep = JSON.stringify({ a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: { l: { m: 1 } } } } } } } } } } } } });
  assert.throws(() => parseBoundedJson(Buffer.from(tooDeep), { maxDepth: 12 }), /depth|12/i);

  const exactBytes = Buffer.from(`"${"x".repeat(RESOURCE_LIMITS.manifestBytes - 2)}"`);
  assert.equal(parseBoundedJson(exactBytes).length, RESOURCE_LIMITS.manifestBytes - 2);
  assert.throws(() => parseBoundedJson(Buffer.concat([exactBytes, Buffer.from(" ")])), /65536|64 KiB/);
  assert.throws(() => parseBoundedJson(Buffer.from([0xff])), /UTF-8/);
});

test("sumWithinLimit rejects overflow and unsafe integer input", () => {
  assert.equal(sumWithinLimit([8, 8], 16, "theme"), 16);
  assert.throws(() => sumWithinLimit([8, 9], 16, "theme"), /theme.*16/);
  assert.equal(
    sumWithinLimit(
      [RESOURCE_LIMITS.themeBytes, RESOURCE_LIMITS.themeBytes, RESOURCE_LIMITS.themeBytes],
      RESOURCE_LIMITS.menuBytes,
      "menu",
    ),
    RESOURCE_LIMITS.menuBytes,
  );
  assert.throws(
    () => sumWithinLimit([RESOURCE_LIMITS.menuBytes, 1], RESOURCE_LIMITS.menuBytes, "menu"),
    /menu.*204472320/,
  );
  assert.throws(() => sumWithinLimit([Number.MAX_SAFE_INTEGER, 1], Number.MAX_SAFE_INTEGER, "theme"), /安全整数/);
  assert.throws(() => sumWithinLimit([-1], 16, "theme"), /非负/);
});

test("processed canvas scaling satisfies both side and total-pixel budgets", () => {
  assert.deepEqual(fitProcessedCanvas(4000, 1000), { width: 2000, height: 500, scale: 0.5 });
  const square = fitProcessedCanvas(8000, 8000);
  assert.ok(square.width <= 2048 && square.height <= 2048);
  assert.ok(square.width * square.height <= 4_000_000);
  const vertical = fitProcessedCanvas(81, 8100);
  assert.ok(vertical.width <= 2048 && vertical.height <= 2048);
  assert.ok(vertical.width * vertical.height <= 4_000_000);
  assert.ok(vertical.height / vertical.width <= 100);
  assert.throws(() => fitProcessedCanvas(0, 10), /正整数/);
});

test("bounded file reads exact bytes and rejects plus one or final symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "heige-bounded-file-"));
  try {
    const exact = join(root, "exact.bin");
    await writeFile(exact, Buffer.alloc(8, 7));
    assert.equal((await readBoundedFile(exact, { maxBytes: 8 })).bytes.byteLength, 8);

    const oversized = join(root, "oversized.bin");
    await writeFile(oversized, Buffer.alloc(9, 7));
    await assert.rejects(readBoundedFile(oversized, { maxBytes: 8, label: "asset" }), /asset.*8/);
    assert.equal(
      (await readBoundedFile(oversized, { maxBytes: null, label: "video" })).bytes.byteLength,
      9,
    );

    if (process.platform !== "win32") {
      const linked = join(root, "linked.bin");
      await symlink(exact, linked);
      await assert.rejects(readBoundedFile(linked, { maxBytes: 8 }), /ELOOP|symbolic|symlink/i);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
