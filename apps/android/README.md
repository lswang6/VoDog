# VoDog Android

Two applications: client (`org.vodog`) and privileged cellular gateway
(`org.vodog.gateway`). First-party code is AGPL-3.0-only. Third-party notices
and licenses remain applicable; see [gateway/THIRD_PARTY.md](gateway/THIRD_PARTY.md).
The gateway contains GPL-3.0-covered BCP adaptations; their existing notices are retained.

## Build and local tests

Install JDK 17, Android SDK platform 36 and build tools. Set `JAVA_HOME` and
`ANDROID_HOME` to your own installations. The checked-in Gradle 9.1.0 wrapper
verifies its distribution SHA-256. No SDK paths, signing keys or Firebase project
configuration are included.

From this directory:

```sh
./gradlew :client:testDebugUnitTest :client:assembleDebug   :gateway:testDebugUnitTest :gateway:assembleDebug --no-daemon --max-workers=1
```

Default endpoints are inert examples. Set your HTTPS endpoints with
`-PvodogApiBaseUrl=https://control.example.com/api/v1` and
`-PvodogRelayApiBaseUrl=https://relay.example.com:16800/api/v1`.
Both properties accept an HTTPS origin or a URL ending in `/api/v1` (optional
trailing slash); builds normalize them to exactly `/api/v1`. The root
`scripts/build-android.sh` forwards `VODOG_API_BASE_URL` as `vodogApiBaseUrl`; that script requires the full HTTPS `/api/v1` URL.
When a primary URL is provided and no relay override is supplied, both routes
use that URL; deployments with a separate relay set `vodogRelayApiBaseUrl`.
The properties in [vodog.properties.example](vodog.properties.example) are a reference;
Gradle does not automatically load that file. Turnstile uses the API origin.
For passkeys, replace the example asset-link URL in
`client/src/main/res/values/strings.xml`, host matching Digital Asset Links for
`org.vodog` and your signing certificate, and configure the server relying-party ID.

## Native Opus gateway

Install CMake 3.22.1 and an Android NDK through your SDK manager.
The native library is built from source as `libvodog_opus.so`, for arm64-v8a.
CMake downloads libopus 1.6.1 from Xiph and verifies its pinned SHA-256;
no prebuilt first-party native objects are shipped.

```sh
./gradlew :gateway:testDebugUnitTest :gateway:assembleDebug   -PvodogLibopusFec=true -PvodogReceiveRecovery=true   --no-daemon --max-workers=1
```

Other gateway capabilities are explicit opt-ins:
`vodogCellularAcceptance`, `vodogRecordingArchive` and
`vodogCommandReplayHorizon`. All default to false. Recovery requires native Opus.
BCP is optional: an absent service is skipped; installed component states are saved and restored exactly.
A build is not device or cellular acceptance: the gateway requires compatible
privileged telephony/audio permissions, a configured server and an attended test device.

## Optional Firebase push

Without `client/google-services.json`, the Google Services plugin is not applied
and push registration reports unavailable; the applications still build.
The [.example template](client/google-services.json.example) contains synthetic,
nonfunctional values. Configure your own Firebase project for `org.vodog`
and place its downloaded configuration at `client/google-services.json` locally.
Never commit that file or signing stores.

The `-Ps33UiTest=true` client variant uses loopback port 16880 with isolated
placeholder Firebase resources. Its instrumentation suite needs a local fixture
server and fixture input; it is not part of ordinary JVM tests.
Other instrumentation suites require a device and some require supplied synthetic
codec fixtures or a configured relay. Do not run connected tests against live
devices as part of public packaging.

Release builds are unsigned; configure signing privately. Local debug build outputs
and caches are ignored. Do not include generated APKs, logs, recordings, private
configuration or test evidence in the source export.

## Export validation

Run `python3 scripts/check-public-export.py` to check package paths, manifest XML,
all JNI exports, the wrapper archive and forbidden local artifacts.
JVM archive integration and Go-validator checks require explicit
`VODOG_ARCHIVE_IT_*` / `VODOG_RECORDING_VALIDATOR` environment inputs;
they skip when these are absent. Test identities are synthetic and must never
be used to dial or message real recipients. Standard carrier short codes and
country-code normalization examples remain test data.
Wire magic such as `CCQ1` remains unchanged for protocol compatibility.
