#!/bin/zsh
set -euo pipefail

ACTION="$1"
PATCHER="$2"
LOG_PATH="$3"
NODE_BIN="$4"
LABEL="$5"
PLIST_PATH="$6"
DOMAIN="gui/$(/usr/bin/id -u)"
MAX_PATCH_ATTEMPTS=300

cleanup() {
  local exit_code="${1:-$?}"
  trap - EXIT HUP INT TERM
  echo "[$(/bin/date -Iseconds)] Unloading queued $ACTION job with status $exit_code"
  if (( exit_code == 0 )); then
    /usr/bin/open /Applications/ChatGPT.app >/dev/null 2>&1 || true
  else
    echo "Queued $ACTION failed; leaving Codex closed to avoid a reconnect loop"
  fi
  /bin/rm -f "$PLIST_PATH"
  /bin/launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  return "$exit_code"
}

trap 'cleanup $?' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

exec >>"$LOG_PATH" 2>&1
echo "[$(/bin/date -Iseconds)] Waiting for Codex to exit before $ACTION"

while /usr/bin/pgrep -f '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' >/dev/null 2>&1; do
  /bin/sleep 0.2
done

run_patch() {
  local operation="$1"
  local attempt=1
  local output=""
  local exit_code=1

  while (( attempt <= MAX_PATCH_ATTEMPTS )); do
    if output="$("$NODE_BIN" "$PATCHER" "$operation" 2>&1)"; then
      print -r -- "$output"
      return 0
    else
      exit_code=$?
    fi
    print -r -- "$output"

    if [[ "$output" != *"Fully quit Codex with Command+Q"* ]]; then
      return "$exit_code"
    fi
    if (( attempt == MAX_PATCH_ATTEMPTS )); then
      echo "Codex helper processes did not stop after $MAX_PATCH_ATTEMPTS attempts"
      return "$exit_code"
    fi

    echo "Codex Renderer or Service is still exiting; retrying $operation ($attempt/$MAX_PATCH_ATTEMPTS)"
    /bin/sleep 0.2
    (( attempt += 1 ))
  done

  return "$exit_code"
}

if [[ "$ACTION" == "install" ]]; then
  "$NODE_BIN" "$PATCHER" check
  run_patch install
  "${PATCHER:h:h:h}/scripts/install-pet.command"
elif [[ "$ACTION" == "restore" ]]; then
  run_patch restore
else
  echo "Unsupported queued action: $ACTION"
  exit 64
fi

echo "[$(/bin/date -Iseconds)] $ACTION completed"
