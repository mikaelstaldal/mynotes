# AI coding agent instructions

Guidance for AI coding agents working in this repository. This is a personal
note manager (MyNotes) with a Go backend, SQLite storage, a REST API defined in
OpenAPI, and an embedded Preact + TypeScript frontend.

Frontend/web UI instructions: see `web/AGENTS.md` (loaded automatically when
working under `web/`).

End-to-end test instructions: see `e2e/AGENTS.md` (loaded automatically when
working under `e2e/`).

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
supply-chain constraint: no package-manager install runs as part of the build.
**CI is not quite that strict, and the difference is worth stating rather than
implying**: the workflow uses `npm install -g` to put `tsc` and
`openapi-typescript` on `$PATH` for `build.sh`, and `npm ci --ignore-scripts` in
`e2e/` to install Playwright for the e2e step (§ E2E tests). Both run *outside*
the build, with `--ignore-scripts`, from pinned versions — `build.sh` itself
installs nothing and works on a machine with no package manager at all, which is
the property the constraint is protecting.
`esbuild` and `npm` are required only by `web/ts/vendor/rebuild.sh`, a
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
    render/              # the shared render kit (see web/AGENTS.md), served at /render/
    public/page.css      # page chrome for published pages (see Publishing)
tools/dist-renderer.sh   # copies the render kit out for embedding in a native client
```

Request flow: `handler → service → repository → SQLite`. The handler is a thin
adapter; business rules live in the service layer.

## Publishing

"Publish" renders a note in the browser (`web/ts/util/publish.ts`, the same
pipeline as the read view) and PUTs the HTML fragment to
`/api/v1/notes/{slug}/publish`. The server sanitizes it, stores it, and serves it
at **`/public/notes/{slug}` without authentication** — the one unauthenticated
surface in the app. See spec/REQUIREMENTS.md § Publishing for the user-facing
contract. The parts that are easy to break:

- **`/public/` is exempt from basic auth** (`exemptPrefix` in `main.go`), so
  everything registered under it is world-readable. A catch-all 404 claims the
  rest of the prefix; without it an unmatched path would fall through to the SPA
  shell *unauthenticated*. Do not register anything under `/public/` that is not
  meant to be public, and do not add files under `web/static/public/` expecting
  them to be private.
- **Artifacts are referenced, never inlined.** `util/publish.ts` *reverses* the
  `artifact:` → URL expansion the render pipeline performs, so the posted
  fragment carries canonical `artifact:<sha256>` references; the server extracts
  those into `published_note_artifacts` (which is what gates
  `/public/artifacts/{sha256}`) and rewrites them to the relative
  `../artifacts/<sha>`. Relative on purpose — it resolves inside a subpath
  deployment, same reasoning as the `artifact:` scheme itself. The
  "Download HTML" path in `util/export.ts` does the opposite (inlines as `data:`)
  because it must work with no server; do not converge the two.
- **Wikilinks are re-pointed at public pages**, also in `util/publish.ts`
  (`rewriteNoteLinks`): `${base}/notes/<slug>` → `./<slug>`, a sibling under
  `/public/notes/`, relative for the same reason the artifact refs are. Tag links
  are unwrapped to text — there is no public tag page and, with no public index,
  never will be. Publishing does not cascade to linked notes; a link to an
  unpublished note 404s and starts working when that note is published, so do
  not add re-publish-on-link bookkeeping. The regexes are the exact inverse of
  how `util/markdown.ts` builds the hrefs — change one and change the other.
- **`sanitize.PublishedHTML` is sanitize-and-store**, not the validate-and-reject
  used for note content, and it deliberately allows `class`, `style` and
  `<style>` (Mermaid diagrams carry their CSS in both). It sets bluemonday's
  `AllowUnsafe(true)` to keep `<style>` *content*; that is only safe because the
  policy does not declare `script`, and because `handler.publishedNoteCSP` gives
  the page no `script-src` at all. Do not add `script` to that policy, and do not
  loosen that CSP.
- **The stored fragment is a body fragment**; the document around it is built at
  serve time (`service.PublishedNoteDocument`) and its stylesheet is
  `render/note.css` + `web/static/public/page.css`, concatenated at startup. So
  restyling published pages needs no re-publish — keep it that way, and keep
  note-content rules in `note.css` rather than `page.css`.
- **Demo mode does not support publishing** (hidden via `isDemo()`); this is a
  documented divergence, not an oversight.

## Demo mode

`-demo-server` and `-demo-bundle DIR` build the web UI with **no backend**: a
service worker (`web/ts/demo-sw.ts` + `web/ts/demo/`) intercepts `/api/v1` and
answers it from IndexedDB. `main.go` injects `window.__serverConfig={demo:true}`
(same mechanism as the MyMail URL); `app.tsx` then waits for the worker to be
installed and in control before rendering, so the first request cannot escape it.

- **Parity with the Go server is the contract.** `web/ts/demo/` re-implements
  `internal/service` + the Markdown-aware parts of `internal/repository`; every
  function names the Go original it mirrors. When you change slug generation,
  excerpts, wikilink extraction, splitting, frontmatter, download wrapping, or
  content validation on the server, change it there too. The accepted
  divergences are listed in spec/REQUIREMENTS.md § Demo Mode — don't add more
  silently.
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

## Tests

Use `github.com/stretchr/testify` (`require` for fatal checks, `assert`
otherwise). Repository and handler tests run against an in-memory SQLite DB
(`file::memory:?cache=shared`) with the full schema migrated. Place `_test.go`
files alongside the package under test.

```bash
go test ./...
go test ./internal/handler/ -run TestCreateAndGetNote
```

## E2E tests

Playwright end-to-end tests live in `e2e/`. **Run them with `./build.sh && ./test-e2e.sh`**
from the repository root — that script is the one the CI step invokes, and it starts the server
itself on a fresh database, checks the server is actually serving the assets on disk, and tears
both down afterwards. It takes the same arguments as `playwright test`, so
`./test-e2e.sh tests/sidebar-footer.spec.ts -g "focus"` works.

Two of the three specs are this repo's half of two cross-repo contracts (`../mysuite`, `spec/` —
see `web/AGENTS.md`); the third is MyNotes' own, and the distinction matters, because changing
what the first two assert is a change in three repositories and changing the third is not:

- `tests/sidebar-footer.spec.ts` — the sidebar-footer contract (`spec/sidebar-footer.md`).
- `tests/logo.spec.ts` — the app-logo contract (`spec/app-logo.md`): the brand badge's geometry,
  colour, glyph extent and placement, plus the guards that are MyNotes-local because our badge
  sits inside a link.
- `tests/note-list-refetch.spec.ts` — **contract-free, and local to this app**: the sidebar note
  list must not reload itself, and so must not discard the reader's scroll position, unless the
  query actually changed. It exists because the sidebar-footer suite caught that defect only by
  landing inside a 300 ms debounce window by chance — green here for weeks, red in CI once.
  Both tests in it measure from *past* that window rather than trying to land in it.

The CI step needs no change as specs are added — it runs `./test-e2e.sh` with no arguments,
which picks up everything under `tests/`.

**The CI step runs this suite.** `.github/workflows/main.yml` has it, after `./build.sh` and
before Pages and the release. `../mysuite/spec/sidebar-footer.md` §9.1 records the three apps'
statuses side by side and **is the authority** — read the status there rather than from a copy
here. This paragraph deliberately carries no run numbers, hashes or dates: a status table
restated in an app repo is the next thing to go stale, which is exactly the failure this
correction is fixing.

Note what a run does and does not mean — **the wording below is MyCal's**, taken rather than
rewritten, because three repos saying this three ways is how the next drift starts:

> the workflow triggers on `push` to `main`, so a breaking commit is already on `main` by the
> time the suite is red — what the gate prevents is a broken contract reaching Pages or the
> rolling release, not the commit landing.

So "the suite gates the contract" is an over-claim. It gates **publication**.

**And a green suite is still not a cross-repo check — that half has not changed.** Each app's
suite can only see its own app: this one shows that *MyNotes* satisfies the contract and says
nothing about whether MyCal and MyMail still agree with it. All three can run, all three can be
green, and the three can still have diverged from each other. Cross-repo drift is detectable
only by `mysuite/tools/check-contract.py`. Do not read "the suite runs now" as closing that gap;
it was never the gap the suite addressed.

Playwright is installed by the workflow, not by `build.sh` — `build.sh` stays usable without a
browser toolchain, and it is byte-unchanged by this.

Everything past running it is in **`e2e/AGENTS.md`**: why to prefer `test-e2e.sh` over a
hand-started server (stale assets, a stale database, a squatter on the port), the
`-public-url`/CSRF rule, why `playwright-test` is the only interactive entry point and
`npm test` is not, and why a geometry assertion can move with no matching source change.

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
    no HTML sanitization since it is not used in contexts where that would be an issue.
    Because it is stored unescaped, anything splicing it into markup must escape
    it (`service.escapeHTMLText` in the published-page document).
  - **Published note HTML** — sanitize-and-store with `sanitize.PublishedHTML`;
    it is rendered output, not a source of truth. See § Publishing.
- **Validate URL schemes** (allow only `http`, `https`, `mailto`) wherever URLs
  are stored or rendered.
- **HTTP hardening:** keep the global `http.MaxBytesHandler` body limit, and both
  `ReadTimeout` and `ReadHeaderTimeout` set on the server.
- **CSP:** keep the Content-Security-Policy tight; include `frame-ancestors
  'none'`. When adding outbound resources, update the relevant directive
  (`script-src`, `img-src`, `connect-src`) at the same time. Published pages have
  their own, stricter policy (§ Publishing) — it must stay script-free.
- **Authentication is global.** Basic auth wraps the whole handler tree; the only
  exemption is the `/public/` prefix (§ Publishing). Adding a second one means
  deciding, deliberately, that everything reachable under it is world-readable.
- **GET is side-effect free:** never modify the database in a GET handler.
- Add `maxLength` (and other) constraints in `openapi.yaml` for string query
  parameters and body fields, not just in code.

## Go development

Run `go mod tidy` after modifying `go.mod`. Cross-cutting HTTP middleware
(auth, CSRF, gzip, security headers, recovery) comes from
`github.com/mikaelstaldal/go-server-common` — prefer it over reimplementing.
