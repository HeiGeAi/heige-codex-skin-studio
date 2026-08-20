#!/bin/zsh
set -euo pipefail
umask 077

ROOT="${0:A:h:h}"
VERSION="${1:-}"
PRODUCT="${2:-codex}"
ERROR_FILE="$(/usr/bin/mktemp -t heige-skin-launcher)"
trap '/bin/rm -f -- "$ERROR_FILE"' EXIT

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

set +e
"$ROOT/scripts/lib/run-cli.zsh" \
  launcher-apply \
  --launcher-version "$VERSION" \
  "${APP_ARGS[@]}" \
  --port "$PORT" \
  2>"$ERROR_FILE"
STATUS=$?
set -e

if (( STATUS == 0 )); then
  exit 0
fi

MESSAGE="$(<"$ERROR_FILE")"
MESSAGE="${MESSAGE//[[:cntrl:]]/ }"
MESSAGE="${MESSAGE[1,1200]}"
[[ -n "$MESSAGE" ]] || MESSAGE="启动器运行失败，请重新运行安装器。"

/usr/bin/osascript -l JavaScript -e 'function run(argv) {
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  app.displayDialog(argv[0], {
    withTitle: argv[1],
    buttons: ["好"],
    defaultButton: "好"
  });
}' -- "$MESSAGE" "HeiGe 皮肤启动器" >/dev/null 2>&1 || true

exit "$STATUS"
