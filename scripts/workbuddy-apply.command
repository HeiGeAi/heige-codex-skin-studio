#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
PORT="${HEIGE_WORKBUDDY_SKIN_PORT:-9342}"
export HEIGE_SKIN_PRODUCT=workbuddy

RESTART_ARGS=()
if (( $# >= 1 )) && [[ "$1" == "--restart" ]]; then
  RESTART_ARGS=(--restart)
  shift
fi

if (( $# > 1 )); then
  print -u2 -- "用法：workbuddy-apply.command [--restart] [theme-id]"
  exit 64
fi
if (( $# == 1 )); then
  exec "$ROOT/scripts/lib/run-cli.zsh" apply --app workbuddy "${RESTART_ARGS[@]}" --theme "$1" --port "$PORT"
fi
exec "$ROOT/scripts/lib/run-cli.zsh" apply --app workbuddy "${RESTART_ARGS[@]}" --prefer-stored --port "$PORT"
