# 悟空双主题预设实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把项目所有者提供的两张生成图像制作成两个轻量内置主题，并通过本地、真机和 GitHub 发布门禁发布 `v5.4.0`。

**Architecture:** 每个主题只新增一个 schema v1 清单和一张 1600×900 WebP，完全复用现有主题发现、校验、注入和阅读增强链路。素材来源表记录项目所有者提供与公开发布决定，不增加运行时代码或依赖。

**Tech Stack:** Node.js ESM、Node test runner、WebP、现有 theme schema、GitHub Actions、GitHub CLI。

---

### Task 1：用失败测试锁定两个预设

**Files:**

- Modify: `test/bundled-presets.test.mjs`

- [ ] **Step 1: 写两个预设的失败合同**

在现有测试中加入：

```js
const requiredPresets = new Map([
  ["dragonball-nimbus", {
    name: "龙珠 · 筋斗云",
    previewFocus: { x: 72, y: 43 },
  }],
  ["dragonball-super-saiyan", {
    name: "龙珠 · 超级赛亚人",
    previewFocus: { x: 67, y: 43 },
  }],
]);

for (const [id, expected] of requiredPresets) {
  assert.ok(ids.includes(id), `${id}: preset must stay bundled`);
  const theme = await loadTheme(join(themesRoot, id));
  assert.equal(theme.manifest.name, expected.name);
  assert.deepEqual(theme.manifest.previewFocus, expected.previewFocus);
  assert.equal(theme.assetMetadata.hero.width, 1600);
  assert.equal(theme.assetMetadata.hero.height, 900);
}
```

- [ ] **Step 2: 验证测试因主题不存在而失败**

Run: `node --test test/bundled-presets.test.mjs`

Expected: FAIL，消息包含 `dragonball-nimbus: preset must stay bundled`。

- [ ] **Step 3: 提交失败测试**

```bash
git add test/bundled-presets.test.mjs
git commit -m "test: require goku bundled presets"
```

### Task 2：生成轻量图片并创建主题清单

**Files:**

- Create: `themes/dragonball-nimbus/hero.webp`
- Create: `themes/dragonball-nimbus/theme.json`
- Create: `themes/dragonball-super-saiyan/hero.webp`
- Create: `themes/dragonball-super-saiyan/theme.json`

- [ ] **Step 1: 从原始 PNG 生成 1600×900 WebP**

使用系统图像工具或可用的 `cwebp` 将两张输入图中心裁切为 16:9，并以视觉无明显损失的质量生成 WebP。原始文件保持不变。

Expected: 两张输出均为 1600×900，且每张小于 1 MB。

- [ ] **Step 2: 创建筋斗云主题清单**

```json
{
  "schemaVersion": 1,
  "id": "dragonball-nimbus",
  "name": "龙珠 · 筋斗云",
  "hero": "hero.webp",
  "appearance": "dark",
  "previewFocus": { "x": 72, "y": 43 },
  "colors": {
    "accent": "#4FC3F7",
    "secondary": "#F6C445",
    "surface": "#101A36",
    "text": "#F3F7FF"
  }
}
```

- [ ] **Step 3: 创建超级赛亚人主题清单**

```json
{
  "schemaVersion": 1,
  "id": "dragonball-super-saiyan",
  "name": "龙珠 · 超级赛亚人",
  "hero": "hero.webp",
  "appearance": "dark",
  "previewFocus": { "x": 67, "y": 43 },
  "colors": {
    "accent": "#F5C451",
    "secondary": "#52C7F2",
    "surface": "#10172B",
    "text": "#FFF8E8"
  }
}
```

- [ ] **Step 4: 验证预设测试转绿**

Run: `node --test test/bundled-presets.test.mjs`

Expected: PASS。

- [ ] **Step 5: 提交主题**

```bash
git add themes/dragonball-nimbus themes/dragonball-super-saiyan
git commit -m "feat: add goku preset themes"
```

### Task 3：登记素材并更新产品文档

**Files:**

- Modify: `ASSET_PROVENANCE.md`
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 登记两个视觉素材**

在来源表加入两行：

```markdown
| `themes/dragonball-nimbus/hero.webp` | 龙珠筋斗云主题主视觉 | 项目所有者于 2026-07-18 提供生成 PNG，并明确要求制作预设后公开发布；仓库保存压缩 WebP | 画面含第三方角色形象，项目未取得可独立核验的第三方授权文件 | 项目所有者确认公开发布 | 后续可替换为权利记录更完整的原创角色素材 |
| `themes/dragonball-super-saiyan/hero.webp` | 龙珠超级赛亚人主题主视觉 | 项目所有者于 2026-07-18 提供生成 PNG，并明确要求制作预设后公开发布；仓库保存压缩 WebP | 画面含第三方角色形象，项目未取得可独立核验的第三方授权文件 | 项目所有者确认公开发布 | 后续可替换为权利记录更完整的原创角色素材 |
```

- [ ] **Step 2: 更新主题数量和发布说明**

把 README 中的内置主题数量更新为 12，并列出两个新主题。在 CHANGELOG 顶部新增 `5.4.0`，说明只新增静态预设，不增加运行时逻辑。

- [ ] **Step 3: 运行文档与来源门禁**

Run: `node scripts/check-asset-provenance.mjs --check && node scripts/check-asset-provenance.mjs --release && node --test test/docs-sync.test.mjs test/release-governance.test.mjs`

Expected: 全部 PASS，release 输出包含 39 个视觉素材。

- [ ] **Step 4: 提交文档**

```bash
git add ASSET_PROVENANCE.md README.md README.en.md CHANGELOG.md
git commit -m "docs: document goku presets"
```

### Task 4：版本、全量测试、打包和真机验收

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `output/heige-codex-skin-studio.skill`

- [ ] **Step 1: 将版本统一更新为 5.4.0**

Run: `npm version 5.4.0 --no-git-tag-version`

Expected: `package.json`、`package-lock.json` 根版本和 lockfile 根包版本均为 `5.4.0`。

- [ ] **Step 2: 运行全量测试和发布来源门禁**

Run: `npm test && npm run release:check`

Expected: 全部测试 PASS，公开发布来源门禁 PASS。

- [ ] **Step 3: 构建两次并验证确定性**

Run:

```bash
node scripts/package-skill.mjs --output /tmp/heige-a.skill --source-date-epoch 1704067200
node scripts/package-skill.mjs --output /tmp/heige-b.skill --source-date-epoch 1704067200
shasum -a 256 /tmp/heige-a.skill /tmp/heige-b.skill
cp /tmp/heige-a.skill output/heige-codex-skin-studio.skill
```

Expected: 两次 `.skill` SHA-256 完全一致，归档包含两个主题目录。

- [ ] **Step 4: 从新包安装并真实应用两个主题**

从新包安装到本机 Studio，依次运行 CLI 应用 `dragonball-nimbus` 和 `dragonball-super-saiyan`。检查主题列表、控制器状态、renderer target、当前主题 ID、阅读增强根属性和背景数据 URL。

Expected: 两次切换均成功，阅读增强仍为 `on`，控制器健康，日志无新增错误。

- [ ] **Step 5: 提交发布候选**

```bash
git add package.json package-lock.json output/heige-codex-skin-studio.skill
git commit -m "chore: prepare v5.4.0"
```

### Task 5：远程门禁与 GitHub Release

**Files:**

- Create: `docs/release/2026-07-18-v5.4.0-verification.md`

- [ ] **Step 1: 记录本地验收证据并提交**

记录测试数量、图片尺寸和大小、包 SHA-256、安装目录、真机切换结果及 Windows/MSIX 真实设备边界。

- [ ] **Step 2: 推送分支并创建 PR**

```bash
git push -u origin codex/add-goku-presets
gh pr create --base main --head codex/add-goku-presets --title "feat: add two Goku preset themes" --body-file /tmp/pr-body.md
```

Expected: PR 创建成功。

- [ ] **Step 3: 等待所有 GitHub 检查**

使用 `gh pr checks --watch` 或 Actions 查询，确认 Node、macOS、Windows 和打包工作流全部成功。

- [ ] **Step 4: 合并并确认远端 main**

合并 PR，拉取最新 `main`，确认合并提交包含两个主题和 `5.4.0` 版本。

- [ ] **Step 5: 创建标签和 Release**

创建带注释的 `v5.4.0` 标签并推送，创建 GitHub Release，上传 `output/heige-codex-skin-studio.skill`。

- [ ] **Step 6: 下载远端资产做最终复核**

下载 Release 资产，验证 SHA-256、ZIP 完整性、两个主题文件和版本字段。

Expected: 远端下载结果与本地发布候选一致。
