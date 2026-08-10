#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
PORT="${HEIGE_WORKBUDDY_SKIN_PORT:-9342}"
export HEIGE_SKIN_PRODUCT=workbuddy
exec "$ROOT/scripts/lib/run-cli.zsh" restore --app workbuddy --port "$PORT"
