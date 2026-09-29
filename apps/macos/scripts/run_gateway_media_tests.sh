#!/bin/zsh
set -euo pipefail

# Gateway media/recording self-tests (pure logic, no WebRTC or modem). When the VoDog
# repo is next to this one (or VODOG_REPO points at it) and Go is installed, the archive
# objects the recorder produces are also checked by services/recording-archive-validator.

ROOT="${0:A:h:h}"
export CLANG_MODULE_CACHE_PATH="$ROOT/.build/caches/clang"
export SWIFTPM_MODULECACHE_OVERRIDE="$ROOT/.build/caches/swiftpm"
OUT="$ROOT/.build/self-tests"
mkdir -p "$OUT" "$ROOT/.build/caches/clang"
export CLANG_MODULE_CACHE_PATH="${CLANG_MODULE_CACHE_PATH:-$ROOT/.build/caches/clang}"

# S70: libopus (SwiftPM target COpus) as a static library, same defines as Package.swift.
COPUS="$ROOT/Sources/COpus"
COPUS_OUT="$OUT/copus"
rm -rf "$COPUS_OUT" && mkdir -p "$COPUS_OUT"
find "$COPUS" -name '*.c' -print0 | xargs -0 -P 8 -I{} sh -c \
  'xcrun clang -c -O2 -DOPUS_BUILD -DVAR_ARRAYS -DHAVE_LRINTF -DHAVE_LRINT -DENABLE_DEEP_PLC -I"$1/include" -I"$1/opus/celt" -I"$1/opus/silk" -I"$1/opus/silk/float" -I"$1/opus/src" -I"$1/opus/dnn" "$2" -o "$3/$(echo "$2" | shasum | cut -c1-16).o"' _ "$COPUS" {} "$COPUS_OUT"
xcrun libtool -static -o "$OUT/libcopus.a" "$COPUS_OUT"/*.o

swiftc \
  -swift-version 5 \
  -O \
  -I "$COPUS/include" \
  "$ROOT/Sources/VoDog/Gateway/GatewayContract.swift" \
  "$ROOT/Sources/VoDog/Gateway/GatewayAudio.swift" \
  "$ROOT/Sources/VoDog/Gateway/GatewayOpus.swift" \
  "$ROOT/Sources/VoDog/Gateway/GatewayRecording.swift" \
  "$ROOT/Tests/GatewayMediaSelfTests/Stubs.swift" \
  "$ROOT/Tests/GatewayMediaSelfTests/main.swift" \
  -framework AVFoundation \
  "$OUT/libcopus.a" \
  -lz \
  -o "$OUT/GatewayMediaSelfTests"

VALIDATOR_SRC="${VODOG_REPO:-$ROOT/../..}/services/recording-archive-validator"
if [[ -z "${GATEWAY_ARCHIVE_VALIDATOR:-}" && -d "$VALIDATOR_SRC" ]] && command -v go >/dev/null; then
  (cd "$VALIDATOR_SRC" && GOCACHE="$OUT/go-cache" GOMODCACHE="$OUT/go-mod" go build -o "$OUT/recording-archive-validator" .)
  export GATEWAY_ARCHIVE_VALIDATOR="$OUT/recording-archive-validator"
fi

"$OUT/GatewayMediaSelfTests"
