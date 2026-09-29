#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# CI should validate this module as a standalone checkout unless explicitly
# pointed at a workspace.
export GOWORK="${GOWORK:-off}"

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

GO_BIN="$(find_go)"
GOFMT_BIN="${GOFMT_BIN:-}"
if [[ -z "$GOFMT_BIN" ]]; then
	candidate="$(dirname "$GO_BIN")/gofmt"
	if [[ -x "$candidate" ]]; then
		GOFMT_BIN="$candidate"
	elif command -v gofmt >/dev/null 2>&1; then
		GOFMT_BIN="$(command -v gofmt)"
	else
		printf 'gofmt not found; set GOFMT_BIN=/path/to/gofmt\n' >&2
		exit 127
	fi
fi

run() {
	printf '\n==> %s\n' "$*"
	"$@"
}

go_mod_version() {
	awk '$1 == "go" { print $2; exit }' go.mod
}

module_path_check() {
	local expected legacy_base legacy_module module_path
	local module_files=()
	local legacy_refs=()

	expected="github.com/boa-z/vowifi-go"
	legacy_base="${CI_LEGACY_MODULE_BASE:-github.com/iniwex5}"
	legacy_module="${CI_LEGACY_MODULE:-${legacy_base%/}/vowifi-go}"

	if ! module_path="$(env GOWORK=off "$GO_BIN" list -m -f '{{.Path}}')"; then
		printf 'failed to read local module path\n' >&2
		return 1
	fi
	if [[ "$module_path" != "$expected" ]]; then
		printf 'module path mismatch: expected %s, got %s\n' "$expected" "$module_path" >&2
		return 1
	fi
	printf '\n==> verified module path: %s\n' "$module_path"

	mapfile -d '' module_files < <(find . \( -name '*.go' -o -name go.mod -o -name go.work \) -not -path './.git/*' -print0)
	if [[ ${#module_files[@]} -gt 0 ]]; then
		mapfile -t legacy_refs < <(grep -nH -- "$legacy_module" "${module_files[@]}" 2>/dev/null || true)
	fi
	if [[ ${#legacy_refs[@]} -gt 0 ]]; then
		printf 'legacy vowifi-go module references found in Go module/source files:\n' >&2
		printf '  %s\n' "${legacy_refs[@]}" >&2
		return 1
	fi
	printf '\n==> verified Go module/source references do not use %s\n' "$legacy_module"
}

git_grep_tracked_fixed() {
	local pattern="$1"
	git grep -nIF -- "$pattern" -- . 2>/dev/null || true
}

git_grep_tracked_regex() {
	local pattern="$1"
	git grep -nIE -- "$pattern" -- . 2>/dev/null || true
}

forbidden_tracked_content_patterns() {
	local mail_domain legacy_owner repo_name
	mail_domain="$(printf '%s.%s' outlook com)"
	legacy_owner="iniwex5"
	repo_name="vowifi-go"

	printf '%s%s%s\n' boa-z @ "$mail_domain"
	printf '%s\n' "$mail_domain"
	printf '/%s/%s\n' home boa
	printf 'github.com/%s/%s\n' "$legacy_owner" "$repo_name"
	printf '%s/%s\n' "$legacy_owner" "$repo_name"
}

forbidden_tracked_content_check() {
	local pattern status
	local refs=()

	status=0
	while IFS= read -r pattern; do
		mapfile -t refs < <(git_grep_tracked_fixed "$pattern")
		if [[ ${#refs[@]} -gt 0 ]]; then
			if [[ "$status" == "0" ]]; then
				printf 'forbidden strings found in tracked content:\n' >&2
			fi
			printf '  %s\n' "${refs[@]}" >&2
			status=1
		fi
	done < <(forbidden_tracked_content_patterns)

	if [[ "$status" == "0" ]]; then
		printf '\n==> tracked content contains none of the forbidden repo hygiene strings\n'
	fi
	return "$status"
}

hygiene_check() {
	local email_regex legacy_base legacy_module local_path_regex status
	local email_refs=()
	local legacy_refs=()
	local local_replace_refs=()
	local local_path_refs=()

	status=0
	legacy_base="${CI_LEGACY_MODULE_BASE:-github.com/iniwex5}"
	legacy_module="${CI_LEGACY_MODULE:-${legacy_base%/}/vowifi-go}"
	email_regex="${CI_PRIVACY_EMAIL_RE:-[[:alnum:]_.%+-]+[@]([[:alnum:]-]+[.])?(gmail|googlemail|hotmail|outlook|live|msn|icloud|me|mac|yahoo|ymail|rocketmail|proton|protonmail|pm|aol|qq|163|126|yeah|foxmail)[.][[:alpha:].]{2,}}"
	local_path_regex='/(home|Users)/[[:alnum:]_.-]+|[[:alpha:]]:[\\]+Users[\\]+[[:alnum:]_.-]+'

	forbidden_tracked_content_check || status=1

	mapfile -t legacy_refs < <(git_grep_tracked_fixed "$legacy_module")
	if [[ ${#legacy_refs[@]} -gt 0 ]]; then
		printf 'legacy vowifi-go module references found in tracked content:\n' >&2
		printf '  %s\n' "${legacy_refs[@]}" >&2
		status=1
	fi

	mapfile -t local_path_refs < <(git_grep_tracked_regex "$local_path_regex")
	if [[ ${#local_path_refs[@]} -gt 0 ]]; then
		printf 'possible local home path references found in tracked content:\n' >&2
		printf '  %s\n' "${local_path_refs[@]}" >&2
		status=1
	fi

	mapfile -t local_replace_refs < <(git_grep_tracked_regex 'replace[[:space:]].*=>[[:space:]]*(\.{1,2}/|/|~)')
	if [[ ${#local_replace_refs[@]} -gt 0 ]]; then
		printf 'local filesystem replace directives found in tracked content:\n' >&2
		printf '  %s\n' "${local_replace_refs[@]}" >&2
		status=1
	fi

	mapfile -t email_refs < <(git_grep_tracked_regex "$email_regex")
	if [[ ${#email_refs[@]} -gt 0 ]]; then
		printf 'possible personal email references found in tracked content:\n' >&2
		printf '  %s\n' "${email_refs[@]}" >&2
		status=1
	fi

	if [[ "$status" == "0" ]]; then
		printf '\n==> hygiene scan found no forbidden strings, personal emails, local home paths, or legacy vowifi-go module references in tracked content\n'
	fi
	return "$status"
}

parse_go_version() {
	local raw major minor patch
	raw="${1#go}"
	raw="${raw%%[!0-9.]*}"
	IFS=. read -r major minor patch _ <<< "$raw"
	patch="${patch:-0}"
	if [[ ! "$major" =~ ^[0-9]+$ || ! "$minor" =~ ^[0-9]+$ || ! "$patch" =~ ^[0-9]+$ ]]; then
		return 1
	fi
	printf '%s %s %s\n' "$major" "$minor" "$patch"
}

go_version_ge() {
	local have_major have_minor have_patch want_major want_minor want_patch
	read -r have_major have_minor have_patch < <(parse_go_version "$1") || return 1
	read -r want_major want_minor want_patch < <(parse_go_version "$2") || return 1

	if ((have_major != want_major)); then
		((have_major > want_major))
		return
	fi
	if ((have_minor != want_minor)); then
		((have_minor > want_minor))
		return
	fi
	((have_patch >= want_patch))
}

version_check() {
	local current required
	required="$(go_mod_version)"
	current="$("$GO_BIN" env GOVERSION 2>/dev/null || true)"

	if [[ -n "$required" ]]; then
		printf '\n==> go.mod requires Go %s or newer\n' "$required"
	fi
	if [[ -n "$current" ]]; then
		printf 'Current Go runtime: %s\n' "$current"
	fi
	if [[ -n "$required" && -n "$current" ]]; then
		if go_version_ge "$current" "$required"; then
			return
		fi
		printf 'Go runtime %s is older than go.mod requirement %s\n' "$current" "$required" >&2
		return 1
	fi
}

fmt_check() {
	mapfile -d '' files < <(find . -name '*.go' -not -path './.git/*' -print0)
	if [[ ${#files[@]} -eq 0 ]]; then
		printf '\n==> no Go files found for gofmt check\n'
		return
	fi
	printf '\n==> %s -l <go files>\n' "$GOFMT_BIN"
	unformatted="$("$GOFMT_BIN" -l "${files[@]}")"
	if [[ -n "$unformatted" ]]; then
		printf 'gofmt required for:\n%s\n' "$unformatted" >&2
		printf 'Run: %s -w <files>\n' "$GOFMT_BIN" >&2
		return 1
	fi
}

tidy_check() {
	run "$GO_BIN" mod tidy -diff
}

download() {
	run "$GO_BIN" mod download
}

vet() {
	run "$GO_BIN" vet ./...
}

smoke() {
	read -r -a packages <<< "${CI_SMOKE_PACKAGES:-./...}"
	if [[ ${#packages[@]} -eq 0 ]]; then
		printf '\n==> no packages configured for smoke check\n'
		return
	fi
	run "$GO_BIN" test -run "${CI_SMOKE_RUN:-^$}" -count=1 "${packages[@]}"
}

compat_selftest() {
	GO_BIN="$GO_BIN" "$ROOT/scripts/compat-vohive-selftest.sh"
}

test_all() {
	run "$GO_BIN" test -count=1 ./...
}

race() {
	if [[ "${SKIP_RACE:-0}" == "1" ]]; then
		printf '\n==> skipping race tests because SKIP_RACE=1\n'
		return
	fi
	read -r -a packages <<< "${CI_RACE_PACKAGES:-./...}"
	run "$GO_BIN" test -race -count=1 "${packages[@]}"
}

coverage() {
	local cleanup coverage_file coverage_mode
	read -r -a packages <<< "${CI_COVERAGE_PACKAGES:-./...}"
	if [[ ${#packages[@]} -eq 0 ]]; then
		printf '\n==> no packages configured for coverage\n'
		return
	fi

	cleanup=0
	coverage_file="${CI_COVERAGE_FILE:-}"
	if [[ -z "$coverage_file" ]]; then
		coverage_file="$(mktemp "${TMPDIR:-/tmp}/vowifi-go-coverage-XXXXXX")"
		cleanup=1
	else
		mkdir -p "$(dirname "$coverage_file")"
	fi
	coverage_mode="${CI_COVERAGE_MODE:-atomic}"

	run "$GO_BIN" test -count=1 -covermode="$coverage_mode" -coverprofile="$coverage_file" "${packages[@]}"
	run "$GO_BIN" tool cover -func="$coverage_file"
	if [[ "$cleanup" == "1" ]]; then
		rm -f "$coverage_file"
	else
		printf '\n==> coverage profile: %s\n' "$coverage_file"
	fi
}

usage() {
	cat <<'USAGE'
Usage: scripts/ci.sh [all|version|module-path|hygiene|privacy|download|fmt|tidy|vet|smoke|compat-selftest|test|race|coverage ...]

Environment:
  GO_BIN               path to go binary when it is not on PATH
  GOFMT_BIN            path to gofmt binary
  GOWORK               Go workspace mode, default: off for hermetic CI
  CI_LEGACY_MODULE     legacy module path rejected in Go files
  CI_LEGACY_MODULE_BASE legacy owner/base used to build the default legacy path
  CI_PRIVACY_EMAIL_RE  personal email regex for hygiene checks
  CI_SMOKE_PACKAGES    package pattern(s) for smoke tests, default: ./...
  CI_SMOKE_RUN         go test -run pattern for smoke tests, default: ^$
  SKIP_RACE=1          skip race tests
  CI_RACE_PACKAGES     package pattern(s) for race tests, default: ./...
  CI_COVERAGE_PACKAGES package pattern(s) for coverage tests, default: ./...
  CI_COVERAGE_FILE     coverage profile path; default: temporary file
  CI_COVERAGE_MODE     Go coverage mode, default: atomic

Default all runs version/module-path/hygiene/download/fmt/tidy/vet/smoke/
compat-selftest/test. Race and coverage are opt-in so the main local and
GitHub CI path stays lightweight.
USAGE
}

if [[ $# -eq 0 || "${1:-}" == "all" ]]; then
	tasks=(version module-path hygiene download fmt tidy vet smoke compat-selftest test)
else
	tasks=("$@")
fi

printf 'Using Go: %s\n' "$("$GO_BIN" version)"
printf 'Using gofmt: %s\n' "$GOFMT_BIN"
printf 'Using GOWORK: %s\n' "$GOWORK"

for task in "${tasks[@]}"; do
	case "$task" in
		version | go-version) version_check ;;
		module-path | module_path) module_path_check ;;
		hygiene | hygiene-check | privacy | privacy-check) hygiene_check ;;
		download) download ;;
		fmt | fmt-check) fmt_check ;;
		tidy | tidy-check) tidy_check ;;
		vet) vet ;;
		smoke) smoke ;;
		compat-selftest | compat-vohive-selftest) compat_selftest ;;
		test) test_all ;;
		race) race ;;
		coverage) coverage ;;
		-h | --help | help)
			usage
			exit 0
			;;
		*)
			printf 'unknown CI task: %s\n' "$task" >&2
			usage >&2
			exit 2
			;;
	esac
done
