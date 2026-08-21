---
name: heige-codex-skin-studio
description: Use when 用户希望在 macOS 或 Windows 安装、制作、应用、暂停、恢复或设置 HeiGe Codex Desktop 皮肤常驻，或给腾讯 CodeBuddy 桌面端（WorkBuddy）一次性换肤。
---

# HeiGe Codex Skin Studio

通过本机 CDP 注入为 Codex Desktop 换肤，不修改 `app.asar`、应用签名或二进制文件。同一引擎支持给腾讯 CodeBuddy 桌面端（WorkBuddy）一次性换肤，见「WorkBuddy 支持」一节。

## 必须遵守

1. 先确认当前是 macOS 还是 Windows，只运行对应平台的入口。
2. 安装阶段跳过自动应用，先让安装交易完整结束。
3. `status` 是只读检查。不得用 `apply`、`enable-skin` 或重启来代替状态检查。
4. 执行启用或完整恢复前，先告知用户 Codex 可能正常重启。以脚本返回的 ACK 或明确错误为准，不把「看到重启」当成成功证据。
5. 失败后不做无界重试。保留原错误与 `doctor` 输出，再决定下一步。

## 首次安装

macOS：

```bash
HEIGE_SKIP_APPLY=1 "$HOME/.agents/skills/heige-codex-skin-studio/scripts/install.command"
```

Windows PowerShell：

```powershell
& "$HOME\.agents\skills\heige-codex-skin-studio\scripts\install.ps1" -SkipApply
```

Windows 用户也可双击 `scripts\install.bat`。Windows 入口只转发到包内 `payload\scripts\windows\install.ps1`，不运行 macOS 命令。

默认稳定安装目录：

- macOS：`$HOME/.codex/heige-codex-skin-studio`
- Windows：`$HOME\.codex\heige-codex-skin-studio`

## 应用与常驻语义

- `apply`：仅应用当前会话，不改变下次启动的常驻选择。
- 顶部菜单「皮肤常驻」开关是唯一受支持的开启常驻入口。打开后下次启动继续使用；关闭后本次继续使用，下次启动恢复原生界面。
- 「启用皮肤」与「开启常驻」是两个意图。macOS 打开 `$HOME/Applications/HeiGe 皮肤启动器.app` 后，可通过固定入口打开或关闭 Codex 与 WorkBuddy 当前皮肤。关闭只暂停当前会话并保留最近主题和常驻选择；一键修复会强制干净重启已安装产品并恢复最近皮肤。
- `enable-skin` 和 `enable-skin.command` 都是 session-only `apply` 的兼容名，只恢复当前会话，常驻选择保持不变。
- 用户明确要求常驻时，先用启动器或 `apply` 恢复当前会话，再提醒用户在顶部菜单显式打开常驻开关。Agent 不得代替用户改成 `true`。
- `enable-persist.command` 是弃用的非零退出入口，不得将它当作上述步骤的替代方案。
- 启动器未显式指定主题时，优先恢复上次非原生主题，只有没有历史选择时才使用 `miku-488137`。

macOS 安装必须创建或升级带 Miku 图标的 Schema 5 原生双产品启动器，完成 universal 二进制校验、本地 ad hoc 完整性签名和 LaunchServices 注册。不得把该签名描述成 Apple Developer ID 或公证。启动器不在面板内选择主题，不为 WorkBuddy 开启常驻。打开、关闭和修复必须分别走版本绑定的 `launcher-apply`、`launcher-close`、`launcher-repair`；Codex 固定使用 9341，WorkBuddy 固定使用 9342。启动器只允许对明确的静态 `LOCK_CHAIN_CORRUPT` 做一次安全恢复：先证明相关服务、进程、锁声明和外来 CDP listener 均不活跃，严格校验状态与用户主题，整体备份旧状态根后再重建。普通锁竞争、未知内容或第二次失败必须停止。失败详情进入受限、轮转的产品日志，用户同时在原生面板看到错误。

macOS 稳定入口是 `scripts/launch-skin.command`、`scripts/close-skin.command`、`scripts/repair-skin.command`、`scripts/apply.command`、`scripts/enable-skin.command`、`scripts/pause.command`、`scripts/resume.command` 和 `scripts/restore.command`。Windows 生命周期操作必须使用 `scripts\windows` 下的同名 `.ps1` 或 `.bat`，不得直接运行 Node CLI 代替 Windows Store/MSIX 激活或进程重启。Windows 彻底卸载必须使用 `scripts\windows\uninstall.ps1` 或 `scripts\windows\uninstall.bat`；该入口会清理当前用户计划任务、开始菜单、AppData 状态、残留控制器进程和稳定安装目录。若稳定安装目录已被手动删除，从源码目录运行卸载入口清理残留。需要完整退出 Codex/GPT 桌面端时，使用 `scripts\windows\close-codex.ps1` 或 `scripts\windows\close-codex.bat`。商店版若报 AppContainer 回环隔离，仅当用户明确允许一次管理员权限时才可调用 `scripts\windows\enable-loopback.bat`；不得每次 apply 静默提权，也不得复制或改 ACL `WindowsApps`。

用户意图必须分开：

- `pause` 只移除当前会话的皮肤与菜单，不改变常驻选择。
- `resume` 只恢复同一个已验证进程中被 `pause` 暂停的皮肤，不是通用重启入口。
- `restore` 关闭常驻、注销后台控制器并恢复原生界面。Codex 已关闭时保持关闭；已是原生状态时不为了恢复而额外启动。
- `close-codex` 只安全完整退出已归属的 Codex/GPT 桌面进程并保持关闭，不改常驻、不自动 apply、不自动重启。仅当用户明确允许关闭/退出 Codex 或 GPT 桌面端时才可调用；若用户约束“不要关闭 Codex”，禁止擅自调用。
- `enable-loopback` 只给当前商店版 Codex 添加一次 CheckNetIsolation 回环豁免，便于本工具连入已绑定的本机调试端口。仅当用户明确允许一次管理员权限、且报错为回环隔离时才可调用；不得在每次 apply 时静默提权。
- `uninstall` 只用于 Windows 完整移除，不等同于 `restore`。执行前告知用户会删除稳定安装目录和本地状态；不得用 Node CLI 模拟卸载。

## 内置预设与菜单自定义

默认回退主题是 `miku-488137`。另有 `genshin-dawn`、`genshin-night`、`wuthering-tide`、`wuthering-echo`、`naruto-hokage`、`naruto-sasuke`、`deepspace-dawn`、`deepspace-star`、`dragonball-nimbus`、`dragonball-super-saiyan` 和 `dalao-dianyan`，合计 12 个内置预设。

内置预设会同步 Codex 深浅外观。顶部菜单的「＋ 自定义图片」可选择本地图片、自动压缩取色、判断画面亮度并同步 Codex 外观。菜单新上传会写入本机用户主题库，成为正式用户主题并记入启动器，「我的主题」行尾 × 可删除对应磁盘主题。只有旧版 `custom-upload` 是 renderer 本地兼容槽，新上传不再以该快捷槽作为权威存储。需要从文件或 AI 生成主题时，用 `create` 生成正式主题。

主题中心的「阅读增强」默认开启，为最终回复和过程回复增加统一的 90％ 主题自适应半透明底色与对称留白；用户可随时关闭。该偏好保存在 renderer 本地并同步到其他窗口，不改变皮肤常驻状态，不调用后台接口，也不增加模糊、阴影、观察器或滚动监听。

## 状态与诊断

macOS 只读状态：

```bash
"$HOME/.codex/heige-codex-skin-studio/scripts/lib/run-cli.zsh" status --port 9341
```

Windows 只读后台任务状态：

```powershell
& "$HOME\.codex\heige-codex-skin-studio\scripts\windows\controller.ps1" -Action status -Port 9341
```

注入异常时运行 `doctor`，保留完整 JSON，不循环调用可能触发正常重启的入口。CDP 只允许侦听 `127.0.0.1`，默认端口是 `9341`。

## 图片与主题

用户给出图片时，先验证非空 PNG、JPG、JPEG 或 WebP，再用已验证的 Node.js 22 或更高版本运行：

```text
<verified-node> "$ROOT/src/cli.mjs" create --image "<绝对路径>" --name "<主题名>"
```

从 JSON 返回中读取 `id`。设为 `$id` 后，macOS 运行：

```bash
"$ROOT/scripts/apply.command" "$id"
```

Windows PowerShell 运行：

```powershell
& "$root\scripts\windows\apply.ps1" -Theme $id -Port 9341
```

这两个入口都只应用当前会话，不暗中打开常驻。

用户只给创意描述时，先用当前可用的 `imagegen` 生成横向 UI 主图。为左侧导航和底部输入区留出可读空间，不要把按钮、菜单文字或聊天内容烘焙到图片中。

## 安装包自带的可选 Miku Future Pet

发布包内自带 `Miku Future` 动画 Pet，但皮肤安装不会自动启用。仅当用户明确要求安装 Miku Future 时才执行。macOS 优先使用统一 wrapper：

```bash
"$ROOT/scripts/install-pet.command"
```

需要直接调用 CLI 时，使用 `<verified-node> "$ROOT/src/cli.mjs" install-pet --source "$ROOT/custom-pet/miku-future"`。不因用户只要换肤而自动安装宠物。

## WorkBuddy 支持

同一个 Skill 也能给 WorkBuddy（腾讯 CodeBuddy 桌面端）换肤，入口独立，别和 Codex 的混用：

- 应用：`"$ROOT/scripts/workbuddy-apply.command" [--restart] [主题 id]`。默认端口 9342；`--restart` 先安全退出 WorkBuddy 再以调试模式拉起。
- 还原：`"$ROOT/scripts/workbuddy-restore.command"`。
- `workbuddy-enable-skin.command` 是 workbuddy-apply 的兼容名，只应用当前会话。
- Node CLI 的等价写法是加 `--app workbuddy`。
- WorkBuddy 不支持常驻：`set-persistence --app workbuddy` 会明确报错。这是刻意的安全决定（`file://` renderer 回调控制服务带 `Origin: null`，不进来源白名单），不得试图绕过来源校验或代用户改配置。重启 WorkBuddy 后皮肤消失属预期，重跑一次 workbuddy-apply 即可。
- 需要系统 Node.js 22 或更新版本。macOS 在 WorkBuddy 5.3.11 真机验证；Windows 侧未在真机验证，不得宣称已验证。

## Windows 验证边界

自动化测试要求在 `windows-latest` 上同时用 Windows PowerShell 5.1 和 PowerShell 7 验证确定性应用解析、Node.js 22 门禁、当前用户 Scheduled Task、入口语义、UTF-8 BOM、BAT CRLF，以及中文和空格路径。真实 Scheduled Task 集成测试只能使用 GUID 测试任务名，不得触碰生产任务。

Microsoft Store 真机待验证：自动化证据不证明真实 Store/MSIX 安装的 AUMID 激活、回环豁免后 HTTP CDP、或包内可执行文件回退能完成注入。已实现差分诊断与一次性 `enable-loopback` 引导，但在真机 netstat / `/json/version` 证据补齐前，不宣称该路径已完整验证。
