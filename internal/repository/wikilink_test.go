package repository

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// TestExtractNoteLinks locks in that extraction matches the frontend renderer:
// wikilinks in prose (including table cells and around strikethrough) are
// indexed, while wikilinks inside code spans/blocks, tag links, and
// self-references are not.
func TestExtractNoteLinks(t *testing.T) {
	cases := []struct {
		name    string
		content string
		own     string
		want    []string
	}{
		{"prose note links", "see [[alpha]] and [[beta|B]]", "self", []string{"alpha", "beta"}},
		{"tag link skipped", "a [[#work]] tag", "self", nil},
		{"self reference skipped", "ref to [[self]]", "self", nil},
		{"deduped, first-seen order", "[[beta]] then [[alpha]] then [[beta]]", "self", []string{"beta", "alpha"}},
		{"inline code span excluded", "text `[[incode]]` more", "self", nil},
		{"fenced code block excluded", "```\n[[fenced]]\n```\n", "self", nil},
		{"indented code block excluded", "    [[indented]]\n", "self", nil},
		{"table cell included", "| h |\n| --- |\n| [[intable]] |\n", "self", []string{"intable"}},
		{"strikethrough included", "~~[[strike]]~~", "self", []string{"strike"}},
		{"invalid slug left literal", "not [[Bad Slug]] here", "self", nil},
		{"label with note link", "[[alpha|My Label]]", "self", []string{"alpha"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := extractNoteLinks(c.content, c.own)
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("extractNoteLinks(%q) = %v, want %v", c.content, got, c.want)
			}
		})
	}
}

func TestExtractNoteLinksAdversarial(t *testing.T) {
	for _, unit := range []string{"[", "[[a|", "[[a", "[[a-"} {
		t.Run(unit, func(t *testing.T) {
			content := strings.Repeat(unit, 1_000_000/len(unit))
			start := time.Now()
			require.Empty(t, extractNoteLinks(content, "self"))
			require.Less(t, time.Since(start), 3*time.Second)
		})
	}
}

func TestExtractNoteLinksBounds(t *testing.T) {
	slug := strings.Repeat("a", 100)
	label := strings.Repeat("😀", 256)
	require.Equal(t, []string{slug}, extractNoteLinks("[["+slug+"|"+label+"]]", "self"))
	require.Empty(t, extractNoteLinks("[["+slug+"a]]", "self"))
	require.Empty(t, extractNoteLinks("[[a|"+label+"界]]", "self"))
	require.Equal(t, []string{"ok"}, extractNoteLinks("[[a|"+label+"界]] [[ok]]", "self"))
}

// Nearby closing delimiters must not force every incomplete label through the regexp.
func TestExtractNoteLinksAdversarialClosingDelimiters(t *testing.T) {
	unit := "[[" + strings.Repeat("[[a|", 260) + "]]"
	content := strings.Repeat(unit, 1_000_000/len(unit))
	start := time.Now()
	require.Empty(t, extractNoteLinks(content, "a"))
	require.Less(t, time.Since(start), 3*time.Second)
}

func TestExtractNoteLinksMalformedDelimiter(t *testing.T) {
	for _, content := range []string{"[[a|label] more]] [[ok]]", "[[a|label\nmore]] [[ok]]"} {
		require.Equal(t, []string{"ok"}, extractNoteLinks(content, "self"))
	}
}
