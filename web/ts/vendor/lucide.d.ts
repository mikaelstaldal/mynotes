// Types for the generated web/static/vendor/lucide-<version>.js bundle (lucide-static).
// Mapped to the bare specifier "lucide-icons" in tsconfig paths + the index.html
// import map, mirroring the other vendored bundles.

/** A single SVG child element of an icon: [tagName, attributes]. */
export type IconNodeChild = [tag: string, attrs: Record<string, string>];

/** One icon's geometry: the ordered child elements that go inside its <svg>. */
export type IconNode = IconNodeChild[];

export interface IconMeta {
  /** Canonical kebab-case icon name (e.g. "circle-alert"). */
  name: string;
  /** Space-joined search terms (upstream tags); '' when the icon has none. */
  keywords: string;
}

export interface IconCategory {
  /** Category label, shown as the tab's tooltip / aria-label (e.g. "Arrows"). */
  name: string;
  /** Representative icon name used as the tab's visible glyph. */
  icon: string;
  /** Member icon names, alphabetical; every one is present in LUCIDE_ICON_NODES. */
  icons: string[];
}

/** name → icon geometry. Build an <svg> from any entry (see components/Icon). */
export const LUCIDE_ICON_NODES: Record<string, IconNode>;

/** Alphabetical list of every icon with its search keywords, for the picker. */
export const LUCIDE_ICONS: IconMeta[];

/** Alphabetical (by title) list of icon categories, for the picker's tabs. */
export const LUCIDE_CATEGORIES: IconCategory[];
