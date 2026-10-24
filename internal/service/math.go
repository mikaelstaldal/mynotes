package service

import (
	"sort"
	"strings"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
)

// mathParser consumes opaque math before backticks, matching markdown.ts. The
// node is only used for validation, so it needs no renderer.
type mathParser struct{}

func (*mathParser) Trigger() []byte { return []byte{'$'} }

var mathCacheKey = parser.NewContextKey()

type mathCache struct {
	parent  ast.Node
	source  string
	offsets map[int]int
	starts  map[int]int
	single  []int
	double  []int
}

func (*mathParser) Parse(parent ast.Node, r text.Reader, pc parser.Context) ast.Node {
	line, seg := r.Position()
	cache, _ := pc.Get(mathCacheKey).(*mathCache)
	if cache == nil || cache.parent != parent {
		cache = &mathCache{parent: parent, offsets: map[int]int{}, starts: map[int]int{}}
		var b strings.Builder
		for {
			v, part := r.PeekLine()
			if len(v) == 0 {
				break
			}
			row, _ := r.Position()
			cache.offsets[row] = b.Len()
			cache.starts[row] = part.Start
			b.Write(v)
			r.AdvanceLine()
		}
		cache.source = b.String()
		slashes := 0
		for i := 0; i < len(cache.source); i++ {
			c := cache.source[i]
			if c == '$' && slashes%2 == 0 {
				if i+1 < len(cache.source) && cache.source[i+1] == '$' {
					cache.double = append(cache.double, i)
				}
				prevSpace := i > 0 && (cache.source[i-1] == ' ' || cache.source[i-1] == '\t')
				nextDigit := i+1 < len(cache.source) && cache.source[i+1] >= '0' && cache.source[i+1] <= '9'
				if !prevSpace && !nextDigit {
					cache.single = append(cache.single, i)
				}
			}
			if c == '\\' {
				slashes++
			} else {
				slashes = 0
			}
		}
		pc.Set(mathCacheKey, cache)
		r.SetPosition(line, seg)
	}
	offset := cache.offsets[line] + seg.Start - cache.starts[line]
	end := cache.end(offset)
	if end == 0 {
		return nil
	}
	// Advance within each logical line: container prefixes and virtual padding
	// are reader bookkeeping, not bytes in the inline source.
	for end > 0 {
		v, _ := r.PeekLine()
		if end < len(v) {
			r.Advance(end)
			break
		}
		end -= len(v)
		r.AdvanceLine()
	}
	return ast.NewString([]byte("math"))
}

// end mirrors display then single-dollar math. Closing delimiter indexes are
// built once, so repeated unmatched dollars cannot trigger quadratic scans.
func (c *mathCache) end(start int) int {
	src := c.source
	if start+1 < len(src) && (src[start+1] == ' ' || src[start+1] == '\t') {
		return 1
	}
	if strings.HasPrefix(src[start:], "$$") {
		i := sort.SearchInts(c.double, start+2)
		if i < len(c.double) {
			close := c.double[i]
			if strings.TrimSpace(src[start+2:close]) != "" {
				return close + 2 - start
			}
		}
	}
	i := sort.SearchInts(c.single, start+1)
	if i < len(c.single) {
		close := c.single[i]
		if strings.TrimSpace(src[start+1:close]) != "" {
			return close + 1 - start
		}
	}
	return 0
}

// Display blocks end at a line whose trimmed suffix is $$, even without a
// matching inline delimiter. Code/HTML inside the block is opaque to rendering.
type mathBlockParser struct{}
type mathBlock struct {
	ast.BaseBlock
	closed bool
}

var kindMathBlock = ast.NewNodeKind("MathBlock")

func (*mathBlock) Kind() ast.NodeKind           { return kindMathBlock }
func (n *mathBlock) Dump(src []byte, level int) { ast.DumpHelper(n, src, level, nil, nil) }
func (*mathBlockParser) Trigger() []byte        { return []byte{'$'} }
func (*mathBlockParser) Open(_ ast.Node, r text.Reader, pc parser.Context) (ast.Node, parser.State) {
	line, _ := r.PeekLine()
	pos := pc.BlockOffset()
	if pos < 0 || pos+2 > len(line) || string(line[pos:pos+2]) != "$$" {
		return nil, parser.NoChildren
	}
	n := &mathBlock{closed: strings.HasSuffix(strings.TrimSpace(string(line[pos+2:])), "$$")}
	r.AdvanceToEOL()
	return n, parser.NoChildren
}
func (*mathBlockParser) Continue(node ast.Node, r text.Reader, _ parser.Context) parser.State {
	n := node.(*mathBlock)
	if n.closed {
		return parser.Close
	}
	line, _ := r.PeekLine()
	n.closed = strings.HasSuffix(strings.TrimSpace(string(line)), "$$")
	r.AdvanceToEOL()
	return parser.Continue | parser.NoChildren
}
func (*mathBlockParser) Close(ast.Node, text.Reader, parser.Context) {}
func (*mathBlockParser) CanInterruptParagraph() bool                 { return true }
func (*mathBlockParser) CanAcceptIndentedLine() bool                 { return false }
