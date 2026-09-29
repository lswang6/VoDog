#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
	cat <<'USAGE'
Usage: scripts/compat-vohive-selftest.sh

Builds a minimal temporary VoHive-like consumer and runs compat-vohive.sh
against it. This verifies that the compatibility rewrite, local replace, tidy,
and focused test flow work without requiring a real consumer checkout.

Environment:
  GO_BIN                              path to go binary
  VOWIFI_MODULE                       module path for this repository
  VOWIFI_COMPAT_SELFTEST_LEGACY_BASE  fake legacy owner/base used in the temp consumer
  VOHIVE_COMPAT_TMPDIR                parent directory for temporary compatibility work
USAGE
}

find_go() {
	if [[ -n "${GO_BIN:-}" ]]; then
		printf '%s\n' "$GO_BIN"
		return
	fi
	if command -v go >/dev/null 2>&1; then
		command -v go
		return
	fi
	if [[ -x /usr/local/go/bin/go ]]; then
		printf '%s\n' /usr/local/go/bin/go
		return
	fi
	printf 'go not found; set GO_BIN=/path/to/go\n' >&2
	return 127
}

go_mod_version() {
	awk '$1 == "go" { print $2; exit }' "$ROOT/go.mod"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || "${1:-}" == "help" ]]; then
	usage
	exit 0
fi

GO_BIN="$(find_go)"
VOWIFI_MODULE="${VOWIFI_MODULE:-github.com/boa-z/vowifi-go}"
legacy_base="${VOWIFI_COMPAT_SELFTEST_LEGACY_BASE:-example.invalid/legacy}"
legacy_base="${legacy_base%/}"
legacy_module="${legacy_base}/vowifi-go"
tmp_parent="${VOHIVE_COMPAT_TMPDIR:-${TMPDIR:-/tmp}}"

mkdir -p "$tmp_parent"
tmpdir="$(mktemp -d -p "$tmp_parent" vowifi-go-compat-selftest-XXXXXX)"
cleanup() {
	rm -rf "$tmpdir"
}
trap cleanup EXIT

consumer="$tmpdir/consumer"
mkdir -p "$consumer/cmd/vohive" "$consumer/internal/compat" "$tmpdir/work"

cat >"$consumer/go.mod" <<EOF
module example.invalid/compat-consumer

go $(go_mod_version)

require ${legacy_module} v0.0.0
EOF

cat >"$consumer/internal/compat/compat_test.go" <<EOF
package compat

import (
	"bytes"
	"testing"

	legacy "${legacy_module}/engine/sim"
)

type fakeAKAProvider struct{}

func (fakeAKAProvider) CalculateAKA(rand16, autn16 []byte) (legacy.AKAResult, error) {
	return legacy.AKAResult{
		RES: append([]byte(nil), rand16...),
		CK:  append([]byte(nil), autn16...),
		IK:  []byte{0x01, 0x02},
	}, nil
}

func TestCompatRewrite(t *testing.T) {
	var provider legacy.AKAProvider = fakeAKAProvider{}
	result, err := provider.CalculateAKA([]byte{0xaa}, []byte{0xbb})
	if err != nil {
		t.Fatalf("CalculateAKA returned error: %v", err)
	}
	if !bytes.Equal(result.RES, []byte{0xaa}) || !bytes.Equal(result.CK, []byte{0xbb}) {
		t.Fatalf("unexpected AKA result: RES=%x CK=%x", result.RES, result.CK)
	}
}
EOF

cat >"$consumer/cmd/vohive/main.go" <<EOF
package main

func main() {}
EOF

printf 'Using Go: %s\n' "$("$GO_BIN" version)"
printf 'Temporary consumer: %s\n' "$consumer"

VOHIVE_DIR="$consumer" \
	GO_BIN="$GO_BIN" \
	VOWIFI_MODULE="$VOWIFI_MODULE" \
	VOWIFI_COMPAT_LEGACY_BASE="$legacy_base" \
	VOHIVE_COMPAT_PACKAGES="./internal/compat" \
	VOHIVE_COMPAT_RUN="TestCompatRewrite" \
	VOHIVE_COMPAT_TMPDIR="$tmpdir/work" \
	"$ROOT/scripts/compat-vohive.sh"
