# AI coding agent instructions

Guidance for AI coding agents working in this repository. This is a personal
note manager (MyNotes) with a Go backend, SQLite storage, a REST API defined in
OpenAPI, and an embedded Preact + TypeScript frontend.

## Specification

Keep spec/REQUIREMENTS.md updated when new features are added.

## Build & Run

```bash
./build.sh                                   # generate code, compile TS, build binary, test, lint
./mynotes                            # serves on 127.0.0.1:8080
./mynotes -port 3000 -data /tmp/app  # custom port and data directory
```

`go`, `ogen`, `tsc`, `openapi-typescript`, `node`, and `golangci-lint` must be on
`$PATH`. `node` runs the `node --test` client-side XSS-gate tests invoked from
`build.sh`.

`build.sh` must **never** invoke `npm`/`npx`/`yarn`/`pnpm`/`bun` — a deliberate
supply-chain constraint: no package-manager install runs as part of the build or
CI. `esbuild` and `npm` are required only by `web/ts/vendor/rebuild.sh`, a
separate, manually-run maintainer script that pre-builds the vendored
CodeMirror/markdown-it/DOMPurify bundles (and the test-only jsdom bundle) and
commits the result; it is out-of-band, not invoked by `build.sh` or CI.

The database is created automatically on first start under `<data>/mynotes.sqlite`.

## Architecture

Layered Go backend with an embedded Preact frontend. The deployed artifact is a
single binary plus one SQLite file.

```
main.go                  # CLI flags, HTTP routing, middleware, graceful shutdown
openapi.yaml             # REST API contract — the source of truth for code generation
internal/
  api/                   # GENERATED ogen server stubs — DO NOT EDIT
  handler/               # implements the generated api.Handler interface + middleware
  service/               # business logic: validation, sanitization, sentinel errors
  repository/            # SQLite storage; schema + versioned migrations in db.go
  model/                 # shared domain types (storage- and transport-agnostic)
  sanitize/              # HTML sanitization (bluemonday)
web/
  embed.go               # //go:embed of web/static
  ts/                    # TypeScript sources (compiled to web/static by tsc)
    vendor/rebuild.sh    # maintainer-only: rebuilds the vendored bundles below
  static/                # embedded assets: index.html, app.css, vendored
                          # preact/CodeMirror/markdown-it/DOMPurify, compiled JS
```

Request flow: `handler → service → repository → SQLite`. The handler is a thin
adapter; business rules live in the service layer.

## Code generation (two steps, both run by build.sh)

**Go server stubs** (`ogen`): `internal/api/` is generated from `openapi.yaml`
by `go generate ./...` (directive in `internal/generate.go`). Never edit
`internal/api/` by hand — regenerate after changing the spec.

**TypeScript API types** (`openapi-typescript`): `web/ts/api/types.ts` is
generated from `openapi.yaml`. Never edit it by hand. The frontend imports its
request/response types from it via `web/ts/api/client.ts`.

To change the API: edit `openapi.yaml`, regenerate, then update the handler
implementation and the frontend client.

## Conventions

- **Timestamps:** stored as UTC RFC 3339 strings in SQLite; exposed as
  `date-time` in the API.
- **Errors:** the API error body is `{"error": "message"}`. The service layer
  returns sentinel errors (`service.ErrNotFound`, `service.ErrValidation`); the
  handler's `NewError` maps them to HTTP status codes.
- **Partial updates:** PATCH request fields are optional; a nil pointer in the
  service/repository means "leave unchanged".
- **Migrations:** append a new `[]string` to `migrations` in
  `internal/repository/db.go`; never edit an applied migration. Versioning is via
  `PRAGMA user_version`.
- **Frontend file naming:** components and views are `PascalCase.tsx`; utilities
  and non-component modules are `lowercase.ts`. Relative imports use `.js`
  extensions (TypeScript ESM convention — tsc resolves `.ts`/`.tsx`, emits `.js`).
- **Frontend networking:** all requests go through `api` in `web/ts/api/client.ts`
  (centralized retry, 401/404 handling, error parsing). Do not call `fetch`
  directly from components.

## Tests

Use `github.com/stretchr/testify` (`require` for fatal checks, `assert`
otherwise). Repository and handler tests run against an in-memory SQLite DB
(`file::memory:?cache=shared`) with the full schema migrated. Place `_test.go`
files alongside the package under test.

```bash
go test ./...
go test ./internal/handler/ -run TestCreateAndGetNote
```

## Security guidelines

- **Guard every write path** (create *and* update, interactive *and* imported).
  An import or API client is never trusted. The guard differs by field:
  - **Most fields** — sanitize with `sanitize.HTML` (mutate-on-write).
  - **Note `content`** — **validate-and-reject, not sanitize-and-store.** Note
    `content` is stored verbatim Markdown; its embedded HTML is *validated*
    (never mutated) by bluemonday on write — a write carrying disallowed HTML is
    rejected, not silently rewritten. `internal/sanitize` is retained and reused
    as this embedded-HTML validator (not removed). DOMPurify is the
    authoritative render-time gate on the frontend.
  - **Note `title`** - only validated for length and no control characters, 
    no HTML sanitization since it is not used in contexts where that would be an issue
- **Validate URL schemes** (allow only `http`, `https`, `mailto`) wherever URLs
  are stored or rendered.
- **HTTP hardening:** keep the global `http.MaxBytesHandler` body limit, and both
  `ReadTimeout` and `ReadHeaderTimeout` set on the server.
- **CSP:** keep the Content-Security-Policy tight; include `frame-ancestors
  'none'`. When adding outbound resources, update the relevant directive
  (`script-src`, `img-src`, `connect-src`) at the same time.
- **GET is side-effect free:** never modify the database in a GET handler.
- Add `maxLength` (and other) constraints in `openapi.yaml` for string query
  parameters and body fields, not just in code.

## Go development

Run `go mod tidy` after modifying `go.mod`. Cross-cutting HTTP middleware
(auth, CSRF, gzip, security headers, recovery) comes from
`github.com/mikaelstaldal/go-server-common` — prefer it over reimplementing.
