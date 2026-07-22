// Types for the generated web/static/vendor/emoji-<version>.js bundle (emojibase-data).
// Mapped to the bare specifier "emoji-data" in tsconfig paths + the index.html
// import map, mirroring the other vendored bundles.

export interface Emoji {
  /** The emoji character(s) to insert. */
  char: string;
  /** Primary name — shown as a tooltip and matched by search. */
  name: string;
  /** Extra space-separated search terms (upstream tags). */
  keywords?: string;
}

export interface EmojiCategory {
  /** Category label, shown as the tab's tooltip / aria-label. */
  name: string;
  /** A representative emoji used as the tab's visible icon. */
  icon: string;
  emojis: Emoji[];
}

export const EMOJI_CATEGORIES: EmojiCategory[];
