package sanitize

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// The digest shape the artifact scheme requires; the bytes are arbitrary.
const testDigest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// --- PublishedHTML: what the render pipeline emits must survive ---

func TestPublishedHTMLKeepsRenderedMarkup(t *testing.T) {
	// Each case is markup the frontend render pipeline actually produces, and
	// must round-trip unchanged: anything dropped here is a visible regression
	// on every published page.
	kept := map[string]string{
		"callout classes":   `<div class="callout callout-color-blue"><p class="callout-title">Hi</p></div>`,
		"foldable callout":  `<details class="callout callout-foldable" open=""><summary class="callout-title">T</summary><p>b</p></details>`,
		"code fence class":  `<pre><code class="language-go">fmt.Println()</code></pre>`,
		"task checkbox":     `<input type="checkbox" checked="" disabled=""/>`,
		"artifact image":    `<img src="artifact:` + testDigest + `" alt="x"/>`,
		"mathml":            `<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math>`,
		"decorative icon":   `<svg class="lucide" aria-hidden="true"><path d="M1 1"/></svg>`,
		"raster data image": `<img src="data:image/png;base64,iVBORw0=" alt=""/>`,
		// A wikilink, rewritten by the publish path to the linked note's own
		// public page — a sibling of this one, hence relative.
		"link to another published note": `<a href="./other-note">other</a>`,
	}
	for name, html := range kept {
		t.Run(name, func(t *testing.T) {
			assert.Equal(t, html, PublishedHTML(html))
		})
	}
}

// Mermaid is the reason the published policy allows CSS at all: its <svg>
// carries the diagram's styling in a <style> child plus inline style
// attributes, and losing either renders every published diagram unstyled.
func TestPublishedHTMLKeepsMermaidStyling(t *testing.T) {
	const diagram = `<div class="mermaid-diagram">` +
		`<svg id="m1" style="max-width:100%" role="graphics-document">` +
		`<style>#m1 .node rect{fill:#eee;stroke:#333}</style>` +
		`<g><rect x="1" y="2"/><text>node</text></g></svg></div>`
	assert.Equal(t, diagram, PublishedHTML(diagram))
}

// --- PublishedHTML: what must never survive ---

func TestPublishedHTMLStripsUnsafe(t *testing.T) {
	// AllowUnsafe(true) is set so <style> content survives; these pin that it
	// does not also let script or framed content through, since the published
	// page is served to unauthenticated readers.
	cases := map[string]string{
		"script element":     `<script>alert(1)</script>`,
		"script in svg":      `<svg><script>alert(1)</script></svg>`,
		"iframe":             `<iframe src="https://evil.example/"></iframe>`,
		"object":             `<object data="https://evil.example/"></object>`,
		"event handler":      `<p onclick="steal()">a</p>`,
		"javascript href":    `<a href="javascript:alert(1)">x</a>`,
		"svg data image":     `<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" alt=""/>`,
		"non-canonical href": `<img src="artifact:not-a-digest" alt=""/>`,
	}
	for name, html := range cases {
		t.Run(name, func(t *testing.T) {
			out := PublishedHTML(html)
			assert.NotContains(t, out, "alert(1)")
			assert.NotContains(t, out, "evil.example")
			assert.NotContains(t, out, "onclick")
			assert.NotContains(t, out, "javascript:")
			assert.NotContains(t, out, "svg+xml")
			assert.NotContains(t, out, "not-a-digest")
		})
	}
}

// --- HTML: the note-content validator must not inherit the widening ---

// The two policies are built from the same base, so this pins that widening the
// published one did not quietly widen the note-content validator with it — a
// note whose Markdown embeds <style> or a class attribute must still be
// rejected, which the service detects as a divergence from the input.
func TestHTMLValidatorStaysNarrow(t *testing.T) {
	assert.NotContains(t, HTML(`<style>body{}</style>`), "body{}")
	assert.Equal(t, `<p>a</p>`, HTML(`<p class="x">a</p>`))
	assert.Equal(t, `<p>a</p>`, HTML(`<p style="color:red">a</p>`))
}
