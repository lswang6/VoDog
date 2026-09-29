SHELL := /usr/bin/env bash
.RECIPEPREFIX := >

GO ?= $(shell command -v go 2>/dev/null || printf /usr/local/go/bin/go)
GOFMT ?= $(shell command -v gofmt 2>/dev/null || printf /usr/local/go/bin/gofmt)
CI := ./scripts/ci.sh
VOHIVE_COMPAT := ./scripts/compat-vohive.sh
VOHIVE_COMPAT_SELFTEST := ./scripts/compat-vohive-selftest.sh

.PHONY: help ci go-version module-path hygiene-check privacy-check download fmt-check tidy-check vet smoke test race coverage compat-vohive compat-vohive-selftest

help:
> @printf 'Targets:\n'
> @printf '  make ci          run the default local CI suite used by GitHub Actions\n'
> @printf '  make go-version  check current Go against the go.mod version pin\n'
> @printf '  make module-path check canonical module path and Go import roots\n'
> @printf '  make hygiene-check check tracked content for repo hygiene leaks\n'
> @printf '  make privacy-check alias for hygiene-check\n'
> @printf '  make download    download Go module dependencies\n'
> @printf '  make fmt-check   check gofmt formatting\n'
> @printf '  make tidy-check  check go.mod/go.sum tidiness\n'
> @printf '  make vet         run go vet ./...\n'
> @printf '  make smoke       compile packages/tests without running the full test suite\n'
> @printf '  make test        run go test -count=1 ./...\n'
> @printf '  make race        run optional go test -race -count=1 ./...\n'
> @printf '  make coverage    run optional coverage tests and print a summary\n'
> @printf '  make compat-vohive run old VoHive compatibility and module-path checks\n'
> @printf '  make compat-vohive-selftest run a lightweight local compatibility rewrite self-test\n'
> @printf '\nOverride tools with: GO=/usr/local/go/bin/go GOFMT=/usr/local/go/bin/gofmt make ci\n'

ci:
> GO_BIN="$(GO)" GOFMT_BIN="$(GOFMT)" $(CI)

go-version:
> GO_BIN="$(GO)" GOFMT_BIN="$(GOFMT)" $(CI) version

module-path:
> GO_BIN="$(GO)" GOFMT_BIN="$(GOFMT)" $(CI) module-path

hygiene-check:
> GO_BIN="$(GO)" GOFMT_BIN="$(GOFMT)" $(CI) hygiene

privacy-check:
> GO_BIN="$(GO)" GOFMT_BIN="$(GOFMT)" $(CI) privacy

download:
> GO_BIN="$(GO)" GOFMT_BIN="$(GOFMT)" $(CI) download

fmt-check:
> GO_BIN="$(GO)" GOFMT_BIN="$(GOFMT)" $(CI) fmt

tidy-check:
> GO_BIN="$(GO)" GOFMT_BIN="$(GOFMT)" $(CI) tidy

vet:
> GO_BIN="$(GO)" GOFMT_BIN="$(GOFMT)" $(CI) vet

smoke:
> GO_BIN="$(GO)" GOFMT_BIN="$(GOFMT)" $(CI) smoke

test:
> GO_BIN="$(GO)" GOFMT_BIN="$(GOFMT)" $(CI) test

race:
> GO_BIN="$(GO)" GOFMT_BIN="$(GOFMT)" $(CI) race

coverage:
> GO_BIN="$(GO)" GOFMT_BIN="$(GOFMT)" $(CI) coverage

compat-vohive:
> GO_BIN="$(GO)" $(VOHIVE_COMPAT)

compat-vohive-selftest:
> GO_BIN="$(GO)" $(VOHIVE_COMPAT_SELFTEST)
