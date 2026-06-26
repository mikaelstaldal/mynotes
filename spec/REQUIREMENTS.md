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

- Real-time collaboration / concurrent multi-user editing.
- Version history / revisions.
- Folders, tags, or hierarchical organization.
- File/image attachments or uploads (referencing remote/inline images is allowed;
  uploading a Markdown file to *create a note* is a client-side convenience, not an
  attachment — the file's text becomes the note body and the file itself is not stored).
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
- A slug may be changed (renamed) on update. Renaming to another note's slug is a
  conflict (409); renaming to the note's own current slug is a no-op. Changing a
  slug changes the note's URL — old links break (no redirects); the UI must warn
  before changing an existing slug.

## Markdown handling

- Content is stored as Markdown source verbatim; it is never converted to or
  served as HTML by the server. All rendering happens in the browser.
- Supported syntax: CommonMark plus GFM tables, strikethrough, and autolinks;
  bare URLs/emails auto-link; images render. Task lists are not supported in v1.
- Both the read view and the editor's live preview render the same way and must
  be safe against XSS (see Security).
- Content is bounded at 1,000,000 characters; empty content is valid.

## REST behavior (user-observable)

The API manages notes keyed by slug. Operations:

- **List/search notes** — optional query `q`, plus paging (`limit`, `offset`).
  Returns a page of summaries (slug, title, updated time, excerpt) and the total
  match count.
  - Absent, empty, or whitespace-only `q` = browse (no filter), ordered most
    recently updated first.
  - Present `q` = full-text search over title and body, ordered by relevance,
    with a match-centred excerpt that highlights matched terms. A match found
    only in the title falls back to a plain content prefix excerpt.
  - `total` reflects all matching rows, independent of the page window. Paging
    past the end returns an empty page, not an error.
- **Create a note** — title (required), content (optional, defaults empty), slug
  (optional, auto-generated if absent). Returns the full created note.
- **Fetch a note** by slug — returns the full note (Markdown content).
- **Update a note** (partial) — any of title, content, slug; absent fields are
  left unchanged. Returns the full updated note. An update that changes nothing
  does not bump the updated timestamp; an update with no recognized fields is an
  error.
- **Delete a note** by slug — deleting an unknown note is a not-found error
  (delete is not idempotent).
- **Download** a note's raw Markdown as a `.md` file (filename derived from slug).
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

Errors use the shape `{ "error": "message" }`. Status codes: 201 create/import; 200
get/update/list/download; 204 delete; 400 validation/malformed input; 404 not
found; 409 conflict on an explicit/renamed slug.

## Frontend behavior

**Two-panel layout:** a persistent left sidebar always shows the full note list;
a right main panel shows the selected note or editor. URLs are real paths
(bookmarkable), not hash routes.

Routes: no-note-selected (`/`), new-note editor (`/new`), read view of a note
(`/notes/{slug}`), and existing-note editor (`/notes/{slug}/edit`).

- **Sidebar (always visible):** debounced search box, results showing title,
  updated time, and excerpt with highlights when searching. Empty and loading
  states. A "Load more" button pages through results (accumulating and
  de-duplicating rows by slug); resets on query change. Shows the total count.
  "New note" and "Upload note" actions. The currently open note is
  highlighted in the list.
- **Upload Markdown or HTML:** pick a single `.md`/`.markdown`/text or
  `.html`/`.htm` file. For Markdown files, the title is derived client-side (first
  heading, else filename without extension, else "Untitled") and the note is created
  via `POST /notes`. For HTML files, the raw HTML is sent to `POST /notes/import-html`
  and the server performs the conversion and title extraction. Oversized files are
  rejected before/from the server with a clear message.
- **Read view (main panel):** renders the note's Markdown safely into a styled
  container. The stored title is used as the browser tab title (not duplicated as
  a body heading). "Edit", "Delete", and "Download Markdown" actions. A 404 (or a
  malformed-slug deep link) shows a not-found message.
- **Editor (main panel, new/edit):** title input (with auto-derive-from-heading
  until edited); slug field (suggested for new notes, editable-with-warning when
  editing); a Markdown source editor with a live local preview; a "Link to note"
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

## Security (user-facing guarantees)

- The app must not execute scripts or active content embedded in note bodies;
  rendered notes are sanitized so untrusted content cannot run code.
- Embedded HTML in notes is allowed only for a safe set of tags/attributes; only
  `http`/`https`/`mailto` link schemes and `https`/safe-`data:` image sources are
  permitted; unsafe HTML/schemes cause a write to be rejected.
- The whole app may be gated behind optional HTTP Basic Auth. GET requests never
  modify data.
