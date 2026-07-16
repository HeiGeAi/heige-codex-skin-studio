#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
SOURCE="$ROOT/payload/custom-pet/miku-future"
TARGET="$HOME/.codex/pets/miku-future"
CONFIG="$HOME/.codex/config.toml"

test -s "$SOURCE/pet.json"
test -s "$SOURCE/spritesheet.webp"
mkdir -p "$HOME/.codex"
mkdir -p "$TARGET"
cp "$SOURCE/pet.json" "$TARGET/pet.json"
cp "$SOURCE/spritesheet.webp" "$TARGET/spritesheet.webp"

[[ -e "$CONFIG" ]] || touch "$CONFIG"
if grep -q '^selected-avatar-id = "custom:miku-future"$' "$CONFIG"; then
  echo "Miku Future 已经是当前宠物，无需修改"
elif grep -q '^selected-avatar-id = ' "$CONFIG"; then
  cp "$CONFIG" "$CONFIG.bak-miku-pet-$(date +%Y%m%d-%H%M%S)"
  sed -i '' 's/^selected-avatar-id = .*/selected-avatar-id = "custom:miku-future"/' "$CONFIG"
  echo "Miku Future 已更新并设为当前宠物"
else
  [[ ! -s "$CONFIG" ]] || cp "$CONFIG" "$CONFIG.bak-miku-pet-$(date +%Y%m%d-%H%M%S)"
  [[ ! -s "$CONFIG" ]] || printf '\n' >> "$CONFIG"
  printf "selected-avatar-id = \"custom:miku-future\"\n" >> "$CONFIG"
  echo "Miku Future 已追加并设为当前宠物"
fi
