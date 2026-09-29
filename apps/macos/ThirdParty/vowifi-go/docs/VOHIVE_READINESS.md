# VoHive Readiness Gap Analysis

This document tracks the remaining work before `vowifi-go` should be treated
as usable inside VoHive. It is written as an integration checklist: each area
separates implemented code from the evidence still required for a real VoHive
runtime.

## Readiness Decision

`vowifi-go` is currently suitable for VoHive compatibility development and
loopback protocol work. It is not yet proven as a complete runtime replacement
inside VoHive.

"Usable in VoHive" means all of the following are true:

- An older VoHive checkout can resolve `github.com/boa-z/vowifi-go`, build the
  relevant runtime packages, and run the compatibility test matrix without a
  committed local `replace`.
- A controlled device trial completes modem/SIM identity, AKA, SWu/ePDG tunnel
  establishment, IMS registration, refresh, and shutdown cleanup.
- SMS, USSD, outbound voice, inbound voice, and the emergency-call policy are
  either validated through VoHive or explicitly guarded as unavailable.
- Runtime recovery for modem hangs, SIM busy, ePDG failure, P-CSCF failure, IMS
  recovery statuses, messaging failure, and media failure is observable from
  VoHive without leaking subscriber identifiers, keys, nonces, local machine
  details, or private paths.

## Current Position

The project has the right repository shape and much of the protocol surface is
already implemented. Current strengths include:

- Canonical module identity, local CI, GitHub Actions CI, module-path hygiene,
  privacy checks, and an old-VoHive compatibility workflow that runs against a
  temporary consumer checkout.
- Public runtime boundaries for SIM/ISIM AKA, SWu/ePDG, IMS registration,
  messaging, voice, carrier policy, E911, lifecycle state, and diagnostics.
- Loopback-heavy tests for AT/APDU/QMI helpers, IKEv2/EAP-AKA, ESP/TUN/XFRM
  primitives, IMS registration, SIP transport, SMS/USSD, E911 helpers, voice
  dialogs, SDP rewrite, RTP/RTCP, SRTP/SRTCP, and redacted trace fixtures.
- Redacted VoHive-facing diagnostic shapes for runtime state, event snapshots,
  IMS registration results, REGISTER recovery decisions, registration recovery
  state, and free-form runtime error text.

The remaining risk is evidence, integration, and carrier variation. Unit tests
show that many reconstructed pieces behave correctly in isolation. They do not
yet prove that VoHive can replace the original closed-source runtime on a real
modem/SIM/operator path.

## Readiness Levels

| Level | Meaning | Current Status |
| --- | --- | --- |
| Compile-compatible | VoHive resolves the module, selected packages build, and focused compatibility tests pass. | Mostly in place for the known checked packages. |
| Loopback-functional | Runtime flows pass deterministic tests with fake transports, fixture traces, and local sockets. | Partially in place across SIM, SWu, IMS, SMS/USSD, E911, and voice. |
| Device-functional | A real modem/SIM/ePDG/IMS path can register, keep alive, send SMS/USSD, place calls, and recover from common failures. | Not proven yet. |
| Production-ready | Carrier variation, emergency behavior, long-running stability, observability, rollback, and operational hardening are validated. | Not complete. |

## Readiness Matrix

| Area | In Place | Missing Before VoHive Use | Evidence Needed |
| --- | --- | --- | --- |
| Module and consumer compatibility | Canonical module path, module-path guard, CI, temporary old-VoHive rewrite/check workflow, main binary build check. | Keep the package matrix synchronized with every VoHive consumer and document the supported VoHive version range per release. | Compatibility job output for the target VoHive branch or tag, plus a release note that names the tested VoHive range. |
| Runtime lifecycle | `Start`, stop, state snapshots, SWu startup wiring, IMS registration wiring, SMS/USSD/voice transport wrapping, recovery state updates. | Prove start, stop, restart, cancellation, cleanup, and recovery from VoHive's actual call sites. Ensure every VoHive-facing surface consumes safe diagnostics. | A VoHive runtime trial log showing startup, ready state, recovery event, shutdown, and redacted state snapshots. |
| Modem, SIM, ISIM, and AKA | AT, APDU, CRSM, QMI UIM logical-channel helpers, identity readers, AKA challenge handling, typed recovery planning, opt-in AT control recovery. | Validate real device behavior under busy ports, hung control channels, locked SIMs, missing applets, multi-slot modems, and vendor recovery commands. | Redacted transcripts for IMEI, IMSI, ISIM identities, EF_AD, AKA success, AUTS sync failure, SIM busy, and control-port recovery. |
| SWu/ePDG tunnel | IKEv2, IKE_AUTH EAP-AKA/AKA', CHILD_SA, ESP, NAT-T helpers, MOBIKE, DPD, rekey metadata, userspace packet session, TUN routing, Linux XFRM planning. | Prove real ePDG tunnel establishment, DNS propagation, packet forwarding, MTU behavior, IPv4/IPv6 routing, rekey, DELETE cleanup, DPD, and MOBIKE under VoHive. | A controlled ePDG run with redacted IKE/EAP state, tunnel addresses, route cleanup, packet counters, and recoverable failure cases. |
| IMS registration and Security-Agree | REGISTER, Digest AKA, 401/407 retry, 423 retry, 494 planning, Security-Client/Server/Verify, XFRM install planning, refresh, de-registration, P-CSCF failover, CRLF keepalive, recovery hooks. | Prove initial registration, security association selection/install, refresh, failover, de-registration, and recovery against a real IMS path. | Redacted REGISTER traces for success, 401/407, stale nonce, AUTS, 423, 494, 5xx/Retry-After, selected P-CSCF, and shutdown de-registration. |
| SMS and USSD | SMS segmentation/PDU, CPIM, IMDN/delivery report handling, inbound SMS, USSD INVITE/INFO/BYE helpers, redirect/auth/retry classification, durable retry envelope planning, service-level retry replay APIs, optional runtime retry worker, and runtime recovery after recoverable IMS failures. | Enable/configure persisted retry replay in VoHive, define duplicate-risk handling, and validate carrier-specific payload variants through VoHive. | VoHive SMS/USSD tests for outbound, multipart, delivery report, inbound, USSD continue/cancel, retry replay, duplicate-risk refusal/reporting, and carrier content-type variants. |
| Voice | Outbound/inbound IMS agents, SIP dialog helpers, PRACK, UPDATE, re-INVITE, REFER/NOTIFY/SUBSCRIBE, OPTIONS, SIP INFO, SDP rewrite, RTP/RTCP relay, DTMF, SRTP/SRTCP, session timers, media quality helpers. | Prove real outbound and inbound calls through VoHive with local softphone interworking, negotiated media, hold/resume, transfer, teardown, and media diagnostics. | VoHive call traces for outbound, inbound, early media, answer, hold/resume, DTMF, transfer, BYE/CANCEL, RTP/RTCP counters, SRTP profile, and at least one recoverable dialog failure. |
| E911 and emergency policy | TS.43-style entitlement parsing, token/websheet helpers, HTTP Digest AKA, PIDF-LO, emergency headers, service URNs, 380/424 planning, emergency profile helpers. | Validate only in authorized test environments, or keep emergency calling explicitly disabled/guarded in VoHive until that evidence exists. | Entitlement bootstrap traces, PIDF-LO validation cases, emergency profile selection, 380/424 retries, and a documented VoHive guard state when validation is absent. |
| Carrier profiles | Carrier presets, JSON overrides, P-CSCF candidate normalization, AT&T-style TS.43/E911 profile data. | Build a carrier compatibility matrix with IMS domain, P-CSCF/ePDG discovery, access-network headers, codecs, SMS/USSD quirks, E911 behavior, and recovery policy. | One successful and one recoverable failure trace per supported carrier profile. |
| Observability and privacy | Redacted diagnostic state, redacted REGISTER recovery decisions, safe diagnostic error text, trace-fixture redaction checks. | Ensure all VoHive call sites use diagnostic views rather than raw protocol errors. Add leak-oriented checks for every new fixture and operator-facing field. | CI redaction reports plus VoHive UI/log examples that preserve actionability without exposing identities, nonces, keys, APDU payloads, IPs, MACs, or local paths. |
| Release discipline | Shared local/GitHub CI entry point, compatibility self-test, old-VoHive compatibility workflow. | Tag only after compatibility and controlled runtime evidence pass. Reject breaking APIs unless a VoHive migration is ready. | Release checklist with CI result, compat result, runtime trial result, known disabled features, and rollback instructions. |

## P0: Required Before A Controlled VoHive Runtime Trial

These items block using this repository as the primary runtime inside a
controlled VoHive trial.

### 1. Full VoHive Consumer Coverage

The compatibility workflow covers the known runtime consumer matrix and builds
the main VoHive binary in an isolated checkout. The remaining work is to keep
that matrix current and make compatibility evidence part of every release
candidate.

Done means:

- The compatibility job covers the complete known VoHive package list for the
  target branch or tag.
- The temporary VoHive checkout builds the main binary with this module.
- No compatibility step requires committing a local filesystem `replace`.
- The tested VoHive version range is recorded in release notes.

### 2. Real Modem And SIM Access Path

SIM/ISIM and AKA layers include substantial AT, APDU, CRSM, QMI UIM, recovery,
and identity functionality. The unproven gap is the real modem path under
device contention and vendor-specific recovery behavior.

Done means:

- IMEI, IMSI, ISIM identity, EF_AD, and AKA reads are validated on at least one
  target modem family used by VoHive.
- QMI UIM and AT logical-channel paths both have documented success/failure
  transcripts.
- Control-port recovery is wired into the runtime host with safe defaults and
  opt-in vendor commands.
- SIM busy, malformed reply, missing applet, no-card, PIN-required, and
  transport-hung cases produce actionable runtime errors.

### 3. SWu/ePDG End-To-End Tunnel

The SWu implementation has IKEv2, EAP-AKA/AKA', ESP, MOBIKE, CHILD_SA,
userspace packet sessions, TUN, routing, and XFRM primitives. The gap is a
full tunnel against a real ePDG and real host networking.

Done means:

- IKE_SA_INIT, IKE_AUTH with EAP-AKA/AKA', CHILD_SA setup, DNS configuration,
  and packet forwarding are validated against a real ePDG.
- NAT-T, DPD, DELETE cleanup, MOBIKE address updates, and CHILD_SA rekey are
  exercised in integration tests or captured trace replays.
- TUN setup, route exclusion, policy rules, MTU handling, IPv4/IPv6
  forwarding, and rollback are verified on the target Linux environment.
- Failure modes for authentication rejection, ePDG timeout, DNS failure,
  routing failure, and packet replay are surfaced to VoHive.

### 4. IMS Registration And Security-Agree Activation

REGISTER, Digest AKA, refresh, de-registration, P-CSCF failover,
Security-Agree selection, XFRM planning, keepalive, and recovery hooks are
implemented in pieces. The gap is proving that VoHive can complete and
maintain a real IMS registration.

Done means:

- Initial REGISTER succeeds with real AKA challenge material.
- 401/407, stale nonce, AUTS synchronization failure, 423 Min-Expires, 494
  Security Agreement Required, and 5xx/Retry-After recovery paths are
  exercised.
- Security-Client, Security-Server, Security-Verify, XFRM install, and selected
  SA usage are validated on the host where VoHive runs.
- P-CSCF failover and sticky selected-proxy behavior work across refresh and
  dialog requests.
- Registration refresh, CRLF keepalive, shutdown de-registration, and recovery
  re-registration are observable from VoHive.

### 5. Runtime Orchestration And Diagnostics

The library exposes lifecycle hooks and redacted diagnostics. The remaining
work is proving that VoHive's runtime controller consistently uses those hooks
for startup, shutdown, retries, support messages, and recovery.

Done means:

- VoHive can start, stop, recover, and report the runtime through stable APIs.
- Registration recovery refreshes the voice, SMS, USSD, and E911 transports
  without requiring a process restart.
- Long-running maintenance tasks have cancellation, timeout, and cleanup
  behavior that VoHive can control.
- VoHive displays supportable errors for modem control, SIM auth, ePDG, IMS,
  messaging, E911, and voice without exposing sensitive protocol material.

## P1: Required Before Broad VoHive Use

These items can follow a first controlled runtime trial, but they are required
before recommending wider VoHive use.

### 6. SMS, USSD, And Messaging Recovery

SMS and USSD have substantial encoding, parsing, SIP MESSAGE, CPIM, redirect,
delivery-report, retry planning, service-level retry replay, and an optional
runtime retry worker. The main gap is enabling that worker from VoHive and
carrier validation.

Done means:

- Outbound SMS, multipart SMS, delivery reports, inbound SMS, USSD INVITE/INFO,
  USSD BYE, redirects, and authentication challenges are tested through VoHive.
- Durable retry envelopes can be replayed through the service API and drained
  by the runtime retry worker or an explicit VoHive scheduler.
- Duplicate-risk cases are clearly separated from safe replay cases.
- Carrier-specific content-type, CPIM, RP, TP-DCS, UDH, and national-language
  variations have trace fixtures.

### 7. Voice Call Parity

Voice has broad SIP dialog, SDP, RTP/RTCP, SRTP, DTMF, supplementary-service,
and session-timer functionality. The remaining gap is proving real call
behavior through VoHive and at least one local softphone integration.

Done means:

- Outbound and inbound calls complete setup, early media, answer, hold, resume,
  DTMF, transfer, and teardown.
- Reliable provisional responses and PRACK are validated through the full call
  path.
- UPDATE, re-INVITE, Session-Expires refresh, CANCEL, BYE, REFER/NOTIFY,
  SUBSCRIBE, INFO, MESSAGE, and OPTIONS behavior are validated against fixture
  traces and at least one real IMS environment.
- RTP/RTCP and SRTP/SRTCP relay quality events feed runtime recovery or
  user-visible diagnostics.
- Codec and security-profile support is documented for the VoHive target
  environment.

### 8. E911 And Emergency Calling

E911 support has request construction, entitlement parsing, emergency headers,
PIDF-LO, and recovery planning. Emergency behavior needs a higher validation
bar than normal voice.

Done means:

- TS.43 entitlement bootstrap, token/websheet flow, address validation, cache
  refresh, and emergency profile selection are tested through VoHive.
- PIDF-LO, Geolocation, multipart body, emergency Request-URI, and
  service-category mapping are validated against trace fixtures.
- 380 Alternative Service and 424 Bad Location Information retries rebuild the
  emergency plan and PIDF-LO at runtime.
- Emergency call behavior is clearly marked experimental until validated with
  authorized test environments, or VoHive explicitly disables/guards it.

### 9. Carrier Profiles And Compatibility Matrix

Carrier presets and overrides exist, but production usefulness depends on
operator-specific quirks.

Done means:

- Each supported carrier has a documented profile: IMS domain, P-CSCF
  discovery, ePDG identity, access-network headers, emergency settings,
  supported codecs, SMS/USSD behavior, and known recovery behavior.
- Carrier overrides are loaded and reported without leaking sensitive data.
- Trace fixtures cover at least one successful and one recoverable failure path
  per supported carrier profile.

## P2: Required Before Production Claims

These items are required before any production-readiness claim.

### 10. Security And Privacy Hardening

Done means:

- Nonces, keys, IMS identities, SIM material, APDU payloads, IPs, MACs, and
  local paths are redacted from logs, runtime diagnostic state, free-form
  runtime errors, and fixtures by default.
- XFRM, TUN, route, and command execution boundaries are privilege-minimized and
  rollback-safe.
- Long-running goroutines, sockets, file descriptors, TUN devices, routes, and
  XFRM state are cleaned up under normal shutdown and failure paths.
- CI includes leak-oriented fixture checks and negative tests for sensitive
  output.

### 11. Observability And Supportability

Done means:

- Runtime state exposes registration, tunnel, modem, messaging, E911, and voice
  health snapshots.
- Recovery decisions include reason codes, retry timing, and next actions.
- VoHive can present concise user-facing failures for modem control, SIM auth,
  ePDG, IMS registration, messaging, E911, and voice media.

### 12. Release Discipline

Done means:

- Semantic tags are cut only after compatibility gates pass.
- The supported VoHive version range is documented for each release.
- Breaking API changes are rejected unless VoHive migration work is completed
  first.
- Compatibility tests run on pull requests and release candidates.

## Acceptance Checklist For "Usable In VoHive"

The project should not be described as usable in VoHive until all of the
following evidence exists:

- A full VoHive compatibility job passes for the target VoHive branch or tag.
- A controlled runtime test completes modem/SIM identity, AKA, SWu/ePDG, IMS
  REGISTER, refresh, and shutdown cleanup.
- SMS and USSD work through VoHive with recovery behavior documented.
- At least one outbound and one inbound voice call complete through VoHive,
  including RTP/RTCP media and teardown.
- Emergency behavior is either validated in an authorized test environment or
  explicitly disabled/guarded in VoHive.
- Logs, runtime states, and trace fixtures pass redaction checks.
- Recovery behavior for modem hangs, SIM busy, ePDG failure, P-CSCF failure,
  IMS 401/407/423/494/5xx, messaging failure, and media failure is documented
  with expected runtime actions.

## Recommended Next Implementation Order

1. Keep the VoHive compatibility package matrix synchronized with current
   VoHive consumers on every release candidate.
2. Capture a real modem/SIM identity and AKA validation pass, including busy
   control-port and safe recovery cases.
3. Prove SWu/ePDG tunnel setup, packet forwarding, and cleanup in a controlled
   environment.
4. Prove IMS registration with Security-Agree, refresh maintenance, failover,
   keepalive, and de-registration.
5. Enable and tune durable SMS/USSD retry replay from VoHive using the runtime
   retry worker or an explicit VoHive scheduler.
6. Run VoHive SMS/USSD trials with outbound, inbound, multipart, delivery
   report, redirect, authentication, and retry cases.
7. Run VoHive outbound and inbound voice trials with real media, PRACK,
   UPDATE/re-INVITE, hold/resume, DTMF, transfer, teardown, and SRTP/RTCP
   evidence.
8. Add or update carrier trace fixtures for registration, SMS/USSD, voice, and
   E911 before claiming carrier support.
9. Keep emergency calling disabled or guarded until authorized E911 validation
   evidence exists.

## Status Copy

Use this wording when describing the current state of the project:

> `vowifi-go` is an independent open Go implementation of the VoHive VoWiFi
> runtime boundary. It already provides a compile-compatible and loopback-tested
> reconstruction base for SIM/ISIM AKA, SWu/ePDG, IMS registration, messaging,
> voice, E911, and diagnostics. It is still under active development and is not
> yet proven as a complete replacement for the original closed-source runtime in
> VoHive. Real modem/SIM, ePDG, IMS, SMS/USSD, voice, emergency, carrier, and
> long-running recovery validation are still required before it should be
> described as usable in VoHive.

## Current Summary

`vowifi-go` has moved beyond a placeholder API shim: it now contains many real
protocol components and VoHive-facing runtime hooks. The decisive remaining
work is to turn loopback functionality into device evidence, then into VoHive
integration evidence. Until those evidence gates pass, the correct project
status is "experimental compatibility development module", not "drop-in VoHive
runtime replacement".
