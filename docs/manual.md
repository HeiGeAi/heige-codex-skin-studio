# 完整手册

这里是 HeiGe Codex Skin Studio 的完整工程手册：安装细节、生命周期语义、Windows 支持、命令行、主题格式和全部常见问题。日常使用看 [README](../README.md) 就够了。

## 这是什么

一个效率优先的 Codex Desktop 换肤工具。它通过本机回环 CDP 把主题实时注入 Codex 界面，不修改 `app.asar`、应用二进制或签名资源。未来 Codex Desktop 若改变启动参数、renderer 结构或界面选择器，本项目仍可能需要适配。

- **一键切换**：应用皮肤后 Codex 顶部中间出现 🎨 菜单，所有已装主题和原生界面即点即换。预设主题会同步切换 Codex 自身的浅色或深色外观，不再需要进入设置手动搭配。嫌按钮碍眼？菜单底部「隐藏此按钮」把它收成一颗半透明小圆点，点圆点即恢复。
- **自定义上传**：菜单里选「＋ 自定义图片」直接上传本地图片，自动按图片风格取色（主色、辅色、面板底色、文字色），并根据图片亮度同步 Codex 深浅外观。它只是单个本地快捷槽，适合快速试色；再次上传会覆盖，行尾 × 可删除。它不是可分发的正式主题，也不改写最近正式主题；renderer 本地存储可在自动补针或常驻启动时继续显示它，清除本地数据后会丢失。需要分发或长期管理时，用 `customize.command` 或 `create` 生成正式主题。
- **一张图片就是一个主题**：任意 PNG、JPG、JPEG、WebP 直接生成皮肤（配色 + 背景底图）。
- **AI 生成主题**：把 Skill 交给 Codex，让它先用生图能力产出主图，再自动做成皮肤，无需额外 API Key。
- **自带可选 Pet**：安装包内附独立的 `Miku Future` 动画桌面宠物，包含待机、奔跑、挥手、跳跃、等待、审查等动作，不覆盖 Codex 内置宠物，也不会在只安装皮肤时强制启用。
- **生命周期分离**：`pause` 只暂停当前会话，`resume` 恢复当前会话；`restore` 关闭常驻，活跃皮肤会话才重启为原生界面，已关闭或已原生时不额外拉起。
- **用户决定是否常驻**：顶部菜单「皮肤常驻」开关是唯一受支持的开启常驻入口。关闭后本次继续使用；下次启动恢复原生界面。想再次常驻时，先打开「HeiGe 皮肤启动器」恢复当前会话，再在顶部菜单显式打开常驻开关。
- **阅读增强默认开启**：最终回复和过程回复都使用当前主题的面板色形成 90％ 半透明阅读底，并保留对称留白。不在长对话区启用实时模糊、阴影、观察器或滚动监听。主题中心可随时关闭，选择会保存在 renderer 本地并同步到其他窗口，不改变皮肤常驻状态。

| 项目 | 参数 |
|---|---|
| 适用应用 | OpenAI Codex Desktop（ChatGPT 桌面端） |
| 支持平台 | macOS 自动化与真机验证；Windows 跨 PowerShell 自动化，Microsoft Store/MSIX 真机待验证 |
| 注入方式 | Chrome DevTools Protocol，调试端口仅绑定本机回环 `127.0.0.1:9341` |
| 内置主题 | 13 个（1 个高精度 Miku 488137 + 8 个游戏轻量主题 + 2 个龙珠主题 + 1 个财神浅色可读版 + 1 个彩蛋「大佬 · 点烟」） |
| 运行时依赖 | 不安装 npm 运行时依赖；优先使用可信的 Codex 内置 Node，使用系统 Node 时要求 Node.js 22 或更新版本 |
| 开发依赖 | `happy-dom` 与 `yazl` 均锁定精确版本，只用于测试与确定性打包 |
| 自动化验证 | Node、macOS、Windows、安装包与文档门禁，不在文档中写死易过期的测试数量 |
| 协议 | 代码 MIT，角色素材权利归各自权利人 |
| 最近更新 | 2026-07-21 |

## 版本与更新检查

主题中心会显示当前 Skin Studio 版本。只有用户主动点击「检查更新」时，控制器才会访问项目的 GitHub 最新正式 Release；发现新版后可一键复制完整更新指令，粘贴到 Codex 对话中执行。检查功能不会后台联网，也不会自行下载、覆盖文件或重启 Codex。

## macOS 安装与日常操作

macOS 安装需要已安装的 Codex Desktop。下载本仓库后：

```bash
open "<仓库路径>/scripts/install.command"
```

安装脚本会把工具放到 `~/.codex/heige-codex-skin-studio`，并默认应用 Miku 预设。应用皮肤时 Codex 会被正常退出并以本机调试模式重新打开，当前任务请先保存。

之后的日常切换都在 Codex 顶部中间的 🎨 菜单里完成。想用自己的图片做皮肤：

```bash
open "$HOME/.codex/heige-codex-skin-studio/scripts/customize.command"
```

想安装随包附带的 `Miku Future` Pet：

```bash
open "$HOME/.codex/heige-codex-skin-studio/scripts/install-pet.command"
```

安装 Pet 后，完全退出并重新打开 Codex，再到「设置 → 宠物」选择 `Miku Future`。

只暂停当前会话：

```bash
open "$HOME/.codex/heige-codex-skin-studio/scripts/pause.command"
```

恢复当前会话：

```bash
open "$HOME/.codex/heige-codex-skin-studio/scripts/resume.command"
```

彻底关闭常驻并恢复原生状态。Codex 已关闭时保持关闭，已是原生状态时不额外拉起：

```bash
open "$HOME/.codex/heige-codex-skin-studio/scripts/restore.command"
```

`apply.command` 只应用本次会话，不会暗中打开下次启动常驻。
安装生成的本地「HeiGe 皮肤启动器」调用的就是这个入口：它会恢复 `lastNonNativeThemeId` 记录的最近非原生主题，但保持常驻选择不变。

Codex 长时间运行后偶发合成器卡死：整窗帧率骤降到约 10 帧，输入和滚动全局迟滞，连新开的空白窗口也一样，与皮肤无关，只有冷重启能恢复。健康会话下 `apply.command` 是幂等的，不会重启进程，此时用 `--restart` 先彻底退出 Codex 再拉起注入：

```bash
"$HOME/.codex/heige-codex-skin-studio/scripts/apply.command" --restart
```

`--restart` 可与主题参数连用（`apply.command --restart theme-id`），同样只应用本次会话，不改变常驻选择；Codex 未运行时等同于普通 apply。退出步骤走正常退出并校验进程身份，绝不强杀，30 秒内未退出会明确报错。

## 常驻开关与恢复（macOS）

只能在 Codex 顶部菜单打开「皮肤常驻」开关。打开后，当前用户的 LaunchAgent 运行统一控制器，负责状态恢复、目标识别和漂移修复。关闭开关时会先确认，并明确提醒：关闭后本次继续使用；下次启动恢复原生界面。关闭命令：

```bash
"$HOME/.codex/heige-codex-skin-studio/scripts/lib/run-cli.zsh" set-persistence false --port 9341
```

关闭后若想只在当前会话再次拉起最近的皮肤，可打开安装时生成的本地应用：

```bash
open "$HOME/Applications/HeiGe 皮肤启动器.app"
```

这个本地应用只调用稳定的 `apply.command`，不会下载代码、请求管理员权限或将 `persistenceEnabled` 改为 `true`。「启用 HeiGe 皮肤」表示恢复当前会话。`enable-skin.command` 是只恢复当前会话的兼容名，常驻选择保持不变。`enable-persist.command` 是弃用的非零退出入口，不再执行任何启用动作。

## Windows（待实机验收）

Windows 入口位于 `scripts\windows`。安装只写当前用户目录，并创建「HeiGe Codex Skin Studio\HeiGe 皮肤启动器」开始菜单快捷方式；`apply.bat` 和兼容名 `enable-skin.bat` 都只作用于当前会话，`pause.bat`、`resume.bat` 与 `restore.bat` 分别暂停、恢复和彻底还原；`close-codex.bat` 只安全完整退出已归属的 Codex/GPT 桌面进程并保持关闭，不改常驻、不自动 apply、不自动重启。若要下次启动仍恢复皮肤，必须在已恢复的 Codex 中手动打开顶部常驻开关；常驻开启后，用户正常重启 Codex（不带调试端口）时，当前用户计划任务中的后台控制器会把它安全退出并以 CDP 重新拉起再注入皮肤。系统 Node 必须为 Node.js 22 或更新版本。

常驻开启成功的标准：开关数秒内变为「已开启」、`%APPDATA%\HeiGeCodexSkinStudio\state.json` 中 `persistenceEnabled` 为 `true`，且任务计划程序里存在 HeiGe 控制器任务。若开关立刻报错或仍为关闭，查看同目录 `injector.log` 中的 `BACKGROUND_START_FAILED` / `LOCK_MALFORMED`；不要长时间停在「正在等待后台确认」。Microsoft Store 版若无法打开调试端口 9341（`abort-incompatible`），常驻重启接管无法完成，需用独立安装版或先走 `close-codex` 后再用启动器恢复。

彻底卸载请双击稳定安装目录内的 `scripts\windows\uninstall.bat`，或从 PowerShell 运行：

```powershell
& "$HOME\.codex\heige-codex-skin-studio\scripts\windows\uninstall.ps1"
```

卸载器会先尽力关闭常驻和当前会话皮肤，再注销当前用户计划任务、移除开始菜单快捷方式、结束残留控制器进程，并删除 `%APPDATA%\HeiGeCodexSkinStudio` 与 `$HOME\.codex\heige-codex-skin-studio`。从稳定安装目录内启动时，安装树会在卸载窗口退出后延迟删除。若已手动删除稳定安装目录，可从源码仓库运行 `scripts\windows\uninstall.bat`，它仍会清理计划任务、开始菜单和 AppData 残留。计划任务指向的安装树只缺少 `src\cli.mjs` 时，控制器也会自行注销并正常退出，避免每次登录重复报错。

传统安装与任务计划程序行为由 Windows PowerShell 5.1、PowerShell 7、32 位解析和隔离的 GUID 任务测试覆盖。Microsoft Store/MSIX 的包发现与激活代码已实现，但真实 Store 应用能否完整接收 CDP 参数仍标记为真机待验证，不能把自动化结果冒充真机结论。

## 交给 Codex 使用

把 `output/heige-codex-skin-studio.skill` 交给 Codex，可以直接说：

> 用这张图片给 Codex 做一个皮肤并应用。

或者：

> 先生成一张蓝紫色赛博城市主图，再把它做成 Codex 皮肤。

Skill 会优先调用 Codex 当前可用的图片生成能力产出主图，然后调用本地确定性工具创建并应用主题。换肤本身不需要额外 API Key。现成的生图提示词见[主题提示词库](theme-prompts.md)。

## 极简主题格式

```json
{
  "schemaVersion": 1,
  "id": "my-skin",
  "name": "My Skin",
  "hero": "hero.webp",
  "appearance": "dark",
  "previewFocus": { "x": 50, "y": 24 },
  "thumbnailFocus": { "x": 50, "y": 50 },
  "thumbnailZoom": 100,
  "colors": {
    "accent": "#24C9D7",
    "secondary": "#EF8FD3",
    "surface": "#F7FBFF",
    "text": "#17344F"
  },
  "copy": {
    "brand": "My Codex",
    "headline": "今天构建什么？"
  }
}
```

只有 `schemaVersion`、`id`、`name` 和 `hero` 必填。图片必须位于主题目录内，颜色、文案、`appearance`、`previewFocus`、`thumbnailFocus` 和 `thumbnailZoom` 都可省略；`appearance` 可设为 `light`、`dark` 或 `system`。`previewFocus` 的 `x`、`y` 使用 0 到 100 的整数，只控制主题中心大横幅。`thumbnailFocus` 使用相同坐标范围，控制主题小卡片和顶部圆形入口。`thumbnailZoom` 使用 100 到 400 的整数，只放大这两种小缩略图，默认 100。三项都不改变 Codex 全屏背景构图。

## 命令行

下面的 Node CLI 主要用于源码开发与诊断。macOS 生命周期操作优先使用 `scripts` 下对应的 `.command` 稳定入口。Windows 必须使用 `scripts/windows/apply.ps1` 或 `scripts/windows/apply.bat`、`scripts/windows/enable-skin.ps1` 或 `scripts/windows/enable-skin.bat`、`scripts/windows/pause.ps1`、`scripts/windows/resume.ps1`、`scripts/windows/restore.ps1` 或 `scripts/windows/restore.bat`、`scripts/windows/close-codex.ps1` 或 `scripts/windows/close-codex.bat`；彻底卸载使用 `scripts/windows/uninstall.ps1` 或 `scripts/windows/uninstall.bat`。这些入口负责 Windows Store/MSIX 激活、进程重启和当前用户残留清理。直接运行 Node CLI 遇到需要启动或重启 Codex 的场景会安全拒绝，不会生成 macOS 生命周期动作。

```bash
node src/cli.mjs list
node src/cli.mjs create --image "/absolute/path/hero.webp" --name "My Skin"
node src/cli.mjs apply --theme my-skin-id
node src/cli.mjs enable-skin --theme my-skin-id # 兼容名，只恢复当前会话
node src/cli.mjs set-persistence false
node src/cli.mjs status
node src/cli.mjs pause
node src/cli.mjs resume
node src/cli.mjs restore
node src/cli.mjs doctor
```

## 常见问题

### 换肤会弄坏 Codex 或破坏签名吗？

本工具本身不修改 `app.asar`、二进制或签名资源。皮肤通过 [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) 在运行时注入；选择关闭常驻后，本次会话仍保留皮肤，下次正常启动回到官方原生界面。

### 支持 Windows 吗？

支持传统安装，并实现了 Microsoft Store/MSIX 的确定性发现与系统激活路径。Windows 自动化覆盖 Windows PowerShell 5.1、PowerShell 7、32 位解析与隔离任务，但 Microsoft Store 真机待验证。商店版和使用系统运行时的安装要求 Node.js 22 或更新版本。不要使用内置 Administrator 账户启动 Store 应用。

### 装完 ChatGPT 桌面端提示「Windows 安装未完成」怎么办？

这是 ChatGPT 应用自身的初始化步骤（需要一次性管理员权限），和本工具无关，但不过这一步就用不上皮肤。先试用户实测有效的修法：删除用户目录下的 Codex 配置文件（路径 `C:\Users\你的用户名\.codex\config.toml`，删除前先改名成 `config.toml.bak` 备份），再重启应用。这个文件损坏或含新版本不认的配置项时，初始化会一直失败，且重装也治不了（重装不清用户目录）。仍不行再按顺序排查：弹出的用户账户控制对话框里默认高亮的是「否」，直接回车等于拒绝，要明确点「是」；别用内置 Administrator 账户，换普通管理员账户；如果系统把 UAC 整个关了（EnableLUA=0），授权弹窗永远出不来，先把用户账户控制调回默认档再重试。都不行可以点「继续受限访问」先把应用用起来再跑换肤脚本，受限模式对注入的影响未经实机验证，遇到问题开 Issue 反馈。

### 怎么用自己的图片做主题？

三条路：顶部中间的 🎨 菜单选「＋ 自定义图片」直接上传（自动按图片取色，作为本地快捷槽快速试色）；双击 `customize.command` 走图形界面；或用命令行 `node src/cli.mjs create --image 图片路径 --name 主题名`。

### 自定义图片的文字或底色有色差、看不清怎么办？

从 `5.2.1` 开始，内置主题和菜单上传的自定义图片都会自动同步 Codex 深浅外观。若图片主体亮度与背景差异很大，自动判断仍可能不符合你的偏好，此时可在 Codex 自己的「设置 → 外观 → 主题」里手动调整。

若背景细节仍干扰 AI 回复文字，请保持主题中心的「阅读增强」开启。浅色主题会使用接近白色的 90％ 半透明底，深色主题会使用深色半透明底；最终回复和过程回复使用同一套规则。关闭后所有 AI 回复正文恢复完全透明。

![外观主题配色设置](images/appearance-theme-contrast.jpg)

*Codex 设置 → 外观：自动联动不符合预期时，可在这里手动切换系统／浅色／深色。*

同一页下方的「深色主题」区还能改强调色、背景、前景和对比度，可以进一步微调。

### Codex 更新版本后主题还能用吗？

多数只更新内容的版本不需要重新打补丁，因为本项目不修改安装包。但 CDP 启动参数、renderer 分类和界面选择器仍属于兼容边界；未来 Codex Desktop 变化时可能需要更新本项目。若升级后失败，请先运行 `doctor` 并在 Issue 中附上脱敏结果。

### 提示「端口未就绪」「无法注入」怎么办？

九成是旧实例没退干净：Codex 有任务在跑时退出会弹确认框，老实例还活着，新实例的调试参数会被它接管丢弃。手动完全退出 Codex（Cmd+Q 并确认，活动监视器里确认没有 ChatGPT 进程）再重跑脚本即可。如果报错说「已带调试参数启动但端口未开放」，说明你的 Codex 版本可能禁用了本机调试端口，请开 Issue 附上版本号，我们会跟进启动兼容方案。

### 怎么让皮肤重启后也一直在？

只能在顶部菜单打开常驻开关。关闭开关会先确认，并提示「关闭后本次继续使用；下次启动恢复原生界面」。以后先打开「HeiGe 皮肤启动器」恢复当前会话，再由用户打开顶部菜单常驻开关，才会恢复下次启动常驻。

### 本机回环端口是否等于安全？

不等于。CDP 只绑定 `127.0.0.1`，可以减少网络暴露，但 CDP 本身无认证；本机同权限进程仍可能访问调试端口并调用 `Runtime.evaluate`。菜单控制接口另有 token、严格 schema 与 revision 校验，但它不能给 CDP 增加浏览器级隔离。完整边界见 [SECURITY.md](../SECURITY.md)。

## 设计边界

这是一个本机工具，不是安全沙箱。控制器只修复被严格分类为 Codex 主 renderer 的目标，并对图片、manifest、菜单数据和日志设置上限。macOS 验证日期与证据见 `docs/release`；Windows 自动化证据与 Microsoft Store 真机待验证状态分开记录。

本仓库前身走 ASAR 修改路线，当前实现已改为 CDP。远程 `v4.0.0` 与 `v5-asar-legacy` 在 2026-07-16 仍指向同一 commit，因此不能把后者当成已经核实的独立遗留快照；远程处置建议见 [审计加固处置报告](release/2026-07-16-audit-hardening-disposition.md)。

## 开发

```bash
npm test
npm run doctor
```

改动 `README.md` 或 `llms.txt` 后，跑 `node scripts/sync-llms.mjs` 重新生成 `llms-full.txt`，否则文档门禁测试会失败。新增图片素材必须在 `ASSET_PROVENANCE.md` 登记来源，`npm test` 里的 provenance 检查会逐文件核对。
