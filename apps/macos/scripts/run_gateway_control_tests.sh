#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
export CLANG_MODULE_CACHE_PATH="$ROOT/.build/caches/clang"
export SWIFTPM_MODULECACHE_OVERRIDE="$ROOT/.build/caches/swiftpm"
mkdir -p "$ROOT/.build/self-tests"

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
  "$ROOT/Tests/GatewayControlSelfTests/main.swift" \
  -o "$ROOT/.build/self-tests/GatewayControlSelfTests"

"$ROOT/.build/self-tests/GatewayControlSelfTests"
