#!/bin/zsh
set -euo pipefail
umask 077

ROOT="${0:A:h:h}"
VERSION="${1:-}"
PRODUCT="${2:-codex}"

case "$PRODUCT" in
  codex)
    PORT=9341
    APP_ARGS=()
    ;;
  workbuddy)
    PORT=9342
    APP_ARGS=(--app workbuddy)
    export HEIGE_SKIN_PRODUCT=workbuddy
    ;;
  *)
    print -u2 -- "HeiGe 皮肤启动器：不支持的产品：$PRODUCT"
    exit 64
    ;;
esac

exec "$ROOT/scripts/lib/run-cli.zsh" \
  launcher-repair \
  --launcher-version "$VERSION" \
  "${APP_ARGS[@]}" \
  --port "$PORT"
