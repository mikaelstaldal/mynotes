import { useEffect } from 'preact/hooks';

interface Props {
  onClose: () => void;
}

interface Row {
  syntax: string;
  desc: string;
}

interface Section {
  title: string;
  rows: Row[];
  // Optional footer with an external reference link, shown under the section.
  note?: { text: string; linkText: string; href: string };
}

// Static cheat-sheet of the Markdown dialect the editor renders (markdown-it
// with GFM tables/task-lists/strikethrough, autolinks, wiki links, AsciiMath
// math, and embedded safe HTML/SVG/MathML). Kept in sync with util/markdown.ts.
// Ordered to follow the format toolbar: headings, inline text, lists, blocks,
// then links & images.
const SECTIONS: Section[] = [
  {
    title: 'Headings',
    rows: [
      { syntax: '# Heading 1', desc: 'Top-level heading' },
      { syntax: '## Heading 2', desc: 'Sub-heading (up to ######)' },
    ],
  },
  {
    title: 'Text',
    rows: [
      { syntax: '**bold**', desc: 'Bold' },
      { syntax: '*italic*', desc: 'Italic' },
      { syntax: '`code`', desc: 'Inline code' },
      { syntax: '~~strikethrough~~', desc: 'Strikethrough' },
    ],
  },
  {
    title: 'Lists',
    rows: [
      { syntax: '1. Item', desc: 'Numbered list' },
      { syntax: '- Item', desc: 'Bullet list' },
      { syntax: '- [ ] To do', desc: 'Task list (unchecked)' },
      { syntax: '- [x] Done', desc: 'Task list (checked)' },
    ],
  },
  {
    title: 'Blocks',
    rows: [
      { syntax: '| A | B |\n| --- | --- |\n| 1 | 2 |', desc: 'Table' },
      { syntax: '---', desc: 'Horizontal rule' },
      { syntax: '> Quote', desc: 'Blockquote' },
      { syntax: '```\ncode\n```', desc: 'Fenced code block' },
      { syntax: '```mermaid\nflowchart TD\n  A --> B\n```', desc: 'Mermaid diagram' },
    ],
    note: {
      text: 'See the ',
      linkText: 'Mermaid diagram syntax',
      href: 'https://mermaid.js.org/intro/',
    },
  },
  {
    title: 'Links & images',
    rows: [
      { syntax: '[[slug]]', desc: 'Link to another note' },
      { syntax: '[[slug|text]]', desc: 'Note link with custom text' },
      { syntax: '[[#tag]]', desc: 'Link to a tag' },
      { syntax: '[[#tag|text]]', desc: 'Link to a tag with custom text' },
      { syntax: '[text](https://example.com)', desc: 'External link' },
      { syntax: 'https://example.com', desc: 'Bare URLs become links' },
      { syntax: '![alt](url)', desc: 'Image' },
    ],
  },
  {
    title: 'Math (AsciiMath)',
    rows: [
      { syntax: '$x^2$', desc: 'Inline math' },
      { syntax: '$$sum_(i=1)^n i$$', desc: 'Display (block) math' },
      { syntax: '\\$5', desc: 'Escape a literal dollar sign' },
    ],
    note: {
      text: 'See the full ',
      linkText: 'AsciiMath syntax reference',
      href: 'https://asciimath.org/#syntax',
    },
  },
];

// A read-only reference popup listing the supported Markdown syntax. Opened from
// the editor's format toolbar; dismissed by Escape, the close button, or a click
// on the backdrop.
export function MarkdownHelp({ onClose }: Props) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div class="markdown-help-overlay" onClick={onClose}>
      <div class="markdown-help" role="dialog" aria-modal="true" aria-labelledby="markdown-help-title" onClick={(e) => e.stopPropagation()}>
        <div class="markdown-help-header">
          <h2 id="markdown-help-title" class="markdown-help-title">Markdown syntax</h2>
          <button type="button" class="btn-icon" title="Close" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div class="markdown-help-body">
          {SECTIONS.map((section) => (
            <section key={section.title} class="markdown-help-section">
              <h3 class="markdown-help-section-title">{section.title}</h3>
              <dl class="markdown-help-list">
                {section.rows.map((row) => (
                  <div key={row.syntax} class="markdown-help-row">
                    <dt><code class="markdown-help-syntax">{row.syntax}</code></dt>
                    <dd class="markdown-help-desc">{row.desc}</dd>
                  </div>
                ))}
              </dl>
              {section.note && (
                <p class="markdown-help-note">
                  {section.note.text}
                  <a href={section.note.href} target="_blank" rel="noopener noreferrer">{section.note.linkText}</a>.
                </p>
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
