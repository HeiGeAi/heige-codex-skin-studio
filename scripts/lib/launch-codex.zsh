#!/bin/zsh
set -euo pipefail

PORT="${1:-9341}"

if curl --silent --fail --max-time 1 "http://127.0.0.1:${PORT}/json/list" >/dev/null 2>&1; then
  return 0
fi

if pgrep -f '^/Applications/ChatGPT\.app/Contents/MacOS/ChatGPT' >/dev/null 2>&1; then
  echo "正在正常退出 Codex，以调试端口重新打开……"
  osascript -e 'tell application id "com.openai.codex" to quit' >/dev/null
  for _ in {1..120}; do
    pgrep -f '^/Applications/ChatGPT\.app/Contents/MacOS/ChatGPT' >/dev/null 2>&1 || break
    sleep 0.25
  done
  # 退出失败绝不能继续 open：单实例锁会把新实例转发给老实例，
  # 调试参数被丢弃、端口永远不开，表现为「参数没有保留」
  if pgrep -f '^/Applications/ChatGPT\.app/Contents/MacOS/ChatGPT' >/dev/null 2>&1; then
    echo "Codex 没有退出：可能弹出了退出确认框，或有任务正在运行。" >&2
    echo "请手动完全退出 Codex（Cmd+Q 并确认对话框），再重新运行本脚本。" >&2
    return 1
  fi
fi

open -na "/Applications/ChatGPT.app" --args \
  --remote-debugging-address=127.0.0.1 \
  "--remote-debugging-port=${PORT}"

for _ in {1..160}; do
  curl --silent --fail --max-time 1 "http://127.0.0.1:${PORT}/json/list" >/dev/null 2>&1 && return 0
  sleep 0.25
done

# 端口没开，按两类失败分别给指引
if pgrep -f '^/Applications/ChatGPT\.app/Contents/MacOS/ChatGPT.*remote-debugging-port' >/dev/null 2>&1; then
  echo "Codex 已带调试参数启动，但端口 ${PORT} 未开放：当前 Codex 版本可能禁用了本机调试端口。" >&2
  echo "请到 https://github.com/HeiGeAi/heige-codex-skin-studio/issues 反馈，并附上 Codex 版本号（菜单 -> 关于）。" >&2
else
  echo "新实例的调试参数没有生效（多半被残留的旧实例接管了）。" >&2
  echo "请手动完全退出 Codex（Cmd+Q，活动监视器里确认没有 ChatGPT 进程），再重新运行本脚本。" >&2
fi
return 1
