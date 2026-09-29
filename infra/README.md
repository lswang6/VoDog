# VoDog host installation and builds

This is a **fresh, dedicated Ubuntu 24.04 amd64 host** deployment. It builds Control,
media, voice and Web from this checkout, installs PostgreSQL 16 and coturn, issues
HTTPS/TURN certificates, creates an admin account, and schedules certificate renewal
and bounded retention. There are no SSH aliases, deployment credentials or device IDs.
First-party code uses the repository AGPL-3.0 license; bundled upstream components
retain their own licenses. No command here publishes a release or installs a phone APK.

## Prepare and install

Use a host with Docker-compatible Linux networking, at least 4 GB RAM and sufficient
recording storage. The bootstrap installs Docker Compose, Certbot and Python through
Ubuntu packages. Container builds need internet access to their upstream registries.
Node 22 and Go 1.26.4 match the current application inputs. Images use version tags;
review and pin tested image digests for reproducible deployments.

Point your application and TURN DNS A records to the host. Do not create an AAAA record
unless you independently configure IPv6. Allow inbound TCP 80/443, UDP 3478, TCP 5349,
and UDP 49160–49200 in the host/provider firewall. Preserve your own administration
access. Do not expose 5432, 16880 or 16881. The installer does not alter firewall rules.
Use a directly assigned public IPv4 where possible. If NAT is used, `--listen-ip` is
the interface address and `--public-ip` the mapped address; the NAT must support relay
hairpin traffic and preserve the UDP relay ports. Documentation IPs below are examples.

Run on the intended host from the public checkout, replacing the domains and addresses:

```sh
python3 infra/prepare.py \
  --domain app.example.com --turn-domain turn.example.com \
  --public-ip 203.0.113.10 --listen-ip 192.0.2.10 \
  --output /srv/vodog-state
sudo bash infra/install-host.sh /srv/vodog-state admin@example.com
```

Preparation only creates files. It generates independent cryptographic secrets and an
admin password; it refuses an existing output directory or one inside the checkout.
Installation deliberately rejects example.com domains. The email passed to the installer
is your ACME contact and executing it accepts the CA's terms. Ports 80/443 must be free.
Never commit the generated state directory, certificates, database volumes or recordings.

The installer builds images before starting services, runs schema migration, waits for
Control/PostgreSQL, then seeds `admin@example.com` using the generated `admin.env` password.
You may change the username in that private file before installation. Read the password
privately; it is not printed by the installer. Re-running the seed resets that user's
password/role, so reserve it for intentional account recovery.

All generated files start mode 600 under a mode-700 directory. Installation assigns
`data/`, `ai-token`, and `control.env` to UID/GID 10001. Control, media, voice and retention
run as this non-root identity. Voice sees only its own environment and the mode-600 token
file; it receives no database, media or TURN server secrets. PostgreSQL has a separate
persistent Docker volume. Application data is in the generated `data/` directory.

The Linux host network is intentional: Control and media **bind to 127.0.0.1**, as required
by their entrypoints, and share loopback with the proxy/voice worker. PostgreSQL publishes
only on 127.0.0.1. Nginx exposes API paths and two signed media probe paths; `/internal/`
and the media bridge's raw offer/close/recording endpoints are never publicly proxied.

## Features and worker contracts

The fresh-host config enables Pixel archive upload/validation, command replay migration
and horizon, DTMF, early media, busy conflict handling, Pixel-originated calls and Web call
liveness. Use the matching current gateway built with all five feature gates below.
Pair a gateway using the admin interface; the installer does not seed a real device or SIM.
Push notifications require your own APNs/FCM credentials and signing identities.

Control's `server.ts` starts transcription; `buildApp` starts AI reconciliation, media
cleanup, push and badge workers. Reports are produced within the transcription pipeline.
Do not create duplicate transcription/report/badge processes. Provider features start off:

- Voice: edit `voice.env`, set `XAI_API_KEY` plus exactly one of `XAI_AGENT_ID` or
  `XAI_REALTIME_MODEL`; configure `VOICE_PROVIDER` as needed. Start the `voice` profile,
  inspect worker health, then set `AI_ENABLED=true` and `AI_WORKER_READY=true` in
  `control.env` and recreate Control. The shared AI token is generated automatically.
- Transcription: set `TRANSCRIPTION_ENABLED=true`, `TRANSCRIPTION_ENABLED_AT` to an
  explicit UTC timestamp and `TRANSCRIPTION_API_KEY`. A compatible endpoint additionally
  needs `TRANSCRIPTION_BASE_URL` and `TRANSCRIPTION_MODEL`. Optional report classification
  requires all three `REPORT_AI_BASE_URL`, `REPORT_AI_API_KEY`, `REPORT_AI_MODEL` values.
- Push/badges: provide your own APNs/FCM configuration and read-only credential mounts
  in the generated Compose file; enable `BADGE_PUSH_ENABLED` only after push works.
- Native app links/passkeys: configure your own signing fingerprints, Apple team,
  association files and `ANDROID_PASSKEY_ORIGINS`. No production signing IDs are bundled.

For example, use `docker compose --project-directory /srv/vodog-state -f
/srv/vodog-state/compose.json --profile voice up -d voice` after configuring a provider.
The image build checks that the native WebRTC audio dependency loads on Linux amd64.

## Retention, backups and upgrades

`vodog-retention.timer` runs the existing bounded retention implementation daily in an
isolated container with Python and psql. It removes expired housekeeping rows and orphan
recordings. Calls and SMS are retained unless you explicitly set `RETENTION_CALL_DAYS`
and/or `RETENTION_SMS_DAYS` in `control.env`. Review a read-only report before changing
policy:

```sh
sudo docker compose --project-directory /srv/vodog-state -f /srv/vodog-state/compose.json \
  --profile maintenance run --rm retention
```

The generated job uses `relay-primary` and `--no-remote` for this single-host installation.
For multi-node deployments, review remote recording deletion and backups separately.
Local recording and Pixel archive paths remain mounted at `/data` for all relevant jobs.
`X-CC-*` recording-signature headers retain the application's current wire contract.

Back up PostgreSQL, the private state directory, recordings and certificates off-host;
test restoration before relying on the installation. Stop writers for a consistent
filesystem/database snapshot. Never use `docker compose down -v` as an upgrade step.
Before updating, keep prior image IDs and a database/data backup. Build reviewed source,
then use the same state directory with `docker compose ... up -d --build --wait`.
Review schema compatibility before rolling back; restoring an old image alone cannot
undo a database migration. The fresh-host bootstrap refuses an existing database volume.

Certbot renews through the HTTP webroot and its deployment hook restarts Web/coturn.
This can interrupt active media sessions; schedule certificate renewal during your
maintenance window. Verify renewal with `sudo certbot renew --dry-run` on the new host.

## Verification and honest acceptance

Offline checks (no Docker daemon or network service required):

```sh
python3 -B infra/test_prepare.py
python3 -B infra/test_retention.py
bash -n infra/install-host.sh scripts/build-android.sh
docker compose --project-directory /srv/vodog-state -f /srv/vodog-state/compose.json \
  --profile voice --profile maintenance --profile setup config --quiet
```

Retention database tests require a disposable, loopback `TEST_DATABASE_URL` containing
`test` in the database name and psql on PATH (or `PSQL`); they recreate its public schema.
Without that explicit database, those integration tests are skipped.

After installation, verify Control and media loopback health, HTTPS login, private route
rejection, the TURN TLS certificate, and actual relay connectivity. A health response or
Compose validation alone does not establish working media. To test HTTPS signaling plus
**UDP TURN allocation and relay-only media data-channel echo**, build the existing probe
and run the wrapper on the test host:

```sh
(cd services/media && go build -o /tmp/vodog-quality-relay-probe ./cmd/quality-relay-probe)
sudo python3 infra/check-media.py /srv/vodog-state --probe-binary /tmp/vodog-quality-relay-probe
openssl s_client -connect turn.example.com:5349 -servername turn.example.com -verify_return_error </dev/null
```

The wrapper gives short-lived signed grants to the probe through stdin and exits nonzero
on failed echo or a non-relay selected pair. It does not dial a phone. TLS certificate
validation is separate; test actual TURN/TLS fallback and native WebRTC clients as well.
Then verify real gateway pairing, SIM synchronization, calls, SMS, recordings and AI with
consenting test participants. These are distinct from compilation and synthetic echo.

Release preparation verified config generation, schema contracts, syntax and offline
checks. **Container builds, fresh-host installation, certificate issuance/renewal, TURN
connectivity, provider calls and physical devices have not been validated here.**

## Android and Pixel module builds

```sh
VODOG_API_BASE_URL=https://vodog.example.com/api/v1 bash scripts/build-android.sh
python3 infra/pixel/build-module.py apps/android/gateway/build/outputs/apk/debug/gateway-debug.apk \
  --aapt /path/to/android-sdk/build-tools/version/aapt \
  --selinux-domain priv_app_36 --output /tmp/vodog-pixel-module
```

`VODOG_API_BASE_URL` must be an HTTPS API URL with path exactly `/api/v1`, without
credentials, query or fragment. The Android script runs both unit test targets and debug builds with the five gateway
feature gates. Debug signing is for development; configure your own release key for
redistribution. The Pixel builder validates package `org.vodog.gateway`, required
privileged permissions, and writes a module plus SHA-256 manifest. Supply the **verified
SELinux domain for your OS/target SDK**; `priv_app_36` is an example, not a universal value.
Neither script installs, roots, reboots, signs with a private key, or publishes anything.
The Magisk installer retains upstream provenance and the GPL license in the module ZIP.
