# AI coding agent instructions — end-to-end tests

Guidance for AI coding agents working on the Playwright suite under `e2e/`. It
supplements the repository-root `AGENTS.md`, which is always loaded; paths below
are written relative to the repository root, as they are there.

The root `AGENTS.md` § E2E tests has what someone who never opens this directory
still needs: that the suite exists, that `./build.sh && ./test-e2e.sh` from the
repository root is how it runs, that it gates publication in CI, and that it holds
this repo's half of the cross-repo sidebar-footer contract. This file is the rest.

## Prefer `test-e2e.sh` over starting a server by hand

The two things it exists to prevent are easy to hit and neither announces itself:

- **A stale server.** `web/embed.go` bakes `web/static/` into the binary, so a running
  `./mynotes` keeps serving the CSS and JS it started with — `./build.sh` alone changes
  nothing it serves. The suite then passes or fails against assets that are not the ones you
  edited. When a measurement disagrees with the source, check this first:
  ```bash
  curl -s http://localhost:8091/app.css | md5sum   # must match
  md5sum web/static/app.css
  ```
- **A stale database, or someone else's server on the port.** Reusing a data directory is how
  an "empty" run silently becomes a run against whatever the last one left behind; and if
  something already holds 8091, a hand-started server exits on bind failure while the tests
  run happily against the squatter.

If you do start one by hand, `-public-url` must match the test baseURL origin
(`http://localhost:8091`), or CSRF rejects with 403 any write driven **through the page**.
Not every write: `csrf.Middleware` allows a request carrying neither `Origin` nor `Referer`
(the native-client path), and Playwright's `request` fixture sends neither — so an API-level
write succeeds against a mismatched `-public-url` and the flag only bites once a test clicks
Save. Measured, not assumed: 201 without an `Origin` header, 403 with a page-style one.

*Important:* interactively, use the `playwright-test` command from `e2e/` and nothing else —
do not invent variants. `test-e2e.sh` falls back to `./node_modules/.bin/playwright test` when
that wrapper is absent, which is the case in CI; that fallback is sanctioned and is the only
one. `e2e/package.json`'s `npm test` / `npm run test:headed` exist for parity with the sibling
repos and are **not** that path — they run `playwright test` against a server you must already
have started yourself, with no port check and no freshness check, so they skip everything the
two bullets above are about.

## Two things the suite does not pin, both deliberate

- **The Chromium build is not pinned by anything committed.** `npx playwright install` fetches
  a browser matched to the `@playwright/test` version in `e2e/package-lock.json`, from
  Microsoft's CDN, on every CI run. The npm side is locked; the browser side is not, and a
  browser change can move a rendered measurement. If a geometry assertion moves with no
  matching source change, suspect this before suspecting the assertion.
- **`e2e/tsconfig.json` is not executed by anything.** Playwright transpiles the specs without
  type-checking, and neither `build.sh` (which has no `node_modules` on a clean checkout) nor
  the workflow runs `tsc` over `e2e/`, so its `strict: true` is only worth what someone runs by
  hand. Do run it after editing a spec — `tsc --noEmit -p tsconfig.json` from `e2e/` — and note
  that it exits **0 with no output** here, which is the whole point of the `skipLibCheck` and
  `target: ES2022` that file explains: without them `playwright-core`'s own declarations
  produce 96 errors, none of them in `tests/**`, and a real error in a spec is then
  indistinguishable from the noise. (The file therefore matches MyMail's rather than MyCal's,
  which still has the noise.) Wiring the command into CI is a change all three repos should
  make together.
