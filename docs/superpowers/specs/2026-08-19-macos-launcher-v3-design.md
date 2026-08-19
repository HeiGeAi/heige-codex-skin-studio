# macOS HeiGe 皮肤启动器 Schema 3 设计

日期：2026-08-19

状态：用户已批准方案方向，等待书面规格复核

基线：GitHub `origin/main`，提交 `87b0e133148cba0eb9fbc7185e4ff8cc3b9e2651`，包版本 `5.5.3`

## 1．背景与现状

项目已经在安装阶段为当前用户生成 `$HOME/Applications/HeiGe 皮肤启动器.app`。现有 Schema 2 APP 只有 `Info.plist` 和一个 zsh 可执行文件。可执行文件通过安装时写入的绝对路径调用稳定安装目录中的 `scripts/apply.command`。

现有入口已经具备正确的 session-only 语义，但还不是完整的 macOS 产品入口：

1. APP 没有自有图标，Finder 和 Dock 显示通用占位图标。
2. APP 没有本地签名，无法用 `codesign --verify --deep --strict` 建立自身完整性证据。
3. 点击失败时没有用户可见反馈，Finder 启动的 shell 错误只会静默退出。
4. Bundle 版本固定为 `1.0`，无法反映当前安装的 Skin Studio 版本。
5. 现有安装事务只覆盖 executable 与 plist，没有覆盖图标和签名资源。

当前官方 Codex Desktop 位于 `/Applications/ChatGPT.app`，Bundle ID 为 `com.openai.codex`。本项目继续通过 `127.0.0.1` 回环 CDP 启动并注入，不修改 `app.asar`、官方应用二进制或官方签名资源。

## 2．当前决策快照

本规格冻结以下决策：

1. 产品形态选择 A：用户先运行一次项目安装器，之后本地 APP 是日常一键换肤入口。
2. 平台范围仅为 macOS。本轮不修改 Windows 启动器。
3. 显示名称继续使用现有的「HeiGe 皮肤启动器」，Bundle ID 继续使用 `com.heige.codex-skin-launcher`，避免产生第二个产品身份。
4. 双击 APP 只恢复当前会话的皮肤，不把 `persistenceEnabled` 从 `false` 改为 `true`。常驻仍由 Codex 顶部菜单中的用户开关控制。
5. 启动器优先恢复 `lastNonNativeThemeId`；没有有效记录时使用默认主题 `miku-488137`。
6. 图标使用当前 Miku 主题的核心人物形象，源自仓库中的 `assets/miku-character.png`，不加入文字、品牌角标或额外角色。
7. 开发基于 GitHub 最新 `main` 的 `5.5.3`，不基于本机旧分支 `5.2.2`，也不回退到最新正式 Release `v5.5.2`。
8. 本轮只形成本地分支、提交和本机安装验证，不推送 GitHub，不创建 Release，不做公开发布。

## 3．本轮完成合同

### 3.1 本轮目标

安装完成后，用户双击「HeiGe 皮肤启动器」即可让官方 Codex Desktop 以本机 CDP 模式启动或受控重启，恢复最近一次有效皮肤，并在应用完成后留下可回读的成功状态。

### 3.2 必须跑通的主路径

1. 最新项目安装器生成或升级 Schema 3 APP。
2. Finder 和 Dock 显示 Miku 自有图标，不再显示通用占位图标。
3. 双击 APP 后，官方 Codex Desktop 被启动或受控重启。
4. 最近一次有效非原生主题被应用；没有记录时应用 `miku-488137`。
5. 回读证据同时证明：目标 renderer 可达、主题 ID 正确、皮肤菜单存在、官方 Codex 签名仍有效。
6. 失败时出现单个原生错误提示，入口以非零状态结束，并保留脱敏日志线索。

### 3.3 明确范围外

1. 独立下载即用的自包含安装 APP。
2. DMG、Developer ID 签名、Apple 公证、Sparkle 更新或 Mac App Store 分发。
3. 托盘菜单、全局快捷键、独立主题选择窗口和新的常驻策略。
4. Windows 启动器改造。
5. 对 Miku 角色、图像或标识作法律授权判断。
6. GitHub 推送、Tag、Release 或对外发布。

### 3.4 完成状态分层

本任务的完成声明必须区分：

1. 已产出：源码、图标和文档存在。
2. 本地已验证：针对性测试与完整测试通过。
3. 目标环境已验证：APP 已安装到当前用户目录，Bundle、图标和本地签名验证通过。
4. 端到端已跑通：真实双击 APP 后，Codex 重启并回读到正确皮肤。
5. 未完成边界：未做 Developer ID 签名、公证、独立分发和 GitHub 发布。

## 4．方案比较与选择

### 4.1 方案一：只补图标

只增加 `AppIcon.icns` 与 `CFBundleIconFile`，继续直接调用 `apply.command`。

优点是改动最小。缺点是失败仍然静默、Bundle 仍然无完整性证据、迁移与签名资源不在安装事务中。它只能修复外观，不能兑现「真实可用产品入口」。不采用。

### 4.2 方案二：生成式 Launcher Schema 3

保留当前安全边界与生成式 APP 架构，增加图标、GUI 专用入口、本地 ad hoc 签名、版本信息、迁移校验和失败提示。

优点是复用已经经过测试的安装事务与 CDP apply 链路，不复制换肤引擎，也不要求用户安装 Xcode。缺点是它仍依赖先运行项目安装器，且本地 ad hoc 签名不等于 Apple 公证。采用本方案。

### 4.3 方案三：原生 Swift APP

用 Swift 或 SwiftUI 重建完整 GUI 壳，再把现有运行时嵌入 APP。

它适合未来的独立发行形态，但会引入构建工具链、通用二进制、Developer ID、公证、更新和双份运行时维护。它超出本轮 A 方案，不采用。

## 5．目标架构

### 5.1 Bundle 结构

Schema 3 APP 的受支持结构为：

```text
HeiGe 皮肤启动器.app/
  Contents/
    Info.plist
    MacOS/
      HeiGe Skin Launcher
    Resources/
      AppIcon.icns
    _CodeSignature/
      CodeResources
```

`Info.plist` 至少包含以下产品字段：

1. `CFBundleDisplayName` 与 `CFBundleName`：`HeiGe 皮肤启动器`。
2. `CFBundleIdentifier`：`com.heige.codex-skin-launcher`。
3. `CFBundleIconFile`：`AppIcon.icns`。
4. `CFBundleShortVersionString` 与 `CFBundleVersion`：来自当前安装包版本，例如 `5.5.3`。
5. `LSMinimumSystemVersion`：与当前 Codex Desktop 支持边界一致，设为 `13.0`。
6. `NSHighResolutionCapable`：`true`。
7. `HeiGeLauncherSchemaVersion`：`3`。
8. `HeiGeInstallRoot`：安装时经过校验的当前用户稳定安装绝对路径。

### 5.2 运行入口

Bundle 内的固定 zsh executable 只调用稳定安装目录中的新入口 `scripts/launch-skin.command`。实际换肤仍由现有 `scripts/apply.command` 与 CLI 完成，避免在 APP 内复制业务引擎。

数据流如下：

```text
双击 APP
  → 校验稳定安装入口
  → launch-skin.command 调用 apply.command
  → 校验官方 Codex 身份与签名
  → 必要时受控退出并带回环 CDP 参数重启
  → 应用 lastNonNativeThemeId 或 miku-488137
  → 回读 renderer、theme id 与菜单
  → 成功静默退出，失败显示原生提示
```

### 5.3 成功体验

成功时不额外发送系统通知，也不弹「成功」对话框。Codex 本身被拉起且皮肤可见就是主反馈，避免一次点击产生两层打扰。

### 5.4 失败体验

`scripts/launch-skin.command` 捕获 `apply.command` 的非零退出，整理为不超过 1200 个字符的单条用户消息，并通过系统自带 `/usr/bin/osascript` 显示原生 alert。实现必须把错误内容作为 argv 传入静态 AppleScript，不把动态文本拼进脚本源码。

失败提示至少区分以下类别：

1. 稳定运行时缺失或损坏。
2. 未找到官方 Codex Desktop。
3. Codex Bundle ID、Team ID 或签名不可信。
4. CDP 端口无法建立或 renderer 超时。
5. 主题不存在、主题读取失败或注入回读失败。
6. 另一个换肤操作正在进行。

错误提示不得包含控制令牌、完整环境变量、授权头或未脱敏子进程环境。详细诊断写入权限受限、大小有上限的 launcher 日志，复用项目现有日志脱敏约束。

## 6．图标资产设计

### 6.1 源图与构图

编辑目标为 `assets/miku-character.png`。最终主图为正方形 Miku 头像近景，保留青色双马尾、耳机、星形发饰、面部和手部动作；去掉原图右侧残留文字与界面元素。人物面部位于中央安全区，缩到 32 像素时仍能辨认。

图标不增加文字、数字、OpenAI 标识或新的品牌符号。背景沿用当前皮肤的青蓝、粉紫渐变与星光质感，外轮廓采用静态 macOS 圆角方形构图，不使用动画。

### 6.2 产物

仓库保存以下正式资产：

1. `assets/launcher/miku-launcher-icon.png`：1024×1024 主源图。
2. `assets/launcher/AppIcon.icns`：由标准 iconset 规格确定性生成的安装资源。

`.icns` 必须覆盖 16、32、128、256、512 与 1024 像素 Retina 组合。构建验证会反向展开 `.icns` 并核对规格，防止只有单张大图但小尺寸缺失。

### 6.3 资产权利边界

现有 `assets/miku-character.png` 在 `ASSET_PROVENANCE.md` 中的已知许可为「未知」，项目所有者此前已确认随仓库公开发布。新图标是该素材的衍生资产，必须新增逐项记录，并明确继承原素材的未知授权状态。

本轮可以按用户明确要求制作和本地安装，但不能把新增记录表述成已取得第三方角色、商标或图像授权。

## 7．安装、迁移与签名

### 7.1 Schema 迁移

安装器继续识别旧 Schema 1 与 Schema 2 Bundle 的所有权，但所有新安装和升级统一生成 Schema 3。

升级时必须：

1. 校验旧 Bundle 符合历史生成器的精确结构与归属字段。
2. 在同一用户 Applications 目录中创建 staging Bundle。
3. 写入 executable、plist 与 icon。
4. 使用系统 `/usr/bin/codesign` 对 staging Bundle 做 ad hoc 签名。
5. 对 staging Bundle 执行 `codesign --verify --deep --strict`。
6. 把图标摘要、签名资源摘要和 Bundle 版本纳入安装事务描述。
7. 原子发布 staging Bundle；发生崩溃或 SIGKILL 时按事务日志恢复旧 Bundle 或完成已决提交。

### 7.2 签名边界

ad hoc 签名只用于证明本机生成后的 Bundle 内容一致，并让自动验收能够检查 Bundle 未被意外改写。它不等于 Developer ID 签名，不提供 Apple 公证，也不承诺可把 APP 单独复制到另一台 Mac 后绕过 Gatekeeper。

### 7.3 LaunchServices 刷新

安装成功后，用系统 LaunchServices 注册器重新登记目标 APP，使 Finder 与 Dock 尽快刷新图标和版本信息。不得通过重启 Finder、清空全局图标缓存或删除用户 Dock 配置来强制刷新。

## 8．安全与隐私约束

1. 不修改 `/Applications/ChatGPT.app` 内任何文件。
2. 启动前继续校验 Bundle ID `com.openai.codex`、OpenAI Team ID 与 `codesign --deep --strict`。
3. CDP 继续只绑定 `127.0.0.1`，不开放局域网地址。
4. APP executable 不下载代码、不调用 `curl`、不请求 `sudo`、不读取任意 `$HOME` 插值路径。
5. 动态路径在安装时规范化并写入 Bundle，入口只接受安装器生成的可信绝对路径。
6. GUI 错误适配器只接收已截断、已清理控制字符的文本。
7. 重复双击依赖现有 operation lock 串行化，不产生多个并发重启。
8. 启动器不改变用户的常驻选择，不创建新的 LaunchAgent。

## 9．实现影响范围

预计修改或新增以下正式文件：

```text
assets/launcher/miku-launcher-icon.png
assets/launcher/AppIcon.icns
ASSET_PROVENANCE.md
src/macos-launcher.mjs
scripts/launch-skin.command
scripts/skill-package-manifest.json
test/macos-launcher.test.mjs
test/scripts.test.mjs
test/live-macos-acceptance.mjs
README.md
README.en.md
docs/manual.md
llms.txt
llms-full.txt
skill/heige-codex-skin-studio/README.md
skill/heige-codex-skin-studio/SKILL.md
```

若实现中证明不需要修改某个预计文件，应直接缩小改动范围。不得借此重构无关的主题、Windows、WorkBuddy 或控制器模块。

## 10．测试与验收

### 10.1 静态和单元测试

至少覆盖：

1. Schema 3 plist、Bundle 结构、版本、图标字段和权限。
2. 旧 Schema 1、2 的识别与 Schema 3 升级。
3. icon 缺失、icon 被替换、签名损坏和额外文件注入时拒绝发布。
4. 安装准备、发布、提交、回滚与 SIGKILL 恢复。
5. 用户名包含中文、空格和 shell 特殊字符时的路径安全。
6. GUI 失败提示的 argv 传递、控制字符清理、长度上限和非零退出。
7. 启动器继续保持 session-only，不改变常驻状态。
8. Skill 安装包包含新增脚本与图标，且打包结果可确定性复现。

### 10.2 完整项目测试

运行最新基线规定的完整门槛：

```bash
npm ci
npm run release:check
```

必须报告通过、失败、跳过数量。单个针对性测试通过不能替代完整门槛。

### 10.3 当前 Mac 目标环境验收

在修改当前安装前，记录官方 Codex 签名、`app.asar` 摘要、当前 Skin Studio 版本和当前主题状态。然后使用项目正式安装入口把新树安装到稳定目录。

安装后必须验证：

1. `$HOME/Applications/HeiGe 皮肤启动器.app` 存在且非空。
2. `Info.plist` 为 Schema 3，版本与安装树一致。
3. `AppIcon.icns` 可反向展开为完整规格。
4. Launcher APP 通过本地 `codesign --verify --deep --strict`。
5. LaunchServices 能解析 Bundle ID、版本和图标。
6. 用 Finder 等价路径 `/usr/bin/open` 真实打开 APP。
7. Codex 进程带预期回环 CDP 参数运行。
8. `/json/list` 可达并存在经过严格识别的主 renderer。
9. 状态回读显示有效非原生主题、菜单存在、目标健康。
10. 官方 `/Applications/ChatGPT.app` 签名仍有效，`app.asar` 摘要未变化。

失败提示路径通过隔离 fixture 和真实 `/usr/bin/osascript` 适配器验证，不故意破坏当前正式安装来制造错误。

### 10.4 视觉验收

1. 检查 1024×1024 主图，确认没有残留文字、水印、裁切面部或新增角色。
2. 检查 32、64、128、256 与 512 像素缩略图，确认小尺寸可辨识。
3. 获取 Finder 或 Quick Look 的本机渲染证据，确认 APP 不再显示通用占位图标。
4. 图标只做静态呈现，不引入动画或动态 Dock 效果。

## 11．回滚策略

1. 功能代码在独立分支 `codex/macos-launcher-product-v3` 开发，不修改用户当前脏工作树。
2. 安装器继续使用现有事务和崩溃恢复机制，发布新 APP 前保留旧 Bundle 作为事务参与者。
3. 若端到端验收失败，先用事务回滚或重新安装公开 `v5.5.2`，不修改官方 Codex Bundle。
4. 用户主题与状态位于 `~/Library/Application Support/HeiGeCodexSkinStudio`，安装树升级不得删除该目录。
5. 未经用户另行授权，不删除旧日志、不清空主题、不推送 GitHub，也不发布 Release。

## 12．残余风险

1. OpenAI 未来可能改变 Electron 启动参数、CDP 能力、renderer URL 或 DOM，届时启动器仍能拉起 APP，但皮肤注入可能需要适配。
2. 本地 ad hoc 签名不能替代 Developer ID 与公证，方案 A 仍要求先运行项目安装器。
3. Miku 图标继承现有未知授权状态，公开分发风险未被技术实现消除。
4. 真实双击验收会受控重启当前 Codex Desktop，当前任务需要在测试前提交全部变更并保留可恢复状态。
5. Finder 和 Dock 有图标缓存，LaunchServices 重登记通常能刷新，但不能承诺所有系统版本立即无缓存显示。

## 13．规格自检结论

本规格没有待定占位符。产品范围、运行语义、图标来源、Bundle 结构、错误路径、迁移、安全边界、测试证据、回滚方式和残余风险彼此一致。实现工作可以在一次独立计划中完成，不需要拆成多个产品子项目。
