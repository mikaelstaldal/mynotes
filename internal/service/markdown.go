package service

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"html/template"
	"io"
	"regexp"
	"strings"

	"github.com/mikaelstaldal/mynotes/internal/sanitize"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	gmhtml "github.com/yuin/goldmark/renderer/html"
	gmtext "github.com/yuin/goldmark/text"
	"golang.org/x/net/html"
)

// maxNestingDepth bounds AST nesting as a coarse DoS guard, mirroring the
// client's markdown-it maxNesting: 100. Parity with the client is a goal, not a
// guarantee — the two count "depth" differently — but any reasonable bound caps
// parser/render cost.
const maxNestingDepth = 100

// markdownParser mirrors the client's enabled feature set: GFM tables,
// strikethrough, and linkify/autolinks, wired via Goldmark's *individual*
// extensions rather than the extension.GFM bundle, so the GFM task-list parser
// stays off (matching the no-task-lists frontend). Raw HTML and images are
// CommonMark-core and already present in the default AST, which is all the walk
// inspects. The parser is stateless across calls and safe for concurrent use.
var markdownParser = goldmark.New(
	goldmark.WithExtensions(
		extension.Table,
		extension.Strikethrough,
		extension.Linkify,
	),
).Parser()

// markdownRenderer converts Markdown to an HTML body fragment. WithUnsafe allows
// raw HTML blocks stored in notes — content was already validated at write time.
var markdownRenderer = goldmark.New(
	goldmark.WithExtensions(
		extension.Table,
		extension.Strikethrough,
		extension.Linkify,
	),
	goldmark.WithRendererOptions(
		gmhtml.WithUnsafe(),
	),
)

// exportStylesheet is a small, self-contained stylesheet embedded in every
// exported HTML document so a downloaded note renders close to the web UI's note
// view (app.css `.note-content`) without a live server. It is intentionally a
// best-effort visual match, not a byte-for-byte copy: the palette and typography
// mirror app.css's :root variables and note-content rules, but colours are wired
// to prefers-color-scheme (the app toggles a data-theme attribute at runtime,
// which a standalone file cannot). Styling stays element-level (no class names)
// because the exported body is the raw rendered Markdown fragment.
const exportStylesheet = `
:root {
  --bg: #ffffff;
  --fg: #1f2937;
  --muted: #6b7280;
  --border: #e5e7eb;
  --primary: #2563eb;
  --surface: #f9fafb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111827;
    --fg: #f3f4f6;
    --muted: #9ca3af;
    --border: #374151;
    --primary: #3b82f6;
    --surface: #1f2937;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0 auto;
  max-width: 65ch;
  padding: 2rem 1.25rem;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--fg);
  line-height: 1.7;
}
body > :first-child { margin-top: 0; }
h1, h2, h3, h4, h5, h6 { margin: 1.25em 0 0.5em; line-height: 1.3; }
h1 { font-size: 1.75rem; }
h2 { font-size: 1.4rem; }
h3 { font-size: 1.15rem; }
p { margin: 0.75em 0; }
ul, ol { padding-left: 1.5rem; margin: 0.75em 0; }
li + li { margin-top: 0.25em; }
a { color: var(--primary); }
a[href*="/tags/"] {
  text-decoration: none;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 0.5em;
  font-size: 0.9em;
  white-space: nowrap;
}
pre {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.9rem 1rem;
  overflow-x: auto;
  font-size: 0.875rem;
  line-height: 1.5;
}
code {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0.1em 0.35em;
  font-size: 0.875em;
}
pre code { background: none; border: none; padding: 0; font-size: inherit; }
blockquote {
  margin: 0.75em 0;
  padding: 0.5em 1em;
  border-left: 3px solid var(--border);
  color: var(--muted);
}
table { border-collapse: collapse; width: 100%; margin: 0.75em 0; }
th, td { border: 1px solid var(--border); padding: 0.4rem 0.7rem; text-align: left; }
th { background: var(--surface); font-weight: 600; }
img { max-width: 100%; height: auto; }
hr { border: none; border-top: 1px solid var(--border); margin: 1.5em 0; }
`

var htmlDocTemplate = template.Must(template.New("doc").Parse(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{{.Title}}</title><style>{{.Style}}</style></head>
<body>
{{.Body}}</body>
</html>
`))

// ArtifactResolver returns the raw bytes and content type of the artifact with
// the given hex SHA-256 digest. ok is false when the artifact is unknown or
// unavailable, in which case the referencing image is left untouched.
type ArtifactResolver func(sha256hex string) (content []byte, contentType string, ok bool)

// RenderToHTML converts Markdown content to a complete HTML document with the
// given title. The rendered HTML fragment is sanitized with the same bluemonday
// policy used at write time before being embedded in the document, providing
// defense-in-depth against any divergence between validation and render output.
//
// When resolve is non-nil, internal artifact image references
// (<img src=".../api/v1/artifacts/<sha256>">) are inlined so the exported
// document renders standalone: bitmap (raster) artifacts become base64 data:
// URLs, while SVG and MathML artifacts are spliced in as inline <svg>/<math>
// elements (a data: URL for SVG is disallowed by the sanitize policy). Unknown
// or unresolvable references are left as-is.
func RenderToHTML(title, content string, resolve ArtifactResolver) (string, error) {
	var body bytes.Buffer
	if err := markdownRenderer.Convert([]byte(content), &body); err != nil {
		return "", fmt.Errorf("render markdown: %w", err)
	}
	rendered := body.String()
	if resolve != nil {
		rendered = inlineArtifactImages(rendered, resolve)
	}
	safe := sanitize.HTML(rendered)
	var doc bytes.Buffer
	if err := htmlDocTemplate.Execute(&doc, struct {
		Title string
		Style template.CSS
		Body  template.HTML
	}{
		Title: title,
		Style: template.CSS(exportStylesheet), // trusted static constant
		Body:  template.HTML(safe),            //nolint:gosec // sanitized by bluemonday immediately above
	}); err != nil {
		return "", fmt.Errorf("render html template: %w", err)
	}
	return doc.String(), nil
}

// artifactSrcPattern matches an internal artifact image URL and captures its hex
// SHA-256 digest. It anchors on the `/api/v1/artifacts/<sha256>` path suffix so
// it matches whether the reference is root-relative (`/api/v1/...`),
// basepath-prefixed (`/notes/api/v1/...`), or absolute
// (`https://host/api/v1/...`); any query string or fragment is trimmed first.
var artifactSrcPattern = regexp.MustCompile(`(?:^|/)api/v1/artifacts/([0-9a-f]{64})$`)

// inlineArtifactImages rewrites internal artifact <img> references so a
// downloaded document renders without a live server. Each token is re-emitted
// via the same golang.org/x/net/html tokenizer bluemonday drives; the sanitize
// pass in RenderToHTML runs afterwards over the result, so any unsafe markup
// spliced in from an artifact is stripped there (defense-in-depth). A raster
// artifact's <img src> is rewritten to a base64 data: URL — gated on
// sanitize.DataImageRaster so the emitted scheme is one the render-time policy
// keeps. An SVG or MathML artifact's <img> is replaced outright by the raw
// <svg>/<math> markup. Unknown or unresolvable references are left untouched.
// On any tokenizer error the original fragment is returned unchanged.
func inlineArtifactImages(fragment string, resolve ArtifactResolver) string {
	z := html.NewTokenizer(strings.NewReader(fragment))
	var b strings.Builder
	for {
		if z.Next() == html.ErrorToken {
			if z.Err() == io.EOF {
				return b.String()
			}
			return fragment
		}
		tok := z.Token()
		if repl, ok := inlineArtifactImg(&tok, resolve); ok {
			b.WriteString(repl)
			continue
		}
		b.WriteString(tok.String())
	}
}

// inlineArtifactImg inspects one token and, when it is an <img> referencing an
// internal artifact, returns the markup that should replace it plus true. For a
// raster artifact it mutates tok's src to a data: URL and returns the re-emitted
// tag; for an SVG/MathML artifact it returns the raw <svg>/<math> content in
// place of the <img>. It returns ("", false) — meaning "emit the token
// unchanged" — for any non-<img> token, a non-artifact src, an unresolved
// artifact, or an artifact whose type is neither raster nor SVG/MathML.
func inlineArtifactImg(tok *html.Token, resolve ArtifactResolver) (string, bool) {
	if tok.Type != html.StartTagToken && tok.Type != html.SelfClosingTagToken {
		return "", false
	}
	if tok.Data != "img" {
		return "", false
	}
	srcIdx := -1
	for i := range tok.Attr {
		if strings.EqualFold(tok.Attr[i].Key, "src") {
			srcIdx = i
			break
		}
	}
	if srcIdx < 0 {
		return "", false
	}
	sha, ok := artifactSHA(tok.Attr[srcIdx].Val)
	if !ok {
		return "", false
	}
	content, contentType, ok := resolve(sha)
	if !ok {
		return "", false
	}
	switch {
	case sanitize.DataImageRaster.MatchString("data:" + contentType + ";"):
		tok.Attr[srcIdx].Val = "data:" + contentType + ";base64," + base64.StdEncoding.EncodeToString(content)
		return tok.String(), true
	case contentType == "image/svg+xml", contentType == "application/mathml+xml":
		return string(content), true
	default:
		return "", false
	}
}

// artifactSHA extracts the hex SHA-256 digest from an internal artifact image
// src, or returns ok=false when src is not such a reference. Any query string or
// fragment is trimmed before matching.
func artifactSHA(src string) (string, bool) {
	path := src
	if i := strings.IndexAny(path, "?#"); i >= 0 {
		path = path[:i]
	}
	m := artifactSrcPattern.FindStringSubmatch(path)
	if m == nil {
		return "", false
	}
	return m[1], true
}

// schemePattern matches a leading RFC 3986 URI scheme ("scheme:"). A
// destination with no match carries no scheme and is treated as relative.
var schemePattern = regexp.MustCompile(`^([a-zA-Z][a-zA-Z0-9+.\-]*):`)

// validateMarkdownStructure is the write-time structural gate over note content.
// It accepts or rejects only — content is never mutated. It rejects (with
// ErrValidation) content that contains a C0 control character other than
// tab/newline/CR, embedded HTML outside the safe allow-list, a Markdown-native
// link/image destination with a disallowed scheme, or nesting deeper than
// maxNestingDepth.
func validateMarkdownStructure(content string) error {
	// Flat byte scan for C0 control characters, independent of the parse. Every
	// C0 control is < 0x80 and so is never part of a UTF-8 multi-byte sequence;
	// the scan catches a raw sentinel (U+0002/U+0003, §8) even on otherwise
	// malformed input, so it does not depend on the UTF-8 check running first.
	for i := 0; i < len(content); i++ {
		if c := content[i]; c < 0x20 && c != '\t' && c != '\n' && c != '\r' {
			return validationError("content must not contain control characters")
		}
	}

	src := []byte(content)
	doc := markdownParser.Parse(gmtext.NewReader(src))

	depth := 0
	var walkErr error
	err := ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			depth--
			return ast.WalkContinue, nil
		}
		depth++
		if depth > maxNestingDepth {
			walkErr = validationError("content is nested too deeply")
			return ast.WalkStop, nil
		}

		switch n.Kind() {
		case ast.KindRawHTML:
			if err := checkEmbeddedHTML(rawHTMLText(n.(*ast.RawHTML), src)); err != nil {
				walkErr = err
				return ast.WalkStop, nil
			}
		case ast.KindHTMLBlock:
			if err := checkEmbeddedHTML(htmlBlockText(n.(*ast.HTMLBlock), src)); err != nil {
				walkErr = err
				return ast.WalkStop, nil
			}
		case ast.KindLink:
			if err := checkScheme(string(n.(*ast.Link).Destination), false); err != nil {
				walkErr = err
				return ast.WalkStop, nil
			}
		case ast.KindImage:
			if err := checkScheme(string(n.(*ast.Image).Destination), true); err != nil {
				walkErr = err
				return ast.WalkStop, nil
			}
		case ast.KindAutoLink:
			al := n.(*ast.AutoLink)
			// Email autolinks are implicitly mailto: (an allow-listed link scheme).
			if al.AutoLinkType == ast.AutoLinkURL {
				if err := checkScheme(string(al.URL(src)), false); err != nil {
					walkErr = err
					return ast.WalkStop, nil
				}
			}
		}
		return ast.WalkContinue, nil
	})
	if err != nil {
		return err
	}
	return walkErr
}

// checkEmbeddedHTML accepts a raw-HTML fragment iff (1) the removal-only
// bluemonday policy leaves it unchanged relative to a canonical re-serialization
// of the original through the same html tokenizer bluemonday uses, and (2) every
// <a href>/<img src> in it passes the same per-element scheme allow-list applied
// to Markdown-native destinations. Pure reformatting (attribute quoting, void-tag
// closing) cancels on both sides of the compare; only genuinely stripped or
// rewritten — i.e. unsafe — content diverges and is rejected.
//
// The explicit scheme pass is required because bluemonday's UGCPolicy registers
// an unconditional <a href>/<img src> attribute policy, which is evaluated before
// the project's Matching regexp and short-circuits it — so the policy alone
// cannot enforce the per-element scheme rules (notably "no http on an image").
// This pass guarantees the §4.1 contract that embedded HTML obeys the same scheme
// allow-list as Markdown-native links/images, independent of bluemonday internals.
func checkEmbeddedHTML(fragment string) error {
	if sanitize.HTML(fragment) != canonicalizeHTML(fragment) {
		return validationError("content contains disallowed HTML")
	}
	return checkEmbeddedSchemes(fragment)
}

// checkEmbeddedSchemes runs the Markdown-native scheme allow-list over the
// <a href> and <img src> destinations found in a raw-HTML fragment, so embedded
// HTML and Markdown syntax enforce identical scheme rules.
func checkEmbeddedSchemes(fragment string) error {
	z := html.NewTokenizer(strings.NewReader(fragment))
	for {
		tt := z.Next()
		if tt == html.ErrorToken {
			// EOF (or a tokenizer error already surfaced by the compare above).
			return nil
		}
		if tt != html.StartTagToken && tt != html.SelfClosingTagToken {
			continue
		}
		tok := z.Token()
		var attrKey string
		isImage := false
		switch tok.Data {
		case "a":
			attrKey = "href"
		case "img":
			attrKey = "src"
			isImage = true
		default:
			continue
		}
		for _, a := range tok.Attr {
			if strings.EqualFold(a.Key, attrKey) {
				if err := checkScheme(a.Val, isImage); err != nil {
					return err
				}
			}
		}
	}
}

// canonicalizeHTML re-serializes a fragment token-by-token through
// golang.org/x/net/html — the same tokenizer bluemonday drives, emitting each
// token via Token.String() exactly as bluemonday does for kept tokens. This is a
// token-stream re-emission, not an html.Parse tree balance: a lone inline start
// or end tag re-serializes identically here and through bluemonday, so a safe
// lone tag is never falsely rejected.
func canonicalizeHTML(fragment string) string {
	z := html.NewTokenizer(strings.NewReader(fragment))
	var b strings.Builder
	for {
		if z.Next() == html.ErrorToken {
			if z.Err() == io.EOF {
				return b.String()
			}
			// A tokenizer error means we cannot canonicalize; treat it as a
			// divergence by returning a sentinel that bluemonday's output (a valid
			// serialization) can never equal.
			return "\x00tokenizer-error"
		}
		b.WriteString(z.Token().String())
	}
}

// checkScheme validates a Markdown-native link/image destination against the
// scheme allow-list, which differs by destination kind. No-scheme (relative)
// destinations are allowed; scheme-relative ("//host/…") destinations are
// rejected on both. Scheme comparison is case-insensitive.
func checkScheme(dest string, isImage bool) error {
	d := strings.TrimSpace(dest)

	// Scheme-relative URLs inherit the page scheme to reach an arbitrary host,
	// outside the explicit allow-list — reject on both links and images.
	if strings.HasPrefix(d, "//") {
		return schemeError(isImage)
	}

	m := schemePattern.FindStringSubmatch(d)
	if m == nil {
		// No scheme: root-relative ("/notes/x") and bare-relative ("foo") allowed.
		return nil
	}
	scheme := strings.ToLower(m[1])

	if isImage {
		// Images: https and the canonical data: raster set only — no http (a
		// CSP-blocked http image renders silently broken, so reject up front).
		if scheme == "https" {
			return nil
		}
		if scheme == "data" && sanitize.DataImageRaster.MatchString(d) {
			return nil
		}
		return schemeError(true)
	}

	// Links: http, https, mailto. data: is never allowed on a link.
	switch scheme {
	case "http", "https", "mailto":
		return nil
	}
	return schemeError(false)
}

func schemeError(isImage bool) error {
	if isImage {
		return validationError("content contains an image with a disallowed URL scheme")
	}
	return validationError("content contains a link with a disallowed URL scheme")
}

// rawHTMLText reconstructs the literal source of an inline raw-HTML node.
func rawHTMLText(n *ast.RawHTML, src []byte) string {
	var b strings.Builder
	for i := 0; i < n.Segments.Len(); i++ {
		seg := n.Segments.At(i)
		b.Write(seg.Value(src))
	}
	return b.String()
}

// htmlBlockText reconstructs the literal source of an HTML block node, including
// its closure line (e.g. the closing tag of a type-6 block) when present.
func htmlBlockText(n *ast.HTMLBlock, src []byte) string {
	var b strings.Builder
	lines := n.Lines()
	for i := 0; i < lines.Len(); i++ {
		seg := lines.At(i)
		b.Write(seg.Value(src))
	}
	if n.HasClosure() {
		b.Write(n.ClosureLine.Value(src))
	}
	return b.String()
}
