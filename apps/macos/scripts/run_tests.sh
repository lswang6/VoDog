#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
export CLANG_MODULE_CACHE_PATH="$ROOT/.build/caches/clang"
export SWIFTPM_MODULECACHE_OVERRIDE="$ROOT/.build/caches/swiftpm"
mkdir -p "$ROOT/.build/caches/clang" "$ROOT/.build/caches/swiftpm"
export CLANG_MODULE_CACHE_PATH="${CLANG_MODULE_CACHE_PATH:-$ROOT/.build/caches/clang}"
export SWIFTPM_MODULECACHE_OVERRIDE="${SWIFTPM_MODULECACHE_OVERRIDE:-$ROOT/.build/caches/swiftpm}"
mkdir -p "$ROOT/.build/self-tests"

for language in zh-Hans en ja fr; do
  localization_dir="$ROOT/Resources/Localization/$language.lproj"
  plutil -lint "$localization_dir/Localizable.strings" >/dev/null
  plutil -lint "$localization_dir/InfoPlist.strings" >/dev/null
done
"$ROOT/scripts/check_localizations.py"

python3 "$ROOT/scripts/create_test_voice_runtime.py"

xcrun swift "$ROOT/scripts/build_module_voice_payload.swift" \
  "$ROOT/.build/self-tests/voice-fixture" \
  "$ROOT/.build/self-tests/ModuleVoice.payload" >/dev/null
xcrun swift "$ROOT/scripts/build_module_voice_payload.swift" \
  "$ROOT/.build/self-tests/voice-fixture" \
  "$ROOT/.build/self-tests/ModuleVoice.second.payload" >/dev/null
cmp \
  "$ROOT/.build/self-tests/ModuleVoice.payload" \
  "$ROOT/.build/self-tests/ModuleVoice.second.payload"

swiftc \
  -swift-version 5 \
  "$ROOT/Sources/VoDog/AppLanguage.swift" \
  "$ROOT/Sources/VoDog/AppIdentityMigration.swift" \
  "$ROOT/Sources/VoDog/CellularModuleID.swift" \
  "$ROOT/Sources/VoDog/CallModels.swift" \
  "$ROOT/Sources/VoDog/CallHistoryStore.swift" \
  "$ROOT/Sources/VoDog/PhoneNumberNormalizer.swift" \
  "$ROOT/Sources/VoDog/CallATParser.swift" \
  "$ROOT/Sources/VoDog/ATConsoleModels.swift" \
  "$ROOT/Sources/VoDog/VoiceSignalProcessor.swift" \
  "$ROOT/Sources/VoDog/CarrierNameFormatter.swift" \
  "$ROOT/Sources/VoDog/NotificationRouting.swift" \
  "$ROOT/Sources/VoDog/LaunchAtLoginController.swift" \
  "$ROOT/Sources/VoDog/ADBProtocol.swift" \
  "$ROOT/Sources/VoDog/ModuleVoicePayload.swift" \
  "$ROOT/Sources/VoDogNetworkIPC/VoDogNetworkIPC.swift" \
  "$ROOT/Sources/VoDogNetworkHelper/NetworkHelperState.swift" \
  "$ROOT/Sources/VoDog/Models.swift" \
  "$ROOT/Sources/VoDog/QADBKeyDeriver.swift" \
  "$ROOT/Sources/VoDog/MessageConversation.swift" \
  "$ROOT/Sources/VoDog/CellularLinkRecovery.swift" \
  "$ROOT/Sources/VoDog/CellularModuleModels.swift" \
  "$ROOT/Sources/VoDog/NetworkThroughput.swift" \
  "$ROOT/Sources/VoDog/DeletedMessageRegistry.swift" \
  "$ROOT/Sources/VoDog/EUICCModels.swift" \
  "$ROOT/Sources/VoDog/ATResponseParser.swift" \
  "$ROOT/Sources/VoDog/SMSPDUDecoder.swift" \
  "$ROOT/Sources/VoDog/SMSPDUEncoder.swift" \
  "$ROOT/Sources/VoDog/SMSVerificationCode.swift" \
  "$ROOT/Sources/VoDog/SOCKSProtocol.swift" \
  "$ROOT/Sources/VoDog/BoundSocket.swift" \
  "$ROOT/Sources/VoDog/SOCKSDNSResolver.swift" \
  "$ROOT/Sources/VoDog/SOCKSProxyModels.swift" \
  "$ROOT/Sources/VoDog/VoWiFiRuntimeModels.swift" \
  "$ROOT/Sources/VoDog/VoWiFiRuntimeControl.swift" \
  "$ROOT/Sources/VoDog/VoWiFiUpstreamProxyModels.swift" \
  "$ROOT/Sources/VoDog/VerificationMessageAutoDelete.swift" \
  "$ROOT/Tests/SelfTests/main.swift" \
  -o "$ROOT/.build/self-tests/VoDogSelfTests"

"$ROOT/.build/self-tests/VoDogSelfTests"

swiftc \
  -swift-version 5 \
  "$ROOT/Sources/VoDog/AppLanguage.swift" \
  "$ROOT/Sources/VoDog/AppIdentityMigration.swift" \
  "$ROOT/Sources/VoDog/CellularModuleID.swift" \
  "$ROOT/Sources/VoDog/CallModels.swift" \
  "$ROOT/Sources/VoDog/CallRecordingStore.swift" \
  "$ROOT/Sources/VoDog/CallRecordingWaveform.swift" \
  "$ROOT/Tests/CallRecordingSelfTests/main.swift" \
  -framework AppKit \
  -framework AudioToolbox \
  -framework AVFoundation \
  -framework UniformTypeIdentifiers \
  -o "$ROOT/.build/self-tests/CallRecordingSelfTests"

"$ROOT/.build/self-tests/CallRecordingSelfTests"

swiftc \
  -swift-version 5 \
  "$ROOT/Sources/VoDog/AppLanguage.swift" \
  "$ROOT/Sources/VoDog/PhoneNumberNormalizer.swift" \
  "$ROOT/Sources/VoDog/SystemContactStore.swift" \
  "$ROOT/Tests/ContactStoreSelfTests/main.swift" \
  -framework AppKit \
  -framework Contacts \
  -o "$ROOT/.build/self-tests/ContactStoreSelfTests"

"$ROOT/.build/self-tests/ContactStoreSelfTests"

xcrun clang \
  -std=c11 \
  -O2 \
  -Wall \
  -Wextra \
  -Werror \
  -I "$ROOT/Sources/CUACProbe/include" \
  "$ROOT/Tests/CUACProbeSelfTests.c" \
  -framework CoreAudio \
  -framework CoreFoundation \
  -framework IOKit \
  -o "$ROOT/.build/self-tests/CUACProbeSelfTests"

"$ROOT/.build/self-tests/CUACProbeSelfTests"

xcrun clang \
  -std=c11 \
  -O2 \
  -Wall \
  -Wextra \
  -Werror \
  -I "$ROOT/Sources/CModemBridge/include" \
  "$ROOT/Sources/CModemBridge/ModemBridge.c" \
  "$ROOT/Tests/CModemBridgeSelfTests.c" \
  -framework CoreFoundation \
  -framework IOKit \
  -o "$ROOT/.build/self-tests/CModemBridgeSelfTests"

"$ROOT/.build/self-tests/CModemBridgeSelfTests"

EUICC_SOURCES=(
  "$ROOT/Sources/CEuiccCore/VoDogEUICCBridge.c"
  "$ROOT/Sources/CEuiccCore/Vendor/lpac/cjson/cJSON.c"
  "$ROOT/Sources/CEuiccCore/Vendor/lpac/cjson/cJSON_ex.c"
  "$ROOT/Sources/CEuiccCore/Vendor/lpac/euicc/base64.c"
  "$ROOT/Sources/CEuiccCore/Vendor/lpac/euicc/derutil.c"
  "$ROOT/Sources/CEuiccCore/Vendor/lpac/euicc/es8p.c"
  "$ROOT/Sources/CEuiccCore/Vendor/lpac/euicc/es9p.c"
  "$ROOT/Sources/CEuiccCore/Vendor/lpac/euicc/es9p_errors.c"
  "$ROOT/Sources/CEuiccCore/Vendor/lpac/euicc/es10a.c"
  "$ROOT/Sources/CEuiccCore/Vendor/lpac/euicc/es10b.c"
  "$ROOT/Sources/CEuiccCore/Vendor/lpac/euicc/es10c.c"
  "$ROOT/Sources/CEuiccCore/Vendor/lpac/euicc/es10c_ex.c"
  "$ROOT/Sources/CEuiccCore/Vendor/lpac/euicc/euicc.c"
  "$ROOT/Sources/CEuiccCore/Vendor/lpac/euicc/hexutil.c"
  "$ROOT/Sources/CEuiccCore/Vendor/lpac/euicc/interface.c"
  "$ROOT/Sources/CEuiccCore/Vendor/lpac/euicc/sha256.c"
  "$ROOT/Sources/CEuiccCore/Vendor/lpac/euicc/tostr.c"
)

xcrun clang \
  -std=c11 \
  -O2 \
  -Wall \
  -Wextra \
  -Werror \
  -Wno-sign-compare \
  -Wno-shorten-64-to-32 \
  -Wno-unused-parameter \
  -I "$ROOT/Sources/CEuiccCore/include" \
  -I "$ROOT/Sources/CEuiccCore/Vendor/lpac" \
  "${EUICC_SOURCES[@]}" \
  "$ROOT/Tests/CEuiccCoreSelfTests.c" \
  -o "$ROOT/.build/self-tests/CEuiccCoreSelfTests"

"$ROOT/.build/self-tests/CEuiccCoreSelfTests"
