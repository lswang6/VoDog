# VoDog macOS

macOS client and DJI QDC507 cellular gateway, derived from
[CellDock](https://github.com/celldock/celldock-for-mac). Original CellDock copyright
and the unchanged noncommercial LICENSE remain applicable. VoDog original additions
use AGPL-3.0-only; see Legal/LICENSING.md and docs/THIRD_PARTY_NOTICES.md.

## Build and checks

Requires macOS 14+, Swift 6 / Xcode command-line tools, Apple Silicon for the packaged
app, and Go 1.26.3+ for the bundled VoWiFi runtime. SwiftPM downloads pinned
LiveKitWebRTC 150.7871.01. The target Mac needs neither Go nor Xcode nor external adb.

```sh
swift build --disable-sandbox --cache-path .build/cache
scripts/run_tests.sh
for t in gateway_control gateway_media vodog vodog_contacts vodog_records vodog_ui; do
  scripts/run_${t}_tests.sh || exit $?
done
VODOG_SIGNING_MODE=development VODOG_CODESIGN_IDENTITY="Apple Development: <your identity>" scripts/build_app.sh
```

Output: outputs/VoDog-<version>-arm64-development.zip. Packaging requires a stable
certificate-backed identity; ad-hoc signing is rejected. Release mode requires Developer
ID. No certificate or team is supplied. VODOG_BUILD_VERSION overrides build-number
incrementing. Signing alone is not notarization.

## Configuration

Default server is https://vodog.example.invalid. Set VODOG_BASE_URL before launch, or
set VoDogBaseURL in preferences for org.vodog.macos, to an HTTPS origin without
credentials, path, query or fragment. Restart and sign in/pair fresh after a server
change. Gateway settings separately expose its pairing server URL. TURN/media addresses
come from your backend. Do not copy old Keychain or module credentials. Module gateway
credentials use /data/vodog/vodog-gateway.json, separate from the upstream namespace.

## Hardware

DJI QDC507 / Quectel EG25-G, suitable SIM/carrier voice/SMS plan and USB data required.
Convert factory USB 2CA3:4006 through the guarded app flow to 2C7C:0125 with ADB/audio
and ECM (usbnet=1). USB audio is 8 kHz. The optional, separately acquired ARMv7 runtime requires
kernel 3.18.44, card mdm9607-tomtom-i2s-snd-card and controlC0 plus PCM D4p/D4c/D5p/D6c.
This is not generic EG25 firmware support. Do not flash unrelated firmware. The app
exclusively owns USB. A logged-in GUI session is required; the network helper needs
administrator approval. eSIM requires a compatible eUICC, not an ordinary nano-SIM.

## Distribution status

Offline builds do not establish live cellular acceptance. QDC507 runtime binaries
are excluded because exact corresponding source/build patches were unavailable.
See module/RUNTIME.md for affected voice functionality and explicit optional packaging.
LGPL static relinking and separate AGPL VoWiFi runtime source obligations apply.
This export is not blanket AGPL relicensing. No live installation is part of validation.
