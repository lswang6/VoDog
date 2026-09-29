# Audio compression and transport

[Documentation](README.md) · [简体中文](audio-transport.zh-CN.md)

The exported source includes codec integration, packet transport, loss recovery, AI audio conversion and recordings. Settings below describe specific paths, not every client.

```text
Pixel PCM <-> libopus <-> cellular-opus-v1 DataChannel
                               | WebRTC / TURN
                          Pion media bridge
                               | Opus RTP / WebRTC / TURN
                      Web / iOS / Android / macOS / AI
```

| Component | Implementation |
| --- | --- |
| Pixel encoder | [LibOpusEncoder.kt](../apps/android/gateway/src/main/java/org/vodog/gateway/media/LibOpusEncoder.kt): 16 kHz mono PCM16LE, 20 ms frames (320 samples / 640 bytes), default 28 kbps, in-band FEC, expected loss 12%, complexity 10 |
| Native codec | [libopus_jni.cpp](../apps/android/gateway/src/main/cpp/libopus_jni.cpp) and [LibOpusDecoder.kt](../apps/android/gateway/src/main/java/org/vodog/gateway/media/LibOpusDecoder.kt) |
| Loss recovery | [OpusPlayoutBuffer.kt](../apps/android/gateway/src/main/java/org/vodog/gateway/media/OpusPlayoutBuffer.kt): sequence/timestamp-aware playout, next-packet FEC attempts, bounded PLC, silence fill and queue recovery |
| Gateway packets | [MediaPacket.kt](../apps/android/gateway/src/main/java/org/vodog/gateway/media/MediaPacket.kt) and [Go packet.go](../services/media/packet.go): direction, duration, sequence, timestamp and Opus payload |
| Gateway transport | [GatewayDataChannelTransport.kt](../apps/android/gateway/src/main/java/org/vodog/gateway/media/GatewayDataChannelTransport.kt): binary `cellular-opus-v1`, `ordered=false`, `maxRetransmits=0`; relay-only ICE/TURN in deployment |
| Media bridge | [main.go](../services/media/main.go): Pion repackages Opus between DataChannel and RTP without codec decoding/re-encoding on this path; timestamps map to the Opus RTP 48 kHz clock |
| macOS gateway | [GatewayMedia.swift](../apps/macos/Sources/VoDog/Gateway/GatewayMedia.swift), [GatewayOpus.swift](../apps/macos/Sources/VoDog/Gateway/GatewayOpus.swift), [GatewayAudio.swift](../apps/macos/Sources/VoDog/Gateway/GatewayAudio.swift), vendored [libopus](../apps/macos/Sources/COpus/opus) |
| AI audio | [audio-bridge.mjs](../services/voice/audio-bridge.mjs), [pcm-pipeline.mjs](../services/voice/pcm-pipeline.mjs), [webrtc-media.mjs](../services/voice/webrtc-media.mjs): anti-alias FIR 48-to-16 kHz resampling, framing, batching and paced playback |
| Recordings | [Media recording](../services/media/recording.go), [Pixel gateway](../apps/android/gateway), [GatewayRecording.swift](../apps/macos/Sources/VoDog/Gateway/GatewayRecording.swift), [archive validator](../services/recording-archive-validator) |

28 kbps is the codec target, not a network bandwidth ceiling: packet headers, SCTP/DTLS, UDP/IP and TURN add overhead. The 12% setting is expected encoder loss, not measured loss or a recovery guarantee. The 48 kHz RTP clock does not require Pixel PCM at 48 kHz. Client WebRTC libraries manage standard audio tracks; AI PCM conversion is a separate path. Transport encryption terminates at the media node, not end-to-end at the SIM.

For TURN credentials and configuration, see [installation](installation.md) and [infra](../infra/README.md). Codec changes must account for both decoders, packet durations and recovery queues. See [recording and AI](recording-ai.md) for archival behavior.

## Source coverage and limits

libopus source and Pixel component snapshots are included. System frameworks, browsers and package dependencies are still supplied by their respective platforms/build manifests. This is not a complete offline mirror of every transitive dependency. See the [Pixel archive](../infra/pixel/external/README.md) for WebRTC source and dependency boundaries.

DJI user-space [PCM helper source](../apps/macos/module/celldock_pcm_bridge.c) and [build script](../apps/macos/scripts/build_pcm_bridge_armel.sh) are included. Exact source/build patches for `qdc507_voice.ko` and `qdc507_aprv3.ko` are unavailable; their binaries are excluded. The DJI low-level runtime is not complete or ready out of the box. See [runtime limitations](../apps/macos/module/RUNTIME.md).

[Codec loss harness](../apps/android/gateway/src/main/cpp/opus_loss_harness.cpp) · [FEC transparency tests](../services/media/fec_transparency_test.go) · [PCM tests](../services/voice/pcm-pipeline.test.mjs) · [Release checks and limits](release-checks.md)
