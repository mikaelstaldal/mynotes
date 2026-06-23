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
- File/image attachments and uploads. (Note: uploading a **Markdown file to
  create a note** — §6 — is *not* an attachment; the file's text becomes the
  note's `content` and the file itself is not stored or referenced. It is a
  client-side convenience over the existing `POST /notes`, so it does not breach
  this non-goal.)
- Public publishing workflow beyond the stable URL existing.

These are listed so the data model and API leave room for them but do not
implement them.

---

## 2. Relationship to the template

MyNotes is built on the existing codebase. The single `items` resource
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
  - **What counts as "the first heading":** the first **ATX** heading only —
    a line matching `^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$`, with the captured
    text as the title. **The leading-indent class is literal spaces (` {0,3}`), not
    `\s`** — CommonMark treats a leading **tab** as 4 columns, which makes a
    `\t# Foo` line an *indented code block* (rendered as code, not a heading) by
    markdown-it; matching only 0–3 **spaces** keeps the client derivation consistent
    with markdown-it (the separator/closing classes use `[ \t]` because a space *or*
    tab is a valid ATX delimiter *after* the markers). **Setext** headings (a text
    line underlined with `===`/`---`) are
    **not** recognized in v1. Lines inside a fenced code block (```` ``` ````/`~~~`)
    are **skipped**, so a `#` comment in a code sample is never mistaken for the
    title. A trailing `#` run is stripped from the captured text **only when it is
    preceded by whitespace** — matching CommonMark's optional closing sequence, so a
    heading like `# Done###` keeps the literal `###` (it derives `Done###`, the same
    text markdown-it renders in the `<h1>`) while `# Done ###` derives `Done`. This
    keeps the derivation consistent with how markdown-it parses the same heading.
  - **Empty-text headings are skipped.** The `[ \t]+` after the markers means a bare
    `#`/`##` (markers with no following space/text) does not match at all. A line
    like `## ` (markers, space, nothing) *does* match but captures empty text;
    since an empty title is never usable (it would fail `minLength: 1`), such a
    heading is **skipped** and scanning continues to the next candidate. The
    derived title is therefore always the first heading with **non-empty,
    non-whitespace** captured text — or, if none exists, no title is derived (the
    editor leaves the field for the user to fill; the upload flow falls back to
    the filename, §6).
  - **Unclosed fences run to end of input.** Fenced-code skipping tracks open/
    close fences; an **unclosed** fence (an opening ```` ``` ````/`~~~` with no
    matching close) extends to EOF — matching CommonMark — so every `#` line after
    it is treated as code and never taken as the title. This keeps the client's
    derivation consistent with how markdown-it renders the same source.
  - **A tab in the captured heading text is replaced with a single space.** A
    heading's inline text may contain a literal tab (`# foo⇥bar`), and a tab is the
    **only** C0 control that can ever reach a derived title: `content` rejects every
    other C0 control except tab/newline/CR (§4.1), and a heading is a single line so
    no newline/CR is captured. But the server rejects **all** C0 controls in `title`,
    **tab included** (§4.1, §9), so a derived `foo\tbar` would 400. The client
    therefore **replaces each tab in the captured text with one space** before using
    it as the title — markdown-it renders the tab as whitespace in the `<h1>` anyway,
    so this matches what the user sees, and it preserves the same "never surface a
    confusing `400` for a title the user never typed" guarantee as the truncation
    rule below. The space substitution happens **before** the `maxLength: 200`
    truncation. (The upload filename fallback — §6 — does not need this; filenames
    do not carry tabs into the title.)
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
  the max length (`maxLength: 100`) **and trim any trailing `-` again** — a cut can
  land mid-separator and re-introduce one, which would violate the slug pattern. A
  generated slug therefore always matches `^[a-z0-9]+(?:-[a-z0-9]+)*$` (or falls
  back to `note`); no separate validation pass against the pattern is needed.
  Room for a uniqueness suffix is **not**
  reserved here — it is reserved only at collision time, when a suffix is actually
  appended (per §3.1, Uniqueness). If the title yields an empty slug (a non-empty
  title whose characters all fold away — e.g. all-punctuation or a non-Latin
  script), fall back to `note`.
- **Uniqueness:** slugs are unique. (The DB enforces uniqueness; the service
  resolves collisions.) Collision handling depends on origin:
  - **Auto-generated** slug (client sent none): on collision the service appends
    `-2`, `-3`, … until free. The base is first truncated so that base + suffix
    still fits within `maxLength: 100` (the suffix is never sacrificed), and any
    trailing `-` left by that truncation is trimmed before the suffix is appended
    (so the result is never `foo--2`, which has an empty segment and violates the
    pattern). The fit
    is recomputed **per suffix length**: when the counter rolls from `-9` to
    `-10` (suffix grows from 2 to 3 chars) the base is re-truncated to
    `100 - len(suffix)`, so the combined slug never exceeds 100 at any counter
    value. The
    service-level existence check is advisory and racy (two concurrent creates
    can both pass it); the DB `UNIQUE` constraint is the source of truth. On a
    `UNIQUE` violation for an auto-generated slug, the service re-resolves the
    suffix and retries the insert (**bounded at 5 attempts**), so concurrent
    double-submits (a double-clicked Save, or a Save issued from two tabs) never
    surface a spurious error. "Re-resolves" means
    it **re-runs the full suffix scan from `-2` against current DB state** (not
    resume from the last counter): the re-scan observes the now-committed colliding
    slug and selects the next free suffix, so the retry is self-healing and a
    repeated collision on the same suffix cannot burn attempts. The `-2`/`-3`/…
    suffix search itself is data-bounded (it scans existing slugs) and is separate
    from this retry, which guards only the rare write race. If all 5 attempts
    still hit a `UNIQUE` violation, the service returns an **internal error
    (`500`)** rather than looping — exhaustion is practically impossible for a
    single-user tool.
  - **Explicit** slug (client supplied one): a collision is an error, never
    silently suffixed — the service returns `ErrConflict` → `409`. The advisory
    existence check here is racy too (like the auto-generated path), but it is
    **not** retried/suffixed — the client asked for that exact slug. Instead, a
    concurrent write that passes the advisory check yet hits the DB `UNIQUE`
    constraint on the `INSERT`/`UPDATE` is mapped to **`ErrConflict` → `409`**
    (the same outcome as the advisory check catching it), **not** surfaced as a
    raw `500`. This applies to **both** an explicit-slug create and a `PATCH`
    slug rename (§9): the editor's Save can be issued concurrently (a
    double-clicked Save button, or the same note open in two tabs), making the
    double-submit race real, and a `409` is the correct, consistent response in
    every case.
- **Editing:** a slug *may* be changed via `PATCH`. Setting `slug` to a value
  already used by **another** note returns `409`; setting it to the note's own
  current slug is a no-op (not a conflict, and — being a no-op — does not bump
  `updated_at`; see §5). Changing it changes the note's URL —
  old links break. This is acceptable for a personal tool; the UI should warn
  before changing an existing slug. (No automatic redirects in v1.) A `PATCH`
  slug is **always an explicit value** the client supplies: there is **no
  auto-regeneration or re-derivation from the title on update** (auto-generation
  and collision-suffixing happen only on create, when no slug is sent — §3.1
  Generation/Uniqueness). To change a slug the client sends the exact new value;
  to leave it unchanged the client omits the field. A slug can never be emptied
  (the `minLength`/pattern forbid `""`), so there is no "clear slug" semantic
  paralleling `content: ""`.
- Reserved slugs: none required, because note URLs live under a `/notes/`
  prefix that cannot collide with app routes (see §6).

---

## 4. Markdown handling

Rendering and editing are **client-side** (resolves O-1, O-2, O-3). The server
treats `content` as Markdown text: it stores it, searches it, **validates its
structure and embedded HTML on write (§4.1)**, and returns it — it never converts
it to HTML. All Markdown→HTML conversion happens in the browser.

- **Standard (O-5):** CommonMark plus the common GFM extensions that stock
  markdown-it supports — tables, strikethrough, and autolinks. markdown-it
  `linkify` is **enabled**, so bare URLs/emails in plain text become links too
  (not just explicit `<url>` autolink syntax); these still pass through
  `validateLink` and DOMPurify, so the scheme allow-lists apply unchanged. **Task lists are *not*
  in v1** (they need a markdown-it plugin and would require allowing `<input>`
  through the sanitizer; `- [ ]` simply renders as a literal list item). **Images
  are enabled**: Markdown image
  syntax renders `<img>`. The sanitizer's scheme allow-list permits `https` and
  the canonical `data:` raster set for image `src`; an `http` `src` survives
  client sanitization but is blocked at load time by CSP `img-src` (which omits
  `http`, avoiding mixed content), and on **write** the server goes further and
  **rejects** an `http` image destination outright (§4.1), so a silently-broken
  `http` image is never stored via the API in the first place. No
  uploads — only referencing remote/inline
  images, consistent with the v1 non-goal on attachments. This requires a small
  CSP `img-src` change (§7).
- **Storage:** the raw Markdown source is stored verbatim in `content`. It is
  **not** HTML-sanitized on the way in (that would corrupt the source). Length,
  UTF-8 validity, **and a structural Markdown check (§4.1)** are enforced on
  write; all three only accept or reject — none alters the stored bytes.
- **Editing — CodeMirror 6.** The editor uses CodeMirror 6 with its Markdown
  language mode (`@codemirror/lang-markdown`) for syntax-aware highlighting of
  the source. It is a source editor (not WYSIWYG); the rendered result is shown
  in a separate preview pane.
- **Rendering — markdown-it + DOMPurify.** A client-side Markdown library
  (recommended: `markdown-it`) converts the source to an HTML string, which is
  then **sanitized with DOMPurify** before being inserted into the DOM. DOMPurify
  is the authoritative XSS gate (see §7). markdown-it runs with **`html: true`**,
  so embedded HTML in the source is passed through into the rendered output
  (rather than escaped to literal text) and then gated by DOMPurify. This same
  pipeline drives both the live preview in the editor and the read view.
- **No server render endpoint and no `content_html`.** There is no `POST
  /render`; the previous server-rendered `content_html` field is removed. Live
  preview is instantaneous and local — no round-trips.

### 4.1 Server-side Markdown validation (write-time gate)

CommonMark/GFM have **no notion of "invalid" Markdown** — every byte string is a
well-formed document, and a parser never errors on content. "Validation" here is
therefore **not** a parse-success check (which would never reject anything); it
is a **structural allow-list** over the parsed document. On **create and update**
(`POST /notes`, `PATCH /notes/{slug}` when `content` is present) the service
parses `content` with **Goldmark** (`github.com/yuin/goldmark`, configured to
match the client's enabled feature set — GFM tables, strikethrough, and
linkify/autolinks, wired via Goldmark's **individual** extensions
(`extension.Table`, `extension.Strikethrough`, `extension.Linkify`) **rather than
the `extension.GFM` bundle**, so Goldmark's GFM **task-list** parser stays off and
the server mirrors the client's no-task-lists feature set (§4). (Even if the
task-list parser were on it would be harmless to this gate, which only walks
HTML/link/image/nesting nodes — a task-list item is just a list item with a
checkbox node the walk ignores — so this is a fidelity choice, not a correctness
one.) **Raw HTML and images need no extra parser option** — both are
CommonMark-core and already appear in Goldmark's default AST as
`ast.KindRawHTML`/`ast.KindHTMLBlock` and `ast.KindImage` nodes, which is all this
gate walks. `WithUnsafe` is a *renderer* option governing HTML **output** and is
irrelevant here, since the content is never rendered server-side) and walks the
resulting AST, rejecting the write with
`service.ErrValidation` → `400` if any of the following appears:

- **Embedded HTML with disallowed elements, attributes, or schemes.** Embedded
  HTML is **allowed** in notes, but every raw-HTML fragment is validated with
  **bluemonday** (`github.com/microcosm-cc/bluemonday` — the template's existing
  `internal/sanitize` package, retained rather than removed). The service pulls
  each inline `ast.KindRawHTML` and block `ast.KindHTMLBlock` fragment out of the
  Goldmark AST and runs bluemonday over **just those fragments**; bluemonday is
  **never** run over the whole `content`, because it is an HTML sanitizer and
  would corrupt Markdown (escaping `&`→`&amp;`, mangling `<` in ordinary text,
  rewriting Markdown that merely looks HTML-ish). If bluemonday would strip or
  alter a fragment, that fragment carries disallowed HTML (a `<script>`, an
  `onerror=` handler, a `javascript:` href, …) and the **whole write is rejected**
  (`service.ErrValidation` → `400`). bluemonday's cleaned output is used **only
  for the accept/reject decision** and is never stored — accepted content is
  stored byte-for-byte verbatim (§4 Storage).
  - **Reject only on real changes, not reformatting.** bluemonday canonicalizes
    HTML (quotes attribute values, closes void tags: `<br>`→`<br/>`), so a byte
    compare of `bluemonday(fragment)` against the raw fragment would falsely
    reject benign HTML it merely reformatted. Compare instead against a
    **canonical re-serialization of the original fragment through the same HTML
    tokenizer** (`golang.org/x/net/html`, which bluemonday itself uses): pure
    formatting differences cancel on both sides, so only genuinely stripped or
    rewritten (i.e. unsafe) content trips the rejection. The comparison is at the
    **token-stream level** (re-emit each tokenizer token), matching how bluemonday
    processes input — *not* a parse-tree (`html.Parse`) balancing. This matters
    because inline raw HTML tokenizes **one tag at a time**: a CommonMark inline
    `<a href="https://x">text</a>` is two separate `ast.KindRawHTML` nodes
    (`<a href="https://x">` and `</a>`) with the link text parsed as Markdown in
    between, and each node is validated on its own. A lone start or end tag
    re-serializes **identically** on both sides (no auto-balancing is introduced),
    so a safe lone tag is never falsely rejected; only a fragment bluemonday
    actually strips or rewrites diverges and trips the rejection. (Block HTML is
    captured whole as one `ast.KindHTMLBlock` node and validated the same way.) For this to hold the
    validation policy must be configured **removal-only** — it must **not inject
    or rewrite** attributes. `UGCPolicy()` stays the base (next bullet), but every
    attribute-injecting default it sets must be **explicitly turned off** on the
    policy: `RequireNoFollowOnLinks(false)`,
    `RequireNoFollowOnFullyQualifiedLinks(false)`, `RequireNoReferrerOnLinks(false)`,
    `RequireNoReferrerOnFullyQualifiedLinks(false)`,
    `AddTargetBlankToFullyQualifiedLinks(false)`, and
    `RequireCrossOriginAnonymous(false)` — so no `rel="nofollow"`,
    `rel="noreferrer"`, `target="_blank"`, or `crossorigin` is ever added. Any such
    addition would make even safe HTML (a plain `<a href="https://x">`) differ from
    its re-serialization and be falsely rejected. The policy strips disallowed
    content; it never augments allowed content. **A milestone-3 spike must assert
    this round-trips** — a plain `<a href="https://x">…</a>`, a `<br>`, and a
    representative slice of the broad allow-listed set (§4.1, §10) pass the gate
    **unrejected** — so that a missed injector (or one a future bluemonday version
    adds) is caught before it false-rejects benign notes rather than in production.
  - **Policy = a broad "safe HTML" allow-list.** The goal is to accept **any tag
    that is safe and reasonable to embed in Markdown**, not just the few tags
    markdown-it itself emits. The server's bluemonday policy uses
    **`bluemonday.UGCPolicy()`** as its base — the library's purpose-built
    safe-user-content profile (prose, headings, lists, tables, blockquotes, code,
    inline semantics like `sub`/`sup`/`kbd`/`abbr`/`mark`/`del`/`ins`,
    `details`/`summary`, `figure`, `div`/`span`, `a`, `img`), which **excludes**
    the dangerous/interactive set (`script`, `style`, `iframe`/`object`/`embed`,
    `form`/`input`/`button`, raw media) and all `on*` event handlers. To it we add
    the project's URL rules (and disable the additions noted above). On `<a href>`
    keep `http`/`https`/`mailto` and relative URLs. On `img@src` allow **only
    `https`, relative URLs, and the canonical `data:` raster set** —
    `data:image/(gif|png|jpeg|webp);` (note the required trailing `;`, §7 defense 2;
    UGCPolicy omits `data:`), **excluding `data:image/svg+xml`** and **dropping
    `http`** — so an embedded-HTML `<img>` obeys the same rule as a Markdown-native
    image (the bullet below): no `http` images are stored, matching the "reject up
    front rather than render a silently-broken image" decision. bluemonday enforces
    the per-element `img@src` rule with a `Matching` regexp on the `src` attribute
    (ANDed with the global scheme policy), so an `http` or non-canonical `data:`
    `src` is stripped — which trips the canonical-reserialization compare (above)
    and **rejects the whole write**. The client DOMPurify
    config (§7) is set to the **same** element/attribute/scheme profile so the two
    gates agree on "safe HTML."
  - **Parity is a goal, not a security dependency.** Because DOMPurify is the
    authoritative render-time gate (§7 defense 3), a divergence is at worst a UX
    wrinkle, never a hole: if the server accepts something DOMPurify later strips,
    the note just renders without that fragment; if the server rejects something
    DOMPurify would keep, the user sees a `400`. Neither is unsafe. Milestone 7
    pins the two against a **shared test vector** (§10) so they stay aligned, but
    they need not be byte-identical.
  - **The same disclaimer covers linkify divergence.** markdown-it's `linkify`
    (`linkify-it`) and Goldmark's linkify recognize **different** bare-text
    URL/email patterns (e.g. `www.host` with no scheme, and differing email/IP
    heuristics), so a bare string the client auto-links into an anchor may stay
    plain text on the server — and thus skip the server's Markdown-native scheme
    check (below) — or vice-versa. This is **not** a security gap: any link the
    client actually renders still passes markdown-it `validateLink` **and**
    DOMPurify (the authoritative render-time gate, §7 defense 3), which enforce the
    scheme rules regardless of whether the server's parser saw the same link. The
    server-side scheme check is defense-in-depth over the links Goldmark *does*
    recognize, never a guarantee that the two linkifiers produce identical link
    sets. (Linkified destinations are always `http`/`https`/`mailto`, the
    allow-listed schemes, so even when the server does recognize them they pass.)
- **Disallowed URL schemes in Markdown-native links/images** — bluemonday (above)
  governs schemes *inside embedded HTML*; Markdown link/image **syntax** parses as
  `ast.KindLink` / `ast.KindAutoLink` / `ast.KindImage` nodes (not HTML), so the
  service checks **those** destinations separately against the scheme allow-list,
  which **differs by destination kind** (mirroring §7):
  - **Links** (`ast.KindLink` / `ast.KindAutoLink`): `http`, `https`, `mailto`.
  - **Images** (`ast.KindImage`): `https` and the canonical `data:` raster set
    only — **`http` is *not* allowed on an image destination.** (An `http` image
    only ever gets blocked at load time by CSP `img-src`, rendering a
    silently-broken image with no feedback, so the write is rejected up front
    instead.) The `data:` allowance is the **canonical four raster subtypes**,
    expressed as the regexp **`^data:image/(gif|png|jpeg|webp);`** — note the
    **required trailing `;`** (the subtype must be followed by a media-type
    parameter such as `;base64,`). This is **markdown-it's default `validateLink`
    `data:` rule verbatim** (`GOOD_DATA_RE = /^data:image\/(gif|png|jpeg|webp);/`,
    §7 defense 2), so it deliberately **excludes `data:image/svg+xml`** (an XSS
    vector — SVG can carry script), any other `data:image/...` subtype, **and** a
    parameter-less `data:image/png,…` (no `;`) — the server never stores a `data:`
    image the client refuses to render, and the SVG-script surface is closed at
    every gate. `data:` is **never** allowed on a link. (The `image/*` wildcard is
    *not* used — see §7 for the single canonical list shared by the server check,
    markdown-it `validateLink`, and DOMPurify.)

  Destinations that carry **no scheme** — root-relative (`/notes/x`, the in-app
  note links of §6 depend on this) and bare-relative (`foo`, `./bar`) — are
  allowed. **Scheme-relative destinations (`//host/...`) are rejected** on both
  links and images: they inherit the page scheme and reach an arbitrary external
  host (the same mixed-content/privacy surface as a remote image) while sitting
  outside the explicit scheme allow-list, so the write is rejected rather than
  silently stored. (Detecting one is a simple leading-`//` check on the
  destination.) Any explicit non-allow-listed scheme (`javascript:`, `vbscript:`,
  `file:`, `data:text/html`, …) is rejected as before. **Scheme comparison is
  case-insensitive** — a destination's scheme is lower-cased before it is matched
  against the allow-list (so `HTTP:`, `MailTo:`, `Data:Image/PNG;…` are treated
  identically to their lowercase forms), per RFC 3986 (URI schemes are
  case-insensitive) and matching DOMPurify's case-insensitive `ALLOWED_URI_REGEXP`
  (`/i`, §7), so the server check and the render-time gate agree on explicit-link
  verdicts. The `data:`-image subtype/parameter match (the canonical
  `^data:image/(gif|png|jpeg|webp);` regexp) is likewise applied case-insensitively
  to the scheme+subtype, consistent with that regexp's `/i`-equivalent use at the
  other gates.
- **Excessive nesting** — block/inline nesting deeper than **100** levels,
  matching markdown-it's `maxNesting: 100` default on the client and bounding
  parser/render cost. **Parity here is a goal, not a guarantee** (same disclaimer
  as the HTML and linkify divergences above): Goldmark counts AST depth while
  markdown-it's `maxNesting` counts its own parser recursion, so the two notions of
  "depth" do not correspond 1:1 and equal numbers do **not** strictly guarantee
  "anything the server accepts the client can also render." This is not a security
  gap — DOMPurify is the authoritative render-time gate (§7 defense 3), and the
  check's real job is **bounding parser/render cost** (a coarse DoS guard), for
  which any reasonable bound works. A divergence at the extreme (≈100-deep nesting)
  is at worst a rendering wrinkle on pathological input, never a hole.
- **C0 control characters** — `content` containing any C0 control character
  **except** tab (`U+0009`), newline (`U+000A`), and carriage return (`U+000D`) is
  rejected. This is a flat **byte** scan (it does **not** require the Goldmark
  parse), but it is part of the same write-time accept/reject gate. A byte scan
  suffices and is robust **independent of check ordering**: every C0 control is
  `< 0x80`, and a byte `< 0x80` is never a lead or continuation byte of a UTF-8
  multi-byte sequence, so a raw `0x02`/`0x03` (or any other C0 byte) is always a
  standalone control character — the scan catches every sentinel even on otherwise
  malformed input, so it does not depend on the separate UTF-8-validity check
  running first. (UTF-8 validity is still enforced as its own check, and the
  Goldmark parse below operates on the source regardless.) Its specific
  purpose is to guarantee the search-highlight **sentinels `U+0002`/`U+0003` (§8)
  truly never occur in stored note text** — so an FTS5 `snippet()` can use them as
  unambiguous `<mark>` delimiters without a user-supplied control char ever
  producing a stray/unpaired sentinel and a broken `<mark>` in a list row. Other
  C0 controls (form feed, vertical tab, NUL, etc.) carry no Markdown meaning and
  are rejected alongside them; the three whitespace controls above are the only
  ones meaningful in Markdown source and stay allowed. Like every other check here
  this only **accepts or rejects** — it never strips or rewrites the stored bytes.
  - **`title` rejects *all* C0 control characters** — including tab/newline/CR,
    which `content` allows. `title` is a single-line display string (shown as a
    list-row heading and used as the browser tab `<title>` on the read view — §6)
    with no legitimate use for any control character, and it is **FTS-indexed alongside `content`** (§8), so the
    same sentinel concern applies: a `U+0002`/`U+0003` in a title must never reach
    storage. This is the same flat rune scan (post-`TrimSpace`, §9), applied to the
    submitted title on **create and update**, rejecting with `service.ErrValidation`
    → `400`. (The tab/newline/CR exception is `content`-only because those carry
    Markdown meaning in body source; a title has none.)

This check is enforced in the **service layer**, not by ogen: it is structural,
not a string `pattern`/`maxLength`, so `openapi.yaml` cannot express it (length
and UTF-8 remain ogen/service checks as before).

It is **defense-in-depth, not a replacement for the client XSS pipeline.** The
server runs bluemonday only to *decide* accept/reject and never stores its
output, so it never mutates content; and the client markdown-it→DOMPurify
pipeline (§7) stays the **authoritative** XSS gate, because (a) the server never
produces, sanitizes-into-storage, or serves HTML — it serves verbatim Markdown,
and (b) the design still treats any content reaching the browser as hostile
(older notes, or rows written outside the API, are not covered by this check).
The server stores the source **verbatim**; validation only accepts or rejects.

**Consequence (be explicit):** embedded HTML is **accepted** whenever every tag,
attribute, and URL scheme is in the safe allow-list — a broad set covering most
HTML people reasonably embed in Markdown (`<details>`/`<summary>`, `<sub>`/`<sup>`,
`<kbd>`, `<abbr>`, `<mark>`, `<figure>`, `<div>`/`<span>`, an aligned `<table>`, a
plain `<a>`/`<img>`, …). HTML carrying anything outside it — a `<script>`,
`<style>`, `<iframe>`, a form control, an `onerror=`/other event handler, or a
`javascript:`/`data:text/html` href — causes the **whole write** to be rejected
with `400`, surfaced via the existing `Toast` (§6). (To widen or narrow the set
later, change the bluemonday policy **and** the DOMPurify config together — §7.)
Text that contains `<`/`>` **without** forming a valid HTML tag (e.g. `a < b`) is
not HTML per CommonMark and always passes; empty `content` has no nodes and always
passes.

### Why this is safe (summary; full detail §7)

1. markdown-it runs with `html: true`, so embedded HTML in the source is rendered
   (not escaped) and then sanitized by DOMPurify (3); independently, the server
   pre-validates embedded HTML on write with bluemonday and rejects anything
   outside the safe allow-list (§4.1).
2. markdown-it's link validator (`validateLink`) is the coarse first pass. It is a
   **denylist, not an allow-list**: it *blocks* `javascript:`/`vbscript:`/`file:`
   and `data:` (except the canonical four raster image subtypes
   `data:image/(gif|png|jpeg|webp)`, excluding `svg+xml`), and **passes every other
   scheme it does not recognize as dangerous** — including `http`/`https`/`mailto`
   but also schemes outside the project allow-list such as `tel:`. It is therefore
   only a first cut at the *dangerous* schemes, not the authority on the
   three-scheme allow-list; the precise allow-list is enforced server-side (§4.1)
   and, on render, by DOMPurify. DOMPurify is the authoritative
   second gate: it allows `http`/`https`/`mailto` everywhere but admits those
   `data:` images **only on `<img src>`** (and only those four subtypes), never on
   `<a href>` — so a `data:text/html` anchor is
   stripped (closing the known `data:`-link phishing vector). The `http`-on-images
   concern (mixed content) is handled not by the sanitizer but by CSP `img-src`
   (which omits `http`), so an `http` image stays in the DOM but never loads
   (see §7).
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

**Response bodies for mutations.** `POST /notes` (`201`) and `PATCH
/notes/{slug}` (`200`) both return the **full `Note` JSON object** (the schema
below), exactly as the template's `CreateItem`/`UpdateItem` return `*api.Item`.
This is load-bearing, not merely conventional: the editor's post-save navigation
and dirty-snapshot reset (§6) read the **final** `slug` from this body — which on
create may have been auto-generated or collision-suffixed, and on a `PATCH`
rename is the new slug (§3.1). A bare `201`/`Location`-only response (no body)
would break that flow. `GET /notes/{slug}` likewise returns the full `Note`;
`DELETE` returns `204` with no body; `/download` returns the raw Markdown body
(see below).

The `{slug}` **path parameter** carries the slug `pattern`/`maxLength` constraint
(§3.1) on **every** `/notes/{slug}*` route, including `/download`. A path that
violates the pattern is rejected by ogen's request validation (a `400`) before
the handler runs; only a well-formed but unknown slug reaches the handler and
yields `404`.

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
- **ogen wiring (decided):** `Content-Disposition` is declared as a **response
  header on the `200` response in `openapi.yaml`**, so ogen generates a setter on
  the download response type and the header is set through the generated
  `api.Handler` interface (the download stays inside the generated handler — no
  side route). The `text/markdown; charset=utf-8` media type is declared as the
  response content (`string` schema → raw body, see above). If a future ogen
  version cannot express a raw body together with a response header, fall back to
  a thin non-ogen route — but the contract above is the intended implementation.
  - **Validate with a spike before relying on it.** Emitting a raw `string`/bytes
    body *together with* a settable response header on the same `200` is not
    exercised anywhere in the current template (the generated code only emits
    `application/json`), so milestone 1 must include a quick `ogen` run that
    confirms the generated `api.Handler` exposes both the raw body and the
    `Content-Disposition` setter. The spike should also confirm the emitted
    `Content-Type` — ogen may serialize a `text/markdown` content declaration
    without the `; charset=utf-8` parameter. The exact parameter is cosmetic
    (browsers default `text/*` to UTF-8), so if ogen drops it that is acceptable;
    just record the actual header the generated code produces rather than
    assuming the literal `text/markdown; charset=utf-8`. The spike must also
    confirm the **empty-content case**: a note with empty `content` must download
    as a `200` with a zero-length body and a correct `Content-Disposition` header
    (per §5), since ogen may serialize an empty `string` response body specially —
    verify it emits an empty body rather than omitting it or erroring. The spike
    must **also** confirm the **mixed-media-type response shape**: this one
    operation declares a `text/markdown` (raw `string`) body on `200` but the
    standard `application/json` `{"error": …}` body on `404` (and other errors).
    Emitting different content types per status code on a single operation — with
    one of them a raw string body — is a distinct assumption from the raw-body +
    header one; verify ogen generates a usable handler/response type for it. (Any
    of these three checks failing is a trigger for the thin-route fallback below.)
    Treat milestone 1 as incomplete until this is verified, not assumed.
  - **Fallback routing:** if the fallback thin route is needed, register it at its
    fully-qualified path `/api/v1/notes/{slug}/download` (under the same `/api/v1`
    base as every other note route — see "URL prefix" below). Go 1.22+'s enhanced
    `net/http.ServeMux` (this project is on Go 1.26) matches the **most specific**
    pattern regardless of registration order, so the precise download pattern wins
    over the `/api/v1/` ogen mount without any ordering dance. The thin route
    reuses the service's get-by-slug and sets the headers by hand, and it must be
    wrapped in `handler.WithMiddleware` (the same recovery/no-store/gzip chain the
    ogen mount uses — see `internal/handler/middleware.go`) so it does not bypass
    those cross-cutting concerns; a route registered bare on the mux would skip
    them. On an unknown slug (`service.ErrNotFound`) the thin route must emit the
    **standard `{"error": "message"}` JSON body with a `404`**, reusing the same
    error encoder as the ogen handler (do not hand-roll a different error shape),
    so the fallback's error responses are byte-identical to every other route's.
- **URL prefix (every `/notes/*` route, including `/download`).** The paths in the
  endpoint table and §6 are written **relative to the `/api/v1` base**; the actual
  served URL of the download is `/api/v1/notes/{slug}/download`. This matters for
  the frontend: a link to a bare `/notes/{slug}/download` would **not** be served
  by ogen (mounted only under `/api/v1/`) — it would fall through to
  `staticHandler` and silently return `index.html` (the SPA shell) instead of the
  Markdown. The "Download Markdown" link target in §6 is therefore
  `/api/v1/notes/{slug}/download`.
- **Body is the verbatim stored Markdown** — the same source returned in
  `Note.content`, byte-for-byte, with no HTML conversion and no sanitization
  (consistent with §4: the server never produces HTML). "Byte-for-byte" refers
  to the **decoded entity body**: the download is served through the same
  `handler.WithMiddleware` chain as every other route, so the gzip middleware
  may compress it on the wire — that is transparent transfer-encoding and the
  bytes the client decodes are identical to `Note.content`. (The chain's
  `Cache-Control: no-store` also applies and is harmless for a saved file.) A
  note with empty
  `content` downloads as a **`200` with an empty body** (empty Markdown is valid,
  per the create constraints) — not `204` and not an error.
- **Range requests are not supported.** The ogen-generated (or fallback) handler
  emits the whole body and does not honor a `Range` header; this is acceptable for
  a personal tool (notes are small). The empty-content download (`200`, zero-length
  body, `Content-Disposition` set) should be **smoke-tested in a real browser**
  during the milestone-1 spike, since some browsers handle a zero-length
  attachment download inconsistently — verify it actually saves an empty `.md`.
  The spike must **also** confirm the gzip middleware behaves sanely over the
  zero-length body: most gzip layers skip bodies below a min-length threshold
  (emitting the empty body uncompressed, no `Content-Encoding`), but since this
  empty-download path is load-bearing, inspect the actual on-wire response rather
  than assuming — a `Content-Encoding: gzip` (or a non-empty compressed stream)
  over an empty body is the failure mode to rule out. **If the gzip layer mis-handles
  the empty body, the thin-route fallback is *not* the fix** — the fallback is
  wrapped in the **same** `handler.WithMiddleware` chain (and therefore the same
  `go-server-common` gzip layer, per the fallback-routing bullet above), so it
  inherits the identical behavior. The remedy is instead to **bypass gzip for the
  download route specifically** (omit the gzip wrapper from this one route's
  middleware chain, or confirm the layer's min-length threshold already skips the
  zero-length body). In practice gzip middleware almost always skips sub-threshold
  bodies, so this is expected to be a no-op; the spike confirms it rather than the
  thin-route fallback, which only addresses the ogen raw-body/header generation
  question, not gzip.
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

UpdateNoteRequest (all optional; absent = leave unchanged):
  title    (same constraints as create: 1..200 when present)
  content  (same constraints as create: 0..1000000 when present)
  slug     (same constraints as create: pattern + maxLength 100 when present)

  - **Field constraints mirror create.** `UpdateNoteRequest.slug` carries the
    identical `pattern`/`maxLength: 100` as `CreateNoteRequest.slug`, and
    `title`/`content` their identical bounds, so a present PATCH field is
    validated by ogen exactly as on create (no second, weaker validation path).
  - **Absent vs. `null`.** The optional fields are generated as ogen `Opt*`
    wrappers (non-nullable). An **absent** field means "leave unchanged"; an
    explicit JSON `null` is **not** a recognized value and is rejected by ogen
    request validation as `400` before the handler runs. Only "field absent"
    vs. "field present with a valid value" matters to the service — there is no
    null-clears semantic (to clear `content`, send `content: ""`). **This
    `null`-rejection applies to the optional fields of `CreateNoteRequest`
    (`content`, `slug`) too**, for the same reason: they are non-nullable ogen
    `Opt*` wrappers, so a `content: null` (or `slug: null`) on create is an ogen
    `400`, never coalesced to `""`/auto-generation — that coalescing is for the
    **absent** (Opt-unset) case only (§9). The rule is a property of how every
    optional request field is generated, not specific to update.
  - A present `content: ""` clears the body (empty content is valid, per the
    create constraints); only an absent field leaves it unchanged.
  - A PATCH that **actually changes** at least one field sets `updated_at = now`
    (UTC), including a slug-only rename — so renaming a note reorders it in the
    browse list (`updated_at DESC`). `created_at` is **immutable** after create —
    no request field touches it and PATCH never rewrites it.
  - **No-op fields don't bump `updated_at`.** A present field whose value equals
    the note's current value is not a change: e.g. a PATCH that sets `slug` to the
    note's own current slug (a no-op, not a conflict — §3.1) leaves `updated_at`
    untouched and does not reorder the note. Only fields whose value differs from
    the stored value count toward "actually changed."
  - A PATCH with no recognized fields (all absent) is rejected as `400`
    (`service.ErrValidation`), not treated as a no-op. (Distinct from the case
    above: there a field *is* present, it just matches the current value.)

Error: { error: string }
```

**Field optionality in `openapi.yaml`.** All **response** fields are declared
`required`, so ogen emits plain (non-`Opt`) Go fields and `openapi-typescript`
emits non-optional TS properties. In particular `NoteSummary.excerpt` is
**required**: an empty excerpt (empty-content note, or a title-only match on an
empty-content note — §8) is the empty string `""`, never an absent field. The
full required set is: `Note` → `slug`, `title`, `content`, `created_at`,
`updated_at`; `NoteSummary` → `slug`, `title`, `updated_at`, `excerpt`;
`NoteList` → `total`, `notes`. Only the **request** bodies carry optional fields
(`CreateNoteRequest.content`/`slug`, all of `UpdateNoteRequest`), per their
sections above.

The list `excerpt` is a **single string field**, never HTML — see §8. Its text is
a slice of the **raw Markdown source**, shown **verbatim**: Markdown syntax is
**not** stripped in v1, so literal markup (`##`, `[text](url)`, fences, `*`, …) may
appear in list rows. This keeps both excerpt paths trivial — the browse prefix is a
plain substring and the search snippet is FTS5 `snippet()` output with no
post-processing beyond the sentinel→`<mark>` step. (A Markdown-to-plain-text pass is
a deliberate non-goal for v1; if added later it must strip the browse prefix **and**
the search snippet while preserving the `U+0002`/`U+0003` highlight sentinels.) It
is one field for both cases:
- **Browsing (no `q`):** a plain prefix of the source truncated to ~200
  characters at a word boundary, with a trailing `…` when truncated; no markers.
  **"Characters" means Unicode runes** (counted as `utf8.RuneCountInString`, the
  same unit as the `maxLength: 200` title rule in §3), never bytes — a cut must
  always land on a rune boundary so the excerpt is valid UTF-8 and never splits a
  multi-byte rune. Because the trailing `…` itself counts within the 200-rune
  budget, the prefix is cut so that **prefix + `…` ≤ 200 runes** — i.e. the prefix
  is at most **199** runes. **A "word boundary" is the last Unicode-whitespace
  position at or before rune 199**; the prefix is cut there and the trailing `…` is
  appended (total ≤ 200). When the first 199 runes contain no whitespace boundary
  (e.g. CJK text, a long URL, or an unbroken code blob), fall back to a **hard cut
  at 199 runes** (still on a rune boundary) before appending `…`, so the excerpt is
  always bounded at 200 runes. A note with empty `content` yields an empty
  `excerpt`.
  - **When `…` is appended (no spurious ellipsis at the boundary).** The `…` is
    added **only when the source is actually longer than the displayed prefix** —
    i.e. when the content exceeds 200 runes. Implemented over the `substr(content,
    1, 201)` probe (§9): the probe returns **201** runes exactly when the content is
    longer than 200 (so truncation is needed and `…` is appended); a probe result
    of **≤200** runes is the *entire* content, which is shown **verbatim with no
    `…`** (a 200-rune note is not truncated). In particular content of exactly 200
    runes must not gain a trailing `…`.
- **Searching (`q` present):** an FTS5 `snippet()` — a short window (~30 tokens)
  centred on the match, so this branch is **token-bounded** and does **not** share
  the browse branch's 200-rune budget above; the two excerpt shapes deliberately
  differ (a match-centred window vs. a leading prefix). Because it is token-bounded
  rather than rune-bounded, `NoteSummary.excerpt` carries **no `maxLength`** in
  `openapi.yaml` (it is `required` but unbounded). In the normal case the ~30-token
  window is small; the one pathological case is content with a single enormous
  whitespace-free token (FTS5 treats it as one token, so a snippet centred on it can
  be large) — accepted for v1, since `content` is already capped at 1,000,000
  characters and this is a single-user tool. Its matched terms are
  wrapped in **non-HTML sentinel delimiters** (`U+0002` start, `U+0003` end) that
  cannot occur in stored note text — **write-time validation rejects content
  containing these (and other C0 controls except tab/newline/CR), §4.1**, so the
  sentinels are guaranteed unique and always well-paired. The client HTML-escapes
  the entire string, then replaces the sentinel pairs with `<mark>…</mark>`.
  Because escaping happens first, the wrapped content is inert; the sentinels are
  the only thing ever turned into markup.
  - **Sentinel transport over JSON (no special handling).** `U+0002`/`U+0003` are
    C0 control characters, which JSON forbids *unescaped* in a string. This needs
    **no special code**: Go's `encoding/json` (used by ogen) automatically emits
    them as `\u0002`/`\u0003` on the wire, and the browser's `JSON.parse` restores
    the raw runes — so the client's `String.replace` sees the actual `U+0002`/
    `U+0003` runes after parsing. Do **not** pre-escape the sentinels to literal
    `\u0002` text in the repository or hand-handle them at the JSON boundary; doing
    so would either double-escape them or leave literal text the client's
    sentinel→`<mark>` replacement never matches.

### Constraints (declared in `openapi.yaml`, per template security guidance)

- `title`: `minLength: 1`, `maxLength: 200`. Required. (The editor auto-fills it
  client-side; the server does not derive it.)
- `content`: `maxLength: 1000000` (1,000,000 characters). Worst-case UTF-8 is
  ~4 MiB, comfortably under the 10 MiB request-body cap. Beyond length/UTF-8,
  `content` is **structurally validated** in the service layer on every write
  (Goldmark parse + AST allow-list, §4.1); a structural violation is a `400`
  (`service.ErrValidation`). This check cannot be expressed in `openapi.yaml`, so
  it is not part of ogen request validation.
- `slug`: `maxLength: 100`, `pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$'`.
- `q`: **optional**, `maxLength: 200`, **no `minLength`**. It must be declared
  not-required and without a `minLength`, because an **absent** `q` and a
  **present-but-empty** `q` (`?q=`) are both valid "browse" inputs (§8): a stray
  `minLength: 1` would make `?q=` an ogen `400` before the service's empty-⇒-browse
  rule runs. (Whitespace-only `q` is also browse — handled in the service, not by
  ogen.)
- `limit`: 1–200, default 50 (`minimum: 1`, `maximum: 200`). `offset`: ≥ 0,
  default 0 — a `minimum: 0` **only; no `maximum` is declared, intentionally.**
  With a fixed `limit`, the largest `offset` the "Load more" flow issues grows
  without bound as the collection grows (§6), so a `maximum` on `offset` would
  break paging past that point; do **not** add one for symmetry with `limit`.
  These bounds are
  declared as `minimum`/`maximum` on the query parameters in `openapi.yaml`, so
  an **out-of-range value is rejected by ogen request validation as `400`**
  (consistent with the malformed-slug `400` above) — the handler never clamps.
  The frontend must therefore keep its computed `limit`/`offset` within range
  (clamp before sending) rather than relying on server-side clamping. **For
  `offset` this clamp is the lower bound only** (`offset >= 0`): since no
  `maximum` is declared, there is no upper value to clamp against, and the
  "Load more" flow only ever advances `offset` by a positive multiple of `limit`
  from `0`, so in practice it never violates even the lower bound — the clamp is
  a defensive floor, not an active constraint. `limit` is clamped to its full
  `1..200` range. An in-range
  `offset` **at or beyond `total`** is **not** an error: it returns `200` with an
  empty `notes` array and the true `total` (the natural SQLite `LIMIT/OFFSET`
  result for a past-the-end page), so a client that over-pages (e.g. because
  `total` shrank under a concurrent delete) simply gets an empty page, never a
  `400`/`404`.

### Status codes

- `201` create, `200` get/update/list/download, `204` delete.
- `400` validation (`service.ErrValidation`), `404` not found
  (`service.ErrNotFound`), `409` slug conflict on explicit user-supplied slug
  (new sentinel `service.ErrConflict` → `409`). Auto-generated slugs never
  conflict (the service resolves them), so `409` only arises when the client
  insists on a specific taken slug.
- **`DELETE` of an unknown slug is `404`, not idempotent.** A well-formed but
  unknown slug resolves to `service.ErrNotFound` → `404` (a malformed slug is the
  earlier ogen `400`); `204` is returned **only** when a row was actually deleted.
  `DELETE` is therefore **not** idempotent — re-deleting an already-deleted note
  yields `404`, which is the stale-tab case the UI handles with a Toast + navigate
  to the list (§6).

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
  Interception applies **only** to in-app routes (`/`, `/new`, `/notes/{slug}`,
  `/notes/{slug}/edit`). Links to other paths — notably the
  `/api/v1/notes/{slug}/download` Markdown download and any external/absolute
  URL — are **not** intercepted; they perform a real browser navigation so the
  `Content-Disposition` download (and the editor's unsaved-changes guard) behave
  correctly.
- All API calls go through `api` in `web/ts/api/client.ts` (no direct `fetch`
  from components — template convention). Add a `notes` client mirroring the
  existing `items` client. (There is no `render` call — rendering is local; §4.)

### Views

- **List/search (`/`):** search input (debounced, drives `q`), results show
  title, updated time, plain-text excerpt, and search highlights when searching.
  "New note" and "Upload Markdown" buttons. Empty and loading states.
  - **`q` length cap (client-side).** `q` carries `maxLength: 200` in
    `openapi.yaml`, enforced by ogen request validation (a `400` for an
    over-length value, §5). The search box must therefore cap the query at 200
    runes before sending rather than relying on the server, so a long paste never
    surfaces a confusing validation `400` through the `api` client. The cap is a
    **silent truncation of the outgoing `q`** (the text actually sent to `GET
    /notes`) to its first 200 runes; the input field itself is not hard-blocked,
    matching the silent-truncation approach used for the title auto-derivation (§3)
    and upload filename/title (§6). **Count runes,
    not UTF-16 code units:** ogen's `maxLength` counts Unicode code points (matching
    Go's `utf8.RuneCountInString`), whereas the HTML `maxlength` attribute and a
    naive `String.length`/`.slice` count UTF-16 units, so astral characters (emoji)
    are mis-measured. Cap with a code-point operation (e.g. `[...q].slice(0, 200)`)
    rather than the `maxlength` attribute. (The same rune-counting rule applies to
    every client-side "character" count/truncation in this spec — the title
    auto-derivation truncation in §3 and the upload size pre-check in §6 — so the
    client and server agree on the boundary. Capping in UTF-16 units fails *safe*
    here, since runes ≤ UTF-16 units, but yields a stricter-than-intended limit.)
  - **Paging — "Load more" button.** The list fetches the first page with the
    default `limit` (50) and `offset` 0, then renders a **"Load more" button**
    whenever more results remain. Clicking it requests the next page (same
    `limit`, `offset` advanced by the number of rows **received from the server**
    so far — a multiple of `limit`, per **Bounds** below — **not** the count of
    rows currently displayed, which the slug de-duplication below can make
    smaller) and **appends** the new rows to the list. The two counters are
    therefore tracked separately: `offset` follows the server (cumulative rows
    fetched), while the displayed count (`loaded`, the de-duplicated accumulated
    rows) drives the button. The button is shown while
    `loaded < NoteList.total` and hidden once all rows are loaded; `total` is
    also shown informationally (e.g. a result count). This applies **identically
    to browsing and searching** — the same accumulate-and-append flow runs whether
    or not `q` is present.
    - **`total` is best-effort, not transactionally consistent with the page.**
      The page query and the `COUNT(*)` are separate statements (§9), so a
      concurrent create/delete (multiple tabs, or a double-clicked Save) can leave
      `total` momentarily out of step with the rows returned. This is acceptable
      for a single-user tool (same last-write-wins stance as the racy slug check,
      §3.1) and self-corrects on the next fetch. The client must therefore tolerate
      both directions: treat `loaded >= total` as "all loaded" (hide the button),
      and treat a "Load more" that returns an empty page (offset past a shrunk
      `total`, §5) as the end of the list (hide the button, keep the rows already
      shown). It never errors on either.
    - **Reset on query change.** Changing the search box (or clearing it) starts a
      fresh result set: the accumulated rows are discarded and `offset` resets to
      0 before the first request, so pages from a previous query are never mixed
      in. (Each `GET /notes` request carries the current `q`.)
    - **De-duplicate appended rows by slug.** Offset-based paging over an
      `updated_at DESC` ordering is **not** stable under concurrent writes: a
      create/edit between two page fetches shifts rows across the page boundary, so
      a note already shown can reappear in the next page (or, symmetrically, a row
      can be skipped). To avoid a **visibly duplicated** list row, the client
      **drops any incoming row whose `slug` is already in the accumulated list**
      when appending (`newRows.filter(r => !shown.has(r.slug))`, keyed by the
      unique `slug`). This is purely cosmetic de-duplication on top of the
      best-effort `total` (above) — both follow the same single-user,
      last-write-wins stance (§3.1); a skipped row is accepted and self-corrects on
      the next fresh fetch. It is **not** a guarantee of a transactionally
      consistent page.
    - **Bounds.** `limit` stays at the in-range default (50) and `offset` is only
      ever advanced by a multiple of it, so both remain within their declared
      ranges (§5: `limit` 1–200, `offset` ≥ 0); the client still **clamps both
      before sending** per §5 rather than relying on the server. With a fixed
      `limit` of 50 the largest `offset` the UI issues grows with `total` and
      stays valid.
  - **Upload Markdown (create from file).** A file picker (accepting `.md`/
    `.markdown`/`text/markdown`/`text/plain`) reads a single chosen file
    **client-side** as UTF-8 text and creates a note from it via the existing
    `POST /notes` — **no new API or server support is required**. The file
    bytes become the note `content` verbatim (Markdown is stored as-is, §4); the
    file is never persisted or attached (see §1 non-goals).
    - **Title** is derived client-side, reusing the **first-ATX-heading** rule
      already specified for the editor (§3 / O-6: Setext ignored, fenced-code
      lines skipped, truncated to 200 chars with a trailing `…` if longer). If
      the content has no usable heading, fall back to the **filename with its
      extension stripped** (e.g. `meeting-notes.md → "meeting-notes"`), itself
      trimmed and truncated to the `maxLength: 200` title limit **the same way as
      the heading rule** — i.e. truncated to 200 runes with a trailing `…`
      (counted within the 200) when longer, so an over-long filename never
      produces a `400` for a title the user never typed. If that too is
      empty (e.g. a file named only `.md`), fall back to a non-empty default such
      as `"Untitled"`, so the mandatory `title` is always present.
    - **Slug** is **not** sent; the server auto-generates it from the title and
      resolves any collision by suffixing (§3.1), so repeatedly uploading files
      that derive the same title yields `my-title`, `my-title-2`, … rather than a
      `409`.
    - **Constraints/errors:** the file's text is subject to the same
      `content` `maxLength: 1000000` and UTF-8 validity checks as any create; a
      file exceeding the limit or failing to decode as UTF-8 is rejected
      client-side (or surfaced from the server `400`) via the existing `Toast`.
      The client **must rune-count the decoded text and reject oversized files
      before `POST /notes`**, because the 1,000,000-character `maxLength` (a
      `400` with the `{"error": …}` JSON body from ogen) and the 10 MiB
      `http.MaxBytesHandler` byte cap are different limits: a file over 10 MiB is
      truncated mid-stream by the body cap and does **not** produce a clean JSON
      `400`, so relying on the server response alone would surface a confusing
      error. The client pre-check gives a clear "file too large" Toast.
    - **On success**, navigate to the new note's read view (`/notes/{slug}`)
      using the slug returned by `POST /notes`.
- **Read (`/notes/{slug}`):** fetches `content`, renders it with the
  markdown-it → DOMPurify pipeline (§4), and injects the sanitized HTML into a
  constrained, styled container. "Edit", "Delete", and "Download Markdown"
  actions. 404 view for missing slugs.
  - **The stored `title` is *not* rendered in the read-view body.** A note's
    `content` almost always opens with its own `# heading` (that heading is exactly
    what the title auto-derives from, §3), so rendering a separate title `<h1>`
    above the body would duplicate it. The read view therefore shows **only** the
    rendered Markdown; the on-page heading comes from the content itself. The stored
    `title` is still used as the **browser tab `<title>`** (set on navigation to the
    read view), in list rows, and for search — just not injected as a body heading.
    (A note whose content has no leading heading simply renders without one; this is
    accepted for v1 and the title remains visible in the tab and list.)
  - **Malformed-slug deep links (decided).** `/notes/{slug}` is a valid SPA path
    even when `{slug}` violates the API slug pattern (e.g. `/notes/Bad_Slug!`),
    so the read flow does **not** pre-validate the slug client-side; it issues the
    fetch and maps a **`400` slug-pattern rejection from the API** (which ogen
    raises before the handler — §5) to the **same not-found view as a `404`**.
    This requires `web/ts/api/client.ts` to surface that `400` as a not-found
    signal on the `GET /notes/{slug}` path (e.g. the same `NotFoundError` it
    already throws on `404`), rather than the generic error `Toast` it raises for
    other non-OK statuses. The one extra round-trip for a malformed slug is
    acceptable. Because the **edit view** (`/notes/{slug}/edit`) loads the note
    through this **same** `GET /notes/{slug}`, the mapping applies to it
    identically: a malformed-slug deep link to the editor also renders the
    not-found view (it is the *initial* fetch, distinct from the stale-`404`-on-
    save case of §6, which Toasts and navigates to the list).
  - **Download Markdown** saves the note's raw source as `<slug>.md`. Preferred
    implementation: navigate/link to `GET /api/v1/notes/{slug}/download` (note the
    `/api/v1` base — a bare `/notes/...` link would hit the SPA fallback and return
    `index.html`, see §5 "URL prefix"). The href must be **root-absolute** (a
    leading `/`): the template's JSON `api` client uses a **relative** base
    (`const BASE = 'api/v1'` in `web/ts/api/client.ts`), and this download link is
    hand-authored *outside* that client, so reusing the relative form would resolve
    against the current path (e.g. on `/notes/my-slug` it becomes
    `/notes/api/v1/notes/my-slug/download`) and miss the route. Write the literal
    `/api/v1/notes/{slug}/download` with the leading slash. The endpoint's
    `Content-Disposition: attachment` triggers the browser save, keeping the
    raw-source path off the JSON `api` client. If routed through `api` instead,
    fetch the `text/markdown` body and save it via a `Blob` + object URL — but
    note `api` (§4, "Frontend networking") is built around JSON parsing, so the
    direct-link form is simpler and avoids buffering large notes **in the client's
    JS heap** (the server-side ogen handler buffers the body as a Go string either
    way — the "avoid buffering" benefit is client-side only, not a streaming
    download).
    - **Stale download (note gone) is *not* specially handled.** Because the
      preferred form is a real (non-intercepted, §6 routing) browser navigation
      that bypasses the `api` client, a note deleted or renamed in another tab
      makes Download land the browser on the raw `{"error": …}` JSON `404` page,
      replacing the SPA — it does **not** get the Toast + navigate-to-list
      treatment that Save/Delete's stale-`404` path does (§6 "Stale note"). This is
      accepted for a single-user tool: the race is rare, the user can navigate
      back, and routing Download through `api` purely to prettify this case is not
      worth the added Blob/object-URL code. (Same last-write-wins stance as §3.1.)
- **Editor (`/new`, `/notes/{slug}/edit`):**
  - Title input. While untouched, it auto-fills from the first **ATX** heading in
    the content as the user types (rules in §3 — Setext ignored, code fences
    skipped; truncated to 200 chars with a trailing `…` if the heading is
    longer); manual edits stop the auto-sync (O-6).
  - Slug field: auto-suggested from title for new notes; shown (and editable
    with a warning) when editing an existing note (O-4 — slugs are mutable; no
    redirects, so the UI warns that the URL will change).
    - **An *unedited* suggested slug is not sent — the server generates it.** On
      `/new`, the suggestion is a **display-only preview** of what the server will
      likely derive; while the user leaves it untouched the create request omits
      `slug` entirely, so the server auto-generates and **auto-suffixes** on
      collision (`my-title`, `my-title-2`, … — §3.1), exactly like the Upload flow.
      The field becomes an **explicit** slug only once the user edits it by hand;
      from then on it is sent verbatim and a collision is a `409` (§3.1, never
      silently suffixed). This keeps the common "just type a title and save" path
      free of surprising `409`s on duplicate titles, while still honoring a slug
      the user deliberately chose. (Tracking "did the user edit the slug?" mirrors
      the title auto-sync dirty flag of §3.)
  - **CodeMirror 6** Markdown source editor plus a **live preview** pane rendered
    locally (markdown-it → DOMPurify) on a debounced change of the editor
    contents. Split or toggle layout. No network round-trip for preview.
  - **Link to another note.** The editor offers an easy way to insert a link to
    an existing note at the cursor without hand-typing its slug. A "Link to
    note" action opens a picker that searches notes (reusing `GET /notes?q=`)
    and, on selection, inserts a Markdown link to that note's stable URL —
    `[<title>](/notes/<slug>)` — using the chosen note's title as the link text
    (editable afterward like any other text). The title is **escaped for link-text
    context** before insertion — backslash-escape `\`, `[`, and `]` — so a title
    like `TODO [urgent]` produces a valid link rather than broken Markdown. (The
    `<slug>` needs no escaping: the slug pattern already excludes `)` and every
    other character that is special in a link destination.) The inserted path is an in-app
    route (§6), so following it navigates within the SPA; it needs no new API or
    server support and passes through the same `validateLink`/DOMPurify gates as
    any other link (§7). For the relative `/notes/<slug>` href to survive
    DOMPurify, its `ALLOWED_URI_REGEXP` must admit relative URLs (§7) — without
    that, the inserted link would render hrefless.
    - **The picker shows only the first page (no paging).** It issues a single
      `GET /notes?q=` at the default `limit` (50) and does **not** offer
      "Load more" — notes beyond the first 50 matches are reached by **typing a
      more specific query** to narrow the result set, not by paging the picker.
      This is acceptable for a personal tool and keeps the picker simple; the list
      view's accumulate-and-append paging (above) is not reused here. (The empty-`q`
      case still browses, so an unfiltered picker shows the 50 most-recently-updated
      notes.)
    - **The note being edited is filtered out of its own picker.** When editing an
      existing note (`/notes/{slug}/edit`), the picker excludes that note from its
      results (`results.filter(n => n.slug !== currentSlug)`), so a note cannot be
      linked to itself. (On `/new` there is no current slug, so nothing is
      filtered.)
    - **Links use server-current slugs (mid-rename race accepted).** The picker
      shows each note's slug as returned by `GET /notes?q=`, so if a note is being
      renamed in another tab the inserted link can point at a soon-to-be-dead slug.
      This is accepted, not guarded — the same single-user, last-write-wins stance
      as the racy slug check (§3.1) and the best-effort paging above; a stale in-app
      link simply resolves to the §6 not-found view if followed after the rename.
  - Save (create/update) and Cancel. Unsaved-changes guard covering **both**
    intercepted in-app (pushState) navigations and real browser unload/reload
    (`beforeunload`).
    - **Cancel navigates context-aware, computed from the route (not browser
      history).** From `/notes/{slug}/edit` it returns to that note's **read
      view** `/notes/{slug}`; from `/new` it returns to the **list** `/` (there
      is no note to show yet). It does **not** use `history.back()`, so a fresh
      deep-link into the editor still cancels to a sensible destination rather
      than leaving the SPA. Cancel is an in-app `pushState` navigation, so it is
      subject to the unsaved-changes guard above: if the editor is dirty the user
      is prompted first, and only on confirmation does the navigation proceed.
      (Post-save navigation is separate — §6 "Post-save navigation" — and always
      goes to the read view built from the response slug.)
    - **"Dirty" is a value comparison against the last-saved snapshot**, not a
      keystroke counter. The editor holds a snapshot of the **last-saved** `(title,
      content, slug)` and is dirty whenever the current `(title, content, slug)`
      differs from it. **The `slug` component of the tuple is the *to-be-sent* slug,
      not the displayed suggestion.** On `/new` the slug field shows an
      auto-suggested *preview* that tracks the title, but the value compared in the
      dirty tuple is what a save would actually send — `undefined`/unset while the
      user has not manually edited the field (the same "did the user edit the slug?"
      flag that decides whether `slug` is sent at all, §6 editor), and the field's
      verbatim value once edited. This keeps the dirty check aligned with the send
      decision and preserves the net-zero guarantee below: reverting a title to `""`
      leaves the to-be-sent slug `undefined` again (no stale suggested-preview string
      lingering in the tuple), so the editor returns to clean. (On
      `/notes/{slug}/edit` the slug is unambiguous — the snapshot and current value
      are both the note's actual slug.) Consequences:
      - Typing and then reverting back to the saved value clears dirty — **no
        spurious prompt** for a net-zero edit.
      - **Auto-title-sync counts as dirty.** When the untouched title tracks the
        first heading (§3), that programmatic title change still diverges from the
        snapshot, so it marks the editor dirty (the user will want it saved).
      - **`/new` baseline is empty** `(title="", content="", slug unset)`, so a
        brand-new editor is *not* dirty until the user types something (or an
        auto-derived title appears); an immediately-abandoned `/new` prompts
        nothing.
      - The snapshot is updated **only on a successful save** (and seeded from the
        fetched note when opening `/notes/{slug}/edit`). A failed save (`409`/`400`,
        §6) does **not** update it, so the guard stays armed and the user can retry
        or navigate with a warning. The guard is also cleared explicitly before the
        post-save navigation below (the save's own `pushState` must not be blocked).
    - **Post-save navigation.** On a successful save the editor navigates to the
      saved note's **read view** `/notes/{slug}` in **both** cases — create
      (`/new`) and edit (`/notes/{slug}/edit`). The slug used is the one returned
      in the response body, never the slug the editor started with: a `POST`
      may have had its slug auto-generated or collision-suffixed (§3.1), and a
      `PATCH` may have **renamed** the slug, leaving the old `/notes/{old}/edit`
      URL dead — so the read-view target is always built from the response slug.
      The unsaved-changes guard is cleared before this navigation so the save's
      own `pushState` is not blocked.
    - **Stale note (404 on Save/Delete).** A `PATCH` or `DELETE` issued from a
      stale tab can target a slug that no longer exists (the note was deleted or
      renamed elsewhere), yielding `404`. In that case the UI shows a `Toast`
      ("This note no longer exists") and navigates to the list (`/`); it does
      **not** show the not-found view, which is reserved for direct deep-links
      (§6 Read). The same applies to the read view's **Edit**/**Delete** actions
      when the underlying note is already gone. (A `404` on the *initial* fetch
      of a read/edit view still renders the not-found view as before.)
  - Errors surfaced via the existing `Toast` component. A **slug conflict
    (`409`)** on save (an explicit or renamed slug already taken — §3.1) is
    surfaced as a **generic error `Toast` showing the server's `{"error": …}`
    message verbatim**; the server returns a clear message (e.g. `"slug already
    in use"`) for this case. No dedicated client error type or slug-field
    highlight is added in v1 — `client.ts` needs no special `409` branch, so the
    existing generic non-OK-status `Toast` path covers it.

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
    `lang-markdown`. **The bundle re-exports a fixed, minimal symbol surface**
    (decided), and the hand-authored `.d.ts` shim (see "TypeScript resolution"
    below) mirrors exactly this surface — there is no single upstream bundled
    `.d.ts`, so the shim is written by hand to match. The surface for v1 is:
    - From `@codemirror/view`: `EditorView` (used for the editor instance,
      `EditorView.updateListener` for live-preview-on-change and
      unsaved-changes detection, `EditorView.dispatch` for cursor insertion, and
      **`EditorView.lineWrapping`** — long Markdown lines wrap), `keymap`.
    - From `@codemirror/state`: `EditorState`, `EditorSelection` (resolve the
      cursor/selection for the "Link to note" insertion).
    - From `@codemirror/commands`: `defaultKeymap`, **`history` and
      `historyKeymap`** (undo/redo — Ctrl/Cmd+Z).
    - From `@codemirror/language`: `syntaxHighlighting`, `defaultHighlightStyle`
      (so the Markdown highlighting is actually visible).
    - From `@codemirror/lang-markdown`: `markdown` (the Markdown language mode).
    - **Not included in v1:** `@codemirror/search` (no in-editor find/replace),
      `lineNumbers`/active-line gutters, a `placeholder` (no empty-editor hint
      text), and bracket matching / auto-close brackets (`matchBrackets`,
      `closeBrackets`). Adding any later means extending both the bundle re-exports
      and the `.d.ts` shim together.
    - **Editor sizing/styling is done in CSS, not via a CodeMirror theme.** The
      minimal surface above intentionally omits `EditorView.theme`; the editor's
      height, borders, and font are set in `web/static/app.css` by targeting
      CodeMirror's stable DOM classes (`.cm-editor`, `.cm-scroller`, `.cm-content`).
      CodeMirror still injects its own structural styles as runtime `<style>`
      elements (covered by `style-src 'self' 'unsafe-inline'`, §7); the app CSS only
      sizes and skins the outer container. This keeps the bundle surface fixed and
      needs no extra export.
  - `vendor/markdown-it.js` — the Markdown renderer.
  - `vendor/dompurify.js` — the sanitizer.
- **Build pipeline change.** `build.sh` gains an `esbuild` bundling step before
  `tsc`, and **`esbuild` becomes a required tool on `$PATH`** (alongside `go`,
  `ogen`, `tsc`, `openapi-typescript`, `golangci-lint`). **`node` and `npm` also
  become required tools on `$PATH`** — `build.sh` runs `npm ci` (to fetch the
  `jsdom` dev dependency) and `node --test` for the client-side XSS-gate tests
  (§10), both after the `esbuild` and `tsc` steps. The bundles are
  committed like the existing vendored Preact files so the binary stays
  self-contained via `//go:embed`. (Update `CLAUDE.md` Build & Run accordingly
  during implementation — see §11 milestone 0.)
- **Import-map edit (required step).** The three bundles must be added as
  entries in the import map in `web/static/index.html` (alongside the existing
  `preact` entries), e.g. `"codemirror": "./vendor/codemirror.js"`,
  `"markdown-it": "./vendor/markdown-it.js"`, `"dompurify": "./vendor/dompurify.js"`.
  This is the one hand-edit the **runtime** vendoring requires.
- **TypeScript resolution for the bundles (required, else `tsc` fails).** The
  import map only satisfies the browser at runtime; `tsc` resolves bare specifiers
  separately. As it already does for Preact, `web/ts/tsconfig.json` needs a
  `paths` entry for each new bare import (`codemirror`, `markdown-it`,
  `dompurify`) pointing at a `.d.ts` type declaration under `web/ts/vendor/…`,
  with those declarations committed alongside (the upstream `@types/markdown-it`
  and `@types/dompurify`; for `codemirror`, a **hand-authored shim that declares
  exactly the bundle's re-export surface listed above**, since there is no single
  upstream bundled `.d.ts` to reuse).
  Because the project compiles with `noEmitOnError: true`, missing types for these
  imports are a hard `tsc` failure that blocks **milestone 6** (the frontend
  `tsc` compile) — milestone 5's `esbuild` bundling does not run `tsc`, so the
  failure surfaces when the app TypeScript is compiled, not when the bundles are
  produced. This is not optional. Keep `exclude: ["vendor"]` so the declarations themselves aren't
  compiled as sources.
- **CSP note.** CodeMirror injects its styles as runtime `<style>` elements,
  which the template's existing `style-src 'self' 'unsafe-inline'` already
  permits. No new `script-src` allowances are needed because the bundles load
  from origin and the import-map hash continues to be covered by
  `commonweb.ImportMapCSPHash` — that hash is computed at runtime over the import
  map contents (`main.go`: `commonweb.ImportMapCSPHash(web.Static)`), so adding
  the three entries changes the import map text but the `script-src` hash adapts
  automatically; **no manual hash value needs updating**. See §7.

---

## 7. Security

The template's security guidance carries over. The client-side rendering
decision moves the XSS trust boundary **into the browser**, so the spec is
explicit about the consequence and the layered mitigations that keep it safe.

### Trust-boundary consequence (be explicit)

Because the server stores raw Markdown verbatim and never produces or serves
HTML, it cannot HTML-sanitize what the browser ultimately renders. The data the
browser renders is **untrusted** (it could contain `<script>`, `javascript:`
links, or raw HTML — whether typed by the user or written by any future
import/API client). For a single-user personal tool the practical exposure is
self-XSS, but the design still treats stored content as hostile and gates it on
render. Write-time validation (§4.1) **shrinks** this surface — bluemonday
rejects embedded HTML outside the safe allow-list, and the scheme check rejects
bad Markdown link/image schemes, so neither reaches storage through the API — but
does not eliminate it: rows written outside the API, or any content predating the
check, remain untrusted, so render-time gating stands regardless.

### Layered defenses (defense in depth)

1. **Embedded HTML is allowed but gated (server + client).** markdown-it runs
   with `html: true`, so raw HTML in the source is rendered rather than escaped;
   DOMPurify (defense 3) then strips anything unsafe. As a server-side complement,
   write-time validation runs **bluemonday** over the embedded-HTML fragments and
   **rejects** any note whose HTML falls outside the safe allow-list before it is
   ever stored (§4.1). The two together mean unsafe HTML neither persists (server)
   nor renders (client).
2. **markdown-it link validation** — the coarse first pass. markdown-it's single
   `validateLink` hook fires for both links and images and cannot apply a
   different scheme list to each, so it accepts the **union** of what either may
   need: `http`/`https`/`mailto`, plus `data:` restricted to the **canonical four
   raster image subtypes** `data:image/(gif|png|jpeg|webp)`. It blocks
   `javascript:`/`vbscript:`/`file:`, `data:text/html`, `data:image/svg+xml`,
   and everything else (O-5). This is markdown-it's safe **built-in default**
   `validateLink` behavior, so v1 keeps that default rather than replacing it.
   **Be precise about what the default does, though:** it is a *denylist* — it
   permits `data:image/(gif|png|jpeg|webp)`, rejects every other `data:` (including
   `svg+xml`) and the script-y schemes (`javascript:`/`vbscript:`/`file:`), and
   **passes any other scheme it doesn't recognize as dangerous** (e.g. `tel:`). So
   `validateLink` enforces the *dangerous-scheme* block but **not** the
   three-scheme (`http`/`https`/`mailto`) link allow-list — that allow-list is
   enforced authoritatively by the server's Markdown-native scheme check (§4.1) and,
   at render time, by DOMPurify's `ALLOWED_URI_REGEXP` (defense 3). What the three
   client/server gates genuinely **share** is the `data:` image rule: **the
   four-subtype list `data:image/(gif|png|jpeg|webp)` is the single canonical
   `data:` image allow-list** used by the server's Markdown-native scheme check and
   bluemonday `img@src` rule (§4.1) and DOMPurify (defense 3) alike, deliberately
   excluding `data:image/svg+xml` (an SVG-script XSS vector). **Precisely, the
   canonical allow-list is the regexp `^data:image/(gif|png|jpeg|webp);`** — note
   the **required trailing `;`** (the subtype must be followed by a media-type
   parameter such as `;base64,`), which is markdown-it's built-in `validateLink`
   rule verbatim (`GOOD_DATA_RE = /^data:image\/(gif|png|jpeg|webp);/`). The
   server's Markdown-native scheme check, the bluemonday `img@src` `Matching`
   regexp (§4.1), and the DOMPurify `uponSanitizeAttribute` hook (defense 3) all use
   this **same** regexp, so a parameter-less `data:image/png,…` (no `;`) is rejected
   by every gate. **Every shorthand `data:image/(gif|png|jpeg|webp)` elsewhere in
   this spec denotes this exact regexp.** Because only those subtypes survive here, a `data:` value on an anchor
   is at worst a harmless inline raster image; the dangerous `data:text/html` is
   already gone. The per-tag distinction that matters (`data:` belongs on images, not
   anchors) is enforced authoritatively in DOMPurify (defense 3).
3. **DOMPurify (authoritative gate)** — every HTML string is sanitized with
   DOMPurify immediately before any `innerHTML` assignment, in both the read view
   and the editor preview. A single shared helper (e.g.
   `web/ts/util/markdown.ts`) owns the render+sanitize pipeline so no component
   ever injects unsanitized HTML. In application code there is exactly one place
   that assigns note-derived HTML to `innerHTML` (CodeMirror's own internal DOM
   construction is out of scope — it never receives note HTML).
   - **Allow-list (broad "safe HTML"; source of truth for §4.1).** DOMPurify is
     configured to keep **any tag/attribute safe and reasonable in a note**,
     matching the server's bluemonday `UGCPolicy()` profile (§4.1) so the two
     gates agree — not just the handful of tags markdown-it emits. Allowed:
     block/sectioning and prose (`p`, `div`, `span`, `h1`–`h6`, `blockquote`,
     `pre`, `code`, `hr`, `br`), lists (`ul`/`ol`/`li`, `dl`/`dt`/`dd`), tables
     (`table`/`caption`/`colgroup`/`col`/`thead`/`tbody`/`tfoot`/`tr`/`th`/`td`),
     inline formatting/semantics (`em`/`strong`/`b`/`i`/`u`/`s`/`del`/`ins`/`mark`/
     `small`/`sub`/`sup`/`abbr`/`cite`/`q`/`kbd`/`samp`/`var`/`dfn`/`time`),
     disclosure (`details`/`summary`), figures (`figure`/`figcaption`), `a`, and
     `img`. **Excluded (stripped):** `script`, `style` (the element *and* the
     attribute — CSS is an injection/exfiltration surface), `iframe`/`object`/
     `embed`, form controls (`form`/`input`/`button`/`select`/`textarea`), and raw
     media (`audio`/`video`/`source`) — not "reasonable in Markdown," and several
     would force new CSP directives — plus all `on*` event-handler attributes.
     Allowed attributes: `href` (on `a`), `src`/`alt` (on `img`), `title`, `class`,
     table `align`/`colspan`/`rowspan`/`scope`, `datetime` (on `time`/`ins`/`del`),
     and `cite` (on `q`/`blockquote`/`ins`/`del`). The `language-*` `class`
     markdown-it emits on fenced `<code>` now **survives** (class is allowed) but
     is inert — there is still **no read-view syntax highlighting in v1**; adding
     one later needs no allow-list change. **URI policy — `data:` scoped to images,
     blocked on anchors, relative URLs allowed.** Set
     `ALLOWED_URI_REGEXP` to
     **`/^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i`** — the
     three-scheme allow-list (`http`/`https`/`mailto`, **no `data:`**) **plus
     DOMPurify's own relative-URL alternation taken verbatim**. The relative
     alternation is **load-bearing, not optional**: a scheme-only regexp like
     `/^(?:https?|mailto):/i` would match no relative URL and DOMPurify would
     strip the `href` from every **root-relative** in-app link — exactly the
     `[<title>](/notes/<slug>)` links the "Link to note" feature (§6) and the §4.1
     no-scheme allowance depend on — silently breaking SPA navigation. The
     alternation (`[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$)`) admits root-relative
     (`/notes/x`) and bare-relative (`foo`, `./bar`) destinations while still
     rejecting any disallowed explicit scheme, matching §4.1's "no-scheme
     destinations are allowed" rule. DOMPurify's own built-in `data:`
     handling is already restricted to image-bearing tags (it admits `data:` on
     `img` and a few media tags, **never on `<a>`**), so with `data:` left out of
     `ALLOWED_URI_REGEXP` the baseline net effect is: `data:` images survive on
     `<img src>` while `data:` on `<a href>` is stripped — the per-tag scoping we
     want. **But DOMPurify's built-in allowance is by *tag*, not by image
     subtype** — it would let `data:image/svg+xml` through on `<img>`, which the
     canonical four-subtype list (defense 2) deliberately excludes as an
     SVG-script vector. To match that list, **add an `uponSanitizeAttribute`
     hook** that permits a `data:` value **only** when it is on `img@src` **and**
     matches `data:image/(gif|png|jpeg|webp)`, and strips `data:` on every other
     element/attribute (and any other `data:image/...` subtype, including
     `svg+xml`). Do not treat this hook as an optional fallback — it is required to
     close the SVG subtype that DOMPurify's defaults would otherwise admit. **The
     spike (§10 / milestone 7) must confirm:** `data:image/png;base64,…` survives
     on `<img>`; `data:image/svg+xml,…` is **stripped** from `<img>`; and `data:`
     (in particular `data:text/html,…`) is stripped from `<a href>`. The hook's
     `data:` test is the **canonical `^data:image/(gif|png|jpeg|webp);` regexp**
     (with the trailing `;`, §7 defense 2), so it stays identical to the server's
     check and to markdown-it's `validateLink`. **`http` image `src` note:** an
     `http` `src` is *not* stripped by this client sanitizer (DOMPurify keeps it,
     `ALLOWED_URI_REGEXP` admits `http`) — it is blocked at load time by CSP
     `img-src`, which omits `http`. The DOMPurify config is deliberately **not**
     tightened to drop `http` images: doing so cleanly would also strip `http`
     *links*, which are allowed. The server is the gate that rejects `http` image
     *destinations* on write (§4.1); for any legacy/out-of-band note that still
     carries one, CSP remains the render-time backstop. (So for `http` images the
     server is the **stricter** gate — the acceptable direction, since the user
     gets a `400` rather than anything unsafe.)
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
     viewer's IP to those hosts — acceptable for a personal tool). **`http` is
     deliberately omitted** (no mixed content); combined with the server rejecting
     `http` image destinations on write (§4.1), an `http` image is neither storable
     via the API nor loadable, and DOMPurify keeping an `http` `src` through (for
     legacy/out-of-band content) is harmless because CSP never loads it.
   - **`img-src` is the *only* CSP directive that changes.** The API is same-origin,
     so XHR/`fetch` stays covered by the existing `default-src 'self'`; **do not add
     a `connect-src`** (the template has none, and adding one would have to
     re-enumerate `'self'` for the API). markdown-it `linkify` and `data:` images
     need no further directives.

### Server-side responsibilities (unchanged or new)

- **Validate on write:** title/slug/content length, UTF-8 validity, slug pattern
  (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), **and a structural Markdown check on `content`**
  (Goldmark parse + AST walk: embedded-HTML fragments validated with bluemonday
  against the safe allow-list, allow-listed schemes on Markdown-native link/image
  destinations, bounded nesting — §4.1). The server does *not* render the source,
  and it never stores bluemonday's cleaned output — the check only **accepts or
  rejects** verbatim source (storage stays byte-for-byte). These are the server's
  gate; the client markdown-it→DOMPurify pipeline remains the authoritative XSS
  gate.
- **GET is side-effect free** — listing/fetching never writes (no rendered-HTML
  caching exists to tempt a write; O-3 resolved as "no caching").
- **Body limits / timeouts:** keep the global `http.MaxBytesHandler` cap and the
  server `ReadTimeout` / `ReadHeaderTimeout`. The 10 MiB body cap comfortably
  covers the 1,000,000-char content limit (≤ ~4 MiB UTF-8).
- **CSRF / auth:** unchanged from the template (CSRF middleware on; optional
  Basic Auth via htpasswd).

> The existing `internal/sanitize` (bluemonday) package is **retained and
> reused** — it is the server's embedded-HTML validator on the note write path
> (§4.1). It is used to **validate (accept/reject), not to mutate**: the service
> runs it over the raw-HTML fragments Goldmark extracts and rejects the write if
> it would strip/alter them; its cleaned output is never stored. (It is **not**
> run over the whole `content`, which would corrupt Markdown, and it is **not** on
> the read path — reads serve verbatim Markdown.) The package may need a small
> policy/API addition to expose the allow-list used for this fragment check and to
> return the cleaned fragment for comparison.
>
> **Governing-instructions note:** `CLAUDE.md` mandates "Sanitize on every write
> path … using `sanitize.HTML`." The notes-`content` path honors the *spirit* of
> this (bluemonday gates every write) but **deviates in mechanism**: it
> validates-and-rejects rather than sanitizes-and-stores (content is stored
> verbatim Markdown; DOMPurify is the authoritative render-time gate). Amend
> `CLAUDE.md` during implementation to describe this validate-not-mutate behavior
> for notes-`content`, alongside the already-planned Build & Run update for
> `esbuild` (§6), so the governing instructions match the design.

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

CREATE INDEX idx_notes_updated_at ON notes(updated_at DESC, id DESC);
-- The index carries the id tie-break so the browse ORDER BY
-- (updated_at DESC, id DESC — §8, §9) is satisfied directly, without a
-- separate sort step even at deep offsets. A bare (updated_at DESC) index
-- could not: SQLite appends the rowid to an index ascending, so it cannot
-- serve a descending secondary id sort.
-- slug already has a UNIQUE index from the column constraint.
```

### Full-text search (FTS5)

Reuse the template's external-content FTS5 pattern (an `fts5` table mirroring the
base table, kept in sync by triggers). Index `title` and `content` (the Markdown
source — searching the source is acceptable and simple; punctuation/markup noise
is minor).

The `MATCH ?` predicate (in both the page query and the `COUNT(*)`, §9) is
**unqualified** — it is `notes_fts MATCH ?` / `f MATCH ?`, **not**
`content MATCH ?` — so a query matches against **both** indexed columns (`title`
and `content`). This is load-bearing: a title-only match (a `q` that hits only
the `title` column) is exactly the case the §8 snippet fallback handles, and it
can only arise if `title` participates in the match. A column-qualified
`content MATCH ?` would silently break title search and the title-only-match
fallback. (The snippet, by contrast, is taken only from the `content` column —
index 1 — see below.)

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

The UPDATE trigger is unscoped — `AFTER UPDATE ON notes`, not the template's
`AFTER UPDATE OF title, content` — so it re-syncs FTS on any row change; this is
simpler and safer than enumerating columns. In practice the service issues an
`UPDATE` only when at least one field actually changed (§9: a no-op PATCH issues
no SQL at all), so the trigger fires only on real changes; a slug-only rename
still fires it, harmlessly re-syncing the unchanged `title`/`content` into FTS.

- **Querying:** keep the template's `sanitizeFTSQuery` (quote each token to make
  FTS5 treat user input as literal terms, not operators). An absent `q` **and** a
  present-but-empty/whitespace-only `q` are both treated as "browse" (no search
  filter), not as a query matching nothing. A `q` that has content but whose every
  token is punctuation (e.g. `"..."`) yields a **non-empty** `sanitizeFTSQuery`
  result whose quoted phrase the unicode61 tokenizer reduces to zero tokens; FTS5
  matches **nothing** for it (it does not raise an error — verified against the
  pinned `modernc.org/sqlite` driver: a `MATCH` on a quoted punctuation-only or
  empty phrase returns zero rows with a nil error, so no zero-token short-circuit
  is needed in `sanitizeFTSQuery`). This is the FTS branch
  returning an empty page with `total = 0` — correct and intended, distinct from
  the browse fallback above. No special-casing or error handling is needed.
- **Ranking:** order by FTS5 relevance (`ORDER BY rank`) when an **effective FTS
  query** is present (a non-empty result from `sanitizeFTSQuery`); order by
  `updated_at DESC` otherwise. **Note the direction:** FTS5's `rank` is a bm25
  score that is more negative for better matches, so `ORDER BY rank`
  (**ascending**, the default) already puts the **best match first** — do *not*
  write `ORDER BY rank DESC` (that would invert relevance). `updated_at DESC` is
  descending as usual. The switch keys on the *effective* query, not on
  the mere presence of the `q` parameter — a present-but-empty/whitespace `q` is
  "browse" and uses `updated_at DESC`, consistent with the browse rule above and
  with how `total`, snippets, and the excerpt mode are all selected. In both cases add
  `id DESC` as a secondary key so equal-rank / equal-timestamp rows paginate
  deterministically across `limit`/`offset`.
- **`total`:** `NoteList.total` is the count of rows matching the current request
  (all notes when browsing; matched notes when `q` is present), so the client can
  paginate; it is **not** affected by `limit`/`offset`. This differs from the
  template, whose `ItemList.total` is the page size (`len(returned)`); the new
  `openapi.yaml` `total` description and the handler must **not** copy the
  template's "number of items in this page" wording/logic — it is a second
  `COUNT(*)` over the same predicate (§9).
- **Snippets/highlights:** when `q` is present, build the `excerpt` with FTS5
  `snippet()` over the **`content`** column — column index **1** in
  `fts5(title, content)`, i.e. `snippet(f, 1, <start>, <end>, '…', ~30)` where
  `f` is the FTS table's alias in the join (§9: `notes n JOIN notes_fts f`). The
  first argument is the **same FTS table reference used in the query** — use the
  alias `f` consistently rather than the bare table name `notes_fts`, so the two
  passages (§8 here and §9) agree
  — with a budget of ~30 tokens (within FTS5's required 1..64 range for the
  token-count argument) and `…`
  as the leading/trailing ellipsis text, passing the **sentinel** start/end
  strings `U+0002` / `U+0003` (not HTML tags) so matched terms are marked without
  injecting markup. The mark/ellipsis arguments to `snippet()` are **literals in
  the SQL text** of the call — FTS5's `snippet()` does **not** accept bind
  parameters for them, so only the `MATCH` term is a bound `?`. **Express the two
  control sentinels as SQLite `char(2)`/`char(3)`** rather than raw control bytes
  embedded in the Go query-string constant: the call reads
  `snippet(f, 1, char(2), char(3), '…', 30)`, which keeps the Go source readable
  and free of invisible control characters while producing the identical `U+0002`/
  `U+0003` delimiters at query time. (The result is byte-for-byte equivalent to
  embedding the literal control bytes; `char(2)`/`char(3)` is purely a
  source-readability choice.) **Title-only matches:** when the query matches only in the
  `title` column, the content snippet carries **no marked term**, so it falls
  back to the plain truncated content prefix (the same value used when browsing,
  no sentinels). The title itself is already shown separately as the row heading,
  so no title snippet is produced. **The fallback is triggered by the absence of
  any `U+0002` start-sentinel in the snippet — not by an empty string.** This is
  deliberate: for a title-only match on a note with **non-empty** `content`, FTS5
  `snippet()` over the `content` column does **not** return an empty string — with
  no matched phrase in that column it returns an **unmarked leading slice** of the
  content (its own ~30-token window, no `U+0002`/`U+0003`). Keying the fallback on
  "no sentinel present" therefore catches every no-highlight case — the title-only
  match (unmarked slice) and the empty-content note (empty string). (A genuine
  content match is always marked by `snippet()`, so it never falls through to this
  branch.) The fallback rebuilds the excerpt
  from the `substr(n.content, 1, 201)` the FTS query already selects (§9), so the
  result is the **same plain ~200-rune word-boundary prefix used when browsing**
  rather than `snippet()`'s shorter unmarked window. The row still shows title + a
  readable excerpt, just without inline highlight markers. A title-only match on a
  note whose `content` is **empty** therefore yields an **empty `excerpt`** — the
  same result as browsing an empty-content note (§5); no placeholder text is
  substituted. When `q` is absent, the `excerpt` is just a
  ~200-character plain-text prefix of the source (no `snippet()`, no sentinels).
  The client escapes the whole string and only then converts sentinel pairs to
  `<mark>` (§5) — markers are never free-form HTML.

---

## 9. Backend layering (Go)

Mirrors the template; rename/replace `item*` with `note*`.

- `internal/model`: `Note` struct (adds `Slug`).
- `internal/repository`: `NoteRepository` (`List`, `GetBySlug`, `Create`,
  `Update`, `Delete`, slug-existence check). `db.go` gets the new schema + FTS.
  - **`GetBySlug` returns the full row.** It selects **all six** columns —
    internal `id` plus the five exposed `Note` fields (`slug`, `title`, `content`,
    `created_at`, `updated_at`) — so the read view has the complete note and the
    `PATCH` no-op diff (§5, below) can compare every present field against its
    stored value (and resolve the slug→`id` it mutates by). The narrower
    `NoteSummary` column set (slug, title, updated_at, excerpt) belongs to the
    `List` query only.
  - **Slug is the external key; `id` stays internal.** `Update` and `Delete`
    resolve the URL `{slug}` to the row `id` first (via `GetBySlug`), then mutate
    by `id` (signatures take a slug, or take the resolved `id` from a handler-side
    lookup — either is acceptable, but the public surface is always keyed by
    slug). A missing slug surfaces as `ErrNotFound`.
  - **Slug rename within PATCH:** resolve the *old* (URL) slug to `id` first, then
    write the new slug onto that `id` in the same update. Setting `slug` to the
    note's own current value is a no-op (not a conflict, §3.1); setting it to a
    value held by another note returns `ErrConflict`. **The uniqueness check must
    exclude the note's own row** — it is `SELECT … WHERE slug = ? AND id != ?`
    (the current `id`), not a bare `WHERE slug = ?`. Otherwise the note's *own*
    current slug would appear to already exist and a self-rename (or any PATCH
    that re-sends the unchanged slug) would be misreported as a `409` instead of
    the documented no-op.
    - **A conflict writes nothing.** The advisory uniqueness check runs **before**
      the `UPDATE`, and a PATCH applies as a **single `UPDATE` statement** writing
      all changed columns at once. So whether the collision is caught by the
      advisory check or by the DB `UNIQUE` constraint (the racy path, mapped to
      `ErrConflict` → `409`, §3.1), **no column is written** — the single statement
      either commits in full or rolls back in full, so a 409 never leaves a partial
      update (a bumped `updated_at` or a written `title` with the slug rejected).
  - **No-op detection is greenfield logic (not inherited from the template).** The
    template's `Update` blindly sets `updated_at = now` and every provided column
    with no prior read. The §5 "actually changed" semantics require the **service**
    to `GetBySlug` first, diff each *present* PATCH field against the stored value.
    The `title` diff compares the **post-`TrimSpace`** value (the same
    normalization the service applies before storing, §9 "Trimming"), so a
    whitespace-only title delta (e.g. `"Foo "` vs stored `"Foo"`) is a no-op rather
    than a pointless `updated_at` bump; `content` is compared verbatim (never
    trimmed). After this diff: (a) if no present field differs, issue **no** SQL `UPDATE` at all (so
    `updated_at` is untouched and the FTS update trigger does not needlessly
    re-sync) and return the unchanged note; (b) otherwise set `updated_at = now`
    and write only the changed columns. The all-fields-absent case is rejected
    `400` *before* this diff (§5). The read-then-write is not transactionally
    isolated against a concurrent writer, which is acceptable for a single-user
    tool (last-write-wins, consistent with the racy slug check in §3.1).
  - **`List` returns both the page and the match count.** Signature returns
    `(notes []NoteSummary, total int, err error)` (or an equivalent struct).
    `total` is computed by a second `COUNT(*)` over the same predicate as the
    page query — all rows when browsing, `… WHERE notes_fts MATCH ?` when an
    effective query is present — and is independent of `limit`/`offset` (§5, §8).
  - **The repository builds the final `excerpt` string for both branches**
    (decided), so each `NoteSummary` it returns is ready to use and the
    service/handler pass it through unchanged. The FTS branch sets `excerpt` from
    `snippet()` (with the empty-snippet → plain-prefix fallback of §8) — and so the
    FTS join query must **select both** the `snippet(...)` **and** the truncated
    source `substr(n.content, 1, 201)` **as two columns of the same row** (the
    `substr` exactly as for the browse branch below). The repository then decides
    **per row**: if the `snippet()` value contains a `U+0002` start-sentinel, use it
    as the excerpt; otherwise (title-only match or empty content — §8) discard
    the snippet and build the plain ~200-rune word-boundary
    prefix from the `substr` column instead. Selecting only one of the two would
    leave the fallback with no content to render. The browse
    branch sets it from the plain ~200-rune word-boundary prefix (§5). To avoid
    pulling full 1,000,000-char `content` into Go for every list row, the browse
    branch should SQL-truncate the source — note that SQLite's `substr(content, 1,
    N)` on a TEXT value counts **characters (code points), not bytes**, so
    `substr(content, 1, 201)` returns the first 201 runes (enough to locate the
    ≤199-rune word boundary and to detect that truncation is needed) — and apply the
    rune-accurate word-boundary cut + `…` in Go over that bounded prefix. The sentinel→`<mark>`
    conversion still happens client-side (§5); the repository emits the raw
    sentinel-wrapped snippet, never HTML.
  - **The search/list query is largely greenfield — the template offers no model
    to copy** for the pieces below; budget for it in milestone 2 rather than
    assuming a rename suffices:
    - The browse branch (`updated_at DESC, id DESC`) and the FTS branch
      (`ORDER BY rank, id DESC`) are two distinct queries selected on the
      *effective* query (§8); only the FTS branch references `notes_fts`.
    - `rank` and `snippet()` are **columns/functions of the FTS5 table** and only
      resolve when the query selects from / joins `notes_fts` (e.g.
      `notes n JOIN notes_fts f ON f.rowid = n.id WHERE f MATCH ?`); call
      `snippet()` against the FTS-table side, with column index **1** for
      `content` (§8). The browse branch must **not** reference `rank`/`snippet()`.
      In this join every column reference must be **table-qualified** — `n.id`
      (not bare `id`, which is ambiguous against the FTS table's `rowid`) and the
      FTS `rank`/`snippet()` against the `f` alias — so the `ORDER BY rank, id
      DESC` of §8 is written `ORDER BY f.rank, n.id DESC`.
    - `total` is a second statement: `SELECT COUNT(*) FROM notes` when browsing,
      `SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH ?` when searching.
      The count must use the **same predicate** as the page query so the two
      cannot disagree (an off-by-one here makes pagination show a phantom extra
      page): the searching count keys on the identical `MATCH ?` term, and the
      external-content triggers (§8) keep `notes` and `notes_fts` in strict 1:1
      sync, so the join-based page (`notes n JOIN notes_fts f`) and the
      `notes_fts`-based count return the same row set. (Rows written outside the
      API without firing the triggers — §7 — would break this invariant, but that
      is out of scope: all writes go through the API.)
- `internal/service`: `NoteService` — validation (title, slug pattern, content
  length, UTF-8, **and structural Markdown validation of `content` — Goldmark AST
  walk + bluemonday HTML-fragment check, §4.1**), slug generation + collision
  resolution. Adds `ErrConflict`.
  On create, a nil/absent `content` is coalesced to `""` before storage (matches
  the column `DEFAULT ''` and the API default). **The service performs this
  coalescing itself** — it does **not** rely on ogen materializing the schema
  `default: ""`; the `default` in `openapi.yaml` documents intent only. ogen emits
  the optional `content` as an `Opt` wrapper whose unset state the service reads as
  "absent" and replaces with `""`, so the behavior is identical whether or not a
  given ogen version applies the schema `default`.
  - **Remove the template's content-mutating sanitize call.** The template's item
    service mutates the body in place on write — `content = sanitize.HTML(content)`
    on create and `clean := sanitize.HTML(*content)` on update (today at
    `internal/service/*.go:68` and `:85`). These **must be deleted** on the note
    write paths: notes store Markdown **verbatim** (§4), and running an HTML
    sanitizer over the whole source would corrupt it (`&`→`&amp;`, mangled `<` in
    prose). bluemonday is reused here only to *validate* extracted HTML fragments
    (accept/reject), never to rewrite stored content (§4.1, §7). Porting by rename
    alone would silently leave this mutation in place — explicitly drop it.
  - **Create timestamps.** On create the service sets `created_at = updated_at =
    now` (UTC RFC 3339), the same instant for both. This guarantees a freshly
    created note sorts to the top of the browse list (`updated_at DESC, id DESC`,
    §8) and makes the immutable-`created_at` rule (§5) consistent with the initial
    `updated_at`. (`PATCH` never touches `created_at`; it bumps `updated_at` only
    on a real change, §5.)
  - **Trimming (template convention).** The service `strings.TrimSpace`-es the
    **`title`** before validating it (as the template's item service does), so a
    whitespace-only title that slips past ogen's `minLength: 1` (e.g. `" "`)
    becomes `""` and is rejected with `ErrValidation` → `400`. After trimming, the
    service also rejects a `title` containing **any C0 control character**
    (including tab/newline/CR — stricter than the `content` scan, which allows
    those three; see §4.1): a title is a single-line, FTS-indexed display string
    with no legitimate control characters, and this guarantees the search sentinels
    `U+0002`/`U+0003` never enter a title either. **`content` is
    never trimmed** — leading/trailing whitespace and blank lines are meaningful
    Markdown and are stored verbatim. (The auto-derived-title path in §3 already
    produces trimmed heading text client-side, but the server trim is the
    authoritative gate.)
  **No Markdown rendering** — the server parses Markdown with Goldmark to
  validate structure (§4.1) but never converts it to HTML.
- `internal/sanitize`: **retained** — bluemonday now backs the embedded-HTML
  validation on the write path (§4.1, §7). Used to validate (accept/reject) the
  raw-HTML fragments Goldmark extracts, never to mutate stored content; not on the
  read path. May need a small addition to expose its allow-list policy and return
  the cleaned fragment for the comparison.
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
  content-length and UTF-8 limits; **structural Markdown validation (§4.1)** —
  safe embedded HTML across the broad allow-list (`<details>`, `<sub>`, `<kbd>`,
  `<div>`, an aligned `<table>`, a plain `<a>`/`<img>`) **accepted**; unsafe
  embedded HTML (`<script>`, `<img onerror=…>`, a `javascript:`/`data:text/html`
  href, `<style>`, `<iframe>`, an `<input>`) **rejected**; benign HTML that
  bluemonday merely reformats (`<br>`, unquoted attributes) and a plain
  `<a href="https://…">` accepted (no false-positive rejection — the
  canonical-reserialization compare + removal-only policy, §4.1); disallowed
  schemes on **Markdown-native** links/images (`javascript:`/`data:text/html`/…)
  rejected;
  `http`/`https`/`mailto` links and root-/bare-relative destinations accepted,
  **scheme-relative (`//host/…`) rejected on both links and images** (§4.1); `https`
  images accepted but an **`http` image destination rejected** (Markdown-native
  *and* embedded-HTML `<img>`, §4.1); the canonical `data:image/(gif|png|jpeg|webp);…`
  (with the trailing `;`) accepted on images but rejected on links, a
  parameter-less `data:image/png,…` (no `;`) rejected, and
  `data:image/svg+xml` rejected on images too (§7); over-deep nesting
  rejected; **content containing a C0 control char — a sentinel `U+0002`/`U+0003`,
  or e.g. NUL — rejected, while tab/newline/CR are accepted** (§4.1, §8); **a
  `title` containing *any* C0 control char — including tab/newline/CR — rejected**
  (stricter than the content scan, §4.1/§9); valid GFM
  and empty content accepted; both create and update paths covered. (No rendering
  to test server-side.)
- **Handler:** full request/response cycle for each endpoint; error→status
  mapping (400/404/409).
- **Frontend (the authoritative XSS gate):** unit-test the shared
  `util/markdown.ts` render+sanitize helper against a table of malicious Markdown
  inputs — `<script>`, `<img onerror=…>`, `[x](javascript:…)`, raw HTML blocks,
  `data:` URLs — asserting the sanitized output contains no script, event
  handler, or disallowed URL scheme. **With `html: true` (§4) the raw-HTML inputs
  now flow through markdown-it into DOMPurify rather than being escaped, so these
  cases exercise DOMPurify directly** — assert that unsafe embedded HTML is
  stripped while allow-listed embedded HTML across the broad set (e.g.
  `<details>`, `<sub>`, `<div>`, a safe `<a>`/`<img>`) survives, matching the
  server bluemonday allow-list (§4.1) so the two gates agree. A **shared fixture**
  of `input → expected survivors/strips` checks that the server bluemonday policy
  and the client DOMPurify config reach the **same verdict** (the parity vector
  referenced in §4.1); it is acceptable for them to diverge only where DOMPurify
  (authoritative) is the stricter of the two. Include a **`linkify` case** (a bare URL
  and a bare email in plain text, e.g. `http://x.test` / `a@b.test`) asserting
  markdown-it auto-links them to `http(s):`/`mailto:` anchors that **survive
  sanitization** — i.e. the sanitized output still contains the anchor with an
  allow-listed scheme (assert on the retained `href` scheme, not byte-for-byte
  equality, since DOMPurify may canonicalize the markup). Use linkify-recognized
  examples (`.test` is a reserved TLD that linkify-it matches). This confirms
  `linkify` output passes the same scheme gates as explicit links (§4, §7
  defense 2). The `data:` cases assert the **per-tag
  scoping decided in §7**: `data:image/png;base64,…` **survives on `<img src>`**,
  while `data:text/html,…` (and any `data:` on an anchor) is **stripped from
  `<a href>`**, and `data:image/svg+xml,…` is **stripped even on `<img src>`**
  (the canonical four-subtype list `gif|png|jpeg|webp` excludes SVG — §7). The
  shared server/client parity vector includes a `data:image/svg+xml` image
  destination, asserting **both** gates reject it. These assertions are also the acceptance criteria for the
  DOMPurify `data:` spike referenced in §7 defense 3. This requires a JS/TS test runner in
  `web/ts` — **decided: Node's built-in `node:test`**, with **`jsdom`** as a dev
  dependency to provide the DOM that DOMPurify requires (DOMPurify cannot run in
  bare Node; it is initialized against a jsdom `window`). This keeps the runner
  itself dependency-free, in line with the project's minimal-toolchain/vendoring
  approach; `jsdom` is a dev-only dependency and is not shipped or embedded.
  - **Tests exercise the real vendored bundles (decided).** The tests import the
    **exact `web/static/vendor/markdown-it.js` and `web/static/vendor/dompurify.js`
    esbuild bundles that ship to the browser** — not separate npm copies — so the
    XSS gate is verified against the artifact users actually run. Consequently
    **`jsdom` is the *only* npm devDependency**; markdown-it and DOMPurify are
    *not* added to `package.json`.
  - **Module resolution for the tests.** The compiled helper and the bundles use
    bare specifiers (`markdown-it`, `dompurify`) that Node won't resolve on its
    own. Provide a **small Node resolution shim** that maps those specifiers to the
    `web/static/vendor/*.js` bundle paths — e.g. a `--import` hook using
    `module.register`/a custom loader, or a Node `imports`/`exports` map in
    `package.json` pointing at the bundle files. The shim mirrors the browser
    import map, so the test environment resolves the same names to the same files.
    (The bundles are self-contained ESM, so once the specifier resolves they load
    under jsdom without further deps.)
  - **Where it lives / wired into the build (not optional).** `package.json` is
    **`web/ts/package.json`** (today just `{ "type": "module" }`; there is no root
    `package.json`). Add the `jsdom` `devDependencies` entry there and the
    resolution shim (loader file or `imports` map). `build.sh` gains an
    `npm ci`/`npm install` step (to fetch `jsdom`) and a `node --test` step **after
    `tsc` and after the `esbuild` vendor-bundling step** (the tests need the
    bundles to exist), alongside `go test`, so the XSS-gate tests run on every
    build. Without this they never execute — they must be part of `./build.sh`
    going green, not a manual afterthought.

---

## 11. Milestones (suggested build order)

0. **Governing-instructions amendment (do first).** Amend `CLAUDE.md` *before*
   writing note code: restate the "Sanitize on every write path … using
   `sanitize.HTML`" rule for the notes-`content` path as **validate-and-reject,
   not sanitize-and-store** — content is stored verbatim Markdown, its embedded
   HTML is validated (not mutated) by bluemonday on write, and DOMPurify is the
   authoritative render-time gate (§4.1, §7) — and add `esbuild`, `node`, and
   `npm` to the Build & Run tool list (§6, §10 — `node`/`npm` drive the
   `jsdom`-based client-side XSS-gate tests run from `build.sh`). `CLAUDE.md`'s
   instructions override default behavior, so leaving the old mutate-on-write
   wording in place would contradict the verbatim-storage design and block
   milestones 1–4. `internal/sanitize` is **retained** and reused as the
   embedded-HTML validator (§7, §9), not removed.
1. **API contract** — write `openapi.yaml` for `notes`; regenerate
   Go stubs and TS types. **Verify the download wiring spike** (raw `text/markdown`
   body + `Content-Disposition` header on the same `200`; §5) here — don't assume
   it generates.
2. **Persistence** — new schema + FTS triggers in `db.go`; `NoteRepository` with
   tests.
3. **Service** — validation (including structural Markdown validation, §4.1),
   slug generation/collision; sentinel errors (`ErrConflict`); tests. (No
   rendering.) Slug accent-folding uses `golang.org/x/text/unicode/norm` (§3.1);
   this is currently an **indirect** dependency in `go.mod`, so importing it
   directly promotes it to a direct dependency. Structural Markdown validation
   adds a **new direct dependency** on `github.com/yuin/goldmark` (parse + AST
   walk only — not used to render) and **reuses `internal/sanitize`'s bluemonday**
   (already a template dependency) for the embedded-HTML fragment check, comparing
   against a `golang.org/x/net/html` re-serialization (§4.1). Include the
   **removal-only policy spike** (§4.1): assert a plain `<a href="https://x">`, a
   `<br>`, and a representative allow-listed HTML slice round-trip the bluemonday
   gate **unrejected**, confirming every UGCPolicy attribute-injector is disabled
   before it can false-reject benign notes. Run `go mod tidy`
   after adding the new imports (per `CLAUDE.md`).
4. **Handler** — implement generated interface + error mapping; handler tests.
5. **Vendor bundling** — add the `esbuild` step to `build.sh`; produce
   `vendor/codemirror.js`, `vendor/markdown-it.js`, `vendor/dompurify.js`; wire
   the import map; update `CLAUDE.md` Build & Run (esbuild on `$PATH`).
6. **Frontend** — path router; list/search, read, and editor views; `notes`
   client; CodeMirror editor; shared `util/markdown.ts` render+sanitize helper +
   local live preview.
7. **Hardening pass** — DOMPurify/markdown-it config review, CSP review,
   client-side XSS regression tests, `./build.sh` green (bundle + build +
   `go test` + `node --test` + lint).

---

## 12. Open questions (resolved)

These are the design questions raised while drafting MyNotes. All are **resolved**
in v1; the markers (`O-1`…`O-6`) are referenced inline throughout the spec. This
appendix lists each so the resolutions are auditable in one place.

| #     | Question                                                              | Resolution (v1)                                                                                                   |
| ----- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `O-1` | Where is Markdown rendered — server-side or in the browser?          | **Client-side.** The server stores/serves only Markdown source; no `content_html`, no render endpoint (§2, §4).    |
| `O-2` | Which editor and rendering libraries?                                | **CodeMirror 6** for editing; **markdown-it → DOMPurify** for render+sanitize (§4, §6).                            |
| `O-3` | Cache rendered HTML server-side?                                     | **No caching.** Reads stay side-effect-free; there is no server HTML to cache (§7).                                |
| `O-4` | Are slugs mutable, and are old URLs redirected?                      | **Mutable, no redirects.** A slug may change via PATCH; old links break; the UI warns before renaming (§3.1, §6).  |
| `O-5` | Which Markdown feature set / extensions, and the CSP consequence?    | CommonMark + GFM tables/strikethrough/autolinks, `linkify` on, images on (needs the `img-src` widening); **no** task lists (§4, §7). |
| `O-6` | Is `title` derived, and where?                                       | **Stored field, auto-derived client-side** from the first ATX heading as an editor convenience; the server validates/stores whatever the client sends (§3). |
