# ChatGPT Desktop Skin Studio

[English README](README.md)

面向 macOS 和 Windows ChatGPT Desktop 的 AI 换肤 Skill 与轻量运行时。

本仓库包含 `codex-skin-studio` Codex Skill 以及轻量 Node.js 工具链。主题换肤路径保持零依赖；可选 Pet 精灵图路径使用 ChatGPT Desktop 随附的 `sharp` 运行时（如果可用）。Skill 可以把生图结果或用户提供的图片制作成完整主题，校验本地资源，通过本机回环 CDP 应用到 ChatGPT Desktop，并通过 macOS LaunchAgent 或 Windows Task Scheduler 在电脑登录、应用启动和 Renderer 重载后自动恢复。

本项目仅将 [HeiGeAi/heige-codex-skin-studio](https://github.com/HeiGeAi/heige-codex-skin-studio) 作为研究和设计参考，独立实现轻量版本，不是对其完整仓库 Fork 后修改，也不宣称功能完全一致。当前范围是 Codex Skill 加轻量本地运行时，后续计划独立扩展皮肤网站能力。

当前应用名称是 ChatGPT Desktop。macOS 技术 Bundle ID 为 `com.openai.codex`；Windows 已支持官方独立版 Codex / ChatGPT Desktop 客户端，包括 Microsoft Store（MSIX）安装和普通可执行文件安装。运行时会自动发现客户端，不依赖具体用户名、盘符或 `WindowsApps` 路径。

## Windows 平台支持

Windows 平台已经支持 Codex / ChatGPT Desktop 换肤的完整流程：发现官方客户端、通过 AUMID 启动 MSIX、在 `127.0.0.1:9341` 建立本机 CDP、注入并验证主题，以及通过用户级 `CodexSkinStudio` Task Scheduler 任务在登录、应用启动和 Renderer 重载后自动恢复。整个过程不修改 `app.asar`、签名、二进制文件或官方 JavaScript，也不需要管理员权限。

## 核心能力

- 使用 Codex 原生生图能力编排文生皮肤。
- 支持图生皮肤：直接使用背景、指定人物或物体保真合成、风格参考图、多图组合。
- 固化五区视觉契约，保证侧栏、聊天区、输入框和主体空间可用。
- 一次性生成 `hero`、`theme.json`、可选 Logo、可选肖像卡和品牌文案。
- 未提供 Logo 或显式品牌名时，自动使用主题名称生成左侧导航品牌名，并应用花式文字样式。
- 品牌名样式会根据 Hero 的视觉语言选择 `anime`、`cyberpunk`、`editorial`、`military`、`mystic` 或 `romantic`，不再所有主题共用同一套字体和装饰。
- 品牌名只替换顶部 workspace label，不误伤项目 Session 和账户区域。
- 只通过 `127.0.0.1` 本机 CDP 通信。
- 可选 macOS LaunchAgent 或 Windows Task Scheduler，自动处理登录、应用启动和 Renderer 重载。
- 支持官方 Windows 独立版 Codex / ChatGPT Desktop，包括 MSIX 和普通可执行文件安装。
- 对话区域右上角提供 `Skins` 按钮，可以直接切换本地已生成的有效主题。
- `Skins` 菜单打开时和运行期间会自动刷新本地主题，新创建的主题无需重启 ChatGPT Desktop 即可出现。
- 过大的 PNG/JPG 主背景会先在 Renderer 中解码并压缩为较小的 WebP Data URL，避免 CSS 过大导致背景规则被静默丢弃。
- 主题生成阶段也会自动把 Hero、Logo、肖像卡转换为 `.webp` 并同步更新 `theme.json`。
- 支持配套 Pet 生成：Pet 必须卡通化、拟人化、大头小身体，并组装为可校验的 Codex V2 8×11 RGBA PNG/WebP 精灵图，包含 16 个视角方向。
- 支持主题 + Pet 配套 Bundle、原子安装、本地状态查询和一次性配套切换命令。
- 不修改 `app.asar`，不修改应用签名，不需要网站、数据库、远程服务或任意主题 CSS。
- Skill 分发文件全部使用英文 ASCII；Skill 可以用中文或其他语言回复用户。

## 工作架构

```text
用户需求或参考图片
        |
        v
Codex Vision + 原生 image_gen
        |
        v
最终 hero + 主题色 + 可选资源
        |
        v
create-theme.mjs
        |
        v
validate -> persist -> apply.mjs -> 本机回环 CDP
                                      |
                                      v
                              ChatGPT Desktop
                                      ^
                                      |
                         可选平台持久化 worker
```

Skill 负责 Agent 编排；`create-theme.mjs` 负责一次性生成完整主题目录；`apply.mjs` 负责发现经过签名校验的 ChatGPT Desktop、选择主 Renderer、注入并验证样式；`persist.mjs` 负责长期运行的自动恢复 worker。启用持久化后，worker 还会在 `127.0.0.1:9342` 提供仅本机访问的主题控制接口，右上角 `Skins` 按钮通过主题 ID 切换有效本地主题，不接受任意文件路径或命令。原生菜单（包括文件“打开方式”菜单）展开时，按钮会临时隐藏并释放点击区域，菜单关闭后自动恢复。按钮支持在对话区域内拖拽，普通点击打开主题菜单，拖拽后位置会保存在当前 Renderer 的本地存储中。

`Skins` 菜单打开时会从本机回环 `/themes` 接口读取最新有效主题，挂载期间也会定时刷新。持久化 worker 暂时不可用时，会保留最近一次注入的主题列表作为缓存。
持久化 worker 会串行执行主题应用，避免后台 Renderer 恢复检查与手动切换同时注入不同主题。

## 目录结构

```text
docs/
├── codex-desktop-skin-skill-mvp-plan.md
└── superpowers/specs/

skill/codex-skin-studio/
├── SKILL.md
├── agents/openai.yaml
├── scripts/
│   ├── apply.mjs
│   ├── create-paired.mjs
│   ├── create-pet.mjs
│   ├── create-theme.mjs
│   ├── install-pet.mjs
│   ├── paired-status.mjs
│   ├── paired.mjs
│   ├── pet.mjs
│   ├── pet-desktop.mjs
│   ├── persist.mjs
│   └── windows/
│       └── apply.ps1
├── templates/
│   ├── pet-contract.json
│   ├── pet.json
│   └── theme.json
└── examples/
    ├── cyberpunk/
    ├── pets/mascot/
    └── slayers-xellos-night/
        ├── hero.webp
        └── theme.json

scripts/
├── package-codex-skin-studio.mjs
└── package-codex-skin-studio.command

test/
├── codex-skin-studio-mvp.test.mjs
└── windows-pet-contract.test.mjs

output/
└── codex-skin-studio.skill
```

生成的主题属于用户数据，macOS 保存在
`~/Library/Application Support/CodexSkinStudio/themes/`，Windows 保存在
`%APPDATA%\\CodexSkinStudio\\themes\\`。仓库额外内置
`examples/slayers-xellos-night/` 作为默认示例皮肤；示例资源的权利说明见
[NOTICE.md](NOTICE.md)。

### 默认示例皮肤

`Slayers Xellos Night` 是仓库的默认示例皮肤，展示一次性生成结果应包含
16:9 的 `hero.webp` 和匹配的 `theme.json`。它用于预览和开发；仍需用户
明确执行 apply 请求后才会应用。

## 安装 Skill

生成可分发的 Skill 包：

```bash
npm run package:codex-skin-studio
```

输出文件为 `output/codex-skin-studio.skill`。可以通过 Codex Skill installer 安装，也可以在本地开发时同步源码目录：

```bash
mkdir -p "$HOME/.codex/skills"
rsync -a --delete skill/codex-skin-studio/ "$HOME/.codex/skills/codex-skin-studio/"
```

Skill 安装本身只复制文件，不启动后台进程。用户首次明确要求应用主题时，Skill 会检查并自动启用持久化 worker。

### Windows 新用户：首次安装和一次性应用

安装 Skill 后，官方独立版 Windows Codex / ChatGPT Desktop 按以下步骤操作：

1. 确认官方桌面客户端已经安装，并在 PowerShell 中确认 `node` 可用。runner 会自动发现 MSIX 和普通可执行文件安装，不要手写 `C:\Users\...` 或 `WindowsApps` 路径。
2. 给 Codex 发起一次完整请求，例如：

   ```text
   创建并应用一个深色赛博朋克 ChatGPT Desktop 皮肤。请生成并检查 hero，创建或更新完整主题目录，启用持久化，并给出 Windows 外部 PowerShell runner 指令；最终确认状态为 active。
   ```

3. 等待 Skill 完成原生生图、hero 检查、`theme.json` 和本地资源创建，以及主题校验。如果直接使用本地背景图，请提供非空的 PNG、JPEG 或 WebP 文件。
4. 将 Skill 返回的确切主题目录填入下面的命令，在独立 PowerShell 窗口执行。它会自动校验主题、优雅关闭当前客户端、发现并启动官方客户端、通过 AUMID 建立 CDP、注入皮肤，并在 `-Persist` 下安装登录后恢复任务：

   ```powershell
   $theme = "$env:APPDATA\CodexSkinStudio\themes\my-theme"
   powershell -NoProfile -ExecutionPolicy Bypass -File `
     "$env:USERPROFILE\.codex\skills\codex-skin-studio\scripts\windows\apply.ps1" `
     -ThemeDir $theme -Persist
   ```

runner 必须返回：

```json
{"status":"applied"}
```

也可以在 PowerShell 中进一步验证：

```powershell
node "$env:USERPROFILE\.codex\skills\codex-skin-studio\scripts\apply.mjs" status --json
node "$env:USERPROFILE\.codex\skills\codex-skin-studio\scripts\persist.mjs" status --json
```

第一个命令必须得到 `status: "active"`，并且主题 ID 正确、`connected: true`、`heroLoaded: true`。启用持久化后，第二个命令应包含 `status: "enabled"` 和 `running: true`。

runner 必须从独立 PowerShell 进程执行，因为在当前 Codex Agent 进程内重启 Renderer 可能会中断正在执行的操作。不要直接在当前 Agent 进程中执行会重启客户端的 `apply.mjs apply`，也不要使用 `taskkill /IM ChatGPT.exe`，否则可能连 Codex 宿主进程一起终止。

### Windows 更新已有皮肤

保留原来的主题 ID 和目录。让 Codex 生成或接收新的 hero、重新提取主题色，并使用 `--replace` 原子替换完整主题目录，然后重复上面的外部 runner 命令。新主题只有在校验成功后才会替换旧主题，更新失败不会留下半成品。

## 使用场景

### 文生皮肤

```text
创建并应用一个深色赛博朋克 ChatGPT Desktop 皮肤，使用霓虹青色作为强调色。
```

Skill 会生成视觉规范，调用原生生图能力，检查结果，提取主题色，生成主题文件，应用主题，并确认最终状态为 `active`。

### 指定人物或物体图生皮肤

```text
以附件中的人物作为主体，制作并应用日漫风格 ChatGPT Desktop 皮肤。保留脸部、轮廓、服装、法杖、颜色和比例，重新设计背景。
```

Skill 会先使用 Vision 检查图片，再明确标记主体角色，优先保持人物或产品结构不变，只改变环境、光照、阴影、画布空间和主体位置。

### 风格参考图

```text
只参考这张图片的配色、光照和画风，重新生成一张 ChatGPT Desktop 皮肤，不复制原图人物和构图。
```

### 直接使用背景图

```text
直接用这张本地图片作为 ChatGPT Desktop 背景并应用。
```

Skill 会检查比例、安全区、对比度、文字和水印，然后再创建主题。

### 配套生成主题与 Pet

示例请求：

```text
根据这张人物参考图，同时生成 ChatGPT Desktop 主题和一个卡通化、拟人化、大头小身体的 Pet，然后配套切换。
```

Skill 会分别生成 Hero 和 Pet 动作帧，分别校验，创建配套 Bundle，原子安装 Pet，并应用主题。切换命令随后通过版本化的可见 Settings > Pets 适配器执行 Refresh 和选择，并确认自定义精灵资源已加载。原生成功状态为 `theme-applied-pet-selected`；UI 不可用时会真实降级为 `theme-applied-pet-refresh-required`。选择后应确认匹配的 Pet 预览/Overlay。当前实测 Desktop 版本不识别 `/pet`，不能把该命令的错误响应误报为唤醒成功。

## 五区视觉契约

每张 hero 都是实时 ChatGPT Desktop 工作台的背景，不是截图或海报。

1. **左侧：品牌与导航安全区。** 为品牌 Logo 或花式品牌名、专属导航预留安静空间。人物脸部、主体高光和密集细节不得放在这里。
2. **中部：沉浸背景与渐变安全层空间。** 保持场景沉浸感，同时为聊天内容保留可读的渐变层空间。
3. **右侧：人物或产品主体与信息卡空间。** 主体放在右侧三分之一，并为可选品牌信息卡留出呼吸空间。
4. **底部：输入工作台安全区。** 底部约 20% 保持低对比度，为输入框和审批控件提供稳定背景。
5. **右下：可选肖像卡。** 作为次要元素，不得覆盖主体、输入框或主要品牌信息。

背景图中不得绘制假菜单、按钮、聊天气泡、代码、文字、水印或 ChatGPT 界面。真实导航、渐变层、输入工作台和卡片由注入器负责。

## 可读性与对比度

运行时注入器负责可读性层。它会把主题色映射到 ChatGPT Desktop 的控件 token，并为输入框、发送按钮、菜单、对话框、右侧文件或文档预览、选中态和焦点态使用不透明的主题派生表面。强调色按钮会根据强调色自动选择对比度更高的前景色，不再固定使用白色，从而避免背景图明亮或细节密集时出现白底白字、按钮不明显等问题。

## 一次性生成并应用

获得最终 hero 并完成 Vision 检查后，可以用一个命令生成和应用主题：

```bash
node "$HOME/.codex/skills/codex-skin-studio/scripts/create-theme.mjs" \
  --id "slayers-xellos-night" \
  --name "Slayers Xellos Night" \
  --out "$HOME/Library/Application Support/CodexSkinStudio/themes/slayers-xellos-night" \
  --hero "/absolute/path/to/final-hero.webp" \
  --accent "#D76CFF" \
  --secondary "#806CFF" \
  --surface "#090D2A" \
  --text "#FFFFFF" \
  --brand "SLAYERS XELLOS" \
  --replace \
  --apply
```

命令会先写入临时目录，完成主题校验后原子替换输出目录，再持久化并应用主题。`--replace` 不会在新主题校验通过前删除旧主题。

用户明确要求应用时，Skill 会自动检查持久化 worker；如果状态是 `disabled`，执行：

```bash
node "$HOME/.codex/skills/codex-skin-studio/scripts/persist.mjs" status --json
node "$HOME/.codex/skills/codex-skin-studio/scripts/persist.mjs" install --json
```

最终必须看到 `application.status: "applied"` 或之后的 `apply.mjs status` 返回 `active`。`scheduled`、`pending` 和 `enabled` 都不能单独证明皮肤已经显示。

## 主题格式

运行时核心是本地 hero 图片和 `theme.json`：

```json
{
  "schemaVersion": 1,
  "id": "slayers-xellos-night",
  "name": "Slayers Xellos Night",
  "hero": "hero.webp",
  "logo": "logo.png",
  "polaroid": "polaroid.png",
  "copy": {
    "brand": "SLAYERS XELLOS",
    "headline": "The Black Cloak of Xellos",
    "tagline": "Arcane ruins. Violet stars. Quiet mischief."
  },
  "colors": {
    "accent": "#D76CFF",
    "secondary": "#806CFF",
    "surface": "#090D2A",
    "text": "#FFFFFF"
  }
}
```

当前 Skill 工作流要求 `schemaVersion`、`id`、`name`、`hero` 和四个主题色。`logo` 用经过授权的本地图片替换顶部 workspace label；没有 Logo 时，`copy.brand` 使用受限 CSS 替换品牌名，`create-theme.mjs` 默认使用主题名称，也可以用 `--brand` 覆盖。`copy.brandStyle.preset` 记录根据 Hero 视觉语言选择的字体和装饰方案。`headline` 和 `tagline` 只有显式提供时才生成右侧信息卡。`polaroid` 是右下角不可交互的次要肖像卡。

当前运行时支持 PNG、JPEG 和 WebP。GIF 与视频背景尚未在 MVP 中启用，因为它们需要额外的动画生命周期、播放状态、性能和重载验证。

## 持久化 Worker

CDP 注入的 CSS 存在于 Renderer 内存中，ChatGPT Desktop 完整重启后会消失。平台原生 worker 在不修改应用包的情况下解决这个问题：

```bash
node "$HOME/.codex/skills/codex-skin-studio/scripts/persist.mjs" install --json
node "$HOME/.codex/skills/codex-skin-studio/scripts/persist.mjs" status --json
node "$HOME/.codex/skills/codex-skin-studio/scripts/persist.mjs" uninstall --json
```

macOS worker 是由 `launchd` 管理的独立 Node.js 进程；Windows worker 是由用户级 Windows Task Scheduler 任务 `CodexSkinStudio` 在交互式登录时启动的独立 Node.js 进程。两者都使用本机回环 CDP，监听选中的 Renderer，并在用户登录、应用启动或 Renderer 重载后重新注入主题。

不要使用 ChatGPT Scheduled Task 代替本地 OS worker。它与本地持久化进程无关，不能提供需要的应用生命周期钩子。

### Windows

在 PowerShell 或命令提示符中使用相同的 Node.js 命令。运行时会依次检查
`%LOCALAPPDATA%`、`%ProgramFiles%` 下的常见 ChatGPT 安装位置、Microsoft Store
包安装目录，并回退到 `where.exe`。首次明确应用主题时，重启 worker 会使用本机回环 CDP 参数启动
ChatGPT Desktop。需要登录和 Renderer 重载后自动恢复时，显式执行：

```powershell
node "$env:USERPROFILE\\.codex\\skills\\codex-skin-studio\\scripts\\persist.mjs" install --json
node "$env:USERPROFILE\\.codex\\skills\\codex-skin-studio\\scripts\\persist.mjs" status --json
```

该命令会创建用户级 `CodexSkinStudio` Task Scheduler 任务，不需要管理员权限，
也不会修改 ChatGPT 安装目录。

为了保证一次性换肤成功，Windows 推荐使用 Skill 内置的外部 PowerShell runner。
它必须从独立的 PowerShell 窗口运行，负责关闭旧 Renderer、通过 AUMID 启动官方 Codex / ChatGPT Desktop、等待 `9341` CDP 就绪，再调用 Node 注入主题：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  "$env:USERPROFILE\.codex\skills\codex-skin-studio\scripts\windows\apply.ps1" `
  -ThemeDir "C:\absolute\path\to\theme" -Persist
```

主题生成或更新完成后，Windows 不要在当前 Codex Agent 内直接执行 `apply.mjs apply`。
runner 返回 `{"status":"applied"}` 后才算换肤成功。

## 检查与恢复

```bash
node "$HOME/.codex/skills/codex-skin-studio/scripts/apply.mjs" doctor --json
node "$HOME/.codex/skills/codex-skin-studio/scripts/apply.mjs" status --json
node "$HOME/.codex/skills/codex-skin-studio/scripts/apply.mjs" restore --json
node "$HOME/.codex/skills/codex-skin-studio/scripts/apply.mjs" restore --restart-normal --json
```

`restore` 只移除注入样式，不删除主题文件。`restore --restart-normal` 会同时关闭调试参数并正常重启 ChatGPT Desktop。

## 常见问题

### 重启后皮肤消失

检查 worker：

```bash
node "$HOME/.codex/skills/codex-skin-studio/scripts/persist.mjs" status --json
```

正常结果应包含 `status: "enabled"` 和 `running: true`。如果是 `disabled`，执行 `install` 后重新应用主题。

### 应用结果是 `scheduled`

说明 ChatGPT Desktop 尚未暴露 Renderer。等待片刻后运行 `apply.mjs status --json`，只有 `active` 才算应用完成。

### 生图失败

Skill 使用 Codex 原生生图能力。如果当前 provider 没有生图路由，请提供最终本地 PNG、JPEG 或 WebP 背景。运行时不会静默切换到外部图片 API。

### 项目 Session 或用户账户样式异常

这是回归问题。品牌选择器只能命中顶部 workspace mode 按钮，不能使用宽泛的侧栏 `:first-child`、通用菜单按钮、项目操作按钮或账户按钮选择器。修改前先运行完整测试。

## 开发与验证

```bash
npm test
npm run test:codex-skin-studio
npm run test:windows
npm run package:codex-skin-studio
```

仓库还提供手动触发的 Windows Desktop E2E workflow：安装官方 Microsoft
Store 版本、启动 loopback CDP、安装示例 Pet，并尝试通过可见的 Settings >
Pets 执行 Refresh 和选择：[Windows Desktop E2E workflow](.github/workflows/windows-desktop-e2e.yml)。
当前 Windows Renderer 的主题注入已经验证；原生 Pet 选择需要已登录且能显示
Settings 的交互式 Desktop，会在干净 Runner 中保留明确失败，不会把本地文件安装
误报为已选择 Pet。

在已登录的 Windows 机器上，可使用以下命令收集原生选择验收证据：

```powershell
node "$env:USERPROFILE\.codex\skills\codex-skin-studio\scripts\verify-pet-desktop.mjs" `
  --pet-id mascot --port 9341 --json
```

主题换肤分发路径保持零依赖和英文 ASCII-only；可选 Pet 图集工具需要 `sharp`，优先使用 ChatGPT Desktop 随附的 Node 运行时。主题名称和用户回复可以使用任意语言。

## 安全边界

- CDP 只绑定 `127.0.0.1`。
- 主题资源必须是主题目录内的本地文件。
- Manifest 字段经过校验，主题不能提供任意 CSS 或 JavaScript。
- 永不修改应用包和代码签名。
- 持久化使用用户级 macOS LaunchAgent 或 Windows Task Scheduler，可通过 `persist.mjs uninstall` 移除。

## 许可证

项目代码使用 [MIT License](LICENSE)。角色名称、Logo 和第三方视觉素材仍受各自权利约束，详见 [NOTICE.md](NOTICE.md)。

English guide: [README.md](README.md)

## 联系方式

项目联系方式和交流信息请扫描二维码：

<img src="codex-skin-skill-qrcode.jpg" alt="联系方式二维码" width="188">

- Discord：[加入社区服务器](https://discord.gg/bjeNUUCXq)
- X / Twitter：[@dennis_huangbei](https://x.com/dennis_huangbei)
