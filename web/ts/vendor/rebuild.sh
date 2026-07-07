#!/usr/bin/env bash
# Maintainer-only script. Fetches the pinned upstream sources for the vendored
# browser libraries (CodeMirror, markdown-it, DOMPurify) via npm and bundles
# each into a single self-contained ESM file under web/static/vendor/, plus a
# test-only jsdom bundle under web/ts/vendor/test/ used by the node --test
# XSS-gate tests.
#
# NOT invoked by build.sh or CI. Run this by hand only when adding or updating
# a vendored library, then commit the regenerated bundle(s).
#
# npm only ever touches a throwaway node_modules here, installed with
# --ignore-scripts (no install-time lifecycle scripts). That keeps the
# package-manager install manual, audited, and out of the automated build —
# build.sh and CI need neither npm nor esbuild.
#
# Requires on $PATH: npm, esbuild.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

VENDOR_DIR="$(pwd)"
BROWSER_OUT="$VENDOR_DIR/../../static/vendor"
TEST_DIR="$VENDOR_DIR/test"

# --- 1. Browser bundles: CodeMirror, markdown-it, DOMPurify -----------------

# Reconcile package-lock.json with package.json first (a no-op producing no diff
# when they're already in sync, so unchanged runs stay deterministic; it adds
# the missing entries after a dependency is added/bumped). Then do a clean,
# lock-pinned install. `npm ci` alone aborts on an out-of-sync lock.
npm install --package-lock-only --ignore-scripts
npm ci --ignore-scripts

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# Fixed minimal symbol surface (see CLAUDE.md / spec/TASKS.md). Deliberately
# excludes @codemirror/search, line numbers/gutters, placeholder, bracket
# matching, and EditorView.theme (styling lives in app.css, not JS themes).
cat > "$WORK_DIR/codemirror-entry.mjs" <<'EOF'
export { EditorView, keymap, ViewPlugin, Decoration, WidgetType } from "@codemirror/view";
export { EditorState, EditorSelection } from "@codemirror/state";
export { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
export { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
export { markdown } from "@codemirror/lang-markdown";
EOF

cat > "$WORK_DIR/markdown-it-entry.mjs" <<'EOF'
import MarkdownIt from "markdown-it";
export default MarkdownIt;
EOF

cat > "$WORK_DIR/dompurify-entry.mjs" <<'EOF'
import DOMPurify from "dompurify";
export default DOMPurify;
EOF

mkdir -p "$BROWSER_OUT"

# The entry files live in $WORK_DIR (/tmp), so esbuild's default upward search
# for node_modules never reaches the install tree in this vendor dir. Point it
# there explicitly. (The jsdom section below writes its entry into $TEST_DIR,
# which already sits next to its own node_modules, so it needs no such hint.)
export NODE_PATH="$VENDOR_DIR/node_modules"

esbuild "$WORK_DIR/codemirror-entry.mjs" \
  --bundle --format=esm --platform=browser --minify \
  --outfile="$BROWSER_OUT/codemirror.js"

esbuild "$WORK_DIR/markdown-it-entry.mjs" \
  --bundle --format=esm --platform=browser --minify \
  --outfile="$BROWSER_OUT/markdown-it.js"

esbuild "$WORK_DIR/dompurify-entry.mjs" \
  --bundle --format=esm --platform=browser --minify \
  --outfile="$BROWSER_OUT/dompurify.js"

echo "Wrote $BROWSER_OUT/{codemirror,markdown-it,dompurify}.js"

# --- 1b. Emoji dataset for the editor's emoji picker ------------------------
#
# emojibase-data ships the CLDR emoji list with per-emoji labels + keyword
# tags and standard group numbers. gen-emoji.mjs (committed, fs-only, no
# network) transforms its en/data.json + en/messages.json into the compact
# EMOJI_CATEGORIES bundle the picker imports as "emoji-data". No esbuild needed
# — the generator emits a plain ESM module directly.

node "$VENDOR_DIR/gen-emoji.mjs" \
  "$VENDOR_DIR/node_modules/emojibase-data/en/data.json" \
  "$VENDOR_DIR/node_modules/emojibase-data/en/messages.json" \
  "$BROWSER_OUT/emoji.js"

# --- 2. Test-only jsdom bundle (never shipped to the browser) ---------------
#
# Kept in its own throwaway install, isolated from the browser deps above, so
# that if esbuild can't bundle it (jsdom does optional native/dynamic
# requires that don't always survive static bundling) the fallback below can
# vendor exactly jsdom's own dependency closure — nothing else.

(
  cd "$TEST_DIR"
  if [ ! -f package-lock.json ]; then
    npm install --package-lock-only --ignore-scripts
  fi
  npm ci --ignore-scripts
)

cat > "$TEST_DIR/jsdom-entry.mjs" <<'EOF'
export { JSDOM } from "jsdom";
EOF

# A clean esbuild exit is NOT sufficient: esbuild happily emits ESM that wraps
# jsdom's dynamic require() of Node builtins in a __require shim which throws
# ("Dynamic require of \"path\" is not supported") the moment you construct a
# JSDOM. So only accept the bundle if it both builds AND actually constructs a
# DOM under node; otherwise fall back to vendoring jsdom's install tree.
bundle_ok=0
if esbuild "$TEST_DIR/jsdom-entry.mjs" \
  --bundle --format=esm --platform=node \
  --external:canvas --external:bufferutil --external:utf-8-validate \
  --outfile="$TEST_DIR/jsdom.js"
then
  if node --input-type=module -e '
    import { pathToFileURL } from "node:url";
    const { JSDOM } = await import(pathToFileURL(process.argv[1]).href);
    const dom = new JSDOM("<p>ok</p>");
    if (dom.window.document.querySelector("p")?.textContent !== "ok") {
      throw new Error("jsdom bundle loaded but produced no DOM");
    }
  ' "$TEST_DIR/jsdom.js" 2>/dev/null
  then
    bundle_ok=1
  fi
fi

rm -f "$TEST_DIR/jsdom-entry.mjs"

if [ "$bundle_ok" = 1 ]; then
  rm -rf "$TEST_DIR/node_modules"
  rm -f "$TEST_DIR/jsdom-node_modules.tar.gz"
  echo "Wrote $TEST_DIR/jsdom.js (bundled)"
else
  cat > "$TEST_DIR/jsdom.js" <<'EOF'
// esbuild could not bundle jsdom into a working ESM module (it does dynamic
// require() of Node builtins, and reads data files like its default stylesheet
// from its own package dir at runtime) — falling back to a thin re-export
// resolved against jsdom's vendored install tree. That tree is committed as the
// single deterministic jsdom-node_modules.tar.gz in this directory; unpack.sh
// extracts it to ./node_modules before the tests run. See rebuild.sh.
export { JSDOM } from "jsdom";
EOF
  # Vendor jsdom's dependency closure as ONE deterministic tarball rather than
  # ~1800 loose files. --sort/--mtime/--numeric-owner + `gzip -n` make the
  # archive byte-identical across rebuilds, so an unchanged tree is no-diff in
  # git. unpack.sh (tar only, no npm) restores it at test time.
  ( cd "$TEST_DIR" \
    && tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='UTC 2020-01-01' \
         -cf - node_modules | gzip -n -9 > jsdom-node_modules.tar.gz \
    && rm -rf node_modules )
  echo "esbuild bundle of jsdom is non-functional; vendored its install tree as"
  echo "$TEST_DIR/jsdom-node_modules.tar.gz. Commit it together with $TEST_DIR/jsdom.js."
fi
