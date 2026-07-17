# macOS live acceptance

Status: BLOCKED
Recorded: 2026-07-17T05:10:00.000Z

## Checks


## Current boundary

- code: SANDBOX_LAUNCHCTL_EPERM
- message: The final production installer was intentionally invoked from the repository, but its first macOS process spawn was blocked by the managed sandbox with `spawn EPERM`. The installer cannot call `launchctl`, so it cannot replace the live stable tree or perform the final renderer click test in this session.

## Code verification

- controller and LaunchAgent regression suite: PASS, 216 passed, 0 failed.
- full suite before the final fresh-controller startup-race patch: PASS, 917 passed, 0 failed, 6 skipped.
- final live menu acceptance: NOT RUN. Do not treat the prior recovery result as feature acceptance.

## Recovery

- status: PASS
- lifecycleHelpers: PASS
- appRepair: PASS
- installer: PASS
- functionalMode: PASS
- journal theme: miku-488137
- effective renderer theme: dalao-dianyan

Windows Store: 待验证
