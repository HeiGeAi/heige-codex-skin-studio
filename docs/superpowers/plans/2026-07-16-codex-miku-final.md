# Codex Miku Theme v5 Final Implementation Plan

> **For agentic workers:** Execute each task with tests and verification evidence. Preserve the user's existing pet and visual assets.

**Goal:** 在真实 Codex Desktop 中安装并发布与高清参考图一致的 v5 初音未来主题，修复宠物背景污染和排队安装失败，并把最终主题与最新宠物作为可复现 Skill 发布到 GitHub。

**Architecture:** 使用纯 Hero 素材、真实 DOM 玻璃化样式和不可变拍立得三层视觉；用零依赖 Node.js 固定尺寸替换 ASAR 入口与四个 PNG 槽；用一次性 launchd 任务在应用退出后安全安装并自动重开。

**Tech Stack:** Node.js、node:test、CSS、zsh、macOS launchd、FFmpeg、GitHub CLI。

### Task 1：冻结参考与素材不变量

- [x] 核对用户参考图与仓库高清源图 SHA-256 一致。
- [x] 锁定右下拍立得 SHA-256，禁止重裁、调色或替换。
- [x] 核对本地最新宠物三份分发副本与已安装副本一致。
- [ ] 更新素材 manifest 的 Hero 与宠物路径、尺寸、布局和哈希。

### Task 2：修复窗口隔离与视觉层级

- [ ] 先补主窗口与宠物 WebView 隔离测试。
- [ ] 把所有全局背景和根伪元素约束到包含 `.app-shell-left-panel` 的主窗口。
- [ ] 重建不含烘焙 UI 的纯 Hero，消除双人物、双卡片、双输入框和双拍立得。
- [ ] 优化左栏、主画布、建议卡、消息区与 composer，压缩 CSS 到 8003 字节以内。
- [ ] 同步源码和 Skill payload，并固定拍立得哈希测试。

### Task 3：修复无人值守安装链路

- [ ] 先补 one-shot、自清理、有限退出重试和宠物配置追加测试。
- [ ] 用明确 `RunAtLoad=true`、`KeepAlive=false` 的一次性任务替代 inferred keepalive。
- [ ] 只对“Codex 尚未完全退出”错误有限重试，其他错误立即失败。
- [ ] 修复宠物配置字段缺失时追加、存在时替换、已为目标值时幂等。
- [ ] 同步根项目、Skill 与独立宠物安装脚本。

### Task 4：修复可复现打包与兼容说明

- [ ] 删除 Skill 内被忽略的重复宠物目录和临时备份产物。
- [ ] 增加从 tracked 文件清单重建 Skill 的脚本与测试。
- [ ] 更新 README、Skill 说明、真实容量与安全边界。
- [ ] 在官方旧基线 fixture 与本机当前结构上分别验证安装预检。

### Task 5：真实应用往返与视觉验收

- [ ] 完全退出 Codex，由一次性任务安装并自动重开。
- [ ] 核对安装状态、完整 ASAR 哈希、四张素材和 launchd label。
- [ ] 抓取 16:9 真实运行截图，对照九项视觉门槛。
- [ ] 打开宠物预览，确认无背景、人物大图、主画布伪元素或拍立得污染。
- [ ] 执行恢复、核对原始哈希，再次安装并重复检查。

### Task 6：最终测试、GitHub 发布与交付

- [ ] 运行完整测试、Shell 语法、Skill 校验、ZIP 完整性和 diff 检查。
- [ ] 从干净 clone 重建 `.skill` 并比较 SHA-256。
- [ ] 提交并推送 `main`，创建 `v5.0.0` Release，上传最终 `.skill`、项目 ZIP、预览图和校验文件。
- [ ] 从 GitHub Release 下载附件，复验哈希与安装内容。
- [ ] 发送飞书完成通知和实际文件正文，记录 message_id。
