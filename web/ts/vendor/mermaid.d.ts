// Type declaration for the vendored Mermaid bundle
// (web/static/vendor/mermaid-<version>.js). Mapped to the bare specifier "mermaid" in
// tsconfig paths + the index.html import map, mirroring the other vendored
// bundles. Only the minimal surface the app uses is declared here.

/** Subset of Mermaid's config we set; Mermaid ignores unknown keys. */
export interface MermaidConfig {
  /** Never auto-scan the page on load; we render explicitly. */
  startOnLoad?: boolean;
  /** 'strict' makes Mermaid sanitize labels and disable click/callbacks. */
  securityLevel?: 'strict' | 'loose' | 'antiscript' | 'sandbox';
  /** Built-in colour theme (we map the app's light/dark theme onto this). */
  theme?: 'default' | 'dark' | 'forest' | 'neutral' | 'base' | 'null';
  /** Never inject Mermaid's own "bomb" error graphic into the DOM on failure. */
  suppressErrorRendering?: boolean;
  /**
   * Top-level label mode. Must be false (together with flowchart.htmlLabels) to
   * get SVG <text> labels instead of HTML <foreignObject> — the flowchart-level
   * flag alone is not honored.
   */
  htmlLabels?: boolean;
  flowchart?: {
    /** false → SVG <text> labels instead of HTML <foreignObject>. */
    htmlLabels?: boolean;
  };
}

/** Result of a successful parse; falsy when parsing fails with suppressErrors. */
export interface ParseResult {
  diagramType: string;
}

/** Result of rendering a diagram: `svg` is the standalone SVG markup. */
export interface RenderResult {
  svg: string;
  bindFunctions?: (element: Element) => void;
}

export interface Mermaid {
  initialize(config: MermaidConfig): void;
  /**
   * Validate `text` without rendering. With `suppressErrors: true` it resolves
   * to `false` on invalid input instead of throwing — used to skip rendering
   * an incomplete diagram while the user is still typing.
   */
  parse(text: string, options?: { suppressErrors?: boolean }): Promise<ParseResult | false>;
  /** Parse + render `text` into SVG. `id` is the DOM id for the SVG root. */
  render(id: string, text: string): Promise<RenderResult>;
}

declare const mermaid: Mermaid;
export default mermaid;
