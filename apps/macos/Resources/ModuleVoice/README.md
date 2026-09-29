# QDC507 runtime from CellDock / CellDock 模组运行时

These files are copied unchanged from public upstream [CellDock commit 6d0461de3a94292e7549a1d8e6e9180bd0b5ed0c](https://github.com/celldock/celldock-for-mac/tree/6d0461de3a94292e7549a1d8e6e9180bd0b5ed0c/Resources/ModuleVoice). All three binary sizes and SHA-256 values were verified against its `manifest.json`; the manifest matches the retained [reference](../../module/runtime-manifest.example.json). No files were extracted from an operator's device or installed application.

| File | Purpose | Upstream terms |
| --- | --- | --- |
| `qdc507_aprv3.ko` | APR kernel module | [GPL-2.0](COPYING-GPL-2.0), upstream kernel provenance below |
| `qdc507_voice.ko` | Voice kernel module | [GPL-2.0](COPYING-GPL-2.0), upstream kernel provenance below |
| `celldock-pcm-bridge.armv7` | Module-side PCM helper | Retained [CellDock license](LICENSE-CellDock); upstream helper source snapshot in [source](source/celldock_pcm_bridge.c) |
| `manifest.json` | Runtime, device-node, size and hash contract | Unchanged upstream metadata |

Kernel provenance stated by CellDock: [the-modem-distro/quectel_eg25_kernel at 82ed00908b3e8efc3ff0de27d2b5a7c0524ecd7f](https://github.com/the-modem-distro/quectel_eg25_kernel/tree/82ed00908b3e8efc3ff0de27d2b5a7c0524ecd7f). Exact additional patches, kernel configuration, symbol versions and complete build inputs for these two `.ko` files have **not** been obtained. The public upstream binary location and the included GPL text do not resolve that corresponding-source gap. Do not describe this as a complete, reproducible kernel source release or claim that redistribution obligations are thereby satisfied. The root AGPL license does not replace these terms.

The helper source snapshot comes from the same CellDock commit's `module/celldock_pcm_bridge.c`; it is preserved separately from VoDog's maintained [helper source](../../module/celldock_pcm_bridge.c). No bit-identical rebuild of the upstream helper binary is claimed.

这些必需运行时文件直接取自上述固定上游提交，大小及哈希均核验一致，并非从私人设备提取。默认 macOS 打包会包含它们。内核模块的完整对应源码/配置/补丁仍未取得；二进制可取得不等于对应源码义务已经完成，不将它们重新标记为第一方 AGPL 代码。

[Build and runtime requirements / 构建与运行前提](../../module/RUNTIME.md) · [DJI setup / DJI 设置](../../../../docs/dji-setup.zh-CN.md)
