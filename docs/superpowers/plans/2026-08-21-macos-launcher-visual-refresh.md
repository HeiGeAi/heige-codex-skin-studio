# macOS Launcher Visual Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the launcher card letter placeholders with real installed application icons and ship a polished Miku digital-terminal AppKit interface as version 5.5.12.

**Architecture:** Keep the existing single-file AppKit launcher and all product actions unchanged. Add focused reusable views for the backdrop, status pills and product icon loading, then compose them inside the existing `ProductCardView` and `AppDelegate.buildWindow()` path. Package and install through the existing Schema 5 signed Bundle workflow.

**Tech Stack:** Swift 5 AppKit, Node.js built-in test runner, existing deterministic `.skill` packager, macOS ad hoc code signing.

---

### Task 1: Lock the visual contract with a failing regression test

**Files:**
- Modify: `test/native-macos-launcher.test.mjs`

- [ ] **Step 1: Replace the old card contract with real-icon and visual-structure assertions**

```js
assert.match(source, /NSWorkspace\.shared\.urlForApplication\(withBundleIdentifier:/);
assert.match(source, /NSWorkspace\.shared\.icon\(forFile:/);
assert.match(source, /LauncherBackdropView/);
assert.match(source, /StatusPillView/);
assert.match(source, /bezelColor/);
assert.doesNotMatch(source, /labelWithString: definition\.id == \.codex \? "C" : "W"/);
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test test/native-macos-launcher.test.mjs`

Expected: FAIL because the current source still creates the `C` and `W` letter marks and has no backdrop or status-pill view.

### Task 2: Implement the AppKit visual refresh

**Files:**
- Modify: `native/macos-launcher/main.swift`

- [ ] **Step 1: Add the adaptive backdrop and reusable status pill**

```swift
final class LauncherBackdropView: AppearanceSurfaceView {
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        NSGradient(
            starting: NSColor(red: 0.22, green: 0.84, blue: 0.81, alpha: 0.95),
            ending: NSColor(red: 0.96, green: 0.55, blue: 0.77, alpha: 0.95)
        )?.draw(in: NSRect(x: 0, y: bounds.height - 3, width: bounds.width, height: 3), angle: 0)
    }
}

final class StatusPillView: AppearanceSurfaceView {
    let label = NSTextField(labelWithString: "读取中")

    init(text: String, tint: NSColor) {
        super.init(backgroundColor: tint.withAlphaComponent(0.12), cornerRadius: 9)
        label.stringValue = text
        label.textColor = tint
    }

    required init?(coder: NSCoder) { nil }
}
```

- [ ] **Step 2: Replace the letter mark with a real application icon loader**

```swift
private func loadApplicationIcon() {
    if let appURL = NSWorkspace.shared.urlForApplication(
        withBundleIdentifier: definition.bundleIdentifier
    ) {
        appIcon.image = NSWorkspace.shared.icon(forFile: appURL.path)
    } else {
        appIcon.image = NSImage(systemSymbolName: fallbackSymbolName, accessibilityDescription: nil)
    }
}
```

- [ ] **Step 3: Recompose the product cards and footer**

Use a 48pt application icon, 17pt product title, status pill, icon-led recent-theme surface, product-colored native button, concise product note, and a footer with safety state, `Codex 9341`, `WorkBuddy 9342`, and diagnostics.

```swift
let identity = NSStackView(views: [appIcon, productText])
let recent = ThemeSummaryView(themeLabel: themeLabel, accentColor: accentColor)
actionButton.bezelColor = accentColor
let footer = NSStackView(views: [safetyStatus, codexPort, workbuddyPort, diagnostics])
```

- [ ] **Step 4: Run the focused tests and rebuild the universal binary**

Run: `scripts/build-macos-launcher.command && node --test test/native-macos-launcher.test.mjs test/macos-launcher.test.mjs`

Expected: both architectures reported and all focused tests PASS.

### Task 3: Release, install and visually verify 5.5.12

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/macos-launcher.mjs`
- Modify: `test/product-identity.test.mjs`
- Modify: `test/macos-launcher.test.mjs`
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `docs/manual.md`
- Modify: `llms-full.txt`
- Modify: `assets/launcher/HeiGeSkinLauncher.bin`
- Modify: `output/heige-codex-skin-studio.skill`
- Create: `docs/release/2026-08-21-v5.5.12-verification.md`

- [ ] **Step 1: Bump all product identity references to 5.5.12 and document the visual change**

Update current version assertions and launcher plist defaults from `5.5.11` to `5.5.12`. Add a changelog entry describing real APP icons, adaptive visual hierarchy and unchanged injection behavior.

- [ ] **Step 2: Synchronize public docs and build the deterministic package**

Run:

```bash
node scripts/sync-llms.mjs
HEIGE_ALLOW_TRACKED_PACKAGE_OUTPUT=1 node scripts/package-skill.mjs \
  --output '/Users/blakexu/.codex/worktrees/macos-launcher-v3/Codex 皮肤/output/heige-codex-skin-studio.skill' \
  --source-date-epoch 1704067200
```

Expected: one `.skill` path and a stable SHA-256 after rebuilding twice.

- [ ] **Step 3: Run the complete release gate**

Run: `umask 022; npm run release:check`

Expected: 0 failures and the full provenance audit passes.

- [ ] **Step 4: Install only from the final artifact and inspect the real window**

Extract with `/usr/bin/ditto`, run the packaged `scripts/install.command`, reopen `/Users/blakexu/Applications/HeiGe 皮肤启动器.app`, and verify the real Codex and WorkBuddy icons, Dark appearance contrast, action labels, recent themes and footer state.

- [ ] **Step 5: Commit the verified local iteration**

```bash
git add native/macos-launcher/main.swift assets/launcher/HeiGeSkinLauncher.bin package.json package-lock.json src/macos-launcher.mjs test docs README.md CHANGELOG.md llms-full.txt output/heige-codex-skin-studio.skill
git commit -m "feat: polish macOS launcher interface (v5.5.12)"
```

Expected: clean worktree. Do not push, tag or publish a GitHub Release without explicit authorization.
