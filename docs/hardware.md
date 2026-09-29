# Hardware requirements

**Voice payload is bundled:** the public CellDock QDC507 kernel modules and compiled PCM bridge are included unchanged. Kernel 3.18.44 with a compatible ABI, root ADB and UAC are still required. Preparing USB identity or completing initialization alone cannot establish module voice; fail-closed readiness checks remain required and physical acceptance is pending. See [DJI setup](dji-setup.md) and [runtime provenance and limits](../apps/macos/module/RUNTIME.md).

[Documentation](README.md) · [简体中文](hardware.zh-CN.md)

## Pixel gateway

The reference integration targets Pixel 7 Pro. Before using another model or OS build, confirm all of the following on that exact combination:

1. The bootloader is unlockable. A carrier-locked variant with OEM unlocking unavailable is not a suitable assumption. Unlocking normally erases user data; prepare a recoverable personal backup first.
2. Root and the reviewed Magisk privileged-app module can be installed for that OS build. A normal sideloaded APK alone cannot obtain the protected telephony and audio capabilities.
3. The SIM is active, registered, and provisioned by its carrier for voice and SMS. Data-only service and modem registration alone do not prove voice support.
4. Android Telecom/InCallService, SIM identity access, call audio capture/injection, and foreground microphone service behavior work together.
5. The gateway can reach Control and TURN, has adequate storage, reliable power, and suitable thermal conditions for continuous use.

The privileged integration uses permissions including `CONTROL_INCALL_EXPERIENCE`, `MODIFY_PHONE_STATE`, `CAPTURE_AUDIO_OUTPUT`, `READ_PRIVILEGED_PHONE_STATE`, and `CHANGE_COMPONENT_ENABLED_STATE`. Some functions also need runtime permissions or explicit root grants. Confirm actual grants; listing them in a manifest is not enough.

Keep the normal system dialer and existing device security policy. Do not disable SELinux, alter unrelated radio configuration, or grant broad permissions merely to make a readiness indicator green. Recheck compatibility after Android, Magisk, or target SDK changes. Pixel gateway and Android user client are separate apps, even when installed on the same phone.

Pair the gateway while its control switch is off; verify SIM ownership and all readiness gates before enabling real actions. Remote activation is a separately authorized standby feature, not remote power-on of a shut-down phone. BCR is an independent third-party recorder, not a prerequisite or a substitute for VoDog archive verification; its interaction with each capture path needs separate checks.

## DJI module gateway

The specific integration is **DJI QDC507 with a Quectel EG25-G baseband**. Do not infer support for DJI Cellular Dongle 2, another modem revision, another LTE dongle, or every device carrying the DJI name.

| Item | Expected integration condition |
| --- | --- |
| Mac | Apple silicon; macOS 14 or later is the documented baseline; confirm the exported package's deployment target |
| Session | Logged-in GUI session with the app running and gateway enabled; administrator interaction may be needed for the helper |
| Module | QDC507 / EG25-G, compatible firmware and AT/ADB access |
| Factory USB identity | `0x2CA3:0x4006` |
| Prepared USB identity | `0x2C7C:0x0125`, product `EG25G_QDC507` |
| Voice audio | USB Audio Class interface; integration expects 8 kHz mono module audio |
| SIM | One active voice/SMS SIM per module; carrier voice/VoLTE compatibility must be checked |

A factory-identity module requires the integration's reviewed preparation flow. Identity conversion changes module configuration and reboots it; perform it only with an idle, owned module and an explicit recovery plan. This guide intentionally does not prescribe blind AT writes for unknown firmware.

The Mac owns the USB control interface. Do not run a second AT/ADB tool against a module already owned by the app. Give the app required microphone and other relevant permissions. A missing USB audio interface, failed voice runtime, or absent carrier registration is a blocker, even if the module appears in a device list.

Multiple prepared modules can have separate gateway runtimes. Pair and validate each separately. Credentials can be stored both in Keychain and on the module; treat possession of the module as possession of a gateway credential. Moving it between Macs does not transfer all pending local queues, and commands issued before attachment must not be replayed blindly. Re-pair/revoke access after loss or unauthorized possession.

The module's cellular data link is not required for the Mac's Control connection; another Mac network can carry HTTPS and TURN. Sleeping the Mac, unplugging the module, stopping the app, or disabling its gateway affects availability. A rootless Pixel or generic USB modem is not an interchangeable fallback.
