// Maintainer-only generator. Transforms emojibase-data into the compact
// `web/static/vendor/emoji-<version>.js` bundle consumed by the editor's emoji
// picker and the Markdown renderer's `:shortcode:` transform.
//
// Pure fs — no network. Invoked by rebuild.sh with the source files from the
// installed emojibase-data package:
//
//   node gen-emoji.mjs <en/data.json> <en/messages.json> \
//     <en/shortcodes/github.json> <out/emoji.js>
//
// data.json      : array of emoji, each { label, tags, emoji, hexcode, group, order, … }
// messages.json  : group metadata { groups: [{ key, message, order }], … }
// github.json    : hexcode -> GitHub shortcode(s) (string | string[])
//
// Only GitHub-compatible shortcodes are recognized, matching the familiar
// GitHub/Slack `:name:` convention. Output is a single ESM module exporting:
//   EMOJI_CATEGORIES — emoji grouped by the standard emoji groups (as the picker
//     shows them), each emoji carrying its primary `shortcode` (the `:name:` the
//     picker inserts) when it has a GitHub shortcode; emoji with none carry no
//     `shortcode`, so the picker inserts their raw character instead.
//   EMOJI_SHORTCODES — a flat { shortcode: char } map covering every GitHub
//     shortcode of every pickable emoji, so the renderer resolves any GitHub
//     `:name:` alias a user might type, not just the picker's primary one.
// The component-only group (skin tones / hair) and ungrouped code points (bare
// regional-indicator letters) are dropped — they aren't standalone pickable emoji.

import { readFileSync, writeFileSync } from 'node:fs';

const [, , dataPath, messagesPath, githubPath, outPath] = process.argv;
if (!dataPath || !messagesPath || !githubPath || !outPath) {
  console.error(
    'usage: node gen-emoji.mjs <data.json> <messages.json> <github.json> <out.js>',
  );
  process.exit(1);
}

const data = JSON.parse(readFileSync(dataPath, 'utf8'));
const messages = JSON.parse(readFileSync(messagesPath, 'utf8'));
const githubShortcodes = JSON.parse(readFileSync(githubPath, 'utf8'));

// emojibase group numbers whose members aren't standalone pickable emoji.
const SKIP_GROUPS = new Set([2]); // component (skin tones, hair)

// Normalize a shortcode map value (string | string[] | undefined) to an array.
function shortcodesFor(map, hexcode) {
  const v = map[hexcode];
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

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

// Flat { shortcode: char } map for the renderer, GitHub shortcodes only.
const shortcodeMap = {};

for (const e of data) {
  if (e.group === undefined || SKIP_GROUPS.has(e.group)) continue;
  const bucket = groups.get(e.group);
  if (!bucket) continue;
  const github = shortcodesFor(githubShortcodes, e.hexcode);
  for (const code of github) {
    if (!(code in shortcodeMap)) shortcodeMap[code] = e.emoji;
  }
  bucket.emojis.push({
    char: e.emoji,
    name: e.label,
    keywords: Array.isArray(e.tags) ? e.tags.join(' ') : '',
    // Primary shortcode the picker inserts (the first GitHub alias); undefined
    // when the emoji has no GitHub shortcode, so the picker inserts its char.
    shortcode: github[0],
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
    emojis: emojis.map(({ char, name, keywords, shortcode }) => {
      const out = { char, name };
      if (keywords) out.keywords = keywords;
      if (shortcode) out.shortcode = shortcode;
      return out;
    }),
  });
}

const total = categories.reduce((n, c) => n + c.emojis.length, 0);

const header =
  '// AUTO-GENERATED — do not edit. Regenerate via web/ts/vendor/rebuild.sh.\n' +
  '// Source: emojibase-data (MIT). ' + total + ' emoji across ' + categories.length +
  ' categories, ' + Object.keys(shortcodeMap).length + ' shortcodes.\n';

writeFileSync(
  outPath,
  header +
    'export const EMOJI_CATEGORIES = ' + JSON.stringify(categories) + ';\n' +
    'export const EMOJI_SHORTCODES = ' + JSON.stringify(shortcodeMap) + ';\n',
);
console.error(
  `Wrote ${outPath} (${total} emoji, ${categories.length} categories, ` +
    `${Object.keys(shortcodeMap).length} shortcodes)`,
);
