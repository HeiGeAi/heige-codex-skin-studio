#!/usr/bin/env node

import { selectPetInChatGptDesktop } from "./pet-desktop.mjs";
import { assertPetId, petError } from "./pet.mjs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const json = (value) => JSON.stringify(value, null, 2);

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") { options.set("json", true); continue; }
    if (arg === "--no-restore") { options.set("restore", false); continue; }
    if (!arg.startsWith("--")) throw petError("PET_INPUT_INVALID", `unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw petError("PET_INPUT_INVALID", `missing value for --${key}`);
    if (options.has(key)) throw petError("PET_INPUT_INVALID", `duplicate option: --${key}`);
    options.set(key, value);
  }
  const petId = options.get("pet-id");
  if (typeof petId !== "string" || !petId.trim()) throw petError("PET_INPUT_INVALID", "missing required option: --pet-id");
  assertPetId(petId.trim());
  const port = Number(options.get("port") || 9341);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw petError("PET_INPUT_INVALID", "--port must be an integer from 1 through 65535");
  return { petId: petId.trim(), port, restoreApp: options.get("restore") !== false };
}

export async function verifyPetDesktop(options, selectFn = selectPetInChatGptDesktop) {
  const result = await selectFn(options);
  if (result?.selection !== "native-ui-confirmed" || result?.assetLoaded !== true) {
    throw petError("PET_NATIVE_UI_UNAVAILABLE", "ChatGPT Desktop did not confirm native Pet selection and loaded sprite asset", { result });
  }
  return { status: "verified", ...result };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    process.stdout.write(`${json(await verifyPetDesktop(options))}\n`);
  } catch (error) {
    process.stderr.write(`${json({ status: "failed", code: error.code || "PET_NATIVE_UI_UNAVAILABLE", message: error.message, details: error.details })}\n`);
    process.exitCode = 1;
  }
}

export { parseArgs };
