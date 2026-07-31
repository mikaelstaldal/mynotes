# AI coding agent instructions

Guidance for AI coding agents working in this repository. This is a personal
note manager (MyNotes) with a Go backend, SQLite storage, a REST API defined in
OpenAPI, and an embedded Preact + TypeScript frontend.

## Specification

Keep spec/REQUIREMENTS.md updated when new features are added.

## REST API

The REST API is used by both the embedded web UI and an Android (Kotlin/Compose) app in another repository.

## Build & Run

```bash
./build.sh                           # generate code, compile TS, build binary, test, lint
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
CodeMirror/markdown-it/DOMPurify bundles, the emoji dataset
(`web/static/vendor/emoji-<version>.js`, generated from `emojibase-data` by the committed
`gen-emoji.mjs`), the TypeScript declarations those bundles do not carry
(`web/ts/vendor/types-node_modules.tar.gz`), and the test-only jsdom bundle, and
commits the result; it is out-of-band, not invoked by `build.sh` or CI.

`web/ts/vendor/node_modules/` is throwaway and gitignored, so the two things
`tsc` and the tests need from it are vendored as committed tarballs that
`build.sh` restores with `tar` alone: `web/ts/vendor/unpack.sh` (declarations —
`package.json`, `*.d.ts`, LICENSE; no JavaScript, nothing reaching the browser)
and `web/ts/vendor/test/unpack.sh` (jsdom). Both are no-ops on a machine where
`rebuild.sh` has installed the real tree. A clean checkout must build with
`./build.sh` and nothing else — if a new tsconfig `paths` entry or `.d.ts` stub
reaches into a package the declarations tarball lacks, that breaks, so add the
package to `TYPES_PACKAGES` in `rebuild.sh` and regenerate.

CI (`.github/workflows/main.yml`) builds on every push to `main`, publishes
the browser demo to GitHub Pages, and publishes the linux/amd64 binary as a
rolling `latest` release (tag moved to the built commit each run).

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
  gdocs/                 # -gdocs-* batch mode: bulk-import owned Google Docs
  mdimport/              # -import-md-dir batch mode: bulk-import a .md directory tree
  mdexport/              # -export-md-dir batch mode: bulk-export every note as .md
  demo/                  # demo seed content; bundle.go exports it for the browser demo
web/
  embed.go               # //go:embed of web/static
  ts/                    # TypeScript sources (compiled to web/static by tsc)
    render/host.ts       # render-kit entry point (globalThis.MyNotesRender)
    demo/                # the demo backend (see below) — worker code, built separately
    demo-sw.ts           # its service-worker entry point
    demo-client.ts       # the page half of demo mode
    vendor/rebuild.sh    # maintainer-only: rebuilds the vendored bundles below
  static/                # embedded assets: index.html, app.css, vendored
                          # preact/CodeMirror/markdown-it/DOMPurify/emoji, compiled JS
    render/              # the shared render kit (see below), served at /render/
tools/dist-renderer.sh   # copies the render kit out for embedding in a native client
```

## MyMail integration

"Send as email" posts a note to a sibling
[MyMail](https://github.com/mikaelstaldal/mymail) instance, whose URL `main.go`
derives from `-public-url` (path replaced with `/mymail`) and hands to the
frontend via an injected inline `<script>` setting `window.__serverConfig`
(hash added to `script-src`). Same-origin, so no CSP or CORS work is needed.
The user can override that URL in the web UI's Settings dialog
(`components/SettingsDialog.tsx`, persisted to localStorage via
`util/config.ts`); `util/mymail.ts` resolves override-then-derived and is the
only thing callers ask "is MyMail configured?". The override must be
same-origin — with no `connect-src` in the policy, `default-src 'self'` blocks
anything else — so a cross-origin one is rejected as it is entered.

`web/ts/util/emailhtml.ts` rewrites the export fragment into an email body and
reports, via `EmailBody.degraded`, what the body could not carry. That list
drives whether `email.ts` attaches the standalone "Download HTML" document —
attach on content loss (diagrams, formulas, icons, embedded graphics,
unresolvable images), not on a substitution that preserves the information
(unfolded callout, ☐/☑ checkbox, styling email cannot express). Because the
renderer puts a Lucide icon in the title of every **alias** callout
(`[!warning]`, …), notes using one always attach; `>-`/`>*`/`>+` boxes do not.
Anything the
placeholder text tells the reader to find "in the attached file" **must** report
a degradation, or the body will reference a file that was never sent.
**MyMail sanitizes what it sends** with `sanitize.OutgoingHTML`
(`mymail/internal/sanitize.NewOutgoingPolicy`): a fixed element allowlist, no
`class`, `<style>` dropped with its content, and a fixed CSS-property allowlist
whose values may not contain escapes, comments, or any functional notation but
`rgb()`/`hsl()`. So styles must be inline `style=` attributes drawn from that
list (no `position`, no `display`, no `color-mix()`), and URLs must be absolute.

MyMail's allowlist was widened for this path — per-side longhands
(`border-left`, `padding-left`), `border-radius`, `list-style`, and the inert
semantic elements are available. It was widened in **both** of MyMail's
directions, not just outgoing, so a note emailed to a MyMail address arrives
rendering exactly as sent; MyMail's `outgoingOnly*` lists are empty and should
stay that way. Widening further is a change in both repos: MyMail's
`cssAllowlist`/`allAllowedElements`, and the mirrored allowlists in
`web/ts/email.test.mjs` here, which restates the policy and asserts the real
rendered output against it.

Within one style attribute a shorthand must precede the longhand refining it
(`border` then `border-left`); MyMail preserves declaration order, pinned by its
`TestDeclarationOrderPreserved`.

## Shared render kit

Native clients (the Android app) do **not** re-implement the Markdown dialect;
they embed `web/static/render/` and drive it in a web view. It is a plain static
page hosting the same `util/markdown.ts` + `util/mermaid.ts` pipeline as the web
UI, exposing `render(markdown)` and `setTheme(theme, vars?)` on
`globalThis.MyNotesRender`.

- `web/static/render/note.css` is the **canonical** stylesheet for rendered note
  content — `app.css` `@import`s it. Put `.note-content` rules and the colour
  variables there, not in `app.css`.
- `tools/dist-renderer.sh <outdir>` copies the kit (host page + compiled modules
  + the vendor bundles it imports) into a consumer. It is a copy, not a build:
  run `./build.sh` first.
- The kit's host page has its own import map, so a vendor version bump must
  update **both** `web/static/index.html` and `web/static/render/index.html`, and
  the latter's `<meta>` CSP hash must be recomputed (`main.go` derives the
  server's header hash automatically). `web/ts/render-kit.test.mjs` fails the
  build if any of that is out of sync.

Request flow: `handler → service → repository → SQLite`. The handler is a thin
adapter; business rules live in the service layer.

## Demo mode

`-demo-server` and `-demo-bundle DIR` build the web UI with **no backend**: a
service worker (`web/ts/demo-sw.ts` + `web/ts/demo/`) intercepts `/api/v1` and
answers it from IndexedDB. `main.go` injects `window.__serverConfig={demo:true}`
(same mechanism as the MyMail URL); `app.tsx` then waits for the worker to be
installed and in control before rendering, so the first request cannot escape it.

- **Intercepting at the network layer is the point**: the frontend is unchanged
  between demo and real, including the `<img>` loads for artifacts and icons and
  the "Download Markdown" navigation, which never go through `api/client.ts`.
- **Parity with the Go server is the contract.** `web/ts/demo/` re-implements
  `internal/service` + the Markdown-aware parts of `internal/repository`; every
  function names the Go original it mirrors. When you change slug generation,
  excerpts, wikilink extraction, splitting, frontmatter, download wrapping, or
  content validation on the server, change it there too. The accepted
  divergences are listed in spec/REQUIREMENTS.md § Demo Mode — don't add more
  silently.
- **Not localStorage**: a service worker cannot reach it (it is synchronous and
  absent from worker scopes), so the store is IndexedDB.
- These sources are **worker code**: excluded from `web/ts/tsconfig.json` and
  built by `web/ts/demo/tsconfig.json` against the WebWorker lib. They are
  classic scripts sharing one global scope via `importScripts`, so they use no
  `import`/`export` — adding one silently turns a file into a module and its
  declarations vanish from the shared scope.
- HTML import is the one thing the worker delegates: parsing HTML needs a
  DOMParser, which a worker has no access to, so it asks the page to run
  `web/ts/util/htmlmd.ts` (a DOM port of `internal/htmlmd`) over a MessageChannel.
- The seed content is not duplicated in JavaScript: `internal/demo/bundle.go`
  runs the real `-demo` seeding against an in-memory database and exports the
  result as `demo-data.json`.

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
