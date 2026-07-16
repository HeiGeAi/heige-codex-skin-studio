#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/heige-codex-skin.XXXXXX")
TARGET="$STAGE/heige-codex-skin-studio"
trap 'rm -rf "$STAGE"' EXIT
if (( ${+HEIGE_SKILL_OUTPUT} )); then
  if [[ -z "$HEIGE_SKILL_OUTPUT" ]]; then
    echo "HEIGE_SKILL_OUTPUT must not be empty" >&2
    exit 64
  fi
  if [[ "$HEIGE_SKILL_OUTPUT" != /* ]]; then
    echo "HEIGE_SKILL_OUTPUT must be an absolute path" >&2
    exit 64
  fi
  OUTPUT="$HEIGE_SKILL_OUTPUT"
else
  OUTPUT="$ROOT/output/heige-codex-skin-studio.skill"
fi

mkdir -p "$TARGET/payload" "${OUTPUT:h}"
cp "$ROOT/skill/heige-codex-skin-studio/SKILL.md" "$TARGET/"
cp "$ROOT/skill/heige-codex-skin-studio/README.md" "$TARGET/"
cp -R "$ROOT/skill/heige-codex-skin-studio/scripts" "$TARGET/"
cp "$ROOT/package.json" "$TARGET/payload/"
cp -R "$ROOT/src" "$TARGET/payload/"
cp -R "$ROOT/themes" "$TARGET/payload/"
cp -R "$ROOT/custom-pet" "$TARGET/payload/"
cp -R "$ROOT/scripts" "$TARGET/payload/"

rm -f "$OUTPUT"
(cd "$STAGE" && /usr/bin/zip -X -q -r "$OUTPUT" heige-codex-skin-studio)
unzip -tq "$OUTPUT" >/dev/null
echo "$OUTPUT"
