# v5.5.5 双产品 macOS 启动器设计规格

## 完成合同

本轮把现有 Finder 可见但无界面的 Codex 单产品启动器升级为 macOS 原生双产品启动器。用户打开「HeiGe 皮肤启动器.app」后看到 Codex 与 WorkBuddy 两张卡片，点击其中一张即可恢复该产品最近一次使用的非原生皮肤。

必须跑通的主路径：

1. v5.5.5 覆盖安装后，`~/Applications/HeiGe 皮肤启动器.app` 保留初音未来图标并可由 Finder 打开。
2. 面板读取 Codex 与 WorkBuddy 的安装状态和最近皮肤名称。
3. 点击 Codex，只调用 Codex 的 9341 注入链并恢复 Codex 最近皮肤。
4. 点击 WorkBuddy，只调用 WorkBuddy 的 9342 注入链并恢复 WorkBuddy 最近皮肤。
5. 操作期间只锁定被点击卡片，失败时原位显示可重试错误，成功时前置目标 APP 并关闭启动器。
6. 覆盖安装继续使用现有原子发布、签名校验、失败回滚和 LaunchServices 注册流程。

明确范围外：

1. 不在启动器里切换或编辑主题。
2. 不为 WorkBuddy 增加常驻服务或放宽 `file://` 控制通道安全边界。
3. 不修改 Codex 或 WorkBuddy 的 `app.asar`。
4. 不自动推送 GitHub、Tag 或 Release。

## 已冻结产品决策

界面采用 A 方案的并列双卡片。启动器不提供主题选择器，每个产品始终使用各自状态目录中的 `lastNonNativeThemeId`。Codex 保留现有会话恢复和顶部菜单常驻语义；WorkBuddy 保持一次性注入，重启后需再次点击启动器。

Codex 与 WorkBuddy 的状态、锁、日志和端口完全隔离：

| 产品 | 状态目录 | CDP 端口 | 动作 |
| --- | --- | ---: | --- |
| Codex | `~/Library/Application Support/HeiGeCodexSkinStudio` | 9341 | `launcher-apply` |
| WorkBuddy | `~/Library/Application Support/HeiGeCodexSkinStudio-workbuddy` | 9342 | `launcher-apply --app workbuddy` |

## 技术架构

启动器使用 AppKit 编写，源码随仓库保存，发布时编译为 arm64 与 x86_64 的 universal binary。安装器只复制已构建二进制，普通用户不需要 Xcode 或 Swift 工具链。最终 `.app` 继续由项目安装器临时组装并 ad hoc 签名。

原生进程从自身 `Info.plist` 读取 `HeiGeInstallRoot` 与版本号，不接受环境变量覆盖稳定运行时路径。它通过稳定安装根中的两个受控脚本读取状态和执行动作：

1. `launcher-state.command <product>` 调用 Node CLI 的 `launcher-state --app <product>`，只输出一个 JSON 对象。
2. `launch-skin.command <version> <product>` 校验产品白名单，再把两个产品都路由到版本绑定的 `launcher-apply`。WorkBuddy 继续使用自身隔离状态和一次性注入能力。

CLI 的启动器状态对象固定为：

```json
{
  "schemaVersion": 1,
  "product": "codex",
  "productName": "Codex",
  "appInstalled": true,
  "appPath": "/Applications/ChatGPT.app",
  "themeId": "miku-488137",
  "themeName": "Miku 488137",
  "mode": "session"
}
```

`appPath` 只有命中已安装 APP 时才返回真实路径，否则为 `null`。损坏或缺失的状态文件回退到默认主题；状态指向不存在主题时显示主题 ID，但动作仍由现有注入层给出权威错误，不伪造成功。

## 界面与状态机

主窗口固定为单窗口、不可多开操作，最小系统版本 macOS 13。两张卡片各自具有 `loading`、`ready`、`running`、`failed` 四种状态。

1. 打开时两卡显示读取状态，后台并行获取产品状态。
2. 未安装产品显示「未安装」并禁用按钮。
3. 点击卡片后只禁用该按钮，文案变为「正在恢复」。另一张卡片保持可见，但全局动作闸门阻止并发注入，避免两个宿主同时被生命周期操作。
4. 子进程退出码为 0 时，用 bundle id 激活已运行宿主；找不到运行实例时用已验证的 `appPath` 打开宿主。随后退出启动器。
5. 非 0 时截断并清洗 stderr，在卡片内显示错误和「重试」按钮，同时把完整错误保留在现有产品日志。
6. 「查看诊断与日志」在 Finder 中打开两个状态目录中实际存在的目录，不创建伪日志。

## 安装、归属与回滚

生成启动器 schema 从 3 升为 4。schema 4 的 `Contents/MacOS/HeiGe Skin Launcher` 是受大小限制的原生二进制，不再是 shell 文本。安装器从发布源读取二进制和图标，计算 SHA-256，写入 stage，签名后再次验证以下内容：

1. bundle 目录只包含归属文件。
2. `Info.plist` 的安装根、版本、bundle id、schema 和最低系统版本一致。
3. 二进制和图标与发布源字节完全一致。
4. 代码签名通过 `codesign --verify --deep --strict`。
5. 发布、回滚、崩溃恢复和旧 schema 3 归属识别继续有效。

## 验收证据

自动化证据包括状态模型单测、CLI 路由单测、shell 产品白名单测试、schema 4 安装与篡改拒绝测试、Swift 双架构编译和完整 `npm test`。目标环境证据包括本机覆盖安装、`codesign` 校验、`lipo -info`、LaunchServices 注册、实际打开面板，以及分别点击 Codex 与 WorkBuddy 的真实注入结果。

真实注入会改变两个 APP 当前会话外观，但不修改用户数据或开启常驻。GitHub 发布不在本轮授权内。
