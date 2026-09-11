#!/usr/bin/env bash
set -euo pipefail

# Compile the macOS on-device dictation helper (Swift → dist/native/maestro-dictation).
# A universal (arm64 + x86_64) binary when both slices build, else the host arch.
# Off macOS — or without the Swift toolchain — it writes a placeholder so
# electron-builder's extraResources entry still resolves (main-process code never
# invokes the helper except on darwin).

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src/native/dictation/main.swift"
PLIST="$ROOT/src/native/dictation/Info.plist"
OUT_DIR="$ROOT/dist/native"
OUT="$OUT_DIR/maestro-dictation"
mkdir -p "$OUT_DIR"

placeholder() {
  # Non-macOS / no-toolchain: unused stub so packaging doesn't fail on a missing path.
  printf '#!/bin/sh\nexit 0\n' >"$OUT"
  chmod +x "$OUT"
  echo "build-helper: $1 — wrote placeholder"
  exit 0
}

[ "$(uname)" = "Darwin" ] || placeholder "not macOS"
command -v swiftc >/dev/null 2>&1 || placeholder "swiftc not found (install Xcode Command Line Tools)"

COMMON=(-O -swift-version 5 -framework Speech -framework AVFoundation
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$PLIST")

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ok_arm=0
ok_x64=0
swiftc "${COMMON[@]}" -target arm64-apple-macos12 "$SRC" -o "$TMP/arm64" && ok_arm=1 || true
swiftc "${COMMON[@]}" -target x86_64-apple-macos12 "$SRC" -o "$TMP/x64" && ok_x64=1 || true

if [ "$ok_arm" = 1 ] && [ "$ok_x64" = 1 ]; then
  lipo -create "$TMP/arm64" "$TMP/x64" -output "$OUT"
elif [ "$ok_arm" = 1 ]; then
  cp "$TMP/arm64" "$OUT"
  echo "build-helper: x86_64 slice failed — shipping arm64-only" >&2
elif [ "$ok_x64" = 1 ]; then
  cp "$TMP/x64" "$OUT"
  echo "build-helper: arm64 slice failed — shipping x86_64-only" >&2
else
  echo "build-helper: swiftc failed for both architectures" >&2
  exit 1
fi

chmod +x "$OUT"
echo "build-helper: wrote $OUT"
lipo -info "$OUT" 2>/dev/null || true
