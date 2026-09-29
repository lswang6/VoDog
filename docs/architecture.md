# Architecture and data flow

[Documentation](README.md) · [简体中文](architecture.zh-CN.md)

## Responsibilities

Control is the authoritative state machine. It authenticates users and gateways, assigns SIMs, arbitrates call ownership, queues commands and SMS, stores contacts and blocklists, and coordinates recordings, transcription, reports, and AI leases. PostgreSQL stores business state. Clients do not directly access the database or drive a remote SIM.

A gateway translates commands into physical telephony actions and reports observations. Pixel uses Android Telecom / InCallService and privileged audio capture/injection. The DJI gateway uses the module's AT control and USB audio through the macOS integration. Readiness for telephony, SMS, and media is reported separately; a heartbeat alone is not proof of working audio.

The Go/Pion media bridge has gateway and client roles. Gateway audio uses the `cellular-opus-v1` data-channel protocol; clients and the AI worker use WebRTC media. coturn is a separate relay service. Control supplies short-lived media authorization and transport-matched TURN configuration. Do not substitute a STUN-only setup for this relay-only design.

## Remote call

1. A signed-in client selects an assigned SIM and requests a call, or claims an incoming call.
2. Control checks ownership, gateway readiness, and device occupancy before issuing the command.
3. The gateway executes and acknowledges the command, then reports actual telephony state.
4. The selected media node connects the gateway and winning client. UI state cannot authorize a second answer or dial.
5. End requests and physical observations converge through Control; media failure and stale ownership are reconciled rather than assumed successful.

Several SIMs in one Pixel do not mean several simultaneous independent audio calls. A module is one physical call resource. Competing clients must respect server ownership, including a call answered elsewhere.

## Local calling and SMS

With the relevant feature gates, Pixel-originated outgoing calls can create shared records and passive archives. The macOS client can select a local attached module and route the call through Mac microphone/speakers and module USB audio without the remote media bridge. Its gateway integration still needs pairing and capture binding to upload a shared archive. A local call can succeed even when archive binding fails.

SMS uses persistent queues and explicit outcomes. A timeout can mean the modem sent the message but the acknowledgement was lost. An `unknown` result must not be blindly resent. Multipart updates can fill an existing conversation item as later parts arrive. Gateway-originated SMS observation is separate from sending through Control.

## Identity and recovery contracts

Gateway credentials have epochs; commands and observations carry generation/assignment context. SIM identity is not a slot index, display number, or transient Android subscription ID. Preserve ownership checks across removal, reassignment, and migration.

Pixel's replay journal protects against executing old commands again. Do not reset it, lower its floor, restore an old database, or fabricate completion to remove a readiness error. DJI has its own command journal and attach-time protections; do not claim identical Pixel replay-horizon support.

Deletion of a call is a coordinated lifecycle across records, recordings, archive uploads, and workers. It is not equivalent to deleting an arbitrary directory. Local exports, independent recorders, diagnostics, and backups have separate retention responsibilities.

## Source map

Use `services/control/src` for API/schema/config contracts; `services/media` for transport and server recordings; `services/voice` for provider and worker lifecycle; `apps/android/gateway` for Pixel execution; and `apps/macos` for module behavior. Client implementations are under their respective `apps` directories. Dependency manifests and the actual exported code take precedence over documentation examples when names or toolchain versions differ.
