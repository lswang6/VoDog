#!/usr/bin/env bash
# Build only. Does not install, sign with a private key, publish or contact a device.
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/.." && pwd)
: "${VODOG_API_BASE_URL:?Set VODOG_API_BASE_URL to an HTTPS API URL, e.g. https://vodog.example.com/api/v1}"
[[ $VODOG_API_BASE_URL =~ ^https://[^/@?#[:space:]]+/api/v1$ ]] || { echo 'HTTPS API URL ending in /api/v1 required, without credentials, query or fragment (e.g. https://vodog.example.com/api/v1)' >&2; exit 2; }
cd "$root/apps/android"
# Keep the Gradle cache inside this checkout unless the caller explicitly chooses another location.
export GRADLE_USER_HOME=${GRADLE_USER_HOME:-"$root/build/gradle-home"}
./gradlew :client:testDebugUnitTest :client:assembleDebug :gateway:testDebugUnitTest :gateway:assembleDebug \
    "-PvodogApiBaseUrl=$VODOG_API_BASE_URL" \
    -PvodogCellularAcceptance=true -PvodogRecordingArchive=true -PvodogLibopusFec=true \
    -PvodogReceiveRecovery=true -PvodogCommandReplayHorizon=true \
    --no-daemon --max-workers=1
