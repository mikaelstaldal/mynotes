## Implement Upload Markdown (create from file)

Add the Upload Markdown action to the list view: a file picker
(`.md`/`.markdown`/`text/markdown`/`text/plain`) reads one file client-side as
UTF-8 and creates a note via `POST /notes` (no new API). The file text becomes
`content` verbatim. Derive the title client-side reusing the first-ATX-heading
rule (shared with the editor); fall back to the filename with extension stripped
(trimmed, truncated to 200 runes with `…`), then to `"Untitled"`. Do **not** send
a slug (server auto-generates/suffixes). Rune-count the decoded text and reject
oversized files (>1,000,000 chars) before posting — the char `maxLength` and the
10 MiB body cap are different limits — surfacing a clear "file too large" toast.
On success navigate to `/notes/{slug}` using the returned slug.

## Build the read view

Build the `/notes/{slug}` view: fetch `content`, render via the shared
`util/markdown.ts` helper into a constrained styled container. Do **not** render
the stored `title` as a body heading (it duplicates the content's own `# heading`);
use the stored title as the browser tab `<title>` on navigation. "Edit", "Delete",
and "Download Markdown" actions. The Download link is a hand-authored
**root-absolute** href `/api/v1/notes/{slug}/download` (leading slash — the JSON
`api` client's relative base must not be reused here), doing a real navigation so
`Content-Disposition` triggers the save; a stale download landing on the JSON 404
is accepted (not specially handled). A 404 or malformed-slug deep link renders the
not-found view; Edit/Delete on an already-gone note shows a toast and navigates to
the list.

## Build the CodeMirror editor view

Build the editor for `/new` and `/notes/{slug}/edit` using the vendored
CodeMirror 6 with the Markdown language mode, plus a live preview pane rendered
locally via `util/markdown.ts` on a debounced change (split/toggle layout, no
network round-trip). Wire `EditorView.updateListener` for preview + dirty
detection, `EditorView.lineWrapping`, `defaultKeymap`/`historyKeymap` (undo/redo),
and `syntaxHighlighting(defaultHighlightStyle)`. Editor sizing/styling lives in
`app.css` targeting `.cm-editor`/`.cm-scroller`/`.cm-content`.

- **Title input:** auto-fills from the first ATX heading while untouched (shared
  rule: Setext ignored, fenced-code lines skipped, empty headings skipped,
  unclosed fence to EOF, tab in captured text → single space, truncate to 200
  runes with `…`); manual edits stop the auto-sync.
- **Slug field:** on `/new`, show an auto-suggested **display-only preview** that
  tracks the title; while untouched the create request omits `slug` (server
  generates+suffixes). The field becomes an **explicit** slug only once edited by
  hand (then sent verbatim; a collision is a 409). When editing, the slug is shown
  editable with a warning that the URL will change.

## Implement the "Link to note" picker

Add a "Link to note" action in the editor that opens a picker searching notes via
`GET /notes?q=` (single first page, default limit 50, **no** "Load more" — narrow
by typing). Exclude the note being edited from its own results
(`results.filter(n => n.slug !== currentSlug)`). On selection, insert
`[<title>](/notes/<slug>)` at the cursor (via `EditorView.dispatch` /
`EditorSelection`), with the title **escaped for link-text context**
(backslash-escape `\`, `[`, `]`). The slug needs no escaping. Stale links from a
concurrent rename are accepted (resolve to the not-found view if followed).

## Implement save, cancel, and the unsaved-changes guard

Wire Save (create via `POST`, update via `PATCH`) and Cancel.

- **Dirty** is a value comparison of current `(title, content, slug)` against the
  last-saved snapshot — not a keystroke counter. The slug component is the
  *to-be-sent* slug (`undefined` while the user hasn't edited the field on `/new`,
  the verbatim value once edited; the note's actual slug when editing). Reverting
  to saved values clears dirty; auto-title-sync counts as dirty; `/new` baseline
  is empty so a brand-new editor isn't dirty until the user types. The snapshot
  updates only on a successful save (and is seeded from the fetched note when
  opening edit); a failed save does not update it.
- **Unsaved-changes guard** covers both intercepted in-app pushState navigations
  and real browser unload/reload (`beforeunload`). Clear it explicitly before the
  post-save navigation so the save's own pushState isn't blocked.
- **Cancel** navigates context-aware computed from the route (not
  `history.back()`): from edit → that note's read view; from `/new` → the list. It
  is an in-app navigation subject to the dirty guard.
- **Post-save navigation:** on success navigate to `/notes/{slug}` using the slug
  from the **response body** (may be auto-generated, suffixed, or renamed) in both
  create and edit cases.
- **Errors:** a 404 on save/delete (stale tab) → toast ("This note no longer
  exists") + navigate to the list (not the not-found view). A 409 slug conflict →
  generic error toast showing the server's `{"error":…}` message verbatim (no
  special client branch).



## CSP and security hardening pass

Widen the CSP `img-src` from `'self' data:` to `'self' data: https:` (the **only**
CSP change — no `http` for images, no `connect-src` since the API is same-origin
under `default-src 'self'`). Keep `script-src 'self'` and `frame-ancestors
'none'`; confirm CodeMirror's runtime `<style>` is covered by the existing
`style-src 'self' 'unsafe-inline'` and that the import-map hash is covered by
`commonweb.ImportMapCSPHash`. Review the DOMPurify and markdown-it configs against
`spec/ARCHITECTURE.md` "Security model". Run the **DOMPurify `data:` spike**: confirm
`data:image/png;base64,…` survives on `<img>`, `data:image/svg+xml,…` is stripped
from `<img>`, and `data:` (e.g. `data:text/html,…`) is stripped from `<a href>`.

## Client-side XSS-gate tests

Set up the client XSS regression tests with **no `npm` install** — no
`package.json` devDependencies, no `npm ci`. The DOM comes from the committed
test-only `jsdom` bundle vendored under `web/ts/vendor/test/` (see "Vendor the
third-party bundles"). Add a Node resolution shim (`--import`/`module.register`
loader, or an `imports`/`exports` map) mapping `markdown-it`/`dompurify` to the
**real `web/static/vendor/*.js` esbuild bundles** (not separate npm copies),
mirroring the browser import map, and mapping `jsdom` to its committed vendored
bundle. Write `node:test`
tests for `util/markdown.ts` against a table of malicious inputs (`<script>`,
`<img onerror=…>`, `[x](javascript:…)`, raw HTML blocks, `data:` URLs), asserting
no script/event-handler/disallowed-scheme survives, that allow-listed embedded
HTML (`<details>`, `<sub>`, `<div>`, safe `<a>`/`<img>`) survives, and a `linkify`
case (bare `http://x.test` / `a@b.test` auto-link to anchors that survive with an
allow-listed scheme). Include the `data:` per-tag scoping assertions and a
**shared server/client parity vector** (input → expected survivors/strips,
including `data:image/svg+xml` rejected by both gates), allowing divergence only
where DOMPurify is the stricter side.

## Wire tests into build.sh and go green

Update `build.sh` so its full order is: `go generate` → `openapi-typescript` →
`tsc` → `web/ts/vendor/test/unpack.sh` → `node --test` → `go test ./...` →
`golangci-lint`. **No `esbuild` bundling and no `npm`/`npx`/`yarn`/`pnpm`/`bun`
anywhere in `build.sh`** — the vendor bundles (browser and the test-only `jsdom`
artifact) are pre-built committed artifacts, so `node --test` runs directly
against the committed `web/static/vendor/*.js` and `web/ts/vendor/test/` bundles.
jsdom is un-bundleable, so its install tree is committed as the deterministic
`web/ts/vendor/test/jsdom-node_modules.tar.gz`; `unpack.sh` (tar only, no npm)
extracts it to `web/ts/vendor/test/node_modules/` — idempotent, so it's a no-op
on warm trees. The `node --test` step runs the client XSS-gate tests on every
build (not a manual afterthought). Run
`./build.sh` and resolve everything until it is green: TS compiled, both Go and
Node tests passing, lint clean. (If a vendored library changed, re-run the
out-of-band `web/ts/vendor/rebuild.sh` first and commit the regenerated bundles.)

## Final cleanup

Remove leftover `items` artifacts (template views `ItemForm.tsx`/`ItemList.tsx`,
`item_repo.go`, any `item`-named code and tests) once their `note` equivalents are
in place and tests pass. Confirm `go mod tidy` has run, the app builds and serves
(`./mynotes`), and the full flow works end to end. Update agent coding instructions in `AGENTS.md`.
At this point `spec/SPEC.md` is fully captured by `spec/REQUIREMENTS.md` + `spec/ARCHITECTURE.md` + this
file and can be removed.
