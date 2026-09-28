# Codex DOM 兼容巡检

Codex Desktop 更新可能改变内部 DOM（页面元素结构）和 CSS 选择器（定位元素的规则）。例如旧 `.main-surface` 失配后，原生白底可能盖住皮肤背景。`compat` 会在已开启调试端口的主窗口逐项计数，帮助在用户反馈前发现变化。

## 何时运行

升级 Codex 后、发布皮肤适配前，或发现背景消失、侧栏和气泡配色异常时运行。请先展开侧栏，打开一个已有用户消息和已完成助手回复的对话，让输入框可见。多个主窗口会逐个检查，任一窗口缺失即整体未通过。

这是手动、只读巡检。它复用现有 CDP（Chromium 调试协议）客户端，不启动或重启 Codex，不注入皮肤，不改 DOM、常驻设置或应用文件。调试端口须事先由现有启动流程开启。当前仅支持 Codex，默认端口为 9341。

## 运行方式

在项目或已安装的 Skin Studio 目录运行（Node.js 22 或更高版本）：

```sh
node src/cli.mjs compat
node src/cli.mjs compat --port 9341 --json
```

macOS 可双击入口，也可在终端保存 JSON：

```sh
./scripts/compat-canary.command
./scripts/compat-canary.command --port 9341 --json > compat-report.json
```

Windows 使用 PowerShell：

```powershell
.\scripts\windows\compat-canary.ps1
.\scripts\windows\compat-canary.ps1 -Port 9341 -Json > compat-report.json
$LASTEXITCODE
```

两个入口均支持环境变量 `HEIGE_CODEX_SKIN_PORT`，显式端口优先。本次 Windows 入口只完成静态检查，未在 Windows 实机运行；PowerShell 5.1 与 7 仍需 Windows CI 验证。

## 输出怎么看

默认文本用 ✅ 标记命中、❌ 标记缺失或检查失败、⚠️ 标记限制。JSON 包含 `schemaVersion`、`timestamp`（UTC）、`codexVersion`、`versionSource`、`port`、`ok`、`warnings` 和 `targets`。每个窗口给出 `id`、`ok`、`anchors`，检查失败时另有 `error`。

每项锚点包含 `id`、`selectors`、`description`、`impact`、`candidates`（逐候选计数）、`count`（候选命中元素去重后的总数）和 `ok`。主内容区的新旧选择器属于同一项，任一命中就通过，不要求新旧类名同时存在。

| 锚点 id | 检查内容 |
| :--- | :--- |
| electron-root | 桌面窗口主题根节点 |
| app-root | 背景根节点 |
| left-panel | 左侧栏 |
| main-surface | 主内容区，兼容三种选择器 |
| composer | 输入框外层表面 |
| user-bubble | 用户消息气泡 |
| assistant-response | 助手回复区域，两种候选 |

退出码为 0 表示所有主窗口全部锚点命中；非零表示锚点缺失、连接失败、无主窗口或其他检查错误。未开启端口时不会自动启动应用。版本读取失败会返回 `codexVersion: null` 并提示补充，不单独导致失败。

版本来自安装元数据：macOS 复用 doctor 的 `CFBundleShortVersionString` 读取方式；Windows 优先读取所选 MSIX 包标识中的版本，传统安装读取可执行文件的 ProductVersion。不会拿 Chromium/Electron 版本冒充 Codex 版本。安装元数据在更新后尚未重启或存在多个安装时可能与正在运行的版本不同，请同时核对关于页。

缺失并不一定是 DOM 改版：空白会话、侧栏折叠、内容尚未加载或消息被虚拟列表卸载，都可能导致计数为 0。先切换到上述检查场景再跑一次。全部命中也只代表选择器仍有效，不能证明背景图片、CSS 优先级、透明度和最终视觉效果正常。

## 缺失时怎样提 issue

1. 记录 Codex 关于页版本、Skin Studio 版本、平台，以及更新前后发生了什么。
2. 准备检查场景后重跑，将 JSON 贴入 Bug 模板的可选「compat 巡检输出」字段。
3. 附上缺失的锚点 id、预期效果、实际效果，以及脱敏后的截图和 doctor 输出。
4. 如果仅某个页面缺失，写明页面类型和侧栏状态，便于区分页面状态与选择器改名。

巡检只采集选择器计数，不读取对话正文或输入内容。提交前仍请检查错误信息、窗口 id 等字段，去掉不想公开的信息。

维护者更新锚点时，应同步真实皮肤选择器。测试会要求清单中每个选择器都出现在生成的皮肤 CSS 或菜单源码中，防止添加一个实现没有使用的宽泛兜底而产生虚假通过。
