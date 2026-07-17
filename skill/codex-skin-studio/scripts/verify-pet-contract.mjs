#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPetContract, petError } from "./pet.mjs";

const json = (value) => JSON.stringify(value, null, 2);

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") { options.set("json", true); continue; }
    if (!arg.startsWith("--")) throw petError("PET_INPUT_INVALID", `unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw petError("PET_INPUT_INVALID", `missing value for --${key}`);
    if (options.has(key)) throw petError("PET_INPUT_INVALID", `duplicate option: --${key}`);
    options.set(key, value);
  }
  const source = options.get("source");
  const contract = options.get("contract");
  if (!source) throw petError("PET_INPUT_INVALID", "missing required option: --source");
  if (!contract) throw petError("PET_INPUT_INVALID", "missing required option: --contract");
  return { source: resolve(source), contract: resolve(contract), platform: options.get("platform") || process.platform };
}

function assertEvidence(source, pattern, label) {
  if (!pattern.test(source)) throw petError("PET_CONTRACT_MISMATCH", `official hatch-pet contract is missing ${label}`);
}

export async function verifyPetContract({ source, contract, platform = process.platform } = {}) {
  const sourcePath = resolve(source);
  const contractPath = resolve(contract);
  let markdown;
  try { markdown = await readFile(sourcePath, "utf8"); }
  catch (error) { throw petError("PET_CONTRACT_MISMATCH", `official hatch-pet contract could not be read: ${sourcePath}`, { cause: error.message }); }
  const observed = await loadPetContract(contractPath);
  assertEvidence(markdown, /spriteVersionNumber:\s*2/i, "spriteVersionNumber: 2");
  assertEvidence(markdown, /1536\s*x\s*2288/i, "1536x2288 dimensions");
  assertEvidence(markdown, /8\s+columns\s+x\s+11\s+rows/i, "8x11 grid");
  assertEvidence(markdown, /192\s*x\s*208/i, "192x208 cells");
  assertEvidence(markdown, /transparent/i, "transparent background");
  assertEvidence(markdown, /Rows\s+`0-8`\s*:\s*standard/i, "standard animation rows");
  assertEvidence(markdown, /Rows\s+`9-10`\s*:\s*16\s+clockwise\s+look\s+directions/i, "look-direction rows");
  assertEvidence(markdown, /000.*up.*12 o'clock/i, "look-direction zero semantics");
  assertEvidence(markdown, /1536x1872.*intermediate/i, "8x9 intermediate boundary");
  for (const direction of observed.lookDirections) assertEvidence(markdown, new RegExp(`\\b${direction.replace(".", "\\.")}\\b`), `look direction ${direction}`);
  const sourceDigest = createHash("sha256").update(markdown).digest("hex");
  return {
    status: "verified",
    platform,
    source: sourcePath,
    sourceDigest,
    contract: contractPath,
    contractVersion: observed.contractVersion,
    evidence: {
      spriteVersionNumber: observed.spriteVersionNumber,
      dimensions: `${observed.grid.columns * observed.frame.width}x${observed.grid.rows * observed.frame.height}`,
      grid: `${observed.grid.columns}x${observed.grid.rows}`,
      cell: `${observed.frame.width}x${observed.frame.height}`,
      lookDirections: observed.lookDirections.length,
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyPetContract(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${json(result)}\n`);
  } catch (error) {
    process.stderr.write(`${json({ status: "failed", code: error.code || "PET_CONTRACT_MISMATCH", message: error.message, details: error.details })}\n`);
    process.exitCode = 1;
  }
}

export { parseArgs };
