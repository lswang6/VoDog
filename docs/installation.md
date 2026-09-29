# Install and configure

[Documentation](README.md) · [简体中文](installation.zh-CN.md) · [AI playbook](../readme-for-ai.md)

Use the [fresh-host installer](../infra/README.md) for a dedicated **Ubuntu 24.04 amd64** machine. It prepares private configuration and builds/deploys the services. Local configuration/schema/syntax checks have been run during release preparation; container builds, a fresh-host install, certificate issuance, TURN connectivity, and physical devices remain unverified. Complete [acceptance](operations.md) for your installation.

## 1. Prepare and run the host installer

Prepare a dedicated host with at least 4 GB RAM, sufficient recording storage, free TCP ports 80/443, and internet access for package/container downloads. Point application and TURN DNS A records to it. Open TCP 80/443, UDP 3478, TCP 5349, and UDP 49160–49200 in both host/provider firewalls; keep 5432, 16880 and 16881 private. The installer does not change firewall rules. Do not add AAAA records without configuring IPv6.

From the public checkout on that host, replace every example value:

```bash
python3 infra/prepare.py \
  --domain vodog.example.com --turn-domain turn.example.com \
  --public-ip 203.0.113.10 --listen-ip 192.0.2.10 \
  --output /srv/vodog-state
sudo bash infra/install-host.sh /srv/vodog-state admin@example.com
```

For a directly assigned public IPv4, use its actual address for both IP flags. Behind NAT, `--listen-ip` is the interface address and `--public-ip` is the mapped address; preserve the relay ports and verify hairpin support. The addresses above are documentation ranges. Installation rejects example domains: enter domains you control. The final email argument is your ACME contact; installation accepts the certificate authority's terms.

`prepare.py` only creates a new private state directory outside the checkout, with independent secrets and an administrator password. Inspect its generated configuration locally; do not commit it. `install-host.sh` installs the host dependencies, builds containers, initializes the database, issues certificates, starts services, seeds the account defined in private `admin.env`, and schedules renewal/retention. Read the generated password privately. A fresh bootstrap refuses an existing database volume; use the component guide for upgrades instead.

The generated deployment serves Web/API and signed media probe routes through the application domain; a separate media domain is only a custom multi-node option. Its default node is `relay-primary`. Provider AI/transcription and push start disabled. Do not add duplicate transcript/report workers: Control already starts them. The current installer configures the telephony features for the matching five-gate gateway build.

## 2. Understand the generated deployment

You need a Linux VPS or equivalent host, PostgreSQL, Node.js with native dependency support, Go for building media/validation tools, a reverse proxy with HTTPS, coturn, persistent recording storage, and a supported gateway. Follow repository manifests for exact toolchain versions. A Mac with Xcode is needed for Apple builds; Android builds need the SDK and the repository's Gradle wrapper. MP3 export also needs ffmpeg with the required codec support.

Use your own DNS names. A single-host starting layout is:

| Service | Example | Exposure |
| --- | --- | --- |
| Web + public API | `https://vodog.example.com` | Public HTTPS; proxy `/api/v1` to Control |
| Media endpoint | `https://media.example.com` | Only intended, authenticated signaling/probe routes |
| TURN | `turn.example.com` | Configured UDP/TCP/TLS listeners and relay allocation range |
| Media node identity | `relay-primary` | Same identifier in Control and media configuration |
| PostgreSQL / internal APIs | Host-local or private service network | Not public |

Examples are not reachable infrastructure. Use real DNS records and trusted certificates for your own domains. Ordinary HTTP reverse proxies do not carry TURN UDP or substitute for TURN TLS. Open the coturn listener ports **and** its configured relay range in the host and provider firewall. Verify advertised relay addresses, NAT mapping, certificate chain/SNI, and UDP/TLS independently. Do not disable TLS verification to work around a mismatch.

## 3. Review Control configuration

The configuration schema in `services/control/src/config.ts` is authoritative. Supply secrets through a restricted environment file or service manager outside Git. Do not assume an arbitrary `.env` file is loaded automatically.

| Configuration | Purpose |
| --- | --- |
| `DATABASE_URL` | Dedicated application database and restricted database user |
| `PUBLIC_ORIGIN` | Your public HTTPS origin, such as `https://vodog.example.com` |
| `RP_ID` | Your WebAuthn relying-party domain, such as `vodog.example.com` |
| `COOKIE_SECRET` | Fresh high-entropy secret, at least the schema's minimum length |
| `PORT` | Control listener; keep direct access private behind the proxy |
| `MEDIA_SECRET`, `TURN_SECRET` | Independent generated secrets shared only with the relevant service |
| `MEDIA_NODES_JSON`, `MEDIA_DEFAULT_NODE_ID` | Actual node registry and default, e.g. `relay-primary`; use the parser's exact fields |
| `RECORDING_ROOT` | Service-owned media recording storage |
| `PIXEL_ARCHIVE_ROOT`, `PIXEL_ARCHIVE_VALIDATOR_PATH` | Original-archive storage and built validator; schema requires absolute resolved paths |
| `RECORDING_MP3_CACHE_DIR` | Private export cache; requires ffmpeg |

Select a private installation/data root yourself, resolve it at provisioning time, and pass the resulting paths through these settings. Do not paste another operator's filesystem layout. Preserve separate storage roots and service permissions. The `PIXEL_*` archive keys are protocol/configuration names also used by the module integration, not a promise of Pixel-only behavior.

The installer performs migration and administrator creation. Do not run seed again routinely: it replaces the password/role of a matching account. For a custom deployment, review `npm run migrate` and `npm run seed`; the latter reads private `TEST_USERNAME`, `TEST_PASSWORD`, and `TEST_USER_ROLE=admin`. There are no default public credentials.

## 4. Check services, then clients

Build and configure the media service, archive validator, coturn, and reverse proxy. Register the same node identifier, media secret, TURN secret, endpoints, and storage contracts in all relevant components. Deny public access to internal worker routes; if a worker runs elsewhere, provide a reviewed authenticated private transport. A publicly reachable HTTPS site alone is not a healthy media deployment.

Start Control and its configured background jobs, then serve the built Web assets. Complete a normal user login and verify account scope before connecting hardware. If Turnstile is enabled, configure both site and secret keys and complete the actual challenge; never weaken authentication to pass automation.

Review every `infra` script before execution. A filename beginning with “deploy”, “configure”, or “probe” can perform writes, install software, or trigger real calls/messages. The existence of a script is not approval to run it, nor proof that its defaults fit your host.

## 5. Configure optional integrations

| Integration | What you supply | Without it |
| --- | --- | --- |
| iOS background calls | Apple signing/team setup, bundle entitlements, `APNS_KEY_ID`, `APNS_TEAM_ID`, private `APNS_KEY_PATH`, matching push topics/environment | No claim of background incoming calls |
| Android push | Your Firebase project and app config, `FCM_PROJECT_ID`, private `FCM_CREDENTIALS_PATH`, then `FCM_ENABLED` | Foreground testing only; no FCM delivery claim |
| Passkeys | Correct RP ID/origin; Apple associated domains and Android signing-certificate origins for the installed apps | Password login remains the initial path; do not register against placeholder domains |
| Turnstile | Your site key, secret key, allowed domains, and enable flag | No challenge integration |
| AI answering | Configured provider credentials, private worker token, healthy voice worker and feature gates | Human-only operation |
| Transcription/reports | Supported provider credentials, models, worker/storage configuration | Recordings need not have transcripts or reports |

Apple/FCM credentials are optional for a source build, not optional evidence for background delivery. Use your own signing material. `org.vodog` and its suffixes are source identity defaults, not transferable App Store registrations or entitlement grants.

## 6. Set up and pair one gateway

Follow the concrete [Pixel setup](pixel-setup.md) or [DJI/macOS setup](dji-setup.md), alongside the [hardware guide](hardware.md). Build an appropriate candidate, review permissions and feature gates, and install only in an authorized maintenance window. Pixel installs need a compatible privileged module and actual granted permissions. Mac module setup needs the supported USB/audio runtime and app permissions.

In the Web administrator interface, create a gateway, generate a short-lived pairing code, and enter it in the gateway's settings with your own server URL. Assign the discovered SIM to the intended account. Check telephony, SMS, media, ownership, and synchronization readiness separately. Do not manually invent a SIM identity or import another deployment's device token.

Enable mutually compatible server and gateway features in the order required by their contracts. Raw application defaults leave several features off, while the host installer explicitly enables matching telephony/archive capabilities; setting every flag to true is not an installation strategy. DTMF/replay capabilities must agree before enabling associated server behavior. Confirm desired settings have been acknowledged by the gateway, not merely saved by Control.

## 7. Accept and operate

Validate foreground Web first, then each native client, background notifications where configured, both relay transports, real inbound/outbound calls, SMS, recordings, and AI separately. Review [operations](operations.md), [recording/AI](recording-ai.md), and [privacy](security.md). Keep secrets and deployment results outside public docs. A failure should remain an explicit open item, with a reproducible symptom and no private identifiers.
