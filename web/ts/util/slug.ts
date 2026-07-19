// The shared slug pattern (mirrors openapi.yaml's slug constraints): lowercase
// alphanumerics in hyphen-separated groups, at most 100 chars. Used to skip
// server round-trips for slugs the backend would reject anyway.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function isValidSlug(slug: string): boolean {
  return slug.length <= 100 && SLUG_RE.test(slug);
}

// Mirror the server's generateSlug: lowercase + NFKD accent-fold + drop combining
// marks + drop remaining non-ASCII, collapse non-alphanumeric ASCII into hyphens,
// trim trailing hyphens, truncate to 100 chars. Falls back to "note" when empty.
export function slugFromTitle(title: string): string {
  const folded = title.toLowerCase().normalize('NFKD').replace(/\p{Mn}/gu, '');
  let result = '';
  let dash = false;
  for (const ch of folded) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) {
      result += ch;
      dash = false;
    } else if (cp > 127) {
      // non-ASCII after accent fold: drop without separator (matches server)
    } else {
      // ASCII non-alphanumeric → separator
      if (!dash && result.length > 0) { result += '-'; dash = true; }
    }
  }
  result = result.replace(/-+$/, '');
  if (result.length > 100) result = result.slice(0, 100).replace(/-+$/, '');
  return result || 'note';
}
