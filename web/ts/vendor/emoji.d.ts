// Types for the generated web/static/vendor/emoji-<version>.js bundle (emojibase-data).
// Mapped to the bare specifier "emoji-data" in tsconfig paths + the index.html
// import map, mirroring the other vendored bundles.

export interface Emoji {
  /** The raw emoji character(s). */
  char: string;
  /** Primary name — shown as a tooltip and matched by search. */
  name: string;
  /** Extra space-separated search terms (upstream tags). */
  keywords?: string;
  /**
   * Primary GitHub `:name:` shortcode the picker inserts (and matches by
   * search). Absent for the rare emoji with no GitHub shortcode — the picker
   * then inserts the raw `char` instead.
   */
  shortcode?: string;
}

export interface EmojiCategory {
  /** Category label, shown as the tab's tooltip / aria-label. */
  name: string;
  /** A representative emoji used as the tab's visible icon. */
  icon: string;
  emojis: Emoji[];
}

export const EMOJI_CATEGORIES: EmojiCategory[];

/**
 * Flat map from every recognized GitHub `:name:` shortcode (across all pickable
 * emoji) to its raw emoji character. Used by the Markdown renderer to resolve
 * `:shortcode:` to the Unicode emoji.
 */
export const EMOJI_SHORTCODES: Record<string, string>;
