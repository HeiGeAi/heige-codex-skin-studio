# macOS HeiGe 皮肤启动器 Schema 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已经覆盖安装的 GitHub `5.5.3` 迭代为本地 `5.5.4`，使每次 macOS 安装都会生成带 Miku 图标、可见错误反馈和一次性安全锁链恢复能力的真实 APP，点击后可拉起或接管官方 Codex Desktop 并恢复最近皮肤。

**Architecture:** 保留现有「稳定安装树加生成式 APP」架构。Schema 3 Bundle 只保存固定入口、版本、图标和本地 ad hoc 签名，业务继续由稳定树中的 CLI、生命周期助手和注入器执行；新增的 launcher 编排先探测 operation lock，只有精确的静态 `LOCK_CHAIN_CORRUPT` 才整根备份状态目录并重试一次。

**Tech Stack:** Node.js 22 ESM、zsh、macOS `codesign`、LaunchServices、`iconutil`、Node 内置测试运行器、现有 CDP 注入与安装事务。

---

## 文件结构

新增文件：

1. `assets/launcher/miku-launcher-icon.png`：1024×1024 图标母版。
2. `assets/launcher/AppIcon.icns`：正式 Bundle 图标资源。
3. `src/macos-launcher-recovery.mjs`：只负责识别和恢复静态损坏的 macOS 状态根。
4. `scripts/launch-skin.command`：Finder 启动专用入口，负责版本参数、错误截断和 argv-safe 原生 alert。
5. `test/macos-launcher-recovery.test.mjs`：状态根恢复的隔离 fixture。
6. `docs/superpowers/plans/2026-08-19-macos-launcher-v3-implementation.md`：本计划和执行勾选状态。

修改文件：

1. `src/macos-launcher.mjs`：Schema 3 Bundle、版本、图标、签名、旧 Schema 迁移及事务摘要。
2. `src/cli.mjs`：内部 `launcher-apply` 命令、版本绑定、锁健康探测和一次性恢复编排。
3. `src/lifecycle-helper.mjs`：允许重启后的受限 `launcher-apply` 续作。
4. `test/macos-launcher.test.mjs`：Bundle、签名、图标、迁移、回滚和篡改测试。
5. `test/cli.test.mjs`：启动器路由矩阵、session-only 和只重试一次测试。
6. `test/scripts.test.mjs`：GUI wrapper 的参数与 alert 安全测试。
7. `test/live-macos-acceptance.mjs`：Schema 3 和目标环境回读。
8. `scripts/skill-package-manifest.json`：新增脚本和图标进入确定性包。
9. `package.json`、`package-lock.json`、`test/product-identity.test.mjs`：版本改为 `5.5.4`。
10. `ASSET_PROVENANCE.md`：记录 Miku 衍生图标继承未知授权状态。
11. `CHANGELOG.md`、`README.md`、`README.en.md`、`docs/manual.md`、`llms.txt`、`llms-full.txt`、`skill/heige-codex-skin-studio/README.md`、`skill/heige-codex-skin-studio/SKILL.md`：同步产品入口和恢复边界。

## Task 1：冻结 `5.5.4` 产品身份

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `test/product-identity.test.mjs`
- Modify: `CHANGELOG.md`

- [ ] **Step 1：先把身份测试改为期待 `5.5.4`**

将版本断言改成精确值：

```js
assert.equal(packageJson.version, "5.5.4");
assert.equal(packageLock.version, "5.5.4");
assert.equal(packageLock.packages[""].version, "5.5.4");
```

- [ ] **Step 2：运行失败测试**

Run：

```bash
node --test test/product-identity.test.mjs
```

Expected：因源码仍为 `5.5.3` 而 FAIL。

- [ ] **Step 3：只更新版本和 changelog 顶部条目**

把三个包版本字段改为 `5.5.4`，并新增：

```markdown
## 5.5.4

- macOS 安装现在生成 Schema 3「HeiGe 皮肤启动器」，包含 Miku 图标、本地完整性签名和可见失败提示。
- 启动器可在安全门通过时备份并重建静态损坏的 operation-lock 状态根，然后只重试一次。
```

- [ ] **Step 4：验证身份测试通过**

Run：`node --test test/product-identity.test.mjs`

Expected：PASS。

- [ ] **Step 5：提交**

```bash
git add package.json package-lock.json test/product-identity.test.mjs CHANGELOG.md
git commit -m "chore: start 5.5.4 launcher iteration"
```

## Task 2：制作并验证 Miku 图标资产

**Files:**

- Create: `assets/launcher/miku-launcher-icon.png`
- Create: `assets/launcher/AppIcon.icns`
- Modify: `ASSET_PROVENANCE.md`
- Modify: `test/miku-asset.test.mjs`

- [ ] **Step 1：先增加资产失败测试**

测试必须检查母版尺寸、ICNS 文件头和溯源文本：

```js
test("launcher icon ships as a 1024 square source and ICNS", async () => {
  const png = await readFile(join(root, "assets/launcher/miku-launcher-icon.png"));
  const icns = await readFile(join(root, "assets/launcher/AppIcon.icns"));
  assert.deepEqual(readPngDimensions(png), { width: 1024, height: 1024 });
  assert.equal(icns.subarray(0, 4).toString("ascii"), "icns");
  assert.match(await readFile(join(root, "ASSET_PROVENANCE.md"), "utf8"),
    /assets\/launcher\/miku-launcher-icon\.png[\s\S]*unknown/i);
});
```

- [ ] **Step 2：运行失败测试**

Run：`node --test test/miku-asset.test.mjs`

Expected：两个新资产不存在，FAIL。

- [ ] **Step 3：用 imagegen 编辑现有核心人物图**

输入固定为 `assets/miku-character.png`，提示词固定为：

```text
Create a polished 1024x1024 macOS app icon from the attached Miku character artwork. Preserve the recognizable face, cyan twin-tail hair, headset, star hair accessory, and hand pose. Remove all text, interface fragments, and watermark-like marks. Use a clean pastel cyan, blue, pink, and violet starry gradient background. Center the face in the macOS icon safe area, keep it legible at 32px, use a static rounded-square icon composition, and add no words, numbers, OpenAI marks, logos, or extra characters.
```

把最终 PNG 保存为 `assets/launcher/miku-launcher-icon.png`。

- [ ] **Step 4：确定性生成标准 iconset 和 ICNS**

Run：

```bash
work_iconset="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$work_iconset"
sips -z 16 16 assets/launcher/miku-launcher-icon.png --out "$work_iconset/icon_16x16.png"
sips -z 32 32 assets/launcher/miku-launcher-icon.png --out "$work_iconset/icon_16x16@2x.png"
sips -z 32 32 assets/launcher/miku-launcher-icon.png --out "$work_iconset/icon_32x32.png"
sips -z 64 64 assets/launcher/miku-launcher-icon.png --out "$work_iconset/icon_32x32@2x.png"
sips -z 128 128 assets/launcher/miku-launcher-icon.png --out "$work_iconset/icon_128x128.png"
sips -z 256 256 assets/launcher/miku-launcher-icon.png --out "$work_iconset/icon_128x128@2x.png"
sips -z 256 256 assets/launcher/miku-launcher-icon.png --out "$work_iconset/icon_256x256.png"
sips -z 512 512 assets/launcher/miku-launcher-icon.png --out "$work_iconset/icon_256x256@2x.png"
sips -z 512 512 assets/launcher/miku-launcher-icon.png --out "$work_iconset/icon_512x512.png"
cp assets/launcher/miku-launcher-icon.png "$work_iconset/icon_512x512@2x.png"
iconutil -c icns "$work_iconset" -o assets/launcher/AppIcon.icns
```

- [ ] **Step 5：记录真实权利边界并复验**

在 `ASSET_PROVENANCE.md` 中写明两个新文件均为 `assets/miku-character.png` 的衍生物，许可状态为 `unknown`，不得写成已获授权。运行：

```bash
node --test test/miku-asset.test.mjs
node scripts/check-asset-provenance.mjs --release
```

Expected：PASS，且视觉检查无文字、无额外角色、面部无裁切。

- [ ] **Step 6：提交**

```bash
git add assets/launcher ASSET_PROVENANCE.md test/miku-asset.test.mjs
git commit -m "feat: add Miku launcher icon assets"
```

## Task 3：把生成式 APP 升级为 Schema 3

**Files:**

- Modify: `src/macos-launcher.mjs`
- Modify: `test/macos-launcher.test.mjs`

- [ ] **Step 1：先写 Schema 3 Bundle 失败测试**

fixture 同时创建 `scripts/launch-skin.command`、`package.json` 和 `assets/launcher/AppIcon.icns`。核心断言为：

```js
assert.equal(MACOS_LAUNCHER_SCHEMA_VERSION, 3);
assert.match(executable, /generated launcher schema 3/);
assert.match(executable, /launch-skin\.command/);
assert.match(plist, /<key>CFBundleIconFile<\/key>\s*<string>AppIcon\.icns<\/string>/);
assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>5\.5\.4<\/string>/);
assert.match(plist, /<key>LSMinimumSystemVersion<\/key>\s*<string>13\.0<\/string>/);
assert.deepEqual(await readFile(join(result.appPath, "Contents/Resources/AppIcon.icns")), iconBytes);
await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--", result.appPath]);
```

另加 Schema 1、Schema 2 可升级，Schema 3 图标替换、签名损坏、额外文件、路径含中文和 shell 字符时 fail closed 的测试。

- [ ] **Step 2：运行失败测试**

Run：`node --test test/macos-launcher.test.mjs`

Expected：Schema 仍为 2、入口仍为 `apply.command`，FAIL。

- [ ] **Step 3：实现版本和图标输入的严格读取**

新增以下内部接口并使用 `O_NOFOLLOW`、大小上限、真实路径和 SHA-256：

```js
async function readLauncherInputs(validationRoot) {
  return {
    version: await readExactPackageVersion(join(validationRoot, "package.json")),
    icon: await readBoundedBinary(join(validationRoot, "assets/launcher/AppIcon.icns")),
  };
}

function expectedLauncher({ installRoot, version, icon }) {
  const executable = renderMacosLauncherExecutable({
    entrypoint: join(installRoot, "scripts", "launch-skin.command"),
    version,
  });
  const plist = renderMacosLauncherPlist({ installRoot, version });
  return { executable, plist, icon };
}
```

- [ ] **Step 4：实现 Schema 3 staging、签名和归属验证**

Schema 3 固定结构只允许：

```js
const SCHEMA_3_CONTENTS = ["Info.plist", "MacOS", "Resources", "_CodeSignature"];
const SCHEMA_3_RESOURCES = ["AppIcon.icns"];
const SCHEMA_3_SIGNATURE = ["CodeResources"];
```

staging 写入并 `fsync` 后执行：

```js
await execFile("/usr/bin/codesign", ["--force", "--sign", "-", "--", stagePath]);
await execFile("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--", stagePath]);
```

归属结果返回 executable、plist、icon、CodeResources 的摘要和 Bundle 版本。旧 Schema 1、2 继续按历史精确结构验证，Schema 3 必须验签。

- [ ] **Step 5：把新摘要纳入可序列化 participant**

participant schema 改为 2，并增加：

```js
afterIconSha256
afterCodeResourcesSha256
afterVersion
beforeIconSha256
beforeCodeResourcesSha256
beforeVersion
```

旧 Bundle 的 icon、signature 字段允许为 `null`。prepare、publish、rollback、finalize 和 SIGKILL recovery 每一步都用这些字段绑定实际 Bundle。

- [ ] **Step 6：运行测试并提交**

Run：

```bash
node --test test/macos-launcher.test.mjs test/macos-install-coordinator.test.mjs
```

Expected：PASS。

```bash
git add src/macos-launcher.mjs test/macos-launcher.test.mjs
git commit -m "feat: generate signed macOS launcher schema 3"
```

## Task 4：增加 Finder 专用入口和安全错误提示

**Files:**

- Create: `scripts/launch-skin.command`
- Modify: `src/cli.mjs`
- Modify: `src/lifecycle-helper.mjs`
- Modify: `test/cli.test.mjs`
- Modify: `test/scripts.test.mjs`

- [ ] **Step 1：先写 wrapper 与 CLI 失败测试**

测试固定以下契约：

```js
const result = await runCli([
  "launcher-apply",
  "--launcher-version", "5.5.4",
  "--port", "9341",
], overrides);
assert.equal(result.persistenceEnabled, false);
assert.equal(overrides.setPersistenceCalls, 0);
```

wrapper 源码必须包含静态 JXA 和 argv 分隔符：

```js
assert.match(script, /\/usr\/bin\/osascript -l JavaScript/);
assert.match(script, /-- "\$MESSAGE" "HeiGe 皮肤启动器"/);
assert.doesNotMatch(script, /osascript -e "[^\n]*\$MESSAGE/);
```

- [ ] **Step 2：运行失败测试**

Run：`node --test test/cli.test.mjs test/scripts.test.mjs`

Expected：未知命令和脚本缺失导致 FAIL。

- [ ] **Step 3：增加受限内部命令**

`COMMAND_OPTIONS` 增加：

```js
["launcher-apply", new Set(["launcher-version", "port"])],
```

命令只允许 `darwin` 与 Codex 产品，精确比较 `--launcher-version` 和当前 `package.json` 版本，然后选择 `lastNonNativeThemeId ?? DEFAULT_THEME_ID`。它复用 `applySelectedTheme`，但保持 `persistenceEnabled` 原值。

`applySelectedTheme` 生成续作时使用：

```js
const continuationCommand = command === "launcher-apply" ? "launcher-apply" : "apply";
afterLaunch: { command: continuationCommand, themeId }
```

`src/lifecycle-helper.mjs` 的 allowlist 只新增精确字符串 `launcher-apply`。

- [ ] **Step 4：实现 GUI wrapper**

`scripts/launch-skin.command` 使用以下固定行为：

```zsh
#!/bin/zsh
set -euo pipefail
umask 077
ROOT="${0:A:h:h}"
VERSION="${1:-}"
PORT="${HEIGE_CODEX_SKIN_PORT:-9341}"
ERROR_FILE="$(/usr/bin/mktemp -t heige-skin-launcher)"
trap '/bin/rm -f -- "$ERROR_FILE"' EXIT
if "$ROOT/scripts/lib/run-cli.zsh" launcher-apply --launcher-version "$VERSION" --port "$PORT" 2>"$ERROR_FILE"; then
  exit 0
fi
STATUS=$?
MESSAGE="$(<"$ERROR_FILE")"
MESSAGE="${MESSAGE//[[:cntrl:]]/ }"
MESSAGE="${MESSAGE[1,1200]}"
[[ -n "$MESSAGE" ]] || MESSAGE="启动器运行失败，请重新运行安装器。"
/usr/bin/osascript -l JavaScript -e 'function run(argv) { const app = Application.currentApplication(); app.includeStandardAdditions = true; app.displayDialog(argv[0], {withTitle: argv[1], buttons:["好"], defaultButton:"好"}); }' -- "$MESSAGE" "HeiGe 皮肤启动器" >/dev/null 2>&1 || true
exit "$STATUS"
```

- [ ] **Step 5：验证并提交**

Run：`node --test test/cli.test.mjs test/scripts.test.mjs test/lifecycle-helper.test.mjs`

Expected：PASS。

```bash
git add scripts/launch-skin.command src/cli.mjs src/lifecycle-helper.mjs test/cli.test.mjs test/scripts.test.mjs
git commit -m "feat: add macOS launcher apply entrypoint"
```

## Task 5：实现静态损坏锁链的一次性安全恢复

**Files:**

- Create: `src/macos-launcher-recovery.mjs`
- Create: `test/macos-launcher-recovery.test.mjs`
- Modify: `src/cli.mjs`
- Modify: `test/cli.test.mjs`

- [ ] **Step 1：先建立损坏状态根 fixture**

fixture 创建 device binding 不一致的 `operation.lock` 与 successor，并写入严格合法 `state.json` 和一个完整用户主题。核心成功断言：

```js
const result = await recoverStaticLauncherStateRoot({
  stateRoot,
  port: 9341,
  dependencies: safeIdleDependencies,
});
assert.equal(result.recovered, true);
assert.match(result.backupPath, /\.corrupt-lock-backup-20260819T160000Z/);
assert.deepEqual(await readStudioState(join(stateRoot, "state.json")), originalState);
assert.equal((await lstat(stateRoot)).mode & 0o777, 0o700);
await assert.rejects(lstat(join(stateRoot, "operation.lock")), /ENOENT/);
assert.equal((await lstat(join(result.backupPath, "operation.lock"))).isFile(), true);
```

另写活 claim PID、LaunchAgent、lifecycle helper、foreign listener、symlink 状态、坏 JSON、坏主题、第二次失败的拒绝测试。

- [ ] **Step 2：运行失败测试**

Run：`node --test test/macos-launcher-recovery.test.mjs`

Expected：模块不存在，FAIL。

- [ ] **Step 3：实现恢复前安全门**

模块导出：

```js
export async function probeLauncherOperationLock({ paths, acquireLock })
export async function recoverStaticLauncherStateRoot({ stateRoot, port, dependencies })
export async function ensureLauncherOperationLock({ paths, port, dependencies })
```

`ensureLauncherOperationLock` 先获取并释放一次 `launcher:preflight` lease。只有 `error.code === "LOCK_CHAIN_CORRUPT"` 才进入恢复，其他错误原样抛出。

恢复前必须依次证明：

1. 没有已加载的受信 LaunchAgent。
2. 若 `9341` 属于官方 Codex，先正常退出并等它和 ephemeral controller 消失；foreign listener 直接拒绝。
3. 进程表中没有稳定树 controller 或 lifecycle helper。
4. 所有 claim 中的 PID 已死亡或身份不匹配。
5. 状态根、`state.json`、`themes` 及其祖先均为当前用户真实路径，无 symlink。
6. `readStudioState` 和每个 `loadTheme` 都成功，任何异常都 fail closed。

- [ ] **Step 4：实现整根备份和可回滚重建**

恢复使用同父目录原子 rename：

```js
await rename(stateRoot, backupPath);
await mkdir(stateRoot, { mode: 0o700 });
await copyValidatedState(join(backupPath, "state.json"), join(stateRoot, "state.json"), 0o600);
await copyValidatedThemes(join(backupPath, "themes"), join(stateRoot, "themes"));
```

不复制 lock、session、transition、lifecycle、handshake 或日志。重建失败时，只在新根仍为本操作归属时移除新根并把 backup rename 回原位。

- [ ] **Step 5：接入 `launcher-apply` 并限制为一次**

在读取 stored state 之前执行：

```js
const lockHealth = await deps.ensureLauncherOperationLock({ paths: deps.paths, port });
const result = await runLauncherApplyOnce();
return { ...result, lockRecovery: lockHealth };
```

`ensureLauncherOperationLock` 内部恢复后仅重新 probe 一次；若第二次 acquire 或后续 apply 失败，不再移动第二个备份。

- [ ] **Step 6：验证并提交**

Run：

```bash
node --test test/macos-launcher-recovery.test.mjs test/cli.test.mjs test/operation-lock.test.mjs
```

Expected：PASS。

```bash
git add src/macos-launcher-recovery.mjs src/cli.mjs test/macos-launcher-recovery.test.mjs test/cli.test.mjs
git commit -m "feat: recover stale macOS launcher lock chains"
```

## Task 6：完成安装集成、LaunchServices 和文档同步

**Files:**

- Modify: `src/macos-launcher.mjs`
- Modify: `src/macos-install-coordinator.mjs`
- Modify: `test/macos-install-coordinator.test.mjs`
- Modify: `scripts/skill-package-manifest.json`
- Modify: `test/skill-package-runtime-manifest.test.mjs`
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `docs/manual.md`
- Modify: `llms.txt`
- Modify: `llms-full.txt`
- Modify: `skill/heige-codex-skin-studio/README.md`
- Modify: `skill/heige-codex-skin-studio/SKILL.md`

- [ ] **Step 1：先写安装与打包失败测试**

断言正式安装 participant 使用 `validationRoot` 中的 `5.5.4` 和图标，但 Bundle 的入口只指向 `targetRoot`：

```js
assert.equal(launcher.afterVersion, "5.5.4");
assert.match(installedExecutable, new RegExp(escapeRegExp(join(targetRoot, "scripts/launch-skin.command"))));
assert.doesNotMatch(installedExecutable, new RegExp(escapeRegExp(sourceRoot)));
assert.ok(packagedPaths.includes("scripts/launch-skin.command"));
assert.ok(packagedPaths.includes("assets/launcher/AppIcon.icns"));
```

- [ ] **Step 2：运行失败测试**

Run：

```bash
node --test test/macos-install-coordinator.test.mjs test/skill-package-runtime-manifest.test.mjs test/skill-package.test.mjs
```

Expected：新增资产和脚本尚未进入 manifest，FAIL。

- [ ] **Step 3：完成安装事务与 LaunchServices 注册**

`prepareMacosLauncher` 从 `validationRoot` 读取版本和 icon，生成指向 `installRoot` 的 Bundle。`finalizeMacosLauncher` 在严格验签后调用：

```js
await execFile(
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
  ["-f", participant.appPath],
);
```

注册失败保留可重试的 finalize 状态，不清空 preparation intent。

- [ ] **Step 4：同步 manifest 和说明文档**

文档明确写出：macOS 每次安装都会生成 `$HOME/Applications/HeiGe 皮肤启动器.app`；点击恢复当前会话，不等于开启登录项；本地 ad hoc 签名不等于 Developer ID 或公证；静态锁链只在安全门通过时恢复一次。

- [ ] **Step 5：运行同步检查并提交**

Run：

```bash
node --test test/macos-install-coordinator.test.mjs test/skill-package-runtime-manifest.test.mjs test/docs-sync.test.mjs
```

Expected：PASS。

```bash
git add src/macos-launcher.mjs src/macos-install-coordinator.mjs test/macos-install-coordinator.test.mjs scripts/skill-package-manifest.json test/skill-package-runtime-manifest.test.mjs README.md README.en.md docs/manual.md llms.txt llms-full.txt skill/heige-codex-skin-studio/README.md skill/heige-codex-skin-studio/SKILL.md
git commit -m "docs: document macOS launcher recovery"
```

## Task 7：确定性打包和完整本地门禁

**Files:**

- Modify: `output/heige-codex-skin-studio.skill`
- Modify: `output/heige-codex-skin-studio.skill.sha256`

- [ ] **Step 1：跑针对性测试**

Run：

```bash
node --test test/macos-launcher.test.mjs test/macos-launcher-recovery.test.mjs test/cli.test.mjs test/scripts.test.mjs test/lifecycle-helper.test.mjs test/macos-install-coordinator.test.mjs test/miku-asset.test.mjs
```

Expected：0 failures。

- [ ] **Step 2：重建确定性 Skill 包**

必须固定已验证的 Node 22，避免 Node 25 产生不同压缩字节：

```bash
HEIGE_NODE=/Users/blakexu/.local/bin/node \
HEIGE_ALLOW_TRACKED_PACKAGE_OUTPUT=1 \
/bin/zsh scripts/package-skill.command \
  "$PWD/output/heige-codex-skin-studio.skill" \
  1704067200
```

然后运行 `node scripts/update-release-hash.mjs`，连续构建两次并比较 SHA-256 完全一致。

- [ ] **Step 3：跑完整 release 门禁**

Run：

```bash
npm ci
npm run release:check
```

Expected：全部测试 0 failures，资产溯源 release gate PASS。

- [ ] **Step 4：提交**

```bash
git add output/heige-codex-skin-studio.skill output/heige-codex-skin-studio.skill.sha256
git commit -m "build: package macOS launcher 5.5.4"
```

## Task 8：覆盖安装 `5.5.4` 并跑真实 Mac 端到端验收

**Files:**

- Modify only through installer: `/Users/blakexu/.codex/heige-codex-skin-studio`
- Modify only through installer: `/Users/blakexu/Applications/HeiGe 皮肤启动器.app`
- Read-only verify: `/Applications/ChatGPT.app`

- [ ] **Step 1：冻结安装前证据**

记录稳定树版本、主题、常驻值、Codex 版本与 PID、官方签名和 `app.asar` SHA-256。必须确认当前分支已提交且 `git status --short` 为空。

- [ ] **Step 2：正式覆盖安装 `5.5.4`**

Run：

```bash
HEIGE_SKIP_APPLY=1 /bin/zsh scripts/install.command
```

Expected：安装事务 `decision: commit`，稳定树版本为 `5.5.4`，状态主题与 `persistenceEnabled` 未改变。

- [ ] **Step 3：验证目标 APP**

Run：

```bash
/usr/libexec/PlistBuddy -c 'Print :HeiGeLauncherSchemaVersion' "$HOME/Applications/HeiGe 皮肤启动器.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$HOME/Applications/HeiGe 皮肤启动器.app/Contents/Info.plist"
/usr/bin/codesign --verify --deep --strict -- "$HOME/Applications/HeiGe 皮肤启动器.app"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -dump
```

Expected：Schema `3`、版本 `5.5.4`、验签通过、Bundle ID 可解析。

- [ ] **Step 4：真实点击语义启动**

Run：

```bash
/usr/bin/open -na "$HOME/Applications/HeiGe 皮肤启动器.app"
```

Expected：当前原生 Codex 的旧 PID 正常退出，新 Codex 带 `--remote-debugging-address=127.0.0.1 --remote-debugging-port=9341` 启动，最近主题恢复。

- [ ] **Step 5：端到端回读**

Run：

```bash
/Users/blakexu/.codex/heige-codex-skin-studio/scripts/lib/run-cli.zsh doctor --port 9341
/Users/blakexu/.codex/heige-codex-skin-studio/scripts/lib/run-cli.zsh status --port 9341
```

Expected：`processHasDebugFlag:true`、`portOpen:true`、renderer 状态均 `installed:true`、`mode:"active"`、主题为安装前 `lastNonNativeThemeId`、失败数组为空、菜单存在、`persistenceEnabled:false` 保持不变。

- [ ] **Step 6：做隔离恢复与失败 UI 验收**

在临时 HOME fixture 中运行真实 `codesign`、真实 wrapper 适配器和人工 device-drift lock；不得破坏正式状态根。证明备份只产生一次、坏状态和活 PID 均 fail closed、alert 使用 argv。

- [ ] **Step 7：复核官方 Codex 未被修改**

重新验证 `/Applications/ChatGPT.app` 的 `codesign --deep --strict` 和 `app.asar` SHA-256 与安装前一致。

- [ ] **Step 8：最终提交和状态检查**

如验收只产生文档证据则提交该证据；否则保持源码工作树干净。不得 push、Tag 或 Release。

## 自检

1. 规格覆盖：版本、每次安装、APP 身份、图标、签名、错误提示、session-only、恢复矩阵、锁链安全门、打包、真机回读和不发布边界均有对应任务。
2. 占位符检查：计划中没有 `TBD`、`TODO` 或未指定的实现步骤。
3. 类型一致性：`launcher-apply`、`--launcher-version`、`launch-skin.command`、participant 摘要名和 `recoverStaticLauncherStateRoot` 在测试与实现任务中一致。
4. 范围控制：不修改 Windows、WorkBuddy、官方 Codex Bundle、登录项或公开发行链路。
