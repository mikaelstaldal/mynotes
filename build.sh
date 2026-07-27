#!/usr/bin/env bash
# Full build: generate code from the OpenAPI spec, compile the frontend,
# then test and lint. Prerequisites on $PATH: go, ogen,
# tsc, openapi-typescript, golangci-lint.
# NOTE: no npm/npx/yarn/pnpm/bun — vendor bundles are pre-built committed
# artifacts; jsdom is unpacked from jsdom-node_modules.tar.gz via tar only.
#
# On success this script is silent (no stdout/stderr) and exits 0.
# On failure it prints the failing step's output to stderr and exits non-zero.
set -euo pipefail

OUTPUT_DIR="."
while getopts "o:" opt; do
  case $opt in
    o) OUTPUT_DIR="$OPTARG" ;;
    \?) echo "Invalid option: -$OPTARG" >&2; exit 1 ;;
  esac
done

# Run a build step silently; on failure, print its combined output to stderr
# and abort with a non-zero exit code.
run() {
  local output
  if ! output=$("$@" 2>&1); then
    printf 'build.sh: step failed: %s\n' "$*" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
}

# 1. Generate the Go ogen server stubs (internal/api/).
run go generate ./...

# 2. Generate the TypeScript API types from the OpenAPI spec.
run openapi-typescript openapi.yaml -o web/ts/api/types.ts

# 3. Unpack the committed TypeScript declarations for the vendored runtime
#    (idempotent — no-op if already present). tsc needs these to resolve
#    'markdown-it', 'dompurify' and the CodeMirror re-exports.
run web/ts/vendor/unpack.sh

# 3a. Compile the TypeScript frontend to web/static/.
run tsc --project web/ts/tsconfig.json

# 3b. Compile the demo-mode service worker (worker code, built against the
#     WebWorker lib rather than the DOM one — see web/ts/demo/tsconfig.json).
run tsc --project web/ts/demo/tsconfig.json

# 4. Unpack the committed jsdom install tree (idempotent — no-op if already unpacked).
run web/ts/vendor/test/unpack.sh

# 5. Run frontend XSS-gate, markdown render, email-body, render-kit wiring,
#    HTML-import, and demo-backend tests.
run node --import ./web/ts/test-preload.mjs --test web/ts/xss-gate.test.mjs web/ts/markdown.test.mjs web/ts/email.test.mjs web/ts/render-kit.test.mjs web/ts/htmlmd.test.mjs web/ts/demo.test.mjs

# 6. Build the single binary (frontend is embedded via web/embed.go).
run env CGO_ENABLED=0 go build -trimpath -buildvcs=true -tags netgo -o "$OUTPUT_DIR/mynotes" .

# 7. Run Go tests.
run go test ./...

# 8. Lint.
run golangci-lint run ./...
