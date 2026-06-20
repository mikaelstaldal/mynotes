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
- "Stable URL" here means **durable and bookmarkable** (the address survives,
  unlike an opaque integer id or a hash route), not publicly accessible. When
  Basic Auth is enabled, every URL — including `/notes/{slug}` — is reachable
  only by the authenticated user; there is no anonymous public-read path in v1.

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
  - A heading line can exceed the `maxLength: 200` title limit. When deriving the
    title from a heading, the client truncates it to 200 characters (with a
    trailing `…`, counted within the 200) so a save never fails with a confusing
    `400` for a title the user never typed.
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
  from the title: lowercase, **fold accents via `golang.org/x/text/unicode/norm`
  NFKD then drop combining marks** (`é→e`, `ñ→n`), drop any remaining non-ASCII
  (non-Latin scripts are not transliterated — they simply fall away), replace
  runs of non-alphanumerics with `-`, trim leading/trailing `-`, then truncate to
  the max length (leaving room for any uniqueness suffix per §3.1). If the title
  yields an empty slug, fall back to `note`.
- **Uniqueness:** slugs are unique. (The DB enforces uniqueness; the service
  resolves collisions.) Collision handling depends on origin:
  - **Auto-generated** slug (client sent none): on collision the service appends
    `-2`, `-3`, … until free. The base is first truncated so that base + suffix
    still fits within `maxLength: 100` (the suffix is never sacrificed). The
    service-level existence check is advisory and racy (two concurrent creates
    can both pass it); the DB `UNIQUE` constraint is the source of truth. On a
    `UNIQUE` violation for an auto-generated slug, the service re-resolves the
    suffix and retries the insert (bounded retries), so concurrent
    double-submits/autosaves never surface a spurious error.
  - **Explicit** slug (client supplied one): a collision is an error, never
    silently suffixed — the service returns `ErrConflict` → `409`.
- **Editing:** a slug *may* be changed via `PATCH`. Setting `slug` to a value
  already used by **another** note returns `409`; setting it to the note's own
  current slug is a no-op (not a conflict). Changing it changes the note's URL —
  old links break. This is acceptable for a personal tool; the UI should warn
  before changing an existing slug. (No automatic redirects in v1.)
- Reserved slugs: none required, because note URLs live under a `/notes/`
  prefix that cannot collide with app routes (see §6).

---

## 4. Markdown handling

Rendering and editing are **client-side** (resolves O-1, O-2, O-3). The server
treats `content` as opaque Markdown text: it stores it, searches it, and returns
it — it never converts it to HTML. All Markdown→HTML conversion happens in the
browser.

- **Standard (O-5):** CommonMark plus the common GFM extensions that stock
  markdown-it supports — tables, strikethrough, and autolinks. markdown-it
  `linkify` is **enabled**, so bare URLs/emails in plain text become links too
  (not just explicit `<url>` autolink syntax); these still pass through
  `validateLink` and DOMPurify, so the scheme allow-lists apply unchanged. **Task lists are *not*
  in v1** (they need a markdown-it plugin and would require allowing `<input>`
  through the sanitizer; `- [ ]` simply renders as a literal list item). **Images
  are enabled**: Markdown image
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
2. markdown-it's link validator (`validateLink`) is a single coarse hook that
   fires for both links and images, so it accepts the **union** of the allowed
   schemes (`http`, `https`, `mailto` for links plus `data:` for images) and
   blocks `javascript:`/`vbscript:`. It cannot by itself forbid `data:` in links
   while allowing it in images; that per-tag distinction is enforced
   authoritatively by DOMPurify's URI policy (see §7).
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
| `GET /notes/{slug}/download` | Download the raw Markdown source (no JSON wrapping).  |

There is no render endpoint — Markdown is rendered in the browser (§4).

### Markdown download

`GET /notes/{slug}/download` returns the note's `content` as the **raw response
body**, not wrapped in the `Note` JSON object. It exists so the web UI (and any
HTTP client) can save a note as a `.md` file directly.

- **Response media type:** `text/markdown; charset=utf-8`. In `openapi.yaml` the
  `200` response declares a single `text/markdown` content with a `string`
  schema, so ogen emits a raw-bytes/`string` body rather than a struct. (Errors
  still use the standard `{"error": "message"}` JSON body — `404` for an unknown
  slug.)
- **Filename:** the handler sets
  `Content-Disposition: attachment; filename="<slug>.md"` so browsers save the
  file with the slug as its name. The slug pattern
  (`^[a-z0-9]+(?:-[a-z0-9]+)*$`) is already filesystem- and header-safe, so no
  escaping is required.
- **Body is the verbatim stored Markdown** — the same source returned in
  `Note.content`, byte-for-byte, with no HTML conversion and no sanitization
  (consistent with §4: the server never produces HTML).
- **GET is side-effect free** (§7) — download only reads.

### Schemas (informal)

```
Note:
  slug        string
  title       string
  content     string   # Markdown source (no HTML produced server-side)
  created_at  date-time
  updated_at  date-time

NoteSummary (list item):
  slug, title, updated_at, excerpt (string; see below)

NoteList:
  total int
  notes [NoteSummary]

CreateNoteRequest:
  title    string (1..200, required; client may auto-fill it from the first
                   heading, but always sends a value — O-6)
  content  string (0..1000000, optional, default "")
  slug     string (optional; pattern + maxLength 100; auto-generated if absent)

UpdateNoteRequest (all optional; nil = leave unchanged):
  title, content, slug

  - A present `content: ""` clears the body (empty content is valid, per the
    create constraints); only an absent field leaves it unchanged.
  - Any successful PATCH sets `updated_at = now` (UTC), including a slug-only
    change — so renaming a note reorders it in the browse list (`updated_at
    DESC`).
  - A PATCH with no recognized fields (all absent) is rejected as `400`
    (`service.ErrValidation`), not treated as a no-op.

Error: { error: string }
```

The list `excerpt` is a **single string field**, never HTML — see §8. It is one
field for both cases:
- **Browsing (no `q`):** a plain prefix of the source truncated to ~200
  characters at a word boundary, with a trailing `…` when truncated; no markers.
  A note with empty `content` yields an empty `excerpt`.
- **Searching (`q` present):** an FTS5 `snippet()` whose matched terms are
  wrapped in **non-HTML sentinel delimiters** (`U+0002` start, `U+0003` end) that
  cannot occur in normal note text. The client HTML-escapes the entire string,
  then replaces the sentinel pairs with `<mark>…</mark>`. Because escaping
  happens first, the wrapped content is inert; the sentinels are the only thing
  ever turned into markup.

### Constraints (declared in `openapi.yaml`, per template security guidance)

- `title`: `minLength: 1`, `maxLength: 200`. Required. (The editor auto-fills it
  client-side; the server does not derive it.)
- `content`: `maxLength: 1000000` (1,000,000 characters). Worst-case UTF-8 is
  ~4 MiB, comfortably under the 10 MiB request-body cap.
- `slug`: `maxLength: 100`, `pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$'`.
- `q`: `maxLength: 200`.
- `limit`: 1–200, default 50. `offset`: ≥ 0, default 0.

### Status codes

- `201` create, `200` get/update/list/download, `204` delete.
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
  existing `items` client. (There is no `render` call — rendering is local; §4.)

### Views

- **List/search (`/`):** search input (debounced, drives `q`), results show
  title, updated time, plain-text excerpt, and search highlights when searching.
  "New note" button. Empty and loading states.
- **Read (`/notes/{slug}`):** fetches `content`, renders it with the
  markdown-it → DOMPurify pipeline (§4), and injects the sanitized HTML into a
  constrained, styled container. "Edit", "Delete", and "Download Markdown"
  actions. 404 view for missing slugs.
  - **Download Markdown** saves the note's raw source as `<slug>.md`. Preferred
    implementation: navigate/link to `GET /notes/{slug}/download` (the endpoint's
    `Content-Disposition: attachment` triggers the browser save), keeping the
    raw-source path off the JSON `api` client. If routed through `api` instead,
    fetch the `text/markdown` body and save it via a `Blob` + object URL — but
    note `api` (§4, "Frontend networking") is built around JSON parsing, so the
    direct-link form is simpler and avoids buffering large notes in memory.
- **Editor (`/new`, `/notes/{slug}/edit`):**
  - Title input. While untouched, it auto-fills from the first heading in the
    content as the user types (truncated to 200 chars with a trailing `…` if the
    heading is longer); manual edits stop the auto-sync (O-6).
  - Slug field: auto-suggested from title for new notes; shown (and editable
    with a warning) when editing an existing note (O-4 — slugs are mutable; no
    redirects, so the UI warns that the URL will change).
  - **CodeMirror 6** Markdown source editor plus a **live preview** pane rendered
    locally (markdown-it → DOMPurify) on a debounced change of the editor
    contents. Split or toggle layout. No network round-trip for preview.
  - Save (create/update) and Cancel. Unsaved-changes guard covering **both**
    intercepted in-app (pushState) navigations and real browser unload/reload
    (`beforeunload`).
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
   (O-5). Blocks `javascript:`/`vbscript:` URLs. Note that markdown-it's single
   `validateLink` hook fires for both links and images and cannot by itself apply
   a different scheme list to each; the per-element distinction (links forbid
   `data:`, images allow it) is enforced authoritatively by **DOMPurify's URI
   policy** (configured with the same allow-lists, keyed per tag). `validateLink`
   is treated as the coarse first pass, DOMPurify as the precise gate.
3. **DOMPurify (authoritative gate)** — every HTML string is sanitized with
   DOMPurify immediately before any `innerHTML` assignment, in both the read view
   and the editor preview. A single shared helper (e.g.
   `web/ts/util/markdown.ts`) owns the render+sanitize pipeline so no component
   ever injects unsanitized HTML. In application code there is exactly one place
   that assigns note-derived HTML to `innerHTML` (CodeMirror's own internal DOM
   construction is out of scope — it never receives note HTML).
   - **Allow-list:** restrict DOMPurify to the tags markdown-it actually emits
     for the enabled features — block/inline text (`p`, `h1`–`h6`, `ul`/`ol`/`li`,
     `blockquote`, `pre`, `code`, `hr`, `br`, `em`/`strong`/`del`), tables
     (`table`/`thead`/`tbody`/`tr`/`th`/`td`), `a`, and `img`. Allowed attributes:
     `href` (on `a`), `src`/`alt`/`title` (on `img`), `title` (on `a`), and table
     cell `align`. No `<input>` (task lists are out), no `style`, no event-handler
     attributes. The `language-*` `class` that markdown-it emits on fenced
     `<code>` is **not** allowed (stripped): there is **no read-view syntax
     highlighting in v1**. (If highlighting is added later, allow `class` on
     `code`/`pre` at that point — do not add a highlighter expecting the class to
     survive.) URI policy mirrors defense 2 above (links: `http`/`https`/
     `mailto`; images: `https`/`data:`).
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
  covers the 1,000,000-char content limit (≤ ~4 MiB UTF-8).
- **CSRF / auth:** unchanged from the template (CSRF middleware on; optional
  Basic Auth via htpasswd).

> The existing `internal/sanitize` (bluemonday) package is **not** on the note
> write/read path anymore. Either remove it or retain it only as an optional
> server-side raw-HTML strip of the stored source (defense in depth); the primary
> design stores Markdown verbatim and sanitizes client-side. Decide during
> implementation — default: remove, since DOMPurify is the gate.
>
> **Governing-instructions note:** `CLAUDE.md` currently mandates "Sanitize on
> every write path … using `sanitize.HTML`." That rule must be **amended during
> implementation** to carve out the notes-`content` path (which is stored verbatim
> Markdown, gated client-side by DOMPurify), alongside the already-planned
> `CLAUDE.md` Build & Run update for `esbuild` (§6). Otherwise the governing
> instructions directly contradict this spec's central security design.

---

## 8. Persistence (SQLite)

A fresh schema (`schemaV1`) replaces the template's `items` schema. New
databases start at MyNotes v1; this is a template repurpose, not a migration
from `items`. Concretely: `migrations[0]` becomes the MyNotes `schemaV1` (the
`items` migration history is discarded, not preserved), and `PRAGMA
user_version` is driven by this new list from 1. MyNotes targets a **fresh data
directory**; pointing it at a pre-existing template DB that already created
`items` (with `user_version > 0`) is unsupported and out of scope for v1. Future
changes append to `migrations` per the template rule.

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

-- External-content tables require the special 'delete' bookkeeping command on
-- DELETE/UPDATE (a plain DELETE/INSERT mirror corrupts the index). Triggers:
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, content)
    VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, content)
    VALUES ('delete', old.id, old.title, old.content);
END;
CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, content)
    VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO notes_fts(rowid, title, content)
    VALUES (new.id, new.title, new.content);
END;
```

The UPDATE trigger fires on any row change (slug/timestamp-only updates re-sync
harmlessly); this is simpler and safer than `UPDATE OF (title, content)`.

- **Querying:** keep the template's `sanitizeFTSQuery` (quote each token to make
  FTS5 treat user input as literal terms, not operators). An absent `q` **and** a
  present-but-empty/whitespace-only `q` are both treated as "browse" (no search
  filter), not as a query matching nothing.
- **Ranking:** order by FTS5 relevance (`ORDER BY rank`) when `q` is present;
  order by `updated_at DESC` when browsing without a query. In both cases add
  `id DESC` as a secondary key so equal-rank / equal-timestamp rows paginate
  deterministically across `limit`/`offset`.
- **`total`:** `NoteList.total` is the count of rows matching the current request
  (all notes when browsing; matched notes when `q` is present), so the client can
  paginate; it is **not** affected by `limit`/`offset`.
- **Snippets/highlights:** when `q` is present, build the `excerpt` with FTS5
  `snippet()` over the **`content`** column with a budget of ~30 tokens and `…`
  as the leading/trailing ellipsis text, passing the **sentinel** start/end
  strings `U+0002` / `U+0003` (not HTML tags) so matched terms are marked without
  injecting markup. **Title-only matches:** when the query matches only in the
  `title` column, the content snippet is empty; in that case fall back to the
  plain truncated content prefix (the same value used when browsing, no
  sentinels). The title itself is already shown separately as the row heading, so
  no title snippet is produced. When `q` is absent, the `excerpt` is just a
  ~200-character plain-text prefix of the source (no `snippet()`, no sentinels).
  The client escapes the whole string and only then converts sentinel pairs to
  `<mark>` (§5) — markers are never free-form HTML.

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
  `NewError`. No `render` operation. The download operation returns the raw
  Markdown body (`text/markdown`) and sets `Content-Disposition` (§5); it reuses
  the service's get-by-slug, adding no new business logic.
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

1. **API contract** — write `openapi.yaml` for `notes`; regenerate
   Go stubs and TS types.
2. **Persistence** — new schema + FTS triggers in `db.go`; `NoteRepository` with
   tests.
3. **Service** — validation, slug generation/collision; sentinel errors
   (`ErrConflict`); tests. (No rendering.)
4. **Handler** — implement generated interface + error mapping; handler tests.
5. **Vendor bundling** — add the `esbuild` step to `build.sh`; produce
   `vendor/codemirror.js`, `vendor/markdown-it.js`, `vendor/dompurify.js`; wire
   the import map; update `CLAUDE.md` Build & Run (esbuild on `$PATH`).
6. **Frontend** — path router; list/search, read, and editor views; `notes`
   client; CodeMirror editor; shared `util/markdown.ts` render+sanitize helper +
   local live preview.
7. **Hardening pass** — DOMPurify/markdown-it config review, CSP review,
   client-side XSS regression tests, `./build.sh` green (bundle + build + test +
   lint).
