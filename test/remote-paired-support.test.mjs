import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import test from "node:test";
import { promisify } from "node:util";

import {
  parseArgs as parseUploadArgs,
  prepareUploadPackage,
} from "../skill/codex-skin-studio/scripts/upload-theme.mjs";
import {
  classifyPairedInstallResult,
  installExtractedPackage,
  normalizeCatalogItem,
  parseArgs as parseRemoteArgs,
  parseZip,
  rankRecommendation,
  recommendSkins,
  saveExtracted,
  validatePackage,
} from "../skill/codex-skin-studio/scripts/remote-skins.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "output", "e2e-paired-neon-v4", "bundle");
const CONTRACT = join(ROOT, "skill", "codex-skin-studio", "templates", "pet-contract.json");
const SLUG = "neon-companion-actions-v4";
const execFileAsync = promisify(execFile);

function crc32(input) {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, value] of Object.entries(files)) {
    const data = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
    const nameBytes = encoder.encode(name);
    const checksum = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    localParts.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, localOffset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);
    localOffset += local.length;
  }
  const localSize = localParts.reduce((sum, part) => sum + part.length, 0);
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(localSize + centralSize + 22);
  let cursor = 0;
  for (const part of localParts) { output.set(part, cursor); cursor += part.length; }
  for (const part of centralParts) { output.set(part, cursor); cursor += part.length; }
  const end = new DataView(output.buffer, cursor, 22);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, localParts.length, true);
  end.setUint16(10, localParts.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, localSize, true);
  return output;
}

function pngHeader({ width = 1536, height = 2288, colorType = 6 } = {}) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes[24] = 8;
  bytes[25] = colorType;
  return bytes;
}

async function pairedFiles(overrides = {}) {
  const contract = JSON.parse(await readFile(CONTRACT, "utf8"));
  const files = {
    "bundle.json": JSON.stringify({
      schemaVersion: 1,
      id: SLUG,
      displayName: "Neon Companion",
      themeId: SLUG,
      petId: SLUG,
      themePath: "theme",
      petPath: "pet",
      contractVersion: contract.contractVersion,
    }),
    "pet-contract.json": JSON.stringify(contract),
    "theme/theme.json": JSON.stringify({ schemaVersion: 1, id: SLUG, name: "Neon Companion", hero: "hero.webp" }),
    "theme/hero.webp": Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]),
    "pet/pet.json": JSON.stringify({ id: SLUG, displayName: "Neon Companion", spriteVersionNumber: 2, spritesheetPath: "spritesheet.png" }),
    "pet/spritesheet.png": pngHeader(),
  };
  return { ...files, ...overrides };
}

test("paired upload requires exactly one source and creates the canonical archive", async () => {
  assert.throws(() => parseUploadArgs([]), /exactly one of --theme-dir or --bundle/);
  assert.throws(() => parseUploadArgs(["--theme-dir", "theme", "--bundle", "bundle", "--contract", CONTRACT]), /exactly one of --theme-dir or --bundle/);
  assert.throws(() => parseUploadArgs(["--bundle", BUNDLE]), /--contract/);

  const prepared = await prepareUploadPackage({ bundle: BUNDLE, contract: CONTRACT });
  assert.equal(prepared.packageKind, "paired");
  assert.equal(prepared.manifest.id, SLUG);
  const parsed = parseZip(prepared.packageBytes);
  assert.deepEqual([...parsed.files.keys()].sort(), [
    "bundle.json",
    "pet-contract.json",
    "pet/pet.json",
    "pet/spritesheet.png",
    "theme/hero.webp",
    "theme/theme.json",
  ]);
  assert.equal(validatePackage(parsed, SLUG, { packageKind: "paired", hasPet: true }).kind, "paired");
});

test("prompt recommendations expose trusted preview and detail links without permanent package URLs", async () => {
  assert.deepEqual(parseRemoteArgs(["recommend", "--prompt", "anime cyan", "--limit", "6", "--json"]), {
    command: "recommend",
    endpoint: "https://codexskinstudio.com",
    json: true,
    limit: 6,
    port: 9341,
    prompt: "anime cyan",
  });
  const item = normalizeCatalogItem({
    slug: "miku-signal",
    title: "Miku Signal",
    summary: "A cyan anime workspace.",
    categories: ["anime-2d"],
    palette: ["cyan"],
    heroUrl: "/media/miku.webp",
    installable: true,
  }, "https://codexskinstudio.com");
  assert.equal(item.imageUrl, "https://codexskinstudio.com/media/miku.webp");
  assert.equal(item.detailUrl, "https://codexskinstudio.com/skins/miku-signal");
  assert.equal(item.downloadUrl, undefined);
  assert.equal(item.downloadRequiresGrant, true);
  assert.equal(rankRecommendation(item, "anime cyan").recommendationReason.includes("category:anime-2d"), true);
  await assert.rejects(recommendSkins({ endpoint: "https://codexskinstudio.com", limit: 3 }), /non-empty --prompt/);
});

test("legacy theme packaging remains compatible with the legacy archive validator", async () => {
  const prepared = await prepareUploadPackage({
    themeDir: join(ROOT, "skill", "codex-skin-studio", "examples", "slayers-xellos-night"),
  });
  const validated = validatePackage(parseZip(prepared.packageBytes), "slayers-xellos-night", { packageKind: "theme", hasPet: false });
  assert.equal(prepared.packageKind, "theme");
  assert.equal(validated.kind, "theme");
  assert.equal(validated.manifest.id, "slayers-xellos-night");
});

test("paired upload CLI retains consent and HMAC signing with paired metadata", async () => {
  const secret = "test-only-upload-secret";
  let received = null;
  const server = createServer(async (request, response) => {
    try {
      const webRequest = new Request(`http://127.0.0.1${request.url}`, {
        method: request.method,
        headers: request.headers,
        body: Readable.toWeb(request),
        duplex: "half",
      });
      const form = await webRequest.formData();
      const metadataJson = String(form.get("metadata"));
      const packageBytes = new Uint8Array(await form.get("package").arrayBuffer());
      const timestamp = String(request.headers["x-codex-skin-timestamp"]);
      const requestId = String(request.headers["x-codex-skin-request-id"]);
      const packageHash = createHash("sha256").update(packageBytes).digest("hex");
      const metadataHash = createHash("sha256").update(metadataJson).digest("hex");
      const signature = createHmac("sha256", secret).update(["POST", "/api/submit", timestamp, requestId, packageHash, metadataHash].join("\n")).digest("hex");
      received = {
        metadata: JSON.parse(metadataJson),
        entries: [...parseZip(packageBytes).files.keys()].sort(),
        signature: request.headers["x-codex-skin-signature"],
        expectedSignature: signature,
        client: request.headers["x-codex-skin-client"],
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ slug: SLUG }));
    } catch (caught) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: caught.message }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      join(ROOT, "skill", "codex-skin-studio", "scripts", "upload-theme.mjs"),
      "--bundle", BUNDLE,
      "--contract", CONTRACT,
      "--endpoint", `http://127.0.0.1:${address.port}/api/submit`,
      "--confirm-share",
      "--json",
    ], { env: { ...process.env, CODEX_SKIN_STUDIO_UPLOAD_SECRET: secret }, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(JSON.parse(stdout).status, "pending_review");
  } finally {
    server.close();
    await once(server, "close");
  }
  assert.equal(received.metadata.packageKind, "paired");
  assert.equal(received.metadata.slug, SLUG);
  assert.equal(received.client, "codex-skin-studio");
  assert.equal(received.signature, received.expectedSignature);
  assert.deepEqual(received.entries, [
    "bundle.json",
    "pet-contract.json",
    "pet/pet.json",
    "pet/spritesheet.png",
    "theme/hero.webp",
    "theme/theme.json",
  ]);

  await assert.rejects(execFileAsync(process.execPath, [
    join(ROOT, "skill", "codex-skin-studio", "scripts", "upload-theme.mjs"),
    "--bundle", BUNDLE,
    "--contract", CONTRACT,
    "--endpoint", `http://127.0.0.1:${address.port}/api/submit`,
    "--json",
  ], { env: { ...process.env, CODEX_SKIN_STUDIO_UPLOAD_SECRET: secret } }), /explicit sharing consent/);
});

test("paired archives are independently validated and extracted with paths intact", async () => {
  const parsed = parseZip(storedZip(await pairedFiles()));
  const validated = validatePackage(parsed, SLUG, { packageKind: "paired", hasPet: true });
  assert.equal(validated.kind, "paired");
  assert.equal(validated.petManifest.id, SLUG);
  assert.equal(validated.contract.contractVersion, "codex-v2-hatch-pet");

  const directory = await saveExtracted(parsed, validated);
  try {
    assert.equal(JSON.parse(await readFile(join(directory, "theme", "theme.json"), "utf8")).id, SLUG);
    assert.equal(JSON.parse(await readFile(join(directory, "pet", "pet.json"), "utf8")).id, SLUG);
    assert.equal(JSON.parse(await readFile(join(directory, "pet-contract.json"), "utf8")).contractVersion, "codex-v2-hatch-pet");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("paired archive validation rejects identity, contract, atlas, and metadata mismatches", async () => {
  const missingContract = await pairedFiles();
  delete missingContract["pet-contract.json"];
  assert.throws(() => validatePackage(parseZip(storedZip(missingContract)), SLUG), /missing pet-contract\.json/);

  const mismatchedPet = await pairedFiles({
    "pet/pet.json": JSON.stringify({ id: "other-pet", displayName: "Other", spriteVersionNumber: 2, spritesheetPath: "spritesheet.png" }),
  });
  assert.throws(() => validatePackage(parseZip(storedZip(mismatchedPet)), SLUG), /matching bundle, theme, and Pet ids/);

  const contract = JSON.parse(await readFile(CONTRACT, "utf8"));
  const wrongContract = await pairedFiles({
    "pet-contract.json": JSON.stringify({ ...contract, contractVersion: "other-contract" }),
  });
  assert.throws(() => validatePackage(parseZip(storedZip(wrongContract)), SLUG), /contractVersion/);

  const wrongDimensions = await pairedFiles({ "pet/spritesheet.png": pngHeader({ width: 1535 }) });
  assert.throws(() => validatePackage(parseZip(storedZip(wrongDimensions)), SLUG), /1536x2288/);

  const noAlpha = await pairedFiles({ "pet/spritesheet.png": pngHeader({ colorType: 2 }) });
  assert.throws(() => validatePackage(parseZip(storedZip(noAlpha)), SLUG), /alpha/);

  const valid = parseZip(storedZip(await pairedFiles()));
  assert.throws(() => validatePackage(valid, SLUG, { packageKind: "theme", hasPet: false }), /public package metadata/);

  const mixedLayout = await pairedFiles({ "theme.json": JSON.stringify({ schemaVersion: 1, id: SLUG, hero: "hero.webp" }) });
  assert.throws(() => validatePackage(parseZip(storedZip(mixedLayout)), SLUG), /not allowed in a paired package/);

  assert.throws(() => parseZip(storedZip({ "../bundle.json": "{}" })), /unsafe ZIP entry/);
  assert.throws(() => parseZip(storedZip({ "pet/readme.txt": "not allowed" })), /unsupported or unsafe ZIP entry/);

  const conflictingHeaders = storedZip(await pairedFiles());
  conflictingHeaders[30] = conflictingHeaders[30] === 0x62 ? 0x78 : 0x62;
  assert.throws(() => parseZip(conflictingHeaders), /local filename does not match central metadata/);
});

test("paired install results never report refresh-required as full success", () => {
  const partial = classifyPairedInstallResult({
    status: "theme-applied-pet-refresh-required",
    theme: { status: "applied" },
    petSelection: { selection: "refresh-required", assetLoaded: null },
  });
  assert.equal(partial.status, "partially_installed");
  assert.equal(partial.complete, false);
  assert.equal(partial.petSelection, "refresh-required");

  const installed = classifyPairedInstallResult({
    status: "theme-applied-pet-selected",
    theme: { status: "applied" },
    petSelection: { selection: "native-ui-confirmed", assetLoaded: true },
  });
  assert.equal(installed.status, "installed");
  assert.equal(installed.complete, true);
});

test("paired installation delegates to switch-paired and preserves a partial result", async () => {
  let invocation = null;
  const result = await installExtractedPackage(
    "/tmp/extracted-pair",
    { kind: "paired", manifest: { id: SLUG } },
    { port: 9451 },
    {
      applyTheme: async () => assert.fail("paired packages must not use the legacy apply path"),
      switchPair: async (directory, contractPath, port) => {
        invocation = { directory, contractPath, port };
        return {
          status: "theme-applied-pet-refresh-required",
          theme: { status: "applied" },
          petSelection: { selection: "refresh-required", assetLoaded: null },
        };
      },
    },
  );
  assert.deepEqual(invocation, {
    directory: "/tmp/extracted-pair",
    contractPath: "/tmp/extracted-pair/pet-contract.json",
    port: 9451,
  });
  assert.equal(result.status, "partially_installed");
  assert.equal(result.complete, false);
});

test("legacy theme installation continues to delegate only to the apply path", async () => {
  let applied = null;
  const result = await installExtractedPackage(
    "/tmp/extracted-theme",
    { kind: "theme", manifest: { id: "legacy-theme" } },
    { port: 9452 },
    {
      switchPair: async () => assert.fail("legacy packages must not use switch-paired"),
      applyTheme: async (directory, port) => {
        applied = { directory, port };
        return { validation: { status: "valid" }, application: { status: "applied" } };
      },
    },
  );
  assert.deepEqual(applied, { directory: "/tmp/extracted-theme", port: 9452 });
  assert.equal(result.status, "installed");
  assert.equal(result.packageKind, "theme");
  assert.equal(result.complete, true);
});
