#!/usr/bin/env zsh
set -euo pipefail

MODE="${1:-run}"
APP_NAME="VoDog"
BUNDLE_ID="org.vodog.macos"
ROOT_DIR="${0:A:h:h}"
DIST_DIR="$ROOT_DIR/dist"
APP_BUNDLE="$DIST_DIR/VoDog.app"
APP_CONTENTS="$APP_BUNDLE/Contents"
APP_MACOS="$APP_CONTENTS/MacOS"
APP_RESOURCES="$APP_CONTENTS/Resources"
APP_BINARY="$APP_MACOS/VoDog"
HELPER_DIR="$APP_CONTENTS/Library/PrivilegedHelperTools"
DAEMON_DIR="$APP_CONTENTS/Library/LaunchDaemons"
WORKSPACE_HOME="$ROOT_DIR/.build/home"
WORKSPACE_CACHE="$ROOT_DIR/.build/caches"
SIGN_IDENTITY="${VODOG_CODESIGN_IDENTITY:-${MAVO_CODESIGN_IDENTITY:-}}"
if [[ -z "$SIGN_IDENTITY" ]]; then
  SIGN_IDENTITY="$(
    security find-identity -v -p codesigning |
      awk -F'"' '/"Apple Development:/ { print $2; exit }'
  )"
fi

[[ -n "$SIGN_IDENTITY" ]] || {
  print -u2 "No stable Apple Development signing identity is available."
  print -u2 "Set VODOG_CODESIGN_IDENTITY to a valid code-signing identity."
  exit 1
}

if [[ -z "${DEVELOPER_DIR:-}" && -d /Applications/Xcode-beta.app/Contents/Developer ]]; then
  export DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer
fi

mkdir -p \
  "$WORKSPACE_HOME" \
  "$WORKSPACE_CACHE/clang" \
  "$WORKSPACE_CACHE/swiftpm"
export HOME="$WORKSPACE_HOME"
export XDG_CACHE_HOME="$WORKSPACE_CACHE"
export CLANG_MODULE_CACHE_PATH="${CLANG_MODULE_CACHE_PATH:-$WORKSPACE_CACHE/clang}"
export SWIFTPM_MODULECACHE_OVERRIDE="${SWIFTPM_MODULECACHE_OVERRIDE:-$WORKSPACE_CACHE/swiftpm}"

pkill -x "$APP_NAME" >/dev/null 2>&1 || true

cd "$ROOT_DIR"
xcrun swift build --disable-sandbox -Xswiftc -disable-sandbox
BIN_DIR="$(xcrun swift build --disable-sandbox -Xswiftc -disable-sandbox --show-bin-path)"

[[ "$APP_BUNDLE" == "$ROOT_DIR/dist/VoDog.app" ]] || {
  print -u2 "Unexpected app bundle path: $APP_BUNDLE"
  exit 1
}
/bin/rm -rf -- "$APP_BUNDLE"
mkdir -p \
  "$APP_MACOS" \
  "$APP_RESOURCES" \
  "$HELPER_DIR" \
  "$DAEMON_DIR"
cp "$ROOT_DIR/Resources/Info.plist" "$APP_CONTENTS/Info.plist"
SUPABASE_ENV_FILE="$ROOT_DIR/website/.env.local"
SUPABASE_URL_VALUE="${VODOG_SUPABASE_URL:-}"
SUPABASE_KEY_VALUE="${VODOG_SUPABASE_PUBLISHABLE_KEY:-}"
if [[ -f "$SUPABASE_ENV_FILE" ]]; then
  if [[ -z "$SUPABASE_URL_VALUE" ]]; then
    SUPABASE_URL_VALUE="$(awk -F= '$1 == "VITE_SUPABASE_URL" { sub(/^[^=]*=/, ""); print; exit }' "$SUPABASE_ENV_FILE")"
  fi
  if [[ -z "$SUPABASE_KEY_VALUE" ]]; then
    SUPABASE_KEY_VALUE="$(awk -F= '$1 == "VITE_SUPABASE_PUBLISHABLE_KEY" { sub(/^[^=]*=/, ""); print; exit }' "$SUPABASE_ENV_FILE")"
  fi
fi
if [[ -n "$SUPABASE_URL_VALUE" ]]; then
  /usr/libexec/PlistBuddy -c "Set :VoDogSupabaseURL $SUPABASE_URL_VALUE" \
    "$APP_CONTENTS/Info.plist"
fi
if [[ -n "$SUPABASE_KEY_VALUE" ]]; then
  /usr/libexec/PlistBuddy -c "Set :VoDogSupabasePublishableKey $SUPABASE_KEY_VALUE" \
    "$APP_CONTENTS/Info.plist"
fi
cp "$BIN_DIR/VoDog" "$APP_BINARY"
cp "$BIN_DIR/VoDogNetworkHelper" "$HELPER_DIR/VoDogNetworkHelper"
cp "$ROOT_DIR/Resources/app.mavo.celldock.network.helper.plist" \
  "$DAEMON_DIR/app.mavo.celldock.network.helper.plist"
cp "$ROOT_DIR/Resources/VoDog.icns" "$APP_RESOURCES/VoDog.icns"
cp -R "$ROOT_DIR/Resources/Localization/"*.lproj "$APP_RESOURCES/"
if [[ -d "$ROOT_DIR/Resources/ModuleVoice" ]]; then
  xcrun swift "$ROOT_DIR/scripts/build_module_voice_payload.swift" \
    "$ROOT_DIR/Resources/ModuleVoice" \
    "$APP_RESOURCES/ModuleVoice.payload" >/dev/null
fi
if find "$APP_RESOURCES" -type f \
  \( -name 'THIRD_PARTY_NOTICES.md' -o -name 'MODULE-REPORT.md' \) \
  -print -quit | grep -q .; then
  print -u2 "App includes a documentation file excluded from resources."
  exit 1
fi
[[ ! -e "$APP_RESOURCES/ModuleVoice-Notices" ]] || {
  print -u2 "App includes the unused ModuleVoice-Notices resource."
  exit 1
}

xattr -cr "$APP_BUNDLE"
codesign --force --sign "$SIGN_IDENTITY" --timestamp=none \
  --identifier app.mavo.celldock.network.helper \
  "$HELPER_DIR/VoDogNetworkHelper"
codesign --force --sign "$SIGN_IDENTITY" --timestamp=none \
  --identifier "$BUNDLE_ID" "$APP_BUNDLE"
codesign --verify --deep --strict "$APP_BUNDLE"

open_app() {
  LAUNCH_TOKEN="--celldock-launch-token=$$-$RANDOM"
  if /usr/bin/open -n -a "$APP_BUNDLE" --args "$LAUNCH_TOKEN"; then
    LAUNCHED_PID=""
    for _ in {1..30}; do
      LAUNCHED_PID="$(
        ps -axo pid=,command= |
          awk -v binary="$APP_BINARY" -v token="$LAUNCH_TOKEN" \
            'index($0, binary) && index($0, token) && !pid { pid=$1 }
             END { if (pid) print pid }'
      )"
      [[ -n "$LAUNCHED_PID" ]] && return
      sleep 0.1
    done
  fi

  print -u2 "Bundle launch failed, falling back to direct executable launch."
  "$APP_BINARY" "$LAUNCH_TOKEN" >/tmp/celldock-build-and-run.log 2>&1 &
  LAUNCHED_PID=$!
  for _ in {1..30}; do
    kill -0 "$LAUNCHED_PID" 2>/dev/null && return
    sleep 0.1
  done
  print -u2 "VoDog did not start from the executable fallback: $APP_BINARY"
  exit 1
}

case "$MODE" in
  run)
    open_app
    ;;
  --debug|debug)
    lldb -- "$APP_BINARY"
    ;;
  --logs|logs)
    open_app
    /usr/bin/log stream --info --style compact --predicate "processIdentifier == $LAUNCHED_PID"
    ;;
  --telemetry|telemetry)
    open_app
    /usr/bin/log stream --info --style compact \
      --predicate "processIdentifier == $LAUNCHED_PID && subsystem == \"$BUNDLE_ID\""
    ;;
  --verify|verify)
    open_app
    sleep 2
    kill -0 "$LAUNCHED_PID" 2>/dev/null
    RUNNING_COMMAND="$(ps -p "$LAUNCHED_PID" -o command=)"
    [[ "$RUNNING_COMMAND" == "$APP_BINARY"* ]] || {
      print -u2 "Unexpected VoDog executable: $RUNNING_COMMAND"
      exit 1
    }
    print "VoDog launch verified: $APP_BINARY (pid $LAUNCHED_PID)"
    ;;
  *)
    print -u2 "usage: $0 [run|--debug|--logs|--telemetry|--verify]"
    exit 2
    ;;
esac
