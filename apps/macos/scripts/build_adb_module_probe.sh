#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
mkdir -p "$ROOT/.build/caches/clang" "$ROOT/.build/caches/swiftpm"
export CLANG_MODULE_CACHE_PATH="${CLANG_MODULE_CACHE_PATH:-$ROOT/.build/caches/clang}"
export SWIFTPM_MODULECACHE_OVERRIDE="${SWIFTPM_MODULECACHE_OVERRIDE:-$ROOT/.build/caches/swiftpm}"
mkdir -p "$ROOT/.build/tools"
xcrun clang \
  -std=c11 \
  -O2 \
  -Wall -Wextra -Werror \
  -mmacosx-version-min=14.0 \
  -I "$ROOT/Sources/CModemBridge/include" \
  -c "$ROOT/Sources/CModemBridge/ModemBridge.c" \
  -o "$ROOT/.build/tools/ModemBridge.probe.o"

swiftc \
  -swift-version 5 \
  -D DEBUG \
  -I "$ROOT/Sources/CModemBridge/include" \
  -Xcc "-fmodule-map-file=$ROOT/tools/CModemBridge.modulemap" \
  "$ROOT/Sources/VoDog/AppLanguage.swift" \
  "$ROOT/Sources/VoDog/VoWiFiRuntimeModels.swift" \
  "$ROOT/Sources/VoDog/VoWiFiRuntimeControl.swift" \
  "$ROOT/Sources/VoDog/ADBProtocol.swift" \
  "$ROOT/Sources/VoDog/ADBModuleController.swift" \
  "$ROOT/Sources/VoDog/ModuleVoicePayload.swift" \
  "$ROOT/Sources/VoDog/ModuleVoiceRuntime.swift" \
  "$ROOT/tools/adb_module_probe.swift" \
  "$ROOT/.build/tools/ModemBridge.probe.o" \
  -framework IOKit \
  -framework CoreFoundation \
  -o "$ROOT/.build/tools/adb_module_probe"

print "$ROOT/.build/tools/adb_module_probe"
