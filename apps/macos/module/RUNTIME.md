# Bundled QDC507 runtime / 已包含 QDC507 运行时

The required runtime binaries and manifest are in [Resources/ModuleVoice](../Resources/ModuleVoice/README.md), copied unchanged from pinned public CellDock upstream and checked against its published sizes/SHA-256 values:

- `qdc507_aprv3.ko`
- `qdc507_voice.ko`
- `celldock-pcm-bridge.armv7`
- `manifest.json`

`scripts/build_app.sh` uses that directory by default, verifies the manifest/components and creates the signed app's `ModuleVoice.payload`. No separate binary download is needed. `VODOG_MODULE_VOICE_DIR` can override it with a reviewed compatible directory; a replacement needs an accurate size/hash manifest. Keep the original upstream files unchanged and preserve their attribution.

## Verify and package

From the repository root:

```sh
python3 tools/check-publication.py
mkdir -p apps/macos/.build/runtime-check
xcrun swift apps/macos/scripts/build_module_voice_payload.swift \
  apps/macos/Resources/ModuleVoice \
  apps/macos/.build/runtime-check/ModuleVoice.payload
```

This checks and packages bytes; it does not connect to a modem or load drivers. Then use the [macOS build guide](../README.md) to create a certificate-signed application. Packaging checks the payload in the extracted archive too.

## Device requirements

Use the supported DJI QDC507 / EG25-G route, with root ADB, a compatible `3.18.44` kernel/ABI, `mdm9607-tomtom-i2s-snd-card`, and these nodes:

```text
/dev/snd/controlC0
/dev/snd/pcmC0D4p
/dev/snd/pcmC0D4c
/dev/snd/pcmC0D5p
/dev/snd/pcmC0D6c
```

USB identity conversion and ECM initialization are explained in the [DJI walkthrough](../../../docs/dji-setup.md) ([中文](../../../docs/dji-setup.zh-CN.md)). They do not establish audio readiness. The app checks root access, kernel version, sound devices and uploaded hashes; failures must not be bypassed. Driver/helper preparation occurs at runtime. Initializing once in upstream CellDock does not remove VoDog's need for its own payload, including helper-backed control, ECM recovery and credential transport. Close CellDock before VoDog owns the same module.

## Source and license status

See [upstream provenance and licenses](../Resources/ModuleVoice/README.md). The two kernel binaries are available and included, but their exact complete corresponding source/build inputs have **not** been obtained. An upstream kernel tree link alone is insufficient. Obtain exact patches, kernel configuration, `Module.symvers`, toolchain and build recipes from the runtime supplier/CellDock maintainer. This publication does not claim that this remaining source gap or applicable redistribution obligations are resolved.

The unchanged upstream PCM helper source is archived alongside the binary; the maintained helper source and build recipe remain [here](celldock_pcm_bridge.c) and [here](../scripts/build_pcm_bridge_armel.sh). From `apps/macos`, with a running Docker engine:

```sh
OUT_DIR="$PWD/outputs/module" scripts/build_pcm_bridge_armel.sh --container
```

The recipe pins its toolchain/image, performs static/ELF checks, and writes the helper, report and SHA-256. This builds the helper only, not the kernel modules. Rebuilding a changed helper requires regenerating its manifest size/hash; do not claim byte identity with the pinned binary without verification.

## 中文说明

仓库现已包含所需两个 `.ko`、PCM helper 及上游清单，默认构建自动打包，无需手工下载。需要替换版本时才设置 `VODOG_MODULE_VOICE_DIR`，并更新替换目录的清单。文件全部来自固定公开上游提交，没有私人设备信息。

仍未补齐的是内核二进制的准确对应源码、配置和补丁，不能把二进制归档称为完整内核源码发布。原始许可及署名保留。构建/哈希检查不等于设备验收；按教程完成型号核对、USB/ECM 初始化后，还需单独验证真实通话、双向声音、录音和重连。
