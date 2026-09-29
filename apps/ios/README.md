# VoDog iOS

Native SwiftUI/CallKit client, iOS 17 or later. First-party code is AGPL-3.0; see the repository license. Third-party components retain their own licenses.

## Generate and compile

Install Xcode with the iOS SDK and XcodeGen, then run from this directory:

```sh
xcodegen generate
python3 check-public-inputs.py
xcodebuild -project VoDog.xcodeproj -scheme VoDog \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/vodog-ios-derived \
  -clonedSourcePackagesDirPath /tmp/vodog-ios-packages \
  CODE_SIGNING_ALLOWED=NO build-for-testing
```

The generated project, scheme, sources, imports and test targets are all named VoDog. XcodeGen's project.yml is authoritative. LiveKitWebRTC is pinned to 150.7871.01; Package.resolved records its revision. Dependency downloads require network access. Keep downloaded packages, DerivedData, result bundles and local credentials outside the repository.

The app icon catalog contains the original opaque 1024×1024 VoDog dog artwork from assets/brand/vodog.png. No previous product artwork is included.

## Configure your installation

Set VODOG_DOMAIN in project.yml or pass it as an Xcode build setting (hostname only, no scheme/path). The harmless default is vodog.example.com. It controls the HTTPS /api/v1 endpoint, /turnstile.html challenge page and webcredentials associated domain. Configure the matching server passkey relying-party ID and Apple app-site-association document.

The app bundle ID is org.vodog; test bundles use org.vodog.tests and org.vodog.uitests. For a signed device build, register your own unique bundle ID, set PRODUCT_BUNDLE_IDENTIFIER and DEVELOPMENT_TEAM locally, and configure the corresponding server APNs topic. No development team, signing profile, APNs key or account is supplied. ExportOptions.plist is a credential-free export template; provide your team locally when archiving/exporting. The APNs entitlement defaults to development for local provisioning; select the correct environment for your distribution profile. Keychain services use org.vodog and the separate org.vodog.s33-local-ui test namespace; adjust these if distributing multiple independently authenticated installations.

CallKit, PushKit/APNs, microphone permissions, passkeys, background delivery and real cellular audio need your signed installation and separate device acceptance. An unsigned simulator build does not validate them.

## Tests and fixtures

Unit tests are in VoDogTests, UI tests in VoDogUITests. To run unit tests with a simulator you control, replace the simulator placeholder:

```sh
xcodebuild -project VoDog.xcodeproj -scheme VoDog \
  -destination 'platform=iOS Simulator,name=<installed simulator>' \
  -derivedDataPath /tmp/vodog-ios-derived \
  -clonedSourcePackagesDirPath /tmp/vodog-ios-packages \
  -resultBundlePath /tmp/vodog-ios-unit-tests.xcresult \
  test -only-testing:VoDogTests
```

Runtime tests use default simulator signing; do not disable code signing because Keychain tests require a signed host app.

UI integration tests require an explicitly configured isolated backend. The Debug simulator accepts only VODOG_UI_TEST_API_BASE_URL=http://127.0.0.1:16880/api/v1. This override is compiled out of device and Release builds. S33 expects database vodog_s33_ui_test and its fixture/reset API; external backend and web handoff fixtures must use the same synthetic identities.

Supply VODOG_UI_TEST_USERNAME_B64 and VODOG_UI_TEST_PASSWORD_B64 through a private local build configuration; the scheme forwards them as TEST_USERNAME_B64 and TEST_PASSWORD_B64. Additional VODOG_UI_TEST_* settings in project.yml select fixture and shared-journey behavior. Never commit credentials, handoff output or screenshots. The physical dial smoke test is opt-in via VODOG_SMOKE_DIAL_NUMBER and can place a real call; it is not part of the compilation command.

Phone fixtures use fictional NANP 202-555-01xx numbers, with intentional short-code, malformed and length-boundary cases. UUIDs, accounts and device IDs are synthetic. Binary inputs are the original VoDog app icon and a 0.6-second synthetic Opus test tone, not a call recording. UI integration suites need matching backend fixtures and are not claimed to pass solely because they compile.

## Third-party notices

LiveKitWebRTC is retrieved from https://github.com/livekit/webrtc-xcframework. Preserve the licenses and notices distributed with that package and its WebRTC binaries when redistributing them. Apple framework names, API identifiers and plist DTD attribution are retained.
