#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "skill", "codex-skin-studio");
const OUTPUT = join(ROOT, "output", "codex-skin-studio.skill");
const EXPECTED = [
  "SKILL.md",
  "agents/openai.yaml",
  "examples/cyberpunk/prompt.md",
  "examples/cyberpunk/theme.json",
  "examples/pets/mascot/pet.json",
  "examples/pets/mascot/spritesheet.webp",
  "examples/slayers-xellos-night/hero.webp",
  "examples/slayers-xellos-night/theme.json",
  "scripts/apply.mjs",
  "scripts/create-paired.mjs",
  "scripts/create-pet.mjs",
  "scripts/create-theme.mjs",
  "scripts/install-pet.mjs",
  "scripts/paired-status.mjs",
  "scripts/paired.mjs",
  "scripts/pet.mjs",
  "scripts/pet-desktop.mjs",
  "scripts/persist.mjs",
  "scripts/switch-paired.mjs",
  "scripts/validate-pet.mjs",
  "scripts/verify-pet-contract.mjs",
  "scripts/verify-pet-desktop.mjs",
  "scripts/windows/apply.ps1",
  "templates/pet-contract.json",
  "templates/pet.json",
  "templates/theme.json",
];

const DOS_TIME = 0;
const DOS_DATE = 0x0021;

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function localHeader(name, checksum, size) {
  const nameBytes = Buffer.from(name, "utf8");
  return Buffer.concat([
    u32(0x04034b50), u16(20), u16(0), u16(0), u16(DOS_TIME), u16(DOS_DATE),
    u32(checksum), u32(size), u32(size), u16(nameBytes.length), u16(0), nameBytes,
  ]);
}

function centralHeader(name, checksum, size, offset) {
  const nameBytes = Buffer.from(name, "utf8");
  return Buffer.concat([
    u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(DOS_TIME), u16(DOS_DATE),
    u32(checksum), u32(size), u32(size), u16(nameBytes.length), u16(0), u16(0),
    u16(0), u16(0), u32(0), u32(offset), nameBytes,
  ]);
}

function endOfCentralDirectory(count, size, offset) {
  return Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(count), u16(count), u32(size), u32(offset), u16(0),
  ]);
}

async function collectFiles(directory, prefix = "") {
  const entries = [];
  const names = (await readdir(join(directory, prefix), { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of names) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) entries.push(...await collectFiles(directory, relativePath));
    else if (entry.isFile()) entries.push(relativePath.replaceAll("\\", "/"));
    else throw new Error(`unsupported source entry: ${relativePath}`);
  }
  return entries;
}

function directoryEntries(files) {
  const directories = new Set(["codex-skin-studio/"]);
  for (const file of files) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(`codex-skin-studio/${parts.slice(0, index).join("/")}/`);
    }
  }
  return [...directories].sort((left, right) => left.localeCompare(right));
}

async function buildArchive(files) {
  const archiveEntries = [];
  for (const directory of directoryEntries(files)) archiveEntries.push({ name: directory, data: Buffer.alloc(0) });
  for (const file of files.sort((left, right) => left.localeCompare(right))) {
    archiveEntries.push({ name: `codex-skin-studio/${file}`, data: await readFile(join(SOURCE, file)) });
  }

  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of archiveEntries) {
    const checksum = crc32(entry.data);
    const header = localHeader(entry.name, checksum, entry.data.length);
    localParts.push(header, entry.data);
    centralParts.push(centralHeader(entry.name, checksum, entry.data.length, offset));
    offset += header.length + entry.data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  return Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory(archiveEntries.length, centralDirectory.length, offset)]);
}

async function packageSkill() {
  const actual = await collectFiles(SOURCE);
  const expected = [...EXPECTED].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`unexpected files in codex-skin-studio Skill\nexpected: ${expected.join(", ")}\nactual: ${actual.join(", ")}`);
  }
  const archive = await buildArchive(actual);
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, archive);
  return { output: OUTPUT, sha256: createHash("sha256").update(archive).digest("hex"), bytes: archive.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await packageSkill();
    process.stdout.write(`${result.output}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

export { EXPECTED, OUTPUT, packageSkill };
