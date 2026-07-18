import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSingleImageTheme, listThemes, resolveAndLoadTheme } from "../src/theme-store.mjs";

async function temporaryRoot(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

function png(width, height, bytes = 24) {
  const result = Buffer.alloc(Math.max(bytes, 24));
  Buffer.from("89504e470d0a1a0a", "hex").copy(result, 0);
  result.writeUInt32BE(13, 8);
  result.write("IHDR", 12, "ascii");
  result.writeUInt32BE(width, 16);
  result.writeUInt32BE(height, 20);
  return result;
}

test("creates a theme from one local image without a build pipeline", async () => {
  const root = await temporaryRoot("heige-theme-");
  const image = join(root, "source.png");
  await writeFile(image, png(640, 360));

  const created = await createSingleImageTheme({
    imagePath: image,
    name: "My Fast Skin",
    storeRoot: join(root, "themes"),
  });

  assert.match(created.id, /^my-fast-skin-/);
  assert.equal(created.manifest.hero, "hero.png");
  assert.deepEqual(JSON.parse(await readFile(join(created.path, "theme.json"), "utf8")), created.manifest);
  assert.deepEqual((await listThemes({ roots: [join(root, "themes")] })).map((item) => item.id), [created.id]);
});

test("rejects unsupported source files", async () => {
  const root = await temporaryRoot("heige-theme-");
  const image = join(root, "source.gif");
  await writeFile(image, "gif");

  await assert.rejects(
    () => createSingleImageTheme({ imagePath: image, name: "No", storeRoot: join(root, "themes") }),
    /PNG、JPG、JPEG 或 WebP/,
  );
});

test("listThemes skips well-formed JSON with a bad shape instead of crashing", async () => {
  const root = await temporaryRoot("heige-badshape-");
  await mkdir(join(root, "good"));
  await writeFile(join(root, "good", "theme.json"), JSON.stringify({ id: "good", name: "Good" }));
  await mkdir(join(root, "noname"));
  await writeFile(join(root, "noname", "theme.json"), JSON.stringify({ id: "noname" }));
  await mkdir(join(root, "nullname"));
  await writeFile(join(root, "nullname", "theme.json"), JSON.stringify({ id: "x", name: null }));

  const themes = await listThemes({ roots: [root] });
  assert.deepEqual(themes.map((t) => t.name), ["Good"]);
});

test("resolveAndLoadTheme loads only the target theme by id", async () => {
  const root = await temporaryRoot("heige-resolve-");
  const storeRoot = join(root, "themes");
  const image = join(root, "source.png");
  await writeFile(image, png(640, 360));
  const first = await createSingleImageTheme({
    imagePath: image,
    name: "Resolve One",
    storeRoot,
  });
  const second = await createSingleImageTheme({
    imagePath: image,
    name: "Resolve Two",
    storeRoot,
  });
  assert.notEqual(first.id, second.id);

  const resolved = await resolveAndLoadTheme({ roots: [storeRoot], id: second.id });
  assert.equal(resolved.selected.id, second.id);
  assert.equal(resolved.loadedTheme.manifest.id, second.id);
  assert.equal(resolved.selected.path, second.path);

  await assert.rejects(
    resolveAndLoadTheme({ roots: [storeRoot], id: "missing-theme" }),
    /找不到主题/,
  );
  await assert.rejects(
    resolveAndLoadTheme({ roots: [storeRoot], id: "../escape" }),
    /invalid/,
  );
});

test("createSingleImageTheme rejects oversized source images", async () => {
  const root = await temporaryRoot("heige-bigimg-");
  const big = join(root, "big.png");
  await writeFile(big, png(640, 360, 9 * 1024 * 1024));
  await assert.rejects(
    createSingleImageTheme({ imagePath: big, name: "Big", storeRoot: join(root, "store") }),
    /过大/,
  );
});

test("createSingleImageTheme validates magic MIME and dimensions before publishing", async () => {
  const root = await temporaryRoot("heige-invalid-source-");
  const storeRoot = join(root, "store");
  const mismatch = join(root, "mismatch.png");
  await writeFile(mismatch, Buffer.from("not-a-png"));
  await assert.rejects(
    createSingleImageTheme({ imagePath: mismatch, name: "Mismatch", storeRoot }),
    /PNG|图片|header/i,
  );

  const bomb = join(root, "bomb.png");
  await writeFile(bomb, png(8000, 8000));
  await assert.rejects(
    createSingleImageTheme({ imagePath: bomb, name: "Bomb", storeRoot }),
    /像素|pixel/i,
  );
});

test("theme ids are content addressed instead of trusting size and mtime metadata", async () => {
  const root = await temporaryRoot("heige-theme-content-id-");
  const firstRoot = join(root, "first");
  const secondRoot = join(root, "second");
  await mkdir(firstRoot);
  await mkdir(secondRoot);
  const first = join(firstRoot, "same.png");
  const second = join(secondRoot, "same.png");
  const firstBytes = png(640, 360, 32);
  const secondBytes = Buffer.from(firstBytes);
  secondBytes[31] ^= 0xff;
  await writeFile(first, firstBytes);
  await writeFile(second, secondBytes);
  const fixed = new Date("2026-07-16T00:00:00.000Z");
  await utimes(first, fixed, fixed);
  await utimes(second, fixed, fixed);

  const left = await createSingleImageTheme({
    imagePath: first,
    name: "Collision Guard",
    storeRoot: join(root, "themes-a"),
  });
  const right = await createSingleImageTheme({
    imagePath: second,
    name: "Collision Guard",
    storeRoot: join(root, "themes-b"),
  });
  assert.notEqual(left.id, right.id);
});

test("the same image and name produce one stable id across paths and mtimes", async () => {
  const root = await temporaryRoot("heige-theme-stable-id-");
  const first = join(root, "first.png");
  const second = join(root, "renamed.png");
  const bytes = png(640, 360, 32);
  await writeFile(first, bytes);
  await writeFile(second, bytes);
  await utimes(first, new Date("2025-01-01T00:00:00Z"), new Date("2025-01-01T00:00:00Z"));
  await utimes(second, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));

  const left = await createSingleImageTheme({
    imagePath: first,
    name: "Stable Theme",
    storeRoot: join(root, "themes-a"),
  });
  const right = await createSingleImageTheme({
    imagePath: second,
    name: "Stable Theme",
    storeRoot: join(root, "themes-b"),
  });
  assert.equal(left.id, right.id);
});

test("a publish failure restores an existing theme byte for byte", async () => {
  const root = await temporaryRoot("heige-theme-rollback-");
  const image = join(root, "source.png");
  const storeRoot = join(root, "themes");
  await writeFile(image, png(640, 360, 32));
  const original = await createSingleImageTheme({ imagePath: image, name: "Rollback", storeRoot });
  const beforeManifest = await readFile(join(original.path, "theme.json"));
  const beforeHero = await readFile(join(original.path, "hero.png"));

  await assert.rejects(createSingleImageTheme({
    imagePath: image,
    name: "Rollback",
    storeRoot,
    hooks: {
      afterExistingRetired: async () => { throw new Error("injected publish failure"); },
    },
  }), /injected publish failure/);
  assert.deepEqual(await readFile(join(original.path, "theme.json")), beforeManifest);
  assert.deepEqual(await readFile(join(original.path, "hero.png")), beforeHero);
});

test("theme publication refuses a symlink collision without touching its target", async () => {
  const root = await temporaryRoot("heige-theme-symlink-");
  const image = join(root, "source.png");
  await writeFile(image, png(640, 360, 32));
  const probe = await createSingleImageTheme({
    imagePath: image,
    name: "Symlink Guard",
    storeRoot: join(root, "probe"),
  });
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "untouched\n");
  const storeRoot = join(root, "themes");
  await mkdir(storeRoot);
  await symlink(outside, join(storeRoot, probe.id));

  await assert.rejects(createSingleImageTheme({
    imagePath: image,
    name: "Symlink Guard",
    storeRoot,
  }), /符号链接|symlink/i);
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "untouched\n");
});

test("theme publication rejects a symlinked store ancestor before creating files", async (t) => {
  const root = await temporaryRoot("heige-theme-store-ancestor-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const image = join(root, "source.png");
  const outside = join(root, "outside");
  const alias = join(root, "alias");
  await writeFile(image, png(640, 360, 32));
  await mkdir(outside);
  await symlink(outside, alias);

  await assert.rejects(createSingleImageTheme({
    imagePath: image,
    name: "Ancestor Guard",
    storeRoot: join(alias, "themes"),
  }), /canonical|symlink|符号链接|规范/i);
  await assert.rejects(lstat(join(outside, "themes")), /ENOENT/);
});
