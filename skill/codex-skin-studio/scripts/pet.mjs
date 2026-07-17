#!/usr/bin/env node

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, isAbsolute, join, resolve, sep, win32 as winPath } from "node:path";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform as hostPlatform } from "node:os";

const require = createRequire(import.meta.url);
let sharp = null;
try { sharp = require("sharp"); } catch { sharp = null; }
if (!sharp) {
  const bundledRoots = [
    process.env.CODEX_NODE_MODULES,
    join(dirname(process.execPath), "..", "lib", "node_modules"),
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules",
  ].filter(Boolean);
  for (const root of bundledRoots) {
    try { sharp = createRequire(join(root, "package.json"))("sharp"); break; } catch { /* Try the next bundled runtime path. */ }
  }
}

export const PET_CONTRACT_SCHEMA = 1;
const PET_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const DEFAULT_MAX_INPUT_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_ATLAS_BYTES = 20 * 1024 * 1024;
const PET_SPRITE_VERSION = 2;
const DEFAULT_ROWS = [
  { name: "idle", frames: 6 },
  { name: "running-right", frames: 8 },
  { name: "running-left", frames: 8 },
  { name: "waving", frames: 4 },
  { name: "jumping", frames: 5 },
  { name: "failed", frames: 8 },
  { name: "waiting", frames: 6 },
  { name: "running", frames: 6 },
  { name: "review", frames: 6 },
  { name: "look-000-to-157.5", frames: 8 },
  { name: "look-180-to-337.5", frames: 8 },
];

export const DEFAULT_PET_CONTRACT = {
  schemaVersion: PET_CONTRACT_SCHEMA,
  contractVersion: "codex-v2-hatch-pet",
  status: "observed",
  source: "ChatGPT Desktop hatch-pet Codex V2 Pet Contract",
  spriteVersionNumber: PET_SPRITE_VERSION,
  grid: { columns: 8, rows: 11 },
  frame: { width: 192, height: 208 },
  spritesheet: { format: ["webp", "png"], colorMode: "rgba", maxBytes: DEFAULT_MAX_ATLAS_BYTES },
  rows: DEFAULT_ROWS,
  neutralLookFrame: { row: 0, column: 6 },
  lookDirections: ["000", "022.5", "045", "067.5", "090", "112.5", "135", "157.5", "180", "202.5", "225", "247.5", "270", "292.5", "315", "337.5"],
};

export function petError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (typeof value !== "string" || !value.trim()) throw petError("PET_INPUT_INVALID", `missing required option: --${name}`);
  return value.trim();
}

export function parsePetArgs(argv) {
  const options = new Map();
  const booleanFlags = new Set(["json", "replace", "dry-run", "allow-provisional", "chroma-key", "manual-pet"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw petError("PET_INPUT_INVALID", `unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (booleanFlags.has(key)) { options.set(key, true); continue; }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw petError("PET_INPUT_INVALID", `missing value for --${key}`);
    options.set(key, value);
  }
  return options;
}

function assertPetId(id) {
  if (!PET_ID.test(id)) throw petError("PET_MANIFEST_INVALID", "pet id must be lowercase letters, numbers, and hyphens");
  return id;
}

function assertInside(root, candidate, label) {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const prefix = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`;
  if (candidatePath !== rootPath && !candidatePath.startsWith(prefix)) throw petError("PET_PATH_UNSAFE", `${label} must remain inside ${rootPath}`);
  return candidatePath;
}

async function readJsonFile(file, code = "PET_INPUT_INVALID") {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { throw petError(code, `invalid JSON: ${file}`, { cause: error.message }); }
}

async function writeJsonFile(file, value) {
  await writeFile(file, `${json(value)}\n`, "utf8");
}

function assertInteger(value, label, min = 1, max = 8192) {
  if (!Number.isInteger(value) || value < min || value > max) throw petError("PET_CONTRACT_MISMATCH", `${label} must be an integer from ${min} through ${max}`);
}

function maxAtlasBytes(contract) {
  return contract.spritesheet?.maxBytes || DEFAULT_MAX_ATLAS_BYTES;
}

function rowSpec(row) {
  return typeof row === "string" ? { name: row, frames: 8 } : row;
}

function rowSpecs(contract) {
  return contract.rows.map(rowSpec);
}

function rowName(row) {
  return rowSpec(row).name;
}

function rowFrameCount(row) {
  return rowSpec(row).frames;
}

export function validateContract(contract, { allowProvisional = false } = {}) {
  if (!contract || typeof contract !== "object") throw petError("PET_CONTRACT_MISMATCH", "pet contract must be an object");
  if (contract.schemaVersion !== PET_CONTRACT_SCHEMA) throw petError("PET_CONTRACT_MISMATCH", `unsupported pet contract schema: ${contract.schemaVersion}`);
  if (typeof contract.contractVersion !== "string" || !contract.contractVersion.trim()) throw petError("PET_CONTRACT_MISMATCH", "pet contract version is required");
  if (!allowProvisional && contract.status !== "observed") throw petError("PET_CONTRACT_MISMATCH", "pet contract is provisional; capture an observed hatch-pet contract first");
  if (contract.spriteVersionNumber !== PET_SPRITE_VERSION) throw petError("PET_CONTRACT_MISMATCH", "the current ChatGPT Desktop contract requires spriteVersionNumber 2");
  if (!contract.grid || contract.grid.columns !== 8 || contract.grid.rows !== 11) throw petError("PET_CONTRACT_MISMATCH", "the current ChatGPT Desktop contract requires an observed 8x11 pet atlas");
  assertInteger(contract.frame?.width, "frame.width");
  assertInteger(contract.frame?.height, "frame.height");
  if (!Array.isArray(contract.rows) || contract.rows.length !== contract.grid.rows) throw petError("PET_CONTRACT_MISMATCH", "pet contract must define exactly eleven rows");
  const specs = rowSpecs(contract);
  if (specs.some((row) => !row || typeof row.name !== "string" || !row.name.trim() || !Number.isInteger(row.frames) || row.frames < 1 || row.frames > contract.grid.columns)) throw petError("PET_CONTRACT_MISMATCH", "every pet row must define a name and one through eight frames");
  if (new Set(specs.map((row) => row.name)).size !== specs.length) throw petError("PET_CONTRACT_MISMATCH", "pet contract row names must be unique");
  if (specs.some((row, index) => row.name !== DEFAULT_ROWS[index].name || row.frames !== DEFAULT_ROWS[index].frames)) throw petError("PET_CONTRACT_MISMATCH", "pet contract rows must match the Codex V2 animation and look-direction layout");
  if (!contract.neutralLookFrame || contract.neutralLookFrame.row !== 0 || contract.neutralLookFrame.column !== 6) throw petError("PET_CONTRACT_MISMATCH", "v2 pet contract must reserve row 0 column 6 for the neutral look frame");
  if (!Array.isArray(contract.lookDirections) || contract.lookDirections.length !== 16) throw petError("PET_CONTRACT_MISMATCH", "v2 pet contract must define sixteen look directions");
  const formats = Array.isArray(contract.spritesheet?.format) ? contract.spritesheet.format : [contract.spritesheet?.format];
  if ((!formats.includes("webp") && !formats.includes("png")) || contract.spritesheet?.colorMode !== "rgba") throw petError("PET_CONTRACT_MISMATCH", "pet contract must require transparent RGBA PNG or WebP output");
  if (contract.spritesheet.maxBytes !== undefined && (!Number.isInteger(contract.spritesheet.maxBytes) || contract.spritesheet.maxBytes < 1 || contract.spritesheet.maxBytes > 100 * 1024 * 1024)) throw petError("PET_CONTRACT_MISMATCH", "spritesheet.maxBytes must be between 1 and 104857600");
  return contract;
}

export async function loadPetContract(file, options = {}) {
  const contract = await readJsonFile(resolve(file), "PET_CONTRACT_MISMATCH");
  return validateContract(contract, options);
}

export function defaultPetsDir({ platform = hostPlatform(), env = process.env } = {}) {
  const override = env.CODEX_PETS_DIR;
  const pathApi = platform === "win32" ? winPath : { join, resolve };
  if (override) return pathApi.resolve(override);
  const home = platform === "win32" ? (env.USERPROFILE || env.HOME || homedir()) : (env.HOME || homedir());
  const codexHome = env.CODEX_HOME ? pathApi.resolve(env.CODEX_HOME) : pathApi.join(home, ".codex");
  return pathApi.join(codexHome, "pets");
}

function requireSharp() {
  if (!sharp) throw petError("PET_IMAGE_PROCESSOR_UNAVAILABLE", "Pet image processing requires the sharp package");
  return sharp;
}

async function assertImage(file) {
  const path = resolve(file);
  const extension = extname(path).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) throw petError("PET_IMAGE_INVALID", `unsupported image extension: ${extension}`);
  let details;
  try { details = await stat(path); } catch (error) { throw petError("PET_IMAGE_INVALID", `image does not exist: ${path}`, { cause: error.message }); }
  if (!details.isFile() || details.size === 0 || details.size > DEFAULT_MAX_INPUT_BYTES) throw petError("PET_IMAGE_INVALID", `image must be a non-empty file no larger than ${DEFAULT_MAX_INPUT_BYTES} bytes: ${path}`);
  return path;
}

async function chromaKeyBuffer(file) {
  const image = requireSharp();
  const { data, info } = await image(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let removed = 0;
  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    if (green > 140 && green > red * 1.22 && green > blue * 1.22) {
      data[index + 3] = 0;
      removed += 1;
    }
  }
  return { buffer: await image(data, { raw: info }).png().toBuffer(), removed, width: info.width, height: info.height };
}

async function frameSource(file, { chromaKey = true } = {}) {
  const path = await assertImage(file);
  const input = await readFile(path);
  if (!chromaKey) return { path, buffer: input, removedPixels: 0 };
  const processed = await chromaKeyBuffer(path);
  return { path, buffer: processed.buffer, removedPixels: processed.removed };
}

async function encodeSpriteSheet(composites, width, height, formats) {
  const sharpImage = requireSharp();
  const { data, info } = await sharpImage({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) {
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
    }
  }
  const webp = await sharpImage(data, { raw: info }).webp({ lossless: true, quality: 100, alphaQuality: 100, effort: 6, exact: true }).toBuffer();
  const decoded = await sharpImage(webp).ensureAlpha().raw().toBuffer();
  let residue = 0;
  for (let index = 0; index < decoded.length; index += 4) {
    if (decoded[index + 3] === 0 && (decoded[index] !== 0 || decoded[index + 1] !== 0 || decoded[index + 2] !== 0)) residue += 1;
  }
  if (residue === 0 && formats.includes("webp")) return { buffer: webp, extension: "webp" };
  if (!formats.includes("png")) throw petError("PET_SPRITESHEET_INVALID", "the selected contract permits WebP only, but the encoder produced transparent RGB residue; allow PNG output or use a lossless WebP encoder");
  return { buffer: await sharpImage(data, { raw: info }).png().toBuffer(), extension: "png" };
}

function frameManifestFromOptions(options, contract) {
  const file = options.get("frames") || options.get("input");
  if (!file) throw petError("PET_INPUT_INVALID", "missing required option: --frames");
  return { file: resolve(file), contract };
}

async function loadFrameManifest(file, contract) {
  const manifest = await readJsonFile(file, "PET_INPUT_INVALID");
  if (!manifest || typeof manifest !== "object" || !manifest.rows || typeof manifest.rows !== "object") throw petError("PET_INPUT_INVALID", "frame manifest must contain rows");
  if (manifest.contractVersion !== contract.contractVersion) throw petError("PET_CONTRACT_MISMATCH", "frame manifest contractVersion does not match the selected pet contract");
  const rows = {};
  for (const row of rowSpecs(contract)) {
    const rowName = row.name;
    const rowEntry = manifest.rows[rowName];
    if (!rowEntry || !Array.isArray(rowEntry.frames) || rowEntry.frames.length !== rowFrameCount(row)) throw petError("PET_INPUT_INVALID", `row ${rowName} must contain exactly ${rowFrameCount(row)} frames`);
    rows[rowName] = rowEntry.frames.map((file) => {
      if (typeof file !== "string" || !file.trim()) throw petError("PET_INPUT_INVALID", `row ${rowName} contains an invalid frame path`);
      return file.trim();
    });
  }
  const base = dirname(resolve(file));
  for (const row of rowSpecs(contract)) rows[row.name] = rows[row.name].map((frame) => assertInside(base, resolve(base, frame), "frame"));
  let neutralFrame = manifest.neutralFrame;
  if (neutralFrame !== undefined && (typeof neutralFrame !== "string" || !neutralFrame.trim())) throw petError("PET_INPUT_INVALID", "neutralFrame must be a non-empty relative image path");
  neutralFrame = neutralFrame ? assertInside(base, resolve(base, neutralFrame), "neutralFrame") : rows.idle[0];
  return { rows, neutralFrame, source: file };
}

export async function createPet({ id, displayName, description, frames, out, contract, replace = false, chromaKey = true } = {}) {
  const petId = assertPetId(id);
  validateContract(contract);
  const output = resolve(out);
  const parent = dirname(output);
  await mkdir(parent, { recursive: true });
  const sourceManifest = await loadFrameManifest(resolve(frames), contract);
  const image = requireSharp();
  const staging = await mkdtemp(join(parent, `.${petId}.`));
  try {
    const frameWidth = contract.frame.width;
    const frameHeight = contract.frame.height;
    const composites = [];
    for (let rowIndex = 0; rowIndex < contract.rows.length; rowIndex += 1) {
      const row = rowSpec(contract.rows[rowIndex]);
      const rowName = row.name;
      for (let column = 0; column < rowFrameCount(row); column += 1) {
        const source = await frameSource(sourceManifest.rows[rowName][column], { chromaKey });
        const resized = await image(source.buffer).resize({ width: frameWidth, height: frameHeight, fit: "contain", position: "center", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
        composites.push({ input: resized, left: column * frameWidth, top: rowIndex * frameHeight });
      }
    }
    const neutral = await frameSource(sourceManifest.neutralFrame, { chromaKey });
    const neutralResized = await image(neutral.buffer).resize({ width: frameWidth, height: frameHeight, fit: "contain", position: "center", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    composites.push({ input: neutralResized, left: contract.neutralLookFrame.column * frameWidth, top: contract.neutralLookFrame.row * frameHeight });
    const formats = Array.isArray(contract.spritesheet.format) ? contract.spritesheet.format : [contract.spritesheet.format];
    const encoded = await encodeSpriteSheet(composites, frameWidth * contract.grid.columns, frameHeight * contract.grid.rows, formats);
    const atlasPath = join(staging, `spritesheet.${encoded.extension}`);
    if (encoded.buffer.length > maxAtlasBytes(contract)) throw petError("PET_SPRITESHEET_INVALID", `generated spritesheet exceeds ${maxAtlasBytes(contract)} bytes`);
    await writeFile(atlasPath, encoded.buffer);
    const manifest = {
      id: petId,
      displayName: String(displayName || petId).trim(),
      description: String(description || "A cute anthropomorphic desktop companion.").trim(),
      spriteVersionNumber: contract.spriteVersionNumber,
      spritesheetPath: `spritesheet.${encoded.extension}`,
    };
    await writeJsonFile(join(staging, "pet.json"), manifest);
    await validatePetDirectory(staging, { contract, allowProvisional: false });
    try {
      await stat(output);
      if (!replace) throw petError("PET_INSTALL_FAILED", `pet output is not empty: ${output}; pass --replace to overwrite`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await commitDirectory(staging, output, replace);
    return { status: "created", id: petId, directory: output, manifestPath: join(output, "pet.json"), spritesheetPath: join(output, `spritesheet.${encoded.extension}`), contractVersion: contract.contractVersion, format: encoded.extension };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function commitDirectory(staging, output, replace) {
  if (!replace) { await rename(staging, output); return; }
  const backup = `${output}.backup-${process.pid}-${Date.now()}`;
  let hadOutput = false;
  try { await rename(output, backup); hadOutput = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
  try { await rename(staging, output); } catch (error) { if (hadOutput) await rename(backup, output); throw error; }
  if (hadOutput) await rm(backup, { recursive: true, force: true });
}

async function validateCorners(file) {
  const image = requireSharp();
  const { data, info } = await image(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const points = [[0, 0], [info.width - 1, 0], [0, info.height - 1], [info.width - 1, info.height - 1]];
  const alpha = points.map(([x, y]) => data[(y * info.width + x) * 4 + 3]);
  let transparentRgbResidue = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0 && (data[index] !== 0 || data[index + 1] !== 0 || data[index + 2] !== 0)) transparentRgbResidue += 1;
  }
  return { width: info.width, height: info.height, hasAlpha: info.channels === 4, cornerAlpha: alpha, cornersTransparent: alpha.every((value) => value === 0), transparentRgbResidue };
}

async function validateFrameCells(file, contract) {
  const image = requireSharp();
  const { data, info } = await image(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const frameWidth = contract.frame.width;
  const frameHeight = contract.frame.height;
  const frames = [];
  for (let row = 0; row < contract.grid.rows; row += 1) {
    const rowSpecValue = rowSpec(contract.rows[row]);
    for (let column = 0; column < contract.grid.columns; column += 1) {
      let left = frameWidth;
      let top = frameHeight;
      let right = -1;
      let bottom = -1;
      for (let y = 0; y < frameHeight; y += 1) {
        for (let x = 0; x < frameWidth; x += 1) {
          const atlasX = column * frameWidth + x;
          const atlasY = row * frameHeight + y;
          if (data[(atlasY * info.width + atlasX) * 4 + 3] === 0) continue;
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
      const isNeutral = contract.neutralLookFrame.row === row && contract.neutralLookFrame.column === column;
      const isUsed = column < rowFrameCount(rowSpecValue) || isNeutral;
      if (!isUsed) {
        if (right >= 0) throw petError("PET_SPRITESHEET_INVALID", `unused frame ${row}:${column} must be fully transparent`);
        continue;
      }
      if (right < 0) throw petError("PET_SPRITESHEET_INVALID", `frame ${row}:${column} contains no visible character`);
      const padding = Math.min(left, top, frameWidth - 1 - right, frameHeight - 1 - bottom);
      if (padding < Math.floor(Math.min(frameWidth, frameHeight) * 0.02)) throw petError("PET_SPRITESHEET_INVALID", `frame ${row}:${column} is cropped or lacks safe padding`);
      frames.push({ row, name: rowSpecValue.name, column, left, top, right, bottom, width: right - left + 1, height: bottom - top + 1, padding, neutral: isNeutral });
    }
  }
  return { frameCount: frames.length, frames };
}

export async function validatePetDirectory(directory, { contract, allowProvisional = false } = {}) {
  validateContract(contract, { allowProvisional });
  const root = resolve(directory);
  const manifestPath = join(root, "pet.json");
  const manifest = await readJsonFile(manifestPath, "PET_MANIFEST_INVALID");
  assertPetId(manifest.id);
  if (typeof manifest.displayName !== "string" || !manifest.displayName.trim()) throw petError("PET_MANIFEST_INVALID", "pet displayName is required");
  if (manifest.spriteVersionNumber !== contract.spriteVersionNumber) throw petError("PET_CONTRACT_MISMATCH", "pet manifest spriteVersionNumber does not match the selected contract");
  if (manifest.contractVersion !== undefined && manifest.contractVersion !== contract.contractVersion) throw petError("PET_CONTRACT_MISMATCH", "pet manifest contractVersion does not match the selected contract");
  if (typeof manifest.spritesheetPath !== "string" || isAbsolute(manifest.spritesheetPath)) throw petError("PET_MANIFEST_INVALID", "spritesheetPath must be relative");
  const spritesheet = assertInside(root, join(root, manifest.spritesheetPath), "spritesheet");
  const extension = extname(spritesheet).toLowerCase();
  const allowedFormats = Array.isArray(contract.spritesheet.format) ? contract.spritesheet.format : [contract.spritesheet.format];
  if (!allowedFormats.includes(extension.slice(1))) throw petError("PET_MANIFEST_INVALID", `spritesheet must use one of: ${allowedFormats.join(", ")}`);
  const details = await stat(spritesheet).catch((error) => { throw petError("PET_IMAGE_INVALID", `spritesheet does not exist: ${spritesheet}`, { cause: error.message }); });
  if (!details.isFile() || details.size === 0 || details.size > maxAtlasBytes(contract)) throw petError("PET_SPRITESHEET_INVALID", `spritesheet is empty or exceeds ${maxAtlasBytes(contract)} bytes`);
  const imageInfo = await validateCorners(spritesheet);
  const expected = { width: contract.frame.width * contract.grid.columns, height: contract.frame.height * contract.grid.rows };
  if (imageInfo.width !== expected.width || imageInfo.height !== expected.height) throw petError("PET_SPRITESHEET_INVALID", `spritesheet must be ${expected.width}x${expected.height}`);
  if (!imageInfo.hasAlpha || !imageInfo.cornersTransparent || imageInfo.transparentRgbResidue > 0) throw petError("PET_ALPHA_INVALID", "spritesheet must contain RGBA alpha, transparent corners, and zero RGB in transparent pixels", imageInfo);
  const frames = await validateFrameCells(spritesheet, contract);
  return { status: "valid", id: manifest.id, directory: root, manifestPath, spritesheet, dimensions: imageInfo, frames, contractVersion: contract.contractVersion };
}

export async function installPet(directory, { petsDir = defaultPetsDir(), contract, replace = false, allowProvisional = false, dryRun = false } = {}) {
  const source = resolve(directory);
  const validation = await validatePetDirectory(source, { contract, allowProvisional });
  const destinationRoot = resolve(petsDir);
  await mkdir(destinationRoot, { recursive: true });
  const destination = assertInside(destinationRoot, join(destinationRoot, validation.id), "pet destination");
  if (dryRun) return { ...validation, status: "validated", dryRun: true, destination };
  if (!replace) {
    try {
      await stat(destination);
      throw petError("PET_INSTALL_FAILED", `pet destination is not empty: ${destination}; pass --replace to overwrite`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const staging = await mkdtemp(join(destinationRoot, `.${validation.id}.`));
  try {
    const manifest = await readFile(join(source, "pet.json"));
    const spritesheet = await readFile(validation.spritesheet);
    await writeFile(join(staging, "pet.json"), manifest);
    await writeFile(join(staging, basename(validation.spritesheet)), spritesheet);
    await commitDirectory(staging, destination, replace);
    const statePath = join(destinationRoot, ".codex-skin-studio-pet-state.json");
    await writeJsonFile(statePath, { schemaVersion: 1, installedId: validation.id, installedAt: new Date().toISOString(), directory: destination, selection: "refresh-required" });
    return { ...validation, status: "installed", destination, refreshRequired: true, selection: "refresh-required" };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (error.code) throw error;
    throw petError("PET_INSTALL_FAILED", error.message);
  }
}

export async function listInstalledPets({ petsDir = defaultPetsDir() } = {}) {
  const root = resolve(petsDir);
  let entries;
  try { entries = await (await import("node:fs/promises")).readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      const manifest = await readJsonFile(join(root, entry.name, "pet.json"), "PET_MANIFEST_INVALID");
      result.push({ id: manifest.id, displayName: manifest.displayName, directory: join(root, entry.name), spriteVersionNumber: manifest.spriteVersionNumber, contractVersion: manifest.contractVersion || null });
    } catch { /* Ignore unrelated directories in the user Pet root. */ }
  }
  return result.sort((left, right) => left.id.localeCompare(right.id));
}

export async function petStatus({ petsDir = defaultPetsDir() } = {}) {
  const root = resolve(petsDir);
  let state = null;
  try { state = await readJsonFile(join(root, ".codex-skin-studio-pet-state.json")); } catch { state = null; }
  return { status: "ok", petsDir: root, active: state?.installedId || null, selection: state?.selection || "unknown", assetLoaded: state?.assetLoaded ?? null, pets: await listInstalledPets({ petsDir: root }) };
}

export async function recordPetSelection({ petsDir = defaultPetsDir(), petId, selection = "native-ui-confirmed", assetLoaded = null } = {}) {
  assertPetId(petId);
  const root = resolve(petsDir);
  const statePath = join(root, ".codex-skin-studio-pet-state.json");
  let current = {};
  try { current = await readJsonFile(statePath); } catch { current = {}; }
  const next = { ...current, schemaVersion: 1, installedId: petId, directory: join(root, petId), selection, assetLoaded: typeof assetLoaded === "boolean" ? assetLoaded : current.assetLoaded ?? null, selectedAt: new Date().toISOString() };
  await writeJsonFile(statePath, next);
  return next;
}

async function cli() {
  const [command, ...argv] = process.argv.slice(2);
  const options = parsePetArgs(argv);
  if (command === "status") {
    const result = await petStatus({ petsDir: options.get("pets-dir") || defaultPetsDir() });
    console.log(options.get("json") ? json(result) : result.message || json(result));
    return;
  }
  const contractPath = options.get("contract");
  if (!contractPath) throw petError("PET_CONTRACT_MISMATCH", "missing required option: --contract");
  const contract = await loadPetContract(contractPath, { allowProvisional: options.get("allow-provisional") === true });
  let result;
  if (command === "validate") result = await validatePetDirectory(requiredOption(options, "directory"), { contract, allowProvisional: options.get("allow-provisional") === true });
  else if (command === "create") result = await createPet({ id: requiredOption(options, "id"), displayName: options.get("name"), description: options.get("description"), frames: requiredOption(options, "frames"), out: requiredOption(options, "out"), contract, replace: options.get("replace") === true, chromaKey: options.get("chroma-key") !== false });
  else if (command === "install") result = await installPet(requiredOption(options, "directory"), { petsDir: options.get("pets-dir") || defaultPetsDir(), contract, replace: options.get("replace") === true, allowProvisional: options.get("allow-provisional") === true, dryRun: options.get("dry-run") === true });
  else throw petError("PET_INPUT_INVALID", "usage: pet.mjs create|validate|install|status --contract PATH [options]");
  console.log(options.get("json") ? json(result) : result.message || json(result));
}

export { assertInside, assertPetId, chromaKeyBuffer, commitDirectory, frameSource, loadFrameManifest, requireSharp };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((error) => { console.error(json({ status: "failed", code: error.code || "PET_COMMAND_FAILED", message: error.message, details: error.details })); process.exitCode = 1; });
}
