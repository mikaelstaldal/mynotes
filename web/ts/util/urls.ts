// Shared DOMPurify URL policy for Markdown and Mermaid SVG.
// Allow http(s), mailto and relative references (including SVG fragment links).
export const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

// Browsers accept whitespace/control characters in URL attributes and also
// resolve forms such as https:example.com. Harden these like ordinary HTTPS.
export function isHTTPURL(href: string): boolean {
  return /^https?:/i.test(href.replace(/[\s\u0000-\u001f\u007f]/g, ''));
}
