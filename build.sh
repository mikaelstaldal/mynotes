#!/usr/bin/env bash
# Full build: generate code from the OpenAPI spec, compile the frontend,
# then test and lint. Prerequisites on $PATH: go, ogen,
# tsc, openapi-typescript, golangci-lint.
# NOTE: no npm/npx/yarn/pnpm/bun — vendor bundles are pre-built committed
# artifacts; jsdom is unpacked from jsdom-node_modules.tar.gz via tar only.
set -euo pipefail

OUTPUT_DIR="."
while getopts "o:" opt; do
  case $opt in
    o) OUTPUT_DIR="$OPTARG" ;;
    \?) echo "Invalid option: -$OPTARG" >&2; exit 1 ;;
  esac
done

# 1. Generate the Go ogen server stubs (internal/api/).
go generate ./...

# 2. Generate the TypeScript API types from the OpenAPI spec.
openapi-typescript openapi.yaml -o web/ts/api/types.ts

# 3. Compile the TypeScript frontend to web/static/.
tsc --project web/ts/tsconfig.json

# 4. Unpack the committed jsdom install tree (idempotent — no-op if already unpacked).
web/ts/vendor/test/unpack.sh

# 5. Run frontend XSS-gate and markdown render tests.
node --import ./web/ts/test-preload.mjs --test web/ts/xss-gate.test.mjs web/ts/markdown.test.mjs

# 6. Build the single binary (frontend is embedded via web/embed.go).
CGO_ENABLED=0 go build -trimpath -buildvcs=true -tags netgo -o "$OUTPUT_DIR/mynotes" .

# 7. Run Go tests.
go test ./...

# 8. Lint.
golangci-lint run ./...
