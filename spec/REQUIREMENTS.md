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
  happens in the browser. The server converts Markdown to HTML (including
  AsciiMath → MathML) only for the download-html endpoint.
- Supported syntax: CommonMark plus GFM tables, strikethrough, task lists, and
  autolinks; bare URLs/emails auto-link; images render. Task-list markers
  (`- [ ]` / `- [x]`) render as disabled (read-only) checkboxes.
- Inline SVG and MathML embedded directly in Markdown HTML blocks are allowed;
  scripts, event handlers, `<foreignObject>`, `<use>`, `<style>`, and other
  unsafe constructs are rejected at write time.
- **Math (AsciiMath):** [AsciiMath](https://asciimath.org) written between single
  dollars (`$x^2$`) renders as inline MathML and between double dollars
  (`$$…$$`, either inline or as a multi-line block) as display MathML. A literal
  dollar is written `\$`; a `$` that is not part of a valid pair (e.g. currency
  like `$5`) stays literal. The AsciiMath source is stored verbatim in the
  Markdown. In the browser read view it is converted to MathML by the vendored
  `asciimath2ml` library (not MathJax), with the generated `<math>` passing
  through the same DOMPurify sanitization gate as all other rendered HTML. The
  server's download-html endpoint performs the same conversion with a Go port of
  that library (`internal/asciimath`), so a downloaded document — whether from
  the web UI's "Download HTML" button or a direct API consumer such as the
  Android app — contains the same MathML as the on-screen view. The generated
  `<math>` passes through the server's bluemonday sanitize pass (whose allow-list
  already covers the MathML element/attribute set). The editor toolbar has a math
  button that wraps the selection in `$…$`.
- **Wikilinks:** the non-standard `[[…]]` syntax links to another note or a tag's
  note list. `[[slug]]` links to a note (`/notes/{slug}`); `[[#slug]]` (with a `#`
  sigil) links to a tag's note list (`/tags/{slug}`). `[[slug|Display text]]` (or
  `[[#slug|Display text]]`) overrides the shown text; the default is the `slug`
  itself (tag links prefix it with `#`). `slug` must match the slug pattern
  (`^[a-z0-9]+(?:-[a-z0-9]+)*$`); anything else is left as literal text. This is a
  client render-time transform only — the reference is stored verbatim in the
  Markdown, is not validated against existing notes/tags (a link to a non-existent
  note 404s when followed; a link to a non-existent tag simply lists no notes),
  and the `[[`/`]]` delimiters do not collide with CommonMark, raw HTML, SVG, or
  MathML. The editor offers toolbar buttons to insert a note link or a tag link;
  each opens a picker that autocompletes by case-insensitive prefix match on the
  note title / tag slug.
- The editor toolbar has an emoji button that opens a picker over the full
  Unicode emoji set (from the vendored `emojibase-data`), browsable by category
  and searchable by name/keyword; selecting one inserts the character at the
  cursor.
- Both the read view and the editor's live preview render the same way and must
  be safe against XSS (see Security).
- Content is bounded at 1,000,000 characters; empty content is valid.
- **Split by headings:** a note can be split into several new notes, one per
  section delimited by Markdown ATX headings at the shallowest level present
  (e.g. if a note's headings are `##`/`###`, it splits at each `##`, keeping the
  `###` subsections nested inside their parent section). Headings inside fenced
  code blocks are ignored. Content before the first such heading (the preamble)
  is discarded. Each new note takes its title from its section heading and shares
  the source note's created and updated times; the source note is left unchanged.
  An optional tag (which must already exist) is attached to every new note. A note
  with no headings cannot be split.

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

A tag is identified solely by a unique, URL-safe **slug** (same character rules
as note slugs: lowercase ASCII letters, digits, and hyphens, 1–100 characters),
which also serves as its display label.

- **Tags are created explicitly**, via their own API call, before they can be
  attached to a note — a note write never silently creates a new tag.
  Referencing an unknown tag slug on a note create/update is a validation
  error (400).
- A tag is created by supplying its slug directly. A slug that collides with an
  existing tag is an error (409), never silently suffixed.
- Deleting a tag detaches it from every note that had it; there is no
  orphan-prevention (mirrors artifact deletion).
- Notes reference tags by slug in create/update requests; `Note` and
  `NoteSummary` API responses embed the full tag (slug) so the client does not
  need extra round-trips to display them.
- Notes can be listed filtered to a single tag (by slug), combinable with a
  full-text search query.

## REST behavior (user-observable)

The API manages notes keyed by slug. Operations:

- **List/search notes** — optional query `q`, an optional `tag` filter (by
  tag slug, combinable with `q`), an optional `titlePrefix` flag, optional
  `sort`/`order` for the browse list, plus paging (`limit`, `offset`).
  Returns a page of summaries (slug, title, updated time, excerpt, tags) and
  the total match count.
  - Absent, empty, or whitespace-only `q` = browse (no filter), ordered by the
    `sort` field (`updated` default, `created`, or `title` case-insensitive)
    and `order` direction (`desc` default, or `asc`). `sort`/`order` apply only
    to browse; they are ignored for full-text search (relevance-ordered) and
    for `titlePrefix` matching (title-ordered).
  - Present `q` = full-text search over title and body, ordered by relevance,
    with a match-centred excerpt that highlights matched terms. A match found
    only in the title falls back to a plain content prefix excerpt.
  - `titlePrefix` (default false) matches `q` as a case-insensitive prefix of
    the note title (autocomplete style, ordered by title) instead of a
    full-text search; body content is not matched. Ignored when `q` is empty.
    Used by the web UI's internal-link picker.
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
- **Split a note** — `POST /notes/{slug}/split` creates one new note per
  top-level heading section of the source note (see "Split by headings" under
  Markdown handling). An optional request body `{ "tag": "<slug>" }` attaches an
  existing tag to every new note (an unknown tag is a validation error). Returns
  summaries (not full content) of the created notes in document order
  (`{ "notes": [ … ] }`). A note with no headings is a validation error. The
  source note is left unchanged.
- **Download Markdown** — `GET /notes/{slug}/download-markdown` returns the raw Markdown as a `.md` file (filename derived from slug).
- **Download HTML** — `GET /notes/{slug}/download-html` converts the note to HTML on the server and returns a complete HTML document as a `.html` file. Internal artifact image references (`![alt](/api/v1/artifacts/{sha256})`) are inlined so the downloaded document renders standalone, without a live server: bitmap artifacts (PNG, JPEG, GIF, WebP) up to 16 MiB become base64 `data:` URLs, while SVG and MathML artifacts are spliced in as inline `<svg>`/`<math>` elements (a `data:` URL for SVG is disallowed by the sanitize policy). A bitmap artifact larger than 16 MiB is replaced by an inline broken-image icon (SVG) rather than embedded, to keep exported documents from ballooning. The spliced markup passes through the same render-time sanitization as the rest of the document. Unknown or unresolvable references are left as-is. AsciiMath (`$…$` / `$$…$$`) is converted to MathML by the server's Go port of `asciimath2ml` (`internal/asciimath`), so the exported document contains the same math markup as the on-screen view. The **web UI's "Download HTML" button** is a plain link to this endpoint (like Download Markdown).
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

Errors use the shape `{ "error": "message" }`. Status codes: 201
create/import/split; 200 get/update/list/download; 204 delete; 400
validation/malformed input; 404 not found; 409 conflict on an explicit slug;
412 version mismatch on update.

## Frontend behavior

**Two-panel layout:** a persistent left sidebar always shows the full note list;
a right main panel shows the selected note or editor. URLs are real paths
(bookmarkable), not hash routes.

Routes: no-note-selected (`/`), tag-filtered note list (`/tags/{slug}`),
new-note editor (`/new`), read view of a note (`/notes/{slug}`), and
existing-note editor (`/notes/{slug}/edit`).

- **Sidebar (always visible):** debounced search box, results showing title,
  updated time, excerpt with highlights when searching, and tags. A sort
  dropdown selects the browse order — by updated time, created time, or title,
  each ascending or descending; the choice is persisted (localStorage) and
  drives both the sidebar and the main-panel overview. It has no effect while a
  search query is active (results stay relevance-ordered). A tag
  filter dropdown lists every tag that exists (not just tags visible in the
  currently loaded notes), so a tag can be selected to filter even when no
  matching note is currently on screen; selecting "All tags" clears the
  filter. While a tag is selected, a "Remove tag" button beside the dropdown
  deletes that tag (after a confirmation): the tag is detached from every note
  that carried it — the notes themselves are kept — and the filter is then
  cleared. Empty and
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
- **Overview (main panel, no note selected):** shown for `/` and
  `/tags/{slug}`. A heading ("All notes", or the tag slug when filtered) over a
  list of every note (or every note carrying the active tag), each row showing
  title, created/updated times, excerpt, and tags, ordered by the shared sort
  choice and paged with "Load more". Each row carries the same per-note action
  toolbar as the read view — "Download Markdown", "Download HTML", "Print",
  "Split", "Edit", and "Delete" — acting on that row's note; delete and split
  refresh the lists in place. Falls back to a "select or create a note" prompt
  only when the list is genuinely empty.
- **Read view (main panel):** renders the note's Markdown safely into a styled
  container. The stored title is used as the browser tab title (not duplicated as
  a body heading). The note's tags are shown as chips; clicking one filters the
  sidebar list to that tag. "Edit", "Delete", "Split", "Print", "Download
  Markdown", and "Download HTML" actions. "Split" opens a dialog with a tag
  picker (the same autocomplete-or-create widget as the editor) to optionally
  choose or create a single tag, then splits the note by its top-level headings
  and navigates to the tag's note list (when a tag was chosen) or the first new
  note. A 404 (or a malformed-slug deep link) shows a not-found message.
- **Editor (main panel, new/edit):** title input (with auto-derive-from-heading
  until edited); slug field (suggested for new notes, editable-with-warning when
  editing); a tag picker (autocomplete over existing tags, plus an explicit
  "create tag" action — deriving a slug from the typed text — for a slug with no
  match, nudging toward reusing existing tags over creating near-duplicates); a
  Markdown source editor with a
  live local preview; a "Link to note"
  picker that searches notes by title (not body content) and inserts a Markdown
  link to the chosen note's stable URL; Save and Cancel.
  - Cancel returns to the note's read view (when editing) or the list (when new),
    computed from the route, and is subject to the unsaved-changes guard.
  - An unsaved-changes guard covers both in-app navigation and browser
    unload/reload. "Dirty" is a value comparison against the last-saved snapshot
    (reverting to saved values clears dirty).
  - The in-progress edit is auto-saved to browser Local Storage every 30 seconds
    while dirty, whenever the page is unloaded or the tab is hidden
    (`beforeunload`/`visibilitychange`), and once more right before submitting to
    the backend, so unsaved work survives an unexpected browser close. The stored
    draft is cleared only
    after the backend confirms the save. On reopening the editor (keyed by note
    slug, or a single shared bucket for a new note), if a stored draft differs
    from the loaded/blank baseline the user is offered a one-time prompt to
    restore it.
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

- A handful of **tags** (e.g. `getting-started`, `reference`, `personal`,
  `work`, `recipes`, `travel`).
- A few **artifacts** — generated images (PNG) and an inline SVG logo — stored
  through the normal artifact pipeline so they are content-addressed and
  content-validated.
- Several **notes** that between them exercise the supported Markdown features:
  headings, emphasis, strikethrough, ordered/nested lists, task lists, tables,
  fenced code, blockquotes, horizontal rules, autolinks, inter-note links, embedded images
  (referencing the seeded artifacts), and inline SVG and MathML. Each note
  carries one or more of the seeded tags.

### Validation and behavior

Demo content is written through the same service layer (and therefore the same
validation) as any note, tag, or artifact created via the REST API. The demo
tags use fixed slugs, so seeding is intended for a fresh or throwaway database:
re-running the command against a database that already holds the demo tags fails
on the duplicate-slug conflict. Progress is printed to stdout; exit code is 0 on
success.

## Security (user-facing guarantees)

- The app must not execute scripts or active content embedded in note bodies;
  rendered notes are sanitized so untrusted content cannot run code.
- Embedded HTML in notes is allowed only for a safe set of tags/attributes; only
  `http`/`https`/`mailto` link schemes and `https`/safe-`data:` image sources are
  permitted; unsafe HTML/schemes cause a write to be rejected.
- The whole app may be gated behind optional HTTP Basic Auth. GET requests never
  modify data.
