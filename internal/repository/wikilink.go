package repository

import (
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	gmtext "github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// Link extraction mirrors the frontend renderer's notion of what is a link, so
// the index matches what a reader actually sees. The frontend
// (web/ts/util/markdown.ts) registers a markdown-it inline rule *before* the
// standard `link` rule; inline rules never run inside code spans or code
// blocks, so a `[[slug]]` written inside code is left as literal text. We get
// the same behaviour by registering an equivalent Goldmark inline parser:
// Goldmark likewise does not run inline parsers inside code, so wikilinks there
// are ignored automatically — no manual code-region stripping needed.

// kindWikiLink identifies the AST node produced by wikiLinkParser. The node is
// only ever walked for extraction; it is never rendered, so it needs no
// renderer registration.
var kindWikiLink = ast.NewNodeKind("WikiLink")

// wikiLinkNode is an inline AST node for a recognized wikilink. sigil is "#" for
// a tag link and "" for a note link; slug is the target slug (group 2 of
// mdWikiLinkRE). The optional display label is irrelevant to indexing and is not
// retained.
type wikiLinkNode struct {
	ast.BaseInline
	sigil string
	slug  string
}

func (n *wikiLinkNode) Kind() ast.NodeKind { return kindWikiLink }

func (n *wikiLinkNode) Dump(source []byte, level int) {
	ast.DumpHelper(n, source, level, nil, nil)
}

// wikiLinkParser recognizes [[slug]], [[slug|label]], [[#slug]] and
// [[#slug|label]] in inline text, mirroring the frontend's markdown-it rule. It
// reuses mdWikiLinkRE (the same grammar the excerpt stripper uses) and only
// matches at the reader position, so a `[` that does not begin a wikilink falls
// through to Goldmark's default link parser.
type wikiLinkParser struct{}

func (p *wikiLinkParser) Trigger() []byte { return []byte{'['} }

func (p *wikiLinkParser) Parse(_ ast.Node, block gmtext.Reader, _ parser.Context) ast.Node {
	line, _ := block.PeekLine()
	m := mdWikiLinkRE.FindSubmatchIndex(line)
	// Only consume when a wikilink starts exactly at the current position.
	if m == nil || m[0] != 0 {
		return nil
	}
	node := &wikiLinkNode{
		sigil: string(line[m[2]:m[3]]),
		slug:  string(line[m[4]:m[5]]),
	}
	block.Advance(m[1])
	return node
}

// wikiLinkExtractParser is a Goldmark parser whose only job is to surface
// wikilink nodes for extraction. It layers wikiLinkParser above the default
// inline parsers (priority below the link parser at 200, so [[ ]] is tried
// first). Only CommonMark-core block/inline handling is needed — code spans and
// code blocks (which must exclude wikilinks) are core, and GFM constructs like
// tables/strikethrough do not gate inline parsing — so no extensions are wired
// in. The parser is stateless and safe for concurrent use.
var wikiLinkExtractParser = goldmark.New(
	goldmark.WithParserOptions(
		parser.WithInlineParsers(util.Prioritized(&wikiLinkParser{}, 199)),
	),
).Parser()

// extractNoteLinks parses content and returns the distinct note-link target
// slugs it contains, in first-seen order. Tag links ([[#slug]]) and any
// self-reference to ownSlug are excluded, and wikilinks inside code spans/blocks
// are ignored (consistent with how the content renders). The result is the full
// set of a note's outgoing link targets, whether or not each target note exists.
func extractNoteLinks(content, ownSlug string) []string {
	doc := wikiLinkExtractParser.Parse(gmtext.NewReader([]byte(content)))
	seen := make(map[string]bool)
	var out []string
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		wl, ok := n.(*wikiLinkNode)
		if !ok || wl.sigil != "" || wl.slug == ownSlug || seen[wl.slug] {
			return ast.WalkContinue, nil
		}
		seen[wl.slug] = true
		out = append(out, wl.slug)
		return ast.WalkContinue, nil
	})
	return out
}
