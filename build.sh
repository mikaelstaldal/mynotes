#!/usr/bin/env bash
# Full build: generate code from the OpenAPI spec, compile the frontend, build
# the Go binary, then test and lint. Prerequisites on $PATH: go, ogen,
# tsc, openapi-typescript, golangci-lint.
set -euo pipefail

OUTPUT_DIR="."
while getopts "o:" opt; do
  case $opt in
    o) OUTPUT_DIR="$OPTARG" ;;
    \?) echo "Invalid option: -$OPTARG" >&2; exit 1 ;;
  esac
done

# 1. Generate the TypeScript API types from the OpenAPI spec.
openapi-typescript openapi.yaml -o web/ts/api/types.ts

# 2. Compile the TypeScript frontend to web/static/.
tsc --project web/ts/tsconfig.json

# 3. Generate the Go ogen server stubs (internal/api/).
go generate ./...

# 4. Build the single binary (frontend is embedded via web/embed.go).
go build -tags netgo -o "$OUTPUT_DIR/mynotes" .

# 5. Run frontend XSS-gate tests (node --test; jsdom bundle must be unpacked).
web/ts/vendor/test/unpack.sh
node --test web/ts/xss-gate.test.mjs

# 6. Test and lint.
go test ./...
golangci-lint run ./...
