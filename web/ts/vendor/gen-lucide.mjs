// Maintainer-only generator. Transforms lucide-static's icon-nodes.json +
// tags.json into the compact `web/static/vendor/lucide.js` bundle consumed by
// the editor's icon picker and the reusable <Icon> component.
//
// Pure fs — no network. Invoked by rebuild.sh with the source files from the
// installed lucide-static package plus the icon/category metadata checked out
// from the lucide source repo (lucide-static ships no category data):
//
//   node gen-lucide.mjs <icon-nodes.json> <tags.json> <out/lucide.js> \
//                       <icons-meta-dir> <categories-meta-dir>
//
// icon-nodes.json : { "<kebab-name>": [ ["<tag>", {<attrs>}], … ], … }
//                   each icon is the ordered list of child elements that go
//                   inside a 24×24 <svg> (Lucide's canonical IconNode shape).
// tags.json       : { "<kebab-name>": ["keyword", …], … } search keywords.
// icons-meta-dir  : lucide repo's icons/ dir — one <name>.json per icon whose
//                   "categories": ["<slug>", …] field gives category membership.
// categories-meta-dir : lucide repo's categories/ dir — one <slug>.json per
//                   category with { "title", "icon" } (display label + the
//                   representative icon shown on the picker's category tab).
//
// Single output — the browser ESM module lucide.js. Its LUCIDE_ICON_NODES export
// is the one embedded copy of the icon geometry: the frontend imports it, and
// the Go server (internal/icons) reads it from the same embedded bundle and
// reconstructs each icon's standalone <svg> to serve GET
// /api/v1/icons/lucide/{name}, so the two sides can never drift and the set is
// embedded in the binary only once.
//
// The ESM module exports:
//   LUCIDE_ICON_NODES : Record<name, IconNode>  — authoritative icon geometry,
//                       reused to build an <svg> anywhere in the web UI.
//   LUCIDE_ICONS      : { name, keywords }[]     — alphabetical list with a
//                       space-joined search string, driving the picker grid.
//   LUCIDE_CATEGORIES : { name, icon, icons }[]  — alphabetical (by title) list
//                       of categories, each with its representative tab icon and
//                       its member icon names, driving the picker's category
//                       tabs. Mirrors EMOJI_CATEGORIES in the emoji bundle.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [, , nodesPath, tagsPath, jsOutPath, iconsMetaDir, categoriesMetaDir] = process.argv;
if (!nodesPath || !tagsPath || !jsOutPath || !iconsMetaDir || !categoriesMetaDir) {
  console.error(
    'usage: node gen-lucide.mjs <icon-nodes.json> <tags.json> <out.js>' +
      ' <icons-meta-dir> <categories-meta-dir>',
  );
  process.exit(1);
}

const nodes = JSON.parse(readFileSync(nodesPath, 'utf8'));
const tags = JSON.parse(readFileSync(tagsPath, 'utf8'));

// Alphabetical, so both the map and the list have a stable, deterministic order
// (unchanged runs produce a byte-identical bundle — no spurious git diff).
const names = Object.keys(nodes).sort();

const shipped = new Set(names);

const sortedNodes = {};
const list = [];
// slug → member icon names, filled while iterating icons below.
const membership = {};
for (const name of names) {
  sortedNodes[name] = nodes[name];
  const kw = Array.isArray(tags[name]) ? tags[name].join(' ') : '';
  list.push({ name, keywords: kw });

  // Each shipped icon's <name>.json lists the category slugs it belongs to;
  // invert that into slug → [names]. Iterating `names` (already sorted) keeps
  // every category's member list alphabetical and deterministic.
  const meta = JSON.parse(readFileSync(join(iconsMetaDir, `${name}.json`), 'utf8'));
  for (const slug of meta.categories ?? []) {
    (membership[slug] ??= []).push(name);
  }
}

// Build the category list from the categories/ metadata: alphabetical by title
// (matching lucide.dev/icons/categories), each carrying its representative tab
// icon and its shipped member names. Skip categories with no shipped icons, and
// fall back to the first member if the declared representative icon isn't
// shipped (keeps the tab renderable).
const categories = [];
for (const file of readdirSync(categoriesMetaDir).sort()) {
  if (!file.endsWith('.json')) continue;
  const slug = file.slice(0, -'.json'.length);
  const icons = membership[slug];
  if (!icons || icons.length === 0) continue;
  const { title, icon } = JSON.parse(readFileSync(join(categoriesMetaDir, file), 'utf8'));
  categories.push({
    name: title,
    icon: shipped.has(icon) ? icon : icons[0],
    icons,
  });
}
categories.sort((a, b) => a.name.localeCompare(b.name));

const header =
  '// AUTO-GENERATED — do not edit. Regenerate via web/ts/vendor/rebuild.sh.\n' +
  '// Source: lucide-static (ISC License). ' + names.length + ' icons, ' +
  categories.length + ' categories.\n';

writeFileSync(
  jsOutPath,
  header +
    'export const LUCIDE_ICON_NODES = ' + JSON.stringify(sortedNodes) + ';\n' +
    'export const LUCIDE_ICONS = ' + JSON.stringify(list) + ';\n' +
    'export const LUCIDE_CATEGORIES = ' + JSON.stringify(categories) + ';\n',
);
console.error(
  `Wrote ${jsOutPath} (${names.length} icons, ${categories.length} categories)`,
);
