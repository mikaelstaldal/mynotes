// Custom ESM resolve hooks — loaded via module.register() from test-preload.mjs.
// Maps bare specifiers used in compiled frontend modules to the real committed
// vendor bundles in web/static/vendor/, mirroring the browser import map.
// jsdom is intentionally NOT remapped: vendor/test/jsdom.js re-exports it as a
// bare specifier resolved against vendor/test/node_modules/ (restored by
// unpack.sh), so the default resolver handles it correctly from that directory.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as pathResolve, dirname, join } from 'node:path';
import { readdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENDOR = pathResolve(__dirname, '../static/vendor');

// The bundle filenames carry the upstream version (e.g. markdown-it-14.2.0.js),
// so resolve each by its prefix rather than a pinned name — no edit needed here
// when a version bumps (see web/ts/vendor/rebuild.sh).
function bundle(prefix) {
  const matches = readdirSync(VENDOR).filter(
    (f) => f.startsWith(prefix) && f.endsWith('.js'),
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${prefix}*.js in ${VENDOR}, found ${matches.length}`,
    );
  }
  return pathToFileURL(join(VENDOR, matches[0])).href;
}

const SPECIFIER_MAP = {
  'markdown-it': bundle('markdown-it-'),
  'dompurify': bundle('dompurify-'),
  'asciimath': bundle('asciimath-'),
  'lucide-icons': bundle('lucide-'),
};

export async function resolve(specifier, context, nextResolve) {
  const mapped = SPECIFIER_MAP[specifier];
  if (mapped) return { shortCircuit: true, url: mapped };
  return nextResolve(specifier, context);
}
