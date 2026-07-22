package service

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// longestLine returns the greatest rune-count of any line in s.
func longestLine(s string) int {
	max := 0
	for line := range strings.SplitSeq(s, "\n") {
		if n := len([]rune(line)); n > max {
			max = n
		}
	}
	return max
}

func TestWrapMarkdown_WrapsLongParagraph(t *testing.T) {
	// A single long paragraph line, all short words, no trailing newline.
	words := make([]string, 40)
	for i := range words {
		words[i] = "word"
	}
	content := strings.Join(words, " ")
	require.Greater(t, len([]rune(content)), wrapWidth)

	out := wrapMarkdown(content)

	assert.LessOrEqual(t, longestLine(out), wrapWidth, "every line fits within the width")
	assert.Greater(t, strings.Count(out, "\n"), 0, "at least one soft break was inserted")
	// No content lost: collapsing the soft breaks back to spaces restores the input.
	assert.Equal(t, content, strings.ReplaceAll(out, "\n", " "))
}

func TestWrapMarkdown_ShortParagraphUnchanged(t *testing.T) {
	content := "A short paragraph.\n\nAnother short one."
	assert.Equal(t, content, wrapMarkdown(content))
}

func TestWrapMarkdown_NeverSplitsAWord(t *testing.T) {
	long := strings.Repeat("x", 120) // a single word longer than the width
	content := "prefix " + long + " suffix"
	out := wrapMarkdown(content)
	assert.Contains(t, out, long, "the over-long word is emitted intact")
}

func TestWrapMarkdown_LeavesCodeFenceVerbatim(t *testing.T) {
	code := strings.Repeat("a", 100)
	content := "```\n" + code + "\n```"
	assert.Equal(t, content, wrapMarkdown(content), "fenced code is never wrapped")
}

func TestWrapMarkdown_LeavesIndentedCodeVerbatim(t *testing.T) {
	content := "    " + strings.Repeat("a", 100)
	assert.Equal(t, content, wrapMarkdown(content), "indented code is never wrapped")
}

func TestWrapMarkdown_LeavesTableVerbatim(t *testing.T) {
	row := "| " + strings.Repeat("cell ", 20) + "|"
	content := "| h | h |\n| - | - |\n" + row
	assert.Equal(t, content, wrapMarkdown(content), "GFM tables are never wrapped")
}

func TestWrapMarkdown_LeavesBlockquoteVerbatim(t *testing.T) {
	content := "> " + strings.Repeat("word ", 30) + "end"
	require.Greater(t, longestLine(content), wrapWidth)
	assert.Equal(t, content, wrapMarkdown(content), "blockquote lines keep their prefix untouched")
}

func TestWrapMarkdown_LeavesListItemVerbatim(t *testing.T) {
	content := "- " + strings.Repeat("word ", 30) + "end"
	require.Greater(t, longestLine(content), wrapWidth)
	assert.Equal(t, content, wrapMarkdown(content), "list items keep their marker/indent untouched")
}

func TestWrapMarkdown_DoesNotBreakBeforeBlockMarkers(t *testing.T) {
	// Every token that could start a block sits right at the wrap point; the
	// wrapper must not put it at the start of a new line.
	cases := []string{"-", "*", "+", "#", "##", ">", ">quote", "---", "***", "===", "___", "~~~", "1.", "2)", "|cell", "<div>"}
	for _, marker := range cases {
		// 78 chars of filler, a space, then the marker: a greedy break would put
		// the marker on its own new line.
		content := strings.Repeat("a", 78) + " " + marker + " tail words here"
		out := wrapMarkdown(content)
		for line := range strings.SplitSeq(out, "\n") {
			assert.NotEqual(t, marker, firstToken(line),
				"marker %q must not begin a continuation line (line=%q)", marker, line)
		}
	}
}

func TestWrapMarkdown_BreaksBeforeSafeTokens(t *testing.T) {
	// Hashtags and emphasis are safe line starts and must not block wrapping.
	content := strings.Repeat("a", 78) + " #hashtag more words to force a wrap here please"
	out := wrapMarkdown(content)
	assert.LessOrEqual(t, longestLine(out), wrapWidth)
	assert.Contains(t, out, "#hashtag", "hashtag preserved")
}

func TestWrapMarkdown_PreservesHardBreak(t *testing.T) {
	// A line ending in two spaces is a hard break; wrapping must keep it.
	content := strings.Repeat("word ", 30) + "end  \nnext paragraph line"
	out := wrapMarkdown(content)
	assert.Contains(t, out, "end  \n", "trailing hard-break spaces are preserved")
}

func TestWrapMarkdown_PreservesSoftBreakStructureAndTrailingNewline(t *testing.T) {
	content := "short line one\nshort line two\n"
	assert.Equal(t, content, wrapMarkdown(content), "existing short lines and trailing newline are untouched")
}

func TestWrapMarkdown_Empty(t *testing.T) {
	assert.Equal(t, "", wrapMarkdown(""))
}

// firstToken returns the first whitespace-delimited token of a line, or "".
func firstToken(line string) string {
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}
