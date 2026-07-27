// Lucide icons for the demo backend — the counterpart of internal/icons.
//
// Note content references an icon as a Markdown image
// (![name](<base>/api/v1/icons/lucide/<name>)), so the worker has to answer
// that route with a standalone SVG document. Like the Go package, it
// reconstructs each icon from the single copy of the geometry already shipped
// in the frontend's vendored Lucide bundle (LUCIDE_ICON_NODES), so the served
// icons can never drift from the picker previews and nothing is embedded twice.
//
// See model.ts for why these are globals rather than module exports.

/** The exact prefix gen-lucide.mjs writes the geometry under, on its own line. */
const LUCIDE_NODES_MARKER = 'export const LUCIDE_ICON_NODES = ';

/** The mid-grey baked into the served SVGs; must match STROKE in gen-lucide.mjs. */
const LUCIDE_STROKE = '#6b7280';

/** One child element of an icon: a tag plus its attributes, in source order. */
type IconChild = [string, Record<string, string>];

let iconsPromise: Promise<Map<string, string>> | null = null;

/**
 * The icon documents, keyed by canonical kebab-case name. Built once, on the
 * first icon request, so a demo that never renders an icon never fetches the
 * ~1700-icon bundle.
 */
function lucideIcons(): Promise<Map<string, string>> {
  if (iconsPromise === null) {
    iconsPromise = buildLucideIcons().catch((err) => {
      iconsPromise = null; // let a later request retry a transient fetch failure
      throw err;
    });
  }
  return iconsPromise;
}

async function buildLucideIcons(): Promise<Map<string, string>> {
  const config = await loadConfig();
  const icons = new Map<string, string>();
  if (config.lucideBundle === '') return icons;

  const response = await fetch(new URL(config.lucideBundle, scopeURL()).href);
  if (!response.ok) return icons;
  const source = await response.text();

  for (const line of source.split('\n')) {
    if (!line.startsWith(LUCIDE_NODES_MARKER)) continue;
    const object = line.slice(LUCIDE_NODES_MARKER.length).replace(/;$/, '');
    const nodes = JSON.parse(object) as Record<string, IconChild[]>;
    for (const name of Object.keys(nodes)) icons.set(name, iconSVG(name, nodes[name]));
    break;
  }
  return icons;
}

/**
 * Serializes one icon's children into a standalone <svg> document. Must stay in
 * step with icons.svgString on the server and with the inline form the frontend
 * renders from the same geometry.
 */
function iconSVG(name: string, children: IconChild[]): string {
  let out = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" '
    + 'viewBox="0 0 24 24" fill="none" stroke="' + LUCIDE_STROKE + '" '
    + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" '
    + 'class="lucide lucide-' + name + '">';
  for (const [tag, attrs] of children) {
    out += '<' + tag;
    for (const key of Object.keys(attrs)) out += ' ' + key + '="' + escapeAttr(attrs[key]) + '"';
    out += '/>';
  }
  return out + '</svg>';
}

/** Escapes an attribute value; mirrors escapeAttr in gen-lucide.mjs (& first). */
function escapeAttr(value: string): string {
  return value
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;');
}
