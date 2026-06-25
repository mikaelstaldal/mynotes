// esbuild could not bundle jsdom into a working ESM module (it does dynamic
// require() of Node builtins, and reads data files like its default stylesheet
// from its own package dir at runtime) — falling back to a thin re-export
// resolved against jsdom's vendored install tree. That tree is committed as the
// single deterministic jsdom-node_modules.tar.gz in this directory; unpack.sh
// extracts it to ./node_modules before the tests run. See rebuild.sh.
export { JSDOM } from "jsdom";
