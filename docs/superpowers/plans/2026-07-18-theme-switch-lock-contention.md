# Theme Switch Lock Contention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 5.2.3 控制器自检与菜单换肤并发造成的间歇性 `LOCK_HELD`，同时保留跨进程安全锁。

**Architecture:** 在 `createSkinController` 的归一化依赖边界，为所有控制器内部 lease 请求增加实例级 FIFO 调度。队首调用真实 `withLease`，仅对获取阶段返回的 `LOCK_HELD` 做有上限退避重试，其他错误保持 fail closed。

**Tech Stack:** Node.js 22、ES modules、`node:test`、Promise FIFO、现有 operation lock。

---

### Task 1: 控制器内部 lease 串行化

**Files:**
- Modify: `test/controller.test.mjs`
- Modify: `src/controller.mjs`

- [ ] **Step 1: 写并发失败测试**

在 `test/controller.test.mjs` 中构造一个会拒绝并发持有者的真实行为型 `withLease`。让 `pause()` 持有 lease 并阻塞在 `removeSkin`，同时调用 `setThemeSelection()`，断言第二个请求保持等待；释放前一个操作后，断言主题提交为 `genshin-night` 且 revision 增加。

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
node --test --test-name-pattern="serializes overlapping controller lease operations" test/controller.test.mjs
```

Expected: FAIL，换肤请求在前一个 lease 释放前收到 `LOCK_HELD` 或提前 settled。

- [ ] **Step 3: 写最小 FIFO 实现**

在 `src/controller.mjs` 添加实例级 lease 调度器：

```js
function serializeLeaseOperations(withLease) {
  let tail = Promise.resolve();
  return async (operation, action, context) => {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await withLease(operation, action, context);
    } finally {
      release();
    }
  };
}
```

在 `normalizedDependencies` 中先确定原始 `withLease`，再把返回依赖中的 `withLease` 替换为调度后的函数。

- [ ] **Step 4: 运行目标测试并确认 GREEN**

Run:

```bash
node --test --test-name-pattern="serializes overlapping controller lease operations" test/controller.test.mjs
```

Expected: PASS。

### Task 2: 短暂跨进程锁冲突有限重试

**Files:**
- Modify: `test/controller.test.mjs`
- Modify: `src/controller.mjs`

- [ ] **Step 1: 写 `LOCK_HELD` 重试失败测试**

让测试 `withLease` 的前两次换肤 lease 获取抛出 `code = "LOCK_HELD"`，第三次执行 action。断言换肤成功、调用次数为 3。另加一个非 `LOCK_HELD` 错误用例，断言只调用 1 次并原样失败。

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
node --test --test-name-pattern="retries bounded live lock contention|does not retry non-contention lease failures" test/controller.test.mjs
```

Expected: 第一个测试 FAIL，当前实现不会重试；第二个测试保持 fail closed。

- [ ] **Step 3: 为 FIFO 队首增加有限退避**

在 `src/controller.mjs` 定义固定等待表并实现：

```js
const LEASE_RETRY_DELAYS_MS = Object.freeze([20, 40, 80, 160, 320, 500]);
```

调度器捕获底层 `withLease` 错误。仅当 `error?.code === "LOCK_HELD"` 且仍有等待预算时，等待对应毫秒数后重新获取。操作 action 一旦开始后抛出的业务错误不得重试。

- [ ] **Step 4: 运行目标测试并确认 GREEN**

Run:

```bash
node --test --test-name-pattern="serializes overlapping controller lease operations|retries bounded live lock contention|does not retry non-contention lease failures" test/controller.test.mjs
```

Expected: 3 个测试全部 PASS。

### Task 3: 全量验证与本机实测

**Files:**
- Verify: `src/controller.mjs`
- Verify: `test/controller.test.mjs`
- Verify: `docs/superpowers/specs/2026-07-18-theme-switch-lock-contention-design.md`

- [ ] **Step 1: 运行控制器测试**

Run:

```bash
node --test test/controller.test.mjs
```

Expected: 0 failures。

- [ ] **Step 2: 运行全量测试**

Run:

```bash
npm test
```

Expected: 0 failures。

- [ ] **Step 3: 安装当前分支到本机并重启控制器**

Run:

```bash
node src/cli.mjs install
```

Expected: 安装成功，`node src/cli.mjs doctor` 返回健康。

- [ ] **Step 4: 实机连续换肤**

通过 CDP 真实鼠标事件依次点击至少 6 个不同主题。每次记录点击后 DOM 主题切换耗时，并等待后端 ACK。核对：

```bash
node src/cli.mjs status
```

Expected: DOM 立即变化，`state.json` 与 `session.json` 最终主题一致，新增日志中没有 `LOCK_HELD`。

- [ ] **Step 5: 重启持久化验证**

重启 Codex 后再次运行：

```bash
node src/cli.mjs doctor
node src/cli.mjs status
```

Expected: 控制器健康，重启前最后选择的主题仍生效。

- [ ] **Step 6: 检查差异并提交**

Run:

```bash
git diff --check
git status --short
git diff -- src/controller.mjs test/controller.test.mjs docs/superpowers/specs/2026-07-18-theme-switch-lock-contention-design.md docs/superpowers/plans/2026-07-18-theme-switch-lock-contention.md
```

Expected: 无空白错误，仅包含本补丁范围内的改动。提交消息：

```bash
git add src/controller.mjs test/controller.test.mjs docs/superpowers/specs/2026-07-18-theme-switch-lock-contention-design.md docs/superpowers/plans/2026-07-18-theme-switch-lock-contention.md
git commit -m "fix(controller): serialize theme switch operations"
```
