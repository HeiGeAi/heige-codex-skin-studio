#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir, platform } from "node:os";
import { inflateRawSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = join(SKILL_ROOT, "scripts", "apply.mjs");
const SWITCH_PAIRED = join(SKILL_ROOT, "scripts", "switch-paired.mjs");
const DEFAULT_ENDPOINT = "https://codexskinstudio.com";
const TRUSTED_ORIGINS = new Set([
  "https://codexskinstudio.com",
  "https://www.codexskinstudio.com",
]);
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
const MAX_ENTRY_COUNT = 20;
const MAX_UNCOMPRESSED_BYTES = 150 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;
const LEGACY_FILES = ["theme.json", "hero.webp", "logo.webp", "polaroid.webp"];
const PAIRED_FILES = [
  "bundle.json",
  "pet-contract.json",
  "theme/theme.json",
  "theme/hero.webp",
  "theme/logo.webp",
  "theme/polaroid.webp",
  "pet/pet.json",
  "pet/spritesheet.png",
  "pet/spritesheet.webp",
];
const ALLOWED_FILES = new Set([...LEGACY_FILES, ...PAIRED_FILES]);
const PAIRED_CONTRACT_VERSION = "codex-v2-hatch-pet";
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function error(message, code = "REMOTE_SKIN_FAILED") {
  const result = new Error(message);
  result.code = code;
  return result;
}

function parseArgs(argv) {
  const command = argv.shift() || "help";
  const options = { command, endpoint: DEFAULT_ENDPOINT, json: false, limit: 24, port: 9341 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--confirm-install") options.confirmInstall = true;
    else if (arg === "--download-only") options.downloadOnly = true;
    else if (arg === "--endpoint") options.endpoint = argv[++index];
    else if (arg === "--query" || arg === "-q") options.query = argv[++index];
    else if (arg === "--prompt") options.prompt = argv[++index];
    else if (arg === "--target") options.target = argv[++index];
    else if (arg === "--category") options.category = argv[++index];
    else if (arg === "--palette") options.palette = argv[++index];
    else if (arg === "--sort") options.sort = argv[++index];
    else if (arg === "--limit") options.limit = Number(argv[++index]);
    else if (arg === "--slug") options.slug = argv[++index];
    else if (arg === "--output") options.output = argv[++index];
    else if (arg === "--port") options.port = Number(argv[++index]);
    else if (!arg.startsWith("-") && !options.slug) options.slug = arg;
    else throw error(`unknown argument: ${arg}`, "INVALID_ARGUMENT");
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 48) throw error("--limit must be an integer from 1 through 48", "INVALID_ARGUMENT");
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw error("--port must be an integer from 1024 through 65535", "INVALID_ARGUMENT");
  return options;
}

function endpointUrl(value, path = "/") {
  let url;
  try { url = new URL(value); } catch { throw error("endpoint must be a valid URL", "INVALID_ENDPOINT"); }
  const localAllowed = process.env.CODEX_SKIN_STUDIO_ALLOW_LOCAL_ENDPOINT === "1";
  const isLocal = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (!TRUSTED_ORIGINS.has(url.origin) && !(localAllowed && isLocal)) throw error("remote skin access is restricted to codexskinstudio.com", "UNTRUSTED_ENDPOINT");
  return new URL(path, url.origin + (url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`));
}

function assertTrustedOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw error("the skin download URL is invalid", "UNTRUSTED_DOWNLOAD"); }
  if (!TRUSTED_ORIGINS.has(url.origin) && !(process.env.CODEX_SKIN_STUDIO_ALLOW_LOCAL_ENDPOINT === "1" && url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) throw error("the skin request redirected to an untrusted origin", "UNTRUSTED_DOWNLOAD");
  return url;
}

function assertTrustedDownload(value) {
  const url = assertTrustedOrigin(value);
  if (!url.pathname.startsWith("/download/") || url.hash) throw error("the skin download URL is not an official archive URL", "UNTRUSTED_DOWNLOAD");
  const grant = url.searchParams.get("grant");
  if (!grant || [...url.searchParams.keys()].some((key) => key !== "grant")) throw error("the skin download URL does not contain a short-lived grant", "UNTRUSTED_DOWNLOAD");
  return url;
}

async function fetchResponse(url, init = {}) {
  const response = await fetch(url, { ...init, redirect: "follow", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw error(`remote skin request failed with HTTP ${response.status}`, "REMOTE_HTTP_ERROR");
  if (response.redirected) assertTrustedOrigin(response.url);
  return response;
}

async function fetchJson(url) {
  const response = await fetchResponse(url, { headers: { accept: "application/json" } });
  try { return await response.json(); } catch { throw error("remote skin response was not valid JSON", "REMOTE_RESPONSE_INVALID"); }
}

function readUint16(bytes, offset) {
  if (offset < 0 || offset + 2 > bytes.length) throw error("ZIP record is truncated", "ZIP_INVALID");
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) throw error("ZIP record is truncated", "ZIP_INVALID");
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function hasBytes(bytes, offset, length) {
  return offset >= 0 && length >= 0 && offset + length <= bytes.length;
}

function findEndOfCentralDirectory(bytes) {
  const start = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
    if (hasBytes(bytes, offset, 22) && readUint32(bytes, offset) === EOCD_SIGNATURE) return offset;
  }
  throw error("ZIP end-of-central-directory record is missing", "ZIP_INVALID");
}

function safeZipPath(value) {
  return value && !value.startsWith("/") && !value.includes("\\") && !value.split("/").some((part) => !part || part === "." || part === "..") && ALLOWED_FILES.has(value);
}

function isSymlink(bytes, offset) {
  const unixMode = readUint32(bytes, offset + 38) >>> 16;
  return (unixMode & 0o170000) === 0o120000;
}

function parseZip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength > MAX_PACKAGE_BYTES) throw error("skin package exceeds the 50 MB limit", "ZIP_LIMIT");
  const eocd = findEndOfCentralDirectory(bytes);
  const entryCount = readUint16(bytes, eocd + 10);
  const centralSize = readUint32(bytes, eocd + 12);
  const centralOffset = readUint32(bytes, eocd + 16);
  if (entryCount > MAX_ENTRY_COUNT) throw error("skin package contains too many entries", "ZIP_LIMIT");
  if (!hasBytes(bytes, centralOffset, centralSize) || centralOffset + centralSize > eocd) throw error("ZIP central directory is outside the archive", "ZIP_INVALID");

  const entries = [];
  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (!hasBytes(bytes, cursor, 46) || readUint32(bytes, cursor) !== CENTRAL_SIGNATURE) throw error("ZIP central directory entry is invalid", "ZIP_INVALID");
    const flags = readUint16(bytes, cursor + 8);
    const compression = readUint16(bytes, cursor + 10);
    const compressedSize = readUint32(bytes, cursor + 20);
    const uncompressedSize = readUint32(bytes, cursor + 24);
    const filenameLength = readUint16(bytes, cursor + 28);
    const extraLength = readUint16(bytes, cursor + 30);
    const commentLength = readUint16(bytes, cursor + 32);
    const localOffset = readUint32(bytes, cursor + 42);
    if (!hasBytes(bytes, cursor + 46, filenameLength + extraLength + commentLength)) throw error("ZIP filename record is invalid", "ZIP_INVALID");
    const path = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(cursor + 46, cursor + 46 + filenameLength));
    if (!safeZipPath(path)) throw error(`unsupported or unsafe ZIP entry: ${path || "<empty>"}`, "ZIP_INVALID");
    if (flags & 0x1) throw error(`encrypted ZIP entries are not allowed: ${path}`, "ZIP_INVALID");
    if (![0, 8].includes(compression)) throw error(`unsupported ZIP compression method: ${compression}`, "ZIP_INVALID");
    if (uncompressedSize > MAX_PACKAGE_BYTES) throw error(`ZIP entry is too large: ${path}`, "ZIP_LIMIT");
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw error("uncompressed skin package exceeds the limit", "ZIP_LIMIT");
    if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO) throw error(`ZIP compression ratio is suspicious: ${path}`, "ZIP_LIMIT");
    if (!hasBytes(bytes, localOffset, 30) || readUint32(bytes, localOffset) !== LOCAL_SIGNATURE) throw error(`ZIP local header is invalid: ${path}`, "ZIP_INVALID");
    const localFilenameLength = readUint16(bytes, localOffset + 26);
    const localExtraLength = readUint16(bytes, localOffset + 28);
    if (!hasBytes(bytes, localOffset + 30, localFilenameLength + localExtraLength)) throw error(`ZIP local filename record is invalid: ${path}`, "ZIP_INVALID");
    let localPath;
    try { localPath = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(localOffset + 30, localOffset + 30 + localFilenameLength)); }
    catch { throw error(`ZIP local filename is invalid UTF-8: ${path}`, "ZIP_INVALID"); }
    if (localPath !== path) throw error(`ZIP local filename does not match central metadata: ${path}`, "ZIP_INVALID");
    const dataOffset = localOffset + 30 + localFilenameLength + localExtraLength;
    if (!hasBytes(bytes, dataOffset, compressedSize)) throw error(`ZIP data is outside the archive: ${path}`, "ZIP_INVALID");
    if (readUint16(bytes, localOffset + 8) !== compression) throw error(`ZIP compression metadata does not match: ${path}`, "ZIP_INVALID");
    if (isSymlink(bytes, cursor)) throw error(`ZIP symlinks are not allowed: ${path}`, "ZIP_INVALID");
    entries.push({ path, flags, compression, compressedSize, uncompressedSize, dataOffset });
    cursor += 46 + filenameLength + extraLength + commentLength;
  }
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) throw error("ZIP contains duplicate entries", "ZIP_INVALID");

  const files = new Map();
  for (const entry of entries) {
    const compressed = bytes.slice(entry.dataOffset, entry.dataOffset + entry.compressedSize);
    let file;
    try {
      file = entry.compression === 0
        ? compressed
        : new Uint8Array(inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.uncompressedSize) }));
    } catch { throw error(`ZIP entry could not be decompressed: ${entry.path}`, "ZIP_INVALID"); }
    if (file.byteLength !== entry.uncompressedSize) throw error(`ZIP size metadata does not match: ${entry.path}`, "ZIP_INVALID");
    files.set(entry.path, file);
  }
  return { bytes, entries, files, totalUncompressed };
}

function isWebP(bytes) {
  return bytes.byteLength >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
}

function parseJson(bytes, name) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw error(`${name} is not valid UTF-8 JSON`, "PACKAGE_INVALID"); }
}

function readUint24(bytes, offset) {
  if (!hasBytes(bytes, offset, 3)) throw error("image header is truncated", "PACKAGE_INVALID");
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function pngInfo(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.byteLength < 29 || !signature.every((value, index) => bytes[index] === value)) throw error("Pet spritesheet is not a valid PNG", "PACKAGE_INVALID");
  if (readUint32(bytes, 8) !== 0x0d000000 || new TextDecoder().decode(bytes.slice(12, 16)) !== "IHDR") throw error("Pet PNG is missing its IHDR header", "PACKAGE_INVALID");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false), hasAlpha: bytes[25] === 6, format: "png" };
}

function webPInfo(bytes) {
  if (!isWebP(bytes)) throw error("Pet spritesheet is not a valid WebP image", "PACKAGE_INVALID");
  let offset = 12;
  let dimensions = null;
  let alphaChunk = false;
  let alphaCapable = false;
  while (offset + 8 <= bytes.byteLength) {
    const type = new TextDecoder().decode(bytes.slice(offset, offset + 4));
    const size = readUint32(bytes, offset + 4);
    const dataOffset = offset + 8;
    if (!hasBytes(bytes, dataOffset, size)) throw error("Pet WebP chunk is truncated", "PACKAGE_INVALID");
    if (type === "ALPH") alphaChunk = true;
    if (type === "VP8X" && size >= 10) {
      dimensions = { width: readUint24(bytes, dataOffset + 4) + 1, height: readUint24(bytes, dataOffset + 7) + 1 };
      alphaCapable = (bytes[dataOffset] & 0x10) !== 0;
    } else if (type === "VP8L" && size >= 5 && bytes[dataOffset] === 0x2f) {
      const bits = readUint32(bytes, dataOffset + 1);
      dimensions = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      alphaCapable = true;
    } else if (type === "VP8 " && size >= 10 && bytes[dataOffset + 3] === 0x9d && bytes[dataOffset + 4] === 0x01 && bytes[dataOffset + 5] === 0x2a) {
      dimensions = {
        width: readUint16(bytes, dataOffset + 6) & 0x3fff,
        height: readUint16(bytes, dataOffset + 8) & 0x3fff,
      };
    }
    offset = dataOffset + size + (size & 1);
  }
  if (!dimensions) throw error("Pet WebP dimensions could not be read", "PACKAGE_INVALID");
  return { ...dimensions, hasAlpha: alphaCapable || alphaChunk, format: "webp" };
}

function validateThemeManifest(manifest, slug, prefix = "") {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.id !== slug || manifest.hero !== "hero.webp") throw error("theme manifest does not match the published skin", "PACKAGE_INVALID");
  for (const [field, expected] of [["logo", "logo.webp"], ["polaroid", "polaroid.webp"]]) {
    if (manifest[field] !== undefined && manifest[field] !== expected) throw error(`theme ${field} must be ${expected}`, "PACKAGE_INVALID");
  }
  return {
    manifest,
    requiredFiles: ["theme.json", "hero.webp", manifest.logo, manifest.polaroid].filter(Boolean).map((name) => `${prefix}${name}`),
  };
}

function assertFilesPresent(parsed, paths) {
  for (const path of paths) if (!parsed.files.has(path)) throw error(`published skin package is missing ${path}`, "PACKAGE_INVALID");
}

function assertPackageLayout(parsed, allowedFiles, kind) {
  const allowed = new Set(allowedFiles);
  for (const path of parsed.files.keys()) if (!allowed.has(path)) throw error(`${path} is not allowed in a ${kind} package`, "PACKAGE_INVALID");
}

function validateLegacyPackage(parsed, slug) {
  assertPackageLayout(parsed, LEGACY_FILES, "theme");
  const manifestBytes = parsed.files.get("theme.json");
  const hero = parsed.files.get("hero.webp");
  if (!manifestBytes || !hero) throw error("published skin package must contain theme.json and hero.webp", "PACKAGE_INVALID");
  const manifest = parseJson(manifestBytes, "theme.json");
  const theme = validateThemeManifest(manifest, slug);
  assertFilesPresent(parsed, theme.requiredFiles);
  for (const name of ["hero.webp", "logo.webp", "polaroid.webp"]) if (parsed.files.has(name) && !isWebP(parsed.files.get(name))) throw error(`${name} is not a valid WebP image`, "PACKAGE_INVALID");
  return { kind: "theme", manifest, themeManifest: manifest, hasPet: false };
}

function validatePairedPackage(parsed, slug) {
  assertPackageLayout(parsed, PAIRED_FILES, "paired");
  const required = ["bundle.json", "pet-contract.json", "theme/theme.json", "theme/hero.webp", "pet/pet.json"];
  assertFilesPresent(parsed, required);
  const bundle = parseJson(parsed.files.get("bundle.json"), "bundle.json");
  const contract = parseJson(parsed.files.get("pet-contract.json"), "pet-contract.json");
  const themeManifest = parseJson(parsed.files.get("theme/theme.json"), "theme/theme.json");
  const petManifest = parseJson(parsed.files.get("pet/pet.json"), "pet/pet.json");
  if (bundle.schemaVersion !== 1 || bundle.id !== slug || bundle.themeId !== slug || bundle.petId !== slug) throw error("paired archive requires matching bundle, theme, and Pet ids", "PACKAGE_INVALID");
  if (bundle.themePath !== "theme" || bundle.petPath !== "pet") throw error("paired archive paths must be theme and pet", "PACKAGE_INVALID");
  if (themeManifest.id !== slug || petManifest.id !== slug) throw error("paired archive requires matching bundle, theme, and Pet ids", "PACKAGE_INVALID");
  const theme = validateThemeManifest(themeManifest, slug, "theme/");
  assertFilesPresent(parsed, theme.requiredFiles);
  for (const name of ["theme/hero.webp", "theme/logo.webp", "theme/polaroid.webp"]) if (parsed.files.has(name) && !isWebP(parsed.files.get(name))) throw error(`${name} is not a valid WebP image`, "PACKAGE_INVALID");

  if (contract.schemaVersion !== 1 || contract.contractVersion !== PAIRED_CONTRACT_VERSION || bundle.contractVersion !== contract.contractVersion) throw error("paired contractVersion must match the observed Codex V2 Pet contract", "PACKAGE_INVALID");
  if (contract.status !== "observed" || contract.spriteVersionNumber !== 2 || contract.grid?.columns !== 8 || contract.grid?.rows !== 11 || contract.frame?.width !== 192 || contract.frame?.height !== 208 || contract.spritesheet?.colorMode !== "rgba") throw error("pet-contract.json does not describe the observed 8x11 RGBA Codex V2 contract", "PACKAGE_INVALID");
  if (petManifest.spriteVersionNumber !== 2 || (petManifest.contractVersion !== undefined && petManifest.contractVersion !== contract.contractVersion)) throw error("Pet manifest does not match pet-contract.json", "PACKAGE_INVALID");
  if (!["spritesheet.png", "spritesheet.webp"].includes(petManifest.spritesheetPath)) throw error("Pet spritesheetPath must be spritesheet.png or spritesheet.webp", "PACKAGE_INVALID");
  const spritesheetPath = `pet/${petManifest.spritesheetPath}`;
  assertFilesPresent(parsed, [spritesheetPath]);
  if (parsed.files.has("pet/spritesheet.png") && parsed.files.has("pet/spritesheet.webp")) throw error("paired archive must contain exactly one Pet spritesheet", "PACKAGE_INVALID");
  const formats = Array.isArray(contract.spritesheet?.format) ? contract.spritesheet.format : [contract.spritesheet?.format];
  const format = petManifest.spritesheetPath.endsWith(".png") ? "png" : "webp";
  if (!formats.includes(format)) throw error("Pet spritesheet format is not allowed by pet-contract.json", "PACKAGE_INVALID");
  const image = format === "png" ? pngInfo(parsed.files.get(spritesheetPath)) : webPInfo(parsed.files.get(spritesheetPath));
  if (image.width !== 1536 || image.height !== 2288) throw error("Pet spritesheet must be 1536x2288", "PACKAGE_INVALID");
  if (!image.hasAlpha) throw error("Pet spritesheet must provide an alpha channel", "PACKAGE_INVALID");
  return { kind: "paired", manifest: themeManifest, themeManifest, bundleManifest: bundle, petManifest, contract, spritesheetPath, image, hasPet: true };
}

function validatePublicMetadata(packageInfo, metadata = {}) {
  if (metadata.packageKind !== undefined && !["theme", "paired"].includes(metadata.packageKind)) throw error("public package metadata has an unsupported packageKind", "PACKAGE_INVALID");
  if (metadata.packageKind !== undefined && metadata.packageKind !== packageInfo.kind) throw error("public package metadata does not match the downloaded archive", "PACKAGE_INVALID");
  if (typeof metadata.hasPet === "boolean" && metadata.hasPet !== packageInfo.hasPet) throw error("public package metadata does not match the downloaded archive", "PACKAGE_INVALID");
  if (packageInfo.kind === "paired" && metadata.pet) {
    if (metadata.pet.id !== undefined && metadata.pet.id !== packageInfo.petManifest.id) throw error("public Pet metadata does not match the downloaded archive", "PACKAGE_INVALID");
    if (metadata.pet.contractVersion !== undefined && metadata.pet.contractVersion !== packageInfo.contract.contractVersion) throw error("public Pet metadata does not match the downloaded archive", "PACKAGE_INVALID");
  }
  return packageInfo;
}

function validatePackage(parsed, slug, publicMetadata = {}) {
  const packageInfo = parsed.files.has("bundle.json") ? validatePairedPackage(parsed, slug) : validateLegacyPackage(parsed, slug);
  return validatePublicMetadata(packageInfo, publicMetadata);
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function appDataRoot() {
  if (platform() === "win32") return process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

async function requestDownloadGrant(endpoint, slug) {
  const response = await fetchResponse(endpointUrl(endpoint, `/api/skins/${encodeURIComponent(slug)}/download-grant`), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ confirm: true }),
  });
  let grant;
  try { grant = await response.json(); } catch { throw error("download grant response was not valid JSON", "REMOTE_RESPONSE_INVALID"); }
  if (!grant || grant.status !== "granted" || typeof grant.downloadUrl !== "string" || typeof grant.packageSha256 !== "string") throw error("download grant response was invalid", "REMOTE_RESPONSE_INVALID");
  assertTrustedDownload(grant.downloadUrl);
  return grant;
}

async function downloadPublishedSkin(endpoint, slug) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw error("slug must use lowercase letters, numbers, and hyphens", "INVALID_ARGUMENT");
  const detail = await fetchJson(endpointUrl(endpoint, `/api/skins/${encodeURIComponent(slug)}`));
  if (detail.status !== "published") throw error("only published skins can be installed", "SKIN_NOT_PUBLISHED");
  if (!detail.installable || typeof detail.packageSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(detail.packageSha256)) throw error("this published skin has no verified package and cannot be installed", "SKIN_NOT_INSTALLABLE");
  const grant = await requestDownloadGrant(endpoint, slug);
  if (grant.packageSha256.toLowerCase() !== detail.packageSha256.toLowerCase()) throw error("download grant checksum does not match the published checksum", "PACKAGE_HASH_MISMATCH");
  const download = assertTrustedDownload(grant.downloadUrl);
  const response = await fetchResponse(download, { headers: { accept: "application/zip" } });
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_PACKAGE_BYTES) throw error("skin package exceeds the 50 MB limit", "ZIP_LIMIT");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_PACKAGE_BYTES) throw error("skin package exceeds the 50 MB limit", "ZIP_LIMIT");
  const actualHash = hash(bytes);
  if (actualHash.toLowerCase() !== detail.packageSha256.toLowerCase()) throw error("skin package checksum does not match the published checksum", "PACKAGE_HASH_MISMATCH");
  const parsed = parseZip(bytes);
  const packageInfo = validatePackage(parsed, slug, detail);
  return { detail, bytes, parsed, packageInfo, manifest: packageInfo.manifest, packageSha256: actualHash, grantExpiresAt: grant.expiresAt };
}

async function saveExtracted(parsed) {
  const directory = await mkdtemp(join(tmpdir(), "codex-skin-"));
  for (const [path, file] of parsed.files) {
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file, { mode: 0o600 });
  }
  return directory;
}

async function runApply(command, directory, port) {
  const args = [APPLY, command];
  if (directory) args.push(directory);
  args.push("--port", String(port), "--json");
  const { stdout, stderr } = await execFileAsync(process.execPath, args, { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  try { return JSON.parse(stdout); } catch { throw error(`${command} returned invalid JSON: ${stderr || stdout}`, "LOCAL_APPLY_FAILED"); }
}

async function applyAndWait(directory, port) {
  const validation = await runApply("validate", directory, port);
  if (validation.status !== "valid") throw error(validation.message || "local theme validation failed", "LOCAL_VALIDATION_FAILED");
  const applied = await runApply("apply", directory, port);
  if (applied.status === "applied") return { validation, application: applied };
  if (applied.status !== "scheduled") throw error(applied.message || "local theme application failed", "LOCAL_APPLY_FAILED");
  const deadline = Date.now() + 90_000;
  let status;
  do {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500));
    status = await runApply("status", null, port);
    if (status.status === "active") return { validation, application: applied, status };
    if (["failed", "stale"].includes(status.status)) throw error(`skin application did not become active: ${status.status}`, "LOCAL_APPLY_FAILED");
  } while (Date.now() < deadline);
  throw error("skin application remained scheduled for more than 90 seconds", "LOCAL_APPLY_TIMEOUT");
}

async function runSwitchPair(directory, contractPath, port) {
  const args = [SWITCH_PAIRED, "--bundle", directory, "--contract", contractPath, "--port", String(port), "--json"];
  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(process.execPath, args, { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 }));
  } catch (caught) {
    stdout = caught?.stdout;
    stderr = caught?.stderr;
    let detail = null;
    try { detail = JSON.parse(String(stderr || stdout)); } catch { detail = null; }
    throw error(detail?.message || `paired switch failed: ${stderr || stdout || caught.message}`, detail?.code || "LOCAL_PAIRED_SWITCH_FAILED");
  }
  try { return JSON.parse(stdout); }
  catch { throw error(`paired switch returned invalid JSON: ${stderr || stdout}`, "LOCAL_PAIRED_SWITCH_FAILED"); }
}

function classifyPairedInstallResult(result) {
  const petSelection = result?.petSelection?.selection || result?.pairedState?.petSelection || "refresh-required";
  const assetLoaded = result?.petSelection?.assetLoaded === true || result?.pairedState?.petUi?.assetLoaded === true;
  const applicationStatus = result?.theme?.status || result?.pairedState?.themeStatus || "unknown";
  const complete = petSelection === "native-ui-confirmed" && assetLoaded && ["applied", "active"].includes(applicationStatus);
  return {
    status: complete ? "installed" : "partially_installed",
    complete,
    applicationStatus,
    petSelection,
    assetLoaded,
    switchResult: result,
    ...(complete ? {} : { nextAction: result?.nextAction || "Open ChatGPT Desktop Settings > Pets > Refresh, select the installed Pet, and confirm its overlay is visible." }),
  };
}

async function installExtractedPackage(directory, packageInfo, options = {}, dependencies = {}) {
  const port = options.port ?? 9341;
  const applyTheme = dependencies.applyTheme || applyAndWait;
  const switchPair = dependencies.switchPair || runSwitchPair;
  if (packageInfo.kind === "paired") {
    const switched = await switchPair(directory, join(directory, "pet-contract.json"), port);
    return { packageKind: "paired", ...classifyPairedInstallResult(switched) };
  }
  const result = await applyTheme(directory, port);
  const applicationStatus = result.status?.status || result.application.status;
  if (applicationStatus !== "active" && applicationStatus !== "applied") throw error("skin application could not be confirmed", "LOCAL_APPLY_FAILED");
  return { packageKind: "theme", status: "installed", complete: true, applicationStatus, validation: result.validation, application: result.application, applicationState: result.status };
}

async function listSkins(options) {
  const url = endpointUrl(options.endpoint, "/api/skins");
  for (const [key, value] of [["q", options.query], ["target", options.target], ["category", options.category], ["palette", options.palette], ["sort", options.sort]]) if (value) url.searchParams.set(key, value);
  url.searchParams.set("limit", String(options.limit));
  const result = await fetchJson(url);
  if (!result || !Array.isArray(result.items)) throw error("remote skin catalog response did not contain an items array", "REMOTE_RESPONSE_INVALID");
  return { ...result, items: result.items.map((item) => normalizeCatalogItem(item, options.endpoint)) };
}

function normalizeCatalogItem(item, endpoint) {
  if (!item || typeof item !== "object" || typeof item.slug !== "string" || !item.slug) throw error("remote skin catalog contained an invalid item", "REMOTE_RESPONSE_INVALID");
  const detailUrl = endpointUrl(endpoint, `/skins/${encodeURIComponent(item.slug)}`).toString();
  let imageUrl = null;
  for (const candidate of [item.heroUrl, item.thumbnailUrl, item.previewUrl]) {
    if (typeof candidate !== "string" || !candidate) continue;
    try { imageUrl = assertTrustedOrigin(new URL(candidate, endpointUrl(endpoint).origin).toString()).toString(); break; } catch { /* Ignore an untrusted preview URL and keep the trusted detail link. */ }
  }
  return {
    slug: item.slug,
    title: item.title || item.slug,
    version: item.version || null,
    authorDisplayName: item.authorDisplayName || null,
    summary: item.summary || "",
    description: item.description || item.summary || "",
    targets: Array.isArray(item.targets) ? item.targets : [],
    categories: Array.isArray(item.categories) ? item.categories : [],
    palette: Array.isArray(item.palette) ? item.palette : [],
    downloads: Number.isFinite(item.downloads) ? item.downloads : 0,
    publishedAt: item.publishedAt || null,
    packageKind: item.packageKind || "theme",
    hasPet: item.hasPet === true,
    pet: item.pet || null,
    installable: item.installable === true || typeof item.packageSha256 === "string",
    downloadRequiresGrant: true,
    imageUrl,
    detailUrl,
  };
}

const PROMPT_HINTS = [
  { terms: ["cyberpunk", "neon", "synthwave", "\u8d5b\u535a", "\u9713\u8679"], categories: ["cyber-ui"], palette: ["cyan", "mixed"] },
  { terms: ["anime", "manga", "\u52a8\u6f2b", "\u65e5\u6f2b"], categories: ["anime-2d"] },
  { terms: ["mystic", "magic", "gothic", "arcane", "\u9b54\u6cd5", "\u795e\u79d8"], categories: ["mystic"] },
  { terms: ["cozy", "calm", "nature", "\u6e29\u6696", "\u81ea\u7136"], categories: ["cozy"], palette: ["green"] },
  { terms: ["minimal", "clean", "simple", "\u6781\u7b80", "\u7b80\u7ea6"], categories: ["minimal"], palette: ["paper"] },
  { terms: ["editorial", "premium", "magazine", "\u7f16\u8f91", "\u9ad8\u7ea7"], categories: ["editorial"] },
];

function promptTokens(prompt) {
  return [...new Set((prompt.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((token) => token.length > 1))];
}

function promptHints(prompt) {
  const value = prompt.toLocaleLowerCase();
  return PROMPT_HINTS.filter((hint) => hint.terms.some((term) => value.includes(term))).reduce((result, hint) => ({
    categories: [...new Set([...result.categories, ...(hint.categories || [])])],
    palette: [...new Set([...result.palette, ...(hint.palette || [])])],
  }), { categories: [], palette: [] });
}

function rankRecommendation(item, prompt) {
  const tokens = promptTokens(prompt);
  const hints = promptHints(prompt);
  const searchable = [item.title, item.summary, item.authorDisplayName, ...item.categories, ...item.palette, ...item.targets].join(" ").toLocaleLowerCase();
  const keywordMatches = tokens.filter((token) => searchable.includes(token));
  const categoryMatches = hints.categories.filter((category) => item.categories.includes(category));
  const paletteMatches = hints.palette.filter((palette) => item.palette.includes(palette));
  const score = keywordMatches.length * 5 + categoryMatches.length * 4 + paletteMatches.length * 2 + Math.min(item.downloads / 1000, 1);
  return {
    ...item,
    recommendationScore: Number(score.toFixed(3)),
    recommendationReason: [...keywordMatches.map((token) => `keyword:${token}`), ...categoryMatches.map((category) => `category:${category}`), ...paletteMatches.map((palette) => `palette:${palette}`)],
  };
}

export async function recommendSkins(options) {
  const prompt = typeof options.prompt === "string" ? options.prompt.trim() : "";
  if (!prompt) throw error("recommend requires a non-empty --prompt", "INVALID_ARGUMENT");
  const target = options.target || "chatgpt";
  const direct = await listSkins({ ...options, query: prompt, target, sort: options.sort || "downloads" });
  let items = direct.items.map((item) => rankRecommendation(item, prompt));
  if (items.length === 0) {
    const broad = await listSkins({ ...options, query: undefined, target, sort: options.sort || "downloads", limit: 48 });
    items = broad.items.map((item) => rankRecommendation(item, prompt)).sort((left, right) => right.recommendationScore - left.recommendationScore || right.downloads - left.downloads).slice(0, options.limit);
  }
  return { status: "ok", mode: "prompt-recommendation", prompt, target, count: items.length, recommendations: items.slice(0, options.limit) };
}

function printResult(value, jsonOutput) {
  if (jsonOutput) console.log(JSON.stringify(value, null, 2));
  else if (value.recommendations) console.log(value.recommendations.map((item, index) => [
    `### ${index + 1}. ${item.title}${item.version ? ` ${item.version}` : ""}`,
    item.imageUrl ? `![${item.title}](${item.imageUrl})` : `[Preview and full description](${item.detailUrl})`,
    item.description,
    `Author: ${item.authorDisplayName || "Community contributor"} | Downloads: ${item.downloads}`,
    `[Open details](${item.detailUrl}) | Install after explicit confirmation`,
  ].join("\n")).join("\n\n") || "No matching published skins found.");
  else if (value.items) console.log(value.items.map((item) => `${item.slug}\t${item.title}\t${item.version}\t${item.installable ? "installable" : "metadata-only"}`).join("\n") || "No published skins found.");
  else if (value.status === "downloaded") console.log(`Downloaded ${value.title} to ${value.path}`);
  else if (value.status === "partially_installed") console.log(`Installed ${value.title} locally, but Pet selection still requires Refresh in ChatGPT Desktop Settings > Pets.`);
  else console.log(`Installed ${value.title}. Application status: ${value.applicationStatus}.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "recommend") {
    printResult(await recommendSkins(options), options.json);
    return;
  }
  if (options.command === "list") {
    printResult(await listSkins(options), options.json);
    return;
  }
  if (options.command !== "install") throw error("usage: remote-skins.mjs recommend --prompt \"...\" [filters] | list [filters] | install --slug <slug> --confirm-install [--download-only]", "INVALID_ARGUMENT");
  if (!options.slug) throw error("skin slug is required", "INVALID_ARGUMENT");
  if (!options.confirmInstall) throw error("explicit installation consent is required; pass --confirm-install only after the user agrees", "CONFIRMATION_REQUIRED");
  const downloaded = await downloadPublishedSkin(options.endpoint, options.slug);
  if (options.downloadOnly) {
    const target = resolve(options.output || join(appDataRoot(), "downloads", `${options.slug}-${downloaded.packageSha256.slice(0, 12)}.zip`));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, downloaded.bytes, { mode: 0o600 });
    printResult({ status: "downloaded", slug: options.slug, title: downloaded.detail.title, path: target, packageKind: downloaded.packageInfo.kind, hasPet: downloaded.packageInfo.hasPet, packageSha256: downloaded.packageSha256 }, options.json);
    return;
  }
  const directory = await saveExtracted(downloaded.parsed, downloaded.packageInfo);
  try {
    const installed = await installExtractedPackage(directory, downloaded.packageInfo, { port: options.port });
    printResult({ ...installed, slug: options.slug, title: downloaded.detail.title, packageSha256: downloaded.packageSha256, hasPet: downloaded.packageInfo.hasPet, pet: downloaded.packageInfo.kind === "paired" ? { id: downloaded.packageInfo.petManifest.id, displayName: downloaded.packageInfo.petManifest.displayName, contractVersion: downloaded.packageInfo.contract.contractVersion } : undefined }, options.json);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export { classifyPairedInstallResult, downloadPublishedSkin, endpointUrl, installExtractedPackage, listSkins, normalizeCatalogItem, parseArgs, parseZip, rankRecommendation, requestDownloadGrant, saveExtracted, validatePackage };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((caught) => {
    const result = { status: "failed", code: caught?.code || "REMOTE_SKIN_FAILED", message: caught?.message || String(caught) };
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  });
}
