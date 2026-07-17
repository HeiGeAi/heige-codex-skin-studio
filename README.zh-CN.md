# ChatGPT Desktop Skin Studio

面向 macOS ChatGPT Desktop 的 AI 换肤 Skill 与轻量运行时。

本仓库包含 `codex-skin-studio` Codex Skill 以及零依赖 Node.js 工具链。Skill 可以把生图结果或用户提供的图片制作成完整主题，校验本地资源，通过本机回环 CDP 应用到 ChatGPT Desktop，并通过 macOS LaunchAgent 在电脑登录、应用启动和 Renderer 重载后自动恢复。

本项目是受 [HeiGeAi/heige-codex-skin-studio](https://github.com/HeiGeAi/heige-codex-skin-studio) 的研究和产品方向启发的独立轻量实现，不是其镜像，也不宣称功能完全一致。当前范围是 Codex Skill 加本地零依赖运行时，后续计划独立扩展皮肤网站能力。

当前应用名称是 ChatGPT Desktop，技术 Bundle ID 为 `com.openai.codex`。

## 核心能力

- 使用 Codex 原生生图能力编排文生皮肤。
- 支持图生皮肤：直接使用背景、指定人物或物体保真合成、风格参考图、多图组合。
- 固化五区视觉契约，保证侧栏、聊天区、输入框和主体空间可用。
- 一次性生成 `hero`、`theme.json`、可选 Logo、可选肖像卡和品牌文案。
- 品牌名只替换顶部 workspace label，不误伤项目 Session 和账户区域。
- 只通过 `127.0.0.1` 本机 CDP 通信。
- 可选 macOS LaunchAgent，自动处理登录、应用启动和 Renderer 重载。
- 对话区域右上角提供 `Skins` 按钮，可以直接切换本地已生成的有效主题。
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
                         可选 macOS LaunchAgent
```

Skill 负责 Agent 编排；`create-theme.mjs` 负责一次性生成完整主题目录；`apply.mjs` 负责发现经过签名校验的 ChatGPT Desktop、选择主 Renderer、注入并验证样式；`persist.mjs` 负责长期运行的自动恢复 worker。启用持久化后，worker 还会在 `127.0.0.1:9342` 提供仅本机访问的主题控制接口，右上角 `Skins` 按钮通过主题 ID 切换有效本地主题，不接受任意文件路径或命令。原生菜单（包括文件“打开方式”菜单）展开时，按钮会临时隐藏并释放点击区域，菜单关闭后自动恢复。

## 目录结构

```text
skill/codex-skin-studio/
├── SKILL.md
├── agents/openai.yaml
├── scripts/
│   ├── apply.mjs
│   ├── create-theme.mjs
│   └── persist.mjs
├── templates/theme.json
└── examples/cyberpunk/

themes/
└── slayers-xellos-night/

output/
└── codex-skin-studio.skill
```

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
  --out "/absolute/path/to/themes/slayers-xellos-night" \
  --hero "/absolute/path/to/final-hero.webp" \
  --accent "#D76CFF" \
  --secondary "#806CFF" \
  --surface "#090D2A" \
  --text "#FFFFFF" \
  --brand "SLAYERS // XELLOS" \
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
    "brand": "SLAYERS // XELLOS",
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

当前 Skill 工作流要求 `schemaVersion`、`id`、`name`、`hero` 和四个主题色。`logo` 用经过授权的本地图片替换顶部 workspace label；没有 Logo 时，`copy.brand` 使用受限 CSS 替换品牌名。`headline` 和 `tagline` 只有显式提供时才生成右侧信息卡。`polaroid` 是右下角不可交互的次要肖像卡。

当前运行时支持 PNG、JPEG 和 WebP。GIF 与视频背景尚未在 MVP 中启用，因为它们需要额外的动画生命周期、播放状态、性能和重载验证。

## 持久化 Worker

CDP 注入的 CSS 存在于 Renderer 内存中，ChatGPT Desktop 完整重启后会消失。LaunchAgent 在不修改应用包的情况下解决这个问题：

```bash
node "$HOME/.codex/skills/codex-skin-studio/scripts/persist.mjs" install --json
node "$HOME/.codex/skills/codex-skin-studio/scripts/persist.mjs" status --json
node "$HOME/.codex/skills/codex-skin-studio/scripts/persist.mjs" uninstall --json
```

worker 是由 macOS `launchd` 管理的独立 Node.js 进程，不是 ChatGPT Desktop 内部进程。它使用本机回环 CDP，监听选中的 Renderer，并在用户登录、应用启动或 Renderer 重载后重新注入主题。

不要使用 ChatGPT Scheduled Task 代替本地 LaunchAgent。Scheduled Task 没有可靠的本机进程和应用生命周期钩子。

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
npm run package:codex-skin-studio
```

Skill 分发内容保持零依赖和英文 ASCII-only。主题名称和用户回复可以使用任意语言。

## 安全边界

- CDP 只绑定 `127.0.0.1`。
- 主题资源必须是主题目录内的本地文件。
- Manifest 字段经过校验，主题不能提供任意 CSS 或 JavaScript。
- 永不修改应用包和代码签名。
- 持久化使用用户级 LaunchAgent，可通过 `persist.mjs uninstall` 移除。

## 许可证

项目代码使用 [MIT License](LICENSE)。角色名称、Logo 和第三方视觉素材仍受各自权利约束，详见 [NOTICE.md](NOTICE.md)。

English guide: [README.md](README.md)
