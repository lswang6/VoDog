#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
export CLANG_MODULE_CACHE_PATH="$ROOT/.build/caches/clang"
export SWIFTPM_MODULECACHE_OVERRIDE="$ROOT/.build/caches/swiftpm"
mkdir -p "$ROOT/.build/self-tests"

swiftc \
  -swift-version 5 \
  "$ROOT/Sources/VoDog/PhoneNumberNormalizer.swift" \
  "$ROOT/Sources/VoDog/VoDog/VoDogContactModels.swift" \
  "$ROOT/Tests/VoDogContactsSelfTests/main.swift" \
  -o "$ROOT/.build/self-tests/VoDogContactsSelfTests"

"$ROOT/.build/self-tests/VoDogContactsSelfTests"
