# AI coding agent instructions

Guidance for AI coding agents working in this repository. This is a **template**
for web applications with a Go backend, SQLite storage, a REST API defined in
OpenAPI, and an embedded Preact + TypeScript frontend. Replace the example
`items` resource with your own domain.

## Build & Run

```bash
./build.sh                                   # generate code, compile TS, build binary, test, lint
./go-web-template                            # serves on 127.0.0.1:8080
./go-web-template -port 3000 -data /tmp/app  # custom port and data directory
```

`go`, `ogen`, `tsc`, `openapi-typescript`, and `golangci-lint` must be on `$PATH`.

The database is created automatically on first start under `<data>/app.sqlite`.

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
  static/                # embedded assets: index.html, app.css, vendored preact, compiled JS
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
go test ./internal/handler/ -run TestCreateAndGetItem
```

## Security guidelines

- **Sanitize on every write path** (create *and* update, interactive *and*
  imported) using `sanitize.HTML`. An import or API client is never trusted.
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
