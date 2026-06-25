// Custom ESM resolve hooks — loaded via module.register() from test-preload.mjs.
// Maps bare specifiers used in compiled frontend modules to the real committed
// vendor bundles in web/static/vendor/, mirroring the browser import map.
// jsdom is intentionally NOT remapped: vendor/test/jsdom.js re-exports it as a
// bare specifier resolved against vendor/test/node_modules/ (restored by
// unpack.sh), so the default resolver handles it correctly from that directory.
import { fileURLToPath } from 'node:url';
import { resolve as pathResolve, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENDOR = pathResolve(__dirname, '../static/vendor');

const SPECIFIER_MAP = {
  'markdown-it': new URL(`file://${VENDOR}/markdown-it.js`).href,
  'dompurify': new URL(`file://${VENDOR}/dompurify.js`).href,
};

export async function resolve(specifier, context, nextResolve) {
  const mapped = SPECIFIER_MAP[specifier];
  if (mapped) return { shortCircuit: true, url: mapped };
  return nextResolve(specifier, context);
}
