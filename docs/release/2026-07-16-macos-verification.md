# macOS live acceptance

Status: PASS（macOS 功能验收）
Recorded: 2026-07-17T07:45:00.000Z
Machine: real macOS host (unsandboxed), Codex desktop hosted by ChatGPT.app

## 本轮修复

### 常驻跨重启失效（核心缺口，已修）

现象：开关写着「已开启，下次启动继续使用」，但用户正常重启 Codex 后皮肤永不恢复（实测 300s+ 无反应）。

根因：控制器只探测带 CDP 端口启动的 Codex（`listCodexProcesses().filter(cdpPort === port)`）。用户正常双击启动的 Codex 不带 CDP，探测返回 null，`reconcile` 永远停在 `wait-for-app`，没有任何组件负责把原生启动的 Codex 接管回皮肤模式。

修复：后台控制器新增 `probeNativeProcess`（识别 `cdpPort === null` 的 Codex）与 `restartIntoCdp`，在常驻开启且发现原生 Codex 时把它重启进 CDP 模式，新增 `relaunch` 动作。三重刹车防止重启循环：

- 同一进程身份只尝试一次；
- 连续失败用尽预算（3 次）后彻底停手，等待人工介入；
- 任何一次重启把 CDP 拉起来即清零预算，用户后续重启照常被接管。

安全边界：仅 `backgroundProcess`（LaunchAgent）启用，ephemeral 控制器不参与；仅 macOS 接线，Windows 仍必须走 `scripts/windows` 包装器；两个依赖均为可选，缺失时退回既有 `wait-for-app` 行为。不携带 `afterLaunch`——控制器本身在运行，Codex 带着 CDP 回来后由它自己注入，同时避开 helper 的 `themeId` 正则拒绝原生主题 ID `__heige_native__` 的问题。

## Live acceptance（真实 renderer，CDP 逐项驱动）

- menuSwitch: PASS。`role=switch`、`aria-checked` 与后台一致、提醒文案完整。
- offAck: PASS。真实确认 UI → 回环 ACK → revision 递增，前后台一致。
- reEnableViaMenu: PASS。开关重新开启即时 ACK，`alert` 为空，无假失败。
- sameProcessReload: PASS。renderer reload 后 2s 内皮肤与菜单恢复。
- **nativeRestart: PASS（本轮新修）**。常驻开启时正常退出并正常重启 Codex，皮肤自动恢复，连续两次实测分别为 10s 内、10s 内；重启后的进程确认携带 `--remote-debugging-port=9341`，由后台控制器接管拉起。
- **persistenceOffRestart: PASS**。常驻关闭后正常重启 Codex，进程不带 CDP 参数、9341 无监听、控制器 5s 内自行注销，用户意志未被违背。
- launcherReenable: PASS。常驻关闭状态下 `enable-skin` 5s 内恢复皮肤，与菜单提醒文案承诺的拉起路径一致。
- finalPreference: PASS。终态 persistenceEnabled=true = 用户原始选择。

## 更正前一版报告的两处错误结论

- **「reEnableViaMenu 假失败」不成立**。前一版记录用户重新开启常驻时先看到「后台控制器未确认，请重试」。在控制器健康状态下复跑，该现象不复现（`alertText` 为空，ACK 即时）。真实原因是当时第一次安装失败留下的 journal 使 `MACOS_INSTALL_IN_PROGRESS` 围栏持续拒绝 `controller:tick`，控制器无法接手 fallback 队列，并非 UI 设计缺陷。
- **「安装器吞掉子命令 stderr」不成立**。实测 `promisify(execFile)` 的 `error.message` 本就包含 stderr，且 `cli.mjs` 的错误确实写入 stderr。当时错误信息中 stderr 为空的唯一解释是：`awaitExactReady` 的 `set-persistence` 子命令达到 15s `timeout` 被 SIGTERM 杀掉，stderr 天然为空。真实问题是错误信息无法区分「子命令报错」与「子命令超时」，属诊断质量，未在本轮改动。

## 已知边界（未在本轮改动，附判断依据）

- **安装期锁竞争**：`install.command` 首次运行可能因 `controller:tick` 持锁而报 `LOCK_HELD`，或因控制器未及时就绪触发 15s 超时；重跑即成功（本轮两次安装均如此）。改动安装协调器的锁策略风险高于收益，保留为已知瞬态。
- **`apply` 不带 `--theme` 时的 preferStored**：手动执行 `apply`（不指定主题）会优先读取 renderer 本地选择，可能覆盖 state.json 的权威主题（本轮验收前曾以 miku-488137 覆盖 dalao-dianyan）。该行为是 `57b16fb fix(macos): preserve the live renderer selection` 的有意设计，控制器重启路径不受影响（helper 显式传 `--theme`），故不擅改。
- **rollback-then-clean harness**：`test/live-macos-acceptance.mjs` 的 preflight `inspectLegacy` 硬性要求旧 watchdog plist 存在，本机已完成迁移（仅存 `com.heige.codex-skin-controller`），该序列在迁移后状态不可运行。属已知未完成工作项。
- **Windows Store 真机**：待验证，需外部环境。
- **公开 Release**：`release:check` 按设计阻断——32 个视觉素材缺少再分发权利证明。此为治理闸门正常工作，非缺陷。

## Code verification

- 全量套件：PASS，930 passed, 0 failed, 6 skipped。
- controller 套件：PASS，75 passed（新增 11 条常驻接管与循环刹车回归）。
- 发布治理套件：PASS，10 passed。
- 安装包 SHA-256：`82bd3cda4e63ebdc570089fc64dfbcd1e33c08b6435fa34dec430f55d05db96d`（`update-release-hash.mjs` 已同步 disposition）。

## Final machine state

theme `dalao-dianyan`，mode active，menu true，persistenceEnabled true，revision 13。与验收前用户状态一致。
