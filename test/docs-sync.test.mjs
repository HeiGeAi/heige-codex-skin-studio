import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = new URL("../", import.meta.url);
const publicDocPaths = [
  "README.md",
  "llms.txt",
  "llms-full.txt",
  "ai.txt",
  "skill/heige-codex-skin-studio/README.md",
  "skill/heige-codex-skin-studio/SKILL.md",
];

async function publicDocs() {
  return (await Promise.all(publicDocPaths.map(async (path) => (
    `\nFILE ${path}\n${await readFile(new URL(`../${path}`, import.meta.url), "utf8")}`
  )))).join("\n");
}

async function publicDoc(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("llms-full is generated from llms summary plus README", async () => {
  await execFileAsync(process.execPath, ["scripts/sync-llms.mjs", "--check"], {
    cwd: root,
    encoding: "utf8",
  });
});
test("public docs describe strict option 1 and its two-step recovery path", async () => {
  const docs = await publicDocs();
  assert.match(docs, /关闭后本次继续使用；下次启动恢复原生界面/);
  assert.match(docs, /HeiGe 皮肤启动器/);
  assert.match(docs, /启用 HeiGe 皮肤/);
  assert.match(docs, /确认/);
  assert.match(docs, /顶部(?:菜单)?[“「]?皮肤常驻[”」]?开关[^\n。]*唯一[^\n。]*(?:开启常驻|false.*true)/i);
  assert.match(docs, /先[^\n。]*(?:启动器|启用 HeiGe 皮肤)[^\n。]*当前会话[^\n。]*再[^\n。]*顶部[^\n。]*开关[^\n。]*常驻/);
  assert.doesNotMatch(docs, /\b(?:60|72)\s*项全通过/);
  assert.doesNotMatch(docs, /Windows 的?常驻模式暂未提供/);
});

test("public docs keep every compatibility entry session-only", async () => {
  const [readme, skill, skillReadme, summary] = await Promise.all([
    publicDoc("README.md"),
    publicDoc("skill/heige-codex-skin-studio/SKILL.md"),
    publicDoc("skill/heige-codex-skin-studio/README.md"),
    publicDoc("llms.txt"),
  ]);
  const canonicalDocs = [readme, skill, skillReadme, summary];
  for (const doc of canonicalDocs) {
    assert.match(doc, /enable-skin[^\n。]*(?:当前会话|session-only|apply)/i);
    assert.doesNotMatch(doc, /enable-skin(?:\.command|\.ps1|\.bat)?[^\n。]*(?:开启|打开|启用)[^\n。]*常驻/i);
  }
  assert.match(readme, /enable-persist\.command[^\n。]*(?:弃用|废弃)[^\n。]*非零/);
  assert.match(skill, /enable-persist\.command[^\n。]*(?:弃用|废弃)[^\n。]*非零/);
});

test("custom image is durable locally but remains distinct from a distributable theme", async () => {
  const [readme, skill, skillReadme] = await Promise.all([
    publicDoc("README.md"),
    publicDoc("skill/heige-codex-skin-studio/SKILL.md"),
    publicDoc("skill/heige-codex-skin-studio/README.md"),
  ]);
  for (const doc of [readme, skill, skillReadme]) {
    assert.match(doc, /自定义图片[^\n。]*(?:用户主题库|记入启动器)/);
    assert.match(doc, /(?:常驻启动|常驻)[^\n。]*(?:恢复|复现)/);
    assert.match(doc, /不是[^\n。]*(?:可分发|跨机器分发)[^\n。]*正式主题/);
  }
});

test("public support and security claims stay within verified boundaries", async () => {
  const docs = await publicDocs();
  assert.match(docs, /Node(?:\.js)?\s*22|Node 22/);
  assert.match(docs, /CDP/);
  assert.match(docs, /无认证|同权限|调试端口/);
  assert.match(docs, /Windows Store|MSIX/);
  assert.match(docs, /待.*真机|真机.*待|pending.*live/i);
  assert.match(docs, /开发依赖|development dependenc/i);
  assert.doesNotMatch(docs, /不需要为每次 Codex 更新重新适配|升级后不需要重新适配|未来.*永远不需要/);
  assert.doesNotMatch(docs, /第三方依赖\s*\|\s*0 个/);
  assert.doesNotMatch(docs, /当前只支持 macOS/);
});

test("public CLI docs keep Windows lifecycle behind the platform wrappers", async () => {
  const docs = await publicDocs();
  assert.match(docs, /scripts\/windows\/apply\.ps1/);
  assert.match(docs, /scripts\/windows\/enable-skin\.bat/);
  assert.match(docs, /scripts\/windows\/restore\.ps1/);
  assert.match(docs, /直接.*Node CLI.*安全拒绝|不得直接运行 Node CLI/s);
});
