# MyNotes — Specification

A personal note manager. It stores a collection of documents written in
**Markdown** (CommonMark), each reachable at a **stable, slug-based URL**, with a
**web-based editor** and **full-text search** across all documents.

This document is the specification only. It defines *what* to build and the key
design decisions. No code is implemented yet.

---

## 1. Goals & scope

- Manage a personal collection of Markdown documents ("notes").
- Each note has a human-readable **slug** that produces a stable, shareable URL.
- A browser-based **Markdown editor** with live preview.
- **Full-text search** across all notes (titles + body), powered by SQLite FTS5.
- Single-user / personal tool. Optional HTTP Basic Auth gates the whole app
  (already supported by the template via `-basic-auth-file`). No per-note
  ownership, sharing, or multi-tenant concerns in v1.

### Non-goals (v1)

- Real-time collaboration / concurrent multi-user editing.
- Version history / revisions.
- Folders, tags, or hierarchical organization (may be added later).
- File/image attachments and uploads.
- Public publishing workflow beyond the stable URL existing.

These are listed so the data model and API leave room for them but do not
implement them.

---

## 2. Relationship to the template

MyNotes is built on the existing `go-web-template`. The single `items` resource
is **replaced** by a `notes` resource. The layered architecture is unchanged:

```
handler → service → repository → SQLite
```

The decisive new ingredient versus the template is **Markdown**: notes are stored
as Markdown source, and the browser renders and **sanitizes** them locally
(CodeMirror for editing, markdown-it + DOMPurify for display). The server never
produces HTML, so the trust boundary moves into the browser — this is the central
security consequence of the client-side decision (see §7).

| Concern            | Template (`items`)            | MyNotes (`notes`)                                  |
| ------------------ | ----------------------------- | -------------------------------------------------- |
| Body content       | Sanitized HTML, stored as-is  | **Markdown source**, stored verbatim; rendered **in the browser** |
| Editing            | `<textarea>`                  | **CodeMirror 6** Markdown editor                   |
| Rendering          | Server returns HTML           | **Client-side** (markdown-it → DOMPurify)          |
| Resource key (URL) | Integer `id`                  | **`slug`** (stable, human-readable)                |
| Search             | FTS5 over title + content     | FTS5 over title + Markdown body (with snippets)    |
| Frontend routing   | Hash routes (`#/items/1`)     | **Path routes** (`/notes/my-slug`) via History API |

---

## 3. Domain model

A **Note**:

| Field        | Type      | Notes                                                                 |
| ------------ | --------- | --------------------------------------------------------------------- |
| `id`         | int64     | Internal primary key. Used as the FTS `rowid`. Not exposed as the URL key. |
| `slug`       | string    | Unique, URL-safe identifier. The stable address of the note.          |
| `title`      | string    | Display title. Used in listings, search weighting, and default slug.  |
| `content`    | string    | **Markdown source** (CommonMark). The source of truth for the body.   |
| `created_at` | timestamp | UTC RFC 3339 (template convention).                                   |
| `updated_at` | timestamp | UTC RFC 3339.                                                         |

Notes:

- `title` is a real, stored field (kept explicit so listings, search weighting,
  and slug generation are cheap and unambiguous). It is **auto-populated from the
  first `# heading` in the content as a client-side editor convenience only**
  (O-6):
  - In the editor, while the title has not been manually edited, it tracks the
    first heading found in the content as the user types. Once the user edits the
    title by hand, auto-sync stops (the manual value is never clobbered).
  - The API contract is unchanged by this: `title` is **mandatory** on create
    (the client always sends a value, derived or typed). The server does **not**
    derive titles — it validates and stores whatever the client submits.
- The API exposes `slug` as the resource identifier; `id` stays internal.
- There is **no** `content_html` field: the server stores and serves only the
  Markdown `content`; HTML is produced in the browser at display time (O-1).

### 3.1 Slug rules

- Allowed characters: lowercase ASCII letters, digits, and hyphens
  (`^[a-z0-9]+(?:-[a-z0-9]+)*$`). Length 1–100.
- **Generation:** if the client does not supply a slug on create, derive one
  from the title: lowercase, transliterate/strip accents, replace runs of
  non-alphanumerics with `-`, trim leading/trailing `-`, truncate to the max
  length. If the title yields an empty slug, fall back to `note`.
- **Uniqueness:** slugs are unique. On collision, append `-2`, `-3`, … until
  free. (The DB enforces uniqueness; the service resolves collisions.)
- **Editing:** a slug *may* be changed via update. Changing it changes the
  note's URL — old links break. This is acceptable for a personal tool; the UI
  should warn before changing an existing slug. (No automatic redirects in v1.)
- Reserved slugs: none required, because note URLs live under a `/notes/`
  prefix that cannot collide with app routes (see §6).

---

## 4. Markdown handling

Rendering and editing are **client-side** (resolves O-1, O-2, O-3). The server
treats `content` as opaque Markdown text: it stores it, searches it, and returns
it — it never converts it to HTML. All Markdown→HTML conversion happens in the
browser.

- **Standard (O-5):** CommonMark plus the common GFM extensions — tables,
  strikethrough, autolinks, task lists. **Images are enabled**: Markdown image
  syntax renders `<img>`, with `src` restricted to `https` and `data:` schemes
  (no `http`, to avoid mixed content; no uploads — only referencing remote/inline
  images, consistent with the v1 non-goal on attachments). This requires a small
  CSP `img-src` change (§7).
- **Storage:** the raw Markdown source is stored verbatim in `content`. It is
  **not** HTML-sanitized on the way in (that would corrupt the source). Only
  length and UTF-8 validity are checked on write.
- **Editing — CodeMirror 6.** The editor uses CodeMirror 6 with its Markdown
  language mode (`@codemirror/lang-markdown`) for syntax-aware highlighting of
  the source. It is a source editor (not WYSIWYG); the rendered result is shown
  in a separate preview pane.
- **Rendering — markdown-it + DOMPurify.** A client-side Markdown library
  (recommended: `markdown-it`) converts the source to an HTML string, which is
  then **sanitized with DOMPurify** before being inserted into the DOM. DOMPurify
  is the authoritative XSS gate (see §7). This same pipeline drives both the live
  preview in the editor and the read view.
- **No server render endpoint and no `content_html`.** There is no `POST
  /render`; the previous server-rendered `content_html` field is removed. Live
  preview is instantaneous and local — no round-trips.

### Why this is safe despite no server-side sanitization (summary; full detail §7)

1. markdown-it is configured with `html: false`, so raw inline/block HTML in the
   source is escaped to literal text rather than passed through.
2. markdown-it's link validator is restricted to `http`, `https`, `mailto`
   (blocking `javascript:`, `vbscript:`, `data:` URLs in links).
3. DOMPurify sanitizes the rendered HTML string before any `innerHTML`
   assignment — the final, authoritative gate.
4. The CSP stays strict (`script-src 'self'`); all libraries are vendored and
   served from origin (see §6, §7).

---

## 5. REST API

Base path `/api/v1`, defined in `openapi.yaml` (source of truth for codegen).
Error body remains `{"error": "message"}`. Timestamps are RFC 3339 UTC.

### Endpoints

| Method & path                | Purpose                                              |
| ---------------------------- | ---------------------------------------------------- |
| `GET /notes`                 | List/search notes. Query: `q`, `limit`, `offset`.    |
| `POST /notes`                | Create a note. Body: `title`, `content`, opt `slug`. |
| `GET /notes/{slug}`          | Fetch one note (Markdown `content`).                 |
| `PATCH /notes/{slug}`        | Partial update (`title`, `content`, `slug`).         |
| `DELETE /notes/{slug}`       | Delete a note.                                       |

There is no render endpoint — Markdown is rendered in the browser (§4).

### Schemas (informal)

```
Note:
  slug        string
  title       string
  content     string   # Markdown source (no HTML produced server-side)
  created_at  date-time
  updated_at  date-time

NoteSummary (list item):
  slug, title, updated_at, excerpt (plain-text), [highlight when q given]

NoteList:
  total int
  notes [NoteSummary]

CreateNoteRequest:
  title    string (1..200, required; client may auto-fill it from the first
                   heading, but always sends a value — O-6)
  content  string (0..N, optional, default "")
  slug     string (optional; pattern + maxLength 100; auto-generated if absent)

UpdateNoteRequest (all optional; nil = leave unchanged):
  title, content, slug

Error: { error: string }
```

The list `excerpt` is **plain text** (an FTS5 snippet or a truncated prefix of
the source), not HTML — see §8. The client escapes/highlights it safely.

### Constraints (declared in `openapi.yaml`, per template security guidance)

- `title`: `minLength: 1`, `maxLength: 200`. Required. (The editor auto-fills it
  client-side; the server does not derive it.)
- `content`: `maxLength` ~100,000 chars (matches the template's content cap;
  tune if needed).
- `slug`: `maxLength: 100`, `pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$'`.
- `q`: `maxLength: 200`.
- `limit`: 1–200, default 50. `offset`: ≥ 0, default 0.

### Status codes

- `201` create, `200` get/update/list/render, `204` delete.
- `400` validation (`service.ErrValidation`), `404` not found
  (`service.ErrNotFound`), `409` slug conflict on explicit user-supplied slug
  (new sentinel `service.ErrConflict` → `409`). Auto-generated slugs never
  conflict (the service resolves them), so `409` only arises when the client
  insists on a specific taken slug.

---

## 6. Frontend (Preact + TypeScript)

### Routing — path-based, not hash-based

The stable-URL requirement calls for real paths. The template's `staticHandler`
already serves `index.html` for any non-asset path, so a History-API SPA router
works without server changes. Replace the hash router with a path router.

| Route                  | View                                              |
| ---------------------- | ------------------------------------------------- |
| `/`                    | Note list + search box.                           |
| `/new`                 | Editor for a new note.                            |
| `/notes/{slug}`        | Rendered read view of a note (the stable URL).    |
| `/notes/{slug}/edit`   | Editor for an existing note.                      |

- The `/notes/` prefix isolates note URLs from app routes (`/`, `/new`), so no
  slug can shadow an application route.
- Internal navigation uses `history.pushState`; the app intercepts link clicks.
- All API calls go through `api` in `web/ts/api/client.ts` (no direct `fetch`
  from components — template convention). Add a `notes` client mirroring the
  existing `items` client, plus a `render` call.

### Views

- **List/search (`/`):** search input (debounced, drives `q`), results show
  title, updated time, plain-text excerpt, and search highlights when searching.
  "New note" button. Empty and loading states.
- **Read (`/notes/{slug}`):** fetches `content`, renders it with the
  markdown-it → DOMPurify pipeline (§4), and injects the sanitized HTML into a
  constrained, styled container. "Edit" and "Delete" actions. 404 view for
  missing slugs.
- **Editor (`/new`, `/notes/{slug}/edit`):**
  - Title input. While untouched, it auto-fills from the first heading in the
    content as the user types; manual edits stop the auto-sync (O-6).
  - Slug field: auto-suggested from title for new notes; shown (and editable
    with a warning) when editing an existing note (O-4 — slugs are mutable; no
    redirects, so the UI warns that the URL will change).
  - **CodeMirror 6** Markdown source editor plus a **live preview** pane rendered
    locally (markdown-it → DOMPurify) on a debounced change of the editor
    contents. Split or toggle layout. No network round-trip for preview.
  - Save (create/update) and Cancel. Unsaved-changes guard on navigate-away.
  - Errors surfaced via the existing `Toast` component.

### Editor & rendering libraries (resolves O-2)

The editor is **CodeMirror 6**; rendering is **markdown-it** sanitized by
**DOMPurify**. All three are third-party browser libraries that must be served
from origin to keep the CSP at `script-src 'self'`.

- **Vendoring strategy.** The template vendors ESM modules and references them
  through an import map (as it does for Preact). CodeMirror 6's dependency graph
  is large (a dozen-plus `@codemirror/*` and `@lezer/*` modules), so hand-listing
  every module in the import map is impractical. Instead, **pre-bundle each
  vendor library into a single self-contained ESM file** with `esbuild`, write
  the bundles under `web/static/vendor/`, and add one import-map entry per
  bundle:
  - `vendor/codemirror.js` — CodeMirror view/state/commands/language +
    `lang-markdown`.
  - `vendor/markdown-it.js` — the Markdown renderer.
  - `vendor/dompurify.js` — the sanitizer.
- **Build pipeline change.** `build.sh` gains an `esbuild` bundling step before
  `tsc`, and **`esbuild` becomes a required tool on `$PATH`** (alongside `go`,
  `ogen`, `tsc`, `openapi-typescript`, `golangci-lint`). The bundles are
  committed like the existing vendored Preact files so the binary stays
  self-contained via `//go:embed`. (Update `CLAUDE.md` Build & Run accordingly
  during implementation.)
- **CSP note.** CodeMirror injects its styles as runtime `<style>` elements,
  which the template's existing `style-src 'self' 'unsafe-inline'` already
  permits. No new `script-src` allowances are needed because the bundles load
  from origin and the import-map hash continues to be covered by
  `commonweb.ImportMapCSPHash`. See §7.

---

## 7. Security

The template's security guidance carries over. The client-side rendering
decision moves the XSS trust boundary **into the browser**, so the spec is
explicit about the consequence and the layered mitigations that keep it safe.

### Trust-boundary consequence (be explicit)

Because the server stores raw Markdown and never produces HTML, server-side
bluemonday sanitization no longer protects rendered notes. The data the browser
renders is **untrusted** (it could contain `<script>`, `javascript:` links, or
raw HTML — whether typed by the user or written by any future import/API
client). For a single-user personal tool the practical exposure is self-XSS, but
the design still treats stored content as hostile and gates it on render.

### Layered defenses (defense in depth)

1. **markdown-it `html: false`** — raw inline/block HTML in the source is
   escaped to text, not passed through. Removes the most common injection path
   before sanitization even runs.
2. **markdown-it link validation** — restrict accepted link URL schemes to
   `http`, `https`, `mailto`, and image `src` schemes to `https`, `data:`
   (O-5). Blocks `javascript:`/`vbscript:` URLs. DOMPurify is configured with the
   same allow-lists.
3. **DOMPurify (authoritative gate)** — every HTML string is sanitized with
   DOMPurify immediately before any `innerHTML` assignment, in both the read view
   and the editor preview. A single shared helper (e.g.
   `web/ts/util/markdown.ts`) owns the render+sanitize pipeline so no component
   ever injects unsanitized HTML. There is exactly one place that touches
   `innerHTML`.
4. **Strict CSP** — `script-src 'self'` (no inline/eval scripts); all vendor
   bundles served from origin; the import-map hash stays covered by
   `commonweb.ImportMapCSPHash`. Even if a sanitization bug slipped through, the
   CSP blocks loading external scripts. Keep `frame-ancestors 'none'`.
   - CodeMirror's runtime `<style>` injection is covered by the existing
     `style-src 'self' 'unsafe-inline'`. No `script-src` change is required.
   - **`img-src` change (O-5):** because rendered notes may embed remote/inline
     images, widen the directive from `'self' data:` to **`'self' data:
     https:`**. This permits remote `https` image loads (note the privacy
     implication: viewing a note will fetch its referenced images, leaking the
     viewer's IP to those hosts — acceptable for a personal tool).

### Server-side responsibilities (unchanged or new)

- **Validate on write:** title/slug/content length, UTF-8 validity, slug pattern
  (`^[a-z0-9]+(?:-[a-z0-9]+)*$`). The server does *not* HTML-sanitize the source
  (that would corrupt Markdown), so these are the server's gate.
- **GET is side-effect free** — listing/fetching never writes (no rendered-HTML
  caching exists to tempt a write; O-3 resolved as "no caching").
- **Body limits / timeouts:** keep the global `http.MaxBytesHandler` cap and the
  server `ReadTimeout` / `ReadHeaderTimeout`. The 10 MiB body cap comfortably
  covers the ~100 KB content limit.
- **CSRF / auth:** unchanged from the template (CSRF middleware on; optional
  Basic Auth via htpasswd).

> The existing `internal/sanitize` (bluemonday) package is **not** on the note
> write/read path anymore. Either remove it or retain it only as an optional
> server-side raw-HTML strip of the stored source (defense in depth); the primary
> design stores Markdown verbatim and sanitizes client-side. Decide during
> implementation — default: remove, since DOMPurify is the gate.

---

## 8. Persistence (SQLite)

A fresh schema (`schemaV1`) replaces the template's `items` schema. New
databases start at MyNotes v1; this is a template repurpose, not a migration
from `items`. Future changes append to `migrations` per the template rule.

```sql
CREATE TABLE notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',   -- Markdown source
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_notes_updated_at ON notes(updated_at DESC);
-- slug already has a UNIQUE index from the column constraint.
```

### Full-text search (FTS5)

Reuse the template's external-content FTS5 pattern (an `fts5` table mirroring the
base table, kept in sync by triggers). Index `title` and `content` (the Markdown
source — searching the source is acceptable and simple; punctuation/markup noise
is minor).

```sql
CREATE VIRTUAL TABLE notes_fts USING fts5(
  title, content,
  content='notes', content_rowid='id'
);
-- AFTER INSERT / DELETE / UPDATE OF (title, content) triggers keep notes_fts in
-- sync, exactly as the template does for items_fts.
```

- **Querying:** keep the template's `sanitizeFTSQuery` (quote each token to make
  FTS5 treat user input as literal terms, not operators).
- **Ranking:** order by FTS5 relevance (`ORDER BY rank`) when `q` is present;
  order by `updated_at DESC` when browsing without a query.
- **Snippets/highlights:** use FTS5 `snippet()` to produce the list `excerpt`
  and highlight markers for matched terms. Highlight markup must be rendered
  safely (escape text, then wrap matches) — it is not free-form HTML.

---

## 9. Backend layering (Go)

Mirrors the template; rename/replace `item*` with `note*`.

- `internal/model`: `Note` struct (adds `Slug`).
- `internal/repository`: `NoteRepository` (`List`, `GetBySlug`, `Create`,
  `Update`, `Delete`, slug-existence check). `db.go` gets the new schema + FTS.
- `internal/service`: `NoteService` — validation (title, slug pattern, content
  length, UTF-8), slug generation + collision resolution. Adds `ErrConflict`.
  **No Markdown rendering** — the server never converts Markdown to HTML.
- `internal/sanitize`: no longer on the note path (§7). Default: remove; or keep
  only as an optional raw-HTML strip of the stored source.
- `internal/handler`: implement the generated `api.Handler` for notes; map
  sentinel errors (`ErrNotFound`→404, `ErrValidation`→400, `ErrConflict`→409) in
  `NewError`. No `render` operation.
- `internal/api`: **generated** from `openapi.yaml` by `ogen` — never hand-edited.
- `web/ts`: new `notes` API client (no `render` call), path router,
  list/read/editor views, a shared `util/markdown.ts` render+sanitize helper, and
  CodeMirror wiring. Types regenerated from `openapi.yaml` via
  `openapi-typescript`.
- `web/static/vendor`: pre-bundled `codemirror.js`, `markdown-it.js`,
  `dompurify.js` (built by `esbuild`), referenced via the import map.

Code-generation workflow is unchanged: edit `openapi.yaml` → regenerate Go stubs
and TS types → implement handler + frontend. The frontend build additionally
bundles vendor libraries with `esbuild` before `tsc` (§6).

---

## 10. Testing

Follow template conventions (`testify`, in-memory SQLite
`file::memory:?cache=shared`, `_test.go` beside the package).

- **Repository:** create/get-by-slug/update/delete; unique-slug enforcement;
  FTS search returns expected matches and ranking; trigger sync after update.
- **Service:** slug generation (accents, punctuation, empty-title fallback,
  truncation); collision resolution (`-2`, `-3`); slug-pattern validation;
  content-length and UTF-8 limits. (No rendering to test server-side.)
- **Handler:** full request/response cycle for each endpoint; error→status
  mapping (400/404/409).
- **Frontend (where the XSS gate now lives):** unit-test the shared
  `util/markdown.ts` render+sanitize helper against a table of malicious Markdown
  inputs — `<script>`, `<img onerror=…>`, `[x](javascript:…)`, raw HTML blocks,
  `data:` URLs — asserting the sanitized output contains no script, event
  handler, or disallowed URL scheme. This requires a JS/TS test runner in
  `web/ts` (e.g. `node:test` or Vitest) — a new addition to the frontend
  toolchain; confirm choice during implementation.

---

## 11. Milestones (suggested build order)

2. **API contract** — write `openapi.yaml` for `notes`; regenerate
   Go stubs and TS types.
3. **Persistence** — new schema + FTS triggers in `db.go`; `NoteRepository` with
   tests.
4. **Service** — validation, slug generation/collision; sentinel errors
   (`ErrConflict`); tests. (No rendering.)
5. **Handler** — implement generated interface + error mapping; handler tests.
6. **Vendor bundling** — add the `esbuild` step to `build.sh`; produce
   `vendor/codemirror.js`, `vendor/markdown-it.js`, `vendor/dompurify.js`; wire
   the import map; update `CLAUDE.md` Build & Run (esbuild on `$PATH`).
7. **Frontend** — path router; list/search, read, and editor views; `notes`
   client; CodeMirror editor; shared `util/markdown.ts` render+sanitize helper +
   local live preview.
8. **Hardening pass** — DOMPurify/markdown-it config review, CSP review,
   client-side XSS regression tests, `./build.sh` green (bundle + build + test +
   lint).
