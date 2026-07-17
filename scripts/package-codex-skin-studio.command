#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
SOURCE="$ROOT/skill/codex-skin-studio"
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/codex-skin-studio.XXXXXX")
TARGET="$STAGE/codex-skin-studio"
OUTPUT="$ROOT/output/codex-skin-studio.skill"
trap 'rm -rf "$STAGE"' EXIT

EXPECTED=(
  "SKILL.md"
  "agents/openai.yaml"
  "examples/cyberpunk/prompt.md"
  "examples/cyberpunk/theme.json"
  "examples/slayers-xellos-night/hero.webp"
  "examples/slayers-xellos-night/theme.json"
  "scripts/apply.mjs"
  "scripts/create-theme.mjs"
  "scripts/persist.mjs"
  "templates/theme.json"
)

mkdir -p "$ROOT/output"
cp -R "$SOURCE" "$STAGE/"
find "$TARGET" -exec touch -t 198001010000 {} +

actual=$(cd "$TARGET" && find . -type f -print | sed 's#^./##' | sort)
expected=$(printf '%s\n' $EXPECTED | sort)
[[ "$actual" == "$expected" ]] || { print -u2 "unexpected files in codex-skin-studio Skill"; diff -u <(printf '%s\n' "$expected") <(printf '%s\n' "$actual"); exit 1; }

rm -f "$OUTPUT"
(cd "$STAGE" && /usr/bin/zip -X -q -r "$OUTPUT" codex-skin-studio)
/usr/bin/unzip -tq "$OUTPUT" >/dev/null
archive=$(/usr/bin/unzip -Z1 "$OUTPUT" | sort)
expected_archive=$(printf '%s\n' \
  'codex-skin-studio/' \
  'codex-skin-studio/agents/' \
  'codex-skin-studio/examples/' \
  'codex-skin-studio/examples/cyberpunk/' \
  'codex-skin-studio/examples/slayers-xellos-night/' \
  'codex-skin-studio/scripts/' \
  'codex-skin-studio/templates/' \
  $(printf 'codex-skin-studio/%s\n' $EXPECTED) | sort)
[[ "$archive" == "$expected_archive" ]] || { print -u2 "unexpected files in codex-skin-studio archive"; exit 1; }
print "$OUTPUT"
