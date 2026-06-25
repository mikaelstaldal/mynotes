// Loaded via `node --import ./web/ts/test-preload.mjs` before any test files.
// Registers the resolve hooks that map markdown-it/dompurify bare specifiers to
// the real committed vendor bundles, so tests can import compiled frontend
// modules without a package-manager install.
import { register } from 'node:module';
register('./test-hooks.mjs', import.meta.url);
