#!/bin/zsh
set -euo pipefail

SOURCE="${0:A:h:h}"
TARGET="$HOME/.codex/heige-codex-skin-studio"

fail() {
  print -u2 -- "HeiGe Codex Skin Studio：$1"
  exit "${2:-1}"
}

probe_node() {
  local candidate="$1"
  local source="$2"
  [[ "$candidate" == /* ]] || fail "$source 必须是绝对路径：$candidate" 127
  [[ -f "$candidate" && -x "$candidate" ]] || fail "$source 不存在或不可执行：$candidate" 127
  local version
  version="$($candidate --version 2>/dev/null)" || fail "$source 无法报告 Node.js 版本：$candidate" 127
  version="${version//$'\r'/}"
  [[ "$version" =~ '^v?[0-9]+\.[0-9]+\.[0-9]+([+-].*)?$' ]] \
    || fail "$source 返回了不可解析的 Node.js 版本：$version" 127
  local major="${version#v}"
  major="${major%%.*}"
  (( major >= 22 )) || fail "$source 必须是 Node.js 22 或更高版本，实际为 $version" 127
  REPLY="$candidate"
}

verify_signed_app() {
  local app="$1"
  local source="$2"
  if [[ "$app" != /* || ! -d "$app" || -L "$app" ]]; then
    NODE_ERROR="$source 不存在或不是可信绝对应用路径：$app"
    return 1
  fi
  if ! /usr/bin/codesign --verify --deep --strict -- "$app" >/dev/null 2>&1; then
    NODE_ERROR="$source 未通过 codesign --deep --strict 验证：$app"
    return 1
  fi
  local details line team_ok=0
  details="$(/usr/bin/codesign -dv --verbose=4 -- "$app" 2>&1)" || {
    NODE_ERROR="$source 无法读取签名归属：$app"
    return 1
  }
  for line in ${(f)details}; do
    [[ "$line" == "TeamIdentifier=2DC432GLL2" ]] && team_ok=1
  done
  if (( ! team_ok )); then
    NODE_ERROR="$source 签名 TeamIdentifier 不是 OpenAI（2DC432GLL2）：$app"
    return 1
  fi
}

node_from_app() {
  local app="$1"
  local source="$2"
  verify_signed_app "$app" "$source" || return 1
  local candidate
  for candidate in \
    "$app/Contents/Resources/cua_node/bin/node" \
    "$app/Contents/Resources/cua_node/node"; do
    if [[ -f "$candidate" && -x "$candidate" ]]; then
      probe_node "$candidate" "$source 内置 Node"
      return 0
    fi
  done
  NODE_ERROR="$source 中没有可用的 Node.js 22 运行时"
  return 1
}

if (( ${+HEIGE_NODE} )); then
  [[ -n "$HEIGE_NODE" ]] || fail "HEIGE_NODE 不能为空" 127
  probe_node "$HEIGE_NODE" "HEIGE_NODE"
  NODE="$REPLY"
elif (( ${+HEIGE_CODEX_APP} )); then
  [[ -n "$HEIGE_CODEX_APP" ]] || fail "HEIGE_CODEX_APP 不能为空" 127
  node_from_app "$HEIGE_CODEX_APP" "HEIGE_CODEX_APP" || fail "$NODE_ERROR" 127
  NODE="$REPLY"
else
  NODE=""
  for app in "/Applications/ChatGPT.app" "$HOME/Applications/ChatGPT.app"; do
    if [[ -d "$app" && ! -L "$app" ]] && node_from_app "$app" "Codex Desktop"; then
      NODE="$REPLY"
      break
    fi
  done
  if [[ -z "$NODE" ]]; then
    candidate="$(command -v node 2>/dev/null || true)"
    [[ -n "$candidate" ]] || fail "没有找到 Node.js 22 或更高版本" 127
    [[ "$candidate" == /* ]] || candidate="${candidate:A}"
    probe_node "$candidate" "系统 Node"
    NODE="$REPLY"
  fi
fi

install_failed() {
  print -u2 -- "HeiGe Codex Skin Studio：安装失败，可执行以下命令排查："
  print -u2 -- "  \"$NODE\" \"$TARGET/src/cli.mjs\" doctor"
  print -u2 -- "  \"$NODE\" \"$TARGET/src/cli.mjs\" status"
  exit 1
}

if [[ "$(uname -s)" == "Darwin" ]]; then
  "$NODE" "$SOURCE/src/macos-install-coordinator.mjs" \
    --source "$SOURCE" \
    --target "$TARGET" || install_failed
else
  "$NODE" "$SOURCE/src/install-transaction.mjs" install \
    --source "$SOURCE" \
    --target "$TARGET" || install_failed
fi

echo "HeiGe Codex Skin Studio 已安装到：$TARGET"
if [[ "${HEIGE_SKIP_APPLY:-0}" != "1" ]]; then
  open "$TARGET/scripts/apply.command"
  print -- "注入已在新 Terminal 窗口执行；若该窗口报失败，请运行：\"$NODE\" \"$TARGET/src/cli.mjs\" doctor"
fi
