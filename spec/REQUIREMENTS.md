# MyNotes — Functional Requirements

MyNotes is a single-user, personal note manager. It stores a collection of
documents written in Markdown (CommonMark), each reachable at a stable,
slug-based URL, with a web-based editor and full-text search.

This document captures *what* the product must do, independent of how it is
built. Implementation choices live in `ARCHITECTURE.md`; the build plan lives in
`TASKS.md`.

## Scope

- Manage a personal collection of Markdown documents ("notes").
- Each note has a human-readable slug producing a stable, bookmarkable URL.
- A browser-based Markdown editor with live preview.
- Full-text search across all notes (titles + body).
- Single-user / personal tool. An optional whole-app HTTP Basic Auth is the only
  access control; there is no per-note ownership, sharing, or public-read path.

### Non-goals (v1)

- Real-time collaboration / concurrent multi-user editing (beyond simple optimistic locking).
- Version history / revisions (beyond version number).
- Folders or hierarchical organization (tags are supported — see below).
- Any public publishing workflow beyond the stable URL existing.

## Domain — a Note

A note has: a unique URL-safe **slug**, a display **title**, a Markdown
**content** body, and **created**/**updated** timestamps. An internal numeric
identity exists but is never exposed as the URL key.

### Title

- Title is mandatory (1–200 characters) and is always supplied by the client.
- As an editor/upload convenience the title may be auto-derived from the first
  heading of the content, but the rules below are user-facing behavior:
  - It tracks the first heading while the user has not manually edited the title;
    once edited by hand, auto-sync stops and the manual value is never clobbered.
  - "First heading" means the first ATX heading (`#`…`######` followed by text).
    Setext headings are not recognized. Headings inside fenced code blocks are
    ignored. Empty-text headings are skipped. An unclosed code fence runs to end
    of input.
  - A derived title longer than 200 characters is truncated (with a trailing `…`)
    so a save never fails for a title the user never typed.
  - If no usable heading exists, no title is derived (the editor leaves the field
    for the user; the upload flow falls back to the filename — see Upload).

### Slug

- Allowed characters: lowercase ASCII letters, digits, and hyphens (no leading,
  trailing, or doubled hyphens). Length 1–100.
- If the client does not supply a slug on create, one is derived from the title
  (lowercase, accents folded, non-ASCII dropped, non-alphanumerics collapsed to
  hyphens, trimmed, length-bounded). A title that folds to nothing yields the
  fallback slug `note`.
- Slugs are unique:
  - Auto-generated slug, on collision: the system silently appends `-2`, `-3`, …
    until free. Concurrent double-submits never surface a spurious error.
  - Explicit (client-supplied) slug, on collision: it is an error (409), never
    silently suffixed.

## Markdown handling

- Content is stored as Markdown source verbatim; rendering for the read view
  happens in the browser. The server converts Markdown to HTML only for the
  download-html endpoint.
- Supported syntax: CommonMark plus GFM tables, strikethrough, and autolinks;
  bare URLs/emails auto-link; images render. Task lists are not supported in v1.
- Inline SVG and MathML embedded directly in Markdown HTML blocks are allowed;
  scripts, event handlers, `<foreignObject>`, `<use>`, `<style>`, and other
  unsafe constructs are rejected at write time.
- **Tag links:** the non-standard syntax `[[#slug]]` links to a tag's note list
  (`/tags/{slug}`); `[[#slug|Display text]]` overrides the shown text (default is
  `#slug`). `slug` must match the tag-slug pattern (`^[a-z0-9]+(?:-[a-z0-9]+)*$`);
  anything else is left as literal text. This is a client render-time transform
  only — the reference is stored verbatim in the Markdown, is not validated
  against existing tags (a link to a non-existent tag simply lists no notes), and
  the `[[`/`]]` delimiters do not collide with CommonMark, raw HTML, SVG, or
  MathML. The editor offers a toolbar button to insert one from the tag list.
- Both the read view and the editor's live preview render the same way and must
  be safe against XSS (see Security).
- Content is bounded at 1,000,000 characters; empty content is valid.

## Artifacts

Binary content (images and other files) may be stored as artifacts and referenced in notes. Artifacts are content-addressed: the SHA-256 of the content is used as the identifier and in the URL, so uploading the same bytes twice returns the existing record unchanged.

### Artifact API

- **Upload an artifact** — `POST /api/v1/artifacts` with a binary body and one of the accepted `Content-Type` values (`image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/svg+xml`, `application/mathml+xml`). Returns `{ sha256, content_type, created_at }`.
- **Fetch an artifact** — `GET /api/v1/artifacts/{sha256}` returns the raw binary body with the original `Content-Type` header and `Cache-Control: immutable`.
- **Delete an artifact** — `DELETE /api/v1/artifacts/{sha256}` removes the artifact (404 if absent).

### Artifact storage

Artifacts are stored as BLOBs in the same SQLite database as notes, in a separate `artifacts` table. There is no automatic garbage collection of artifacts no longer referenced by any note.

### Image embedding in the editor

The "embed image" toolbar button in the note editor uploads the selected file as an artifact and inserts a standard Markdown image reference `![alt](/api/v1/artifacts/{sha256})` at the cursor. SVG and MathML files continue to be embedded inline as before. There is no hard file-size limit on upload (the global 10 MiB request body cap applies).

## Tags

Notes may be categorized with tags in a many-to-many relationship: a note can
carry any number of tags, and a tag can be attached to any number of notes.

A tag has a **name** (1–100 characters) and a unique, URL-safe **slug**
(same character rules as note slugs: lowercase ASCII letters, digits, and
hyphens, 1–100 characters).

- **Tags are created explicitly**, via their own API call, before they can be
  attached to a note — a note write never silently creates a new tag.
  Referencing an unknown tag slug on a note create/update is a validation
  error (400).
- If the client does not supply a slug when creating a tag, one is derived
  from the name using the same rules as note slug derivation, auto-suffixed
  on collision. An explicit slug that collides with an existing tag is an
  error (409), never silently suffixed.
- Deleting a tag detaches it from every note that had it; there is no
  orphan-prevention (mirrors artifact deletion).
- Notes reference tags by slug in create/update requests; `Note` and
  `NoteSummary` API responses embed the full tag (slug + name) so the client
  does not need extra round-trips to display them.
- Notes can be listed filtered to a single tag (by slug), combinable with a
  full-text search query.

## REST behavior (user-observable)

The API manages notes keyed by slug. Operations:

- **List/search notes** — optional query `q`, an optional `tag` filter (by
  tag slug, combinable with `q`), plus paging (`limit`, `offset`).
  Returns a page of summaries (slug, title, updated time, excerpt, tags) and
  the total match count.
  - Absent, empty, or whitespace-only `q` = browse (no filter), ordered most
    recently updated first.
  - Present `q` = full-text search over title and body, ordered by relevance,
    with a match-centred excerpt that highlights matched terms. A match found
    only in the title falls back to a plain content prefix excerpt.
  - Present `tag` restricts results to notes carrying that tag; an unknown
    tag slug simply matches no notes (not an error).
  - `total` reflects all matching rows, independent of the page window. Paging
    past the end returns an empty page, not an error.
- **Create a note** — title (required), content (optional, defaults empty), slug
  (optional, auto-generated if absent), tags (optional array of existing tag
  slugs, defaults to none — an unknown slug is a validation error). Returns
  the full created note.
- **Fetch a note** by slug — returns the full note (Markdown content, tags),
  plus a `version` integer and an `ETag` response header quoting the version
  (e.g. `"1"`).
- **Update a note** (partial) — any of title, content, tags; absent fields are
  left unchanged. Returns the full updated note. An update that changes nothing
  does not bump the updated timestamp or version — this includes replacing
  `tags` with the same set the note already has. A present `tags` array
  (including an empty one) replaces the note's full tag set; an unknown slug
  is a validation error. An update with no recognized fields is an error.
  Supports optimistic locking via the `If-Match` request
  header: if provided, the update is rejected with 412 Precondition Failed when
  the note's current version does not match. The response includes the new
  `version` and `ETag`.
- **Delete a note** by slug — deleting an unknown note is a not-found error
  (delete is not idempotent).
- **Download Markdown** — `GET /notes/{slug}/download-markdown` returns the raw Markdown as a `.md` file (filename derived from slug).
- **Download HTML** — `GET /notes/{slug}/download-html` converts the note to HTML on the server and returns a complete HTML document as a `.html` file.
- **Import HTML** — `POST /import-html` accepts a `text/html` request body
  and converts it to Markdown server-side. The title is taken from the HTML
  `<title>` element; if absent, the plain text of the first `h1`–`h6` element is
  used; if that is also absent, the first ATX heading in the produced Markdown is
  used. Tags with Markdown equivalents (headings, emphasis, links, images, lists,
  tables, code, blockquote, etc.) are converted to Markdown syntax; tags allowed by
  the sanitization policy but with no Markdown equivalent are kept as raw HTML;
  other tags have their tags stripped while preserving text content; `<script>`,
  `<style>`, and similar non-content elements are removed entirely. The produced
  Markdown is subject to the same validation as regular note creation (401 on auth
  failure, 400 on invalid content, 409 on slug conflict).

Notes also expose a monotonically increasing `version` integer (1 on creation,
+1 per write, no-op PATCHes do not increment it) in all response bodies
(`Note` and `NoteSummary`).

Errors use the shape `{ "error": "message" }`. Status codes: 201 create/import;
200 get/update/list/download; 204 delete; 400 validation/malformed input; 404 not
found; 409 conflict on an explicit slug; 412 version mismatch on update.

## Frontend behavior

**Two-panel layout:** a persistent left sidebar always shows the full note list;
a right main panel shows the selected note or editor. URLs are real paths
(bookmarkable), not hash routes.

Routes: no-note-selected (`/`), tag-filtered note list (`/tags/{slug}`),
new-note editor (`/new`), read view of a note (`/notes/{slug}`), and
existing-note editor (`/notes/{slug}/edit`).

- **Sidebar (always visible):** debounced search box, results showing title,
  updated time, excerpt with highlights when searching, and tags. A tag
  filter dropdown lists every tag that exists (not just tags visible in the
  currently loaded notes), so a tag can be selected to filter even when no
  matching note is currently on screen; selecting "All tags" clears the
  filter. Empty and
  loading states. A "Load more" button pages through results (accumulating and
  de-duplicating rows by slug); resets on query or tag-filter change. Shows
  the total count. "New note" and "Upload note" actions. The currently open
  note is highlighted in the list.
- **Upload Markdown or HTML:** pick a single `.md`/`.markdown`/text or
  `.html`/`.htm` file. For Markdown files, the title is derived client-side (first
  heading, else filename without extension, else "Untitled") and the note is created
  via `POST /notes`. For HTML files, the raw HTML is sent to `POST /notes/import-html`
  and the server performs the conversion and title extraction. Oversized files are
  rejected before/from the server with a clear message.
- **Read view (main panel):** renders the note's Markdown safely into a styled
  container. The stored title is used as the browser tab title (not duplicated as
  a body heading). The note's tags are shown as chips; clicking one filters the
  sidebar list to that tag. "Edit", "Delete", "Download Markdown", and "Download
  HTML" actions. A 404 (or a
  malformed-slug deep link) shows a not-found message.
- **Editor (main panel, new/edit):** title input (with auto-derive-from-heading
  until edited); slug field (suggested for new notes, editable-with-warning when
  editing); a tag picker (autocomplete over existing tags, plus an explicit
  "create tag" action for a name with no match — nudging toward reusing
  existing tags over creating near-duplicates); a Markdown source editor with a
  live local preview; a "Link to note"
  picker that searches notes and inserts a Markdown link to the chosen note's
  stable URL; Save and Cancel.
  - Cancel returns to the note's read view (when editing) or the list (when new),
    computed from the route, and is subject to the unsaved-changes guard.
  - An unsaved-changes guard covers both in-app navigation and browser
    unload/reload. "Dirty" is a value comparison against the last-saved snapshot
    (reverting to saved values clears dirty).
  - On successful save, navigate to the saved note's read view using the slug
    from the response (which may have been auto-generated, suffixed, or renamed).
  - A 404 on save/delete from a stale tab shows a toast and navigates to the
    list. A slug conflict (409) shows the server's error message as a toast.
- Errors are surfaced through a toast component.

## Google Docs Bulk Import

A one-shot batch mode that imports all owned Google Docs as notes into the same
SQLite database the server uses.

### Invocation

```
./mynotes -gdocs-client-id=<CLIENT_ID> -gdocs-client-secret=<CLIENT_SECRET> [-data <dir>]
```

When both `-gdocs-client-id` and `-gdocs-client-secret` are present the binary
runs the importer instead of starting the HTTP server.  All other flags
(`-port`, `-addr`, `-public-url`, etc.) are ignored; `-data` controls both the
database path and the stored token location.

### Setup (one time)

1. Create a Google Cloud project; enable the **Drive API**.
2. Create **Desktop App** OAuth 2.0 credentials (not Web Application — Desktop
   App allows any `http://localhost` port without registering exact redirect
   URIs).
3. Note the Client ID and Client Secret.

### First run — authentication

On the first run a browser opens to the Google OAuth consent screen.  After the
user approves, the token (including a refresh token) is saved to
`<data>/gdocs-token.json` (mode 0600).  Subsequent runs use the stored token and
refresh it automatically without any user interaction.

### What is imported

- **Owned** Google Docs only (`'me' in owners`).
- **Google Docs** only (`mimeType = 'application/vnd.google-apps.document'`);
  Sheets, Slides, Forms, and other file types are excluded.
- Non-trashed documents only.
- All pages are fetched automatically (Drive API pagination).

### Export and conversion

Each document is exported via the Drive API:

1. Markdown (`text/markdown`) is tried first.
2. If the Markdown export fails (e.g., HTTP error), HTML (`text/html`) is fetched
   and converted to Markdown using the same HTML→Markdown converter used by the
   import-HTML endpoint.

The document title and creation date are read from the Drive API metadata and
injected as YAML frontmatter, so the existing import service preserves them
correctly.

### Validation and error handling

Imported content passes through the same validation pipeline as any note created
via the REST API.  A document whose content fails validation (e.g., disallowed
embedded HTML) is skipped with an error message; the remaining documents continue
importing.

Re-running the importer creates new notes (with auto-suffixed slugs) for
documents that were already imported.  There is no deduplication — the command is
intended as a one-shot migration.

### Output

Progress is printed to stdout:

```
Listing Google Docs...
Found 42 document(s). Importing...
  ✓ My First Note → /notes/my-first-note
  ✗ Problematic Doc: content validation error: …
  …
Imported 41 note(s). 1 failed:
  - Problematic Doc: content validation error: …
```

Exit code is 0 on full success, 1 if any document failed to import.

## Demo Data

A one-shot batch mode that fills the database with a curated set of notes,
tags, and artifacts so a fresh install can showcase the product's features
without manual data entry.

### Invocation

```
./mynotes -demo [-data <dir>]
```

When `-demo` is present the binary seeds the database and exits instead of
starting the HTTP server. All other flags except `-data` (which controls the
database path) are ignored. The database is created if it does not yet exist.

### What is seeded

- A handful of **tags** (e.g. Getting Started, Reference, Personal, Work,
  Recipes, Travel).
- A few **artifacts** — generated images (PNG) and an inline SVG logo — stored
  through the normal artifact pipeline so they are content-addressed and
  content-validated.
- Several **notes** that between them exercise the supported Markdown features:
  headings, emphasis, strikethrough, ordered/nested lists, tables, fenced code,
  blockquotes, horizontal rules, autolinks, inter-note links, embedded images
  (referencing the seeded artifacts), and inline SVG and MathML. Each note
  carries one or more of the seeded tags.

### Validation and behavior

Demo content is written through the same service layer (and therefore the same
validation) as any note, tag, or artifact created via the REST API. Seeding is
additive and not deduplicated: re-running the command adds another copy of the
demo data (tags get auto-suffixed slugs, notes get auto-suffixed slugs), so it
is intended for a fresh or throwaway database. Progress is printed to stdout;
exit code is 0 on success.

## Security (user-facing guarantees)

- The app must not execute scripts or active content embedded in note bodies;
  rendered notes are sanitized so untrusted content cannot run code.
- Embedded HTML in notes is allowed only for a safe set of tags/attributes; only
  `http`/`https`/`mailto` link schemes and `https`/safe-`data:` image sources are
  permitted; unsafe HTML/schemes cause a write to be rejected.
- The whole app may be gated behind optional HTTP Basic Auth. GET requests never
  modify data.
