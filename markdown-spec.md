# MyNotes Markdown dialect

A note's `content` is stored and returned as verbatim Markdown. Consumers that
render notes (the embedded web UI, the native mobile app, HTML export) should
interpret it as follows. This document is the canonical dialect specification
referenced by the MyNotes OpenAPI contract (`openapi.yaml`).

## Base and extensions

The base syntax is [CommonMark](https://spec.commonmark.org/) plus a small,
fixed subset of [GitHub Flavored Markdown](https://github.github.com/gfm/) extensions:

- **Tables** — GFM [§4.10 Tables](https://github.github.com/gfm/#tables-extension-).
- **Strikethrough** — GFM [§6.5](https://github.github.com/gfm/#strikethrough-extension-),
  `~~deleted~~`.
- **Autolinks** — bare URLs and email addresses are linkified, GFM
  [§6.9](https://github.github.com/gfm/#autolinks-extension-).
- **Task lists** — GFM [§5.3](https://github.github.com/gfm/#task-list-items-extension-),
  `- [ ]` / `- [x]`. A list item whose text begins with such a marker renders as
  a **disabled (read-only) checkbox**, checked for `[x]` (case-insensitive) and
  unchecked for `[ ]`. The checkbox is presentational only — toggling it is a
  content edit that rewrites the marker in the stored Markdown, not a separate
  state.

These four are the only GFM extensions the dialect adopts. GFM's fifth
extension, [§6.11 Disallowed Raw HTML](https://github.github.com/gfm/#disallowed-raw-html-extension-),
is not used as specified — MyNotes applies a stricter allow-list that rejects
disallowed HTML at write time rather than escaping a fixed blocklist (see "Raw
HTML"). 

Constructs that are sometimes assumed to be GFM but are not part of the
GFM spec — footnotes and definition lists — are likewise not interpreted.

## Math (AsciiMath)

[AsciiMath](https://asciimath.org) written between single dollars (`$x^2$`)
renders as inline MathML and between double dollars (`$$…$$`, either inline or as
a multi-line block) as display MathML. A literal dollar is written `\$`; a `$`
that is not part of a valid pair (e.g. currency like `$5`) stays literal. This is
a **render-time transform**: the AsciiMath source is stored verbatim in the
`content` Markdown and converted to MathML at render time in the browser by the
web UI's vendored `asciimath2ml` library, with the generated `<math>` passing
through the same sanitization gate as all other rendered HTML. MathML embedded
directly as raw HTML is also permitted (see "Raw HTML"); that MathML is stored
verbatim and is not a transform.

A consumer that renders `content` itself must run the AsciiMath transform to
display math. Consumers that only pass `content` through unchanged receive the
literal `$…$` source.

## Inline icons, boxes, and callouts (application-specific)

These are **render-time transforms**, not part of CommonMark or GFM, so consumers
must implement them themselves. All of them are stored verbatim in `content` (the
literal `[!name]`, `>-`, etc.); a consumer that only passes `content` through
unchanged receives the literal source. They are composed from two independent
building blocks — inline icons and box/foldable blockquotes — with callouts built
on top.

### Inline icons

`[!name]` anywhere renders an inline icon. `name` is either any built-in Lucide
icon (the same set served by `GET /api/v1/icons/lucide/<name>`) or one of the
callout **aliases** listed below (which resolve to their icon). An unrecognized
name is left as literal text. The rendered icon inherits the surrounding text
colour.

The explicit form `[!lucide-<name>]` always renders the literal Lucide icon
`<name>`, bypassing the alias table and carrying **no** colour/callout semantics.
Use it to reach an icon whose name is also an alias — e.g. `[!lucide-summary]` is
the Lucide "summary" icon, whereas `[!summary]` is the `summary` callout alias
(which renders the clipboard-list icon and tints/boxes as gray). The icon picker
in the web UI inserts this explicit form.

The image form `![<name>](/api/v1/icons/lucide/<name>)` is also recognized and
renders as the same inline icon; `[!name]` is the compact, preferred form.

### Box and foldable blockquotes

A single marker character immediately after the first `>` of a blockquote turns
it into a callout-style box. The blockquote's **first line becomes the title**;
the remaining lines are the body.

| Syntax | Meaning |
| --- | --- |
| `>* Title` | Static (non-foldable) box |
| `>- Title` | Foldable box, collapsed |
| `>+ Title` | Foldable box, expanded |

The marker must sit immediately after `>` (so `> *italic*`, with a space, is an
ordinary blockquote). Foldable boxes render as native `<details>`/`<summary>`;
static boxes use a `<p>` title row. A box with no alias uses the default (gray)
accent.

### Callouts

A callout is a box whose first line starts with an `[!alias]` — this composes the
two blocks above: the alias supplies an icon and a colour, and the blockquote
supplies the box. The title text after the alias is optional and defaults to the
capitalized alias name. Fold a callout with the `>-`/`>+` markers, or with the
Obsidian-compatible `[!alias]-` / `[!alias]+` form (the fold marker directly after
the alias).

```
> [!warning] Heads up
> Body text.

>- [!tip] Click to expand
> Collapsed foldable callout (>+ starts expanded).
```

Each alias maps to a Lucide icon and one of six colour families:

| Family | Aliases (icon) |
| --- | --- |
| blue | note (pencil), info (info), todo (circle-check) |
| green | tip / hint / important (flame), success / check / done (check) |
| cyan | question / help / faq (circle-question-mark) |
| amber | warning / caution / attention (triangle-alert) |
| red | failure / fail / missing (x), danger / error (zap), bug (bug) |
| gray | abstract / summary / tldr (clipboard-list), example (list), quote / cite (quote) |

An unrecognized alias is not a callout: `> [!frobnicate] …` (with no box marker)
is an ordinary blockquote and the `[!frobnicate]` stays literal text.

### Alias-tinted paragraphs

An `[!alias]` at the start of **any** paragraph (not just a blockquote) tints that
paragraph's text and icon with the alias colour, without a box.

## Raw HTML

Raw inline and block HTML is permitted but restricted to a safe subset (broadly
the bluemonday UGC / DOMPurify allow-list: common prose, table, figure and media
elements, plus inline SVG and MathML). The sole permitted form control is the
task-list checkbox — `<input type="checkbox">` with only `checked`/`disabled`
attributes; any other `input` type or attribute is disallowed. Disallowed
constructs — `script`, `style`, `iframe`, `object`, other form controls, `on*`
event-handler attributes, and any URL whose scheme is not `http`, `https` or
`mailto` — are rejected at write time (`400`), so stored content is always safe.
Renderers should still sanitize with an equivalent allow-list as defense in
depth.

## Images and artifacts

Images use standard Markdown image syntax, `![alt](url)`. Binary images uploaded
via `POST /artifacts` are content-addressed and referenced by their SHA-256, e.g.
`![diagram](/api/v1/artifacts/<sha256>)`. Inline `data:` image URIs are also
allowed for the `gif`, `png`, `jpeg` and `webp` types. Built-in icons may be
referenced as images too (see "Inline icons").

## Internal wikilinks (application-specific)

A `[[...]]` syntax — modelled on the wiki-link convention — links to other notes
and tags **within the app**. It is not part of CommonMark or GFM, so consumers
must implement it themselves.

Grammar: the target slug must match `^[a-z0-9]+(?:-[a-z0-9]+)*$` (the same pattern
as note/tag slugs). An optional leading `#` sigil selects a tag instead of a note.
An optional `|` introduces display text, which may be any run of characters except
`]` and newline. Any `[[...]]` that does not match these forms is left as literal
text.

| Syntax | Target | Default display text |
| --- | --- | --- |
| `[[slug]]` | note with that slug | `slug` |
| `[[slug\|Display text]]` | note with that slug | `Display text` |
| `[[#slug]]` | the tag's note list | `#slug` |
| `[[#slug\|Display text]]` | the tag's note list | `Display text` |

Renderers should resolve note wikilinks to their own note-view route and tag
wikilinks to their tag/filter view (the web UI uses `/notes/<slug>` and
`/tags/<slug>`). Wikilinks are stored verbatim in `content`.

Note wikilinks (not tag links) are additionally **indexed** server-side: each note
carries `outgoing_links` (the notes it links to, resolved to existing notes only)
and `incoming_links` (backlinks — notes that link to it), both on `Note` and
`NoteSummary` (see the `NoteLink` schema). The index is refreshed whenever a
note's content is written and reflects target titles and existence at read time,
so creating, renaming, or deleting a target note updates the links of every note
that references it without a re-index. Extraction matches the render: a `[[slug]]`
inside a code span or code block is not a link and is not indexed.
