# Set up a Pixel gateway

[Documentation](README.md) · [简体中文](pixel-setup.zh-CN.md) · [Hardware requirements](hardware.md)

This walkthrough targets an owned, unlockable Pixel 7 Pro with compatible Android/telephony audio support. Complete the [host setup](installation.md) first. Commands below are instructions for your authorized setup; publishing this guide does not perform them.

## 1. Prepare root and recovery

Back up the phone, identify its exact model/build, and confirm OEM unlocking is available. Obtain matching firmware directly from [Google's official Pixel images](https://developers.google.com/android/images), observing its terms and device-specific instructions. VoDog does not distribute stock, patched boot/init_boot, OTA, or baseband firmware.

Follow the [official Magisk installation guide](https://topjohnwu.github.io/Magisk/install.html) on that device. For the Pixel 7 Pro flow, prepare the matching `init_boot` image and patch it on the phone being rooted; do not use another device's patched image. Bootloader unlocking can erase data. Verify root after reboot and keep a recovery route for the matching stock build. Keep SELinux enforcing; do not relock with incompatible modified partitions.

The [external component inventory](../infra/pixel/external/README.md) contains source, licenses, and provenance for root/audio dependencies. BCR provides a separate recording feature. Optional IMS tools are not a universal carrier fix or a mandatory gateway dependency.

## 2. Build the gateway and privileged module

Install the Android toolchain specified by the exported project. From the repository root:

```bash
VODOG_API_BASE_URL=https://vodog.example.com/api/v1 bash scripts/build-android.sh
```

Replace the example with your HTTPS API base URL ending in `/api/v1`. The script builds/tests the Android client and gateway and enables the five gateway acceptance gates. Inspect its output and retain the APK and signing-certificate fingerprint. For a distributable build, use your own persistent signing key; do not alternate signers between the privileged base and user updates.

Build the Magisk module using the installed SDK `aapt` and the **verified SELinux domain for the intended OS/target SDK**:

```bash
export VODOG_AAPT="$ANDROID_HOME/build-tools/<installed-version>/aapt"
export VODOG_SELINUX_DOMAIN='<verified-privileged-app-domain>'
python3 infra/pixel/build-module.py   apps/android/gateway/build/outputs/apk/debug/gateway-debug.apk   --aapt "$VODOG_AAPT"   --selinux-domain "$VODOG_SELINUX_DOMAIN"   --output /tmp/vodog-pixel-module
```

The angle-bracket values must be replaced. Do not guess a privileged-app domain from a different Android version: establish it from the matching platform policy/verified device integration. If that cannot be established, stop before installation. The builder validates `org.vodog.gateway` and privileged permission declarations; it writes `vodog-gateway-magisk.zip` and `module-manifest.json`. It neither roots nor installs the device, and its manifest says `installed: false`.

Inspect the ZIP before use:

```bash
unzip -l /tmp/vodog-pixel-module/vodog-gateway-magisk.zip
cat /tmp/vodog-pixel-module/module-manifest.json
```

## 3. Install in an idle maintenance window

In Magisk on the phone, select **Modules → Install from storage**, choose the reviewed `vodog-gateway-magisk.zip`, then reboot. The module supplies the system privileged APK, permission allowlist, and scoped policy. Ordinary `adb install` alone is insufficient for first provisioning. Keep the gateway control switch off until checks pass.

Enable USB debugging and select the device explicitly for any inspection; do not use a saved serial from another machine. These checks are read-only and may expose private phone state, so retain results privately:

```bash
export VODOG_ADB_SERIAL='<your-device-serial>'
adb -s "$VODOG_ADB_SERIAL" shell pm path org.vodog.gateway
adb -s "$VODOG_ADB_SERIAL" shell dumpsys package org.vodog.gateway
adb -s "$VODOG_ADB_SERIAL" shell cmd role get-role-holders android.app.role.DIALER
```

Confirm the package is recognized as privileged and that its protected permissions are actually granted: `CONTROL_INCALL_EXPERIENCE`, `MODIFY_PHONE_STATE`, `CAPTURE_AUDIO_OUTPUT`, `BYPASS_CONCURRENT_RECORD_AUDIO_RESTRICTION`, `READ_PRIVILEGED_PHONE_STATE`, and `CHANGE_COMPONENT_ENABLED_STATE`. Preserve Google Phone as the normal default dialer; the gateway uses InCallService rather than replacing your dialer.

Open VoDog Gateway and grant its requested Phone, SMS, Microphone, Call logs, and notification permissions through Android settings. Review foreground/background operation and battery restrictions. Grant root to the gateway only for reviewed features that require it, such as system blocklist integration. A manifest entry or granted runtime microphone permission is not proof of protected call audio access.

## 4. Pair and assign a SIM

1. Sign in to your own Web administrator account. Open gateway management, create a gateway, and generate its pairing code.
2. On the Pixel, enter your server endpoint and pairing code; keep the control switch off until pairing succeeds.
3. Let the app discover the physical SIM. In Web administration, assign that SIM to the intended user; add an optional name/number label. Do not use a label as the authoritative SIM identity.
4. Sign in as the assigned user and confirm the same SIM appears. Enable gateway control, then verify telephony, SMS, media and reconciliation readiness independently.
5. Change one harmless SIM setting, verify its desired version is saved, and wait for the exact applied acknowledgement. Resolve a timeout or mismatch before real calls.

## 5. Verify gates and first use

The fresh-host configuration enables archive upload, replay migration/horizon, DTMF, early media, busy handling, and device-originated calls. Use the current gateway with **all five** matching Gradle gates: `vodogCellularAcceptance`, `vodogRecordingArchive`, `vodogLibopusFec`, `vodogReceiveRecovery`, and `vodogCommandReplayHorizon`. Build logs establish requested flags; inspect the actual APK/build fields and runtime readiness before claiming they are active.

Test OFF/ON while idle, confirm normal phone behavior is restored when disabled, then follow [acceptance](operations.md) for approved calls/SMS and both recording tracks. BCP is optional: the release code handles its absence during audio-owner acquisition, release, and recovery, with a focused regression test. A fresh physical-device installation without BCP remains unverified; the code fix does not replace that acceptance.

For recovery, disable the VoDog module in Magisk and reboot during an idle window; retain the original device configuration and matching recovery image. Do not erase the command/replay journal or change SIM identity to clear readiness errors. A successful module installation is not cellular acceptance.
