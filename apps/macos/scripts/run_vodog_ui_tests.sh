#!/bin/zsh
set -euo pipefail

# S57 VoDog phone self-tests: SIM strip order/palette/badge, ringing filter, end retry policy,
# SMS threads, relay/offer policies. Compiles the logic file with the same model/contract set as run_vodog_tests.sh.

ROOT="${0:A:h:h}"
export CLANG_MODULE_CACHE_PATH="$ROOT/.build/caches/clang"
export SWIFTPM_MODULECACHE_OVERRIDE="$ROOT/.build/caches/swiftpm"
OUT="$ROOT/.build/self-tests"
mkdir -p "$OUT" "$ROOT/.build/caches/clang"
export CLANG_MODULE_CACHE_PATH="${CLANG_MODULE_CACHE_PATH:-$ROOT/.build/caches/clang}"

swiftc \
  -swift-version 5 \
  "$ROOT/Sources/VoDog/AppLanguage.swift" \
  "$ROOT/Sources/VoDog/CellularModuleID.swift" \
  "$ROOT/Sources/VoDog/CallModels.swift" \
  "$ROOT/Sources/VoDog/CallATParser.swift" \
  "$ROOT/Sources/VoDog/AppIdentityMigration.swift" \
  "$ROOT/Sources/VoDog/Gateway/GatewayContract.swift" \
  "$ROOT/Sources/VoDog/Gateway/GatewayLogic.swift" \
  "$ROOT/Sources/VoDog/Gateway/GatewayDiagLog.swift" \
  "$ROOT/Sources/VoDog/VoDog/VoDogModels.swift" \
  "$ROOT/Sources/VoDog/VoDog/VoDogContract.swift" \
  "$ROOT/Sources/VoDog/VoDog/VoDogPhoneLogic.swift" \
  "$ROOT/Tests/VoDogUISelfTests/main.swift" \
  -o "$OUT/VoDogUISelfTests"

"$OUT/VoDogUISelfTests"
