# macOS 启动器视觉升级设计

日期：2026-08-21

## 目标

把当前偏工程测试感的「HeiGe 皮肤启动器」升级为正式 macOS 产品界面。保留 Codex 与 WorkBuddy 双卡选择、自动恢复最近皮肤和独立端口逻辑，只重做窗口视觉、产品图标和信息层级。

## 设计方向

主题为「Miku 数字终端」。界面仍遵循 macOS 原生窗口和控件习惯，使用系统字体、原生按钮、系统语义色与真实 APP 图标。视觉大胆点只放在窗口顶部的青色到粉色细光带，以及 Miku Logo 周围的轻微光晕，不使用满屏渐变、重玻璃或持续动画。

### 色彩

- `canvas`：跟随系统的窗口背景色，保证浅色和深色模式可读。
- `surface`：系统控制背景色，作为卡片和皮肤信息区的实底。
- `mikuCyan`：`#39D7CF`，用于 Codex 卡片强调、顶部光带和安全状态。
- `mikuPink`：`#F58BC4`，用于 WorkBuddy 卡片强调和顶部光带终点。
- `textPrimary` 与 `textSecondary`：系统 `labelColor` 和 `secondaryLabelColor`。
- `danger`：系统红色，仅用于错误信息。

### 字体与层级

- 主标题使用 24pt Semibold 系统字体。
- 产品名使用 17pt Semibold。
- 最近皮肤名使用 14pt Semibold。
- 状态、端口和说明使用 10pt 至 12pt Medium 或 Regular。

## 布局

窗口扩大到 760×500。顶部包含 62×62 的 Miku Logo、标题、副标题和「Mac 专属」胶囊。中部保留两张等宽产品卡，卡片顶部显示真实 APP 图标、产品名和状态胶囊；中段显示最近皮肤；下方为全宽主操作按钮和一行产品说明。底部状态栏显示本机安全恢复状态、两个独立端口及诊断入口。

## 产品图标

Codex 与 WorkBuddy 不再显示「C」「W」字母块。启动器通过 `NSWorkspace.shared.urlForApplication(withBundleIdentifier:)` 找到本机 APP，再通过 `NSWorkspace.shared.icon(forFile:)` 读取系统实际图标。若 APP 未安装，使用对应 SF Symbol 作为回退，并保留明确的「未安装」状态。

## 交互与状态

- 读取中：真实图标可先显示，状态胶囊显示「读取中」，按钮禁用。
- 已就绪：显示最近皮肤和当前产品模式，按钮使用产品强调色。
- 未安装：显示 SF Symbol 回退图标，按钮禁用。
- 正在恢复：按钮标题变为「正在恢复…」并锁定两张卡片的重复操作。
- 失败：卡片保留，错误信息使用系统红色，按钮提供重试。
- 成功：保持现有逻辑，前置目标 APP 后关闭启动器。

## 可访问性与兼容性

真实 APP 图标设置为「Codex 应用图标」或「WorkBuddy 应用图标」。按钮和状态文字继续由 AppKit 暴露给辅助功能。所有背景和边框在 `viewDidChangeEffectiveAppearance` 后重新解析，维持 5.5.10 的夜间模式修复。最低系统版本仍为 macOS 13，不增加第三方依赖。

## 验收

- 源码回归测试禁止重新出现字母图标，并要求真实 APP 图标解析路径存在。
- 双架构 Swift 构建通过。
- 完整发布门禁零失败。
- 从最终 `.skill` 覆盖安装后，在正式启动器窗口中目视确认真实 Codex、WorkBuddy 图标、卡片层级、按钮、状态栏和深色模式对比度。

