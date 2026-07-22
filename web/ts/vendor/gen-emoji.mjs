// Maintainer-only generator. Transforms emojibase-data into the compact
// `web/static/vendor/emoji-<version>.js` bundle consumed by the editor's emoji picker.
//
// Pure fs — no network. Invoked by rebuild.sh with the two source files from
// the installed emojibase-data package:
//
//   node gen-emoji.mjs <en/data.json> <en/messages.json> <out/emoji.js>
//
// data.json     : array of emoji, each { label, tags, emoji, group, order, … }
// messages.json : group metadata { groups: [{ key, message, order }], … }
//
// Output is a single ESM module exporting EMOJI_CATEGORIES, grouped by the
// standard emoji groups and ordered as upstream orders them. The component-only
// group (skin tones / hair) and ungrouped code points (bare regional-indicator
// letters) are dropped — they aren't standalone pickable emoji.

import { readFileSync, writeFileSync } from 'node:fs';

const [, , dataPath, messagesPath, outPath] = process.argv;
if (!dataPath || !messagesPath || !outPath) {
  console.error('usage: node gen-emoji.mjs <data.json> <messages.json> <out.js>');
  process.exit(1);
}

const data = JSON.parse(readFileSync(dataPath, 'utf8'));
const messages = JSON.parse(readFileSync(messagesPath, 'utf8'));

// emojibase group numbers whose members aren't standalone pickable emoji.
const SKIP_GROUPS = new Set([2]); // component (skin tones, hair)

// Title-case the lowercase upstream group labels ("smileys & emotion").
function titleCase(s) {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// group order → { name, emojis:[] }, preserving upstream group ordering.
const groups = new Map();
for (const g of messages.groups) {
  if (SKIP_GROUPS.has(g.order)) continue;
  groups.set(g.order, { name: titleCase(g.message), emojis: [] });
}

for (const e of data) {
  if (e.group === undefined || SKIP_GROUPS.has(e.group)) continue;
  const bucket = groups.get(e.group);
  if (!bucket) continue;
  bucket.emojis.push({
    char: e.emoji,
    name: e.label,
    keywords: Array.isArray(e.tags) ? e.tags.join(' ') : '',
    order: e.order ?? 0,
  });
}

const categories = [];
for (const { name, emojis } of groups.values()) {
  if (emojis.length === 0) continue;
  emojis.sort((a, b) => a.order - b.order);
  categories.push({
    name,
    icon: emojis[0].char,
    emojis: emojis.map(({ char, name, keywords }) =>
      keywords ? { char, name, keywords } : { char, name }),
  });
}

const total = categories.reduce((n, c) => n + c.emojis.length, 0);

const header =
  '// AUTO-GENERATED — do not edit. Regenerate via web/ts/vendor/rebuild.sh.\n' +
  '// Source: emojibase-data (MIT). ' + total + ' emoji across ' + categories.length + ' categories.\n';

writeFileSync(outPath, header + 'export const EMOJI_CATEGORIES = ' + JSON.stringify(categories) + ';\n');
console.error(`Wrote ${outPath} (${total} emoji, ${categories.length} categories)`);
