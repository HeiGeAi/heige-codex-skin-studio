#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { listThemes } from "../src/theme-store.mjs";
import { TRACKED_PACKAGE_SOURCE_DATE_EPOCH } from "./package-skill.mjs";
import { renderLlmsFull } from "./sync-llms.mjs";
import { updateReleaseHash } from "./update-release-hash.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const countPatterns = new Map([
  ["README.md", /^(<!-- heige-bundled-theme-count -->\r?\n## 内置 )\d+( 套主题)$/gm],
  ["README.en.md", /^(- \*\*<!-- heige-bundled-theme-count -->)\d+( built-in presets\*\*:)/gm],
  ["docs/manual.md", /^(\| 内置主题 \| <!-- heige-bundled-theme-count -->)\d+( 个)/gm],
]);

export function renderThemeCount(path, text, count) {
  const pattern = countPatterns.get(path);
  if (!pattern) throw new Error(`未知的主题数量文档：${path}`);
  if (!Number.isSafeInteger(count) || count < 0) throw new TypeError("主题数量必须是非负整数");
  if ([...text.matchAll(pattern)].length !== 1) {
    throw new Error(`${path} 必须恰好包含一个有效的 heige-bundled-theme-count 标记`);
  }
  return text.replace(pattern, (_, before, after) => `${before}${count}${after}`);
}

async function syncText(path, expected, check) {
  const target = join(root, path);
  const actual = await readFile(target, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (actual === expected) return;
  if (check) throw new Error(`${path} 存在漂移`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, expected, { flag: "wx", mode: 0o644 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function syncDerived({ check = false } = {}) {
  const count = (await listThemes({ roots: [join(root, "themes")] })).length;
  // 先验证全部锚点，避免后面的文档损坏时先改写前面的文档。
  const documents = await Promise.all([...countPatterns.keys()].map(async (path) => (
    [path, renderThemeCount(path, await readFile(join(root, path), "utf8"), count)]
  )));
  for (const [path, expected] of documents) await syncText(path, expected, check);
  const summary = await readFile(join(root, "llms.txt"), "utf8");
  await syncText("llms-full.txt", renderLlmsFull(summary, documents[0][1]), check);

  const artifact = join(root, "output/heige-codex-skin-studio.skill");
  // 打包器在 output 内生成临时候选并清理，检查模式不替换正式产物。
  await execFileAsync(process.execPath, [
    join(root, "scripts/package-skill.mjs"),
    "--output", artifact,
    "--source-date-epoch", String(TRACKED_PACKAGE_SOURCE_DATE_EPOCH),
    ...(check ? ["--check"] : []),
  ], {
    cwd: root,
    env: { ...process.env, HEIGE_ALLOW_TRACKED_PACKAGE_OUTPUT: "1" },
  });
  await updateReleaseHash({
    artifact,
    disposition: join(root, "docs/release/2026-07-16-audit-hardening-disposition.md"),
    check,
  });
  return count;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    console.error("用法：node scripts/sync-derived.mjs [--check]");
    process.exitCode = 64;
  } else {
    try {
      const count = await syncDerived({ check: args[0] === "--check" });
      console.log(`派生产物${args[0] === "--check" ? "校验通过" : "已同步"}：${count} 个内置主题`);
    } catch (error) {
      console.error(`${error?.message ?? error}\n请运行 npm run sync（新增素材需先 git add）。`);
      process.exitCode = 1;
    }
  }
}
