package service

import (
	"bytes"

	"github.com/mikaelstaldal/mynotes/internal/asciimath"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/renderer"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// This file adds AsciiMath ($…$ inline / $$…$$ display) support to the
// server-side Markdown renderer so the downloaded HTML matches what the web UI
// (and Android app) show on screen. The delimiter rules mirror the client's
// markdown-it configuration in web/ts/util/markdown.ts:
//
//   - Inline $…$   → inline MathML. An opening '$' must not be followed by
//     whitespace; a closing '$' must not be preceded by whitespace nor followed
//     by a digit (so "$5 and $10" stays literal). '$' escaped by a backslash is
//     literal.
//   - Inline $$…$$ (within one line) → display MathML.
//   - Block  $$…$$ (a line opening with "$$", spanning lines until one ending
//     in "$$") → display MathML.
//
// Each math run's AsciiMath source is converted to MathML by
// internal/asciimath at render time; the whole rendered fragment is then
// sanitized by RenderToHTML (the MathML allow-list already covers <math>), so
// math markup passes through the same render-time gate as everything else.

// ### AST nodes

var kindMathInline = ast.NewNodeKind("MathInline")
var kindMathBlock = ast.NewNodeKind("MathBlock")

// mathInline is an inline math run ($…$ or a single-line $$…$$). inline selects
// inline vs. display MathML style.
type mathInline struct {
	ast.BaseInline
	value  []byte
	inline bool
}

func (n *mathInline) Kind() ast.NodeKind { return kindMathInline }

func (n *mathInline) Dump(source []byte, level int) {
	ast.DumpHelper(n, source, level, map[string]string{"value": string(n.value)}, nil)
}

func newMathInline(value []byte, inline bool) *mathInline {
	return &mathInline{value: value, inline: inline}
}

// mathBlock is a display-math block ($$…$$ spanning one or more lines). The
// AsciiMath source is accumulated line by line during block parsing into buf and
// finalized into content on close.
type mathBlock struct {
	ast.BaseBlock
	buf     bytes.Buffer
	content []byte
	closed  bool
}

func (n *mathBlock) Kind() ast.NodeKind { return kindMathBlock }

func (n *mathBlock) Dump(source []byte, level int) {
	ast.DumpHelper(n, source, level, map[string]string{"content": string(n.content)}, nil)
}

// ### Inline parser

type mathInlineParser struct{}

func (p *mathInlineParser) Trigger() []byte { return []byte{'$'} }

func (p *mathInlineParser) Parse(parent ast.Node, block text.Reader, pc parser.Context) ast.Node {
	line, _ := block.PeekLine()
	n := len(line)
	if n == 0 || line[0] != '$' {
		return nil
	}
	// Display math on a single inline run: $$…$$.
	if n >= 2 && line[1] == '$' {
		for i := 2; i < n; i++ {
			if line[i] == '$' && i+1 < n && line[i+1] == '$' && !backslashEscaped(line, i) {
				content := line[2:i]
				if len(bytes.TrimSpace(content)) == 0 {
					return nil
				}
				block.Advance(i + 2)
				return newMathInline(copyBytes(content), false)
			}
		}
		return nil
	}
	// Inline math: $…$. An opening '$' followed by whitespace does not open.
	if n > 1 && (line[1] == ' ' || line[1] == '\t') {
		return nil
	}
	for i := 1; i < n; i++ {
		if line[i] == '$' && !backslashEscaped(line, i) && inlineCanClose(line, i, n) {
			content := line[1:i]
			if len(bytes.TrimSpace(content)) == 0 {
				return nil
			}
			block.Advance(i + 1)
			return newMathInline(copyBytes(content), true)
		}
	}
	return nil
}

// inlineCanClose reports whether a '$' at pos may close an inline math span: it
// must not be immediately preceded by whitespace nor immediately followed by a
// digit (mirroring markdown-it-katex, so currency like "$5" stays literal).
func inlineCanClose(line []byte, pos, n int) bool {
	prev := line[pos-1]
	if prev == ' ' || prev == '\t' {
		return false
	}
	if pos+1 < n {
		next := line[pos+1]
		if next >= '0' && next <= '9' {
			return false
		}
	}
	return true
}

// backslashEscaped reports whether the character at pos is preceded by an odd
// number of backslashes (and is therefore escaped).
func backslashEscaped(line []byte, pos int) bool {
	count := 0
	for i := pos - 1; i >= 0 && line[i] == '\\'; i-- {
		count++
	}
	return count%2 == 1
}

func copyBytes(b []byte) []byte {
	c := make([]byte, len(b))
	copy(c, b)
	return c
}

// ### Block parser

type mathBlockParser struct{}

func (b *mathBlockParser) Trigger() []byte { return []byte{'$'} }

func (b *mathBlockParser) Open(parent ast.Node, reader text.Reader, pc parser.Context) (ast.Node, parser.State) {
	line, _ := reader.PeekLine()
	pos := pc.BlockIndent()
	if pos+1 >= len(line) || line[pos] != '$' || line[pos+1] != '$' {
		return nil, parser.NoChildren
	}
	rest := trimTrailingNewline(line[pos+2:])
	restTrim := bytes.TrimSpace(rest)
	node := &mathBlock{}
	// Single-line block: $$ … $$ entirely on the opening line.
	if bytes.HasSuffix(restTrim, dollarDollar) {
		node.content = bytes.TrimSpace(restTrim[:len(restTrim)-2])
		node.closed = true
		return node, parser.NoChildren
	}
	// Multi-line: keep the opening line's remainder (if any) as the first line.
	if len(restTrim) > 0 {
		node.buf.Write(rest)
		node.buf.WriteByte('\n')
	}
	return node, parser.NoChildren
}

func (b *mathBlockParser) Continue(node ast.Node, reader text.Reader, pc parser.Context) parser.State {
	n := node.(*mathBlock)
	if n.closed {
		return parser.Close
	}
	line, _ := reader.PeekLine()
	lineNoNL := trimTrailingNewline(line)
	trimmed := bytes.TrimSpace(lineNoNL)
	if bytes.HasSuffix(trimmed, dollarDollar) {
		// Closing line: keep its content up to the last "$$".
		idx := bytes.LastIndex(lineNoNL, dollarDollar)
		lastLine := lineNoNL[:idx]
		if len(bytes.TrimSpace(lastLine)) > 0 {
			n.buf.Write(lastLine)
		}
		n.content = n.buf.Bytes()
		n.closed = true
		reader.AdvanceToEOL()
		return parser.Close
	}
	n.buf.Write(lineNoNL)
	n.buf.WriteByte('\n')
	reader.AdvanceToEOL()
	return parser.Continue | parser.NoChildren
}

func (b *mathBlockParser) Close(node ast.Node, reader text.Reader, pc parser.Context) {
	n := node.(*mathBlock)
	if n.content == nil {
		// Unterminated $$ block: use whatever was gathered (matches the client,
		// whose block rule emits the block even without a closing "$$").
		n.content = n.buf.Bytes()
	}
}

func (b *mathBlockParser) CanInterruptParagraph() bool { return true }

func (b *mathBlockParser) CanAcceptIndentedLine() bool { return false }

var dollarDollar = []byte("$$")

// trimTrailingNewline drops a single trailing "\n" (and a preceding "\r"), which
// PeekLine includes on every non-final line.
func trimTrailingNewline(line []byte) []byte {
	if len(line) > 0 && line[len(line)-1] == '\n' {
		line = line[:len(line)-1]
	}
	if len(line) > 0 && line[len(line)-1] == '\r' {
		line = line[:len(line)-1]
	}
	return line
}

// ### Renderer

type mathRenderer struct{}

func (r *mathRenderer) RegisterFuncs(reg renderer.NodeRendererFuncRegisterer) {
	reg.Register(kindMathInline, r.renderMathInline)
	reg.Register(kindMathBlock, r.renderMathBlock)
}

func (r *mathRenderer) renderMathInline(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if entering {
		n := node.(*mathInline)
		src := string(bytes.TrimSpace(n.value))
		_, _ = w.WriteString(asciimath.ToMathML(src, n.inline))
	}
	return ast.WalkContinue, nil
}

func (r *mathRenderer) renderMathBlock(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if entering {
		n := node.(*mathBlock)
		src := string(bytes.TrimSpace(n.content))
		_, _ = w.WriteString(asciimath.ToMathML(src, false))
		_ = w.WriteByte('\n')
	}
	return ast.WalkContinue, nil
}

// ### Extension

type mathExtension struct{}

// mathExt enables AsciiMath $…$ / $$…$$ rendering. It is added to the export
// Markdown renderer (not the write-time validation parser, which leaves note
// content — including any literal '$' — untouched).
var mathExt = &mathExtension{}

func (e *mathExtension) Extend(m goldmark.Markdown) {
	m.Parser().AddOptions(
		parser.WithBlockParsers(util.Prioritized(&mathBlockParser{}, 100)),
		parser.WithInlineParsers(util.Prioritized(&mathInlineParser{}, 150)),
	)
	m.Renderer().AddOptions(
		renderer.WithNodeRenderers(util.Prioritized(&mathRenderer{}, 100)),
	)
}
