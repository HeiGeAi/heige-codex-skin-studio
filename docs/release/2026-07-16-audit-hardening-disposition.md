# 2026-07-16 审计加固处置报告

## 状态

本报告对应 `codex/audit-hardening` 分支。远程状态于 2026-07-16 只读复核，任何远程 Issue、Pull Request、Release、标签、仓库描述与安全设置均未在本轮审计中擅自修改。

本分支的最终交付门槛是：本地完整验证通过，macOS 当前机器实测通过，Windows 自动化证据通过，200-agent 专家复审无未处置的 P0/P1，确定性安装包与本文摘要一致，并且新建 Draft PR 后 GitHub Actions 全部通过。

<!-- heige-package-sha256 --> Package SHA-256: 09686477bae7b5352d1813392cdee4d80d97f0983d5569bf597c26d58525aeb9

## 已确认的产品边界

- 皮肤常驻开关采用方案 1。关闭后本次会话继续使用皮肤，下次启动恢复原生界面。
- 顶部菜单「皮肤常驻」开关是唯一受支持的 `false` 到 `true` 常驻入口。本地「HeiGe 皮肤启动器」与「启用 HeiGe 皮肤」意图只恢复当前会话，不改变常驻选择。
- 关闭常驻后若想恢复，先用启动器或兼容的 `enable-skin` 入口拉起当前会话，再由用户在顶部菜单显式打开常驻开关。`enable-persist.command` 是非零退出的弃用入口。
- 顶部「自定义图片」是单个本地快捷槽，不写入权威的最近正式主题，也不冒充为可分发的持久主题。renderer 本地存储可在自动补针或常驻启动时继续显示它，清除本地数据后会丢失。
- 项目通过本机 CDP 控制桌面客户端。它不是浏览器安全沙箱，也不应宣称能够阻止本机同权限进程访问调试端口。
- macOS 行为必须由当前机器实测背书。Windows Store/MSIX 启动仍以 Windows GitHub Actions 和真实 Windows Store 机器证据为准。
- 项目可以降低升级漂移风险，但不得承诺未来 Codex Desktop 升级永远不需要调整启动方式、目标识别或界面选择器。

## 对 Claude Code 修复日志的复核

Claude Code 那轮并非没有价值，但「全部修完并发布」的结论不成立。本轮按源码、当前 Mac 活体状态和跨平台协议重新核查后，裁决如下：

- 正确且应保留的方向：收敛颜色校验、隔离坏 manifest、区分用户显式 apply 与后台恢复、补齐上传失败反馈、修正 Windows 多行 JSON／退出码／编码问题，以及识别 CDP 回环端口仍然无认证。
- 正确但证据不足的部分：Windows PowerShell 改动只做括号配平与片段核验，不能证明 Scheduled Task、MSIX 激活、端口归属和失败补偿真实可用。本分支因此增加 Windows PowerShell 5.1、PowerShell 7、32 位解析、隔离任务和 GitHub Actions 门禁，并继续把 Store/MSIX 标为真机待验证。
- 与最终产品规格冲突的部分：继续强化 15 秒 watchdog 和冷却自禁，无法表达「关闭后本次继续使用，下次启动原生」的用户选择。最终实现改为 schema 2 状态、统一 controller、一次性启动请求和顶部确认开关。
- 未被处理的高风险边界：旧树覆盖安装、旧 watchdog 到新 controller 的可逆迁移、进程死亡后的 durable journal recovery、动态 revision 被固化到长期任务、仅注册未 ready 被误判健康，以及发布包和文档漂移。这些均不能由当时的测试数量或一次 CDP DOM 验证代替。
- 安全判断本身正确但处置不应等待：CDP 无认证是架构边界，应该立即写入 `SECURITY.md` 与 README，而不是等用户再次确认是否披露。本分支已经明确披露，并把控制菜单的 token 校验与 CDP 的同权限进程风险分开说明。

因此，本报告把 Claude Code 的日志当作一组有用的初步修复记录，不把其中的完成声明、Windows 可用性或发布结论当作最终验收证据。

## 当前 Mac 预检发现

正式迁移前的只读预检发现当前机器不是干净基线，因此尚未执行旧服务删除或状态迁移：

- `/Applications/ChatGPT.app` 的 `codesign --verify --deep --strict` 与 Gatekeeper 校验失败，精确原因是 `Contents/Resources/app.asar` 被修改。当前 bundle 版本为 `26.707.72221`，其 `app.asar` SHA-256 为 `b5da51e5df6e996076e4cb19045cec46dd4c08cf61c19cdbc5cb426b8413b73c`，签名已不是 OpenAI 的完整有效签名。
- OpenAI 官方下载页当前指向 `https://persistent.oaistatic.com/codex-app-prod/ChatGPT.dmg`。隔离下载的 DMG 已通过 `hdiutil verify`；其中 `ChatGPT.app` 版本为 `26.707.91948`，build `5440`，TeamIdentifier `2DC432GLL2`，通过 deep strict codesign 与 Gatekeeper notarization 校验；官方 `app.asar` SHA-256 为 `85b11c8d93d377f82161ba9b7b1af6f95b2a0490f01993dbc4d3a107dce77591`。
- 官方 app 已复制到隐藏 staging 路径并再次通过签名校验，但 canonical `/Applications/ChatGPT.app` 尚未替换。替换必须由 detached live harness 在当前进程正常退出后按 durable journal 完成，失败时恢复原 bundle。
- `com.heige.codex-skin-watchdog` 与一个旧版 `com.heige.codex-skin-controller` plist 同时 loaded，schema 2 state 尚不存在。旧 controller 当前不 running，其固定参数仍使用 `~/.hermes/node/bin/node`。这属于半迁移现场，必须把旧 controller 本身也纳入 byte-for-byte 备份与回滚。
- 旧 watchdog 的 state／log 字段仍含未受信任的临时路径。预检只记录该事实，不遍历、不读取、不删除那些路径。

这也证明旧日志中「重新应用干净状态」不等于恢复了官方签名。最终验收必须先恢复并验证官方 app，再以该干净基线测试 CDP 运行时皮肤。

## 远程只读快照

### 仓库元数据

- 仓库：`HeiGeAi/heige-codex-skin-studio`。
- 可见性：公开。
- 默认分支：`main`。
- 归档状态：未归档。
- 当前描述同时宣称 macOS、Windows 与 9 个预设主题。该描述应在本分支验证结论稳定后改成与真实支持矩阵一致的文案，本轮不直接修改。
- Secret scanning 与 push protection 已启用。Dependabot security updates 未启用。
- Private vulnerability reporting 当前为 `enabled: false`。

### Release 与标签

- 当前唯一且 Latest 的 Release 是 `v4.0.0`，名称为 `Codex Miku Theme v4.0.0`，发布于 `2026-07-15T10:25:05Z`。
- 其资产 `codex-miku-theme.skill` 的远程摘要为 `sha256:4a8283276db8f7ec999ce49ca489113c2ac82888cab93cce00b232540e54e537`。该资产属于旧版本，不是本分支最终产物。
- `v4.0.0` 与 `v5-asar-legacy` 当前都指向 `fdf374e2123e3b47183ff86af62aded8f69c0096`。
- 在完整历史核验前，不移动或删除 `v5-asar-legacy`，也不把它描述成已经证实的独立遗留快照。
- 本轮素材溯源门禁确认 32 个视觉素材尚未取得可公开再分发的权利证据，因此禁止为本分支创建或更新公开 Release。只有在逐项补齐授权，或用权利清晰的素材完成替换并通过门禁后，才可另行评估发布；旧 Release 本轮保持不动。

### Issue #1

- `#1 windows error` 当前仍为 open。
- 报告内容是传统路径探测不到 Windows Store/MSIX Codex。
- 报告者随后评论「codex 已解决」，但没有提供可复现的安装类型、版本与完整验证矩阵。
- 建议等待本分支 Windows 自动化与真实 Windows Store 机器证据齐备后再回复并关闭。仅凭该评论不能证明仓库实现已解决问题。

### Draft PR #2

- `#2 Support Microsoft Store Codex on Windows` 当前为 open、draft。
- 远程 head 为 `agent/support-codex-msix-windows`，head SHA 为 `976e107e5cecfdb3f02de3caf3a113521181056f`，base 为 `main`。
- 该 PR 只有 1 个 commit，GitHub 当前给出 `mergeable: false` 与 `mergeable_state: dirty`。
- 其方向包括 MSIX 探测、系统 Node 与包激活，但必须与本分支的确定性解析、Node 22 预检、任务隔离与握手验证逐项比较。
- 建议在本分支 Draft PR 建立后做提交级对照，再决定吸收、替代或请求关闭。当前不关闭、不评论、不修改该 PR。

## 建议的远程处置

1. 在新 Draft PR 的本地与 CI 证据稳定后，修正仓库描述，去掉未经验证或容易过期的绝对化支持声明。
2. 将公开 Release 保持为阻断状态，直至 32 个视觉素材逐项取得再分发授权或完成合规替换；不得以 Draft PR、测试全绿或安装包可构建代替素材权利门禁。
3. 查清 `v5-asar-legacy` 的历史意图后，再决定是否需要创建真实、独立且可说明来源的 legacy 标签。
4. 取得 Windows Store/MSIX 真机证据后处理 Issue #1，并在回复中给出安装类型、版本、Node 来源与启动验证结果。
5. 对比 Draft PR #2 与本分支后再处置，避免遗漏外部贡献者提供的有效边界条件。
6. 建议启用 private vulnerability reporting，为 CDP 控制边界与本机启动链路提供私密报告入口。
7. 评估是否启用 Dependabot security updates，但自动升级仍须经过现有跨平台验证门禁。

## 待最终回填

- 本地完整测试矩阵与结果。
- 200-agent 复审结论、被采纳修复与明确保留的 P2 风险。
- 2026-07-16 当前 macOS 机器迁移与重启语义实测结果。
- Windows PowerShell 5.1、PowerShell 7、32 位解析与 GUID Scheduled Task 集成结果。
- 最终 `.skill` 文件 SHA-256。最终构建后必须替换本文唯一的 `heige-package-sha256` 标记，不允许保留 `pending final build`。
- 新 Draft PR 地址与 GitHub Actions 结果。
