#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h:h}"

fail() {
  print -u2 -- "HeiGe Codex Skin Studio：$1"
  exit "${2:-1}"
}

probe_node() {
  local candidate="$1"
  local source="$2"
  if [[ "$candidate" != /* ]]; then
    NODE_ERROR="$source 必须是绝对路径：$candidate"
    return 1
  fi
  if [[ ! -f "$candidate" || ! -x "$candidate" ]]; then
    NODE_ERROR="$source 不可执行或不存在：$candidate"
    return 1
  fi
  local version
  if ! version="$($candidate --version 2>/dev/null)"; then
    NODE_ERROR="$source 无法报告 Node.js 版本：$candidate"
    return 1
  fi
  version="${version//$'\r'/}"
  if [[ ! "$version" =~ '^v?[0-9]+\.[0-9]+\.[0-9]+([+-].*)?$' ]]; then
    NODE_ERROR="$source 返回了不可解析的 Node.js 版本：$version"
    return 1
  fi
  local major="${version#v}"
  major="${major%%.*}"
  if (( major < 22 )); then
    NODE_ERROR="$source 必须是 Node.js 22 或更高版本，实际为 $version"
    return 1
  fi
  REPLY="$candidate"
  return 0
}

validate_node() {
  probe_node "$1" "$2" || fail "$NODE_ERROR" 127
}

app_node() {
  local app="$1"
  local source="$2"
  validate_app "$app" "$source"
  local candidate
  for candidate in \
    "$app/Contents/Resources/cua_node/bin/node" \
    "$app/Contents/Resources/cua_node/node"; do
    if [[ -f "$candidate" && -x "$candidate" ]]; then
      if probe_node "$candidate" "$source 内置 Node"; then
        export HEIGE_CODEX_APP="$app"
        return 0
      fi
    fi
  done
  return 1
}

validate_app() {
  local app="$1"
  local source="$2"
  [[ "$app" == /* ]] || fail "$source 必须是绝对路径：$app"
  [[ -d "$app" && ! -L "$app" ]] || fail "$source 不存在或不是可信应用目录：$app"
  [[ -f "$app/Contents/MacOS/ChatGPT" ]] || fail "$source 缺少 Codex 主程序：$app"
}

validate_workbuddy_app() {
  local app="$1"
  local source="$2"
  [[ "$app" == /* ]] || fail "$source 必须是绝对路径：$app"
  [[ -d "$app" && ! -L "$app" ]] || fail "$source 不存在或不是可信应用目录：$app"
  # WorkBuddy 是标准 Electron 打包，主程序名就叫 Electron，不是应用名
  [[ -f "$app/Contents/MacOS/Electron" ]] || fail "$source 缺少 WorkBuddy 主程序：$app"
}

# WorkBuddy 分支：它只带 node.tar.gz 压缩包，没有能直接执行的内置 Node，
# 所以不走下面那套「先找宿主内置 node」的逻辑，直接要系统 Node 22+。
# 校验也换成 WorkBuddy 自己的：拿 ChatGPT 主程序去校 WorkBuddy 必然误报。
if [[ "${HEIGE_SKIN_PRODUCT:-codex}" == "workbuddy" ]]; then
  if (( ${+HEIGE_WORKBUDDY_APP} )); then
    [[ -n "$HEIGE_WORKBUDDY_APP" ]] || fail "HEIGE_WORKBUDDY_APP 不能为空"
    validate_workbuddy_app "$HEIGE_WORKBUDDY_APP" "HEIGE_WORKBUDDY_APP"
    export HEIGE_WORKBUDDY_APP
  fi
  if (( ${+HEIGE_NODE} )); then
    [[ -n "$HEIGE_NODE" ]] || fail "HEIGE_NODE 不能为空"
    validate_node "$HEIGE_NODE" "HEIGE_NODE"
  else
    candidate="$(command -v node 2>/dev/null || true)"
    [[ -n "$candidate" ]] || fail "WorkBuddy 换肤需要系统 Node.js 22 或更高版本（WorkBuddy 自身不带可执行的 Node）" 127
    [[ "$candidate" == /* ]] || candidate="${candidate:A}"
    validate_node "$candidate" "系统 Node"
  fi
  exec "$REPLY" "$ROOT/src/cli.mjs" "$@"
fi

if (( ${+HEIGE_CODEX_APP} )); then
  [[ -n "$HEIGE_CODEX_APP" ]] || fail "HEIGE_CODEX_APP 不能为空"
  validate_app "$HEIGE_CODEX_APP" "HEIGE_CODEX_APP"
  export HEIGE_CODEX_APP
fi

if (( ${+HEIGE_NODE} )); then
  [[ -n "$HEIGE_NODE" ]] || fail "HEIGE_NODE 不能为空"
  validate_node "$HEIGE_NODE" "HEIGE_NODE"
  NODE="$REPLY"
elif (( ${+HEIGE_CODEX_APP} )); then
  app_node "$HEIGE_CODEX_APP" "HEIGE_CODEX_APP" || fail "HEIGE_CODEX_APP 中没有可用的 Node.js 22 运行时"
  NODE="$REPLY"
else
  NODE=""
  for app in "/Applications/ChatGPT.app" "$HOME/Applications/ChatGPT.app"; do
    if [[ -d "$app" && ! -L "$app" ]] && app_node "$app" "Codex Desktop"; then
      NODE="$REPLY"
      break
    fi
  done
  if [[ -z "$NODE" ]]; then
    candidate="$(command -v node 2>/dev/null || true)"
    [[ -n "$candidate" ]] || fail "没有找到 Node.js 22 或更高版本" 127
    [[ "$candidate" == /* ]] || candidate="${candidate:A}"
    validate_node "$candidate" "系统 Node"
    NODE="$REPLY"
  fi
fi

exec "$NODE" "$ROOT/src/cli.mjs" "$@"
