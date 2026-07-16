import { lstat, readFile, realpath } from "node:fs/promises";
import {
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

import { THEME_SCHEMA_VERSION } from "./constants.mjs";

const COLOR_KEYS = ["accent", "secondary", "surface", "text"];
const COPY_KEYS = ["brand", "headline", "tagline"];
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const HEX_COLOR = /^#[0-9A-F]{6}$/i;
const THEME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_COLORS = {
  accent: "#4BC2E0",
  secondary: "#AD7ED5",
  surface: "#FAFAFF",
  text: "#122C60",
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInside(root, candidate) {
  const relativePath = relative(root, candidate);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function normalizeAssetPath(value, field) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    value.split(/[\\/]+/).includes("..")
  ) {
    throw new Error(`theme ${field} must be a relative path inside the theme directory`);
  }
  if (!IMAGE_EXTENSIONS.has(extname(value).toLowerCase())) {
    throw new Error(`theme ${field} must be PNG, JPEG, or WebP`);
  }
  return value;
}

function normalizeHero(hero) {
  return normalizeAssetPath(hero, "hero");
}

function normalizeColors(colors) {
  if (colors != null && !isRecord(colors)) {
    throw new Error("theme colors must be an object");
  }
  return Object.fromEntries(
    COLOR_KEYS.map((key) => {
      const configured = colors?.[key];
      const value = configured === undefined ? DEFAULT_COLORS[key] : configured;
      if (typeof value !== "string" || !HEX_COLOR.test(value)) {
        throw new Error(`${key} must be a six-digit hex color`);
      }
      return [key, value.toUpperCase()];
    }),
  );
}

function normalizeCopy(copy) {
  if (copy == null) return null;
  if (!isRecord(copy)) {
    throw new Error("theme copy must be null or an object");
  }

  return Object.fromEntries(
    COPY_KEYS.filter((key) => copy[key] !== undefined).map((key) => {
      if (typeof copy[key] !== "string") {
        throw new Error(`copy.${key} must be a string`);
      }
      return [key, copy[key]];
    }),
  );
}

export function validateThemeManifest(input) {
  if (!isRecord(input)) {
    throw new Error("theme manifest must be an object");
  }
  if (input.schemaVersion !== THEME_SCHEMA_VERSION) {
    throw new Error(`unsupported theme schema ${input.schemaVersion}`);
  }
  if (typeof input.id !== "string" || !THEME_ID.test(input.id)) {
    throw new Error("theme id must use lowercase letters, numbers, and hyphens");
  }
  if (typeof input.name !== "string" || !input.name.trim()) {
    throw new Error("theme name must be a non-empty string");
  }

  return {
    schemaVersion: THEME_SCHEMA_VERSION,
    id: input.id,
    name: input.name.trim(),
    hero: normalizeHero(input.hero),
    logo: input.logo === undefined || input.logo === null ? null : normalizeAssetPath(input.logo, "logo"),
    polaroid: input.polaroid === undefined || input.polaroid === null ? null : normalizeAssetPath(input.polaroid, "polaroid"),
    colors: normalizeColors(input.colors),
    copy: normalizeCopy(input.copy),
  };
}

async function resolveAsset(root, realRoot, relative, field) {
  const assetPath = resolve(root, relative);
  if (!isInside(root, assetPath)) {
    throw new Error(`theme ${field} escapes the theme directory`);
  }
  const realAssetPath = await realpath(assetPath);
  if (!isInside(realRoot, realAssetPath)) {
    throw new Error(`theme ${field} escapes the theme directory`);
  }
  const info = await lstat(assetPath);
  if (!info.isFile() || info.size < 1) {
    throw new Error(`theme ${field} must be a non-empty file`);
  }
  return assetPath;
}

export async function loadTheme(themeDir) {
  const root = resolve(themeDir);
  const raw = JSON.parse(await readFile(join(root, "theme.json"), "utf8"));
  const manifest = validateThemeManifest(raw);
  const realRoot = await realpath(root);
  const heroPath = await resolveAsset(root, realRoot, manifest.hero, "hero");
  const logoPath = manifest.logo ? await resolveAsset(root, realRoot, manifest.logo, "logo") : null;
  const polaroidPath = manifest.polaroid ? await resolveAsset(root, realRoot, manifest.polaroid, "polaroid") : null;

  return { manifest, heroPath, logoPath, polaroidPath, root };
}
