# Support and acceptance boundaries

**DJI voice prerequisite:** the optional kernel/PCM payload is excluded from this export. Source support in this table does not mean a fresh module can provide audio. See [DJI setup](dji-setup.md).

[Documentation](README.md) · [简体中文](support.zh-CN.md)

“Source support” means an implementation or integration contract exists. It does not certify a new installation, every device variant, or every carrier. No fresh VoDog physical installation is certified by these docs.

| Capability | Web | iOS | Android client | macOS |
| --- | --- | --- | --- | --- |
| Remote call / answer / end / DTMF | Source support | Source support | Source support | Source integration |
| Shared SMS and SIM selection | Source support | Source support | Source support | Source integration |
| Contacts, call/SMS blocklists, records and settings | Source support | Source support | Source support | Source integration |
| Authorized recording playback/export and reports | Source support | Source support | Source support | Source integration |
| Background incoming call delivery | Browser lifecycle dependent | Requires APNs/PushKit, entitlement and device checks | Requires configured FCM and device checks | Running app/session dependent; no equivalent mobile push registration |
| Physical gateway hosting | No | No | Separate Pixel gateway app | Supported DJI module integration |

The macOS tree is derived from CellDock and has a different license. Its local module functions and VoDog remote functions are distinct. Do not infer complete feature parity from a common API: for example, macOS passkey management does not establish passkey enrollment/login support.

## Gateway-specific limits

- **Pixel:** privileged, rooted integration; default builds can keep cellular actions gated off. Passive recording for device-originated outgoing calls does not establish recording of incoming calls answered locally on the Pixel.
- **DJI:** QDC507 / EG25-G only within the documented integration; one SIM per module. Multiple attached modules have separate gateway runtimes, but simultaneous hardware behavior must be tested on the actual Mac and modules.
- **DJI recording:** remote gateway calls have original archive capture; local module calls have their own recording path and shared capture binding. Local M4A availability is not proof that the shared archive completed.
- **Notifications:** credentials are optional for source builds and foreground experiments, but background delivery cannot be claimed without them. Browser suspension is not equivalent to native incoming-call support.
- **AI:** supported provider adapters do not guarantee account/model availability, latency, transcripts, or uninterrupted service. No seamless AI-to-human mid-call handoff is promised.
- **Media:** UDP and TLS relay paths need independent validation. Network changes, long calls, echo, clock drift, reconnection, and constrained devices need physical tests.
- **Recording:** carrier early media, silent tracks, missing capture permission, interrupted upload, and low storage can produce absent or incomplete recordings. Transcript absence is sometimes the correct result.

## How to report validation

Record these separately: source review; reproducible build; unit/integration tests; authenticated UI; native simulator; native physical device; real cellular inbound/outbound; SMS; background push; audio and archive integrity; AI; long-running operation; backup/restore. A green build closes only the build item. Use the [acceptance checklist](operations.md) for each new deployment.

[Release preparation checks](release-checks.md) record the public export validation scope separately from new installation acceptance.

The excluded DJI runtime also affects helper-backed module control and credential transport, not only audio. A payload-free Mac build supports the remote client path but must not be described as a working module gateway.
