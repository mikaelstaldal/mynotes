// Read the opening marker once, then walk backwards over the optional closing
// marker. A lazy body plus an optional whitespace/hash suffix backtracks
// quadratically on long whitespace runs. Keep this scan linear instead.
function atxHeadingText(line: string): string | null {
  const opening = /^#{1,6}[ \t]+/.exec(line);
  if (!opening || /[\r\u2028\u2029]/.test(line)) return null;
  const start = opening[0].length;
  let end = line.length;
  while (end > start && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  let hashes = end;
  while (hashes > start && line[hashes - 1] === '#') hashes--;
  if (hashes < end && hashes > start && (line[hashes - 1] === ' ' || line[hashes - 1] === '\t')) {
    end = hashes;
  }
  return line.slice(start, end);
}

// Extract the first ATX heading (any level) from markdown text.
// Fenced-code blocks (``` or ~~~) are skipped; an unclosed fence extends to EOF.
// Tabs in the heading text are replaced with a single space.
// Result is truncated to 200 runes with …; returns null when none found.
export function titleFromContent(text: string): string | null {
  const lines = text.split('\n');
  let fenceChar = '';
  let fenceLen = 0;

  for (const line of lines) {
    if (fenceLen === 0) {
      const fm = /^(`{3,}|~{3,})/.exec(line);
      if (fm) { fenceChar = fm[1][0]; fenceLen = fm[1].length; continue; }
      const heading = atxHeadingText(line);
      if (heading === null) continue;
      const t = heading.replace(/\t/g, ' ').trim();
      if (!t) continue;
      const runes = [...t];
      return runes.length <= 200 ? t : runes.slice(0, 200).join('') + '…';
    } else {
      const closeRe = new RegExp(`^${fenceChar === '`' ? '`' : '~'}{${fenceLen},}\\s*$`);
      if (closeRe.test(line)) { fenceLen = 0; fenceChar = ''; }
    }
  }
  return null;
}

// Derive a human-friendly title suggestion from a slug by running the
// title-to-slug algorithm backwards as far as possible: hyphens become spaces
// and the first letter is capitalized. Lost information (original case, dropped
// punctuation and accents) cannot be recovered, so this is only a suggestion.
// Returns '' for an empty slug.
export function titleFromSlug(slug: string): string {
  const spaced = slug.replace(/-+/g, ' ').trim();
  if (!spaced) return '';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Derive a title from a filename: strip .md/.markdown extension, trim,
// truncate to 200 runes with …, or fall back to "Untitled".
export function titleFromFilename(name: string): string {
  const stripped = name.replace(/\.(?:md|markdown)$/i, '').trim();
  if (!stripped) return 'Untitled';
  const runes = [...stripped];
  return runes.length <= 200 ? stripped : runes.slice(0, 200).join('') + '…';
}
