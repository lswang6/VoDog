# Third-party provenance

`BcpTelephonyAudioEndpoint.kt` is adapted from Basic Call Player (BCP) by chenxiaolong
(https://github.com/chenxiaolong/BCP). BCP is
licensed under GNU GPL v3. The adapted source carries an SPDX notice, identifies the
modification date, and this gateway module includes the complete GPL v3 text. Source must
remain available under GPL v3 when this covered gateway build is conveyed.

The early prototype kept this endpoint inactive. The current controlled gateway candidate uses it only with reviewed privileged permissions and an authoritative active-call lifecycle.

The data-only transport embeds `io.getstream:stream-webrtc-android:1.3.9`, published by
GetStream from https://github.com/GetStream/webrtc-android under Apache License 2.0. The
corresponding license text is included as `LICENSE-APACHE-2.0.txt`. This gateway creates no
WebRTC audio source or track, keeps the WebRTC audio device module muted. The separate privileged telephony capture path requires `RECORD_AUDIO`; this is distinct from a WebRTC audio source.
