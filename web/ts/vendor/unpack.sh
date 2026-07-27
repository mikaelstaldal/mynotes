#!/usr/bin/env bash
# Extracts the committed TypeScript declarations (types-node_modules.tar.gz)
# into ./node_modules so `tsc` can type-check the frontend from a clean
# checkout.
#
# Why this exists: the runtime code is vendored as pre-built bundles in
# web/static/vendor/, but their *type* declarations are not part of those
# bundles. tsconfig.json maps 'markdown-it' and 'dompurify' into this
# directory's node_modules, and codemirror.d.ts re-exports from it, so without
# these files the build fails with TS2307. They are vendored as ONE
# deterministic tarball rather than ~100 loose files under a path that
# rebuild.sh owns and would clobber — the same treatment jsdom gets in test/.
#
# Only declarations are in here: package.json (needed for module resolution),
# *.d.ts/*.d.mts/*.d.cts, and LICENSE. No JavaScript ships in this tarball, and
# nothing from it reaches the browser.
#
# Idempotent, and a no-op on a maintainer machine where rebuild.sh has already
# installed the full tree. Uses only tar/gzip (no package manager), so build.sh
# stays free of npm. Regenerate via web/ts/vendor/rebuild.sh (maintainer-only).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

# The declaration tsconfig.json's 'markdown-it' path mapping points at — the
# first thing that fails without this tree, and so the marker for "already
# present", whether from this tarball or from a full npm install.
MARKER=node_modules/@types/markdown-it/index.d.mts

if [ ! -f "$MARKER" ]; then
  tar -xzf types-node_modules.tar.gz
fi
