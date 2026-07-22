package service

import (
	"strings"
	"unicode/utf8"

	"github.com/yuin/goldmark/ast"
	gmtext "github.com/yuin/goldmark/text"
)

// wrapWidth is the column at which downloaded Markdown paragraphs are soft-wrapped.
const wrapWidth = 80

// wrapMarkdown reflows over-long paragraph lines to wrapWidth columns for
// download, inserting soft line breaks at word boundaries only. Rendering is
// unaffected: within a paragraph a single newline is a soft break that renders
// as a space, so replacing an interior space run with a newline is a no-op for
// the reader.
//
// Only top-level paragraphs are touched. Their source is spliced back byte for
// byte around the rewritten spans, so headings, fenced/indented code, tables,
// HTML blocks, blockquotes, and list items (whose paragraph lines carry a
// per-line prefix that a naive rewrap would corrupt) are left verbatim. Breaks
// are never inserted before a token that could start or interrupt a block
// (heading, list, blockquote, fence, thematic break, setext underline, …), so
// the wrapped continuation lines stay part of the same paragraph.
func wrapMarkdown(content string) string {
	if content == "" {
		return content
	}
	src := []byte(content)
	doc := markdownParser.Parse(gmtext.NewReader(src))

	// Collect the byte spans of wrappable top-level paragraphs, in document order.
	type span struct{ start, stop int }
	var spans []span
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering || n.Kind() != ast.KindParagraph || n.Parent().Kind() != ast.KindDocument {
			return ast.WalkContinue, nil
		}
		lines := n.Lines()
		if lines.Len() == 0 {
			return ast.WalkContinue, nil
		}
		// A top-level paragraph's line segments are contiguous (no per-line
		// prefix); verify before splicing so a prefixed paragraph is never
		// clobbered even if one reaches here.
		start := lines.At(0).Start
		stop := lines.At(lines.Len() - 1).Stop
		prev := start
		contiguous := true
		for i := 0; i < lines.Len(); i++ {
			s := lines.At(i)
			if s.Start != prev {
				contiguous = false
				break
			}
			prev = s.Stop
		}
		if contiguous {
			spans = append(spans, span{start, stop})
		}
		return ast.WalkContinue, nil
	})

	if len(spans) == 0 {
		return content
	}

	var b strings.Builder
	b.Grow(len(content) + len(content)/8)
	prev := 0
	for _, sp := range spans {
		b.WriteString(content[prev:sp.start])
		b.WriteString(wrapParagraph(content[sp.start:sp.stop]))
		prev = sp.stop
	}
	b.WriteString(content[prev:])
	return b.String()
}

// wrapParagraph wraps each source line of a paragraph chunk independently,
// preserving the existing newline structure (including any hard breaks) and
// only adding soft breaks inside lines that exceed wrapWidth.
func wrapParagraph(chunk string) string {
	lines := strings.Split(chunk, "\n")
	for i, line := range lines {
		lines[i] = wrapLine(line)
	}
	return strings.Join(lines, "\n")
}

// wrapLine soft-wraps a single line to wrapWidth columns, breaking only at
// interior space runs and never before a token that could begin a block
// construct. A chosen space run is replaced by a single newline; every other
// character (leading indentation, interior spacing, trailing hard-break spaces,
// the words themselves) is preserved exactly.
func wrapLine(line string) string {
	if utf8.RuneCountInString(line) <= wrapWidth {
		return line
	}

	// Leading whitespace is kept as-is on the first output line.
	i := 0
	for i < len(line) && (line[i] == ' ' || line[i] == '\t') {
		i++
	}
	prefix := line[:i]

	// Split the remainder into (word, following-gap) tokens. Gaps are runs of
	// spaces/tabs; the final token's gap holds any trailing whitespace.
	type token struct{ word, gap string }
	var toks []token
	for i < len(line) {
		ws := i
		for i < len(line) && line[i] != ' ' && line[i] != '\t' {
			i++
		}
		word := line[ws:i]
		gs := i
		for i < len(line) && (line[i] == ' ' || line[i] == '\t') {
			i++
		}
		toks = append(toks, token{word: word, gap: line[gs:i]})
	}
	if len(toks) == 0 {
		return line
	}

	var b strings.Builder
	b.WriteString(prefix)
	col := utf8.RuneCountInString(prefix)
	for i, t := range toks {
		wl := utf8.RuneCountInString(t.word)
		if i == 0 {
			b.WriteString(t.word)
			col += wl
			continue
		}
		gap := toks[i-1].gap
		gl := utf8.RuneCountInString(gap)
		if col+gl+wl > wrapWidth && canStartLine(t.word) {
			b.WriteByte('\n')
			b.WriteString(t.word)
			col = wl
		} else {
			b.WriteString(gap)
			b.WriteString(t.word)
			col += gl + wl
		}
	}
	b.WriteString(toks[len(toks)-1].gap) // trailing gap (e.g. hard-break spaces)
	return b.String()
}

// canStartLine reports whether word is safe as the first token of a wrapped
// continuation line — i.e. it cannot begin or interrupt a block-level
// construct. It is deliberately conservative: an ambiguous token is treated as
// unsafe, at worst leaving a line slightly over width rather than changing how
// the paragraph renders.
func canStartLine(word string) bool {
	if word == "" {
		return false
	}
	switch word[0] {
	case '>', '<', '|':
		// Blockquote (space after > optional), HTML block, table-ish.
		return false
	case '#':
		// ATX heading: 1-6 '#' followed by a space (the break) or end of line.
		n := leadingRun(word, '#')
		return n != len(word) || n > 6
	case '-', '*':
		// Bullet list marker ("- "/"* "), thematic break ("---"/"***"), or
		// setext underline ("-"). A lone marker or an all-marker run is unsafe.
		return !allSame(word, word[0])
	case '+':
		// Bullet list marker only.
		return word != "+"
	case '_':
		// Thematic break ("___", 3+).
		return !allSame(word, '_') || len(word) < 3
	case '=':
		// Setext heading underline ("===").
		return !allSame(word, '=')
	case '~':
		// Fenced code (~~~, 3+); ~~strike~~ stays safe.
		return leadingRun(word, '~') < 3
	case '`':
		// Fenced code (```, 3+); `code` stays safe.
		return leadingRun(word, '`') < 3
	default:
		// Ordered list marker that could interrupt a paragraph: digits then
		// '.'/')'. Conservative for any such token, not only "1.".
		return !isOrderedMarker(word)
	}
}

// leadingRun counts the leading run of byte c in s.
func leadingRun(s string, c byte) int {
	n := 0
	for n < len(s) && s[n] == c {
		n++
	}
	return n
}

// allSame reports whether s is non-empty and every byte equals c.
func allSame(s string, c byte) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] != c {
			return false
		}
	}
	return true
}

// isOrderedMarker reports whether word is an ordered-list marker ("<digits>."
// or "<digits>)").
func isOrderedMarker(word string) bool {
	if len(word) < 2 {
		return false
	}
	last := word[len(word)-1]
	if last != '.' && last != ')' {
		return false
	}
	for i := 0; i < len(word)-1; i++ {
		if word[i] < '0' || word[i] > '9' {
			return false
		}
	}
	return true
}
