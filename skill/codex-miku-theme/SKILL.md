---
name: codex-miku-theme
description: Use when a macOS Codex Desktop user asks for the Hatsune Miku or 初音未来 theme, cyan-pink full-canvas skin, matching animated pet, theme installation, theme status check, or safe restoration of the original Codex appearance.
compatibility: macOS, Codex Desktop 26.707.72221 build 5307, Node.js 20 or newer
---

# Codex Miku Theme

## Overview

Install the complete v5 488137 Miku theme, optimized sidebar, and matching native custom pet. The bundled installer validates the exact Codex build, creates a verified original backup, patches fixed-size ASAR entries atomically, installs `Miku Future` under the supported custom-pet directory, and refuses unsafe version mismatches.

## Use the bundled commands

Resolve every path relative to this `SKILL.md`. Do not copy the payload elsewhere or rewrite the patcher unless the user explicitly asks to port the theme to a new Codex build.

| User intent | Action |
|---|---|
| Install or enable the theme | Run `open scripts/install-after-quit.command`, then ask the user to press `Command + Q` once. The detached helper installs after Codex exits and reopens it. |
| Install or refresh only the pet | Run `scripts/install-pet.command`; then refresh the pet list and select `Miku Future`. |
| Check whether it is installed | Run `scripts/check.command` and summarize the JSON result. |
| Restore the official appearance | Run `open scripts/restore-after-quit.command`, then ask the user to press `Command + Q` once. |
| Codex is already fully closed | `scripts/install-now.command` may be run from Terminal or Finder. |

After installation, tell the user to open `设置 > 宠物`, refresh the list, and select the independent `Miku Future` pet.

## Safety boundary

- Treat `Unsupported Codex build` as a real compatibility boundary. Report the detected and supported builds; do not edit the version constants just to force installation.
- Never kill Codex automatically. The queued installer waits for the user to quit cleanly.
- Never delete or replace the verified backup, bypass hash checks, re-sign the app, or overwrite an ASAR changed by a Codex update.
- Installation changes the signed application resource. The bundled restore command returns the exact original ASAR if macOS rejects the modified app.
- The theme is macOS-only and currently targets `/Applications/ChatGPT.app`, the application bundle used by Codex Desktop.

## Successful handoff

Confirm these points concisely:

1. The compatibility check passed and installation is queued, or the theme is already installed.
2. The user only needs to quit Codex once; it will reopen automatically after installation.
3. The original appearance remains recoverable with `restore-after-quit.command`.

If installation fails, read `~/Library/Logs/Codex Miku Theme/install.log` and report the exact error without weakening the safety checks.
