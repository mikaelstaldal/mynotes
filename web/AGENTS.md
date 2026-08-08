# AI coding agent instructions — frontend

Guidance for AI coding agents working on the MyNotes frontend: the Preact +
TypeScript sources under `web/ts/` and the embedded assets under `web/static/`.
It supplements the repository-root `AGENTS.md`, which is always loaded; paths
below are written relative to the repository root, as they are there.

## MyMail integration

"Send as email" posts a note to a sibling
[MyMail](https://github.com/mikaelstaldal/mymail) instance, whose URL `main.go`
derives from `-public-url` (path replaced with `/mymail`) and hands to the
frontend via an injected inline `<script>` setting `window.__serverConfig`
(hash added to `script-src`). Same-origin, so no CSP or CORS work is needed.
The user can override that URL in the web UI's Settings dialog
(`components/SettingsDialog.tsx`, persisted to localStorage via
`util/config.ts`); `util/mymail.ts` resolves override-then-derived and is the
only thing callers ask "is MyMail configured?". The override must be
same-origin — with no `connect-src` in the policy, `default-src 'self'` blocks
anything else — so a cross-origin one is rejected as it is entered.

`web/ts/util/emailhtml.ts` rewrites the export fragment into an email body and
reports, via `EmailBody.degraded`, what the body could not carry. That list
drives whether `email.ts` attaches the standalone "Download HTML" document —
attach on content loss (diagrams, formulas, icons, embedded graphics,
unresolvable images), not on a substitution that preserves the information
(unfolded callout, ☐/☑ checkbox, styling email cannot express). Because the
renderer puts a Lucide icon in the title of every **alias** callout
(`[!warning]`, …), notes using one always attach; `>-`/`>*`/`>+` boxes do not.
Anything the
placeholder text tells the reader to find "in the attached file" **must** report
a degradation, or the body will reference a file that was never sent.
**MyMail sanitizes what it sends** with `sanitize.OutgoingHTML`
(`mymail/internal/sanitize.NewOutgoingPolicy`): a fixed element allowlist, no
`class`, `<style>` dropped with its content, and a fixed CSS-property allowlist
whose values may not contain escapes, comments, or any functional notation but
`rgb()`/`hsl()`. So styles must be inline `style=` attributes drawn from that
list (no `position`, no `display`, no `color-mix()`), and URLs must be absolute.

MyMail's allowlist was widened for this path — per-side longhands
(`border-left`, `padding-left`), `border-radius`, `list-style`, and the inert
semantic elements are available. It was widened in **both** of MyMail's
directions, not just outgoing, so a note emailed to a MyMail address arrives
rendering exactly as sent; MyMail's `outgoingOnly*` lists are empty and should
stay that way. Widening further is a change in both repos: MyMail's
`cssAllowlist`/`allAllowedElements`, and the mirrored allowlists in
`web/ts/email.test.mjs` here, which restates the policy and asserts the real
rendered output against it.

Within one style attribute a shorthand must precede the longhand refining it
(`border` then `border-left`); MyMail preserves declaration order, pinned by its
`TestDeclarationOrderPreserved`.

## The sidebar footer is governed from outside this repo

The theme toggle and the **Settings** button at the bottom of the sidebar
(`.sidebar-footer` in `web/ts/app.tsx` and `web/static/app.css`) implement a
contract shared with the sibling MyCal and MyMail apps, so the three sit in the
same place on screen and look the same. It is defined in the sibling `mysuite`
repository — `../mysuite`, `spec/sidebar-footer.md` — and **not here**. Changing
any of it is a change in all three repositories.

The declarations in that block look like ordinary CSS and are not. Things that
would be routine tidying anywhere else in `app.css` break the contract silently:
normalising `0.80rem` to `0.8rem` (the trailing zero is the convention that makes
one `grep` find the value in all three repos), folding the rule back into
`.btn-icon`, dropping a "redundant" `flex-shrink: 0` or `text-align: center`,
adding a `font-weight` to the base `button` rule, or restoring `outline: none` on
the focus rule.

`e2e/tests/sidebar-footer.spec.ts` catches most of that **when somebody runs it**,
and today somebody always has to: the CI step for it is committed and has never
executed, because the workflow triggers on push to `main` and the branch carrying
it is unpushed. So read the list below as what a run would catch, not as what is
guarding you while you edit. Nothing is.

It is worth knowing which items and why, because the exceptions are not the ones
you would guess:

- **Caught by reading the CSSOM**, not the rendering: folding the rule away, and
  dropping `flex-shrink: 0`, `text-align: center`, `font-weight: 400`,
  `font-style: normal`, `white-space: nowrap` or `font-family: inherit`. These are
  the pins the *rendered* result cannot defend — deleting `font-weight: 400` today
  changes no computed value at all here, since `body` sets no weight and the
  button inherits 400 either way. That was mutation-tested: the declaration test
  went red, the computed-value test stayed green.
- **Caught by measurement:** `outline: none`, the geometry, the sizes and the
  colours, in both themes and at several content volumes.
- **Not caught, and safe:** adding a `font-weight` to the base `button` rule. Our
  own pin out-specifies it, which is exactly what the pin is for — so this is only
  a breakage in a repo that has *also* dropped the pin, and the first bullet
  covers that half.
- **Not caught, and not catchable by anything:** normalising `0.80rem` to
  `0.8rem`. The two serialise identically in the CSSOM and render identically, so
  the convention is held by review alone (spec §9.2 records it as the one
  uncatchable item on the list).

Run the suite with `./build.sh && ./test-e2e.sh` — see the root `AGENTS.md` — and
read the spec and its `measurement-protocol.md` before changing any of these
values; a change here is a change in three repositories, and the suite can only
tell you that *this* app still satisfies the contract, never that the three still
agree.

Note also that a green `./build.sh` says nothing about geometry: `web/embed.go`
bakes `web/static/` into the binary, so an already-running server keeps serving
the CSS it started with. That is why `test-e2e.sh` compares served against
on-disk bytes for every emitted asset before it runs a single test.

## Shared render kit

Native clients (the Android app) do **not** re-implement the Markdown dialect;
they embed `web/static/render/` and drive it in a web view. It is a plain static
page hosting the same `util/markdown.ts` + `util/mermaid.ts` pipeline as the web
UI, exposing `render(markdown)` and `setTheme(theme, vars?)` on
`globalThis.MyNotesRender`.

- `web/static/render/note.css` is the **canonical** stylesheet for rendered note
  content — `app.css` `@import`s it. Put `.note-content` rules and the colour
  variables there, not in `app.css`. Two of those variables (`--hover-bg`,
  `--faint`) are used by app chrome alone and are inert in the kit and on
  published pages; they live there deliberately, because this file owns the theme
  selectors and `app.css` has no `:root` block of its own.
- `tools/dist-renderer.sh <outdir>` copies the kit (host page + compiled modules
  + the vendor bundles it imports) into a consumer. It is a copy, not a build:
  run `./build.sh` first.
- The kit's host page has its own import map, so a vendor version bump must
  update **both** `web/static/index.html` and `web/static/render/index.html`, and
  the latter's `<meta>` CSP hash must be recomputed (`main.go` derives the
  server's header hash automatically). `web/ts/render-kit.test.mjs` fails the
  build if any of that is out of sync.

## Demo mode

- **Intercepting at the network layer is the point**: the frontend is unchanged
  between demo and real, including the `<img>` loads for artifacts and icons and
  the "Download Markdown" navigation, which never go through `api/client.ts`.
- **Not localStorage**: a service worker cannot reach it (it is synchronous and
  absent from worker scopes), so the store is IndexedDB.
- These sources are **worker code**: excluded from `web/ts/tsconfig.json` and
  built by `web/ts/demo/tsconfig.json` against the WebWorker lib. They are
  classic scripts sharing one global scope via `importScripts`, so they use no
  `import`/`export` — adding one silently turns a file into a module and its
  declarations vanish from the shared scope.
- HTML import is the one thing the worker delegates: parsing HTML needs a
  DOMParser, which a worker has no access to, so it asks the page to run
  `web/ts/util/htmlmd.ts` (a DOM port of `internal/htmlmd`) over a MessageChannel.

## Conventions

- **Frontend file naming:** components and views are `PascalCase.tsx`; utilities
  and non-component modules are `lowercase.ts`. Relative imports use `.js`
  extensions (TypeScript ESM convention — tsc resolves `.ts`/`.tsx`, emits `.js`).
- **Frontend networking:** all requests go through `api` in `web/ts/api/client.ts`
  (centralized retry, 401/404 handling, error parsing). Do not call `fetch`
  directly from components.
