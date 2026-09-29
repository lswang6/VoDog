#!/usr/bin/env zsh
set -euo pipefail

ROOT="${0:A:h:h}"
SOURCE_APP="${VODOG_APP_SOURCE:-${MAVO_APP_SOURCE:-$ROOT/outputs/VoDog.app}}"
DESTINATION_APP="/Applications/VoDog.app"
LEGACY_APP="/Applications/VoDogLegacy.app"
LAUNCH_AFTER_INSTALL="${1:-}"
# Previous installs live in the project (outputs/ is git-ignored), not /Applications.
BACKUP_DIR="${VODOG_BACKUP_DIR:-$ROOT/outputs/previous-apps}"
BACKUP_KEEP=3

[[ -d "$SOURCE_APP" ]] || {
  print -u2 "VoDog app not found: $SOURCE_APP"
  exit 1
}
codesign --verify --deep --strict "$SOURCE_APP"

STAGE_ROOT="$(mktemp -d /Applications/.VoDog-install.XXXXXX)"
STAGE_APP="$STAGE_ROOT/VoDog.app"
BACKUP_APP=""
LEGACY_BACKUP_APP=""
INSTALL_COMPLETE=false

cleanup() {
  /bin/rm -rf -- "$STAGE_ROOT"
  if [[ "$INSTALL_COMPLETE" != true &&
        -n "$BACKUP_APP" &&
        -d "$BACKUP_APP" &&
        ! -e "$DESTINATION_APP" ]]; then
    mv -- "$BACKUP_APP" "$DESTINATION_APP"
  fi
  if [[ "$INSTALL_COMPLETE" != true &&
        -n "$LEGACY_BACKUP_APP" &&
        -d "$LEGACY_BACKUP_APP" &&
        ! -e "$LEGACY_APP" ]]; then
    mv -- "$LEGACY_BACKUP_APP" "$LEGACY_APP"
  fi
}
trap cleanup EXIT

ditto "$SOURCE_APP" "$STAGE_APP"
xattr -cr "$STAGE_APP"
codesign --verify --deep --strict "$STAGE_APP"

pkill -x VoDog >/dev/null 2>&1 || true
pkill -x VoDogLegacy >/dev/null 2>&1 || true

if [[ -e "$LEGACY_APP" ]]; then
  mkdir -p -- "$BACKUP_DIR"
  LEGACY_BACKUP_APP="$BACKUP_DIR/VoDogLegacy.previous.brand-migration.$(date +%Y%m%d-%H%M%S).app"
  mv -- "$LEGACY_APP" "$LEGACY_BACKUP_APP"
fi
if [[ -e "$DESTINATION_APP" ]]; then
  mkdir -p -- "$BACKUP_DIR"
  BACKUP_APP="$BACKUP_DIR/VoDog.previous.$(date +%Y%m%d-%H%M%S).app"
  mv -- "$DESTINATION_APP" "$BACKUP_APP"
fi
mv -- "$STAGE_APP" "$DESTINATION_APP"
INSTALL_COMPLETE=true

codesign --verify --deep --strict "$DESTINATION_APP"
# Keep only the newest backups (timestamped names sort chronologically).
for OLD_BACKUP in "$BACKUP_DIR"/VoDog.previous.*.app(N[1,-$((BACKUP_KEEP + 1))]); do
  /bin/rm -rf -- "$OLD_BACKUP"
done
print "Installed VoDog: $DESTINATION_APP"
if [[ -n "$BACKUP_APP" ]]; then
  print "Previous app backup: $BACKUP_APP"
fi
if [[ -n "$LEGACY_BACKUP_APP" ]]; then
  print "Previous VoDogLegacy backup: $LEGACY_BACKUP_APP"
fi

if [[ "$LAUNCH_AFTER_INSTALL" == "--launch" ]]; then
  INSTALLED_BINARY="$DESTINATION_APP/Contents/MacOS/VoDog"
  LAUNCH_TOKEN="--celldock-launch-token=$$-$RANDOM"
  /usr/bin/open -n -a "$DESTINATION_APP" --args "$LAUNCH_TOKEN"
  INSTALLED_PID=""
  for _ in {1..30}; do
    INSTALLED_PID="$(
      ps -axo pid=,command= |
        awk -v binary="$INSTALLED_BINARY" -v token="$LAUNCH_TOKEN" \
          'index($0, binary) && index($0, token) && !pid { pid=$1 }
           END { if (pid) print pid }'
    )"
    [[ -n "$INSTALLED_PID" ]] && break
    sleep 0.1
  done
  [[ -n "$INSTALLED_PID" ]] || {
    print -u2 "Installed VoDog did not start: $DESTINATION_APP"
    exit 1
  }
  sleep 2
  kill -0 "$INSTALLED_PID" 2>/dev/null
  RUNNING_COMMAND="$(ps -p "$INSTALLED_PID" -o command=)"
  [[ "$RUNNING_COMMAND" == "$INSTALLED_BINARY"* ]] || {
    print -u2 "Unexpected VoDog executable: $RUNNING_COMMAND"
    exit 1
  }
  print "Installed VoDog launch verified: $INSTALLED_BINARY (pid $INSTALLED_PID)"
fi
