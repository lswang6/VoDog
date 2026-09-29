# Optional QDC507 runtime: not included

The public source export deliberately omits:

- Resources/ModuleVoice/qdc507_aprv3.ko
- Resources/ModuleVoice/qdc507_voice.ko
- Resources/ModuleVoice/celldock-pcm-bridge.armv7
- Generated ModuleVoice.payload

The kernel modules derive from GPL-2.0 code at
https://github.com/the-modem-distro/quectel_eg25_kernel
(commit 82ed00908b3e8efc3ff0de27d2b5a7c0524ecd7f). GPL permits compliant redistribution,
but the exact local module patches/configuration/Makefiles corresponding to these
binaries were unavailable. An upstream checkout alone is insufficient. No proprietary
license exception or commercial permission is assumed. The compiled PCM helper is
also omitted; its source and reproducible build recipe remain as
module/celldock_pcm_bridge.c and scripts/build_pcm_bridge_armel.sh.

Request exact corresponding source, patches, kernel config, Module.symvers, toolchain
and reproducible module build recipes from the runtime supplier/CellDock maintainer:
https://github.com/celldock/celldock-for-mac . This repository does not supply a binary
download URL or automatically fetch/install an unverified payload.

After obtaining compliant source and independently building/validating a compatible
runtime, place the components and a correct size/SHA-256 manifest in a local private
directory. module/runtime-manifest.example.json records the former runtime structure
and checksums as reference only. Set VODOG_MODULE_VOICE_DIR to that directory when
running scripts/build_app.sh; it validates components and packages the payload.
Leave the variable unset to build an app without optional QDC507 voice payload.

Without that payload the app cannot initialize the module-side voice runtime or
claim working DJI local/gateway audio. Remote VoDog client features remain buildable;
modem data/SMS depend on device firmware and are not validated here. Hardware checks
must remain fail-closed. Tests use explicitly synthetic non-loadable bytes generated
inside .build; successful payload tests do not validate firmware or drivers.

The constructor currently requires a payload even for helper-backed control operations:
module-side VoWiFi control/status and ECM recovery also fail with missing resources.
Module credential import/export through that runtime is unavailable as well; do not
claim a functioning DJI gateway from a payload-free build. Remote client functionality
is independent; AT-only SMS/data behavior still needs separate hardware validation.

## Rebuild the PCM bridge from source

The helper source and build recipe are included; no external binary is required for
this component. From apps/macos, with a running local Docker engine:

```sh
OUT_DIR="$PWD/outputs/module" scripts/build_pcm_bridge_armel.sh --container
```

The recipe pins the Debian image digest and ARM soft-float GCC/binutils/libc package
versions, builds the helper, performs compiler/static-analysis and ELF ABI checks,
and writes a stripped helper, audit report and SHA-256 file to outputs/module.
Alternatively install the cross tools and run the same script with --local.
No module connection, ADB operation or firmware installation is performed by this
build script. Successful helper build does not supply the two missing kernel modules.
The reference manifest checksums refer to the former binaries; regenerate size/hash
entries for an independently rebuilt helper instead of claiming bit-identical output.
