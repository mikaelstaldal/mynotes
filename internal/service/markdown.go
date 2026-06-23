package service

import (
	"io"
	"regexp"
	"strings"

	"github.com/mikaelstaldal/go-web-template/internal/sanitize"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
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
