package htmlmd

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestConvert(t *testing.T) {
	tests := []struct {
		name        string
		html        string
		wantTitle   string
		wantContent string
	}{
		// ── Title extraction ────────────────────────────────────────────────
		{
			name:        "title from <title>",
			html:        `<html><head><title>My Title</title></head><body><h1>Heading</h1><p>text</p></body></html>`,
			wantTitle:   "My Title",
			wantContent: "# Heading\n\ntext",
		},
		{
			name:        "title from h1 when no <title>",
			html:        `<body><h1>Heading One</h1><p>text</p></body>`,
			wantTitle:   "Heading One",
			wantContent: "# Heading One\n\ntext",
		},
		{
			name:        "title from h2 when no h1",
			html:        `<body><h2>Sub</h2></body>`,
			wantTitle:   "Sub",
			wantContent: "## Sub",
		},
		{
			name:        "<title> takes precedence over h1",
			html:        `<html><head><title>Page Title</title></head><body><h1>Heading</h1></body></html>`,
			wantTitle:   "Page Title",
			wantContent: "# Heading",
		},
		{
			name:        "no title and no headings",
			html:        `<body><p>just text</p></body>`,
			wantTitle:   "",
			wantContent: "just text",
		},

		// ── Block elements ──────────────────────────────────────────────────
		{
			name:        "two paragraphs",
			html:        `<body><p>Hello</p><p>World</p></body>`,
			wantTitle:   "",
			wantContent: "Hello\n\nWorld",
		},
		{
			name:        "all heading levels",
			html:        `<body><h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4><h5>E</h5><h6>F</h6></body>`,
			wantTitle:   "A",
			wantContent: "# A\n\n## B\n\n### C\n\n#### D\n\n##### E\n\n###### F",
		},
		{
			name:        "hr",
			html:        `<body><p>a</p><hr><p>b</p></body>`,
			wantTitle:   "",
			wantContent: "a\n\n---\n\nb",
		},
		{
			name:        "blockquote",
			html:        `<body><blockquote><p>quoted</p></blockquote></body>`,
			wantTitle:   "",
			wantContent: "> quoted",
		},
		{
			name:        "nested blockquote",
			html:        `<body><blockquote><blockquote><p>deep</p></blockquote></blockquote></body>`,
			wantTitle:   "",
			wantContent: "> > deep",
		},

		// ── Lists ───────────────────────────────────────────────────────────
		{
			name:        "unordered list",
			html:        `<ul><li>a</li><li>b</li></ul>`,
			wantTitle:   "",
			wantContent: "- a\n- b",
		},
		{
			name:        "ordered list",
			html:        `<ol><li>first</li><li>second</li></ol>`,
			wantTitle:   "",
			wantContent: "1. first\n2. second",
		},
		{
			name:        "nested list",
			html:        `<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>`,
			wantTitle:   "",
			wantContent: "- a\n  - b\n- c",
		},

		// ── Code ────────────────────────────────────────────────────────────
		{
			name:        "pre block",
			html:        `<body><pre>code here</pre></body>`,
			wantTitle:   "",
			wantContent: "```\ncode here\n```",
		},
		{
			name:        "pre with language class",
			html:        `<body><pre><code class="language-go">func main() {}</code></pre></body>`,
			wantTitle:   "",
			wantContent: "```go\nfunc main() {}\n```",
		},
		{
			name:        "inline code",
			html:        `<p><code>x := 1</code></p>`,
			wantTitle:   "",
			wantContent: "`x := 1`",
		},
		{
			name:        "inline code containing backtick",
			html:        "<p><code>a`b</code></p>",
			wantTitle:   "",
			wantContent: "`` a`b ``",
		},

		// ── Inline formatting ────────────────────────────────────────────────
		{
			name:        "strong",
			html:        `<p><strong>bold</strong></p>`,
			wantTitle:   "",
			wantContent: "**bold**",
		},
		{
			name:        "b",
			html:        `<p><b>bold</b></p>`,
			wantTitle:   "",
			wantContent: "**bold**",
		},
		{
			name:        "em",
			html:        `<p><em>italic</em></p>`,
			wantTitle:   "",
			wantContent: "*italic*",
		},
		{
			name:        "i",
			html:        `<p><i>italic</i></p>`,
			wantTitle:   "",
			wantContent: "*italic*",
		},
		{
			name:        "del strikethrough",
			html:        `<p><del>gone</del></p>`,
			wantTitle:   "",
			wantContent: "~~gone~~",
		},
		{
			name:        "s strikethrough",
			html:        `<p><s>gone</s></p>`,
			wantTitle:   "",
			wantContent: "~~gone~~",
		},
		{
			name:        "strike strikethrough",
			html:        `<p><strike>gone</strike></p>`,
			wantTitle:   "",
			wantContent: "~~gone~~",
		},

		// ── Links and images ─────────────────────────────────────────────────
		{
			name:        "link",
			html:        `<a href="https://example.com">text</a>`,
			wantTitle:   "",
			wantContent: "[text](https://example.com)",
		},
		{
			name:        "link without href",
			html:        `<a>anchor</a>`,
			wantTitle:   "",
			wantContent: "anchor",
		},
		{
			name:        "image",
			html:        `<img src="https://example.com/a.png" alt="pic">`,
			wantTitle:   "",
			wantContent: "![pic](https://example.com/a.png)",
		},
		{
			name:        "image without src",
			html:        `<img alt="pic">`,
			wantTitle:   "",
			wantContent: "",
		},
		{
			name:        "br",
			html:        `<p>line1<br>line2</p>`,
			wantTitle:   "",
			wantContent: "line1  \nline2",
		},

		// ── Tables ───────────────────────────────────────────────────────────
		{
			name: "table with thead",
			html: `<table><thead><tr><th>A</th><th>B</th></tr></thead>` +
				`<tbody><tr><td>1</td><td>2</td></tr></tbody></table>`,
			wantTitle:   "",
			wantContent: "| A | B |\n| --- | --- |\n| 1 | 2 |",
		},
		{
			name:        "table without thead",
			html:        `<table><tr><td>H1</td><td>H2</td></tr><tr><td>1</td><td>2</td></tr></table>`,
			wantTitle:   "",
			wantContent: "| H1 | H2 |\n| --- | --- |\n| 1 | 2 |",
		},
		{
			name: "table with alignment",
			html: `<table><thead><tr><th align="left">L</th><th align="right">R</th><th align="center">C</th></tr></thead>` +
				`<tbody><tr><td>a</td><td>b</td><td>c</td></tr></tbody></table>`,
			wantTitle:   "",
			wantContent: "| L | R | C |\n| :--- | ---: | :---: |\n| a | b | c |",
		},
		{
			name:        "empty table",
			html:        `<table></table>`,
			wantTitle:   "",
			wantContent: "",
		},

		// ── Raw HTML passthrough ─────────────────────────────────────────────
		{
			name:        "kbd passthrough",
			html:        `<p>Press <kbd>Ctrl+C</kbd></p>`,
			wantTitle:   "",
			wantContent: "Press <kbd>Ctrl+C</kbd>",
		},
		{
			name:        "sub and sup passthrough",
			html:        `<p>H<sub>2</sub>O and E=mc<sup>2</sup></p>`,
			wantTitle:   "",
			wantContent: "H<sub>2</sub>O and E=mc<sup>2</sup>",
		},
		{
			name:        "abbr with title passthrough",
			html:        `<p><abbr title="HyperText">HTML</abbr></p>`,
			wantTitle:   "",
			wantContent: `<abbr title="HyperText">HTML</abbr>`,
		},
		{
			name:        "abbr unsafe attrs stripped",
			html:        `<p><abbr onclick="evil()">HTML</abbr></p>`,
			wantTitle:   "",
			wantContent: `<abbr>HTML</abbr>`,
		},
		{
			name:        "span passthrough",
			html:        `<p><span>text</span></p>`,
			wantTitle:   "",
			wantContent: `<span>text</span>`,
		},
		{
			name:        "mark passthrough",
			html:        `<p><mark>highlighted</mark></p>`,
			wantTitle:   "",
			wantContent: `<mark>highlighted</mark>`,
		},
		{
			name:        "ins passthrough",
			html:        `<p><ins>added</ins></p>`,
			wantTitle:   "",
			wantContent: `<ins>added</ins>`,
		},

		// ── Stripped/transparent elements ─────────────────────────────────────
		{
			name:        "div stripped, children preserved",
			html:        `<div><p>inside</p></div>`,
			wantTitle:   "",
			wantContent: "inside",
		},
		{
			name:        "section stripped",
			html:        `<section><p>text</p></section>`,
			wantTitle:   "",
			wantContent: "text",
		},
		{
			name:        "script skipped entirely",
			html:        `<script>alert(1)</script><p>safe</p>`,
			wantTitle:   "",
			wantContent: "safe",
		},
		{
			name:        "style skipped entirely",
			html:        `<style>body{color:red}</style><p>text</p>`,
			wantTitle:   "",
			wantContent: "text",
		},

		// ── Markdown character escaping ───────────────────────────────────────
		{
			name:        "asterisk escaped",
			html:        `<p>2 * 3 = 6</p>`,
			wantTitle:   "",
			wantContent: `2 \* 3 = 6`,
		},
		{
			name:        "underscore escaped",
			html:        `<p>snake_case</p>`,
			wantTitle:   "",
			wantContent: `snake\_case`,
		},
		{
			name:        "pipe escaped",
			html:        `<p>a | b</p>`,
			wantTitle:   "",
			wantContent: `a \| b`,
		},
		{
			name:        "bracket escaped",
			html:        `<p>[not a link]</p>`,
			wantTitle:   "",
			wantContent: `\[not a link\]`,
		},
		{
			name:        "bang escaped",
			html:        `<p>!</p>`,
			wantTitle:   "",
			wantContent: `\!`,
		},

		// ── Body-only: head content ignored ─────────────────────────────────
		{
			name:        "head metadata ignored",
			html:        `<html><head><meta charset="utf-8"><link rel="stylesheet" href="x.css"></head><body><p>content</p></body></html>`,
			wantTitle:   "",
			wantContent: "content",
		},

		// ── Empty/fragment inputs ────────────────────────────────────────────
		{
			name:        "empty body",
			html:        `<body></body>`,
			wantTitle:   "",
			wantContent: "",
		},
		{
			name:        "fragment without html wrapper",
			html:        `<p>paragraph</p>`,
			wantTitle:   "",
			wantContent: "paragraph",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Convert(tt.html)
			require.NoError(t, err)
			assert.Equal(t, tt.wantTitle, got.Title, "Title")
			assert.Equal(t, tt.wantContent, got.Content, "Content")
		})
	}
}
