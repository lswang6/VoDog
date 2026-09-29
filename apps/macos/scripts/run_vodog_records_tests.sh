#!/bin/zsh
set -euo pipefail

# VoDog records/report self-tests (S54 C3): wire decoding, label mapping, time formatting.
# Pure Foundation; compiles only the model file.

ROOT="${0:A:h:h}"
export CLANG_MODULE_CACHE_PATH="$ROOT/.build/caches/clang"
export SWIFTPM_MODULECACHE_OVERRIDE="$ROOT/.build/caches/swiftpm"
OUT="$ROOT/.build/self-tests"
mkdir -p "$OUT" "$ROOT/.build/caches/clang"
export CLANG_MODULE_CACHE_PATH="${CLANG_MODULE_CACHE_PATH:-$ROOT/.build/caches/clang}"

swiftc \
  -swift-version 5 \
  "$ROOT/Sources/VoDog/VoDog/VoDogRecordModels.swift" \
  "$ROOT/Tests/VoDogRecordsSelfTests/main.swift" \
  -framework AVFoundation \
  -o "$OUT/VoDogRecordsSelfTests"

"$OUT/VoDogRecordsSelfTests"
