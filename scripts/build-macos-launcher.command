#!/bin/zsh
set -euo pipefail
umask 077

ROOT="${0:A:h:h}"
SOURCE="$ROOT/native/macos-launcher/main.swift"
OUTPUT="$ROOT/assets/launcher/HeiGeSkinLauncher.bin"
TEMP_DIR="$(/usr/bin/mktemp -d -t heige-native-launcher)"
trap '/bin/rm -rf -- "$TEMP_DIR"' EXIT

[[ -f "$SOURCE" && ! -L "$SOURCE" ]] || {
  print -u2 -- "缺少原生启动器源码：$SOURCE"
  exit 1
}

SWIFTC="$(/usr/bin/xcrun --find swiftc)"
SDK="$(/usr/bin/xcrun --sdk macosx --show-sdk-path)"

compile_arch() {
  local target="$1"
  local output="$2"
  "$SWIFTC" \
    -swift-version 5 \
    -O \
    -whole-module-optimization \
    -sdk "$SDK" \
    -target "$target" \
    "$SOURCE" \
    -o "$output"
}

compile_arch arm64-apple-macos13.0 "$TEMP_DIR/launcher-arm64" &
ARM64_PID=$!
compile_arch x86_64-apple-macos13.0 "$TEMP_DIR/launcher-x86_64" &
X86_PID=$!
wait "$ARM64_PID"
wait "$X86_PID"

/usr/bin/lipo -create \
  "$TEMP_DIR/launcher-arm64" \
  "$TEMP_DIR/launcher-x86_64" \
  -output "$TEMP_DIR/HeiGeSkinLauncher.bin"
/usr/bin/lipo "$TEMP_DIR/HeiGeSkinLauncher.bin" -verify_arch arm64 x86_64
/bin/chmod 755 "$TEMP_DIR/HeiGeSkinLauncher.bin"
/bin/mv -f "$TEMP_DIR/HeiGeSkinLauncher.bin" "$OUTPUT"
/bin/chmod 755 "$OUTPUT"
/usr/bin/lipo -info "$OUTPUT"
