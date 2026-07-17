#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { commandApply, loadTheme, validateManifest } from "./apply.mjs";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const REQUIRED_COLORS = ["accent", "secondary", "surface", "text"];
const DEFAULT_PORT = 9341;
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
let sharp = null;
try {
  sharp = require("sharp");
} catch {
  sharp = null;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const key = argument.slice(2);
    if (key === "replace" || key === "apply") {
      values.set(key, true);
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${key}`);
    values.set(key, value);
  }
  return values;
}

function required(values, key) {
  const value = values.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error(`missing required option: --${key}`);
  return value.trim();
}

function optionalCopy(values) {
  const copy = {};
  for (const key of ["brand", "headline", "tagline"]) {
    const value = values.get(key);
    if (value !== undefined) copy[key] = String(value).trim();
  }
  return Object.keys(copy).length ? copy : undefined;
}

async function assertImage(file, label) {
  const resolved = resolve(file);
  const extension = extname(resolved).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) throw new Error(`${label} must be PNG, JPEG, or WebP`);
  const details = await stat(resolved);
  if (!details.isFile() || details.size === 0) throw new Error(`${label} must be a non-empty file`);
  return resolved;
}

async function prepareOutputDirectory(directory, replace) {
  await mkdir(dirname(directory), { recursive: true });
  try {
    const details = await stat(directory);
    if (!details.isDirectory()) throw new Error(`theme output is not a directory: ${directory}`);
    const entries = await readdir(directory);
    if (entries.length && !replace) throw new Error(`theme directory is not empty: ${directory}; pass --replace to overwrite it`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function commitOutput(staging, output) {
  const backup = `${output}.old-${process.pid}-${Date.now()}`;
  let hadOutput = false;
  try {
    await rename(output, backup);
    hadOutput = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await rename(staging, output);
  } catch (error) {
    if (hadOutput) await rename(backup, output);
    throw error;
  }
  if (hadOutput) await rm(backup, { recursive: true, force: true });
}

function applyPort(values) {
  if (!values.has("port")) return DEFAULT_PORT;
  const port = Number(values.get("port"));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("port must be an integer from 1024 through 65535");
  return port;
}

async function compressToWebp(source, destination) {
  if (sharp) {
    await sharp(source).webp({ quality: 84, alphaQuality: 100 }).toFile(destination);
    return basename(destination);
  }
  try {
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-frames:v", "1", "-c:v", "libwebp", "-quality", "84", destination]);
    return basename(destination);
  } catch {
    throw new Error("automatic WebP compression requires the optional sharp package or ffmpeg in PATH");
  }
}

function assetName(key) {
  return `${key}.webp`;
}

async function copyAsset(source, destination) {
  await compressToWebp(source, destination);
  return basename(destination);
}

async function createTheme(values) {
  const id = required(values, "id");
  const name = required(values, "name");
  const output = resolve(required(values, "out"));
  const hero = await assertImage(required(values, "hero"), "hero");
  const assets = { hero };
  for (const key of ["logo", "polaroid"]) {
    if (values.has(key)) assets[key] = await assertImage(required(values, key), key);
  }

  const colors = Object.fromEntries(REQUIRED_COLORS.map((key) => [key, required(values, key)]));
  const manifest = validateManifest({
    schemaVersion: 1,
    id,
    name,
    hero: assetName("hero"),
    ...(assets.logo ? { logo: assetName("logo") } : {}),
    ...(assets.polaroid ? { polaroid: assetName("polaroid") } : {}),
    ...(optionalCopy(values) ? { copy: optionalCopy(values) } : {}),
    colors,
  });

  await prepareOutputDirectory(output, values.has("replace"));
  const staging = join(dirname(output), `.${basename(output)}.${process.pid}.${Date.now()}.tmp`);
  await mkdir(staging);
  const files = [];
  try {
    for (const key of ["hero", "logo", "polaroid"]) {
      if (!assets[key]) continue;
      files.push(await copyAsset(assets[key], join(staging, manifest[key])));
    }
    await writeFile(join(staging, "theme.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    files.push("theme.json");
    const validated = await loadTheme(staging);
    await commitOutput(staging, output);
    const application = values.has("apply") ? await commandApply(output, applyPort(values)) : null;
    return {
      status: "created",
      themeId: validated.manifest.id,
      themeDir: output,
      manifest: validated.manifest,
      files,
      ...(application ? { application } : {}),
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const result = await createTheme(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "failed", message: error.message })}\n`);
    process.exitCode = 1;
  }
}

export { applyPort, compressToWebp, createTheme, parseArgs };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
