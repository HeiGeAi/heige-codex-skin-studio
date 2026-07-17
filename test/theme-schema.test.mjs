import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadTheme, validateThemeManifest } from "../src/theme-schema.mjs";

const minimalManifest = {
  schemaVersion: 1,
  id: "miku-488137",
  name: "Miku 488137",
  hero: "hero.png",
};

function png(width, height, bytes = 24) {
  const result = Buffer.alloc(Math.max(bytes, 24));
  Buffer.from("89504e470d0a1a0a", "hex").copy(result, 0);
  result.writeUInt32BE(13, 8);
  result.write("IHDR", 12, "ascii");
  result.writeUInt32BE(width, 16);
  result.writeUInt32BE(height, 20);
  return result;
}

function manifestBytes(targetBytes, overrides = {}) {
  const input = { ...minimalManifest, ...overrides, padding: "" };
  const empty = Buffer.byteLength(JSON.stringify(input));
  assert.ok(empty <= targetBytes);
  input.padding = "x".repeat(targetBytes - empty);
  const encoded = Buffer.from(JSON.stringify(input));
  assert.equal(encoded.byteLength, targetBytes);
  return encoded;
}

async function withTheme(manifest, callback) {
  const root = await mkdtemp(join(tmpdir(), "heige-theme-"));
  try {
    await writeFile(join(root, "theme.json"), JSON.stringify(manifest));
    return await callback(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("normalizes the minimal theme and supplies color defaults", () => {
  assert.deepEqual(validateThemeManifest(minimalManifest), {
    schemaVersion: 1,
    id: "miku-488137",
    name: "Miku 488137",
    hero: "hero.png",
    logo: null,
    polaroid: null,
    cardArtwork: null,
    colors: {
      accent: "#4BC2E0",
      secondary: "#AD7ED5",
      surface: "#FAFAFF",
      text: "#122C60",
    },
    copy: null,
  });
});

test("merges optional colors and preserves optional copy", () => {
  const copy = { headline: "我们今天来构什么？" };
  const result = validateThemeManifest({
    ...minimalManifest,
    colors: { accent: "#19c9e5" },
    copy,
  });

  assert.deepEqual(result.colors, {
    accent: "#19C9E5",
    secondary: "#AD7ED5",
    surface: "#FAFAFF",
    text: "#122C60",
  });
  assert.deepEqual(result.copy, copy);
  assert.throws(
    () => validateThemeManifest({ ...minimalManifest, copy: "headline" }),
    /theme copy must be null or an object/,
  );
  assert.throws(
    () =>
      validateThemeManifest({
        ...minimalManifest,
        copy: { headline: 488137 },
      }),
    /copy\.headline must be a string/,
  );
});

test("rejects malformed core fields and colors", () => {
  assert.throws(
    () => validateThemeManifest({ ...minimalManifest, schemaVersion: 2 }),
    /unsupported theme schema/,
  );
  assert.throws(
    () => validateThemeManifest({ ...minimalManifest, id: "Miku Theme" }),
    /theme id/,
  );
  assert.throws(
    () => validateThemeManifest({ ...minimalManifest, id: 488137 }),
    /theme id/,
  );
  assert.throws(
    () => validateThemeManifest({ ...minimalManifest, name: "" }),
    /theme name/,
  );
  assert.throws(
    () =>
      validateThemeManifest({
        ...minimalManifest,
        colors: { accent: "cyan" },
      }),
    /hex color/,
  );
  assert.throws(
    () =>
      validateThemeManifest({
        ...minimalManifest,
        colors: { accent: null },
      }),
    /hex color/,
  );
});

test("rejects unsafe or unsupported hero paths", () => {
  for (const hero of ["/tmp/hero.png", "../hero.png", "art/../../hero.png"])
    assert.throws(
      () => validateThemeManifest({ ...minimalManifest, hero }),
      /relative path inside the theme directory/,
    );

  assert.throws(
    () => validateThemeManifest({ ...minimalManifest, hero: "hero.gif" }),
    /PNG, JPEG, or WebP/,
  );
});

test("loads one existing non-empty hero", async () => {
  await withTheme(
    { ...minimalManifest, hero: "images/hero.webp" },
    async (root) => {
      await mkdir(join(root, "images"));
      const image = Buffer.alloc(30);
      image.write("RIFF", 0, "ascii");
      image.writeUInt32LE(22, 4);
      image.write("WEBPVP8X", 8, "ascii");
      image.writeUInt32LE(10, 16);
      image.writeUIntLE(487, 24, 3);
      image.writeUIntLE(136, 27, 3);
      await writeFile(join(root, "images/hero.webp"), image);

      const theme = await loadTheme(root);

      assert.equal(theme.root, root);
      assert.equal(theme.heroPath, join(root, "images/hero.webp"));
      assert.equal(theme.manifest.hero, "images/hero.webp");
      assert.equal(theme.assetBuffers.hero.byteLength, image.byteLength);
      assert.deepEqual(theme.assetMetadata.hero, {
        mime: "image/webp",
        width: 488,
        height: 137,
      });
    },
  );
});

test("loads optional signature-card artwork inside the theme budget", async () => {
  await withTheme({
    ...minimalManifest,
    cardArtwork: "card.png",
  }, async (root) => {
    const hero = png(1600, 900);
    const cardArtwork = png(480, 600);
    await writeFile(join(root, "hero.png"), hero);
    await writeFile(join(root, "card.png"), cardArtwork);

    const theme = await loadTheme(root);

    assert.equal(theme.manifest.cardArtwork, "card.png");
    assert.equal(theme.cardArtworkPath, join(root, "card.png"));
    assert.deepEqual(theme.assetMetadata.cardArtwork, {
      mime: "image/png",
      width: 480,
      height: 600,
    });
    assert.deepEqual(theme.assetBuffers.cardArtwork, cardArtwork);
  });
});

test("rejects unsafe or unsupported signature-card artwork paths", () => {
  for (const cardArtwork of ["/tmp/card.png", "../card.png", "art/../../card.png"]) {
    assert.throws(
      () => validateThemeManifest({ ...minimalManifest, cardArtwork }),
      /relative path inside the theme directory/,
    );
  }
  assert.throws(
    () => validateThemeManifest({ ...minimalManifest, cardArtwork: "card.gif" }),
    /PNG, JPEG, or WebP/,
  );
});

test("rejects invalid signature-card artwork files", async () => {
  await withTheme({
    ...minimalManifest,
    cardArtwork: "card.png",
  }, async (root) => {
    await writeFile(join(root, "hero.png"), png(1600, 900));
    await writeFile(join(root, "card.png"), png(8193, 100));
    await assert.rejects(loadTheme(root), /宽度|width/i);
    await writeFile(join(root, "card.png"), "");
    await assert.rejects(loadTheme(root), /cardArtwork.*non-empty|cardArtwork不能为空|图片/i);
  });
});

test("rejects signature-card artwork reached through a symlink outside the theme", async () => {
  const outside = await mkdtemp(join(tmpdir(), "outside-card-artwork-"));
  try {
    await writeFile(join(outside, "card.png"), png(480, 600));
    await withTheme(
      { ...minimalManifest, cardArtwork: "images/card.png" },
      async (root) => {
        await writeFile(join(root, "hero.png"), png(1600, 900));
        await symlink(outside, join(root, "images"));
        await assert.rejects(loadTheme(root), /escapes the theme directory/);
      },
    );
  } finally {
    await rm(outside, { force: true, recursive: true });
  }
});

test("enforces manifest bytes and nesting before resolving assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "heige-theme-budget-"));
  try {
    await writeFile(join(root, "hero.png"), png(100, 100));
    await writeFile(join(root, "theme.json"), manifestBytes(64 * 1024));
    assert.equal((await loadTheme(root)).manifest.id, minimalManifest.id);

    await writeFile(join(root, "theme.json"), manifestBytes((64 * 1024) + 1));
    await assert.rejects(loadTheme(root), /65536|64 KiB/);

    let nested = 1;
    for (let index = 0; index < 12; index += 1) nested = { next: nested };
    await writeFile(join(root, "theme.json"), JSON.stringify({ ...minimalManifest, nested }));
    await assert.rejects(loadTheme(root), /depth|12/i);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects MIME mismatch, image bombs, and aggregate theme bytes", async () => {
  await withTheme(minimalManifest, async (root) => {
    await writeFile(join(root, "hero.png"), png(8193, 100));
    await assert.rejects(loadTheme(root), /宽度|width/i);
    await writeFile(join(root, "hero.png"), Buffer.from("not-a-png"));
    await assert.rejects(loadTheme(root), /PNG|图片|header/i);
  });

  await withTheme({
    ...minimalManifest,
    logo: "logo.png",
    polaroid: "polaroid.png",
    cardArtwork: "card.png",
  }, async (root) => {
    for (const file of ["hero.png", "logo.png", "polaroid.png", "card.png"]) {
      await writeFile(join(root, file), png(100, 100, 5 * 1024 * 1024));
    }
    await assert.rejects(loadTheme(root), /theme.*16777216|16 MiB/i);
  });
});

test("rejects a missing or empty hero file", async () => {
  await withTheme(minimalManifest, async (root) => {
    await assert.rejects(loadTheme(root), /hero\.png|ENOENT/);
    await writeFile(join(root, "hero.png"), "");
    await assert.rejects(loadTheme(root), /hero must be a non-empty file|hero不能为空/);
  });
});

test("rejects a hero reached through a symlink outside the theme", async () => {
  const outside = await mkdtemp(join(tmpdir(), "outside-theme-"));
  try {
    await writeFile(join(outside, "hero.png"), Buffer.from([1]));
    await withTheme(
      { ...minimalManifest, hero: "images/hero.png" },
      async (root) => {
        await symlink(outside, join(root, "images"));
        await assert.rejects(loadTheme(root), /escapes the theme directory/);
      },
    );
  } finally {
    await rm(outside, { force: true, recursive: true });
  }
});
