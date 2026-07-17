#!/usr/bin/env node

import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { appDataRoot, commandApply, commandStatus, loadTheme } from "./apply.mjs";
import { defaultPetsDir, installPet, loadPetContract, petError, petStatus, recordPetSelection, validatePetDirectory } from "./pet.mjs";
import { selectPetInChatGptDesktop } from "./pet-desktop.mjs";

const BUNDLE_SCHEMA = 1;

const json = (value) => JSON.stringify(value, null, 2);

async function readJson(file, code = "PAIR_BUNDLE_INVALID") {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { throw petError(code, `invalid JSON: ${file}`, { cause: error.message }); }
}

function assertInside(root, candidate, label) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(prefix)) throw petError("PAIR_PATH_UNSAFE", `${label} must remain inside ${resolvedRoot}`);
  return resolvedCandidate;
}

function assertId(value, label) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(value)) throw petError("PAIR_BUNDLE_INVALID", `${label} must be a lowercase id`);
  return value;
}

export async function validatePairBundle(directory, { contract, allowProvisional = false } = {}) {
  const root = resolve(directory);
  const manifest = await readJson(join(root, "bundle.json"));
  if (manifest.schemaVersion !== BUNDLE_SCHEMA) throw petError("PAIR_BUNDLE_INVALID", `unsupported bundle schema: ${manifest.schemaVersion}`);
  assertId(manifest.id, "bundle id");
  if (typeof manifest.displayName !== "string" || !manifest.displayName.trim()) throw petError("PAIR_BUNDLE_INVALID", "bundle displayName is required");
  if (manifest.themeId !== manifest.id || manifest.petId !== manifest.id) throw petError("PAIR_BUNDLE_INVALID", "MVP paired bundles require matching theme and pet ids");
  if (manifest.contractVersion !== contract.contractVersion) throw petError("PET_CONTRACT_MISMATCH", "bundle contractVersion does not match the selected contract");
  if (manifest.themePath !== "theme" || manifest.petPath !== "pet") throw petError("PAIR_BUNDLE_INVALID", "bundle themePath and petPath must be theme and pet");
  const themePath = assertInside(root, join(root, manifest.themePath), "theme path");
  const petPath = assertInside(root, join(root, manifest.petPath), "pet path");
  const theme = await loadTheme(themePath);
  const pet = await validatePetDirectory(petPath, { contract, allowProvisional });
  return { status: "valid", id: manifest.id, displayName: manifest.displayName, directory: root, bundle: manifest, theme, pet, contractVersion: manifest.contractVersion };
}

async function directoryHash(directory) {
  const hash = createHash("sha256");
  for (const file of [join(directory, "bundle.json"), join(directory, "theme", "theme.json"), join(directory, "pet", "pet.json")]) hash.update(await readFile(file));
  return hash.digest("hex");
}

export async function createPairBundle({ id, displayName, themeDir, petDir, out, contract, replace = false } = {}) {
  const bundleId = assertId(id, "bundle id");
  const sourceTheme = resolve(themeDir);
  const sourcePet = resolve(petDir);
  await validatePetDirectory(sourcePet, { contract });
  await loadTheme(sourceTheme);
  const output = resolve(out);
  await mkdir(dirname(output), { recursive: true });
  const staging = `${output}.staging-${process.pid}-${Date.now()}`;
  await rm(staging, { recursive: true, force: true });
  try {
    await mkdir(staging, { recursive: true });
    await cp(sourceTheme, join(staging, "theme"), { recursive: true, errorOnExist: true });
    await cp(sourcePet, join(staging, "pet"), { recursive: true, errorOnExist: true });
    await writeFile(join(staging, "bundle.json"), `${json({ schemaVersion: BUNDLE_SCHEMA, id: bundleId, displayName: String(displayName || bundleId).trim(), themeId: bundleId, petId: bundleId, themePath: "theme", petPath: "pet", contractVersion: contract.contractVersion, createdAt: new Date().toISOString(), selection: "refresh-required" })}\n`);
    const result = await validatePairBundle(staging, { contract });
    if (!replace) {
      try {
        await stat(output);
        throw petError("PAIR_BUNDLE_INVALID", `bundle output already exists: ${output}; pass --replace to overwrite`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const backup = `${output}.backup-${process.pid}-${Date.now()}`;
    let hadOutput = false;
    try { await rename(output, backup); hadOutput = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
    try { await rename(staging, output); } catch (error) { if (hadOutput) await rename(backup, output); throw error; }
    if (hadOutput) await rm(backup, { recursive: true, force: true });
    return { status: "created", id: bundleId, directory: output, bundlePath: join(output, "bundle.json"), contentHash: await directoryHash(output), contractVersion: result.contractVersion };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function switchPairBundle(directory, { contract, petsDir = defaultPetsDir(), port = 9341, replace = true, allowProvisional = false, nativePet = true, selectPetFn = selectPetInChatGptDesktop, commandApplyFn = commandApply, appDataRootFn = appDataRoot } = {}) {
  const bundle = await validatePairBundle(directory, { contract, allowProvisional });
  const petInstall = await installPet(join(bundle.directory, bundle.bundle.petPath), { petsDir, contract, replace, allowProvisional });
  const themeApplication = await commandApplyFn(join(bundle.directory, bundle.bundle.themePath), port);
  let petSelection;
  if (!nativePet) {
    petSelection = { status: "manual", selection: "refresh-required", reason: "native Pet UI selection was disabled" };
  } else {
    try {
      petSelection = await selectPetFn({ petId: bundle.bundle.petId, port });
    } catch (error) {
      petSelection = { status: "manual", selection: "refresh-required", code: error.code || "PET_NATIVE_UI_UNAVAILABLE", message: error.message };
    }
  }
  if (petSelection.selection === "native-ui-confirmed") {
    await recordPetSelection({ petsDir, petId: bundle.bundle.petId, selection: petSelection.selection, assetLoaded: petSelection.assetLoaded });
  }
  const stateRoot = appDataRootFn();
  await mkdir(stateRoot, { recursive: true });
  const pairedState = { schemaVersion: 1, bundleId: bundle.id, themeId: bundle.bundle.themeId, petId: bundle.bundle.petId, switchedAt: new Date().toISOString(), themeStatus: themeApplication.status, petStatus: petInstall.status, petSelection: petSelection.selection, petUi: petSelection };
  await writeFile(join(stateRoot, "paired-state.json"), `${json(pairedState)}\n`);
  const selected = petSelection.selection === "native-ui-confirmed";
  const themeStatus = themeApplication.status === "applied" ? "theme-applied" : "theme-scheduled";
  return { status: `${themeStatus}-pet-${selected ? "selected" : "refresh-required"}`, bundle: bundle.id, theme: themeApplication, pet: petInstall, petSelection, nextAction: selected ? "Confirm the matching ChatGPT Desktop Pet overlay is visible and animating." : "Open ChatGPT Desktop Settings > Pets > Refresh, choose the installed matching Pet, then confirm its overlay.", pairedState };
}

export async function pairedStatus({ petsDir = defaultPetsDir(), port = 9341 } = {}) {
  let pairState = null;
  try { pairState = await readJson(join(appDataRoot(), "paired-state.json")); } catch { pairState = null; }
  let theme;
  try { theme = await commandStatus(port); } catch (error) { theme = { status: "unavailable", message: error.message }; }
  return { status: "ok", pairState, theme, pet: await petStatus({ petsDir }) };
}

export { BUNDLE_SCHEMA };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.error(json({ status: "failed", code: "PAIR_INPUT_INVALID", message: "use create-paired.mjs, switch-paired.mjs, or paired-status.mjs" }));
  process.exitCode = 1;
}
