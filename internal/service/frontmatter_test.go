package service

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// mustDate parses a "2006-01-02" string and panics on failure — test helper only.
func mustDate(s string) time.Time {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		panic(err)
	}
	return t
}

// mustRFC3339 parses an RFC3339 string and panics on failure — test helper only.
func mustRFC3339(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestParseFrontmatter(t *testing.T) {
	cases := []struct {
		name      string
		input     string
		wantTitle string
		wantSlug  string
		wantDate  time.Time // zero means "not expected"
		wantBody  string
	}{
		// --- YAML ---
		{
			name:      "yaml title only",
			input:     "---\ntitle: My Note\ndate: 2024-01-01\n---\n\nBody here.",
			wantTitle: "My Note",
			wantDate:  mustDate("2024-01-01"),
			wantBody:  "\nBody here.",
		},
		{
			name:      "yaml with slug",
			input:     "---\ntitle: Hello\nslug: custom-slug\n---\nBody.",
			wantTitle: "Hello",
			wantSlug:  "custom-slug",
			wantBody:  "Body.",
		},
		{
			name:      "yaml datetime rfc3339",
			input:     "---\ntitle: T\ndate: 2024-06-15T10:30:00Z\n---\n",
			wantTitle: "T",
			wantDate:  mustRFC3339("2024-06-15T10:30:00Z"),
			wantBody:  "",
		},
		{
			name:     "yaml no title field",
			input:    "---\ndate: 2024-01-01\n---\n\nBody here.",
			wantDate: mustDate("2024-01-01"),
			wantBody: "\nBody here.",
		},
		{
			name:     "yaml empty frontmatter",
			input:    "---\n---\nBody.",
			wantBody: "Body.",
		},
		{
			name:      "yaml closing delimiter at eof",
			input:     "---\ntitle: Title Only\n---",
			wantTitle: "Title Only",
			wantBody:  "",
		},
		{
			name:      "yaml crlf line endings",
			input:     "---\r\ntitle: CRLF\r\n---\r\nBody.",
			wantTitle: "CRLF",
			wantBody:  "Body.",
		},

		// --- TOML ---
		{
			name:      "toml double-quoted title and slug",
			input:     "+++\ntitle = \"TOML Note\"\nslug = \"toml-slug\"\n+++\n\nBody.",
			wantTitle: "TOML Note",
			wantSlug:  "toml-slug",
			wantBody:  "\nBody.",
		},
		{
			name:      "toml single-quoted title",
			input:     "+++\ntitle = 'Single Quoted'\n+++\nBody.",
			wantTitle: "Single Quoted",
			wantBody:  "Body.",
		},
		{
			name:      "toml bare date",
			input:     "+++\ntitle = \"T\"\ndate = 2024-03-10\n+++\n",
			wantTitle: "T",
			wantDate:  mustDate("2024-03-10"),
			wantBody:  "",
		},
		{
			name:      "toml bare datetime",
			input:     "+++\ntitle = \"T\"\ndate = 2024-03-10T08:00:00Z\n+++\n",
			wantTitle: "T",
			wantDate:  mustRFC3339("2024-03-10T08:00:00Z"),
			wantBody:  "",
		},
		{
			name:      "toml quoted date string",
			input:     "+++\ntitle = \"T\"\ndate = \"2024-03-10\"\n+++\n",
			wantTitle: "T",
			wantDate:  mustDate("2024-03-10"),
			wantBody:  "",
		},
		{
			name:     "toml no title field",
			input:    "+++\nauthor = \"me\"\n+++\nBody.",
			wantBody: "Body.",
		},
		{
			name:      "toml closing delimiter at eof",
			input:     "+++\ntitle = \"EOF\"\n+++",
			wantTitle: "EOF",
			wantBody:  "",
		},

		// --- JSON ---
		{
			name:      "json with title slug date",
			input:     "{\n  \"title\": \"JSON Note\",\n  \"slug\": \"json-slug\",\n  \"date\": \"2024-05-20\"\n}\n\nBody.",
			wantTitle: "JSON Note",
			wantSlug:  "json-slug",
			wantDate:  mustDate("2024-05-20"),
			wantBody:  "Body.",
		},
		{
			name:      "json datetime rfc3339",
			input:     "{\"title\":\"T\",\"date\":\"2024-05-20T12:00:00Z\"}\n\nBody.",
			wantTitle: "T",
			wantDate:  mustRFC3339("2024-05-20T12:00:00Z"),
			wantBody:  "Body.",
		},
		{
			name:     "json no title field",
			input:    "{\"tags\": [\"a\"]}\n\nBody.",
			wantBody: "Body.",
		},
		{
			name:      "json no trailing body",
			input:     "{\"title\": \"Only FM\"}",
			wantTitle: "Only FM",
			wantBody:  "",
		},

		// --- No frontmatter ---
		{
			name:     "plain markdown no frontmatter",
			input:    "# Heading\n\nParagraph.",
			wantBody: "# Heading\n\nParagraph.",
		},
		{
			name:     "dash line not closed",
			input:    "---\ntitle: Unclosed\n\nNo closing delimiter.",
			wantBody: "---\ntitle: Unclosed\n\nNo closing delimiter.",
		},
		{
			name:     "triple-dash not at line boundary",
			input:    "--- extra\ntitle: No\n---\nBody.",
			wantBody: "--- extra\ntitle: No\n---\nBody.",
		},
		{
			name:     "empty content",
			input:    "",
			wantBody: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fm, gotBody := parseFrontmatter(tc.input)
			assert.Equal(t, tc.wantTitle, fm.Title, "title")
			assert.Equal(t, tc.wantSlug, fm.Slug, "slug")
			assert.Equal(t, tc.wantBody, gotBody, "body")
			if tc.wantDate.IsZero() {
				assert.True(t, fm.Date.IsZero(), "date should be zero")
			} else {
				assert.True(t, tc.wantDate.Equal(fm.Date), "date: want %v got %v", tc.wantDate, fm.Date)
			}
		})
	}
}

func TestImportMarkdown_FrontmatterFields(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	t.Run("yaml title over atx heading", func(t *testing.T) {
		md := "---\ntitle: Frontmatter Title\n---\n\n# ATX Heading\n\nContent."
		note, err := svc.ImportMarkdown(ctx, md)
		require.NoError(t, err)
		assert.Equal(t, "Frontmatter Title", note.Title)
		assert.Equal(t, "\n# ATX Heading\n\nContent.", note.Content)
	})

	t.Run("yaml date sets created_at", func(t *testing.T) {
		md := "---\ntitle: Dated Note\ndate: 2022-03-15\n---\nContent."
		note, err := svc.ImportMarkdown(ctx, md)
		require.NoError(t, err)
		assert.Equal(t, 2022, note.CreatedAt.Year())
		assert.Equal(t, time.Month(3), note.CreatedAt.Month())
		assert.Equal(t, 15, note.CreatedAt.Day())
	})

	t.Run("yaml slug used verbatim", func(t *testing.T) {
		md := "---\ntitle: Slug Test\nslug: explicit-slug\n---\nContent."
		note, err := svc.ImportMarkdown(ctx, md)
		require.NoError(t, err)
		assert.Equal(t, "explicit-slug", note.Slug)
	})

	t.Run("toml title slug date", func(t *testing.T) {
		md := "+++\ntitle = \"TOML\"\nslug = \"toml-note\"\ndate = 2023-07-04\n+++\nContent."
		note, err := svc.ImportMarkdown(ctx, md)
		require.NoError(t, err)
		assert.Equal(t, "TOML", note.Title)
		assert.Equal(t, "toml-note", note.Slug)
		assert.Equal(t, 2023, note.CreatedAt.Year())
	})

	t.Run("json title slug date", func(t *testing.T) {
		md := "{\"title\":\"JSON\",\"slug\":\"json-note\",\"date\":\"2021-12-31\"}\nContent."
		note, err := svc.ImportMarkdown(ctx, md)
		require.NoError(t, err)
		assert.Equal(t, "JSON", note.Title)
		assert.Equal(t, "json-note", note.Slug)
		assert.Equal(t, 2021, note.CreatedAt.Year())
	})

	t.Run("no frontmatter falls back to atx heading and current time", func(t *testing.T) {
		before := time.Now().Add(-time.Second)
		md := "# ATX Heading\n\nContent."
		note, err := svc.ImportMarkdown(ctx, md)
		require.NoError(t, err)
		assert.Equal(t, "ATX Heading", note.Title)
		assert.True(t, note.CreatedAt.After(before), "created_at should be near now")
	})

	t.Run("frontmatter stripped from stored content", func(t *testing.T) {
		md := "---\ntitle: Stripped\n---\nJust content."
		note, err := svc.ImportMarkdown(ctx, md)
		require.NoError(t, err)
		assert.Equal(t, "Stripped", note.Title)
		assert.Equal(t, "Just content.", note.Content)
	})

	t.Run("invalid frontmatter slug is validation error", func(t *testing.T) {
		md := "---\ntitle: Bad Slug\nslug: Bad Slug!\n---\nContent."
		_, err := svc.ImportMarkdown(ctx, md)
		assert.ErrorIs(t, err, ErrValidation)
	})

	t.Run("duplicate frontmatter slug is conflict", func(t *testing.T) {
		md := "---\ntitle: First\nslug: conflict-slug\n---\nContent."
		_, err := svc.ImportMarkdown(ctx, md)
		require.NoError(t, err)

		md2 := "---\ntitle: Second\nslug: conflict-slug\n---\nContent."
		_, err = svc.ImportMarkdown(ctx, md2)
		assert.ErrorIs(t, err, ErrConflict)
	})
}
