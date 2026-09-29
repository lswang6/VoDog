# Contributors and upstream acknowledgments / 贡献者与上游致谢

[English README](README.md) · [中文首页](README.zh-CN.md) · [Notice](NOTICE.md) · [License boundaries](docs/licensing.md)

VoDog thanks its [direct contributors](https://github.com/lswang6/VoDog/graphs/contributors) and the upstream authors below. Upstream credit acknowledges reused work or references; it does not imply direct participation in VoDog or endorsement. Linked contributor lists and retained AUTHORS/copyright notices remain authoritative, including contributors not individually named here.

感谢 VoDog 的直接贡献者及以下上游作者。上游署名表示代码、依赖或设计参考的来源，不表示这些作者直接参与或认可 VoDog。贡献者页面及保留的 AUTHORS、版权声明包含更多作者，本文不替代原始署名或许可。

| Project / 项目 | Authors and contributors / 作者及贡献者 | Relationship / 使用关系 |
| --- | --- | --- |
| [CellDock](https://github.com/celldock/celldock-for-mac) | [CellDock contributors](https://github.com/celldock/celldock-for-mac/graphs/contributors) | Basis of the modified macOS app and DJI integration / macOS 与 DJI 集成的直接上游；保留其非商业许可 |
| [MaVo](https://github.com/moluncn/mavo) | [moluncn](https://github.com/moluncn) and [contributors](https://github.com/moluncn/mavo/graphs/contributors) | Interface/feature design credit acknowledged by CellDock / CellDock 致谢的界面与功能设计参考；不声称 VoDog 直接复制其代码 |
| [BCP](https://github.com/chenxiaolong/BCP) / [BCR](https://github.com/chenxiaolong/BCR) | [chenxiaolong](https://github.com/chenxiaolong), [BCP contributors](https://github.com/chenxiaolong/BCP/graphs/contributors), [BCR contributors](https://github.com/chenxiaolong/BCR/graphs/contributors) | Pixel audio research fork, installer provenance and optional recorder / Pixel 音频研究分支、安装器来源与可选录音器 |
| [Magisk](https://github.com/topjohnwu/Magisk) | [topjohnwu](https://github.com/topjohnwu) and [contributors](https://github.com/topjohnwu/Magisk/graphs/contributors) | Pixel root/module infrastructure / root 与模块基础设施 |
| [Shizuku](https://github.com/RikkaApps/Shizuku) / [API](https://github.com/RikkaApps/Shizuku-API) | RikkaApps and [contributors](https://github.com/RikkaApps/Shizuku/graphs/contributors) | Privileged integration support / 特权集成支持组件 |
| [TurboIMS / TensorIMS](https://github.com/Pixel-Tailor-CN/TensorIMS) | [Mystery00](https://github.com/Mystery00), Pixel-Tailor-CN and [contributors](https://github.com/Pixel-Tailor-CN/TensorIMS/graphs/contributors) | Optional IMS support snapshot / 可选 IMS 支持快照 |
| [Opus](https://opus-codec.org/) | Xiph.Org and the [retained AUTHORS](apps/macos/Sources/COpus/opus/AUTHORS) | Native codec, FEC and PLC / 编解码与丢包恢复 |
| [WebRTC](https://webrtc.googlesource.com/src/) / [GetStream Android wrapper](https://github.com/GetStream/webrtc-android) | WebRTC authors, GetStream and [wrapper contributors](https://github.com/GetStream/webrtc-android/graphs/contributors) | Native real-time transport / 原生实时传输 |
| [LiveKit WebRTC](https://github.com/livekit/webrtc-xcframework) | LiveKit and [contributors](https://github.com/livekit/webrtc-xcframework/graphs/contributors), underlying WebRTC authors | Apple-platform WebRTC packaging / Apple 平台框架封装 |
| [Pion WebRTC](https://github.com/pion/webrtc) | Pion and [contributors](https://github.com/pion/webrtc/graphs/contributors) | Go media bridge / Go 媒体桥 |
| [coturn](https://github.com/coturn/coturn) | [coturn contributors](https://github.com/coturn/coturn/graphs/contributors) | TURN relay / TURN 中继 |
| [lpac](https://github.com/estkme-group/lpac) / [cJSON](https://github.com/DaveGamble/cJSON) | ESTKme GROUP, [lpac contributors](https://github.com/estkme-group/lpac/graphs/contributors), Dave Gamble and [cJSON contributors](https://github.com/DaveGamble/cJSON/graphs/contributors) | Vendored euicc/cJSON subset / eSIM 库子集及 JSON 实现 |
| [vowifi-go](https://github.com/boa-z/vowifi-go) | [boa-z](https://github.com/boa-z) and [contributors](https://github.com/boa-z/vowifi-go/graphs/contributors) | Separate modified VoWiFi runtime / 独立修改版 VoWiFi 运行时 |
| [Quectel kernel tree](https://github.com/the-modem-distro/quectel_eg25_kernel) | the-modem-distro and upstream Linux/Quectel authors | Provenance reference for excluded kernel modules, not a claim of complete corresponding source / 已排除内核模块的来源参考，不代表已包含完整对应源码 |

The macOS [third-party notices](apps/macos/docs/THIRD_PARTY_NOTICES.md) additionally credit protocol references: IchthysMaranatha/asterisk-chan-quectel, Quectel documentation, warthog618/sms, patriczeq/WWANManager, and Blue Robotics/cellphone-modem-manager. These are references, not a claim that their code was copied.

另感谢 [React](https://github.com/facebook/react)、[Vite](https://github.com/vitejs/vite)、[Fastify](https://github.com/fastify/fastify)、[TypeScript](https://github.com/microsoft/TypeScript)、[Node.js](https://github.com/nodejs/node)、[PostgreSQL](https://www.postgresql.org/)、[Kotlin](https://github.com/JetBrains/kotlin)、[AndroidX](https://android.googlesource.com/platform/frameworks/support/)、[Swift](https://github.com/swiftlang/swift) 与 [FFmpeg](https://ffmpeg.org/) 的作者和贡献者。依赖锁文件、Pixel [来源清单](infra/pixel/external/manifest.json) 及各组件原始声明记录准确版本和许可；此页不穷举所有传递依赖。
