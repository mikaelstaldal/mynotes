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

`e2e/tests/sidebar-footer.spec.ts` catches most of that, and CI runs it on every
push to `main` — see the root `AGENTS.md` § E2E tests, and
`../mysuite/spec/sidebar-footer.md` §9.1, which is the authority on each app's
status. So the list below is what the suite catches, not merely what a run would
catch if somebody remembered.

Two limits on that, both unchanged by CI running: it catches a breakage only
*after* the commit is on `main` (it gates publication, not the commit), and it
can only see this app — it never establishes that the three still agree.

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

## The app logo is governed from outside this repo

The badge at the top left of the sidebar — `.brand-logo` in `web/static/app.css`, drawn by
`web/ts/components/Logo.tsx`, sitting inside the brand anchor in `web/ts/app.tsx` — implements
a second contract shared with MyCal and MyMail, so the three apps' marks are the same size and
sit in the same place. It is defined in the sibling `mysuite` repository — `../mysuite`,
`spec/app-logo.md` — and **not here**. Read the values there rather than from any prose in this
repo.

Same rule as the sidebar footer: changing any of it is a change in all three repositories. What
differs is *which* routine edits break it, because MyNotes' badge lives somewhere neither
sibling's does — **inside an `<a>`**.

- **The anchor's flex context is load-bearing.** `.sidebar-brand` carries `display: flex;
  align-items: center; gap: 8px`. It reads like styling and is not: as a flex item of
  `.sidebar-header` the anchor is otherwise blockified, so removing `display: flex` stacks the
  badge above the label instead of beside it, and the `gap` **is** the contract's mandated
  badge-to-label distance. Do not fold it into `.brand`, which is also used where there is no
  badge.
- **`.brand-logo`'s `color: #fff` is a pin, not a restatement of the obvious.** The badge is a
  descendant of an `<a>`, so it is exposed to anything the link does to its own `color` — and
  that declaration is the only thing standing between the link and the glyph, because the glyph
  reaches its colour through `currentColor`. Delete it as redundant ("the mark is white anyway")
  and the glyph immediately inherits `--fg`; add a `.brand:hover { color: var(--link) }` on top
  of that and it changes colour under the pointer.

  Both halves are measured, not argued — and the order matters, because it is the opposite of
  what it looks like. **Adding `.brand:hover` while the pin is present does nothing at all**
  (mutation-tested: the whole suite stayed green, because `.brand-logo`'s own `color`
  out-specifies the anchor's). **It is removing the pin that breaks it.** So the rule to carry
  is *keep the `color` declaration*, not *avoid hover rules* — this is the same shape as the
  footer's `font-weight: 400` above, where the pin is what makes an otherwise-dangerous edit
  safe. **MyCal and MyMail have no link here, so neither sibling repo will ever catch this —
  it is ours alone.**
- **`Logo.tsx`'s `viewBox` is not tidying.** It crops to the letter (`10 10 12 12`) rather than
  spanning `favicon.svg`'s `0 0 32 32`, because the contract sets a floor on how much of the
  glyph box the mark's ink must span. "Restoring" the favicon's viewBox for consistency drops
  the mark to ~31% of the box — it renders about a third the size of MyCal's inside an
  identically-sized badge, and **every geometry check still passes**, since the badge box and
  the glyph box are both untouched.
- **`Logo.tsx` and `favicon.svg` must stay the same picture.** The only intended differences are
  that crop and `currentColor` in place of the favicon's `#fff` (the CSS box paints the square,
  so the inline copy has no background `<rect>`). Change the letterform in one and change it in
  the other.
- **The sidebar's `540px` is derived, not chosen**, and the last step is derived differently
  from the first two — read `.sidebar`'s comment in `app.css` before touching it. `420 → 456`
  for the badge itself and `456 → 464` for the 12px → 16px inset both grew the column by exactly
  what was added to the header, holding the tab strip's clearance at 15.63px. `464 → 540` did
  not: it carries the label going 1rem → 1.1rem **and** a stated tolerance for a wider
  `system-ui` than this machine's. Sizing to what fits locally is what put CI red — the runner's
  font is ~1.25× wider, and 464px absorbed 0.99×. 540px absorbs 1.41×. **That ratio is not what
  the suite asserts**, and the reason is worth carrying: its denominator is the running
  machine's own text, so a perfectly healthy row reads ~1.15 on CI, and a floor under it fails
  where fonts are widest — the bug wearing the guard's clothes. `e2e/tests/logo.spec.ts` pins
  the font-independent half instead (px available *for* text: 257, floor 246) plus a low
  backstop on the leftover px (floor 8, where CI has ~33 and this machine 75). Narrowing the
  column re-breaks the header.
- **`.sidebar`'s `padding-top: 14px` IS the badge's y**, and it takes *two* `align-self:
  flex-start` declarations to keep it that way — one on `.sidebar-brand`, one on `.brand-logo`.
  Each removes a different remainder, and the second is the one that looks redundant and is not:
  without it the badge keeps `(brand height − 28) / 2`, which is zero only while the 28px badge
  out-measures the label's line box — i.e. only up to about an 18.67px root font. A remainder
  that happens to be zero is not an authored position. Both are contract placement, not spacing.
  (`.brand-logo`'s own `align-items: center` is unrelated and stays: it centres the *glyph*.)
- **The 16px inset is one value in five rules** — `.sidebar-header`, `.sidebar-content`,
  `.notes-list`'s cancelling negative margin, `.notes-list-scroll` and `.note-row`. Change one and
  the badge stops lining up with the note list below it; that is why the whole set moved together.

**The failure mode here is invisible, which is the reason this section is long.**
`.sidebar-tabs` is `flex: 1; min-width: 0` with no `overflow`, so when the header runs out of
room the strip silently shrinks *below its content* and the tabs paint **underneath** the action
buttons. `.sidebar-actions` never moves, `.sidebar-header` never overflows its box, and
`.sidebar`'s `overflow: hidden` never clips. There is no console error and no layout shift.

So the obvious check does not work: comparing the action buttons' right edge against the
header's returns **clean zero in every visibly broken case**, at every root font size. The two
assertions that can see it are `tabs.scrollWidth > tabs.clientWidth` and the last tab's right
edge against `.sidebar-actions`' left edge. If you add a fit assertion, use one of those.

**A known-open defect in this area, not caused by the logo:** at large root font sizes the tab
strip overflows into the buttons — a WCAG 1.4.4 Resize Text failure that predates the badge and
is tracked separately. **Do not read a header-overflow report at a large root font as a
regression from the logo work.**

The 464 → 540 widening moved this without settling it, so the numbers are worth having exactly.
Measured on one machine, at the 1.1rem label: a 20px root needs a 535px column and therefore now
fits, by 5px; a 24px root needs 612px and still overflows. **Do not treat the 20px case as
fixed.** A 5px margin is 1.02× this machine's text, and CI's `system-ui` is ~1.25× wider — the
same gap that produced the failure this widening was for. It fits the font in front of you.

`e2e/tests/logo.spec.ts` holds this half of the contract. Unlike the footer suite it
was accepted the way `measurement-protocol.md` requires, by being **shown red for the right
reason** rather than merely green. What each mutation did, because the results are not the ones
you would predict:

| Mutation | Result |
|---|---|
| `Logo.tsx` viewBox back to the favicon's `0 0 32 32` | **2 red** — the extent assertion, `ink 5.844px in a 17px glyph box` (34.4%). Every badge-box and glyph-box assertion **stayed green**, which is the whole reason that assertion exists |
| Drop `.brand-logo { color: #fff }` | **1 red** — glyph resolves to `--fg`, `rgb(31, 41, 55)` |
| Drop the pin **and** add `.brand:hover` | **3 red** — the colour test plus both hover tests |
| Add `.brand:hover` alone, pin intact | **0 red — nothing broke.** The pin out-specifies it |
| ~~Give `.brand` a `font-size: 1.1rem`~~ — **this is now the shipped state**, not a mutation. It went **2 red** exactly as this row recorded (the label guard, *and* the header-fit assertion, a wider label pushing the tabs into the buttons), which is why taking the siblings' label size required the column to grow with it. Kept here because it is the clearest demonstration on the table that the header-fit assertion earns its place |
| `padding-left: 4px` on `.brand-logo` | **4 red** on the centring insets (7.5 vs 5.5). The badge stayed 28×28 and the glyph 17×17 throughout — with `box-sizing: border-box`, padding slides the mark off centre without changing either box |
| `align-self: flex-start` → `center` on `.sidebar-brand` | **1 red** — y reads 19.30 not 14 |
| Drop `align-self: flex-start` from `.brand-logo` | **5 red** — the 20/24/32px-root placement tests (y 15 / 18 / 24) and both label-line-height tests. Green at a 16px root throughout, which is exactly why the declaration looks removable |
| Header inset alone back to 12px | **2 red** — placement (x = 12) and the alignment test |
| Change the mark's `d` in `favicon.svg` alone | **1 red** — `web/ts/logo.test.mjs`, which runs on every `./build.sh` rather than only when somebody runs the e2e suite |
| Restore `expect(column.width).toBeCloseTo(420, 0)` in the footer suite | **2 red** — the assertion removed when the column widened (see there); it would now read `Received: 540` |
| Narrow `.sidebar` back to 464px, label left at 1.1rem | **2 red** — the header-fit test (which carries both fit assertions) and the room-to-spare test, the second reporting the cause rather than the symptom: `the header has room for only 181.0px of text (431px available − 250.0px of fixed parts)` |

Run the suite with `./build.sh && ./test-e2e.sh` — see the root `AGENTS.md` — and read the
contract and `measurement-protocol.md` before changing any of these values. As with the footer,
the suite can only tell you that *this* app still satisfies the contract, never that the three
still agree.

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
