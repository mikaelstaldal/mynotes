package service

import (
	"strings"
	"testing"
)

// body extracts the rendered fragment between <body> and </body> from a full
// exported document, for concise assertions.
func body(t *testing.T, md string) string {
	t.Helper()
	doc, err := RenderToHTML("T", md, nil)
	if err != nil {
		t.Fatalf("RenderToHTML: %v", err)
	}
	i := strings.Index(doc, "<body>\n")
	j := strings.Index(doc, "</body>")
	if i < 0 || j < 0 {
		t.Fatalf("no body in output: %s", doc)
	}
	return doc[i+len("<body>\n") : j]
}

func TestRenderToHTML_InlineMath(t *testing.T) {
	got := body(t, "Inline $x^2$ here.")
	if !strings.Contains(got, `<math display="inline">`) {
		t.Errorf("expected inline math, got: %s", got)
	}
	if !strings.Contains(got, "<msup><mi>x</mi><mn>2</mn></msup>") {
		t.Errorf("expected x^2 markup, got: %s", got)
	}
}

func TestRenderToHTML_DisplayMathBlock(t *testing.T) {
	got := body(t, "A block:\n\n$$\nsum_(i=1)^n i\n$$\n\nafter.")
	if !strings.Contains(got, `<math display="block">`) {
		t.Errorf("expected display math, got: %s", got)
	}
	if !strings.Contains(got, "<munderover>") {
		t.Errorf("expected sum with limits, got: %s", got)
	}
	// The block must not be wrapped in a paragraph and the surrounding text is
	// still rendered.
	if !strings.Contains(got, "<p>A block:</p>") || !strings.Contains(got, "<p>after.</p>") {
		t.Errorf("surrounding paragraphs missing, got: %s", got)
	}
}

func TestRenderToHTML_SingleLineDisplayBlock(t *testing.T) {
	got := body(t, "$$ x/y $$\n\ndone.")
	if !strings.Contains(got, `<math display="block">`) || !strings.Contains(got, "<mfrac>") {
		t.Errorf("expected display fraction, got: %s", got)
	}
}

// Markdown-active characters inside math must be treated as literal AsciiMath,
// not parsed as emphasis — the whole reason the render happens server-side.
func TestRenderToHTML_MathContentIsNotMarkdown(t *testing.T) {
	got := body(t, "Display $$a**b**$$ run.")
	if strings.Contains(got, "<strong>") || strings.Contains(got, "<em>") {
		t.Errorf("math content was parsed as markdown: %s", got)
	}
	if !strings.Contains(got, `<math display="block">`) {
		t.Errorf("expected display math, got: %s", got)
	}
}

// A lone '$' and currency-like text must stay literal.
func TestRenderToHTML_CurrencyAndBareDollarStayLiteral(t *testing.T) {
	for _, in := range []string{
		"Currency $5 and $10 stay literal.",
		"Bad open $ x$ literal.",
		"Just a $ sign.",
	} {
		got := body(t, in)
		if strings.Contains(got, "<math") {
			t.Errorf("unexpected math for %q: %s", in, got)
		}
	}
}

// Math delimiters inside code spans and fenced code blocks must not render.
func TestRenderToHTML_MathNotRenderedInCode(t *testing.T) {
	got := body(t, "`$x$` and:\n\n```\n$$y$$\n```")
	if strings.Contains(got, "<math") {
		t.Errorf("math rendered inside code: %s", got)
	}
	if !strings.Contains(got, "<code>$x$</code>") {
		t.Errorf("inline code content changed: %s", got)
	}
}

// An unterminated $$ block must still render (matching the client) and must not
// hang or panic.
func TestRenderToHTML_UnterminatedBlock(t *testing.T) {
	got := body(t, "before\n\n$$\nx+1")
	if !strings.Contains(got, `<math display="block">`) {
		t.Errorf("expected display math for unterminated block, got: %s", got)
	}
}
