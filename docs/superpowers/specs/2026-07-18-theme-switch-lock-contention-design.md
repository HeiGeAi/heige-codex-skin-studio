# 主题切换锁冲突修复设计

## 背景

5.2.3 的主题资源、菜单点击和状态写入链路均可正常工作，但换肤存在间歇性失败。实机日志记录了：

```text
renderer_control_request_failed: LOCK_HELD: operation controller:set-theme-selection is held by live pid
controller_failure: LOCK_HELD: operation controller:ack-renderer-request is held by live pid
controller_failure: LOCK_HELD: operation controller:tick is held by live pid
```

后台控制器每秒执行健康巡检，同时 loopback 控制服务可接收菜单换肤请求。两条异步路径会在同一个 Node.js 进程中并发调用 `withOperationLock`。文件锁按设计拒绝第二个持有者，因此一次正常的进程内并发会被误判为操作冲突。控制服务随后返回 `THEME_UPDATE_FAILED`，菜单回滚乐观预览，用户看到的结果就是点击后不生效。

## 目标

1. 同一控制器进程内的持久化操作必须按到达顺序串行执行。
2. 另一个可信进程短暂持锁时，控制器可以在有限时间内重试。
3. 不移除、不绕过、不放宽现有跨进程文件锁。
4. 不修改主题资源、主题菜单视觉或安装流程。
5. 换肤请求仍须在浏览器 3 秒超时窗口内完成或进入现有渲染器兜底通道。

## 方案

在 `src/controller.mjs` 的依赖归一化阶段包装底层 `withLease`：

1. 使用 Promise tail 建立控制器实例级 FIFO 队列。
2. 每个排队任务获得执行权后才调用真实 `withLease`。
3. 仅对错误码严格等于 `LOCK_HELD` 的获取失败执行有限退避重试。
4. 重试等待为 20、40、80、160、320、500ms，总等待上限 1120ms。
5. 其他锁错误、业务错误和操作内部错误立即原样抛出。
6. 无论任务成功或失败，都在 `finally` 中释放 FIFO 槽位，避免队列永久阻塞。

这层调度只协调一个控制器实例。跨进程互斥仍由 `operation-lock.mjs` 决定，调度器不会伪造 lease，也不会在没有 lease 的情况下写状态。

## 测试

在 `test/controller.test.mjs` 增加两类回归：

1. 一个控制器操作持有 lease 时，同时到达的换肤请求应等待，前一个操作释放后再成功提交，而不是收到 `LOCK_HELD`。
2. 底层 lease 获取连续返回短暂 `LOCK_HELD` 后恢复时，换肤请求应在重试预算内成功；非 `LOCK_HELD` 错误仍须立即失败。

完成单元测试后运行全量 `node --test`，再把修复安装到本机，通过真实 Codex 菜单连续切换多个主题，核对 DOM、`state.json`、`session.json` 和控制器日志，最后重启 Codex 验证持久化主题。

## 不采用的方案

1. 只在菜单失败后再次排队。它只能掩盖症状，控制器的其他操作仍会撞锁。
2. 删除主题切换的 operation lock。它会让状态和 session 写入失去跨进程原子性。
3. 无限重试。它会掩盖安装占锁、死进程和锁链损坏等真实故障。
