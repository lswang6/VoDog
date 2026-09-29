# Operations and acceptance

[Documentation](README.md) · [简体中文](operations.zh-CN.md)

## Acceptance for each new installation

Record `passed`, `failed`, `not run`, or `blocked` with the exact scope. Keep detailed evidence privately and use only synthetic examples in public issues.

| Stage | Required observation |
| --- | --- |
| Source/build | Correct application identities, dependency notices, reproducible build, relevant tests, no embedded private configuration |
| Service health | Database migrations, process health, private internal routes, certificate renewal, recording disk permissions and free space |
| Authentication | Fresh login, logout, session persistence/refresh, account isolation, actual challenge/passkey behavior if enabled |
| Gateway | Correct paired gateway and SIM owner; telephony/SMS/media ready; settings acknowledged; OFF/ON behavior understood |
| Remote calls | Each client separately: outbound, inbound, answer elsewhere, cancel before answer, end from both sides, DTMF and two-way audio |
| Networks | UDP relay, TLS relay, Wi-Fi/cellular client paths, disconnection/rejoin and terminal cleanup |
| SMS | Incoming/outgoing, supported short-number formats, multipart completion, unknown-outcome handling and no duplicate replay |
| Local calls | Pixel outgoing observation; Mac local-module direct call; appropriate capture/record sync without routing confusion |
| Recordings | Both original tracks audible, timing/integrity, upload resume, authorized playback/export, correct handling of missing/silent tracks |
| AI | Immediate and timeout modes, selected provider, greeting, interruption, hangup, failure cleanup, transcript/report scope |
| Background | Physical iOS/Android delivery with the configured push environment; running Mac behavior; browser limits |
| Resilience | Long call, device restart, low disk, interrupted archive, backup/restore and deletion lifecycle |

Use only explicitly approved test recipients; do not call emergency numbers or unsolicited recipients. A synthetic test must never silently switch to a real destination. Test carrier features on the actual SIM/network; one successful call does not certify all carriers.

## Troubleshooting order

1. **Cannot log in:** verify public origin, RP ID, TLS, system clock, challenge configuration, and session storage. Do not bypass auth to make a test green.
2. **Gateway offline:** check app/service state, pairing epoch, own network, SIM registration, and capability diagnostics. Do not equate an online heartbeat with media readiness.
3. **Rings but no audio:** inspect relay candidates, selected node, transport-matched TURN grants, firewall/relay range, privileged capture or module UAC, and platform audio route.
4. **Gateway busy after a call:** compare physical telephony state with server state and pending acknowledgements. Preserve the command/replay journals; use supported reconciliation rather than deleting locks or restoring an old database.
5. **SMS unknown:** inspect the gateway's result and acknowledgement state before offering a manual retry; uncertain delivery is not safe automatic retry.
6. **No recording/transcript:** distinguish disabled capture, failed binding, no speech, incomplete upload, failed validator, and failed provider job. Never create a success record by relabeling missing data.

Collect a time-bounded, redacted timeline with synthetic call labels, event names, platform, transport, and error codes. Diagnostics can contain phone numbers, device data, IP addresses, or transcript text; review content before sharing.

## Upgrades and recovery

Freeze the candidate and read actual installed state before a change. Back up application binaries, private configuration, schema/data, and required recording state to restricted storage. Verify a restore plan and idle physical telephony before replacing a gateway. Use compatible signing and inspect actual feature gates.

Deploy compatible Control/schema changes before clients that require them, and enable server behavior only when gateway capability contracts allow it. Desired settings and acknowledged settings are separate. Keep rollback candidates, but do not roll back database/replay identity to make old code fit.

Test backups on an isolated instance. A copied database alone is not a full recovery: recording objects, gateway journals, secrets, push identities, and pending jobs may matter. Do not clone a live gateway token into a second active installation. Review retention for live data, exports, logs, caches, and backups separately.
