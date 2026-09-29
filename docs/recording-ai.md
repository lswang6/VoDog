# Recording, archives, transcripts, and AI

[Documentation](README.md) · [简体中文](recording-ai.zh-CN.md)

## Three distinct recording paths

| Path | What it captures | What completion means |
| --- | --- | --- |
| Gateway original archive | Gateway-side original caller/remote tracks, timing metadata, and supported playout-derived tracks | Bound capture identity, validated manifest/objects, and server-confirmed finalization |
| Media-node recording | Audio visible to the relay bridge | The node finalized its files and authorized retrieval works; this is not proof of gateway original completeness |
| Independent local recording | A separate phone recorder or macOS local-call recording | A local file exists; it may not be uploaded, synchronized, or deleted with VoDog records |

Remote calls can have both gateway and media-node recordings. Pixel locally dialed outgoing calls can use passive capture when enabled; locally answered incoming calls are not covered by that claim. macOS local-module direct calls have a separate capture path: Mac microphone/speakers communicate with USB audio, and the VoDog integration obtains a server capture binding before creating the shared archive. If binding fails, the local call or independent M4A recording may still work while the shared archive is absent. Capture before binding may be missing.

Gateway archives use frozen identity and manifest/object integrity checks, resumable chunk upload, and authoritative finalization. They are not disposable upload caches until the protocol permits cleanup. A local directory, successful HTTP chunk request, or a media-node copy is insufficient evidence of a complete original archive. Preserve restart state and free space; do not manually delete pending archives to hide errors.

Playback requires an authorized session and an available source. MP3 export requires the configured private cache and ffmpeg. A mixed conversation export is a derivative, not a replacement for original tracks and timing. Aligning tracks at their start does not by itself prove no drift over a long call.

## Transcription and reports

Control coordinates post-call transcription. Configure `TRANSCRIPTION_ENABLED`, the provider/model settings, a valid start boundary where required, and the relevant worker. The implementation supports a native Gemini path or an OpenAI-compatible endpoint selected by `TRANSCRIPTION_BASE_URL`; use an endpoint with the actual audio/model capabilities expected by the adapter. Reports have separate `REPORT_AI_*` configuration.

Silent or unusable audio should not produce invented text. Missing transcripts can reflect no detected speech, disabled features, provider failure, incomplete recording, or a job that has not finished. Realtime AI conversation text and post-call recording transcription are different artifacts and can have different completeness. Do not mark either as verbatim proof without checking the audio.

## AI answering

SIM answering modes are human (`normal`), immediate AI (`ai`), and timeout-to-AI (`timeout_ai`) when returned as available by Control. Provider selection is account-scoped. Busy-call policy can separately reject a conflicting call or route an eligible call on another gateway to AI; it is not unlimited concurrent calling.

The voice worker uses a private service identity and per-run leases. It prepares a provider, commits the answer through Control, connects relay media, and gates speech on actual call/media readiness. A provider saying “done” is not proof that the physical call ended. Lease loss, provider failure, and call time limits need explicit cleanup and physical-state reconciliation.

| Configuration area | Relevant settings |
| --- | --- |
| Control enablement | `AI_ENABLED`, `AI_WORKER_READY`, `AI_INTERNAL_TOKEN`, `AI_VOICE_PROVIDERS` |
| Worker identity | `VOICE_CONTROL_ORIGIN`, `VOICE_INSTANCE_ID`, `AI_INTERNAL_TOKEN_FILE`, optional `VOICE_NODE_ID` |
| Transport | `VOICE_MEDIA_TRANSPORT` (`udp` or `tls`), matching Control-issued TURN URL |
| xAI | `XAI_API_KEY`, and the supported `XAI_AGENT_ID` or `XAI_REALTIME_MODEL` mode |
| Doubao | `DOUBAO_API_KEY`, supported voice/model settings and optional `DOUBAO_INSTRUCTIONS_FILE` |
| Limits | `AI_MAX_CALL_SECONDS` and supported provider-specific duration/silence controls |

Use `relay-primary` as a generic node label in examples, never as a substitute for matching actual node registration. Store tokens and prompts privately; prompts may contain personal information. The worker must not receive unrestricted user/device credentials or database access merely to simplify setup. Direct Pixel-to-provider AI is not part of this documented path.

Test provider connectivity with synthetic audio before a consented real call. Then independently test immediate/timeout answering, greeting timing, interruption, silence timeout, caller hangup, provider failure, recording, transcript, and report creation. Provider test success alone does not close the cellular or audio-quality checks. Review where audio/text is sent under [privacy](security.md).
