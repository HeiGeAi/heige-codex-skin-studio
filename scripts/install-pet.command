#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
SOURCE="$ROOT/custom-pet/miku-future"
TARGET="$HOME/.codex/pets/miku-future"

test -s "$SOURCE/pet.json"
test -s "$SOURCE/spritesheet.webp"
mkdir -p "$TARGET"
cp "$SOURCE/pet.json" "$TARGET/pet.json"
cp "$SOURCE/spritesheet.webp" "$TARGET/spritesheet.webp"

if grep -q '^selected-avatar-id = ' "$HOME/.codex/config.toml" && ! grep -q '^selected-avatar-id = "custom:miku-future"$' "$HOME/.codex/config.toml"; then
  cp "$HOME/.codex/config.toml" "$HOME/.codex/config.toml.bak-miku-pet-$(date +%Y%m%d-%H%M%S)"
  sed -i '' 's/^selected-avatar-id = .*/selected-avatar-id = "custom:miku-future"/' "$HOME/.codex/config.toml"
fi

echo "Miku Future 已安装到 $TARGET 并设为当前宠物"
