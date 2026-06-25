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
      const m = /^#{1,6}[ \t]+(.*?)(?:[ \t]+#+[ \t]*)?$/.exec(line);
      if (!m) continue;
      const t = m[1].replace(/\t/g, ' ').trim();
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

// Derive a title from a filename: strip .md/.markdown extension, trim,
// truncate to 200 runes with …, or fall back to "Untitled".
export function titleFromFilename(name: string): string {
  const stripped = name.replace(/\.(?:md|markdown)$/i, '').trim();
  if (!stripped) return 'Untitled';
  const runes = [...stripped];
  return runes.length <= 200 ? stripped : runes.slice(0, 200).join('') + '…';
}
