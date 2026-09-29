#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
mkdir -p "$ROOT/.build/caches/clang" "$ROOT/.build/caches/swiftpm"
export CLANG_MODULE_CACHE_PATH="${CLANG_MODULE_CACHE_PATH:-$ROOT/.build/caches/clang}"
export SWIFTPM_MODULECACHE_OVERRIDE="${SWIFTPM_MODULECACHE_OVERRIDE:-$ROOT/.build/caches/swiftpm}"
TOOLS_DIR="$ROOT/.build/tools"
PROBE_BINARY="$TOOLS_DIR/celldock_production_call_probe"
PROBE_APP="$TOOLS_DIR/VoDog Production Call Probe.app"

mkdir -p "$TOOLS_DIR"
xcrun clang \
  -std=c11 \
  -O2 \
  -Wall -Wextra -Werror \
  -mmacosx-version-min=14.0 \
  -I "$ROOT/Sources/CModemBridge/include" \
  -c "$ROOT/Sources/CModemBridge/ModemBridge.c" \
  -o "$TOOLS_DIR/ModemBridge.production-probe.o"
xcrun clang \
  -std=c11 \
  -O2 \
  -Wall -Wextra -Werror \
  -mmacosx-version-min=14.0 \
  -I "$ROOT/Sources/CUACProbe/include" \
  -c "$ROOT/Sources/CUACProbe/CUACProbe.c" \
  -o "$TOOLS_DIR/CUACProbe.production-probe.o"

swiftc \
  -swift-version 5 \
  -target arm64-apple-macosx14.0 \
  -I "$ROOT/Sources/CModemBridge/include" \
  -I "$ROOT/Sources/CUACProbe/include" \
  -Xcc "-fmodule-map-file=$ROOT/tools/CModemBridge.modulemap" \
  -Xcc "-fmodule-map-file=$ROOT/tools/CUACProbe.modulemap" \
  "$ROOT/Sources/VoDog/AppLanguage.swift" \
  "$ROOT/Sources/VoDog/ADBProtocol.swift" \
  "$ROOT/Sources/VoDog/ADBModuleController.swift" \
  "$ROOT/Sources/VoDog/ATConsoleModels.swift" \
  "$ROOT/Sources/VoDog/ATResponseParser.swift" \
  "$ROOT/Sources/VoDog/CarrierNameFormatter.swift" \
  "$ROOT/Sources/VoDog/CallATParser.swift" \
  "$ROOT/Sources/VoDog/CallModels.swift" \
  "$ROOT/Sources/VoDog/CallRecordingStore.swift" \
  "$ROOT/Sources/VoDog/Models.swift" \
  "$ROOT/Sources/VoDog/QADBKeyDeriver.swift" \
  "$ROOT/Sources/VoDog/SMSPDUDecoder.swift" \
  "$ROOT/Sources/VoDog/SMSPDUEncoder.swift" \
  "$ROOT/Sources/VoDog/SMSVerificationCode.swift" \
  "$ROOT/Sources/VoDog/ModuleVoicePayload.swift" \
  "$ROOT/Sources/VoDog/ModuleVoiceRuntime.swift" \
  "$ROOT/Sources/VoDog/VoiceAudioService.swift" \
  "$ROOT/Sources/VoDog/VoiceSignalProcessor.swift" \
  "$ROOT/Sources/VoDog/ModemService.swift" \
  "$ROOT/Sources/VoDog/USBInterfaceContentionResolver.swift" \
  "$ROOT/tools/production_call_probe.swift" \
  "$TOOLS_DIR/ModemBridge.production-probe.o" \
  "$TOOLS_DIR/CUACProbe.production-probe.o" \
  -framework AVFoundation \
  -framework AppKit \
  -framework AudioToolbox \
  -framework CoreAudio \
  -framework CoreFoundation \
  -framework IOKit \
  -framework UniformTypeIdentifiers \
  -o "$PROBE_BINARY"

rm -rf -- "$PROBE_APP"
mkdir -p \
  "$PROBE_APP/Contents/MacOS" \
  "$PROBE_APP/Contents/Resources/ModuleVoice-Notices"
cp "$ROOT/Resources/ProductionCallProbe-Info.plist" "$PROBE_APP/Contents/Info.plist"
cp "$PROBE_BINARY" "$PROBE_APP/Contents/MacOS/celldock_production_call_probe"
xcrun swift "$ROOT/scripts/build_module_voice_payload.swift" \
  "$ROOT/Resources/ModuleVoice" \
  "$PROBE_APP/Contents/Resources/ModuleVoice.payload" >/dev/null
cp "$ROOT/docs/COPYING-GPL-2.0" \
  "$PROBE_APP/Contents/Resources/ModuleVoice-Notices/COPYING-GPL-2.0"
cp "$ROOT/docs/MODULE-REPORT.md" \
  "$PROBE_APP/Contents/Resources/ModuleVoice-Notices/MODULE-REPORT.md"
xattr -cr "$PROBE_APP"
codesign --force --deep --sign - "$PROBE_APP"
codesign --verify --deep --strict --verbose=2 "$PROBE_APP"
plutil -lint "$PROBE_APP/Contents/Info.plist" >/dev/null
[[ -f "$PROBE_APP/Contents/Resources/ModuleVoice.payload" ]]
if find "$PROBE_APP" -type f -name '*.ko' -print -quit | grep -q .; then
  print -u2 "Production call probe exposes a standalone kernel module."
  exit 1
fi

print "$PROBE_APP"
