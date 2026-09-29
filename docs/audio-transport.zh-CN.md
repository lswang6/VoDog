# 语音压缩与传输

[文档目录](README.zh-CN.md) · [English and source map](audio-transport.md)

发布内容包括编解码集成、封包、传输、丢包恢复、AI 音频转换及录音源码。逐项文件链接见[源码表](audio-transport.md)。

1. **Pixel 编码**：libopus 路径接收 16 kHz 单声道 PCM16LE，每帧 20 ms，即 320 个采样、640 字节。默认目标码率 28 kbps，开启带内 FEC，预期丢包参数为 12%，复杂度为 10。这些参数不代表所有客户端使用相同配置。
2. **网关传输**：Opus 载荷连同方向、帧时长、序列号和时间戳封包，经 `cellular-opus-v1` WebRTC DataChannel 传输，设置 `ordered=false`、`maxRetransmits=0`。部署采用 relay-only ICE/TURN。
3. **媒体桥**：Go/Pion 在网关 DataChannel 和客户端 RTP 之间双向转封装 Opus，此路径不解码再编码。RTP 使用 48 kHz 时钟，不表示 Pixel PCM 必须以 48 kHz 采样。
4. **丢包恢复**：播放缓冲根据序列号和时间戳调度，尝试用下一包的 FEC 恢复缺失帧，再使用有界 PLC 或补零；包含积压恢复逻辑。FEC 不能保证恢复所有丢包。
5. **AI 音频**：包含 48→16 kHz 抗混叠 FIR 重采样、分帧、批处理和定速回放。客户端标准音轨由 WebRTC 库处理，AI 的 PCM 转换属于另一条路径。
6. **录音**：包含 Pixel、macOS 网关、媒体服务的录音实现，以及归档校验工具；业务配置见[录音与 AI](recording-ai.zh-CN.md)。

28 kbps 是编码目标，不是网络带宽上限；封包、SCTP/DTLS、UDP/IP、TURN 均有开销。12% 是编码器配置，不是实测丢包率或恢复保证。传输加密在媒体节点终止，不应描述为客户端到 SIM 的端到端加密。

TURN 凭据及节点配置见[安装教程](installation.zh-CN.md)和 [infra](../infra/README.md)。修改编解码参数时，需要一起检查双方解码器、包时长及恢复队列，不能只改一个常量。

## 包含范围与缺口

libopus 源码及 Pixel 支持组件快照已包含。系统框架、浏览器和包管理器依赖仍需按构建清单获取；这不是所有平台依赖的完全离线镜像。WebRTC 源码快照及外部依赖边界见 [Pixel 存档](../infra/pixel/external/README.md)。

DJI 的用户态 [PCM helper 源码](../apps/macos/module/celldock_pcm_bridge.c)和[构建脚本](../apps/macos/scripts/build_pcm_bridge_armel.sh)已包含。但 `qdc507_voice.ko`、`qdc507_aprv3.ko` 缺少准确对应源码和构建补丁，因此未发布二进制。不能声称 DJI 底层全部齐备或开箱即用，见[运行时缺口](../apps/macos/module/RUNTIME.md)。

[源码表与相关测试](audio-transport.md) · [发行验证及剩余限制](release-checks.md)
