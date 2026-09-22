# 贡献指南

这个仓库接受两类贡献：内置主题预设，以及注入实现与平台脚本的改动。两类的要求不同，先说清楚，避免白写。

## 一条硬要求：基于最新 main

仓库迭代很快，一个 PR 放两周就可能与 main 冲突到无法合并。动手前先同步：

```bash
git fetch origin
git switch -c your-branch origin/main
```

如果改了 `scripts/windows/` 或 `src/`，请先在 issue 里说明你要改哪条路径、要解决什么现象，对齐后再写代码。同一片代码区域同时存在多个基于旧分叉的 PR 时，重复劳动的成本比审查成本高得多。

## 主题预设贡献

1. 新建 `themes/<theme-id>/`，包含 `theme.json`（对照现有主题填写 `schemaVersion`、`id`、`name`、`hero`、`appearance`、`colors`）与主视觉图片。
2. 在 `ASSET_PROVENANCE.md` 里为每个图片素材登记一行，六个字段都要填，来源与授权必须如实。**素材来源不明或授权无法说明的图，不要提交。**
3. 同步内置主题数量口径：`README.md`、`README.en.md`、`docs/manual.md` 三处都要跟着改。
4. 跑 `node scripts/sync-llms.mjs` 同步 `llms-full.txt`。
5. 跑 `npm test`，并确认 `node scripts/check-asset-provenance.mjs --check` 通过。资产表与 Git 跟踪文件必须一一对应，多一行少一行都会失败。
6. 接受一条判断标准：**与已有预设视觉或命名高度接近的主题不会同时内置**，请说明新主题与现有预设的差异点。

## 代码贡献

1. 先开 issue 对齐范围，说明现象、复现步骤、预期行为。
2. 基于最新 main 开发，改动尽量聚焦在一个模块。
3. 本地必须全绿：

```bash
npm ci
npm test
node scripts/check-asset-provenance.mjs --check
node scripts/check-asset-provenance.mjs --release
node scripts/sync-llms.mjs
```

4. 改了 `src/` 之后，被跟踪的 `.skill` 产物会失效，需要重建并同步哈希：

```bash
HEIGE_ALLOW_TRACKED_PACKAGE_OUTPUT=1 node scripts/package-skill.mjs \
  --output "$(pwd)/output/heige-codex-skin-studio.skill" --source-date-epoch 1704067200
```

然后把 `docs/release/2026-07-16-audit-hardening-disposition.md` 里唯一的 `heige-package-sha256` 标记替换为新值。CI 会校验这两者一致。

5. 改动 `scripts/windows/` 时，本地没有 Windows 环境就明确说明，Windows 侧以 CI 的 `windows-2025` 任务（PowerShell 5.1 与 7 双跑）为准。**不要把只做过静态检查的改动描述成已验证。**
6. 行为改动请补测试。安全相关路径（ACL、路径校验、进程身份、调试端口）的改动尤其需要覆盖失败路径。

## 审查与合并

- 维护者会核对：`npm test` 全绿，资产表一致，文档口径与代码一致，`.skill` 产物的确定性构建哈希一致。
- 合并前 CI 必须全绿，包括 Windows 与 macOS 两个专属任务。
- 如果 PR 的方向与项目当前形态偏离，或范围过大无法安全审查，会关闭并说明原因，欢迎拆成聚焦的小 PR 重开。

## 不接受的内容

- 纯推广性改动（在文档里塞第三方服务地址、付费端点、邀请链接）。
- 无法说明来源与授权的图片素材。
- 与 Codex 使用条款冲突的改动，例如修改应用二进制、绕过签名校验。

## 有问题就问

开 issue 或到 [Discussions](https://github.com/HeiGeAi/heige-codex-skin-studio/discussions) 提问都行。说清楚你遇到的版本号和现象，定位会快很多。
