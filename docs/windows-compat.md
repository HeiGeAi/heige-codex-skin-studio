# Windows 兼容状态与自助排查

适用版本：5.5.18 及以后。macOS 的情况见 [README](../README.md) 与[完整手册](manual.md)。

## 1. 支持状态

「自动化验证」指 CI 的 `windows-2025` 任务在 Windows PowerShell 5.1 与 PowerShell 7 下双跑通过，不等于真机人工验证。Microsoft Store / MSIX 版（下称商店版）的包发现、系统激活、回环隔离诊断和一次性回环豁免都已实现，但还没有维护者的真机验证记录，所以下表如实标为「未验证」。

| 功能 | 入口脚本 | 官方独立版 | 商店版 |
|---|---|---|---|
| 应用皮肤 | `scripts\windows\apply.bat` / `apply.ps1` | 自动化验证 | 未验证 |
| 皮肤常驻（登录后自动恢复） | 主题中心「皮肤常驻」开关，后台由 `controller.ps1` 与登录计划任务接管 | 自动化验证 | 未验证；商店版若屏蔽调试端口则后台无法接管 |
| 一键还原 | `scripts\windows\restore.bat` / `restore.ps1` | 自动化验证 | 未验证 |
| 完全卸载 | `scripts\windows\uninstall.bat` | 自动化验证 | 未验证 |

几条容易踩的前提：

- 所有 `.bat` 入口固定调用系统自带的 Windows PowerShell 5.1，登录计划任务也一样。想用 PowerShell 7，直接运行对应的 `.ps1`。
- 官方独立版优先使用 Codex 自带的 Node；商店版没有可用的内置 Node，需要系统装有 Node.js 22 或更新版本。
- 不要用内置 Administrator 账户运行商店版应用，Windows 默认禁止这个账户启动商店应用。
- 商店版第一次使用如果提示回环隔离，运行一次 `scripts\windows\enable-loopback.bat`（只需要一次管理员授权），之后再 apply。

## 2. 已知问题

| 现象 | 你会看到的提示 | 原因 | 修复版本 | 你该做什么 |
|---|---|---|---|---|
| 商店版找不到 Codex | 「未找到可信的 Windows Store 包。」（旧版本提示「未找到 Codex Desktop」） | 早期版本只探测传统安装路径 | 5.5.3 起支持商店包发现与系统激活 | 升级到最新版重试；仍失败按第 3 节附 doctor 输出提 issue |
| 商店版重启后没带调试参数，apply 退出码 1 | 「商店版激活未把调试参数写入主进程命令行」 | 商店版 AUMID 激活丢掉了调试参数 | 5.5.3 起自动改用已验证的包内可执行文件重启 | 彻底退出 Codex（任务管理器里确认没有 ChatGPT / Codex 进程）后重跑 apply；仍失败改装官方独立版，或附 doctor 输出提 issue |
| `LOCK_PERMISSIONS` / icacls 报错 1332 | 「Windows owner ACL is not private」或 icacls 1332 | 旧版回退路径把不带 `*` 前缀的 SID 传给 `icacls /setowner`；提权会话与计划任务权限级别冲突也会触发 | 5.4.5 修权限级别冲突；5.5.3 修 icacls 参数；5.5.18 起已私有的状态目录只做只读验证，不再每次重写 | 升级到最新版重跑；如果提示 `LOCK_ACL_UNTRUSTED`，删除 `%APPDATA%\HeiGeCodexSkinStudio` 后重新安装（会清掉本机主题偏好）。不要手动改 `WindowsApps` 目录的权限 |
| `LOCK_STAGING_WRITE_FAILED` | 「could not create Windows owner staging」 | 状态目录的临时锁目录创建或加权限失败 | 与上一行同一组 ACL 修复相关，建议先升级 | 关掉所有 HeiGe 相关窗口后重跑 apply；反复出现时删除 `%APPDATA%\HeiGeCodexSkinStudio` 后重新安装 |
| 皮肤常驻一直「正在等待后台确认」 | 「后台控制器未确认，请重试」 | 后台控制器没有在时限内确认皮肤生效 | 5.4.5 修复常驻检查占用调试端口导致的卡住 | 重试一次（apply 会自动重试一次）；仍失败查看 `%APPDATA%\HeiGeCodexSkinStudio\injector.log` 里有没有 `BACKGROUND_START_FAILED` 或 `LOCK_MALFORMED`，附在 issue 里 |
| 开启常驻后登录不恢复，计划任务立即退出 | 「未找到 Node.js 运行时。请安装 Node.js 22 或更高版本。」 | 计划任务启动时找不到 Node | 见 [CHANGELOG](../CHANGELOG.md) | 安装 Node.js 22 或更新版本（或改用官方独立版 Codex），然后关掉再打开一次「皮肤常驻」 |
| 更新 Codex 后背景变白或消失 | 皮肤配色还在，背景图不见了 | Codex 改了内部界面结构，皮肤依赖的锚点失配 | 按版本逐个适配 | 在 PowerShell 里运行 `scripts\windows\compat-canary.ps1` 做 [compat 巡检](compat-canary.md)，把输出附在 issue 里 |

## 3. 自助排查三步

**第一步：跑 doctor。** Windows 没有单独的 doctor 脚本，它是 Node 命令行的子命令。在 PowerShell 里运行：

```powershell
node "$HOME\.codex\heige-codex-skin-studio\src\cli.mjs" doctor
```

也可以直接重跑 `apply.bat`，apply 开头会自动做同样的自检并打印「自检结果」。

**第二步：看 `diagnosis` 这一行。** doctor 输出一段 JSON，先看 `diagnosis`，冒号前的英文就是下表的取值：

| diagnosis | 含义 | 下一步 |
|---|---|---|
| `ok` | 调试端口开放，可以注入 | 直接 apply |
| `loopback-isolated` | 商店版回环隔离 | 运行一次 `enable-loopback.bat` 后重试 |
| `running-no-flag` | Codex 在运行但没带调试参数，多半是旧实例 | 完全退出 Codex 后重跑 apply |
| `running-flag-not-observable` | 进程在运行，但调试参数不在命令行里可见，端口也没开 | 完全退出 Codex 后重跑 apply |
| `flag-present-port-closed` | 进程带了调试参数但端口没开，可能是新版 Codex 禁用了调试端口 | 直接提 issue |
| `not-running` | Codex 没在运行 | 运行 apply 拉起 |

辅助字段：`appFound`（找没找到 Codex）、`processHasDebugFlag`（进程是否带调试参数）、`portOpen`（端口是否开放），商店版还有 `loopbackExempt` 和 `loopbackIsolated`。

**第三步：该提 issue 的情况。** `diagnosis` 是 `flag-present-port-closed`；商店版做完回环豁免后端口仍不可达；或者按第 2 节操作后问题仍然复现。

## 4. 提 issue 前的检查清单

1. 完全退出 Codex，任务管理器里确认没有残留的 ChatGPT / Codex 进程，再重跑一次。
2. Skin Studio 已升级到最新版本（主题中心底部显示版本号）。
3. 商店版已运行过一次 `enable-loopback.bat`。
4. 使用系统 Node 时，版本是 Node.js 22 或更新。
5. 没有用内置 Administrator 账户运行商店版。
6. 准备好这几项再[提 issue](https://github.com/HeiGeAi/heige-codex-skin-studio/issues/new/choose)：安装方式（官方独立版或商店版）、Codex 版本号、Skin Studio 版本号、复现步骤，以及去掉用户名等隐私信息后的 doctor 输出。
