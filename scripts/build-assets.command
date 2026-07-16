#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/assets/miku-reference.png"
PORTRAIT_SOURCE="$ROOT/assets/miku-portrait-reference.png"

for dependency in ffmpeg pngquant; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    echo "$dependency is required to rebuild the Miku crops." >&2
    exit 1
  fi
done

verify_hash() {
  local file="$1"
  local expected="$2"
  local actual
  actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  if [[ "$actual" != "$expected" ]]; then
    echo "SHA-256 mismatch for $file: $actual" >&2
    exit 1
  fi
}

verify_hash "$SOURCE" "ffb05df56a95748266d6e52a1bbc70a073d706e0ec2930e60735f078241316e3"
verify_hash "$PORTRAIT_SOURCE" "a1e8e01ae1617d21de5e903a2de8591489bd28018d5f19b57626c251d262527c"

ffmpeg -hide_banner -loglevel error -y -i "$PORTRAIT_SOURCE" \
  -vf "scale=1240:698:flags=lanczos,eq=saturation=1.08:contrast=1.02" \
  -frames:v 1 "$ROOT/assets/miku-full-canvas-unquantized.png"
pngquant --force --colors 256 --speed 1 \
  --output "$ROOT/assets/miku-full-canvas.png" \
  -- "$ROOT/assets/miku-full-canvas-unquantized.png"
rm "$ROOT/assets/miku-full-canvas-unquantized.png"
ffmpeg -hide_banner -loglevel error -y -i "$PORTRAIT_SOURCE" \
  -vf "crop=2600:1604:2400:150,scale=608:375:flags=lanczos,eq=saturation=1.08:contrast=1.02" \
  -frames:v 1 "$ROOT/assets/miku-character.png"
ffmpeg -hide_banner -loglevel error -y -i "$SOURCE" \
  -vf "crop=320:2103:771:555,scale=98:644:flags=lanczos" -frames:v 1 "$ROOT/assets/miku-sidebar-wash.png"
ffmpeg -hide_banner -loglevel error -y -i "$SOURCE" \
  -vf "crop=744:751:4601:2299,scale=228:230:flags=lanczos" -frames:v 1 "$ROOT/assets/miku-polaroid.png"

verify_hash "$ROOT/assets/miku-full-canvas.png" "291ae75b07f133da9ad46a9716023cd0a23183a0070216b9ce9194193f8df292"
verify_hash "$ROOT/assets/miku-character.png" "4b203f967ed49db1c9a140d6637664700fcc5a2c948eb0d9a81645039272ca77"
verify_hash "$ROOT/assets/miku-sidebar-wash.png" "166774fc48661fb2de114623db325cb7649035282a27e963672bb7b49fc7b2e2"
verify_hash "$ROOT/assets/miku-polaroid.png" "d30fb69fcd0db2c02b26d6927125caf2f89a178945199ddd9ea86f9853ecd042"

echo "Rebuilt and verified the clean Miku hero artwork and three supporting crops."
