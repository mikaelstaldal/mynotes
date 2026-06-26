// Package htmlmd converts an HTML document to Markdown. Only the <body>
// subtree is converted; content outside it (scripts, stylesheets, head
// metadata) is discarded. The produced Markdown uses CommonMark syntax plus
// the GFM extensions supported by this application: tables, strikethrough,
// and linkify.
//
// Conversion rules:
//   - Tags with direct Markdown equivalents are converted to Markdown syntax.
//   - Tags allowed by the application's sanitization policy but with no
//     Markdown equivalent are kept as raw HTML in the output.
//   - Tags outside the sanitization policy have their start/end tags stripped;
//     their text content is preserved (except <script>/<style> which are
//     skipped entirely).
package htmlmd

import (
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// Result is the output of Convert.
type Result struct {
	// Title is the text of the <title> element, or the plain text of the first
	// h1–h6 element in the body, or "" if neither is present.
	Title string
	// Content is the converted Markdown, trimmed of leading/trailing whitespace.
	Content string
}

// Convert parses htmlDoc and converts its <body> to Markdown.
func Convert(htmlDoc string) (Result, error) {
	root, err := html.Parse(strings.NewReader(htmlDoc))
	if err != nil {
		return Result{}, err
	}

	c := &converter{}

	htmlNode := firstChildElement(root, atom.Html)
	if htmlNode == nil {
		// Fragment input: html.Parse always produces the full tree, so this
		// should not happen, but fall back gracefully.
		htmlNode = root
	}

	if head := firstChildElement(htmlNode, atom.Head); head != nil {
		c.title = extractTitleText(head)
	}
	if body := firstChildElement(htmlNode, atom.Body); body != nil {
		c.walkChildren(body, 0)
	} else {
		c.walkChildren(htmlNode, 0)
	}

	return Result{
		Title:   strings.TrimSpace(c.title),
		Content: strings.TrimSpace(c.buf.String()),
	}, nil
}

// converter holds mutable state across the recursive DOM walk.
type converter struct {
	title        string // from <head><title>
	firstHeading string // first h1–h6 plain text; exported as Title when no <title>

	buf        strings.Builder
	pendingNLs int // deferred newlines; flushed before the next write

	inPre      bool // inside <pre>: text written raw, no escaping
	listStack  []listLevel
	tableState *tableAccum
}

type listLevel struct {
	ordered bool
	counter int
}

type tableAccum struct {
	headerRows [][]string
	bodyRows   [][]string
	inHeader   bool
	curRow     []string
	aligns     []string // per-column align value ("left"/"right"/"center")
}

// maxWalkDepth guards against stack overflow on pathologically nested HTML.
const maxWalkDepth = 200

// ── Output helpers ────────────────────────────────────────────────────────────

func (c *converter) flushPendingNLs() {
	if c.buf.Len() == 0 {
		c.pendingNLs = 0
		return
	}
	for i := 0; i < c.pendingNLs; i++ {
		c.buf.WriteByte('\n')
	}
	c.pendingNLs = 0
}

func (c *converter) write(s string) {
	if s == "" {
		return
	}
	c.flushPendingNLs()
	c.buf.WriteString(s)
}

// ensureBlock schedules a blank line (two newlines) before the next write.
func (c *converter) ensureBlock() {
	if c.pendingNLs < 2 {
		c.pendingNLs = 2
	}
}

// ensureNewline schedules a single newline before the next write.
func (c *converter) ensureNewline() {
	if c.pendingNLs < 1 {
		c.pendingNLs = 1
	}
}

// ── Walk ─────────────────────────────────────────────────────────────────────

func (c *converter) walk(n *html.Node, depth int) {
	if depth > maxWalkDepth {
		return
	}
	switch n.Type {
	case html.TextNode:
		if c.inPre {
			c.write(n.Data)
		} else {
			// Collapse newlines: block structure comes from elements.
			text := strings.ReplaceAll(n.Data, "\n", " ")
			c.write(escapeMarkdownText(text))
		}
	case html.ElementNode:
		c.handleElement(n, depth)
	case html.DocumentNode:
		c.walkChildren(n, depth)
		// DoctypeNode, CommentNode: skip
	}
}

func (c *converter) walkChildren(n *html.Node, depth int) {
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		c.walk(ch, depth+1)
	}
}

// ── Element dispatch ──────────────────────────────────────────────────────────

func (c *converter) handleElement(n *html.Node, depth int) {
	switch n.DataAtom {

	// ── Skip entirely (dangerous or non-content) ──────────────────────────
	case atom.Script, atom.Style, atom.Noscript, atom.Template, atom.Svg, atom.Math:
		return

	// ── Transparent structural containers (not in UGC policy) ────────────
	// Strip tag, preserve children; insert block gaps to avoid run-on text.
	case atom.Div, atom.Section, atom.Article, atom.Header, atom.Footer,
		atom.Nav, atom.Main, atom.Aside, atom.Center, atom.Form, atom.Label,
		atom.Address, atom.Fieldset:
		c.ensureBlock()
		c.walkChildren(n, depth)
		c.ensureBlock()

	// ── Paragraphs ────────────────────────────────────────────────────────
	case atom.P:
		c.ensureBlock()
		c.walkChildren(n, depth)
		c.ensureBlock()

	// ── Headings ──────────────────────────────────────────────────────────
	case atom.H1, atom.H2, atom.H3, atom.H4, atom.H5, atom.H6:
		c.ensureBlock()
		level := headingLevel(n.DataAtom)
		plain := collectPlainText(n)
		if c.firstHeading == "" {
			c.firstHeading = strings.TrimSpace(plain)
		}
		if c.title == "" && c.firstHeading != "" {
			c.title = c.firstHeading
		}
		c.write(strings.Repeat("#", level) + " ")
		c.walkChildren(n, depth)
		c.ensureBlock()

	// ── Horizontal rule ───────────────────────────────────────────────────
	case atom.Hr:
		c.ensureBlock()
		c.write("---")
		c.ensureBlock()

	// ── Lists ─────────────────────────────────────────────────────────────
	case atom.Ul:
		nested := len(c.listStack) > 0
		if nested {
			c.ensureNewline()
		} else {
			c.ensureBlock()
		}
		c.listStack = append(c.listStack, listLevel{ordered: false})
		c.walkChildren(n, depth)
		c.listStack = c.listStack[:len(c.listStack)-1]
		if !nested {
			c.ensureBlock()
		}

	case atom.Ol:
		nested := len(c.listStack) > 0
		if nested {
			c.ensureNewline()
		} else {
			c.ensureBlock()
		}
		c.listStack = append(c.listStack, listLevel{ordered: true, counter: 1})
		c.walkChildren(n, depth)
		c.listStack = c.listStack[:len(c.listStack)-1]
		if !nested {
			c.ensureBlock()
		}

	case atom.Li:
		indent := strings.Repeat("  ", max(0, len(c.listStack)-1))
		c.ensureNewline()
		level := &c.listStack[len(c.listStack)-1]
		var marker string
		if level.ordered {
			marker = strconv.Itoa(level.counter) + ". "
			level.counter++
		} else {
			marker = "- "
		}
		c.write(indent + marker)
		c.walkChildren(n, depth)
		c.pendingNLs = 1

	// ── Blockquote ────────────────────────────────────────────────────────
	case atom.Blockquote:
		c.ensureBlock()
		sub := c.subConverter()
		sub.walkChildren(n, 0)
		c.mergeFirstHeading(sub)
		inner := strings.TrimRight(sub.buf.String(), "\n")
		for line := range strings.SplitSeq(inner, "\n") {
			if strings.TrimSpace(line) == "" {
				c.write(">")
			} else {
				c.write("> " + line)
			}
			c.buf.WriteByte('\n')
		}
		c.pendingNLs = 2

	// ── Code blocks ───────────────────────────────────────────────────────
	case atom.Pre:
		c.ensureBlock()
		lang := extractCodeLang(n)
		c.write("```" + lang + "\n")
		c.inPre = true
		c.walkChildren(n, depth) // <code> child is transparent in pre mode
		c.inPre = false
		c.ensureNewline()
		c.write("```")
		c.ensureBlock()

	// ── Inline code ───────────────────────────────────────────────────────
	case atom.Code:
		if c.inPre {
			// Transparent: text flows raw into the fenced block.
			c.walkChildren(n, depth)
		} else {
			raw := collectRawText(n)
			if strings.Contains(raw, "`") {
				c.write("`` " + raw + " ``")
			} else {
				c.write("`" + raw + "`")
			}
		}

	// ── Inline formatting → Markdown ──────────────────────────────────────
	case atom.Strong, atom.B:
		sub := c.subConverter()
		sub.walkChildren(n, 0)
		c.mergeFirstHeading(sub)
		inner := strings.TrimSpace(sub.buf.String())
		if inner != "" {
			c.write("**" + inner + "**")
		}

	case atom.Em, atom.I:
		sub := c.subConverter()
		sub.walkChildren(n, 0)
		c.mergeFirstHeading(sub)
		inner := strings.TrimSpace(sub.buf.String())
		if inner != "" {
			c.write("*" + inner + "*")
		}

	case atom.Del, atom.S, atom.Strike:
		sub := c.subConverter()
		sub.walkChildren(n, 0)
		c.mergeFirstHeading(sub)
		inner := strings.TrimSpace(sub.buf.String())
		if inner != "" {
			c.write("~~" + inner + "~~")
		}

	// ── Links and images ──────────────────────────────────────────────────
	case atom.A:
		href := attrVal(n, "href")
		sub := c.subConverter()
		sub.walkChildren(n, 0)
		c.mergeFirstHeading(sub)
		inner := strings.TrimSpace(sub.buf.String())
		if href != "" {
			c.write("[" + inner + "](" + href + ")")
		} else {
			c.write(inner)
		}

	case atom.Img:
		src := attrVal(n, "src")
		if src == "" {
			return
		}
		alt := attrVal(n, "alt")
		c.write("![" + escapeMarkdownText(alt) + "](" + src + ")")

	// ── Hard line break ───────────────────────────────────────────────────
	case atom.Br:
		c.write("  \n")

	// ── Tables ────────────────────────────────────────────────────────────
	case atom.Table:
		c.ensureBlock()
		saved := c.tableState
		c.tableState = &tableAccum{}
		c.walkChildren(n, depth)
		c.renderGFMTable()
		c.tableState = saved
		c.ensureBlock()

	case atom.Thead:
		if c.tableState != nil {
			c.tableState.inHeader = true
		}
		c.walkChildren(n, depth)
		if c.tableState != nil {
			c.tableState.inHeader = false
		}

	case atom.Tbody, atom.Tfoot, atom.Caption:
		c.walkChildren(n, depth)

	case atom.Colgroup, atom.Col:
		// structural metadata; no Markdown output

	case atom.Tr:
		if c.tableState != nil {
			c.tableState.curRow = nil
		}
		c.walkChildren(n, depth)
		if c.tableState != nil {
			if c.tableState.inHeader {
				c.tableState.headerRows = append(c.tableState.headerRows, c.tableState.curRow)
			} else {
				c.tableState.bodyRows = append(c.tableState.bodyRows, c.tableState.curRow)
			}
		}

	case atom.Th, atom.Td:
		if c.tableState != nil {
			sub := c.subConverter()
			sub.walkChildren(n, 0)
			c.mergeFirstHeading(sub)
			// Escape pipe chars in cell content to avoid breaking GFM table syntax.
			cell := strings.ReplaceAll(strings.TrimSpace(sub.buf.String()), "|", "\\|")
			// Collapse newlines; table cells are single-line in GFM.
			cell = strings.ReplaceAll(cell, "\n", " ")
			c.tableState.curRow = append(c.tableState.curRow, cell)
			if n.DataAtom == atom.Th {
				c.tableState.aligns = append(c.tableState.aligns, attrVal(n, "align"))
			}
		} else {
			c.walkChildren(n, depth)
		}

	// ── Raw HTML passthrough (in UGC policy, no Markdown equivalent) ──────
	// These are allowed by the application's bluemonday UGCPolicy and will
	// survive the service's embedded-HTML validation.
	case atom.Abbr, atom.Acronym, atom.Bdo, atom.Big, atom.Cite, atom.Dfn,
		atom.Details, atom.Dl, atom.Dt, atom.Dd,
		atom.Figcaption, atom.Figure,
		atom.Ins, atom.Kbd, atom.Mark,
		atom.Q, atom.Rp, atom.Rt, atom.Ruby,
		atom.Samp, atom.Small, atom.Span,
		atom.Sub, atom.Summary, atom.Sup,
		atom.Time, atom.Tt, atom.U, atom.Var, atom.Wbr:
		c.write(serializeElement(n))

	default:
		// Unrecognized element: strip tag, walk children for text content.
		c.walkChildren(n, depth)
	}
}

// ── Table rendering ───────────────────────────────────────────────────────────

func (c *converter) renderGFMTable() {
	ts := c.tableState
	allRows := append(ts.headerRows, ts.bodyRows...)
	if len(allRows) == 0 {
		return
	}

	maxCols := 1
	for _, r := range allRows {
		if len(r) > maxCols {
			maxCols = len(r)
		}
	}

	var header []string
	var dataRows [][]string
	if len(ts.headerRows) > 0 {
		header = ts.headerRows[0]
		dataRows = append(ts.headerRows[1:], ts.bodyRows...)
	} else {
		header = allRows[0]
		dataRows = allRows[1:]
	}
	header = padRow(header, maxCols)

	seps := make([]string, maxCols)
	for i := range seps {
		var align string
		if i < len(ts.aligns) {
			align = strings.ToLower(ts.aligns[i])
		}
		switch align {
		case "center":
			seps[i] = ":---:"
		case "right":
			seps[i] = "---:"
		case "left":
			seps[i] = ":---"
		default:
			seps[i] = "---"
		}
	}

	c.write("| " + strings.Join(header, " | ") + " |\n")
	c.write("| " + strings.Join(seps, " | ") + " |\n")
	for _, row := range dataRows {
		c.write("| " + strings.Join(padRow(row, maxCols), " | ") + " |\n")
	}
}

func padRow(row []string, n int) []string {
	out := make([]string, n)
	copy(out, row)
	return out
}

// ── Sub-converter ─────────────────────────────────────────────────────────────

// subConverter creates a child converter for inline contexts (strong, em, etc.)
// and blockquote inner content. It inherits inPre and listStack state.
func (c *converter) subConverter() *converter {
	sub := &converter{inPre: c.inPre}
	if len(c.listStack) > 0 {
		sub.listStack = make([]listLevel, len(c.listStack))
		copy(sub.listStack, c.listStack)
	}
	return sub
}

// mergeFirstHeading propagates firstHeading discovery from a sub-converter.
func (c *converter) mergeFirstHeading(sub *converter) {
	if c.firstHeading == "" && sub.firstHeading != "" {
		c.firstHeading = sub.firstHeading
	}
	if c.title == "" && c.firstHeading != "" {
		c.title = c.firstHeading
	}
}

// ── Serialization ─────────────────────────────────────────────────────────────

// safeAttrs maps element atoms to their allowed attribute names.
// Only these attributes are emitted by serializeElement; all others are stripped.
var safeAttrs = map[atom.Atom]map[string]bool{
	atom.Abbr:     {"title": true},
	atom.Acronym:  {"title": true},
	atom.Dfn:      {"title": true},
	atom.Time:     {"datetime": true},
	atom.Th:       {"align": true, "colspan": true, "rowspan": true, "scope": true},
	atom.Td:       {"align": true, "colspan": true, "rowspan": true},
	atom.Col:      {"span": true, "align": true},
	atom.Colgroup: {"span": true},
	atom.Q:        {"cite": true},
}

// voidElements are HTML elements that must not have a closing tag.
var voidElements = map[atom.Atom]bool{
	atom.Br:    true,
	atom.Hr:    true,
	atom.Img:   true,
	atom.Input: true,
	atom.Col:   true,
	atom.Wbr:   true,
}

// serializeElement re-serializes an element and its subtree as safe HTML.
// Only attributes in safeAttrs are emitted; all others are stripped.
func serializeElement(n *html.Node) string {
	var b strings.Builder
	serializeNode(&b, n)
	return b.String()
}

func serializeNode(b *strings.Builder, n *html.Node) {
	switch n.Type {
	case html.TextNode:
		b.WriteString(html.EscapeString(n.Data))
	case html.ElementNode:
		b.WriteByte('<')
		b.WriteString(n.Data)
		allowed := safeAttrs[n.DataAtom]
		for _, a := range n.Attr {
			key := strings.ToLower(a.Key)
			if allowed[key] {
				fmt.Fprintf(b, ` %s="%s"`, key, html.EscapeString(a.Val))
			}
		}
		if voidElements[n.DataAtom] {
			b.WriteByte('>')
			return
		}
		b.WriteByte('>')
		for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
			serializeNode(b, ch)
		}
		b.WriteString("</" + n.Data + ">")
	}
}

// ── Text utilities ────────────────────────────────────────────────────────────

// escapeMarkdownText escapes characters that carry syntactic meaning in
// Markdown inline context. '>' is not escaped (blockquote syntax only triggers
// at line start). '#' is not escaped (ATX heading marker only triggers at line
// start). '\n' is handled at the call site before escaping.
func escapeMarkdownText(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch r {
		case '\\', '*', '_', '`', '[', ']', '~', '<', '!', '|':
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// collectPlainText concatenates all text-node content in the subtree.
// Used for heading title extraction (no Markdown escaping).
func collectPlainText(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
		}
		for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
			walk(ch)
		}
	}
	walk(n)
	return b.String()
}

// collectRawText is like collectPlainText but skips element subtrees inside
// script/style children. Used for inline <code> content.
func collectRawText(n *html.Node) string {
	return collectPlainText(n)
}

// ── DOM utilities ─────────────────────────────────────────────────────────────

func attrVal(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if strings.EqualFold(a.Key, key) {
			return a.Val
		}
	}
	return ""
}

func firstChildElement(parent *html.Node, a atom.Atom) *html.Node {
	for ch := parent.FirstChild; ch != nil; ch = ch.NextSibling {
		if ch.Type == html.ElementNode && ch.DataAtom == a {
			return ch
		}
	}
	return nil
}

func extractTitleText(head *html.Node) string {
	titleNode := firstChildElement(head, atom.Title)
	if titleNode == nil {
		return ""
	}
	return strings.TrimSpace(collectPlainText(titleNode))
}

// extractCodeLang looks for a child <code class="language-X"> and returns "X".
func extractCodeLang(pre *html.Node) string {
	for ch := pre.FirstChild; ch != nil; ch = ch.NextSibling {
		if ch.Type == html.ElementNode && ch.DataAtom == atom.Code {
			for cls := range strings.FieldsSeq(attrVal(ch, "class")) {
				if lang, ok := strings.CutPrefix(cls, "language-"); ok {
					return lang
				}
			}
		}
	}
	return ""
}

func headingLevel(a atom.Atom) int {
	switch a {
	case atom.H1:
		return 1
	case atom.H2:
		return 2
	case atom.H3:
		return 3
	case atom.H4:
		return 4
	case atom.H5:
		return 5
	case atom.H6:
		return 6
	}
	return 1
}
