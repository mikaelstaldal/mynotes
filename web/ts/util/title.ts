// Extract the first ATX heading (any level) from markdown text.
// Strips the optional closing sequence (e.g. "## Title ##").
export function titleFromContent(text: string): string | null {
  const m = /^#{1,6}\s+(.*?)(?:\s+#+\s*)?$/m.exec(text);
  if (!m) return null;
  const title = m[1].trim();
  return title || null;
}

// Derive a title from a filename: strip .md/.markdown extension, trim,
// truncate to 200 runes with …, or fall back to "Untitled".
export function titleFromFilename(name: string): string {
  const stripped = name.replace(/\.(?:md|markdown)$/i, '').trim();
  if (!stripped) return 'Untitled';
  const runes = [...stripped];
  return runes.length <= 200 ? stripped : runes.slice(0, 200).join('') + '…';
}
