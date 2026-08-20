#!/bin/zsh
set -euo pipefail
umask 077

ROOT="${0:A:h:h}"
PRODUCT="${1:-}"

case "$PRODUCT" in
  codex)
    ;;
  workbuddy)
    export HEIGE_SKIN_PRODUCT=workbuddy
    ;;
  *)
    print -u2 -- "HeiGe 皮肤启动器：不支持的产品：$PRODUCT"
    exit 64
    ;;
esac

exec "$ROOT/scripts/lib/run-cli.zsh" launcher-state --app "$PRODUCT"
