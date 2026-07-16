#!/bin/zsh
set -euo pipefail

PLIST_PATH="$1"
LABEL="$2"
RUNNER="$3"
ACTION="$4"
PATCHER="$5"
LOG_PATH="$6"
NODE_BIN="$7"

mkdir -p "${PLIST_PATH:h}"
rm -f "$PLIST_PATH"
/usr/bin/plutil -create xml1 "$PLIST_PATH"
/usr/bin/plutil -insert Label -string "$LABEL" "$PLIST_PATH"
/usr/bin/plutil -insert RunAtLoad -bool true "$PLIST_PATH"
/usr/bin/plutil -insert KeepAlive -bool false "$PLIST_PATH"
/usr/bin/plutil -insert ProcessType -string Background "$PLIST_PATH"
/usr/bin/plutil -insert StandardOutPath -string "$LOG_PATH" "$PLIST_PATH"
/usr/bin/plutil -insert StandardErrorPath -string "$LOG_PATH" "$PLIST_PATH"
/usr/bin/plutil -insert ProgramArguments -array "$PLIST_PATH"

arguments=(
  /bin/zsh
  "$RUNNER"
  "$ACTION"
  "$PATCHER"
  "$LOG_PATH"
  "$NODE_BIN"
  "$LABEL"
  "$PLIST_PATH"
)
for index in {1..${#arguments}}; do
  /usr/bin/plutil -insert "ProgramArguments.$(( index - 1 ))" -string "$arguments[$index]" "$PLIST_PATH"
done

/bin/chmod 600 "$PLIST_PATH"
/usr/bin/plutil -lint "$PLIST_PATH" >/dev/null
