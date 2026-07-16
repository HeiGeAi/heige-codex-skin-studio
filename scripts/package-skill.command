#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
OUTPUT="${1:-$ROOT/output/codex-miku-theme.skill}"
STAGING_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/codex-miku-skill.XXXXXX")"
ARCHIVE="$STAGING_ROOT/codex-miku-theme.skill"

cleanup() {
  rm -rf "$STAGING_ROOT"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "${OUTPUT:h}"

tracked_files=("${(@f)$(git -C "$ROOT" ls-files skill/codex-miku-theme)}")
if (( ${#tracked_files[@]} == 0 )); then
  echo "No tracked Codex Miku Skill files were found." >&2
  exit 1
fi

for tracked_path in "${tracked_files[@]}"; do
  relative_path="${tracked_path#skill/}"
  source_path="$ROOT/$tracked_path"
  destination_path="$STAGING_ROOT/$relative_path"
  mode="$(git -C "$ROOT" ls-files -s -- "$tracked_path" | awk '{print $1}')"

  test -f "$source_path"
  mkdir -p "${destination_path:h}"
  cp "$source_path" "$destination_path"
  if [[ "$mode" == "100755" ]]; then
    chmod 755 "$destination_path"
  else
    chmod 644 "$destination_path"
  fi
  TZ=UTC touch -t 202001010000 "$destination_path"
done

file_list="$STAGING_ROOT/files.txt"
(
  cd "$STAGING_ROOT"
  find codex-miku-theme -type f -print | LC_ALL=C sort > "$file_list"
  TZ=UTC /usr/bin/zip -X -q "$ARCHIVE" -@ < "$file_list"
)

test -s "$ARCHIVE"
mv "$ARCHIVE" "$OUTPUT"
shasum -a 256 "$OUTPUT"
