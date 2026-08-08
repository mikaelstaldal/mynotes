#!/usr/bin/env bash
# Runs the Playwright suite against a freshly started server.
#
# This is the entry point CI uses, and it is the one to use locally when you
# want the same conditions CI gets. Interactively, `playwright-test` from the
# e2e directory is still the way to run a single spec (see e2e/AGENTS.md).
#
# It does not build. Run ./build.sh first — and note that the binary embeds
# web/static/, so a server started from a stale binary serves stale assets and
# the suite then measures something other than what you edited. The freshness
# check below exists to make that impossible rather than merely unlikely.
set -euo pipefail

# Every path below is repo-relative, including the freshness check — without
# this, running from elsewhere fails with a "stale app.css" message that is
# actively misleading about what went wrong.
cd "$(dirname "${BASH_SOURCE[0]}")"

BINARY=./mynotes
PORT=8091
# A fresh database per run, in a directory this script owns and removes.
# Reusing one is how an "empty" run silently becomes a run against whatever the
# last one left behind.
DATA_DIR=$(mktemp -d)

SERVER_PID=

cleanup() {
    if [ -n "$SERVER_PID" ]; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    rm -rf "$DATA_DIR"
}

trap cleanup EXIT
# An untrapped fatal signal terminates bash *without* running the EXIT trap, so
# the server would survive the script and squat the port — the exact condition
# the pre-flight check below refuses to start on, meaning the next run fails
# rather than the current one. SIGPIPE is the candidate: piping this script into
# `head` or `grep -m1` closes stdout under it.
#
# Adopted from MyMail, which measured that leak. **It does not reproduce here**,
# and the honest version of that is worth writing down rather than transcribing
# their result: `2>&1 | head -5`, `2>&1 | grep -m1 passed`, `| head -1` and a
# mid-run SIGINT were each tried against this script and cleanup ran in all four,
# leaving nothing on the port. Only SIGKILL leaks, and no trap can catch that.
# Kept anyway — it is one line, it costs nothing, the general claim about
# untrapped signals is true whether or not this script's pipelines reach it, and
# the three suites should not differ here by accident.
#
# Re-raising via `exit` rather than adding the signals to the EXIT trap's list:
# listing them there runs cleanup twice, once per trap.
trap 'exit 1' INT TERM PIPE

if [ ! -x "$BINARY" ]; then
    echo "$BINARY not found or not executable — run ./build.sh first" >&2
    exit 1
fi

# Refuse to start if the port is already taken. Ours would exit on bind failure
# while the readiness probe below succeeded against whatever is squatting, and
# the suite would then run against a database and a binary that are not the ones
# under test. That happened in the sibling repo this script came from.
#
# Checked here rather than by watching our own process afterwards: a background
# process that has exited is a zombie until reaped, and `kill -0` succeeds on a
# zombie — so the obvious liveness check silently passes in exactly this case.
# (It was tried there, against a real squatter, and reported 48/48 green.)
if (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
    exec 3<&- 3>&-
    echo "Something is already listening on port ${PORT}." >&2
    echo "Stop it first — otherwise these tests would run against it, not against this build." >&2
    exit 1
fi

# -public-url must match the baseURL origin in e2e/playwright.config.ts, or CSRF
# rejects any write driven through the PAGE with 403.
#
# Stated precisely because the obvious stronger claim is wrong, and was checked:
# go-server-common's csrf.Middleware allows a request carrying neither Origin nor
# Referer (that is the native-client path), and Playwright's `request` fixture
# sends neither — so an API-level POST returns 201 even against a deliberately
# mismatched -public-url. Measured: 201 without an Origin header, 403 with a
# page-style one. The flag therefore costs nothing today and is required the
# moment a test clicks Save instead of calling the API, which is exactly when it
# would be hardest to diagnose.
#
# The server binds 127.0.0.1 (the -addr default) and everything here addresses
# `localhost`. On a host that resolves localhost to ::1 only, the readiness probe
# below fails and the run stops with "Server failed to start" — loud and wrong
# about the cause, but not silent. Kept as `localhost` because -public-url and the
# config's baseURL have to agree with each other, and they are shared with the
# sibling suites.
"$BINARY" -port "$PORT" -data "$DATA_DIR" -public-url "http://localhost:${PORT}" &
SERVER_PID=$!

# GET /api/v1/notes answers on an empty database ({"total":0,"notes":[]}), so
# this probes the real API rather than the SPA shell — which the server returns
# for any unmatched path and which would therefore go 200 before the database
# was open.
for i in $(seq 1 40); do
    if curl -sf "http://localhost:${PORT}/api/v1/notes" > /dev/null 2>&1; then
        break
    fi
    if [ "$i" -eq 40 ]; then
        echo "Server failed to start on port ${PORT}" >&2
        exit 1
    fi
    sleep 0.5
done

# Prove the server is serving the build under test. A green suite run against a
# stale binary is not evidence, and it fails in the reassuring direction: the
# tests pass, describing a version of the app that is not the one on disk.
#
# Every emitted script and stylesheet, not a sample of them. Hashing app.css and
# app.js alone looks sufficient and is not: tsc emits one module per source file
# and there are ~55 of them under web/static/, so editing views/NoteView.ts leaves
# BOTH of those files byte-identical and a two-file check passes a server serving
# 53 stale modules. A guard that samples the assets is not a guard against
# staleness; it is a guard against staleness in the two files nobody was going to
# edit alone.
#
# Three exclusions, all deliberate, because an undocumented one reads as an
# oversight and quietly narrows what "fresh" means here:
#   * vendor/ is committed rather than emitted (see AGENTS.md — no package
#     manager runs in this build), so it cannot go stale relative to a build.
#   * public/ is not served as a static file at all. web/static/public/page.css
#     is only ever delivered concatenated onto render/note.css, at
#     /public/note.css — handled separately below, because a find that included
#     it here would fetch a 404 (the /public/ catch-all) and fail for the wrong
#     reason.
#   * *.html is not matched by the find. web/static/index.html is served through
#     buildIndexHTML, which may splice a window.__serverConfig <script> into it,
#     so it is byte-identical to disk for some -public-url values and not others —
#     a comparison that passes for a reason unrelated to freshness is worse than
#     none. render/index.html has no such rewrite and IS checked, separately
#     below, at the URL it is actually reachable from.
# The demo worker's output IS included: it is served the same way and goes stale
# the same way.
stale=0
checked=0
while IFS= read -r path; do
    asset=${path#web/static/}
    if ! served=$(curl -sf "http://localhost:${PORT}/${asset}" | md5sum | cut -d' ' -f1); then
        echo "Could not fetch /${asset} from the test server." >&2
        exit 1
    fi
    ondisk=$(md5sum "$path" | cut -d' ' -f1)
    if [ "$served" != "$ondisk" ]; then
        echo "Server is serving a stale ${asset} (served $served, on disk $ondisk)." >&2
        stale=$((stale + 1))
    fi
    checked=$((checked + 1))
done < <(find web/static \( -name '*.js' -o -name '*.css' \) \
    -not -path '*/vendor/*' -not -path 'web/static/public/*' | sort)

# The published-page stylesheet, which is the one asset with no 1:1 URL. main.go
# concatenates render/note.css + '\n' + public/page.css at startup and serves the
# result at /public/note.css, so this is the only way page.css's freshness is
# observable from outside the process — and it is embedded in the binary exactly
# like everything above, so it goes stale exactly like everything above.
if ! served=$(curl -sf "http://localhost:${PORT}/public/note.css" | md5sum | cut -d' ' -f1); then
    echo "Could not fetch /public/note.css from the test server." >&2
    exit 1
fi
ondisk=$({ cat web/static/render/note.css; printf '\n'; cat web/static/public/page.css; } \
    | md5sum | cut -d' ' -f1)
if [ "$served" != "$ondisk" ]; then
    echo "Server is serving a stale /public/note.css (served $served, on disk $ondisk)." >&2
    stale=$((stale + 1))
fi
checked=$((checked + 1))

# The render kit's host page, served verbatim at /render/ — main.go registers it
# explicitly because http.FileServer canonicalises /render/index.html to /render/
# and would otherwise leave it unreachable, so /render/index.html is a 301 and
# this is the URL to hash. Worth its own line rather than left out with the other
# HTML: it carries a hand-maintained import map and a <meta> CSP hash that
# web/AGENTS.md warns must be kept in sync with web/static/index.html, and it is
# the file tools/dist-renderer.sh copies into native clients.
if ! served=$(curl -sf "http://localhost:${PORT}/render/" | md5sum | cut -d' ' -f1); then
    echo "Could not fetch /render/ from the test server." >&2
    exit 1
fi
ondisk=$(md5sum web/static/render/index.html | cut -d' ' -f1)
if [ "$served" != "$ondisk" ]; then
    echo "Server is serving a stale /render/ host page (served $served, on disk $ondisk)." >&2
    stale=$((stale + 1))
fi
checked=$((checked + 1))

# A find that matches nothing would report zero stale files and read as a pass —
# the empty-set failure this kind of guard has been bitten by before. Note the
# floor is not 0 but 2: the two explicit checks above always run, so `checked`
# is never 0 even when the find matches nothing.
if [ "$checked" -le 2 ]; then
    echo "Freshness check found no assets to compare — is web/static/ built?" >&2
    exit 1
fi
if [ "$stale" -gt 0 ]; then
    echo "${stale} of ${checked} assets are stale." >&2
    echo "The binary embeds web/static/ — rebuild with ./build.sh and try again." >&2
    exit 1
fi

cd e2e
# `playwright-test` is a local wrapper for exactly this command and is the
# interactive entry point e2e/AGENTS.md names; CI has no such wrapper, so fall
# through to the bin npm links. (Both @playwright/test and playwright declare a
# `playwright` bin, so which package npm links is a hoisting detail — but the
# bin is stable either way, which a hardcoded node_modules/playwright/cli.js
# path would not be.)
if command -v playwright-test > /dev/null 2>&1; then
    playwright-test "$@"
elif [ -x ./node_modules/.bin/playwright ]; then
    ./node_modules/.bin/playwright test "$@"
else
    echo "Playwright is not installed — run 'npm ci' in e2e/ first." >&2
    exit 1
fi
