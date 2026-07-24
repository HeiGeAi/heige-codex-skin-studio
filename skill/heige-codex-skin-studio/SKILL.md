---
name: heige-codex-skin-studio
description: Use when 用户希望在 macOS 或 Windows 安装、制作、应用、暂停、恢复或设置 HeiGe Codex Desktop 皮肤常驻。
---

# HeiGe Codex Skin Studio

通过本机 CDP 注入为 Codex Desktop 换肤，不修改 `app.asar`、应用签名或二进制文件。

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
- 「启用皮肤」与「开启常驻」是两个意图。关闭后，macOS 打开 `$HOME/Applications/HeiGe 皮肤启动器.app` 只会调用 `apply.command`，恢复当前会话的最近非原生主题，并保持 `persistenceEnabled=false`。
- `enable-skin` 和 `enable-skin.command` 都是 session-only `apply` 的兼容名，只恢复当前会话，常驻选择保持不变。
- 用户明确要求常驻时，先用启动器或 `apply` 恢复当前会话，再提醒用户在顶部菜单显式打开常驻开关。Agent 不得代替用户改成 `true`。
- `enable-persist.command` 是弃用的非零退出入口，不得将它当作上述步骤的替代方案。
- 启动器未显式指定主题时，优先恢复上次非原生主题，只有没有历史选择时才使用 `miku-488137`。

macOS 稳定入口是 `scripts/apply.command`、`scripts/enable-skin.command`、`scripts/pause.command`、`scripts/resume.command` 和 `scripts/restore.command`。Windows 生命周期操作必须使用 `scripts\windows` 下的同名 `.ps1` 或 `.bat`，不得直接运行 Node CLI 代替 Windows Store/MSIX 激活或进程重启。Windows 彻底卸载必须使用 `scripts\windows\uninstall.ps1` 或 `scripts\windows\uninstall.bat`；该入口会清理当前用户计划任务、开始菜单、AppData 状态、残留控制器进程和稳定安装目录。若稳定安装目录已被手动删除，从源码目录运行卸载入口清理残留。需要完整退出 Codex/GPT 桌面端时，使用 `scripts\windows\close-codex.ps1` 或 `scripts\windows\close-codex.bat`。

用户意图必须分开：

- `pause` 只移除当前会话的皮肤与菜单，不改变常驻选择。
- `resume` 只恢复同一个已验证进程中被 `pause` 暂停的皮肤，不是通用重启入口。
- `restore` 关闭常驻、注销后台控制器并恢复原生界面。Codex 已关闭时保持关闭；已是原生状态时不为了恢复而额外启动。
- `close-codex` 只安全完整退出已归属的 Codex/GPT 桌面进程并保持关闭，不改常驻、不自动 apply、不自动重启。仅当用户明确允许关闭/退出 Codex 或 GPT 桌面端时才可调用；若用户约束“不要关闭 Codex”，禁止擅自调用。
- `uninstall` 只用于 Windows 完整移除，不等同于 `restore`。执行前告知用户会删除稳定安装目录和本地状态；不得用 Node CLI 模拟卸载。

## 内置预设与菜单自定义

默认回退主题是 `miku-488137`。另有 `genshin-dawn`、`genshin-night`、`wuthering-tide`、`wuthering-echo`、`naruto-hokage`、`naruto-sasuke`、`deepspace-dawn`、`deepspace-star`、`dragonball-nimbus`、`dragonball-super-saiyan`、`caishen-lite-readable` 和 `dalao-dianyan`，合计 13 个内置预设。

内置预设会同步 Codex 深浅外观。顶部菜单的「＋ 自定义图片」可选择本地图片、自动压缩取色、判断画面亮度并同步 Codex 外观。「自定义图片」只是单个本地快捷槽，再次上传会覆盖，行尾 × 可删除；它不是可分发的正式主题，也不改写最近正式主题。renderer 本地存储可在自动补针或常驻启动时继续显示它，清除本地数据后会丢失。快速试用优先用这个入口；需要分发或长期管理时，用 `create` 生成正式主题。

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

## Windows 验证边界

自动化测试要求在 `windows-latest` 上同时用 Windows PowerShell 5.1 和 PowerShell 7 验证确定性应用解析、Node.js 22 门禁、当前用户 Scheduled Task、入口语义、UTF-8 BOM、BAT CRLF，以及中文和空格路径。真实 Scheduled Task 集成测试只能使用 GUID 测试任务名，不得触碰生产任务。

Microsoft Store 真机待验证：自动化证据不证明真实 Store/MSIX 安装的 AUMID 激活能按预期传递 CDP 参数。在真机证据补齐前，不宣称该路径已完整验证。
