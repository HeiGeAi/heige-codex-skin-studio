# HeiGe Codex Skin Studio Skill

这个 Skill 支持 macOS 与 Windows，通过本机 CDP 注入完成 Codex Desktop 换肤，不修改 `app.asar`、应用签名或二进制文件。

## 安装入口

- macOS：运行 `scripts/install.command`。Agent 安装时应使用 `HEIGE_SKIP_APPLY=1`。
- Windows PowerShell：运行 `scripts\install.ps1 -SkipApply`。
- Windows 图形入口：双击 `scripts\install.bat`。

安装后，macOS 使用 `$HOME/.codex/heige-codex-skin-studio`，Windows 使用 `$HOME\.codex\heige-codex-skin-studio`。

## 用户可控的常驻

顶部菜单「皮肤常驻」开关是唯一受支持的开启常驻入口。关闭后本次继续使用；下次启动恢复原生界面。macOS 本地应用「HeiGe 皮肤启动器」只调用 `apply.command`，恢复当前会话的最近非原生主题，不会自动打开常驻。需要下次启动继续使用时，先用「HeiGe 皮肤启动器」恢复当前会话，再在顶部菜单显式打开常驻开关。

`apply` 只改变当前会话，不改变常驻选择。`enable-skin` 是 session-only `apply` 的兼容名，只恢复当前会话。`enable-persist.command` 是弃用的非零退出入口。启用与完整恢复可能让 Codex 正常重启，执行前要先告知用户。`status` 严格只读，不应启动、退出、重启或注入 Codex。

Windows 的生命周期操作必须从 `scripts\windows` 下对应的 `.ps1` 或 `.bat` 进入。不要直接运行 Node CLI 代替 Windows Store/MSIX 激活或重启流程；如果直接调用遇到需要启动或重启，CLI 会安全拒绝并提示正确入口。需要完整退出 Codex/GPT 桌面端并保持关闭时，使用 `scripts\windows\close-codex.bat`（仅在用户明确允许关闭时调用；用户说“不要关闭”时不得擅自执行）。彻底移除使用 `scripts\windows\uninstall.ps1` 或 `scripts\windows\uninstall.bat`，它会清理当前用户计划任务、开始菜单、AppData 状态、残留控制器进程和稳定安装目录；安装目录被手动删除后，也可从源码目录运行该入口清理残留。

Skill 保留 12 个内置预设，默认是 `miku-488137`。切换预设会同步 Codex 深浅外观，顶部「自定义图片」也会按画面亮度自动判断外观。自定义图片验证完成后会写入本机用户主题库并记入启动器，可上传、幂等覆盖或删除，也可在常驻启动时恢复；它不是仓库内可跨机器分发的正式主题。需要分发或版本管理时使用 `create`，再把返回的 `id` 传给 macOS 或 Windows 的 `apply` 入口。`pause` 暂停当前会话，`resume` 只恢复同一进程，`restore` 关闭常驻并还原；Windows `close-codex` 只完整退出桌面端并保持关闭；Windows `uninstall` 会完整删除安装与状态。发布包内自带可选的 `Miku Future` 动画 Pet，仅当用户明确要求时才调用统一 `install-pet` 入口。

主题中心的「阅读增强」默认开启，为最终回复和过程回复增加统一的 90％ 主题自适应半透明阅读底与对称留白；用户可随时关闭。它只使用 renderer 本地偏好和现有窗口同步，不改变常驻状态，也不增加模糊、阴影、观察器、滚动监听或后台请求。

## Windows 证据边界

自动化门禁要求在 `windows-latest` 上同时通过 Windows PowerShell 5.1 与 PowerShell 7 测试，覆盖解析、Node.js 22、当前用户 Scheduled Task、入口语义、编码和中文空格路径。真实任务集成测试只使用 GUID 测试名，不触碰生产任务。

Microsoft Store 真机待验证。自动化测试不能替代真实 Store/MSIX 安装上的 AUMID 激活与 CDP 参数传递验收。
