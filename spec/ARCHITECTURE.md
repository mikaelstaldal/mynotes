# MyNotes — Architecture

MyNotes uses a layered Go backend, SQLite storage,
an OpenAPI-defined REST API with generated server stubs, and an embedded Preact +
TypeScript frontend. The deployed artifact is a single Go binary plus one SQLite
file.

This document records the design decisions. Functional behavior is in `REQUIREMENTS.md`.

## Layering

```
handler → service → repository → SQLite
```

- `main.go` — CLI flags, HTTP routing, middleware, graceful shutdown.
- `openapi.yaml` — REST contract; source of truth for code generation.
- `internal/api/` — generated ogen server stubs (never hand-edited).
- `internal/handler/` — implements the generated `api.Handler`; maps sentinel
  errors to HTTP status; middleware chain (recovery/no-store/gzip).
- `internal/service/` — business logic: validation, slug generation/collision,
  structural Markdown validation, sentinel errors.
- `internal/repository/` — SQLite storage; schema + FTS triggers + migrations in
  `db.go`.
- `internal/model/` — shared `Note` domain type.
- `internal/sanitize/` — bluemonday; the write-time embedded-HTML *validator* (accept/reject).
- `web/` — embedded Preact frontend (`embed.go` `//go:embed` of `web/static`).

Request flow: handler (thin adapter) → service (rules) → repository → SQLite.

## Decisions

Notes are stored as Markdown source. The server stores, searches, validates, and
returns the source but **never produces or serves HTML**. All Markdown→HTML
conversion and sanitization happens in the browser. This moves the XSS trust
boundary into the client.

| Concern        | Decision                                             |
|----------------|------------------------------------------------------|
| Body           | Markdown source stored verbatim; rendered in browser |
| Editing        | CodeMirror 6 Markdown editor                         |
| Rendering      | Client-side (markdown-it → DOMPurify)                |
| URL key        | `slug` (stable, human-readable)                      |
| Search         | FTS5 title + Markdown body, with snippets            |
| Frontend route | Path routes via History API                          |

There is no `content_html` field and no server render endpoint.

## Data model & persistence (SQLite)

Fresh schema `schemaV1` replaces the template's `items` schema (the `items`
migration history is discarded; `migrations[0]` becomes MyNotes `schemaV1`,
`PRAGMA user_version` driven from 1). Targets a fresh data directory; pointing at
a pre-existing template DB is unsupported.

```sql
CREATE TABLE notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',   -- Markdown source
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_notes_updated_at ON notes(updated_at DESC, id DESC);
```

The composite index carries the `id` tie-break so the browse ordering
(`updated_at DESC, id DESC`) is served without a sort step.

**Full-text search:** external-content FTS5 table mirroring `notes`, indexing
`title` and `content`, kept in sync by `AFTER INSERT/DELETE/UPDATE` triggers
(external-content tables require the `'delete'` bookkeeping command on
delete/update). The UPDATE trigger is unscoped (`AFTER UPDATE ON notes`).

```sql
CREATE VIRTUAL TABLE notes_fts USING fts5(
  title, content, content='notes', content_rowid='id'
);
```

Search query rules:
- `MATCH ?` is **unqualified** (`notes_fts MATCH ?`), so it matches both title and
  content. A column-qualified `content MATCH ?` would break title search.
- Reuse the template's `sanitizeFTSQuery` (quote each token → literal terms).
- Browse (effective query empty) → `ORDER BY updated_at DESC, id DESC`.
- Search (effective query present) → `ORDER BY rank, id DESC` (bm25 `rank`
  ascending = best first; do **not** use `rank DESC`). `rank`/`snippet()` resolve
  only when joining `notes_fts` (`notes n JOIN notes_fts f ON f.rowid = n.id`);
  qualify every column (`n.id`, `f.rank`).
- `total` is a second `COUNT(*)` over the **same predicate** (`SELECT COUNT(*)
  FROM notes` browsing; `… FROM notes_fts WHERE notes_fts MATCH ?` searching),
  independent of limit/offset. Best-effort, not transactionally consistent with
  the page.
- Excerpt is built **in the repository** for both branches:
  - Browse: plain ~200-rune word-boundary prefix of the source. SQL-truncate with
    `substr(content, 1, 201)` (SQLite `substr` counts code points on TEXT) to
    avoid pulling full content; apply the rune-accurate word-boundary cut + `…` in
    Go. A 201-rune probe means truncation is needed (append `…`); ≤200 is shown
    verbatim. Empty content → empty excerpt.
  - Search: FTS5 `snippet(f, 1, char(2), char(3), '…', 30)` over the `content`
    column (index 1), marking matched terms with sentinel control chars `U+0002`
    (start) / `U+0003` (end) — not HTML. `snippet()` mark/ellipsis args are SQL
    literals (`char(2)`/`char(3)`), only `MATCH` is bound. The FTS join must also
    select `substr(n.content,1,201)`; per row, if the snippet contains a `U+0002`
    sentinel use it, otherwise (title-only match or empty content) fall back to the
    plain prefix. The client converts sentinel pairs to `<mark>` after HTML-escaping.

## REST API

Base path `/api/v1`, defined in `openapi.yaml`. Error body `{ "error": "message" }`.
Timestamps RFC 3339 UTC.

| Method & path                | Purpose                                            |
|------------------------------|----------------------------------------------------|
| `GET /notes`                 | List/search. Query `q`, `limit`, `offset`.         |
| `POST /notes`                | Create. Body: `title`, `content`, optional `slug`. |
| `GET /notes/{slug}`          | Fetch one note.                                    |
| `PATCH /notes/{slug}`        | Partial update (`title`, `content`, `slug`).       |
| `DELETE /notes/{slug}`       | Delete.                                            |
| `GET /notes/{slug}/download` | Raw Markdown download (`text/markdown`).           |

Schema notes:
- `POST` (201) and `PATCH` (200) both return the **full `Note`** — the editor's
  post-save navigation reads the final slug from the body.
- Response schemas: `Note` {slug, title, content, created_at, updated_at};
  `NoteSummary` {slug, title, updated_at, excerpt}; `NoteList` {total, notes}. All
  **response** fields are `required` (excerpt is `""`, never absent).
- Request fields: `CreateNoteRequest` {title required 1..200; content optional
  0..1000000 default ""; slug optional pattern+maxLength 100}. `UpdateNoteRequest`
  = all optional with identical constraints; absent = leave unchanged; explicit
  JSON `null` is rejected by ogen (no null-clears semantic — send `content: ""` to
  clear).
- Constraints in `openapi.yaml`: `title` 1..200; `content` maxLength 1000000;
  `slug` maxLength 100 pattern `^[a-z0-9]+(?:-[a-z0-9]+)*$`; `q` optional
  maxLength 200 **no minLength**; `limit` 1..200 default 50; `offset` minimum 0
  **no maximum**. Out-of-range query params → ogen 400 (handler never clamps;
  frontend clamps before sending). `excerpt` has **no maxLength** (token-bounded).
- The `{slug}` path param carries the slug pattern on every `/notes/{slug}*` route
  (incl. `/download`); a malformed slug is an ogen 400 before the handler.

Status/error mapping (in handler `NewError`): `service.ErrValidation`→400,
`service.ErrNotFound`→404, `service.ErrConflict`→409 (new sentinel). DELETE of an
unknown slug → 404 (not idempotent).

### Markdown download

`GET /notes/{slug}/download` returns `content` as the raw body
(`text/markdown; charset=utf-8`), `Content-Disposition: attachment;
filename="<slug>.md"`. Declared in `openapi.yaml` as a `200` with a single
`text/markdown` `string` content + a `Content-Disposition` response header, so
ogen emits a raw body + header setter; errors keep the JSON `{"error":…}` shape.
Empty content downloads as 200 with a zero-length body. Served URL is
`/api/v1/notes/{slug}/download` (frontend must use the `/api/v1` prefix and a
root-absolute href). If ogen cannot express raw-body+header+mixed-media, fall back
to a thin non-ogen route at the fully-qualified path, wrapped in the same
`handler.WithMiddleware` chain and reusing the same error encoder. **Verify with a
spike in milestone 1** (raw body + header on one 200, the empty-body case, and
mixed media types per status; gzip behavior over the empty body).

## Markdown rendering & validation pipeline

**Client (authoritative XSS gate):** markdown-it (with `html: true`, `linkify`
on, GFM tables/strikethrough/autolinks, `maxNesting: 100`) → DOMPurify before any
`innerHTML`. One shared helper (`web/ts/util/markdown.ts`) owns render+sanitize;
exactly one place assigns note-derived HTML to `innerHTML`. Used by both the read
view and the editor live preview.

**Server (defense-in-depth, write-time gate, §4.1):** on create and on update
when `content` is present, the service parses `content` with **Goldmark**
(`github.com/yuin/goldmark`, wired with the individual extensions
`extension.Table`/`extension.Strikethrough`/`extension.Linkify` — **not** the GFM
bundle, to keep task-lists off) and walks the AST, rejecting the write with
`ErrValidation` → 400 if any of:
- **Embedded HTML outside the safe allow-list.** Pull each `ast.KindRawHTML` /
  `ast.KindHTMLBlock` fragment and run **bluemonday** over just that fragment.
  Compare bluemonday's output against a **canonical re-serialization of the
  original fragment through the same `golang.org/x/net/html` tokenizer**
  (token-stream level, not a parse-tree balance) so pure reformatting doesn't
  false-reject; only genuinely stripped/rewritten content trips rejection.
  bluemonday output is used only for the decision, never stored.
  - Policy = `bluemonday.UGCPolicy()` (broad safe-HTML profile) **made
    removal-only**: explicitly disable every attribute injector
    (`RequireNoFollowOnLinks(false)`, `…OnFullyQualifiedLinks(false)`,
    `RequireNoReferrer…(false)`, `AddTargetBlankToFullyQualifiedLinks(false)`,
    `RequireCrossOriginAnonymous(false)`). Add URL rules: `<a href>` keeps
    `http`/`https`/`mailto`/relative; `img@src` allows **only** `https`, relative,
    and the canonical `data:` raster set (`Matching` regexp), excluding
    `data:image/svg+xml` and dropping `http`.
- **Disallowed schemes on Markdown-native destinations** (`ast.KindLink` /
  `ast.KindAutoLink` / `ast.KindImage`): links allow `http`/`https`/`mailto`;
  images allow only `https` + canonical `data:` raster (no `http`). No-scheme
  (root-/bare-relative) allowed; scheme-relative (`//host/…`) rejected on both;
  any other explicit scheme rejected. Scheme comparison case-insensitive.
- **Nesting deeper than 100 levels** (coarse DoS bound; parity with client
  `maxNesting` is a goal not a guarantee).
- **C0 control characters in `content`** except tab/newline/CR (flat byte scan).
  Guarantees the search sentinels `U+0002`/`U+0003` never reach storage.
- **`title` rejects *all* C0 controls** (incl. tab/newline/CR) — single-line,
  FTS-indexed display string.

The canonical `data:` image allow-list — used identically by the server scheme
check, the bluemonday `img@src` rule, markdown-it `validateLink`, and DOMPurify —
is the regexp **`^data:image/(gif|png|jpeg|webp);`** (required trailing `;`,
excludes `svg+xml`).

Parity between server and client gates is a **goal, not a security dependency**:
DOMPurify is authoritative at render time, so a divergence is at worst a UX
wrinkle. A shared test vector pins them (milestone 7).

The check is **service-layer** (structural, not expressible as ogen
`pattern`/`maxLength`); length and UTF-8 remain ogen/service checks. It only
accepts or rejects — content is stored byte-for-byte verbatim.

## Security model

The browser renders untrusted content; the design treats stored content as
hostile and gates on render. Layered defenses:
1. Embedded HTML allowed but gated — server bluemonday (write) + DOMPurify (render).
2. markdown-it `validateLink` — coarse denylist first pass (blocks script-y and
   non-canonical `data:` schemes; passes the rest). Not the allow-list authority.
3. **DOMPurify — authoritative render-time gate.** Broad safe-HTML allow-list
   matching the server bluemonday profile; excludes `script`/`style`/`iframe`/
   form controls/raw media and all `on*` handlers. `ALLOWED_URI_REGEXP =
   /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i` — three-scheme
   allow-list **plus DOMPurify's relative-URL alternation** (load-bearing: keeps
   root-relative in-app `/notes/<slug>` links working). An
   `uponSanitizeAttribute` hook permits `data:` **only** on `img@src` matching the
   canonical raster regexp (closes the `data:image/svg+xml` that DOMPurify
   defaults would admit) and strips `data:` everywhere else (e.g. `<a href>`).
4. Strict CSP — `script-src 'self'`, all vendor bundles served from origin,
   import-map hash via `commonweb.ImportMapCSPHash` (adapts automatically; no
   manual hash). Keep `frame-ancestors 'none'`. CodeMirror's runtime `<style>` is
   covered by existing `style-src 'self' 'unsafe-inline'`. **Only CSP change:**
   widen `img-src` from `'self' data:` to `'self' data: https:` (no `http` — no
   mixed content; combined with the server rejecting `http` image destinations).
   Do **not** add `connect-src` (API is same-origin under `default-src 'self'`).

Server responsibilities unchanged otherwise: `http.MaxBytesHandler` body cap
(10 MiB covers the 1M-char limit), `ReadTimeout`/`ReadHeaderTimeout`, CSRF
middleware, optional Basic Auth, GET side-effect free.

## Frontend (Preact + TypeScript)

- **Path-based router** (History API) replacing the hash router. Routes `/`,
  `/new`, `/notes/{slug}`, `/notes/{slug}/edit`. Link-click interception applies
  only to in-app routes; the download link and external/absolute URLs do real
  navigations.
- All API calls go through `api` in `web/ts/api/client.ts` (no direct `fetch`).
  `client.ts` maps a `400` slug-pattern rejection on `GET /notes/{slug}` to the same not-found signal
  as a `404`.
- Shared `web/ts/util/markdown.ts` render+sanitize helper.
- Client-side rune-counting (code points, not UTF-16) for every "character"
  cap/truncation (q ≤200, title derive ≤200, upload size pre-check).
- File naming: components/views `PascalCase.tsx`; utilities `lowercase.ts`;
  relative imports use `.js` extensions.

### Vendored libraries (CSP `script-src 'self'`)

CodeMirror 6, markdown-it, DOMPurify are pre-bundled by **esbuild** into
self-contained ESM files under `web/static/vendor/` (`codemirror.js`,
`markdown-it.js`, `dompurify.js`), each added to the import map in
`web/static/index.html`, and committed like the vendored Preact files.

**Supply-chain stance:** `build.sh` never runs `npm`/`npx`/`yarn`/`pnpm`/`bun`. The
bundles are committed source-of-truth artifacts; `build.sh` consumes them and
does not rebuild them. They are regenerated only by an **out-of-band, manually-run
maintainer script** (e.g. `web/ts/vendor/rebuild.sh`, not part of `build.sh` or
CI) that pins upstream versions, runs `npm ci --ignore-scripts` into a throwaway
`.gitignore`d `node_modules`, bundles with esbuild, and is the single place `npm`
and `esbuild` are required. This keeps every package-manager install manual,
audited, and outside the automated build.

- `vendor/codemirror.js` re-exports a fixed minimal surface: from
  `@codemirror/view` `EditorView` (incl. `updateListener`, `dispatch`,
  `lineWrapping`) + `keymap`; from `@codemirror/state` `EditorState`,
  `EditorSelection`; from `@codemirror/commands` `defaultKeymap`, `history`,
  `historyKeymap`; from `@codemirror/language` `syntaxHighlighting`,
  `defaultHighlightStyle`; from `@codemirror/lang-markdown` `markdown`. **Not in
  v1:** search, line numbers/gutters, placeholder, bracket matching. Editor
  sizing/styling is done in `app.css` targeting `.cm-editor`/`.cm-scroller`/
  `.cm-content` (no CodeMirror theme export).
- **TypeScript resolution:** `web/ts/tsconfig.json` needs `paths` entries for
  `codemirror`/`markdown-it`/`dompurify` → `.d.ts` shims under `web/ts/vendor/`
  (upstream `@types/markdown-it`/`@types/dompurify`; a **hand-authored** shim for
  codemirror matching the re-export surface). `noEmitOnError: true` makes missing
  types a hard `tsc` failure. Keep `exclude: ["vendor"]`.

## Build & test pipeline

`build.sh` order: `go generate` (ogen) → `openapi-typescript` → `tsc` →
**`node --test`** (client XSS-gate tests, against committed bundles) → `go test` →
lint. **`build.sh` runs no `npm`/`npx`/`yarn`/`pnpm`/`bun` and no esbuild step** — the
vendor bundles are pre-built committed artifacts (see "Vendored libraries"). Only
**`node`** is added to the required tools on `$PATH` (in addition to `go`, `ogen`,
`tsc`, `openapi-typescript`, `golangci-lint`). `esbuild` and `npm` are required
only by the out-of-band vendor-rebuild script, not by `build.sh`.

Tests:
- **Repository:** CRUD, unique-slug, FTS matches + ranking, trigger sync.
- **Service:** slug generation/collision, validation, structural Markdown
  validation (safe HTML accepted, unsafe rejected, scheme rules, sentinel/C0
  rejection, title C0 rejection, removal-only round-trip spike).
- **Handler:** request/response cycle, error→status mapping.
- **Frontend XSS gate:** `node:test` + a committed, test-only vendored `jsdom`
  bundle (under `web/ts/vendor/test/`; **no `npm` devDependency, no `npm ci`**),
  importing the **real vendored `markdown-it.js`/`dompurify.js` bundles** via a
  Node resolution shim mirroring the import map. Tests live under `web/ts` and run
  with only `node` on `$PATH`. Shared server/client parity vector for `data:` and
  HTML allow-list verdicts.
