#!/usr/bin/env bash
# Maintainer-only script. Fetches the pinned upstream sources for the vendored
# browser libraries (CodeMirror, markdown-it, DOMPurify, …) via npm and bundles
# each into a single self-contained ESM file under web/static/vendor/, copies
# Preact's prebuilt ESM modules + type stubs, and builds a test-only jsdom bundle
# under web/ts/vendor/test/ used by the node --test XSS-gate tests.
#
# Every browser bundle filename is version-stamped (e.g. dompurify-3.4.11.js,
# preact-10.29.7.module.js) from the installed package version, so a file's name
# records exactly which upstream release it was built from. The import map in
# web/static/index.html references these filenames by hand, so it MUST be updated
# whenever a version bumps — this script prints the current names at the end as a
# reminder. (internal/icons and the XSS-gate test instead glob the versioned name,
# so they need no edit.)
#
# NOT invoked by build.sh or CI. Run this by hand only when adding or updating
# a vendored library, then commit the regenerated bundle(s).
#
# npm only ever touches a throwaway node_modules here, installed with
# --ignore-scripts (no install-time lifecycle scripts). That keeps the
# package-manager install manual, audited, and out of the automated build —
# build.sh and CI need neither npm nor esbuild.
#
# Requires on $PATH: npm, esbuild, git.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

VENDOR_DIR="$(pwd)"
BROWSER_OUT="$VENDOR_DIR/../../static/vendor"
TEST_DIR="$VENDOR_DIR/test"
PREACT_OUT="$BROWSER_OUT/preact"    # runtime ESM modules served to the browser
PREACT_TYPES="$VENDOR_DIR/preact"   # .d.ts type stubs (compile-time only)

# Read an installed dependency's version from its package.json. Used to stamp the
# vendored bundle filenames so each file's name records its upstream release.
pkgver() { node -p "require('$VENDOR_DIR/node_modules/$1/package.json').version"; }

# --- 1. Browser bundles: CodeMirror, markdown-it, DOMPurify -----------------

# Reconcile package-lock.json with package.json first (a no-op producing no diff
# when they're already in sync, so unchanged runs stay deterministic; it adds
# the missing entries after a dependency is added/bumped). Then do a clean,
# lock-pinned install. `npm ci` alone aborts on an out-of-sync lock.
npm install --package-lock-only --ignore-scripts
npm ci --ignore-scripts

# Versions to stamp into the vendored bundle filenames, read from the freshly
# installed tree. CodeMirror is a composite of several @codemirror/* packages
# with independent versions; its bundle tracks the core @codemirror/view.
CODEMIRROR_VER="$(pkgver @codemirror/view)"
MARKDOWNIT_VER="$(pkgver markdown-it)"
DOMPURIFY_VER="$(pkgver dompurify)"
ASCIIMATH_VER="$(pkgver asciimath2ml)"
MERMAID_VER="$(pkgver mermaid)"
EMOJI_VER="$(pkgver emojibase-data)"
LUCIDE_VER="$(pkgver lucide-static)"
PREACT_VER="$(pkgver preact)"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# asciimath2ml ships CommonJS with a single named export; re-export it as ESM so
# esbuild emits a browser bundle exposing asciiToMathML (AsciiMath -> MathML).
cat > "$WORK_DIR/asciimath-entry.mjs" <<'EOF'
export { asciiToMathML } from "asciimath2ml";
EOF

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

# Mermaid ships an ESM build; re-export its default so esbuild bundles the whole
# diagram engine (it registers diagram types via dynamic import()) into one
# self-contained file. The web UI lazy-imports this bundle only when a note
# actually contains a ```mermaid block (see web/ts/util/mermaid.ts).
cat > "$WORK_DIR/mermaid-entry.mjs" <<'EOF'
export { default } from "mermaid";
EOF

mkdir -p "$BROWSER_OUT"

# The entry files live in $WORK_DIR (/tmp), so esbuild's default upward search
# for node_modules never reaches the install tree in this vendor dir. Point it
# there explicitly. (The jsdom section below writes its entry into $TEST_DIR,
# which already sits next to its own node_modules, so it needs no such hint.)
export NODE_PATH="$VENDOR_DIR/node_modules"

# Bundle filenames are version-stamped, so a version bump changes the name rather
# than overwriting. Remove any previously-vendored bundles first so old versions
# don't linger in the tree.
rm -f "$BROWSER_OUT"/{codemirror,markdown-it,dompurify,asciimath,mermaid,emoji,lucide}-*.js

esbuild "$WORK_DIR/codemirror-entry.mjs" \
  --bundle --format=esm --platform=browser --minify \
  --outfile="$BROWSER_OUT/codemirror-$CODEMIRROR_VER.js"

esbuild "$WORK_DIR/markdown-it-entry.mjs" \
  --bundle --format=esm --platform=browser --minify \
  --outfile="$BROWSER_OUT/markdown-it-$MARKDOWNIT_VER.js"

esbuild "$WORK_DIR/dompurify-entry.mjs" \
  --bundle --format=esm --platform=browser --minify \
  --outfile="$BROWSER_OUT/dompurify-$DOMPURIFY_VER.js"

# asciimath2ml is MIT-licensed; keep the attribution banner in the bundle.
esbuild "$WORK_DIR/asciimath-entry.mjs" \
  --bundle --format=esm --platform=browser --minify \
  --legal-comments=none \
  --banner:js='/*! asciimath2ml '"$ASCIIMATH_VER"' | MIT License | Copyright (c) 2024 Tommi Johtela | https://github.com/johtela/asciimath2ml */' \
  --outfile="$BROWSER_OUT/asciimath-$ASCIIMATH_VER.js"

# Mermaid is large; --bundle inlines its dynamically-imported diagram modules
# into the single output file (no code-splitting), keeping it a plain ESM module
# loadable via the import map like the others.
esbuild "$WORK_DIR/mermaid-entry.mjs" \
  --bundle --format=esm --platform=browser --minify \
  --outfile="$BROWSER_OUT/mermaid-$MERMAID_VER.js"

echo "Wrote versioned browser bundles under $BROWSER_OUT/:"
echo "  codemirror-$CODEMIRROR_VER.js markdown-it-$MARKDOWNIT_VER.js dompurify-$DOMPURIFY_VER.js asciimath-$ASCIIMATH_VER.js mermaid-$MERMAID_VER.js"

# --- 1a. Preact runtime modules + type stubs -------------------------------
#
# Preact ships prebuilt self-contained ESM (dist/*.module.js) plus its own .d.ts,
# so no esbuild step is needed — copy them verbatim. The runtime modules go to
# web/static/vendor/preact/ (served, version-stamped, loaded via the import map);
# the .d.ts go to web/ts/vendor/preact/ (compile-time only, resolved via the
# tsconfig `paths` entries, so they are NOT version-stamped).

mkdir -p "$PREACT_OUT" "$PREACT_TYPES/src" "$PREACT_TYPES/hooks/src" "$PREACT_TYPES/jsx-runtime/src"
rm -f "$PREACT_OUT"/{preact,hooks,jsx-runtime}-*.module.js

PREACT_SRC="$VENDOR_DIR/node_modules/preact"
cp "$PREACT_SRC/dist/preact.module.js"                 "$PREACT_OUT/preact-$PREACT_VER.module.js"
cp "$PREACT_SRC/hooks/dist/hooks.module.js"            "$PREACT_OUT/hooks-$PREACT_VER.module.js"
cp "$PREACT_SRC/jsx-runtime/dist/jsxRuntime.module.js" "$PREACT_OUT/jsx-runtime-$PREACT_VER.module.js"

cp "$PREACT_SRC/src/index.d.ts"             "$PREACT_TYPES/src/index.d.ts"
cp "$PREACT_SRC/src/jsx.d.ts"               "$PREACT_TYPES/src/jsx.d.ts"
cp "$PREACT_SRC/src/dom.d.ts"               "$PREACT_TYPES/src/dom.d.ts"
cp "$PREACT_SRC/hooks/src/index.d.ts"       "$PREACT_TYPES/hooks/src/index.d.ts"
cp "$PREACT_SRC/jsx-runtime/src/index.d.ts" "$PREACT_TYPES/jsx-runtime/src/index.d.ts"

# Preact's .d.ts use extensionless relative imports; this repo's tsconfig uses
# Node16 module resolution, which requires explicit .js extensions. Add them.
cat > "$WORK_DIR/normalize-preact-dts.mjs" <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
const [typesDir] = process.argv.slice(2);
const edits = [
  [`${typesDir}/src/index.d.ts`, [["./jsx", "./jsx.js"], ["./dom", "./dom.js"]]],
  [`${typesDir}/jsx-runtime/src/index.d.ts`, [["../../src/jsx", "../../src/jsx.js"]]],
];
for (const [file, subs] of edits) {
  let s = readFileSync(file, "utf8");
  for (const [from, to] of subs) s = s.split(`from '${from}'`).join(`from '${to}'`);
  writeFileSync(file, s);
}
EOF
node "$WORK_DIR/normalize-preact-dts.mjs" "$PREACT_TYPES"

echo "Wrote $PREACT_OUT/{preact,hooks,jsx-runtime}-$PREACT_VER.module.js + type stubs"

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
  "$BROWSER_OUT/emoji-$EMOJI_VER.js"

# --- 1c. Lucide icon set for the editor's icon picker ----------------------
#
# lucide-static ships the whole icon collection as data: icon-nodes.json (each
# icon's SVG child elements as [tag, attrs] pairs) plus tags.json (search
# keywords). It ships NO category data, so the picker's category tabs come from
# the lucide *source* repo instead — its icons/<name>.json (each icon's category
# membership) and categories/<slug>.json (each category's title + representative
# tab icon). We sparse-checkout just those two metadata dirs at a pinned tag.
# gen-lucide.mjs (committed, fs-only, no network) transforms all of it into the
# compact LUCIDE_ICON_NODES + LUCIDE_ICONS + LUCIDE_CATEGORIES bundle the picker
# and the <Icon> component import as "lucide-icons". Its LUCIDE_ICON_NODES export
# is the single embedded copy of the icon geometry: the Go server (internal/icons)
# reads it from the same bundle and rebuilds each icon's SVG to serve GET
# /api/v1/icons/lucide/{name}, so nothing is embedded twice and the two sides
# can't drift. gen-lucide intersects category membership with the shipped set, so
# a handful of icons the pinned source and lucide-static disagree on drop out
# cleanly. No esbuild needed — the generator emits plain files directly.

# Pinned lucide source ref the category metadata is taken from. Bump alongside
# the lucide-static version in package.json when refreshing the icon set.
LUCIDE_REF="main"
LUCIDE_SRC="$WORK_DIR/lucide-src"
git clone --depth 1 --branch "$LUCIDE_REF" --filter=blob:none --sparse \
  https://github.com/lucide-icons/lucide.git "$LUCIDE_SRC"
git -C "$LUCIDE_SRC" sparse-checkout set icons categories

node "$VENDOR_DIR/gen-lucide.mjs" \
  "$VENDOR_DIR/node_modules/lucide-static/icon-nodes.json" \
  "$VENDOR_DIR/node_modules/lucide-static/tags.json" \
  "$BROWSER_OUT/lucide-$LUCIDE_VER.js" \
  "$LUCIDE_SRC/icons" \
  "$LUCIDE_SRC/categories"

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

# --- 3. Reminder: keep the import map in sync -------------------------------
#
# The bundle filenames are version-stamped, so update the import map in
# web/static/index.html to reference the names printed above whenever a version
# bumped. (internal/icons and web/ts/xss-gate.test.mjs glob the versioned name,
# so they need no edit.)
cat <<EOF

Reminder: update the import map in web/static/index.html to reference:
  preact         -> ./vendor/preact/preact-$PREACT_VER.module.js
  preact/hooks   -> ./vendor/preact/hooks-$PREACT_VER.module.js
  preact/jsx-runtime -> ./vendor/preact/jsx-runtime-$PREACT_VER.module.js
  codemirror     -> ./vendor/codemirror-$CODEMIRROR_VER.js
  markdown-it    -> ./vendor/markdown-it-$MARKDOWNIT_VER.js
  dompurify      -> ./vendor/dompurify-$DOMPURIFY_VER.js
  emoji-data     -> ./vendor/emoji-$EMOJI_VER.js
  lucide-icons   -> ./vendor/lucide-$LUCIDE_VER.js
  asciimath      -> ./vendor/asciimath-$ASCIIMATH_VER.js
  mermaid        -> ./vendor/mermaid-$MERMAID_VER.js
EOF
