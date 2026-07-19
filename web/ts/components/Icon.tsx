import { h } from 'preact';
import { LUCIDE_ICON_NODES } from 'lucide-icons';

interface Props {
  /** Canonical kebab-case Lucide icon name (e.g. "circle-alert"). */
  name: string;
  /** Pixel width/height of the square icon. Defaults to Lucide's 24. */
  size?: number;
  /** Stroke width. Lucide's default is 2. */
  strokeWidth?: number;
  /** Extra class(es), appended after the default `lucide lucide-<name>`. */
  class?: string;
}

// Renders a Lucide icon inline as an <svg> whose stroke is `currentColor`, so it
// inherits the surrounding text colour. Reusable anywhere in the web UI; returns
// null for an unknown name. The icon geometry comes from the vendored
// lucide-static data (LUCIDE_ICON_NODES) — the same source the picker and the
// Markdown insertion path use, so a rendered icon and an inserted one match.
export function Icon({ name, size = 24, strokeWidth = 2, class: cls }: Props) {
  const nodes = LUCIDE_ICON_NODES[name];
  if (!nodes) return null;
  const className = cls ? `lucide lucide-${name} ${cls}` : `lucide lucide-${name}`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={strokeWidth}
      stroke-linecap="round"
      stroke-linejoin="round"
      class={className}
      aria-hidden="true"
    >
      {nodes.map(([tag, attrs], i) => h(tag, { ...attrs, key: i } as never))}
    </svg>
  );
}
