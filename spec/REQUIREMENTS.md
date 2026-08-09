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

- Content is stored as Markdown source verbatim; all rendering to HTML (read
  view, editor preview, and the Download HTML / print export) happens in the
  browser. The server never converts Markdown to HTML.
- Supported syntax: CommonMark plus GFM tables, strikethrough, task lists, and
  autolinks; bare URLs/emails auto-link; images render. Task-list markers
  (`- [ ]` / `- [x]`) render as checkboxes: clickable in the web UI's read view
  and editor preview (see §Frontend behavior, **Clickable task items**), and
  disabled everywhere else — the Download HTML / print document, the email body,
  and the shared render kit.
- **Subscript and superscript:** the Pandoc form — `H~2~O` renders as
  `H<sub>2</sub>O` and `2^10^` as `2<sup>10</sup>`. As in Pandoc, the text
  between the delimiters may not contain unescaped whitespace, so ordinary prose
  using a lone `~` or `^` stays literal; a space is written `\ ` and a literal
  delimiter `\~` / `\^`. The content is parsed as inline Markdown, so the two
  nest (`x^y~z~^`). A delimiter that belongs to another inline construct (a code
  span, an inline math span) does not close the sub/superscript, and a `~~…~~`
  pair is strikethrough. The editor toolbar has subscript and superscript
  buttons that wrap the selection in `~…~` / `^…^`.
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
  web UI's Download HTML / print export reuses that same render pipeline, so an
  exported document contains the same MathML as the on-screen view. A native
  client gets the transform from the shared render kit (see **Shared render
  kit**); a consumer that passes `content` through unchanged receives the
  literal `$…$` source. The editor toolbar has a math button that wraps the
  selection in `$…$`.
- **Mermaid diagrams:** a fenced code block with the `mermaid` info string
  (```` ```mermaid ````, the Obsidian convention) renders as a diagram
  (flowchart, sequence, etc.). The diagram source is stored verbatim in the
  Markdown. This is a **client render-time feature**: the vendored
  [Mermaid](https://mermaid.js.org/) library (lazy-loaded on first use)
  converts the block to SVG in the browser read view and editor preview,
  following the light/dark theme, with Mermaid's `securityLevel: 'strict'`
  plus a dedicated DOMPurify pass sanitizing the output. A malformed diagram
  falls back to showing its source. The web UI's Download HTML / print export
  renders diagrams too (it reuses the same browser render pipeline), so exported
  documents contain the rendered SVG. The editor
  toolbar has a button that inserts a starter `mermaid` block.
- **Inline icons:** `[!name]` anywhere renders a Lucide icon inline. `name` is
  any vendored Lucide icon, or one of the callout **aliases** below (which
  resolve to their icon). An unrecognized name is left as literal text. The
  explicit `[!lucide-name]` form forces the literal Lucide icon with no alias
  lookup and no colour/callout semantics (e.g. `[!lucide-summary]`); the icon
  picker inserts this form.
- **Box / foldable blockquotes:** a single marker character immediately after the
  first `>` of a blockquote turns it into a callout-style box — `>-` a collapsed
  foldable box, `>+` an expanded foldable box, `>*` a static box. Every box uses
  its first line as the title (foldable boxes render as native
  `<details>`/`<summary>`); a box with no alias uses the default (gray) accent.
- **Callouts:** the [Obsidian callout](https://obsidian.md/help/callouts) syntax,
  composed from the two blocks above — a blockquote whose first line starts with
  an `[!alias]` renders as a styled admonition (the alias icon, its colour accent,
  and a title row above the body; the title is optional and defaults to the
  capitalized alias name). Fold a callout with the `>-`/`>+` markers, or the
  Obsidian `[!alias]-` / `[!alias]+` form. The aliases follow Obsidian (note,
  info, todo, tip/hint/important, success/check/done, question/help/faq,
  warning/caution/attention, failure/fail/missing, danger/error, bug,
  abstract/summary/tldr, example, quote/cite), each mapped to a Lucide icon and a
  colour family (blue, green, cyan, amber, red, gray). An `[!alias]` at the start
  of **any** paragraph (not just a blockquote) tints that paragraph's text and
  icon with the alias colour. All of the above is a **client render-time
  feature**: content is stored verbatim (the literal `[!alias]`, `>-`, etc.), so
  it passes the server's structural validation unchanged and needs no new
  stored-content format. Rendering reuses the same markdown-it → DOMPurify
  pipeline as the rest of the read view, editor preview, and Download HTML / print
  export. A consumer that does not run that pipeline (see **Shared render kit**)
  receives the literal Markdown.
- **Emoji shortcodes:** `:shortcode:` renders as the corresponding raw Unicode emoji
  (e.g. `:rocket:` → 🚀, `:+1:` → 👍), where `shortcode` is a GitHub-compatible
  shortcode (the GitHub shortcode set from the vendored `emojibase-data`). An
  unrecognized `:shortcode:` is left as literal text, so ordinary colon use (`12:30`)
  is unaffected, and the transform does not run inside code spans or fences. Like
  the icon/callout features this is a **client render-time transform**: the
  literal `:shortcode:` is stored verbatim in `content`, so a consumer that does
  not run the render pipeline receives the literal source. The editor's emoji
  picker inserts this `:shortcode:` form.
- **Wikilinks:** the non-standard `[[…]]` syntax links to another note or a tag's
  note list. `[[slug]]` links to a note (`/notes/{slug}`); `[[#slug]]` (with a `#`
  sigil) links to a tag's note list (`/tags/{slug}`). `[[slug|Display text]]` (or
  `[[#slug|Display text]]`) overrides the shown text; the default is the `slug`
  itself (tag links prefix it with `#`). `slug` must match the slug pattern
  (`^[a-z0-9]+(?:-[a-z0-9]+)*$`); anything else is left as literal text. This is a
  client render-time transform only — the reference is stored verbatim in the
  Markdown and is not validated against existing notes/tags (following a link to a
  non-existent note or tag creates it — see the routing section for the note-editor
  and tag auto-create behaviour), and the `[[`/`]]` delimiters do not collide with
  CommonMark, raw HTML, SVG, or
  MathML. The editor offers toolbar buttons to insert a note link or a tag link;
  each opens a picker that autocompletes by case-insensitive prefix match on the
  note title / tag slug.
- **Link index / backlinks:** note wikilinks (not tag links) are additionally
  indexed server-side. Each note's content is parsed for `[[slug]]` note links
  whenever the note is created or updated, and the resulting edges are stored in
  a `note_links` table (source note → target slug). Extraction matches the
  renderer: a `[[slug]]` inside a code span or code block is not a link and is
  not indexed. The `Note` and `NoteSummary` API responses expose the graph as
  `outgoing_links` (notes this note links to, resolved to existing notes only —
  dangling links to non-existent notes are omitted) and `incoming_links`
  (backlinks — notes that link to this note); each entry is a `{slug, title}`
  pair. Link titles and existence are resolved at read time, so creating a
  previously-missing target, renaming, or deleting a note updates the links of
  every note that references it without re-indexing. Existing notes are indexed
  once by a one-time backfill when the database is upgraded to the schema
  version that introduces `note_links`. The web note view renders `incoming_links`
  as a "Linked from" backlinks section below the content (outgoing links already
  appear inline as rendered wikilinks).
- The editor toolbar has an emoji button that opens a picker over the full
  Unicode emoji set (from the vendored `emojibase-data`), browsable by category
  and searchable by name/keyword/shortcode; selecting one inserts its `:name:`
  shortcode (the emoji-shortcode render-time transform above) at the cursor,
  falling back to the raw character for the rare emoji with no shortcode.
- The editor toolbar has an icon button that opens a picker over the full Lucide
  icon set (from the vendored `lucide-static`), searchable by name/keyword;
  selecting one inserts a Markdown image reference to the server's icon endpoint,
  `![<name>](<base>/api/v1/icons/lucide/<name>)`, at the cursor — keeping note content
  compact rather than embedding the full SVG. The picker previews each icon inline
  (theme-aware, `stroke="currentColor"`) via a reusable `Icon` component backed by
  the vendored Lucide data (`web/static/vendor/lucide-<version>.js`, exposing
  `LUCIDE_ICON_NODES` and `LUCIDE_ICONS`). That bundle is the single embedded copy
  of the icon geometry: the server (`internal/icons`) reads `LUCIDE_ICON_NODES`
  from it and reconstructs each icon's SVG at startup, so the set is not embedded
  twice and the two sides never drift.
- **`GET /api/v1/icons/{set}/{name}`** serves an icon as an `image/svg+xml`
  asset (from the `internal/icons` embedded set), so note-embedded
  `![…](/api/v1/icons/<set>/<name>)` references render. It is declared in `openapi.yaml` 
  (operation `getIcon`) for clients such as the Android app, but mounted directly on the 
  mux (like the artifact GET), taking precedence over the ogen `/api/v1/` handler rather than
  being served through it. It is a static, public, immutable, unauthenticated
  asset route served under the same locked-down sandbox CSP as artifact SVGs.
  The served asset carries a fixed neutral-grey stroke, for a client that loads it
  directly rather than through the render pipeline. An unknown name returns 404.
- In **any client running the render pipeline**, a note-embedded
  `![…](/api/v1/icons/lucide/<name>)` reference
  to a known icon is rendered inline as an `<svg stroke="currentColor">` (built from
  the vendored `LUCIDE_ICON_NODES`, mirroring the `Icon` component and the server's
  HTML export) rather than as an `<img>`, so the icon inherits the note's foreground
  colour and follows the light/dark toggle. An unknown name falls back to an `<img>`
  pointing at the icon endpoint (which 404s). The inline `<svg>` passes through the
  same DOMPurify render-time gate as all other note markup.
- **Artifacts are referenced with the `artifact:` URL scheme.** A stored artifact
  (§Artifacts) is embedded with ordinary Markdown image syntax carrying an
  app-defined scheme and the artifact's SHA-256 — `![alt](artifact:{sha256})` —
  and never a URL. The reference is therefore independent of where the app is
  deployed, and resolving it is a client render-time transform like every other
  extension: the pipeline rewrites it to `{base}/api/v1/artifacts/{sha256}`,
  where `{base}` is the deployment's base path taken from the page's
  `<base href>`. Without that a subpath deployment
  (`-public-url https://example.com/notes`) would resolve the reference at the
  origin root, outside the deployment — a 404 on a real server, and in demo mode
  also outside the service worker's scope, so none of the seeded images would
  load. The render kit has no `<base href>`, so references resolve root-relative
  there (see **Shared render kit**). A raw `<img src>` (and an SVG
  `<image href>`) in embedded HTML resolves identically.
  Only the exact form `artifact:` + 64 lowercase hex digits is accepted: it is
  validated at write time (§Security) and, at render time, anything else keeps
  the unknown scheme and is dropped by the sanitizer, so nothing beyond a bare
  digest is ever spliced into the resolved URL.
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

## Shared render kit

Almost everything above is a **client render-time transform** — the server never
produces HTML — so every client that displays notes has to implement the same
dialect. Rather than have each one re-implement it, the browser render pipeline
is packaged as an embeddable kit that native clients load in a web view.

- The kit is a plain static site rooted at `render/index.html`. It hosts the same
  markdown-it → DOMPurify pipeline (and the same Mermaid pass, AsciiMath
  conversion, inline Lucide icons and stylesheet) that the web UI's read view and
  editor preview use. There is one implementation of the dialect and one XSS
  gate; a client cannot drift from the web UI.
- The MyNotes server serves it at `/render/`, so it can be exercised in a browser.
  Clients are expected to **embed a copy** rather than fetch it, so rendering
  works offline and does not depend on the server version.
- The page exposes a small JavaScript API on `globalThis.MyNotesRender`:
  - `render(markdown)` — replaces the displayed note; resolves once diagrams have
    been drawn.
  - `setTheme(theme, vars?)` — `'light'` or `'dark'`, optionally overriding
    individual CSS colour variables so the embedded view matches the host app's
    chrome. Diagrams are re-rendered on a theme change, since Mermaid bakes its
    colours into the generated SVG.
- The page carries **no note content of its own**: the host pushes Markdown in
  through that API, so the sanitization gate is the only path to the DOM.
- Wikilinks and tag links render as the same root-relative `/notes/{slug}` and
  `/tags/{slug}` URLs as in the web UI; an embedding client intercepts those
  navigations and routes them natively. External links carry `target="_blank"`.
- Images resolve as ordinary requests to `/api/v1/artifacts/{sha256}` (what an
  `artifact:{sha256}` reference expands to; the kit has no `<base href>`, so the
  path is root-relative) and `/api/v1/icons/lucide/{name}`, which an embedding
  client is expected to serve from its own (authenticated, cached,
  offline-capable) storage.
- A client that only consumes the REST API and does not run the kit still gets
  well-formed Markdown — every extension is a render-time transform over content
  stored verbatim.

## MyMail integration

MyNotes can hand a note to a sibling [MyMail](https://github.com/mikaelstaldal/mymail)
instance to send it as an email (see **Send as email**). The integration mirrors
the one MyCal has with MyMail.

- **Zero configuration, derived from `-public-url`.** A MyMail deployed at
  `/mymail` on the same origin is assumed: `https://example.com/mynotes` implies
  `https://example.com/mymail`. Nothing is derived when `-public-url` is unset or
  names the origin root — a MyNotes at the root leaves no room for siblings — and
  the feature is then absent from the UI unless a URL is set in **Settings**.
  There is no separate server flag.
- The derived URL reaches the web UI through an inline `<script>` that the server
  splices into `index.html`, setting `window.__serverConfig.mymailUrl`. The
  script is JSON-encoded so no URL can terminate the surrounding element, and its
  sha256 is added to the page's `script-src` (only that page's — the render kit's
  host page never carries it).
- **Overridable in the web UI** (see **Settings**), for a MyMail that does not
  sit at `/mymail` or a MyNotes deployed at the origin root. The override is
  browser-local (localStorage) and takes precedence over the derived URL; an
  empty setting falls back to it. Being user-editable it is not trusted: a stored
  value is re-validated on every read (absolute `http`/`https`, no query or
  fragment) and dropped if it does not hold.
- Because MyMail is same-origin, the request needs no CSP relaxation
  (`default-src 'self'` covers it), carries the shared Basic-Auth session, and
  satisfies MyMail's Origin-based CSRF check. That is also why the setting
  **only accepts a same-origin URL**: with no `connect-src` in the policy, the
  browser would block a request to any other origin, so such a URL is rejected as
  it is entered rather than failing at send time.
- The web UI posts to MyMail's `POST /api/v1/messages/send-with-attachments`.
  MyNotes stores nothing about the message and provides no API of its own for it.

## Publishing

A note can be **published**: served as a web page that anyone with the link can
read, with no password, while the rest of the deployment stays private. This is
the only way content leaves the authenticated boundary — everything else the app
offers (download, print, email) hands the note to the person who is already
signed in.

- **The page is rendered by the client.** Publishing renders the note in the
  browser, using the same pipeline as the read view, and posts the resulting HTML
  to `PUT /api/v1/notes/{slug}/publish`. The Markdown dialect is defined by that
  pipeline (§Shared render kit) and the server has no second implementation of
  it, so what a reader sees is what the author saw.
- **The page is a snapshot.** Editing a published note does not change its public
  page; the author publishes again to update it. `published_at` on `Note` and
  `NoteSummary` says when the snapshot was taken, so a later `updated_at` means
  the public page is out of date. A note that has never been published, or has
  been unpublished, has no `published_at`.
- **Published at `/public/notes/{slug}`.** Nothing lists what is published:
  there is no public index, so a page is reachable only by knowing its slug. A
  slug that is not published and a slug that does not exist give the same
  response, so the set of notes cannot be probed from outside.
- **Unpublishing** (`DELETE /api/v1/notes/{slug}/publish`) takes the page down;
  unpublishing a note that is not published is a 404. **Deleting a note
  unpublishes it.**
- **Links between notes point at public pages.** A wikilink (§Markdown handling)
  in a published note addresses the linked note's *public* page, not the app,
  which a reader has no credentials for. Publishing a note does **not** publish
  the notes it links to: until a linked note is published its link is simply a
  link that does not resolve, and it starts working the moment that note is
  published, with no need to publish the linking note again. Tag links have no
  public counterpart — nothing lists published notes — so they appear as plain
  text rather than as a link to a page the reader cannot open.
- **Images are referenced, not embedded.** An artifact used by a published note
  becomes readable at `/public/artifacts/{sha256}`, also without
  authentication — and only while some published note references it. Publishing
  one note therefore exposes that note's images and nothing else; unpublishing
  withdraws them again, unless another published note still uses them. Artifacts
  are not inlined into the page as `data:` URLs, so the same image is fetched and
  cached once however many published notes show it. Publishing a page that
  references an artifact the server does not hold is a validation error (400)
  rather than a page with broken images.
- **The posted HTML is sanitized, not rejected.** Unlike note content — stored
  verbatim Markdown, where disallowed HTML fails the write (§Security) — a
  published page is rendered output, so scripts, framed content, event handlers
  and disallowed URL schemes are stripped from it and the rest is published.
  Author CSS is kept, because a diagram cannot be styled without it; the page is
  served with a policy that permits no script at all, which is what makes that
  safe. The HTML is bounded at 2,000,000 characters.
- **Styling comes from the server.** Only the note's body is stored; the server
  wraps it in a document carrying the note's title (as both the page title and
  its heading) and a link to `/public/note.css`, which is the same stylesheet the
  read view uses. Changing how published pages look therefore does not require
  re-publishing them. A published page is always light: it carries no script and
  so cannot follow the reader's theme, and its diagrams have the light palette
  baked in from publish time.

## Artifacts

Binary content (images and other files) may be stored as artifacts and referenced in notes. Artifacts are content-addressed: the SHA-256 of the content is used as the identifier, in the API URL, and in the `artifact:{sha256}` reference note content carries (§Content), so uploading the same bytes twice returns the existing record unchanged.

### Artifact API

- **Upload an artifact** — `POST /api/v1/artifacts` with a binary body and one of the accepted `Content-Type` values (`image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/svg+xml`, `application/mathml+xml`). Returns `{ sha256, content_type, created_at }`.
- **Fetch an artifact** — `GET /api/v1/artifacts/{sha256}` returns the raw binary body with the original `Content-Type` header and `Cache-Control: immutable`.
- **Delete an artifact** — `DELETE /api/v1/artifacts/{sha256}` removes the artifact (404 if absent).

### Artifact storage

Artifacts are stored as BLOBs in the same SQLite database as notes, in a separate `artifacts` table. There is no automatic garbage collection of artifacts no longer referenced by any note.

### Image embedding in the editor

The "embed image" toolbar button in the note editor uploads the selected file as an artifact and inserts a standard Markdown image reference `![alt](artifact:{sha256})` at the cursor. SVG and MathML files continue to be embedded inline as before. There is no hard file-size limit on upload (the global 10 MiB request body cap applies).

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
- Listing tags returns every tag sorted by slug, each with a **note count** —
  the number of notes currently carrying it (0 for an unused tag). This powers
  both client-side autocomplete and the tag-management view.
- Notes reference tags by slug in create/update requests; `Note` and
  `NoteSummary` API responses embed the full tag (slug) so the client does not
  need extra round-trips to display them.
- Notes can be listed filtered by one or more tags (by slug). Multiple tags AND
  together — a note must carry every requested tag to match — and the whole tag
  filter is combinable with a full-text search query.

## REST behavior (user-observable)

The API manages notes keyed by slug. Operations:

- **List/search notes** — optional query `q`, an optional `tag` filter (by
  tag slug; the `tag` parameter may be repeated to AND several tags together,
  combinable with `q`), an optional `titlePrefix` flag, optional
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
  - Present `tag` restricts results to notes carrying that tag; repeating `tag`
    requires notes to carry ALL of the given tags (AND). An unknown tag slug
    simply matches no notes (not an error). The single-value form (`tag=x`) is
    a one-element filter and behaves as before (backward compatible).
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
- **Download Markdown** — `GET /notes/{slug}/download-markdown` returns the note as a `.md` file (filename derived from slug). The body is a YAML frontmatter block (`title`, `slug`, `date` — the note's `created_at` as an RFC 3339 UTC timestamp — and `tags`, an array of the note's tag slugs, omitted when the note has none) followed by the Markdown content soft-wrapped at column 80. Wrapping reflows only over-long top-level paragraph lines, inserting soft line breaks at word boundaries (never splitting a word, and never before a token that could start a block); headings, code, tables, blockquotes, and list items are left verbatim. Because a soft break inside a paragraph renders as a space, the wrapped download renders identically to the stored note. The frontmatter is round-trip compatible with the Markdown import feature (re-importing the downloaded file restores the same title, slug, creation date, and tags); a single newline separates the closing `---` from the content (the parsed body is the wrapped content, which renders identically to the original).
- **Download HTML** — a **web-UI-only** feature (no server endpoint): the browser renders the note to a complete, standalone HTML document and downloads it as a `.html` file (filename derived from slug). It reuses the read-view render pipeline (markdown-it + DOMPurify, AsciiMath → MathML, inline Lucide icon `<svg>`) and additionally renders Mermaid diagrams to SVG, so the exported file matches the on-screen view — including diagrams, which a server render cannot produce. Internal artifact image references (`![alt](artifact:{sha256})`) are fetched and inlined as base64 `data:` URLs so the document renders standalone, without a live server (an SVG loaded via `<img src="data:">` cannot execute script, so it stays inert); an artifact larger than 16 MiB is replaced by an inline broken-image icon, and unknown or unresolvable references are left as-is. A small embedded stylesheet approximates the read view; the current light/dark theme is baked into the downloaded file (a `data-theme` attribute on `<html>`, and dark-themed Mermaid SVG) so it looks like what the user saw. The **Print** action reuses the same generated document, loaded into an off-screen iframe whose print dialog is invoked, but is always exported light (dark on paper wastes ink and reads poorly); the embedded stylesheet additionally resets to light under `@media print`, so even a saved dark document prints light.
- **Send as email** — a **web-UI-only** feature (no server endpoint) available
  only when the MyMail integration is configured (see "MyMail integration"). The
  note is sent as an HTML formatted email through the sibling MyMail instance,
  built from the same render as **Download HTML**: the message **body** carries
  the rendered note as HTML, and the `text/plain` alternative is the note's
  Markdown source. Always exported light, for the same reason as **Print**: the
  recipient's mail client supplies its own background.

  The unmodified standalone document from **Download HTML** is **attached** as a
  `.html` file **only when the body could not carry some of the note's content** —
  that is, when it contains diagrams, formulas, icons, embedded graphics, or an
  image whose source cannot be made absolute. A note the body reproduces
  faithfully is sent without an attachment: a second copy of a note the recipient
  can already read in full is noise, and it roughly doubles the size of the
  message. A substitution that carries the same information in a different shape
  (an unfolded callout, a checkbox rendered as ☐/☑, styling email cannot express)
  does not trigger the attachment. Messages with an attachment go to MyMail's
  `send-with-attachments` endpoint, the rest to `send`. The confirmation names
  what was lost whenever the attachment is included.

  Note that the renderer places a Lucide icon in the title of every **alias**
  callout (`[!warning]`, `[!note]`, …), so any note using one counts as degraded
  and is sent with the attachment. A box written without an alias (`>-`, `>*`,
  `>+`) carries no icon and is not affected.

  The body is adapted for email, because MyMail sanitizes what it sends (it
  allows a fixed set of elements, no `class`, no `<style>` element, and a fixed
  set of CSS properties) — which is also roughly how mail clients behave. The
  adaptation: every rule of the export stylesheet is re-expressed as an inline
  `style=` attribute; all links and image references are made absolute (a link
  that cannot be, including a fragment-only one, keeps its text but loses its
  href; an image that cannot be is dropped); Mermaid diagrams are replaced by a
  note pointing at the attachment; MathML degrades to its text content in a
  `<code>` span; inline Lucide icons are dropped (their labels remain in the
  surrounding text); foldable callouts flatten to
  always-expanded boxes; and task-list checkboxes become ☐/☑ characters.
  Everything so removed is present in full in the attachment, which is exactly
  why those removals are the ones that trigger it. Inlined artifact images
  (`data:` URLs) are carried through unchanged.

  MyMail's sanitization allowlist accommodates this path, so the email keeps
  rounded corners, single-sided accent borders on callouts, and bullet-free task
  lists. It does so symmetrically — MyMail renders on delivery everything it
  permits on send — so a note emailed to a MyMail address (including your own)
  arrives exactly as sent rather than stripped back. Styling MyMail permits in
  neither direction — `position`, `display`, `opacity`, `<style>` elements — is
  excluded on purpose and is unreliable in mail clients anyway.
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

- **Navigating to a non-existent note** (`/notes/{slug}` for a slug that doesn't
  exist — whether typed as a URL or reached by following a wikilink) opens the
  new-note editor pre-filled with that slug (forced, so the created note gets it)
  and a title suggested by reversing the slug algorithm (hyphens → spaces, first
  letter capitalised). The suggestion alone does not enable saving; a manual edit
  is required. Cancelling returns to the note that linked here when reached via a
  link, otherwise to `/`. Saving creates the note in place (no duplicate history
  entry, so a single back press leaves it).
- **Navigating to a non-existent tag** (`/tags/{slug}` for a slug that doesn't
  exist — typed as a URL or reached by following a `[[#slug]]` tag link)
  auto-creates it as an empty tag (no notes attached), so it becomes real and
  appears in the sidebar tag dropdown. Malformed slugs the backend would reject
  are ignored.

- **Sidebar (always visible):** a three-tab panel — a **Notes** tab (the default),
  a **Tags** tab, and a **Graph** tab — under the brand.
  - **Brand (all tabs):** the app mark on a coloured badge, followed by the
    "MyNotes" label; the whole block links to the note list. The badge is
    decorative — it is `aria-hidden` and the link's accessible name is the label
    alone.

    The badge implements the **MySuite logo contract**, shared with the sibling
    MyCal and MyMail apps so the three marks render at the same size and sit in
    the same place. As with the sidebar footer, that contract is defined in the
    sibling `mysuite` repository (`../mysuite`, `spec/app-logo.md`) and **that
    document is the authority** — this section deliberately carries none of its
    values, so it cannot drift from them. The tidy-ups that break the contract
    silently in *this* app are covered by "The app logo is governed from outside
    this repo" in `web/AGENTS.md`, which is where somebody about to edit the
    stylesheet will actually read them.

    `e2e/tests/logo.spec.ts` holds this repo's half. It necessarily *does* state
    the mandated numbers — an assertion cannot check a value without naming it —
    which makes it the one place here that goes stale if the contract is amended,
    and the place to update first.

    The mark itself is MyNotes' own — what it depicts is deliberately not shared;
    only the geometry, colour and placement are. It is drawn from the same
    letterform as `web/static/favicon.svg`, which the two must keep in step.

    The sidebar is **540px** wide rather than its historical 420px, in three
    steps. The first two grew the column by exactly what was added to the header,
    so the rest of it kept the room it had before: first for the badge, then for
    the wider inset the contract's placement requires (420 → 456 → 464). The
    third, 464 → 540, is different in kind — it carries the app-name label at
    the siblings' 1.1rem instead of MyNotes' former 1rem, **and** a deliberate
    tolerance for a `system-ui` wider than the authoring machine's, since sizing
    the column to what fits locally is what let the header overflow on other
    systems. The main pane is 76px narrower for it, which is the accepted cost.
  - **Notes tab:** debounced search box, results showing title,
    updated time, excerpt with highlights when searching, and tags. A sort
    dropdown selects the browse order — by updated time, created time, or title,
    each ascending or descending; the choice is persisted (localStorage) and
    drives both the sidebar and the main-panel overview. It has no effect while a
    search query is active (results stay relevance-ordered). A tag
    filter lists every tag that exists (not just tags visible in the
    currently loaded notes), so a tag can be selected to filter even when no
    matching note is currently on screen; multiple tags AND together, each shown
    as a removable chip (removing a chip drops that tag from the filter only — it
    does not delete the tag). Empty and
    loading states. A "Load more" button pages through results (accumulating and
    de-duplicating rows by slug); resets on query or tag-filter change. Shows
    the total count. "New note" and "Upload note" actions. The currently open
    note is highlighted in the list.
  - **Tags tab:** lists every tag sorted by slug, each with the number of notes
    carrying it and a delete button. Clicking a tag's name filters the note list
    by it and switches back to the Notes tab. A "New tag" action asks for a name
    in a prompt dialog and creates the tag (empty) from its slugified form.
    Deleting a tag that is still
    attached to one or more notes asks for confirmation first (the notes
    themselves are kept, just untagged); deleting an unused tag (zero notes) does
    not prompt. The list refreshes after a delete.
  - **Graph tab:** visualizes the note-link graph (from the `outgoing_links` /
    `incoming_links` index) as a Mermaid diagram. Only notes that participate in
    at least one link are drawn — a directed edge per note-to-note wikilink;
    isolated (unlinked) notes are omitted. Each node is filled with a colour
    derived from the note's tag (a deterministic colour per tag slug; a note with
    several tags is coloured by its alphabetically-first tag, and untagged notes
    get a neutral fill). A legend below the diagram maps each tag colour (plus
    "(untagged)" when applicable). Hovering a node shows a tooltip listing all of
    the note's tags (or "No tags"). Clicking a node opens that note, and the note
    currently open in the main panel is highlighted. The diagram scrolls on both
    axes within the sidebar. Empty and loading states.
  - **Sidebar footer (all tabs):** a light/dark theme toggle and a **Settings**
    action. Light mode is the
    default; the choice is persisted (localStorage) and applied to the document
    root as a `data-theme` attribute, which drives every colour via CSS
    variables. It affects the whole web UI and the Markdown render pipeline (read
    view, editor preview, callouts, and Mermaid diagrams — which are re-rendered
    on toggle since their colours are baked into the SVG) and the downloaded HTML,
    but not print (see **Download HTML**).
    Both controls implement the **MySuite sidebar-footer contract**, shared with
    the sibling MyCal and MyMail apps so that someone with all three open in
    browser tabs sees nothing move when switching between them. Their geometry,
    colours, hover and focus treatment, the width-stable label mechanism, and
    their position relative to the *window* are defined once, in the sibling
    `mysuite` repository — `../mysuite`, `spec/sidebar-footer.md`. That document
    is binding and is the only place those values live; this document
    deliberately restates none of them, and a number found here that contradicts
    it is stale.
    Read it, and its `measurement-protocol.md`, before changing anything about
    these two controls.
    **Changing any of this is a change in all three repositories** — there is no
    such thing as fixing it here alone.

    What is particular to MyNotes: **Settings is absent from demo builds** — a
    demo has no server to hold the MyMail URL — so a demo shows the theme toggle
    alone, and the contract's geometry then applies to a single control rather
    than a pair. The palette its colours resolve through lives in
    `web/static/render/note.css` rather than `app.css`, since that file owns the
    theme selectors and `app.css` has no `:root` block of its own; two of those
    variables are used only by app chrome and are inert everywhere else that
    stylesheet is consumed. And the footer is full-bleed where the sidebar header
    and note list above it are inset, so the controls — and the demo badge beside
    them — sit slightly left of the note list; that is the price of the shared
    contract, not an oversight.

    **There is now a suite for this**, `e2e/tests/sidebar-footer.spec.ts`, run by
    `./test-e2e.sh` after `./build.sh`. It measures the rendered page in Chromium: both viewport
    coordinates across every route and at a content volume that makes the
    sidebar's inner scrollport scroll, the acceptance height, the pinned computed
    values *and* their presence as declarations, contrast for the resting label,
    the focus indicator and the hover fill in both themes, and the full-bleed
    separator. `./build.sh` alone still says nothing about any of it — the binary
    embeds `web/static/`, which is why `test-e2e.sh` compares served bytes against
    on-disk bytes before running a test.

    Three limits, stated because a green suite bounds what was checked rather than
    what is correct. **CI runs this suite on every push to `main`** — see the root
    `AGENTS.md` § E2E tests, with `../mysuite/spec/sidebar-footer.md` §9.1 as the
    authority on status — but the workflow triggers *on* push, so a breaking commit
    is already on `main` when the suite goes red: **what it gates is publication**,
    not the commit landing, and it is still not what stops an edit made for a good
    reason by someone who did not know the rule existed. That remains the prose in
    `web/AGENTS.md`. **`0.80rem` cannot be verified by anything** — it serialises
    identically to `0.8rem` — so that convention is held by review. And this suite
    can only see MyNotes: **cross-repo drift remains undetectable**, so a figure
    agreeing here says nothing about whether MyCal and MyMail still agree with it.
- **Settings:** a modal opened from the sidebar footer, holding the preferences
  that have no control of their own — currently just the **MyMail URL** (see
  **MyMail integration**). The field shows the user's override; leaving it empty
  means "use the URL the server derived", which the placeholder and a hint below
  the field name. Saving validates the URL and reports why one is refused —
  relative, not `http`/`https`, carrying a query or fragment, or not on this
  origin; the last because the Content-Security-Policy would block the request.
  The choice takes effect at once: the note toolbars' "Send as email" action
  appears or disappears without a reload. Cancel, Escape, or a click outside
  discards the edit. The action is not offered in demo mode, where MyMail is the
  only setting and is unavailable anyway.
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
  "Send as email" (only when MyMail is configured), "Split", "Edit", and
  "Delete" — acting on that row's note; delete asks for confirmation first
  (naming the note), and delete and split
  refresh the lists in place. Falls back to a "select or create a note" prompt
  only when the list is genuinely empty.
- **Read view (main panel):** renders the note's Markdown safely into a styled
  container. The stored title is used as the browser tab title (not duplicated as
  a body heading). The note's tags are shown as chips; clicking one filters the
  sidebar list to that tag. "Edit", "Delete", "Split", "Print", "Download
  Markdown", "Download HTML", and — when MyMail is configured — "Send as email"
  actions. "Send as email" opens a dialog with the recipient address and a
  subject prefilled with the note's title; the note is rendered only on submit.
  "Split" opens a dialog with a tag
  picker (the same autocomplete-or-create widget as the editor) to optionally
  choose or create a single tag, then splits the note by its top-level headings
  and navigates to the tag's note list (when a tag was chosen) or the first new
  note. A 404 (or a malformed-slug deep link) shows a not-found message.
- **Clickable task items:** a task-list checkbox in the read view is the one
  interactive part of it. Clicking one opens the note in the editor with that
  item toggled (`[ ]` ⇄ `[x]`) — and **nothing saved**: the flip is an ordinary
  unsaved edit, so the user decides between saving and discarding it, and the
  usual unsaved-changes guard applies. Clicking one in the editor's own preview
  (already editing) just toggles it in place, likewise unsaved and undoable.
  Whichever item was clicked is the one that moves, however many the note has and
  wherever they sit (nested lists, ordered lists, blockquotes, callouts): the
  click carries the source line of the marker it was rendered from *and* the
  state it was rendered in, and both are re-checked against the document before
  anything is touched. A click the document no longer matches does nothing rather
  than something wrong — and where a re-check cannot tell (the editor restoring a
  draft, a document the clicked line numbers were never about) the pending toggle
  is dropped outright.
  Interactivity is web-UI-only: the exported, printed, emailed and render-kit
  copies keep the disabled checkbox.
- **Editor (main panel, new/edit):** title input (with auto-derive-from-heading
  until edited); slug field (suggested for new notes, editable-with-warning when
  editing); a tag picker (autocomplete over existing tags, plus an explicit
  "create tag" action — deriving a slug from the typed text — for a slug with no
  match, nudging toward reusing existing tags over creating near-duplicates); a
  Markdown source editor with syntax highlighting and a
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
    (`beforeunload`/`visibilitychange`), when the unsaved-changes guard fires on
    in-app navigation (which neither of those events covers), and once more right
    before submitting to the backend, so unsaved work survives an unexpected
    browser close. The stored
    draft is cleared only
    after the backend confirms the save. On reopening the editor (keyed by note
    slug, or a single shared bucket for a new note), if a stored draft differs
    from the loaded/blank baseline the user is offered a one-time choice to
    restore it or discard it; discarding clears the stored draft, and the editor
    is not rendered until the choice is made, so the answer decides its initial
    contents and nothing behind the question can be typed into or submitted.
  - On successful save, navigate to the saved note's read view using the slug
    from the response (which may have been auto-generated, suffixed, or renamed).
  - A 404 on save/delete from a stale tab shows a toast and navigates to the
    list. A slug conflict (409) shows the server's error message as a toast.
- Errors are surfaced through a toast component.
- **Confirmations and prompts are in-app dialogs**, never the browser-native
  `alert`/`confirm`/`prompt`: a themed modal (heading, optional explanation, a
  text field for a prompt) rendered in the app's own styling, dismissible with
  its cancel button, Escape, or a click outside — which answers "no" for a
  confirmation and "cancelled" for a prompt. A question whose *dismissing* answer
  is itself destructive (only the draft-restore one) withholds Escape and
  click-outside, so discarding takes a deliberate click. Requests queue, so only
  one is on screen at a time. They answer asynchronously, so anything gated on the answer
  (in-app navigation, creating the editor for a note with a stored draft) waits
  for it rather than blocking. The one browser-native dialog that remains is the
  `beforeunload` unsaved-changes warning on refresh/tab-close, which only the
  browser can raise.

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

## Markdown Directory Bulk Import

A one-shot batch mode that imports a directory tree of Markdown files as notes
into the same SQLite database the server uses.  The filesystem counterpart to the
Google Docs import, sharing its structure: it writes through the same
`NoteService` the REST API uses, so imported content passes the same validation.

### Invocation

```
./mynotes -import-md-dir <DIR> [-data <dir>]
```

When `-import-md-dir` is present the binary runs the importer instead of starting
the HTTP server.  All other flags except `-data` (which controls the database
path) are ignored.  The database is created if it does not yet exist.
Combining `-import-md-dir` with `-demo`, `-demo-server`, `-demo-bundle`, or the
`-gdocs-*` flags is an error: each batch mode runs instead of the others.

### What is imported

- The directory is walked **recursively**; a missing path, or a path that is not
  a directory, imports nothing and is an error.
- **Regular files with a `.md` extension** (matched case-insensitively) only.
  Every other file is skipped silently — no `.markdown`, `.txt`, or extensionless
  file is read.
- **Hidden entries are skipped** — any file or directory whose name starts with
  `.`, a skipped directory including everything under it, so an Obsidian vault's
  `.trash` does not resurrect deleted notes and `.git` is not read.  The named
  root itself is never skipped, so importing `~/.notes` works.  No other
  directory is excluded: a site repository's `node_modules/` is imported like
  any other subdirectory.
- **A symlinked root is resolved**, so naming a symlink to a directory imports
  its contents rather than finding nothing.  Symbolic links *within* the tree
  are not followed (neither to files nor to directories), so the walk cannot
  leave the named directory.
- Files are visited in lexical order, so an unchanged directory imports in a
  stable order.
- A file larger than **10 MiB** is reported as an error rather than read (the
  content length limit of 1,000,000 characters bites well before that anyway).
- **Empty files** — nothing but whitespace — are skipped: they are reported as
  skipped and counted separately, and are neither imported as empty notes nor
  treated as failures.

### Title, date, slug, and tags

The file's content is authoritative and reaches the service **verbatim**; the
filesystem only supplies fallbacks for what the file itself does not say.  A
leading UTF-8 BOM is stripped first, so it cannot defeat frontmatter detection.

Frontmatter is parsed exactly as for the import-Markdown endpoint (YAML `---`,
TOML `+++`, or JSON), so `title`, `slug`, `date`, and `tags` are honoured; tags
that do not yet exist are created.

- **Title:** frontmatter `title` → first ATX heading → the file name without its
  extension (`Shopping list.md` → `Shopping list`).  Truncated to 200 characters
  like any other imported title.
- **created_at:** frontmatter `date` → the file's modification time.
  `updated_at` equals `created_at`, as for every import.
- **Slug:** frontmatter `slug` verbatim (a collision is an error for that file)
  → derived from the title and de-conflicted with a numeric suffix, so several
  files with the same title all import (`my-note`, `my-note-2`, …).

### Validation and error handling

Imported content passes through the same validation pipeline as any note created
via the REST API.  A file that fails validation (e.g. disallowed embedded HTML,
invalid UTF-8, no title anywhere), cannot be read, or is too large is reported
and skipped; the remaining files continue importing.  A directory that cannot be
read is reported once and skipped, and the rest of the tree still imports.

Re-running the importer creates new notes (with auto-suffixed slugs) for files
that were already imported.  There is no deduplication — the command is intended
as a one-shot migration, not a sync.

### Output

Progress is printed to stdout:

```
Scanning /path/to/markdown for .md files...
Found 42 file(s). Importing...
  ✓ My First Note.md → /notes/my-first-note
  ✓ projects/Ideas.md → /notes/ideas
  ⊘ scratch.md: skipped, no content
  ✗ broken.md: content validation error: …
  …
Imported 40 note(s). 1 skipped. 1 failed:
  - broken.md: content validation error: …
```

File names are shown relative to the import directory.  Exit code is 0 when no
file failed, 1 otherwise; skipped files do not affect the exit code.

## Markdown Directory Bulk Export

A one-shot batch mode that writes every note in the database to a directory as a
Markdown file.  The inverse of the Markdown directory bulk import, and its
structural twin: it reads through the same `NoteService` the REST API uses, and
serialises each note with the same function behind
`GET /notes/{slug}/download-markdown`, so an exported file is byte-for-byte what
the *Download Markdown* button produces and an exported directory re-imports with
`-import-md-dir`.

### Invocation

```
./mynotes -export-md-dir <DIR> [-data <dir>]
```

When `-export-md-dir` is present the binary runs the exporter instead of starting
the HTTP server.  All other flags except `-data` (which controls the database
path) are ignored.  The target directory is created, with any missing parent, if
it does not yet exist.  Unlike the import modes the **database is not created**:
exporting from a `-data` directory that holds no database is an error, not an
empty directory and a successful exit.  Combining `-export-md-dir` with
`-import-md-dir`, `-demo`, `-demo-server`, `-demo-bundle`, or the `-gdocs-*`
flags is an error: each batch mode runs instead of the others.

### What is written

- **One `.md` file per note**, flat in the target directory — no subdirectories,
  and no directory structure is reconstructed from tags.
- Notes are exported **oldest first** (by `created_at`, with an id tiebreak), so
  a run over an unchanged database produces the same names in the same order.
- The file content is a **YAML frontmatter block** (title, slug, date, tags,
  `dialect: mynotes`) followed by the note's Markdown body soft-wrapped for
  reading — exactly `service.MarkdownWithFrontmatter`, the download-Markdown
  serialisation, reused rather than reimplemented so the two cannot drift.
- Artifacts (images) are **not** exported; a note referencing one keeps the
  `artifact:…` reference in its Markdown.

### File names

A note is written as **`<slug>.md`** — the file is named by the same identifier
that addresses the note at `/notes/<slug>`, so a URL maps to a file and back
without guessing.

The slug needs no sanitising, truncation, or de-duplication for this: it is
already constrained to `^[a-z0-9]+(-[a-z0-9]+)*$` (lowercase ASCII alphanumerics
and interior hyphens), at most 100 characters, and `UNIQUE` in the schema.  So
there is no separator, no dot, no invisible or uppercase character, no name past
a filesystem's limit, and no collision — on any platform.

Two things remain:

- A slug matching a **DOS device name** (`con`, `nul`, `aux`, `prn`, `com1`…`com9`,
  `lpt1`…`lpt9`) is prefixed with `_`, since Windows rejects `con.md` as firmly as
  `con`.  Each of these is a valid slug — a note titled "Con" auto-slugs to `con`
  — so the case is reachable, not theoretical.  The prefix cannot collide with
  another note's file, because `_con` is not a slug any note can hold.
- The slug is **re-checked against the pattern** before it is joined into a path.
  This is the one place a database value becomes a path, and a file name should
  not rest on an invariant enforced in another package; a slug that is not a bare
  name is rejected rather than written, costing that one note an error line.

### Re-running

An export overwrites the file it wrote for a note before: the command is a
repeatable dump of the database, not an incremental sync.  Nothing else in the
directory is touched, so a note deleted since the previous run leaves its file
behind, and a note whose slug changed leaves its old file alongside the new one.

### Validation and error handling

A note that cannot be read or written, or whose slug is not a bare name, is
reported and skipped; the remaining notes still export.  A target path that
exists as something other than a directory, or that cannot be created, exports
nothing and is the single reported error.

### Output

Progress is printed to stdout:

```
Listing notes...
Found 42 note(s). Exporting to /path/to/out...
  ✓ /notes/my-first-note → my-first-note.md
  ✓ /notes/ideas → ideas.md
  ✗ broken: write /path/to/out/broken.md: no space left on device
  …
Exported 41 note(s). 1 failed:
  - broken: write /path/to/out/broken.md: no space left on device
```

Exit code is 0 when no note failed, 1 otherwise.

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

## Demo Mode

A build of the web UI that runs with no backend: a service worker intercepts the
REST API and answers it from storage in the browser. It exists so the product
can be tried — or published as a live demo — without a server, a database, or
anyone's notes leaving their machine.

### Invocation

```
./mynotes -demo-server [-port <n>] [-addr <host>] [-public-url <url>]
./mynotes -demo-bundle <dir> [-public-url <url>]
```

`-demo-server` serves the web UI and nothing else: no database is opened and no
REST API is mounted. `-demo-bundle` writes the same thing out as static files
and exits; the directory must not already exist or must be empty. Neither mode
accepts `-data` — there is no database — and combining them with it is an error.
A `-public-url` path component sets the deployment's base path in both, exactly
as it does for the real server.

The bundle is a plain static site: index.html carrying the Content-Security-
Policy the server would send as a header, the compiled app, the service worker,
the seed document, and a `404.html` copy of the shell for hosts that serve it on
an unknown path. Any web server that serves a directory can host it. A service
worker requires a secure context, so it must be served over HTTPS or from
localhost.

### Behavior

- On first load the browser store is filled with the same content `-demo` seeds
  (§Demo Data) — the same tags, notes, and artifacts, produced by the same
  seeding code.
- The first visit opens a modal explaining that there is no server, that
  everything is stored in this browser, and that nothing is really saved. It has
  a single OK button, and is also dismissed with Escape or a click outside.
  Dismissal is recorded in localStorage, so it appears once per browser — not
  once per store, so clearing the demo's notes does not bring it back. It never
  appears outside demo mode. A standing reminder stays in the sidebar footer.
- Every REST operation the web UI performs is available and behaves as it does
  against the server: listing, full-text search with highlighted snippets,
  title-prefix filtering, tag filtering and sorting, create, edit with
  optimistic locking, delete, split, tag management, image upload and display,
  Lucide icons, Markdown and HTML import, Markdown download, and HTML export.
- Data persists across reloads and restarts, and is scoped to the browser and
  origin. Clearing the site's data restores the original demo content.
- A hard reload (Ctrl-Shift-R) loads the page with the worker bypassed, leaving
  it with no backend. The demo recovers on its own — it asks the worker already
  installed to take control, and reloads once if that does not happen — so the
  app comes up as usual rather than reporting that the backend did not start.
- The MyMail integration is never offered in demo mode: there is no server to
  relay a message. Neither is the Settings action, MyMail being all it holds; a
  MyMail URL left in localStorage by a non-demo deployment on the same origin is
  ignored rather than acted on.
- Publishing is never offered either (§Publishing): a published page is served
  by a server to readers who are not running the demo, and the demo has no server
  and no readers but the one browser it lives in. `/public/…` answers with a
  not-found page there, as it does on a real deployment with nothing published.
- Image uploads are capped at 2 MiB, and a write that exhausts the browser's
  storage quota is reported as such. Neither limit exists on the server.
- After the worker is installed it also resolves client-side deep links, so
  those work on a static host that does not rewrite unknown paths itself.

### Fidelity

The demo backend is a re-implementation, and its observable behavior is expected
to match the server's: same routes, same status codes, same JSON, same ETag and
optimistic-locking semantics, same slugs, excerpts, snippets, wikilink graph,
validation verdicts, and downloaded Markdown. Two differences are accepted:

- Schema-level request errors (a missing title, a malformed slug) are still
  rejected with 400, but the message is the demo's own rather than the wording
  the server's generated decoder produces.
- Search results are ordered by match count instead of SQLite's bm25 ranking.
  Which notes match, and how their snippets look, is unchanged.

### Security

Demo content never leaves the browser it was typed into, so the write-time
validation is a consistency guarantee rather than a boundary. It still rejects
disallowed embedded HTML, event-handler attributes, and link/image schemes
outside the allow-list; the authoritative XSS gate remains the render-time
DOMPurify pass on the page, exactly as in the real app.

## Security (user-facing guarantees)

- The app must not execute scripts or active content embedded in note bodies;
  rendered notes are sanitized so untrusted content cannot run code.
- Embedded HTML in notes is allowed only for a safe set of tags/attributes; only
  `http`/`https`/`mailto` link schemes and `https`/safe-`data:`/`artifact:` image
  sources are permitted; unsafe HTML/schemes cause a write to be rejected.
- The whole app may be gated behind optional HTTP Basic Auth, **except the
  published-note surface** (§Publishing), which exists to be readable without
  credentials. That exemption covers exactly `/public/…`: a published page, an
  artifact some published note references, and the stylesheet those pages need.
  Nothing else under that path is served, so an unauthenticated request cannot
  fall through to any other part of the app.
- A published page is static: it is served with a policy that allows it no
  script, no frames, and no form submission, and can be framed by nobody. That
  holds whatever reaches it, which is why author CSS may be published verbatim.
- Publishing is explicit and per-note. Nothing is published as a side effect of
  creating, editing, or importing a note, and no listing of published notes is
  served.
- GET requests never modify data.
