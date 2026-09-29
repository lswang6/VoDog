# Source release validation

[English README](../README.md) · [中文首页](../README.zh-CN.md)

This page describes the public source export, not a preconfigured hosted service or
physical-device certification. All examples and showcase screenshots use fictional data.

| Component | Validation | Boundary |
| --- | --- | --- |
| Web | 380 unit tests; production and isolated demo builds passed | Three demo screenshots reviewed; no live account used |
| Android | Client: 484 passed; gateway: 587 passed, 2 prerequisite-dependent skips; app/instrumentation builds and gated native gateway build passed | No device installation |
| iOS | App and test targets compile; 462 simulator unit tests passed | No signed distribution or physical phone acceptance |
| macOS | Swift build and base/gateway/client/media self-checks passed; VoWiFi Go tests passed | No signed/notarized app or physical module acceptance |
| Control | TypeScript build and 490 tests passed against disposable databases | No production database accessed |
| Voice | 242 tests passed; one optional integration test skipped | No live AI provider calls |
| Media | Build, full media race suite and archive-validator race suite passed | Earlier host-network ICE timing failures were reproduced with the baseline; final ordinary-network run passed without weakening assertions |
| Infrastructure | Configuration generation tests and Compose schema checks passed; 82 retention tests passed with a disposable database | Linux image builds and fresh-host installation are separate checks |
| Publication | File/identity scanning, dedicated secret scanning and recursive component-archive inspection | Upstream test keys and public fingerprints are reviewed separately from operational credentials |

[GitHub Actions](https://github.com/lswang6/VoDog/actions) checks the publication set,
document links, component hashes and Linux container builds. Consult the actual run
status; workflow configuration alone is not a passing result.

## Explicit limitations

- The DJI module's optional kernel runtime is excluded because exact corresponding
  source/build inputs have not been located. This also affects helper-backed module
  control and credential transport. See [runtime requirements](../apps/macos/module/RUNTIME.md).
  A payload-free macOS build is **not** a working fresh DJI gateway.
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

DJI 内核运行时因缺少精确对应源码与构建材料未随包发布，影响语音及部分模块控制功能，
不能把不含该运行时的 macOS 构建当作可直接使用的全新 DJI 网关。
CellDock 部分保留非商业许可。容器、全新 VPS、签名、后台推送与真实蜂窝功能须分别验收。
