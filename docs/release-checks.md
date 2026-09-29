# Source release validation

[English README](../README.md) · [中文首页](../README.zh-CN.md)

This page describes the public source export, not a preconfigured hosted service or
physical-device certification. All examples and showcase screenshots use fictional data.

The test counts below are previously validated results, not a rerun after bundling
the DJI runtime. Bundled runtime size/hash checks and payload construction passed; the app payload decoder and tamper-rejection check passed against the real upstream payload. macOS base self-tests were rerun and passed. A full signed app archive and physical module acceptance were not performed.

| Component | Validation | Boundary |
| --- | --- | --- |
| Web | 380 unit tests; production and isolated demo builds passed | Three demo screenshots reviewed; no live account used |
| Android | Client: 484 passed; gateway: 587 passed, 2 prerequisite-dependent skips; app/instrumentation builds and gated native gateway build passed | No device installation |
| iOS | App and test targets compile; 462 simulator unit tests passed | No signed distribution or physical phone acceptance |
| macOS | Swift build and base/gateway/client/media self-checks passed; VoWiFi Go tests passed | No signed/notarized app or physical module acceptance |
| Control | TypeScript build and 490 tests passed against disposable databases | No production database accessed |
| Voice | 242 tests passed; one optional integration test skipped | No live AI provider calls |
| Media | Build, full media race suite and archive-validator race suite passed | Earlier host-network ICE timing failures were reproduced with the baseline; final ordinary-network run passed without weakening assertions |
| Infrastructure | Configuration generation tests and Compose schema checks passed; 82 retention tests passed with a disposable database | Control, media, voice, Web and TURN Linux images passed GitHub Actions; fresh-host installation is not exercised |
| Publication | File/identity scanning, dedicated secret scanning and recursive component-archive inspection | Upstream test keys and public fingerprints are reviewed separately from operational credentials |

[GitHub Actions](https://github.com/lswang6/VoDog/actions) checks the publication set,
document links, component hashes and all six Linux container targets, including retention. The [initial source-release run](https://github.com/lswang6/VoDog/actions/runs/36592084657) passed publication checks and the first five image targets. Consult the actual run
status; workflow configuration alone is not a passing result.

## Explicit limitations

- The public CellDock kernel/PCM runtime is now bundled unchanged. Exact corresponding
  kernel source/configuration/patches have not been obtained; complete or reproducible
  kernel source and resolved redistribution obligations are not claimed. GPL-2.0
  kernel-module terms remain applicable. See [runtime provenance](../apps/macos/module/RUNTIME.md).
  Kernel 3.18.44 with compatible ABI, root ADB and UAC remain required. Initialization
  alone is insufficient; fail-closed checks remain and physical acceptance is pending.
- CellDock-derived code retains its noncommercial license. The repository is a
  mixed-license distribution; see [licensing](licensing.md).
- Native signing, APNs/FCM, passkeys, real calls/SMS, actual audio, AI provider behavior,
  reboot/recovery and a fresh VPS installation need separate operator acceptance.
- Archived dependency sources are not an offline SDK/toolchain mirror. Build tools
  and dependency managers still require their documented upstream dependencies.

## 中文说明

本页记录公开源码副本的验证情况，不代表已提供托管服务或完成真机认证。
截图、账号、号码和对话均为虚构演示。Web 构建与 380 项测试、macOS 构建与相关自测、
Voice 的 242 项测试及隔离数据库中的 82 项保留策略测试已通过。
Android 客户端 484 项通过、网关 587 项通过且 2 项因前提跳过；iOS 模拟器 462 项通过；
Control 的 490 项测试通过。媒体完整 race 测试最终通过，早期出现过基线也可复现的宿主网络时序失败。

以上测试数主要为此前已验证结果；本次重新通过 macOS 基础自测、真实上游载荷构建、应用解包和篡改拒绝检查，以及全部运行时大小/哈希校验。未执行完整签名 App 打包或真实模组验收。
现已原样随附 CellDock 公开内核/PCM 二进制；精确对应的内核源码、配置及补丁仍未取得，
不声称源码完整或可重复构建，也不声称再分发义务已解决，内核模块的 GPL-2.0 条款仍适用。
仍需内核 3.18.44、兼容 ABI、root ADB 与 UAC；初始化不足以验收，检查失败时保持阻断，真机验收尚未完成。
CellDock 部分保留非商业许可。Control、媒体、Voice、Web 与 TURN 的 Linux 容器构建已在 GitHub Actions 通过；保留策略容器也纳入 CI。全新 VPS、签名、后台推送与真实蜂窝功能仍须分别验收。
