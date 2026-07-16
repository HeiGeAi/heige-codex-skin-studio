# HeiGe Codex Skin Studio 审计加固与用户可控常驻设计

日期：2026-07-16

状态：待用户复核

目标分支：`codex/audit-hardening`

基线提交：`79b03dc`

## 一、文档地位

本设计用于完成第二轮全面审计后的发布加固，并加入用户确认的「皮肤常驻」开关。

它取代旧设计中以下已经失效的决策：

1. 「首发只支持 macOS」。当前仓库已经公开宣称支持 Windows，本轮必须让入口、测试和文档与该承诺一致。
2. 「pause 只移除当前样式」。在常驻模式下，这会被看门狗立刻覆盖，必须改成有明确状态的会话暂停。
3. 「普通重启一定回到原生界面」。是否在重启后恢复皮肤，改由用户菜单开关决定。
4. 「CDP 路线不需要随 Codex 升级适配」。目标 URL、页面结构、启动参数和运行时路径仍需持续验证。

本设计不把现有 72 项测试通过视为发布证明。发布候选需要同时通过 Node、浏览器运行态、macOS launchd、Windows PowerShell、打包和真机证据门禁。

## 二、目标

本轮交付应同时实现以下结果：

1. 修复审计确认的运行时、并发、注入生命周期、多窗口、Windows 和打包问题。
2. 在顶部 🎨 菜单内加入「皮肤常驻」开关，把重启后的界面选择权交给用户。
3. 关闭常驻后，本次皮肤继续使用；下次启动进入完全原生状态，不保留皮肤、菜单、后台控制器或 CDP 调试端口。
4. 为完全原生状态提供无需记命令的一键重新启用入口。
5. 发布包包含完整许可、安全说明和可复核的确定性构建结果。
6. 所有成功与失败都必须来自真实状态，不允许假成功、吞错或把 mock 结果写成真机结论。

## 三、非目标与授权边界

本轮不执行以下动作：

1. 不改写 Git 历史，不清理历史 pack 中的大文件。
2. 不删除、移动或重写现有远端 tag。
3. 不自动合并 main。
4. 不自动发布 GitHub Release。
5. 不自动修改 GitHub 分支保护、漏洞告警和代码扫描设置。
6. 不把 Windows CI 或 mock 结果描述成 Microsoft Store 真机验证。
7. 不用 NOTICE 代替素材授权，不声称角色和图片版权问题已经解决。
8. 不引入云服务、账号系统、遥测或第三方 API Key。
9. 不制作需要长期签名和分发维护的独立原生托盘应用。

远端设置、历史 tag、Release 和素材替换在代码与证据矩阵完成后单独确认。

## 四、用户体验

### 4.1 菜单开关

顶部 🎨 菜单增加一行标准开关：

```text
皮肤常驻                                      开／关
关闭后本次继续使用；下次启动恢复原生界面。
重新启用：打开「HeiGe 皮肤启动器」，或在 Codex 中说「启用 HeiGe 皮肤」。
```

交互要求：

1. 开关使用 `role="switch"` 和 `aria-checked`，支持鼠标、Enter 和 Space。
2. 开关状态与当前主题选择分开保存。
3. 开启时，当前选择会在 renderer 重载和 Codex 重启后恢复。
4. 关闭时，不立即移除本次皮肤，也不强制重启 Codex。
5. 用户仍可在本次会话内切换主题，或者在退出前重新打开常驻。
6. 「原生界面」是当前外观选择；「皮肤常驻」是下次启动策略。两者不得混成一个状态。

### 4.2 关闭提醒

用户把开关从开切到关时，菜单先显示确认卡：

```text
下次启动将恢复原生界面

本次皮肤会继续使用。退出后，皮肤、顶部菜单和后台控制器都会停止。
以后可打开「HeiGe 皮肤启动器」，或在 Codex 中说「启用 HeiGe 皮肤」。

[取消]  [确认关闭]
```

只有后台控制器返回成功确认后，开关才显示为关闭，并显示一次结果提醒：

```text
常驻已关闭。本次继续使用，下次启动恢复原生界面。
重新启用：打开「HeiGe 皮肤启动器」，或在 Codex 中说「启用 HeiGe 皮肤」。
```

如果后台没有确认，UI 必须恢复为开启，并显示真实错误。不能先把开关画成关闭，再等待后台碰运气同步。

### 4.3 重新启用

完全原生状态提供三条入口：

1. macOS 主入口：用户级应用 `/Users/<user>/Applications/HeiGe 皮肤启动器.app`。它在本机安装过程中生成，只调用稳定安装目录里的启用脚本。
2. Windows 主入口：开始菜单中的「HeiGe Codex Skin Studio／启用皮肤」快捷方式。
3. Codex 自然语言入口：用户在原生 Codex 中说「启用 HeiGe 皮肤」。已安装 Skill 调用脱离当前会话的启用助手，并在重启前给出明确提示。

命令行脚本保留为排障兜底，不作为普通用户唯一入口。

重新启用流程必须先校验应用路径、Node、主题、端口和状态，再安装用户级后台任务，最后正常退出并带 loopback CDP 重新打开 Codex。恢复上次有效主题；上次主题不存在时回退到默认主题并说明原因。

### 4.4 默认值与升级迁移

1. 新安装默认关闭皮肤常驻。安装完成后的当前会话可以使用皮肤和开关；用户不打开常驻就退出时，下次完全原生。
2. 旧版已经启用 LaunchAgent 且有有效主题记录的用户迁移为开启，避免升级后静默失去既有行为。
3. 旧版未启用常驻的用户迁移为关闭。
4. 迁移只在新状态不存在时执行一次，之后以用户选择为准。

## 五、状态模型

### 5.1 持久状态

状态文件使用版本化 JSON 和原子替换，至少包含：

```json
{
  "schemaVersion": 2,
  "persistenceEnabled": false,
  "selectedThemeId": "miku-488137",
  "lastNonNativeThemeId": "miku-488137",
  "controlToken": "random-per-install-secret",
  "revision": 1
}
```

字段语义：

1. `persistenceEnabled` 只决定下一次启动是否恢复皮肤。
2. `selectedThemeId` 保存用户当前明确选择，原生界面使用专用常量，不伪装成主题 ID。
3. `lastNonNativeThemeId` 用于从完全原生状态重新启用时恢复上次皮肤。
4. `controlToken` 每次安装随机生成，文件权限仅当前用户可读。
5. `revision` 每次成功写入递增，供菜单确认自己收到的是对应操作结果。

状态文件损坏或权限异常时必须 fail-closed：不自动恢复皮肤，不重启 Codex，保留诊断错误。

### 5.2 会话状态

会话状态独立于持久状态：

```text
active    当前显示主题，控制器允许自愈
native    当前显示原生外观，控制器仍可运行
paused    本次进程不注入，重启后按 persistenceEnabled 决定
restoring 正在彻底停用并准备普通模式重开
error     控制器停止破坏性动作，等待人工修复
```

`pause` 不得修改用户的下次启动选择，但同一 Codex 进程内看门狗必须尊重 paused，不能在 15 秒后重新注入。

用户关闭常驻时，控制器把 `persistenceEnabled` 写成 false，但把当前已验证的 Codex 进程身份标记为 `keepUntilProcessExit`。因此：

1. 同一个进程发生 renderer 重载时仍恢复本次皮肤和菜单。
2. 不为当前进程之外的新实例重新注入。
3. 当前进程退出、崩溃或被新进程身份替换后，`keepUntilProcessExit` 失效，后台任务注销。

进程身份至少由 PID、可执行路径和启动时间共同组成，不能只凭 PID，避免 PID 复用把关闭状态带到另一个进程。

## 六、后台控制器架构

### 6.1 统一 Node 控制器

把当前一次性 zsh 看门狗职责收敛为一个可测试的跨平台 Node 控制器。平台脚本只负责注册、注销和启动：

1. macOS 使用用户级 LaunchAgent。
2. Windows 使用用户级 Scheduled Task，不请求管理员权限。
3. 控制器负责进程识别、CDP 健康检查、renderer 注入、状态同步、失败计数和当前会话结束后的清理。
4. 控制器只在常驻开启或当前菜单仍需要处理关闭确认时运行。

关闭常驻并得到确认后，控制器继续服务当前 Codex 会话，使用户可以在退出前反悔并重新打开。检测到 Codex 退出后，控制器注销自己的 LaunchAgent／Scheduled Task 并退出。

如果系统关机导致控制器来不及注销，后台任务下次被唤起时先读取 `persistenceEnabled=false`，在不启动 Codex、不打开 CDP 和不启动控制通道的前提下自我注销。

macOS 新 label 使用 `com.heige.codex-skin-controller`。升级时先验证并卸载旧的 `com.heige.codex-skin-watchdog`，删除它指向测试临时目录的 plist，再注册新控制器。自动化测试必须使用带随机后缀的 label，不得再次操作这两个真实生产 label。

### 6.2 菜单控制通道

renderer 不能直接写本机文件或调用 launchd。为保证开关真实生效，控制器在当前用户、当前受控 Codex 会话存续期间提供一个极小的本机控制通道：

1. 只绑定随机分配的 `127.0.0.1` 端口，不绑定 `0.0.0.0`、IPv6 通配或局域网地址。
2. 只实现 `POST /v1/persistence` 和必要的 CORS 预检，不提供文件、命令或任意参数执行接口。
3. 请求必须携带随机安装 token、当前 revision 和布尔目标状态。
4. 校验 Host、Origin、Content-Type、Content-Length、token 和 JSON 形状。
5. 请求体设置很小的硬上限，超时和连接数有限制。
6. 响应只有新状态、revision 和可显示错误，不返回本机路径、日志或环境变量。
7. 关闭常驻并结束当前 Codex 会话后，控制通道随控制器一起消失。

控制器把本次随机端口、token 和 revision 作为只读配置注入菜单。token 在 renderer 中只能保护控制通道免受普通网页跨站请求，不能抵抗已经取得同一 Codex renderer 或本机用户权限的代码。因为接口只能切换一个布尔状态，不允许执行命令或读文件，所以即使 token 边界失效，影响仍被限制在启停本工具。

不采用浏览器轮询本地文件，也不采用「菜单先写 localStorage，后台 15 秒后再猜」的方案。它们无法给出可靠确认，用户快速退出时会产生假关闭。

### 6.3 进程与应用解析

所有 macOS 脚本和 Node 模块使用同一个 app resolver，优先级为：

1. 明确的 `HEIGE_CODEX_APP`。
2. `/Applications/ChatGPT.app`。
3. `/Users/<user>/Applications/ChatGPT.app`。

由 app 路径派生 executable 和 bundled Node，不再在多个脚本里硬编码。

进程探测复用 doctor 已在当前真机验证的 `ps` 路径，不依赖会在当前 Codex 命令行上失败的 `pgrep -f` 正则。

Windows resolver 必须：

1. 在 32 位 PowerShell 中仍能发现 64 位 Program Files。
2. 由实际 install path 精确匹配 Store PackageFullName／InstallLocation。
3. ChatGPT 与 Codex 双包共存时不依赖枚举顺序。
4. 在使用系统 Node 时要求 Node 22 或更高版本。

### 6.4 并发与锁

所有会触碰 Codex 进程或后台注册的操作使用 fail-closed 锁：

1. 锁记录 PID、操作类型、进程启动标识、创建时间和心跳。
2. 拿不到锁时返回明确错误，不允许等待后无锁继续。
3. 只有确认持有者已死亡且启动标识不匹配时才能回收。
4. disable／restore 不得按模糊进程名强删锁。
5. 所有输入校验在关闭、重启或启动 Codex 之前完成。

## 七、注入与菜单生命周期

### 7.1 严格目标过滤

只连接已经验证的 Codex 进程暴露的预期主 renderer URL。宠物 overlay 和无关 `app://` 页面单独分类，不把任意 `app://` 都当主窗口。

主窗口全部失败时，apply、remove 和 status 必须非零失败。overlay 成功不能掩盖主窗口失败，错误结果必须保留每个 target 的 ID 和原因。

### 7.2 generation 与 dispose

每次注入创建唯一 generation：

1. 新实例显式 dispose 旧事件监听、BroadcastChannel、timer、FileReader 和异步图片任务。
2. 所有同步和异步回调都检查当前 generation。
3. 不能用复用 style 节点是否连接来代表整个实例仍然存活。
4. remove 后旧 API 不得继续写 localStorage、dataset 或样式。

### 7.3 多窗口一致性

主题选择、原生外观、菜单隐藏状态和常驻开关通过 `BroadcastChannel` 同步。storage 事件作为兼容补充，但不能依赖同文档自己触发 storage 事件。

后台健康检查逐个主窗口验证：

1. 菜单是否存在。
2. generation 是否为当前版本。
3. 当前主题是否符合状态。
4. paused／native 是否被正确尊重。

任何窗口偏离时只修复偏离窗口，不因为一个窗口失败而破坏其他健康窗口。

### 7.4 图片与资源预算

资源限制分别作用于：

1. `theme.json` 字节数和 JSON 嵌套深度。
2. 单个资源字节数。
3. 图片宽、高、总像素和纵横比。
4. 单主题资源总量。
5. 注入菜单的所有主题总量。

浏览器上传先检查文件类型和字节数，再解码并检查像素预算。所有 FileReader、Image、canvas 和 storage 异常必须在有限时间内 resolve 或 reject，并给用户可见错误。

## 八、命令语义

### 8.1 apply

验证全部输入后，启动或连接 Codex，应用指定主题，并更新当前主题。它不在用户未选择时偷偷打开下次启动常驻。

### 8.2 enable-skin

重新启用入口使用的统一命令：

1. 校验运行环境和上次主题。
2. 写入 `persistenceEnabled=true`。
3. 注册平台后台任务。
4. 通过脱离调用者生命周期的 helper 正常重启 Codex。
5. 注入菜单并恢复上次有效主题。

### 8.3 pause 与 resume

pause 只影响当前 Codex 进程，移除视觉层并写入当前进程对应的 paused 状态。resume 恢复当前主题。常驻控制器不得覆盖 paused。

### 8.4 restore

restore 是彻底恢复，不再是 pause 的别名：

1. 写入 `persistenceEnabled=false`。
2. 注销后台任务并关闭控制通道。
3. 移除所有主窗口和 overlay 中属于本工具的注入。
4. 正常关闭带调试参数的 Codex。
5. 以普通模式重新打开，确认 CDP 端口不再由 Codex 监听。

### 8.5 兼容脚本

现有 `enable-persist.command` 保留为 `enable-skin` 的兼容入口。现有 `disable-persist.command` 保留为彻底关闭后台常驻的兼容入口，并在输出中区分「当前皮肤保留」和「下次完全原生」。

Windows 提供对应 `.ps1` 和 CRLF `.bat` 入口，包内 `SKILL.md` 按平台给出真实可执行步骤。

## 九、安装器与重新启用入口

### 9.1 macOS

安装器在用户目录生成最小应用 bundle：

```text
/Users/<user>/Applications/HeiGe 皮肤启动器.app
```

该 bundle 不携带第二份引擎，只调用：

```text
/Users/<user>/.codex/heige-codex-skin-studio/scripts/enable-skin.command
```

应用 bundle 在本机生成，不下载可执行文件，不请求管理员权限。安装器验证入口存在、可执行，并输出 Finder 可见位置。

### 9.2 Windows

安装器创建当前用户开始菜单快捷方式，目标为稳定安装目录内的 `enable-skin.bat`。不写系统级 Program Files，不请求管理员权限。

### 9.3 Skill

Skill 必须识别「启用皮肤」「重新打开皮肤」「恢复 HeiGe 主题」「开启常驻」等意图。执行前提示 Codex 将正常重启；通过 detached helper 完成重启，避免 helper 随当前 Codex 进程一起被杀。

Skill 不得自行无限重试，也不得在用户只要求检查状态时修改后台任务。

## 十、Windows 交付

Windows 不再只保证文件存在。发布门禁要求：

1. `.skill` 顶层说明按平台分流，Windows 用户不会收到 `open` 或 `/Applications` 指令。
2. install、apply、pause、restore、enable-skin 和后台 Scheduled Task 都有真实 PowerShell 入口。
3. Windows PowerShell 5.1 与 PowerShell 7 的语法、JSON、多行输出、退出码、UTF-8 BOM、中文路径和空格路径自动化通过。
4. Store 双包选择有确定性单元测试。
5. Scheduled Task 的注册、禁用和状态迁移使用隔离名称测试，不碰测试机真实用户任务。
6. Microsoft Store 真启动仍标注为待 Windows 真机验收，不能由 GitHub Actions 替代。

## 十一、打包、许可与安全文档

### 11.1 确定性打包

打包命令接受显式输出路径，测试只能写临时目录。归档使用排序白名单、固定权限和 `SOURCE_DATE_EPOCH`，相同源码连续构建两次必须得到相同 SHA-256。

发布包必须包含：

1. `LICENSE`。
2. `NOTICE`。
3. `SECURITY.md`。
4. 运行所需的 src、themes、scripts、Skill 和 package metadata。

发布包不得包含：

1. `.before-*` 备份素材。
2. 审计报告和竞品比较报告。
3. 打包器自身。
4. Git 元数据、临时目录和测试产物。

### 11.2 SECURITY.md

安全文档明确说明：

1. CDP 使用 `Runtime.evaluate`，不是单纯 CSS 文件加载。
2. 常驻开启期间存在无认证的 loopback CDP 端口。
3. 菜单控制通道的用途、token 和关闭生命周期。
4. restore 如何关闭后台任务、控制通道和 CDP。
5. 项目不读取 Codex 对话、API Key、Base URL 或用户项目文件。
6. 私密漏洞报告渠道和支持版本。

素材来源与再分发授权另列清单。免责声明不作为授权证明。

## 十二、CI 与测试证据

所有行为变更遵循测试先行，每个回归测试必须先看到预期失败，再写最小实现。

### 12.1 Node 和浏览器行为

1. Node 22 和当前 Codex bundled Node 运行完整测试。
2. 使用可执行 DOM 环境验证菜单点击、键盘操作、确认卡、开关回滚和可访问性属性，不再只用正则检查生成字符串。
3. 两个 renderer 测试主题、隐藏状态和常驻状态同步。
4. generation 测试证明旧闭包和异步图片回调失效。
5. 图片字节、尺寸、像素、纵横比和 canvas 失败均有测试。

浏览器行为测试使用固定在 devDependencies 的轻量 DOM harness；运行依赖不进入 `.skill`。测试必须执行真实菜单脚本和事件，不得把新增行为重新降级成字符串正则断言。

### 12.2 macOS

1. 使用隔离 HOME、状态目录和唯一 launchd label，禁止测试覆盖真实 `com.heige.codex-skin-watchdog` 和 `com.heige.codex-skin-controller`。
2. 用真实 `ps` 命令形状验证当前 Codex 进程探测。
3. 测试锁持有者存活、死亡、心跳、超时和并发 apply／restore。
4. 测试常驻开、菜单关、当前会话反悔、退出后自注销和下次完全原生。
5. 在当前 Mac 修复被污染的 LaunchAgent 后，验证状态目录、重启和补针。

### 12.3 Windows

1. GitHub Actions `windows-latest` 运行 Windows PowerShell 5.1 和 PowerShell 7。
2. 测试普通安装、32 位宿主路径、Store 双包 mock、AUMID 参数和退出码。
3. 用隔离 Scheduled Task 名测试注册和注销。
4. Windows 真机验收结果单独记录，缺少真机时保持「待验证」。

### 12.4 发布物

1. 连续构建两次并比较 SHA-256。
2. 解包后逐项验证白名单、LICENSE、NOTICE 和 SECURITY。
3. 验证包内没有备份素材、报告和包构建脚本。
4. 测试完成后 `git status --short` 必须为空。

## 十三、错误处理

以下情况必须阻止破坏性动作并返回非零结果：

1. app、Node、主题或端口参数无效。
2. 端口由非目标进程占用。
3. 主 renderer 全部失败。
4. 状态文件损坏、token 缺失或 revision 冲突。
5. 控制请求来源、token、形状或大小不合法。
6. 拿不到有效锁。
7. 后台任务注册、注销或状态确认失败。
8. Windows Store 包选择不唯一。

通知、日志和 UI 错误不得泄露 token、完整环境变量或用户隐私路径。日志轮转保留，健康成功必须把连续失败计数清零。

## 十四、验收标准

只有满足以下条件，分支才可进入 Draft PR：

1. 当前 Mac 的真实 LaunchAgent 污染已修复，状态目录恢复正确。
2. 当前 Codex 进程能被 doctor、launcher 和控制器一致识别。
3. 用户打开常驻后，重启和 renderer 重载恢复所选皮肤。
4. 用户关闭常驻时看到明确的重新启用说明，后台确认后开关才成功。
5. 关闭后的本次会话继续使用皮肤，退出后后台任务自注销。
6. 下次启动没有皮肤、菜单、后台控制器和 CDP 端口。
7. macOS 启动器、Windows 开始菜单和 Codex 自然语言三条路径都能重新启用。
8. pause 在同一进程内保持暂停，resume 可恢复，restore 能真正回到普通启动。
9. 多窗口主题、菜单和常驻状态一致。
10. apply、remove 和 status 不产生主窗口假成功。
11. Windows `.skill` 有真实入口，PS5.1 和 PS7 自动化通过。
12. `.skill` 确定性构建，包含许可和安全文件，不含备份与报告。
13. README、`llms-full.txt`、仓库描述建议、测试数和产品能力不再互相矛盾。
14. 完整验证后工作树干净，Draft PR 清楚列出真机已验证项和待验证项。

当前被跟踪的竞品比较报告从发布源码树移除，但保留在 Git 历史中。Draft PR 另附旧 Latest Release、错误 `v5-asar-legacy` tag、Issue #1 和冲突 Draft PR #2 的建议处置清单，不自动执行远端关闭、改 tag 或发布动作。

即使全部技术验收通过，素材授权来源仍作为发布残余风险保留，不能把候选发布写成版权无风险。

## 十五、实施拆分

本设计覆盖一个发布候选，但实施必须拆成有独立测试和提交的工作流：

1. 运行时解析、状态模型、锁和当前 Mac 修复。
2. 后台控制器、菜单开关、关闭提醒和重新启用入口。
3. 注入生命周期、多窗口和资源预算。
4. Windows 入口、Scheduled Task 和 PowerShell 测试。
5. 确定性打包、许可、安全文档和 CI。
6. 最终跨模块验证、README 同步和 Draft PR。

每个工作流按 RED、GREEN、REFACTOR 推进，先通过规格符合性审查，再通过代码质量审查。任何一项真机证据缺失，都必须在 PR 中保留为待验证，不能用推断补齐。
