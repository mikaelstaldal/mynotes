package repository

import (
	"reflect"
	"testing"
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
