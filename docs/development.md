# Develop and test

[Documentation](README.md) · [简体中文](development.zh-CN.md)

Run from the VoDog repository root. These commands build or test source; they do not install gateways, deploy servers, publish releases, or prove real cellular behavior. Use the lockfiles and declared Go, Gradle, Android SDK, Swift, and Xcode requirements rather than guessing compatibility from a successful dependency install.

## Web and services

```bash
(cd apps/web && npm ci && npm test && npm run build)
(cd services/control && npm ci && npm run build)
(cd services/media && go test -race ./...)
(cd services/recording-archive-validator && go test ./...)
(cd services/voice && npm ci && npm test)
```

Control database tests require **three independent disposable databases**. Create these yourself on an isolated PostgreSQL instance; all three database names must contain `test`. Tests can rebuild the public schema. Never substitute a production URL.

```bash
(cd services/control &&   TEST_DATABASE_URL=postgresql://localhost/vodog_control_test   REPLAY_TEST_DATABASE_URL=postgresql://localhost/vodog_replay_test   REPLAY_MIGRATION_TEST_DATABASE_URL=postgresql://localhost/vodog_replay_migration_test   npm test)
```

Missing database variables can skip part of the suite or fail it. Report skipped cases and prerequisites. Native WebRTC dependencies in the voice service must load on the intended runtime/architecture; passing JavaScript-only tests does not prove that.

## Android

```bash
(cd apps/android && ./gradlew   :client:testDebugUnitTest :client:assembleDebug   :gateway:testDebugUnitTest :gateway:assembleDebug   --no-daemon --max-workers=1)
```

A default gateway build deliberately leaves physical-call capabilities gated. A reviewed acceptance candidate uses the corresponding exported Gradle properties:

```bash
(cd apps/android && ./gradlew :gateway:testDebugUnitTest :gateway:assembleDebug   -PvodogCellularAcceptance=true   -PvodogRecordingArchive=true   -PvodogLibopusFec=true   -PvodogReceiveRecovery=true   -PvodogCommandReplayHorizon=true   --no-daemon --max-workers=1)
```

This command does not authorize installation or calls. Verify the resulting APK's actual gates, application ID, certificate, and server compatibility. Configure `vodogApiBaseUrl` with your HTTPS `/api/v1` URL for real use; example endpoints cannot serve calls. Release signing and Firebase configuration are private per-deployment inputs. A debug APK is not a signed distribution release.

## iOS

The exported XcodeGen project is `VoDog`, with iOS 17 as its source deployment target. Select an installed simulator; `IOS_SIMULATOR` below is a local shell variable, not an application setting.

```bash
export IOS_SIMULATOR='iPhone simulator name from Xcode'
(cd apps/ios && xcodegen generate && xcodebuild   -project VoDog.xcodeproj -scheme VoDog   -destination "platform=iOS Simulator,name=$IOS_SIMULATOR"   -derivedDataPath ../../build/ios-derived   test -only-testing:VoDogTests)
```

Configure your own Apple team for signed device builds and set `VODOG_DOMAIN` to your domain for associated domains. Keep Xcode’s normal simulator signing enabled when running tests; the command above deliberately does not set `CODE_SIGNING_ALLOWED=NO`. An unsigned build is a compile-only check, not executable simulator-test acceptance. Do not globally disable app signing to bypass Keychain/session errors: a build can succeed while session persistence fails. Simulator tests do not cover APNs delivery, physical CallKit/audio behavior, background ringing, or distribution signing.

## macOS

Read [licensing](licensing.md) before building or distributing the CellDock-derived integration. The Swift package, system frameworks, native helper/runtime sources, and WebRTC/Opus dependencies are part of this build, not an Electron wrapper.

```bash
(cd apps/macos && swift build)
(cd apps/macos && scripts/run_tests.sh)
(cd apps/macos && scripts/run_gateway_control_tests.sh)
(cd apps/macos && scripts/run_gateway_media_tests.sh)
```

Review each test script's prerequisites first; gateway media validation can require Go and the shared archive validator. These commands are source checks, not the live-module probe scripts. App packaging, helper signing, entitlements, installation, notarization, and actual USB ownership are separate steps. Avoid running device probes merely because they appear next to unit-test scripts.

## Changes and validation

Keep edits scoped to the component you own and preserve parallel contributors' changes. Trace shared callers before changing protocol or identity fields. Use the smallest relevant runnable check, then validate affected client/server contracts. Preserve command idempotency, version conflict handling, authorization, replay journals, and deletion proofs.

When changing public identities, update package IDs, entitlements, signing associations, push topics, service names, defaults, tests, and docs together. Do not rewrite third-party attribution. Keep real credentials, device identifiers, logs, media, build output, and deployment evidence out of the source release.
