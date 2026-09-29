# Pixel external components

VoDog first-party code is AGPL-3.0. Third-party components retain the licenses listed below. [manifest.json](manifest.json) records immutable upstream references, component roles and SHA-256 checksums. Verify all files with `shasum -a 256 -c SHA256SUMS` from this directory.

## Components

| Directory | Version / upstream | License | Role |
|---|---|---|---|
| magisk | [30.7](https://github.com/topjohnwu/Magisk/tree/e8a58776f1d7bdf852072ad0baa6eceb9a1e4aac) | GPLv3; submodule licenses retained | Required root/module framework for the documented Pixel setup |
| gateway-installer | [BCP 1.1](https://github.com/chenxiaolong/BCP/tree/0350949cc1a8b83bebc725cf25256b259c61edf9) | GPLv3 | Required privileged-app module installer |
| bcr | [3.8](https://github.com/chenxiaolong/BCR/tree/b6c3f3d716f8f7fca7e731997c886bddd9804186) | GPL-3.0-only | Independent recording feature; optional for basic gateway transport |
| bcp-upstream | [1.1](https://github.com/chenxiaolong/BCP/tree/0350949cc1a8b83bebc725cf25256b259c61edf9) | GPLv3 | Optional telephony audio reference |
| vodog-research-fork | [BCP 1.1 base](https://github.com/chenxiaolong/BCP/tree/0350949cc1a8b83bebc725cf25256b259c61edf9) with VoDog research modifications | GPLv3 | Optional PCM capture/injection prototype |
| libopus | [1.6.1](https://downloads.xiph.org/releases/opus/opus-1.6.1.tar.gz) | BSD-style license and patent grants in COPYING | Gateway FEC/PLC codec, compiled into `libvodog_opus.so` |
| webrtc-android | [1.3.9](https://github.com/GetStream/webrtc-android/tree/859dd09c96f6053ea26eca432240eeff532a062f) | Apache-2.0 wrapper | Required DataChannel transport wrapper source |
| webrtc-native | [m125.4](https://github.com/GetStream/webrtc/tree/4655e557d1206a42899b6b03fbf017fc64c654cc) | BSD-3-Clause, Apache modifications and third-party terms | Native WebRTC transport source |
| shizuku | [13.6.0](https://github.com/RikkaApps/Shizuku/tree/2650830c5b099ae0dd34fedf614d4f592ca05d65) | Apache-2.0; API MIT | Optional carrier IMS provisioning |
| turbo-ims | [3.7.3.r126](https://github.com/Mystery00/TurboIMS/tree/8c52b0d2b862bea21373355971b3fa7235a183c6) | Apache-2.0 | Optional carrier IMS provisioning |

There are 17 source tarballs, one BCR module ZIP and one Turbo IMS APK. BCR's detached signature is also included. The BCR ZIP/signature and Turbo IMS APK checksums match upstream release asset checksums; a matching checksum is separate from signature verification.

## Source layout

Extract each upstream archive into its own directory. The VoDog research fork archive has two sibling roots, `vodog-research-fork/` and `test-audio/`; its test audio is a generated tone.

Magisk's seven source submodules are included under `magisk/submodules/`. Populate the following paths inside the extracted Magisk tree, stripping the respective archive root.

| Destination | Commit | License evidence |
|---|---|---|
| native/src/external/selinux | be1b39a657fee7faacfae548b75cb53302043a01 | GPL/LGPL/BSD texts for each component |
| native/src/external/lz4 | d44371841a2f1728a3f36839fd4b7e872d0927d3 | BSD library; GPLv2 tools/tests |
| native/src/external/libcxx | d5117df3ba7704aab06c3a30b97c7529c931662b | LICENSE.TXT and exceptions |
| native/src/external/cxx-rs | b09b91554b392523f633b9e3cbe0b43273528c71 | MIT OR Apache-2.0 |
| native/src/external/lsplt | cef80a97a73184b4def9b3e1148884365fc173fd | LGPL-3.0; documentation theme MIT |
| native/src/external/system_properties | b7c2088565fbe13d22fe074960332e89615bb4aa | Per-file notices and SOURCE-HEADERS.txt |
| native/src/external/crt0 | 9dfa67b4d543f1b6bf2e936f560fbe77ca2a226a | Per-file notices and SOURCE-HEADERS.txt |

Directory names encode `/` as `__`. LSPlt includes its documentation theme as ordinary files. Populate Shizuku's `api/` from the included API submodule at `510fc988c02c3475d8c25db170f96792f105bdf8`.

SDK/NDK/JDK, Gradle/Maven/Cargo dependencies and Chromium/WebRTC DEPS require upstream dependency resolution. These packages are component sources, not an offline toolchain mirror. WebRTC's wrapper native-library update [37b8867](https://github.com/GetStream/webrtc-android/commit/37b8867763b8b64f2050b3a5e959e1eef1b687d9) identifies m125.4; this is not a bit-identical rebuild guarantee. Four prebuilt libraries are omitted from the wrapper source archive. Before distributing compiled WebRTC libraries, resolve their exact build dependencies and include the complete third-party license notices.

## Platform requirements

The target platform is an unlockable Pixel 7 Pro (cheetah), Tensor G2/Shannon, arm64, with working SIM/VoLTE and a compatible telephony audio HAL. The Android minimum SDK does not imply support on arbitrary phones. Root the matching `init_boot` image using Magisk and keep SELinux enforcing. Obtain firmware from its official distributor.

Gateway and BCR need privileged-system-app installation for protected telephony/audio permissions. Gateway permissions include CONTROL_INCALL_EXPERIENCE, MODIFY_PHONE_STATE, CAPTURE_AUDIO_OUTPUT, BYPASS_CONCURRENT_RECORD_AUDIO_RESTRICTION, READ_PRIVILEGED_PHONE_STATE and CHANGE_COMPONENT_ENABLED_STATE, plus runtime grants. System blocklist mirroring requires authorized su and a narrow SELinux rule matching the application's actual domain. Keep Google Dialer as the default dialer and use matching signing certificates for privileged base packages and updates.

Gateway audio injection uses Android AudioTrack with TYPE_TELEPHONY; capture uses AudioRecord and protected voice sources. InCallService manages microphone mute. No separate proprietary injection library or Xposed module is required. Enable the documented gateway build feature gates when building a functional telephony gateway.

BCR recording is independent of gateway recording. Validate concurrency on the target firmware, including incoming bridged calls. Optional BCP prototypes must not compete for audio ownership. Carrier-specific IMS provisioning is separate from gateway operation.

Preserve GPL-covered source and notices when redistributing derived code. AGPL first-party licensing does not replace third-party licenses. Firmware, root-hiding utilities, carrier configuration and proprietary radio tools are not included.
