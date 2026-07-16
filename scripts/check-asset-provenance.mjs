#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const documentPath = resolve(root, "ASSET_PROVENANCE.md");
const visualPath = /^(?:assets|themes|custom-pet|docs\/images)\/.*\.(?:png|jpe?g|webp)$/i;

if (process.argv.length !== 3 || process.argv[2] !== "--check") {
  console.error("usage: node scripts/check-asset-provenance.mjs --check");
  process.exitCode = 2;
} else {
  const [{ stdout }, markdown] = await Promise.all([
    execFileAsync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }),
    readFile(documentPath, "utf8"),
  ]);
  const tracked = stdout.split("\0").filter((path) => visualPath.test(path)).sort();
  const rows = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^\|\s*`([^`]+)`\s*\|(.*)\|\s*$/.exec(line);
    if (!match) continue;
    const fields = match[2].split("|").map((field) => field.trim());
    if (fields.length !== 5 || fields.some((field) => field.length === 0)) {
      throw new Error(`素材来源表行格式无效：${match[1]}`);
    }
    rows.push({ path: match[1], fields });
  }
  const counts = new Map();
  for (const row of rows) counts.set(row.path, (counts.get(row.path) ?? 0) + 1);
  const missing = tracked.filter((path) => !counts.has(path));
  const duplicates = [...counts].filter(([, count]) => count !== 1).map(([path]) => path);
  const extra = [...counts.keys()].filter((path) => !tracked.includes(path));
  if (missing.length || duplicates.length || extra.length) {
    const detail = [
      missing.length ? `缺少：${missing.join(", ")}` : "",
      duplicates.length ? `重复：${duplicates.join(", ")}` : "",
      extra.length ? `非跟踪素材：${extra.join(", ")}` : "",
    ].filter(Boolean).join("\n");
    throw new Error(`素材来源表与 Git 跟踪文件不一致\n${detail}`);
  }
  console.log(`asset provenance verified: ${tracked.length} tracked visual assets`);
}
