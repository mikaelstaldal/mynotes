package service

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"github.com/mikaelstaldal/mynotes/internal/model"
)

const digestA = "0000000000000000000000000000000000000000000000000000000000000001"
const digestB = "0000000000000000000000000000000000000000000000000000000000000002"

// --- artifact reference extraction and expansion ---

func TestExpandArtifactRefsDigests(t *testing.T) {
	tests := map[string]struct {
		html string
		want []string
	}{
		"none":          {`<p>no images here</p>`, []string{}},
		"single":        {`<img src="artifact:` + digestA + `">`, []string{digestA}},
		"two distinct":  {`<img src="artifact:` + digestA + `"><img src="artifact:` + digestB + `">`, []string{digestA, digestB}},
		"deduplicated":  {`<img src="artifact:` + digestA + `"><img src="artifact:` + digestA + `">`, []string{digestA}},
		"svg image ref": {`<svg><image href="artifact:` + digestA + `"/></svg>`, []string{digestA}},
		// Sorted, so the stored rows and these expectations are deterministic
		// regardless of document order.
		"sorted": {`<img src="artifact:` + digestB + `"><img src="artifact:` + digestA + `">`, []string{digestA, digestB}},
	}
	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			_, got := expandArtifactRefs(tc.html)
			assert.Equal(t, tc.want, got)
		})
	}
}

// The digests this returns are exactly the artifacts the publish makes
// world-readable, so anything that is not an image source must not reach it. A
// note that documents the `artifact:<sha256>` syntax, or quotes a digest in
// prose, displays no image — and must publish no artifact.
func TestExpandArtifactRefsIgnoresNonImagePositions(t *testing.T) {
	tests := map[string]string{
		"prose":              `<p>write artifact:` + digestA + ` to embed it</p>`,
		"code span":          `<p><code>artifact:` + digestA + `</code></p>`,
		"code block":         `<pre><code>![alt](artifact:` + digestA + `)</code></pre>`,
		"link href":          `<a href="artifact:` + digestA + `">x</a>`,
		"unrelated attr":     `<img src="/other.png" alt="artifact:` + digestA + `">`,
		"substring of a URL": `<img src="https://example.com/artifact:` + digestA + `">`,
	}
	for name, html := range tests {
		t.Run(name, func(t *testing.T) {
			out, digests := expandArtifactRefs(html)
			assert.Empty(t, digests, "must publish no artifact")
			assert.Equal(t, html, out, "must not rewrite the text either")
		})
	}
}

// The expansion is relative on purpose: resolved against /public/notes/{slug}
// it lands on /public/artifacts/{sha} under any deployment path, so a stored
// snapshot survives the deployment moving.
func TestExpandArtifactRefsIsRelative(t *testing.T) {
	out, _ := expandArtifactRefs(`<img src="artifact:` + digestA + `" alt="x">`)
	assert.Equal(t, `<img src="../artifacts/`+digestA+`" alt="x">`, out)
	assert.NotContains(t, out, "artifact:")

	// A self-closing SVG <image> keeps its shape.
	out, _ = expandArtifactRefs(`<svg><image href="artifact:` + digestA + `"/></svg>`)
	assert.Equal(t, `<svg><image href="../artifacts/`+digestA+`"/></svg>`, out)
}

// Everything the walk does not rewrite is passed through byte for byte. This is
// load-bearing for Mermaid: bluemonday emits a <style> element's CSS as raw
// text, and re-serializing it would escape the `>` of a child combinator and
// break the diagram it styles.
func TestExpandArtifactRefsPreservesEverythingElse(t *testing.T) {
	const diagram = `<div class="mermaid-diagram"><svg id="m1" style="max-width:100%">` +
		`<style>#m1 .node > rect{fill:#eee}` + "\n" + `#m1 a{color:red}</style>` +
		`<g><rect x="1"/></g></svg></div>`
	out, digests := expandArtifactRefs(diagram)
	assert.Equal(t, diagram, out)
	assert.Empty(t, digests)

	// …and the same holds around a reference that *is* rewritten.
	withImage := diagram + `<p><img src="artifact:` + digestA + `"></p>` + diagram
	out, digests = expandArtifactRefs(withImage)
	assert.Equal(t, []string{digestA}, digests)
	assert.Equal(t, 2, strings.Count(out, `.node > rect`))
	assert.Contains(t, out, `src="../artifacts/`+digestA+`"`)
}

// --- the served document ---

func TestPublishedNoteDocument(t *testing.T) {
	doc := PublishedNoteDocument(model.PublishedNote{
		Slug:        "a-note",
		Title:       "My Note",
		HTML:        `<p>body</p>`,
		PublishedAt: time.Now().UTC(),
	})
	assert.True(t, strings.HasPrefix(doc, "<!DOCTYPE html>"))
	assert.Contains(t, doc, "<title>My Note</title>")
	assert.Contains(t, doc, `<link rel="stylesheet" href="../note.css">`)
	assert.Contains(t, doc, `<main class="note-content"><h1>My Note</h1>`)
	assert.Contains(t, doc, "<p>body</p>")
	// The document is static: it must bring no script of its own.
	assert.NotContains(t, doc, "<script")
}

func TestEscapeHTMLText(t *testing.T) {
	tests := map[string]string{
		`plain`:            `plain`,
		`<b>`:              `&lt;b&gt;`,
		`a & b`:            `a &amp; b`,
		`"quoted"`:         `&quot;quoted&quot;`,
		`it's`:             `it&#39;s`,
		`"><script>x</  >`: `&quot;&gt;&lt;script&gt;x&lt;/  &gt;`,
	}
	for in, want := range tests {
		t.Run(in, func(t *testing.T) {
			assert.Equal(t, want, escapeHTMLText(in))
		})
	}
}

// A title that could break out of either the <title> text or an attribute must
// be inert everywhere the document splices it.
func TestPublishedNoteDocumentEscapesTitle(t *testing.T) {
	doc := PublishedNoteDocument(model.PublishedNote{
		Slug:  "x",
		Title: `</title><script>alert(1)</script>`,
		HTML:  `<p>x</p>`,
	})
	assert.NotContains(t, doc, "<script>")
	// The only </title> in the document is the wrapper's own closing tag.
	assert.Equal(t, 1, strings.Count(doc, "</title>"))
	assert.Contains(t, doc, "&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;")
}
