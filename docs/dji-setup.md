# Set up the DJI module integration on macOS

[Documentation](README.md) · [简体中文](dji-setup.zh-CN.md) · [macOS component guide](../apps/macos/README.md)

## What is available

The integration targets **DJI QDC507 / Quectel EG25-G** on Apple-silicon macOS. Remote VoDog client features are buildable independently of module audio. This distribution **includes the required QDC507 kernel modules, compiled PCM helper and manifest** from pinned public CellDock upstream. Default macOS packaging includes them. Exact corresponding kernel source/build inputs remain unavailable; binary inclusion does not resolve that source gap. Read the [runtime requirements and acquisition/build procedure](../apps/macos/module/RUNTIME.md).

The runtime binaries are available from CellDock upstream; the missing materials are their exact corresponding kernel source/build patches, not the binaries themselves. You can initialize and test a supported module with the upstream application, then build VoDog with its bundled, hash-verified runtime. Synthetic payload tests do not load or validate real drivers.

## 0. Prepare a purchased module with upstream CellDock

1. Check the seller's model identification: this path is for **DJI QDC507 / Quectel EG25-G**, not every DJI 4G/4G Enhanced Transmission module. Use a USB data cable/adapter with stable power and an active SIM that supports voice and SMS. Check SIM PIN and carrier VoLTE availability. No soldering or generic firmware flashing is prescribed by this procedure.
2. Obtain CellDock from its [official releases](https://github.com/celldock/celldock-for-mac/releases). Release [0.3.1](https://github.com/celldock/celldock-for-mac/releases/tag/0.3.1) was available when this guide was checked on 2026-09-29. Install the upstream app and connect only the module being prepared; close VoDog and other modem/AT/ADB tools.
3. Let CellDock inspect the device. If it shows the original DJI configuration, use **Convert and Restart** (Chinese UI: “转换并重启”). Its guarded conversion checks the selected device, idle call state, unlock challenge and exact USB settings, enables the supported interfaces, reads settings back, then restarts. Do not paste another device's unlock response or bypass an unsupported-configuration result.
4. If the device instead needs ECM initialization, use **Confirm Initialization** (“确认初始化”) and wait for re-enumeration. For this DJI route, the target is USB `2C7C:0125`, AT/ADB/audio enabled and CDC-ECM `usbnet=1`. “Module ready” establishes USB/network preparation, not successful two-way voice.
5. In CellDock, verify SIM registration, SMS, an incoming and outgoing call, audio in both directions and recording with a consenting test participant. The referenced QDC507 runtime expects root ADB, kernel `3.18.44`, its matching sound card/devices and the proper UAC path. App diagnostics should identify failures; an arbitrary kernel with the same version string is not proof of ABI compatibility.
6. Quit CellDock before VoDog takes ownership. Build the VoDog app with the included runtime as described below, then pair and test VoDog independently. CellDock initialization does **not** make a payload-free VoDog build work: drivers/helper are prepared at runtime, and VoDog still validates its own bundled payload even if a driver is already loaded.

CellDock 0.3.1 also supports certain **native Quectel** devices without ADB/KO injection. That is a different backend, not a way to bypass the DJI QDC507 runtime requirement in this export. See the [upstream release notes](https://github.com/celldock/celldock-for-mac/releases/tag/0.3.1).

Source references: upstream [initialization UI](https://github.com/celldock/celldock-for-mac/blob/6d0461de3a94292e7549a1d8e6e9180bd0b5ed0c/Sources/CellDock/CellDockInitialSetupView.swift), [guarded conversion](https://github.com/celldock/celldock-for-mac/blob/6d0461de3a94292e7549a1d8e6e9180bd0b5ed0c/Sources/CellDock/ModemService.swift), and [runtime manifest](https://github.com/celldock/celldock-for-mac/blob/6d0461de3a94292e7549a1d8e6e9180bd0b5ed0c/Resources/ModuleVoice/manifest.json). These are public upstream references, not a record of a private installation.

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

The [runtime guide](../apps/macos/module/RUNTIME.md) documents the bundled CellDock components and hash verification. Default packaging uses `Resources/ModuleVoice`; `VODOG_MODULE_VOICE_DIR` is only needed for a reviewed replacement. Its manifest and all three binary hashes match this export's reference manifest. This establishes binary provenance, not hardware acceptance or complete corresponding source. Public redistribution still requires the exact source/build materials and applicable notices; obtain those from the supplier/maintainer or build from complete source. Leaving the variable unset uses the bundled payload.

## 3. Pair, assign, and check readiness

1. In Web administration, create a gateway and generate a pairing code.
2. In the Mac app's gateway settings, select the attached module, enter your gateway server URL and pairing code, and pair while disabled.
3. Enable the gateway and assign its discovered SIM to the intended user in Web administration. Where offered, administrator “join account” combines those provisioning steps; non-admin users still need assignment.
4. Check each module separately: SIM/carrier registration, phone/SMS readiness, voice runtime and media readiness, and acknowledged settings. Do not override a failed voice gate.
5. Grant microphone permission for local Mac calling and approve only the expected helper. Keep the app running; each attached paired module has its own gateway runtime.

Credentials use Keychain and a module copy at `/data/vodog/vodog-gateway.json`. This is a product runtime path, not an operator-specific directory. Treat a lost module as a lost credential and revoke/re-pair it. Do not copy another installation's Keychain or module token.

## 4. Test the right path

A remote SIM uses Control and relay media. An eligible local attached SIM can use direct Mac/module audio; shared recording still requires capture binding and archive finalization. Confirm which route the UI selected. Complete [acceptance](operations.md) after checking the bundled runtime on your hardware, with approved calls/SMS and separate audio, recording, AI, and reconnect checks.

The bundled payload also supports helper-backed VoWiFi control/status, ECM recovery and module credential import/export. A missing or invalid payload still blocks those paths. The PCM helper source/build recipe is included; the two kernel modules are supplied as upstream binaries, with their source gap recorded separately.
