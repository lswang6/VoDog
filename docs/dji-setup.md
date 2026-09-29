# Set up the DJI module integration on macOS

[Documentation](README.md) · [简体中文](dji-setup.zh-CN.md) · [macOS component guide](../apps/macos/README.md)

## What is available

The integration targets **DJI QDC507 / Quectel EG25-G** on Apple-silicon macOS. Remote VoDog client features are buildable independently of module audio. This source export **does not include the QDC507 kernel modules or compiled module-side PCM payload** needed to initialize local/gateway voice. Exact corresponding source/build inputs for the kernel blobs were unavailable, so they are excluded; this is not a proprietary-license exception. Read the [runtime requirements and acquisition/build procedure](../apps/macos/module/RUNTIME.md).

Without a compliant, independently built compatible runtime, do not claim working DJI local calls, gateway audio, recording capture, or AI audio through that module. Modem data/SMS depend on firmware and still need hardware validation. Synthetic payload tests do not load or validate real drivers.

## 1. Build and configure the Mac app

Review the CellDock non-commercial terms in [licensing](licensing.md). Follow the component guide's current toolchain requirements and tests. From the repository root:

```bash
(cd apps/macos && swift build --disable-sandbox --cache-path .build/cache)
(cd apps/macos && scripts/run_tests.sh && scripts/run_gateway_control_tests.sh && scripts/run_gateway_media_tests.sh)
(cd apps/macos &&   VODOG_SIGNING_MODE=development   VODOG_CODESIGN_IDENTITY='Apple Development: <your identity>'   scripts/build_app.sh)
```

Use a real certificate-backed identity; ad-hoc signing is not the packaging path. Signed development packaging is not notarization. The output ZIP is under `apps/macos/outputs/`; the target Mac does not need the build toolchain. Install your reviewed app using the component's installation instructions, approve its signed network helper when prompted, and launch in a logged-in GUI session.

The client defaults to `https://vodog.example.invalid`, an intentionally unusable endpoint. Set your own HTTPS origin before first login:

```bash
defaults write org.vodog.macos VoDogBaseURL -string 'https://vodog.example.com'
```

Replace the example with your domain, then restart. Alternatively launch the executable with `VODOG_BASE_URL` set in its process environment; a shell export does not necessarily reach a Finder-launched app. Use an origin with no credentials, path, query, or fragment. Gateway settings have their own pairing server URL: configure that too. After switching servers, sign in and pair afresh rather than importing old credentials.

## 2. Prepare the supported module

Connect one idle QDC507 over a USB data connection. Keep other AT/ADB tools closed. In the app's module view, inspect the detected module identity and firmware before choosing its guarded **convert module identity** flow.

- Factory USB: `2CA3:4006`.
- Prepared USB: `2C7C:0125`, with AT/ADB, USB audio, and ECM (`usbnet=1`).
- Module voice expects 8 kHz UAC and the specific compatible kernel/audio interfaces described in `module/RUNTIME.md` and the component guide.

Conversion changes configuration and reboots the module; do not unplug it mid-operation or perform conversion during a call. Do not flash generic EG25 firmware or firmware for a different DJI product. No stock firmware is supplied. If identification or preparation fails, stop and use the component's diagnostics rather than forcing another model's settings.

For module voice, obtain the exact corresponding source, patches, kernel configuration, symbol versions and toolchain from the runtime supplier/upstream maintainer. Build and validate compatible components independently. Set `VODOG_MODULE_VOICE_DIR` to a private directory containing those components and a matching size/SHA-256 manifest when packaging. Leaving it unset builds without the optional voice payload. The repository does not automatically fetch an unverified payload.

## 3. Pair, assign, and check readiness

1. In Web administration, create a gateway and generate a pairing code.
2. In the Mac app's gateway settings, select the attached module, enter your gateway server URL and pairing code, and pair while disabled.
3. Enable the gateway and assign its discovered SIM to the intended user in Web administration. Where offered, administrator “join account” combines those provisioning steps; non-admin users still need assignment.
4. Check each module separately: SIM/carrier registration, phone/SMS readiness, voice runtime and media readiness, and acknowledged settings. Do not override a failed voice gate.
5. Grant microphone permission for local Mac calling and approve only the expected helper. Keep the app running; each attached paired module has its own gateway runtime.

Credentials use Keychain and a module copy at `/data/vodog/vodog-gateway.json`. This is a product runtime path, not an operator-specific directory. Treat a lost module as a lost credential and revoke/re-pair it. Do not copy another installation's Keychain or module token.

## 4. Test the right path

A remote SIM uses Control and relay media. An eligible local attached SIM can use direct Mac/module audio; shared recording still requires capture binding and archive finalization. Confirm which route the UI selected. Complete [acceptance](operations.md) only after the missing runtime prerequisite is resolved, with approved calls/SMS and separate audio, recording, AI, and reconnect checks.

The missing payload also blocks helper-backed VoWiFi control/status, ECM recovery and module credential import/export. A payload-free build is not a functioning DJI gateway. The PCM helper source/build recipe is included, but building it alone does not replace the missing kernel modules.
