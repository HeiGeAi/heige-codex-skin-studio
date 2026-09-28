#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
# 默认端口与显式参数交给 CLI 统一解析，保留 JSON 输出与退出码。
exec "$ROOT/scripts/lib/run-cli.zsh" compat --app codex "$@"
