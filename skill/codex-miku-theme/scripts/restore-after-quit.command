#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
LOG_DIR="$HOME/Library/Logs/Codex Miku Theme"
LOG_PATH="$LOG_DIR/restore.log"
LABEL="com.heigeai.codex-miku-theme.restore"
DOMAIN="gui/$(/usr/bin/id -u)"
STAGING_ROOT="$HOME/Library/Application Support/Codex Miku Theme/installer"
PATCHER="$STAGING_ROOT/payload/src/theme-patch.mjs"
RUNNER="$STAGING_ROOT/scripts/lib/run-after-quit.zsh"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
PLIST_WRITER="$ROOT/scripts/lib/write-launch-agent.zsh"
NODE_BIN="$(command -v node)"

mkdir -p "$LOG_DIR"
mkdir -p "$STAGING_ROOT/payload" "$STAGING_ROOT/scripts/lib"
cp -R "$ROOT/payload/." "$STAGING_ROOT/payload/"
cp "$ROOT/scripts/install-pet.command" "$STAGING_ROOT/scripts/install-pet.command"
cp "$ROOT/scripts/lib/run-after-quit.zsh" "$RUNNER"
/bin/launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || \
  /bin/launchctl remove "$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST_PATH"
/bin/zsh "$PLIST_WRITER" "$PLIST_PATH" "$LABEL" "$RUNNER" restore "$PATCHER" "$LOG_PATH" "$NODE_BIN"
/bin/launchctl bootstrap "$DOMAIN" "$PLIST_PATH"

echo "恢复已排队。"
echo "现在按 Command + Q 完全退出 Codex；恢复完成后 Codex 会自动重新打开。"
