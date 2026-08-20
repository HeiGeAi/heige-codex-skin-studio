# v5.5.5 Dual Product macOS Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a native macOS launcher that restores the most recent Codex or WorkBuddy skin from a two-card panel and survives local v5.5.5 overwrite installation.

**Architecture:** A universal AppKit executable lives in the generated launcher bundle and reads only attributed bundle metadata. It queries a small JSON state command and routes actions through product-whitelisted shell entrypoints, while the existing transactional installer owns staging, signing, rollback, and LaunchServices registration.

**Tech Stack:** Node.js 22 ESM, Node test runner, zsh, Swift 6 AppKit, macOS codesign and lipo.

---

### Task 1: Freeze launcher state contract

**Files:**
- Create: `src/launcher-panel-state.mjs`
- Create: `test/launcher-panel-state.test.mjs`
- Modify: `src/cli.mjs`

- [ ] **Step 1: Write failing state-model tests**

Add tests for installed and missing products, stored theme name resolution, default-theme fallback, missing manifest fallback, exact schema keys, and product mode values `session` and `one-shot`.

- [ ] **Step 2: Verify RED**

Run: `node --test test/launcher-panel-state.test.mjs`

Expected: FAIL because `src/launcher-panel-state.mjs` does not exist.

- [ ] **Step 3: Implement the pure state builder**

Export `buildLauncherPanelState({ profile, discovery, studioState, themes, defaultThemeId })`. Validate the inputs and return exactly `schemaVersion`, `product`, `productName`, `appInstalled`, `appPath`, `themeId`, `themeName`, and `mode`.

- [ ] **Step 4: Add the CLI adapter and failing CLI tests**

Add `launcher-state --app codex|workbuddy` to the command whitelist. The branch reads discovery, studio state, and theme list, then delegates to the pure builder. Extend the existing CLI test fixture to assert JSON-equivalent values and reject unknown options.

- [ ] **Step 5: Verify GREEN**

Run: `node --test test/launcher-panel-state.test.mjs test/cli.test.mjs`

Expected: all selected tests pass with zero failures.

### Task 2: Add product-safe launcher scripts

**Files:**
- Create: `scripts/launcher-state.command`
- Modify: `scripts/launch-skin.command`
- Create: `test/macos-launcher-scripts.test.mjs`
- Modify: `scripts/skill-package-manifest.json`

- [ ] **Step 1: Write failing script tests**

Use a temporary copied script tree and a recording `run-cli.zsh` fixture. Assert Codex routes to `launcher-apply --launcher-version <version> --port 9341`, WorkBuddy routes to `apply --app workbuddy --prefer-stored --port 9342`, state routes to `launcher-state --app <product>`, and any other product exits nonzero before invoking the CLI.

- [ ] **Step 2: Verify RED**

Run: `node --test test/macos-launcher-scripts.test.mjs`

Expected: FAIL because the state entrypoint and WorkBuddy launcher route are missing.

- [ ] **Step 3: Implement minimal routing**

Keep `set -euo pipefail` and `umask 077`. Accept only literal `codex` or `workbuddy`, preserve the existing 1200-character sanitized dialog for action failure, and do not use `eval`, inherited executable paths, or unvalidated ports.

- [ ] **Step 4: Update the package manifest**

Package both executable scripts with mode `0755`; add the native source and built binary entries in the later native task without weakening manifest exactness.

- [ ] **Step 5: Verify GREEN**

Run: `node --test test/macos-launcher-scripts.test.mjs`

Expected: all routing and rejection tests pass.

### Task 3: Build the native two-card AppKit panel

**Files:**
- Create: `native/macos-launcher/main.swift`
- Create: `scripts/build-macos-launcher.command`
- Create: `test/native-macos-launcher.test.mjs`
- Create mechanically: `assets/launcher/HeiGeSkinLauncher.bin`

- [ ] **Step 1: Write failing native contract tests**

Assert the source declares the exact product IDs and bundle IDs, decodes the state schema, creates two product cards, uses `Process` with fixed scripts, handles loading and failure states, activates the target app, and contains no network API, shell interpreter string, `eval`, or `app.asar` mutation.

- [ ] **Step 2: Verify RED**

Run: `node --test test/native-macos-launcher.test.mjs`

Expected: FAIL because the Swift source and build script do not exist.

- [ ] **Step 3: Implement AppKit source**

Build a single `NSWindow` with a native title bar, brand header, two `ProductCardView` instances, and diagnostics button. Read `HeiGeInstallRoot` and `CFBundleShortVersionString` from `Bundle.main`; invoke fixed script names under that root with `Process.executableURL`; decode bounded JSON; dispatch UI changes to the main queue; enforce one action at a time; truncate displayed errors; terminate only after activation succeeds.

- [ ] **Step 4: Implement reproducible universal build**

The build script locates the macOS SDK with `xcrun`, compiles arm64 and x86_64 with deployment target 13.0 into a private temporary directory, combines them using `/usr/bin/lipo -create`, verifies both architectures, and atomically replaces only `assets/launcher/HeiGeSkinLauncher.bin`.

- [ ] **Step 5: Build and verify GREEN**

Run: `scripts/build-macos-launcher.command`

Run: `node --test test/native-macos-launcher.test.mjs`

Run: `/usr/bin/lipo -info assets/launcher/HeiGeSkinLauncher.bin`

Expected: tests pass and lipo reports both `x86_64` and `arm64`.

### Task 4: Upgrade generated launcher ownership to schema 4

**Files:**
- Modify: `src/macos-launcher.mjs`
- Modify: `test/macos-launcher.test.mjs`

- [ ] **Step 1: Write failing schema 4 tests**

Change the primary fixture expectation to schema 4 and assert the installed executable equals `assets/launcher/HeiGeSkinLauncher.bin`, is nonempty and executable, has both architectures on macOS, and the plist preserves version, icon, install root, and minimum system version. Add rejection tests for a modified native executable, oversized executable, symlinked executable asset, and a schema 3 legacy bundle regression test.

- [ ] **Step 2: Verify RED**

Run: `node --test test/macos-launcher.test.mjs`

Expected: FAIL because the installer still renders schema 3 shell text.

- [ ] **Step 3: Implement binary input and validation**

Set `MACOS_LAUNCHER_SCHEMA_VERSION` to 4. Read the source binary with `O_NOFOLLOW` and a fixed maximum size. For schema 4, stage and validate bytes instead of UTF-8 text; for schemas 1 through 3 keep the existing canonical shell validation. Hash bytes into the existing participant fields and retain exact directory and signature checks.

- [ ] **Step 4: Verify GREEN and transactional regressions**

Run: `node --test test/macos-launcher.test.mjs test/macos-install-coordinator.test.mjs test/macos-launcher-recovery.test.mjs`

Expected: all selected tests pass with zero failures.

### Task 5: Version, package, documentation, and full automated verification

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `scripts/skill-package-manifest.json`
- Modify: `README.md`
- Modify: `docs/manual.md`
- Create: `docs/release/2026-08-20-v5.5.5-verification.md`
- Create mechanically: release ZIP produced by the existing package command

- [ ] **Step 1: Bump all owned version references to 5.5.5**

Update package metadata, launcher defaults and affected fixtures. Run an `rg` audit to distinguish deliberate historical references from stale current-version references.

- [ ] **Step 2: Document the dual-product launcher**

Describe open, card states, Codex session and persistence semantics, WorkBuddy one-shot semantics, log locations, reinstall recovery, and explicit non-support for theme selection inside the launcher.

- [ ] **Step 3: Run focused tests**

Run: `node --test test/launcher-panel-state.test.mjs test/macos-launcher-scripts.test.mjs test/native-macos-launcher.test.mjs test/macos-launcher.test.mjs`

Expected: zero failures.

- [ ] **Step 4: Run the complete release check**

Run: `npm run release:check`

Expected: zero test failures and asset provenance check success.

- [ ] **Step 5: Package and inspect artifact**

Run the repository's existing packaging command. Verify ZIP listing includes the Swift source, universal binary, both launcher scripts, v5.5.5 package metadata, and no temporary files. Record SHA-256 and exact test counts in the release verification document.

### Task 6: Local overwrite install and real macOS acceptance

**Files:**
- Modify after evidence collection: `docs/release/2026-08-20-v5.5.5-verification.md`

- [ ] **Step 1: Snapshot current local launcher and runtime state**

Record current app version, signature result, stable runtime version, installed Codex and WorkBuddy paths, and whether each app is running. Do not alter user theme state.

- [ ] **Step 2: Run the existing v5.5.5 local installer in overwrite mode**

Use the project-supported install command so runtime and launcher participate in one transaction. Do not hand-copy files into the stable install root.

- [ ] **Step 3: Verify installed ownership**

Run `codesign --verify --deep --strict`, inspect plist version and schema, compare binary and icon hashes with the packaged source, verify `lipo -info`, and confirm LaunchServices resolves the launcher.

- [ ] **Step 4: Open and visually inspect the panel**

Open `~/Applications/HeiGe 皮肤启动器.app`, confirm both cards, installed states, recent theme names, disabled states, diagnostics link, Miku icon, and no Terminal window.

- [ ] **Step 5: Run real Codex and WorkBuddy actions**

Click Codex and verify the selected recent theme is visible in Codex. Reopen the launcher, click WorkBuddy, and verify its selected recent theme is visible. Confirm the two state files retain separate theme IDs and no WorkBuddy LaunchAgent was created.

- [ ] **Step 6: Record residual boundaries**

Document anything not target-environment verified, including Intel hardware execution if only universal binary inspection was possible. Do not claim GitHub publication or notarization.
