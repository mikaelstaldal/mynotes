package repository

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"

	"github.com/mikaelstaldal/mynotes/internal/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file::memory:?cache=shared&_pragma=foreign_keys(on)")
	require.NoError(t, err)
	db.SetMaxOpenConns(1) // keep the shared in-memory DB alive for the whole test
	require.NoError(t, InitSchema(db))
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func ptr(s string) *string { return &s }

func TestNoteCRUD(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	created, err := repo.Create(ctx, "hello", "Hello", "world")
	require.NoError(t, err)
	assert.NotZero(t, created.ID)
	assert.Equal(t, "hello", created.Slug)
	assert.Equal(t, "Hello", created.Title)
	assert.Equal(t, "world", created.Content)
	assert.False(t, created.CreatedAt.IsZero())
	assert.Equal(t, 1, created.Version, "new note starts at version 1")

	got, err := repo.GetBySlug(ctx, "hello")
	require.NoError(t, err)
	assert.Equal(t, created.ID, got.ID)
	assert.Equal(t, "Hello", got.Title)

	// Title-only update leaves content and slug unchanged.
	updated, err := repo.Update(ctx, "hello", ptr("Updated"), nil, nil, nil)
	require.NoError(t, err)
	assert.Equal(t, "Updated", updated.Title)
	assert.Equal(t, "world", updated.Content, "content left unchanged when nil")
	assert.Equal(t, "hello", updated.Slug, "slug left unchanged when nil")
	assert.Equal(t, 2, updated.Version, "first update bumps version to 2")

	require.NoError(t, repo.Delete(ctx, "hello"))
	_, err = repo.GetBySlug(ctx, "hello")
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestVersionIncrementsPerUpdate(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	n, err := repo.Create(ctx, "v-note", "V", "")
	require.NoError(t, err)
	assert.Equal(t, 1, n.Version)

	n2, err := repo.Update(ctx, "v-note", ptr("V2"), nil, nil, nil)
	require.NoError(t, err)
	assert.Equal(t, 2, n2.Version)

	n3, err := repo.Update(ctx, "v-note", nil, ptr("new content"), nil, nil)
	require.NoError(t, err)
	assert.Equal(t, 3, n3.Version)
}

func TestListIncludesVersion(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	_, err := repo.Create(ctx, "note-a", "A", "body")
	require.NoError(t, err)

	notes, _, err := repo.List(ctx, "", "", false, "updated", "desc", 50, 0)
	require.NoError(t, err)
	require.Len(t, notes, 1)
	assert.Equal(t, 1, notes[0].Version)
}

func TestGetMissingReturnsNotFound(t *testing.T) {
	repo := NewNoteRepository(newTestDB(t))
	_, err := repo.GetBySlug(context.Background(), "nope")
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestUpdateMissingReturnsNotFound(t *testing.T) {
	repo := NewNoteRepository(newTestDB(t))
	_, err := repo.Update(context.Background(), "nope", ptr("x"), nil, nil, nil)
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestDeleteMissingReturnsNotFound(t *testing.T) {
	repo := NewNoteRepository(newTestDB(t))
	err := repo.Delete(context.Background(), "nope")
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestSlugRename(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	_, err := repo.Create(ctx, "old-slug", "Title", "body")
	require.NoError(t, err)

	// Rename writes the new slug onto the resolved id in the same UPDATE.
	renamed, err := repo.Update(ctx, "old-slug", nil, nil, ptr("new-slug"), nil)
	require.NoError(t, err)
	assert.Equal(t, "new-slug", renamed.Slug)
	assert.Equal(t, "Title", renamed.Title)

	_, err = repo.GetBySlug(ctx, "old-slug")
	assert.ErrorIs(t, err, ErrNotFound)
	got, err := repo.GetBySlug(ctx, "new-slug")
	require.NoError(t, err)
	assert.Equal(t, "body", got.Content)
}

func TestSlugRenameConflictWritesNothing(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	_, err := repo.Create(ctx, "first", "First", "a")
	require.NoError(t, err)
	_, err = repo.Create(ctx, "second", "Second", "b")
	require.NoError(t, err)

	// Renaming "second" onto the taken slug "first" must fail and write nothing
	// (UNIQUE constraint trips the single UPDATE statement).
	_, err = repo.Update(ctx, "second", ptr("Changed"), nil, ptr("first"), nil)
	require.Error(t, err)

	unchanged, err := repo.GetBySlug(ctx, "second")
	require.NoError(t, err)
	assert.Equal(t, "Second", unchanged.Title, "title not written when slug conflicts")
	assert.Equal(t, "second", unchanged.Slug)
}

func TestCreateDuplicateSlugRejected(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	_, err := repo.Create(ctx, "dup", "First", "a")
	require.NoError(t, err)

	// The UNIQUE constraint on slug is the authority: a second insert with the
	// same slug must fail and leave the original row untouched.
	_, err = repo.Create(ctx, "dup", "Second", "b")
	require.Error(t, err)

	got, err := repo.GetBySlug(ctx, "dup")
	require.NoError(t, err)
	assert.Equal(t, "First", got.Title, "original row not overwritten by the rejected insert")
}

func TestSlugExists(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	created, err := repo.Create(ctx, "taken", "T", "x")
	require.NoError(t, err)

	exists, err := repo.SlugExists(ctx, "taken", 0)
	require.NoError(t, err)
	assert.True(t, exists)

	exists, err = repo.SlugExists(ctx, "free", 0)
	require.NoError(t, err)
	assert.False(t, exists)

	// Excluding the note's own row makes its slug not count as a conflict.
	exists, err = repo.SlugExists(ctx, "taken", created.ID)
	require.NoError(t, err)
	assert.False(t, exists)
}

func TestListBrowseOrderingAndTotal(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	// Timestamps are second-granular, so within a test these share updated_at and
	// the browse order is driven by the `id DESC` tiebreak: newest row first.
	_, err := repo.Create(ctx, "first", "First", "one")
	require.NoError(t, err)
	_, err = repo.Create(ctx, "second", "Second", "two")
	require.NoError(t, err)
	_, err = repo.Create(ctx, "third", "Third", "three")
	require.NoError(t, err)

	notes, total, err := repo.List(ctx, "", "", false, "updated", "desc", 50, 0)
	require.NoError(t, err)
	assert.Equal(t, 3, total)
	require.Len(t, notes, 3)
	assert.Equal(t, []string{"third", "second", "first"},
		[]string{notes[0].Slug, notes[1].Slug, notes[2].Slug}, "newest id first")

	// total is independent of limit/offset.
	page, total, err := repo.List(ctx, "", "", false, "updated", "desc", 1, 1)
	require.NoError(t, err)
	assert.Equal(t, 3, total)
	require.Len(t, page, 1)
	assert.Equal(t, "second", page[0].Slug, "offset into the id-DESC order")
}

func TestListBrowseSort(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	// Insertion order (id ASC) deliberately differs from title order so the
	// title sort cannot accidentally pass on the id tiebreak alone.
	_, err := repo.Create(ctx, "banana", "Banana", "b")
	require.NoError(t, err)
	_, err = repo.Create(ctx, "apple", "apple", "a") // lowercase: NOCASE collation
	require.NoError(t, err)
	_, err = repo.Create(ctx, "cherry", "Cherry", "c")
	require.NoError(t, err)

	slugs := func(notes []model.NoteSummary) []string {
		out := make([]string, len(notes))
		for i, n := range notes {
			out[i] = n.Slug
		}
		return out
	}

	asc, _, err := repo.List(ctx, "", "", false, "title", "asc", 50, 0)
	require.NoError(t, err)
	assert.Equal(t, []string{"apple", "banana", "cherry"}, slugs(asc), "title A→Z, case-insensitive")

	desc, _, err := repo.List(ctx, "", "", false, "title", "desc", 50, 0)
	require.NoError(t, err)
	assert.Equal(t, []string{"cherry", "banana", "apple"}, slugs(desc), "title Z→A")

	// created shares the second-granular timestamp within the test, so ordering
	// falls to the id tiebreak: ASC is insertion order, DESC is its reverse.
	createdAsc, _, err := repo.List(ctx, "", "", false, "created", "asc", 50, 0)
	require.NoError(t, err)
	assert.Equal(t, []string{"banana", "apple", "cherry"}, slugs(createdAsc), "created oldest first")

	// An unknown sort/order is normalized by the service; the repository falls
	// back to updated/DESC for anything unrecognized.
	fallback, _, err := repo.List(ctx, "", "", false, "bogus", "sideways", 50, 0)
	require.NoError(t, err)
	assert.Equal(t, []string{"cherry", "apple", "banana"}, slugs(fallback), "unknown → updated DESC (id tiebreak)")
}

func TestBrowseExcerptTruncation(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	short := "a short body"
	_, err := repo.Create(ctx, "short", "Short", short)
	require.NoError(t, err)

	// 50 words of "word" -> well over 200 runes; expect a truncated excerpt.
	long := strings.TrimSpace(strings.Repeat("word ", 60))
	_, err = repo.Create(ctx, "long", "Long", long)
	require.NoError(t, err)

	_, err = repo.Create(ctx, "empty", "Empty", "")
	require.NoError(t, err)

	bySlug := map[string]string{}
	notes, _, err := repo.List(ctx, "", "", false, "updated", "desc", 50, 0)
	require.NoError(t, err)
	for _, n := range notes {
		bySlug[n.Slug] = n.Excerpt
	}

	assert.Equal(t, short, bySlug["short"], "short content verbatim")
	assert.Equal(t, "", bySlug["empty"], "empty content -> empty excerpt")
	assert.True(t, strings.HasSuffix(bySlug["long"], "…"), "long content gets ellipsis")
	assert.LessOrEqual(t, len([]rune(bySlug["long"])), 201)
	assert.NotContains(t, strings.TrimSuffix(bySlug["long"], "…"), "  ",
		"cut at a word boundary, no dangling partial word handling artifacts")
}

func TestBrowseExcerptIgnoresRawHTML(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	svg := "<svg width=\"10\" height=\"10\">\n<text>not the excerpt</text>\n</svg>\n\nActual text paragraph."
	_, err := repo.Create(ctx, "svg-note", "SVG", svg)
	require.NoError(t, err)

	mathml := "<math>\n<mi>x</mi>\n</math>\n\nAnother real paragraph."
	_, err = repo.Create(ctx, "mathml-note", "MathML", mathml)
	require.NoError(t, err)

	div := "<div class=\"card\">\nignored HTML content\n</div>\nPlain text after a div."
	_, err = repo.Create(ctx, "div-note", "Div", div)
	require.NoError(t, err)

	voidTag := "<hr>\nText right after a void element."
	_, err = repo.Create(ctx, "void-note", "Void", voidTag)
	require.NoError(t, err)

	bySlug := map[string]string{}
	notes, _, err := repo.List(ctx, "", "", false, "updated", "desc", 50, 0)
	require.NoError(t, err)
	for _, n := range notes {
		bySlug[n.Slug] = n.Excerpt
	}

	assert.Equal(t, "Actual text paragraph.", bySlug["svg-note"])
	assert.Equal(t, "Another real paragraph.", bySlug["mathml-note"])
	assert.Equal(t, "Plain text after a div.", bySlug["div-note"])
	assert.Equal(t, "Text right after a void element.", bySlug["void-note"])
}

func TestBrowseExcerptSkipsGFMTables(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	table := "| Name | Age |\n| --- | --- |\n| Bob | 30 |\n| Sue | 25 |\n\nParagraph after the table."
	_, err := repo.Create(ctx, "table-note", "Table", table)
	require.NoError(t, err)

	aligned := "| A | B |\n|:---|---:|\n| 1 | 2 |\n\nAligned table paragraph."
	_, err = repo.Create(ctx, "aligned-note", "Aligned", aligned)
	require.NoError(t, err)

	// A bare "---" underline (no pipes) is not a table delimiter, so the
	// header text above it must NOT be skipped as if it were a table.
	setext := "Heading text\n---\n\nSetext paragraph."
	_, err = repo.Create(ctx, "setext-note", "Setext", setext)
	require.NoError(t, err)

	bySlug := map[string]string{}
	notes, _, err := repo.List(ctx, "", "", false, "updated", "desc", 50, 0)
	require.NoError(t, err)
	for _, n := range notes {
		bySlug[n.Slug] = n.Excerpt
	}

	assert.Equal(t, "Paragraph after the table.", bySlug["table-note"])
	assert.Equal(t, "Aligned table paragraph.", bySlug["aligned-note"])
	assert.Equal(t, "Heading text", bySlug["setext-note"])
}

func TestSearchMatchesAndSnippet(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	_, err := repo.Create(ctx, "quarterly-report", "Quarterly report", "revenue figures here")
	require.NoError(t, err)
	_, err = repo.Create(ctx, "grocery-list", "Grocery list", "milk and eggs")
	require.NoError(t, err)

	hits, total, err := repo.List(ctx, "revenue", "", false, "updated", "desc", 50, 0)
	require.NoError(t, err)
	assert.Equal(t, 1, total)
	require.Len(t, hits, 1)
	assert.Equal(t, "quarterly-report", hits[0].Slug)
	// Content match -> snippet carries the U+0002/U+0003 sentinels (raw, not HTML).
	assert.Contains(t, hits[0].Excerpt, "\x02", "start sentinel present")
	assert.Contains(t, hits[0].Excerpt, "\x03", "end sentinel present")
	assert.NotContains(t, hits[0].Excerpt, "<")
}

func TestSearchTitlePrefix(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	// "revenue" appears in one note's title and in another note's content only.
	_, err := repo.Create(ctx, "revenue-report", "Revenue report", "figures here")
	require.NoError(t, err)
	_, err = repo.Create(ctx, "grocery-list", "Grocery list", "revenue was a movie")
	require.NoError(t, err)

	// Default (whole-note) search matches both the title and the content note.
	all, total, err := repo.List(ctx, "revenue", "", false, "updated", "desc", 50, 0)
	require.NoError(t, err)
	assert.Equal(t, 2, total)
	assert.Len(t, all, 2)

	// Title-prefix search matches just the note whose title starts with the
	// term, case-insensitively.
	titleHits, total, err := repo.List(ctx, "revenue", "", true, "updated", "desc", 50, 0)
	require.NoError(t, err)
	assert.Equal(t, 1, total)
	require.Len(t, titleHits, 1)
	assert.Equal(t, "revenue-report", titleHits[0].Slug)

	// A partial prefix (mid-word) still matches from the start of the title.
	partial, total, err := repo.List(ctx, "Grocery l", "", true, "updated", "desc", 50, 0)
	require.NoError(t, err)
	assert.Equal(t, 1, total)
	require.Len(t, partial, 1)
	assert.Equal(t, "grocery-list", partial[0].Slug)

	// A term that appears only mid-title (not as a prefix) does not match,
	// unlike a full-text search.
	none, total, err := repo.List(ctx, "report", "", true, "updated", "desc", 50, 0)
	require.NoError(t, err)
	assert.Equal(t, 0, total)
	assert.Empty(t, none)
}

func TestSearchRankingOrder(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	// "strong" matches the term in its title and repeatedly in short content;
	// "weak" mentions it once buried in a long body. bm25 (notes_fts.rank)
	// must rank the dense, short document above the sparse, long one.
	_, err := repo.Create(ctx, "weak", "Other",
		"i once saw an apple in passing among many other padding words here to "+
			"lengthen this document considerably so its bm25 score is lower")
	require.NoError(t, err)
	_, err = repo.Create(ctx, "strong", "Apple", "apple apple apple")
	require.NoError(t, err)

	hits, total, err := repo.List(ctx, "apple", "", false, "updated", "desc", 50, 0)
	require.NoError(t, err)
	assert.Equal(t, 2, total)
	require.Len(t, hits, 2)
	assert.Equal(t, []string{"strong", "weak"},
		[]string{hits[0].Slug, hits[1].Slug}, "denser match ranks first")
}

func TestSearchTriggerSyncOnTitleUpdate(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	_, err := repo.Create(ctx, "note", "Aardvark", "body text")
	require.NoError(t, err)

	_, err = repo.Update(ctx, "note", ptr("Zeppelin"), nil, nil, nil)
	require.NoError(t, err)

	// The AFTER UPDATE trigger must reindex the title column too: the old title
	// is gone from the index and the new one is searchable.
	gone, _, err := repo.List(ctx, "Aardvark", "", false, "updated", "desc", 50, 0)
	require.NoError(t, err)
	assert.Empty(t, gone, "old title no longer indexed")

	found, _, err := repo.List(ctx, "Zeppelin", "", false, "updated", "desc", 50, 0)
	require.NoError(t, err)
	require.Len(t, found, 1)
	assert.Equal(t, "note", found[0].Slug)
}

func TestSearchEmptyContentMatchHasEmptyExcerpt(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	// Title match with no content: the snippet carries no sentinel, and the
	// plain-prefix fallback over empty content yields an empty excerpt.
	_, err := repo.Create(ctx, "pineapple", "Pineapple", "")
	require.NoError(t, err)

	hits, _, err := repo.List(ctx, "Pineapple", "", false, "updated", "desc", 50, 0)
	require.NoError(t, err)
	require.Len(t, hits, 1)
	assert.NotContains(t, hits[0].Excerpt, "\x02", "no content sentinel for a title-only match")
	assert.Equal(t, "", hits[0].Excerpt, "empty content -> empty excerpt")
}

func TestSearchTitleOnlyMatchFallsBackToPrefix(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	_, err := repo.Create(ctx, "widgets", "Widgets", "no match in body")
	require.NoError(t, err)

	hits, _, err := repo.List(ctx, "widgets", "", false, "updated", "desc", 50, 0)
	require.NoError(t, err)
	require.Len(t, hits, 1)
	// Title-only match: no content sentinel, so excerpt falls back to the prefix.
	assert.NotContains(t, hits[0].Excerpt, "\x02")
	assert.Equal(t, "no match in body", hits[0].Excerpt)
}

func TestSearchTitlePrefixTreatsWildcardsLiterally(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	_, err := repo.Create(ctx, "discount", "50% off sale", "body")
	require.NoError(t, err)
	_, err = repo.Create(ctx, "other", "Other note", "body")
	require.NoError(t, err)

	// A bare "%" must not act as a LIKE wildcard matching every title.
	none, total, err := repo.List(ctx, "%", "", true, "updated", "desc", 50, 0)
	require.NoError(t, err)
	assert.Equal(t, 0, total)
	assert.Empty(t, none)

	// A literal "%" in the prefix matches the title that actually contains it.
	hits, total, err := repo.List(ctx, "50%", "", true, "updated", "desc", 50, 0)
	require.NoError(t, err)
	assert.Equal(t, 1, total)
	require.Len(t, hits, 1)
	assert.Equal(t, "discount", hits[0].Slug)
}

func TestSearchTreatsInputAsLiteral(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	_, err := repo.Create(ctx, "report", "Quarterly report", "revenue figures")
	require.NoError(t, err)
	_, err = repo.Create(ctx, "grocery", "Grocery list", "milk and eggs")
	require.NoError(t, err)

	hits, _, err := repo.List(ctx, "report", "", false, "updated", "desc", 50, 0)
	require.NoError(t, err)
	require.Len(t, hits, 1)
	assert.Equal(t, "Quarterly report", hits[0].Title)

	// FTS operator keywords must be matched literally, not interpreted.
	none, total, err := repo.List(ctx, "report OR grocery", "", false, "updated", "desc", 50, 0)
	require.NoError(t, err)
	assert.Empty(t, none)
	assert.Equal(t, 0, total)
}

func TestSearchTriggerSyncOnUpdate(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	_, err := repo.Create(ctx, "note", "Title", "original text")
	require.NoError(t, err)

	_, err = repo.Update(ctx, "note", nil, ptr("replacement prose"), nil, nil)
	require.NoError(t, err)

	// The FTS index must reflect the new content (AFTER UPDATE trigger).
	gone, _, err := repo.List(ctx, "original", "", false, "updated", "desc", 50, 0)
	require.NoError(t, err)
	assert.Empty(t, gone, "old content no longer indexed")

	found, _, err := repo.List(ctx, "replacement", "", false, "updated", "desc", 50, 0)
	require.NoError(t, err)
	require.Len(t, found, 1)
	assert.Equal(t, "note", found[0].Slug)
}

// --- Tags --------------------------------------------------------------

func TestCreateWithTagsAttachesThem(t *testing.T) {
	ctx := context.Background()
	db := newTestDB(t)
	repo := NewNoteRepository(db)
	tagRepo := NewTagRepository(db)

	work, err := tagRepo.Create(ctx, "work", "Work")
	require.NoError(t, err)
	home, err := tagRepo.Create(ctx, "home", "Home")
	require.NoError(t, err)

	note, err := repo.CreateWithTime(ctx, "note", "Note", "body", time.Now().UTC(), []int64{work.ID, home.ID})
	require.NoError(t, err)
	require.Len(t, note.Tags, 2)
	slugs := []string{note.Tags[0].Slug, note.Tags[1].Slug}
	assert.ElementsMatch(t, []string{"work", "home"}, slugs)

	// GetBySlug independently re-fetches and attaches tags too.
	got, err := repo.GetBySlug(ctx, "note")
	require.NoError(t, err)
	require.Len(t, got.Tags, 2)
}

func TestCreateWithUnknownTagIDFails(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	_, err := repo.CreateWithTime(ctx, "note", "Note", "body", time.Now().UTC(), []int64{999})
	assert.ErrorIs(t, err, ErrUnknownTag)

	// The whole transaction rolled back: the note itself must not exist either.
	_, err = repo.GetBySlug(ctx, "note")
	assert.ErrorIs(t, err, ErrNotFound, "failed tag attachment must roll back the note insert too")
}

func TestUpdateTagsNilLeavesUnchanged(t *testing.T) {
	ctx := context.Background()
	db := newTestDB(t)
	repo := NewNoteRepository(db)
	tagRepo := NewTagRepository(db)

	tag, err := tagRepo.Create(ctx, "work", "Work")
	require.NoError(t, err)
	_, err = repo.CreateWithTime(ctx, "note", "Note", "body", time.Now().UTC(), []int64{tag.ID})
	require.NoError(t, err)

	updated, err := repo.Update(ctx, "note", ptr("Renamed"), nil, nil, nil)
	require.NoError(t, err)
	require.Len(t, updated.Tags, 1, "nil tagIDs leaves the tag set untouched")
	assert.Equal(t, "work", updated.Tags[0].Slug)
}

func TestUpdateTagsReplacesFullSet(t *testing.T) {
	ctx := context.Background()
	db := newTestDB(t)
	repo := NewNoteRepository(db)
	tagRepo := NewTagRepository(db)

	work, err := tagRepo.Create(ctx, "work", "Work")
	require.NoError(t, err)
	home, err := tagRepo.Create(ctx, "home", "Home")
	require.NoError(t, err)
	_, err = repo.CreateWithTime(ctx, "note", "Note", "body", time.Now().UTC(), []int64{work.ID})
	require.NoError(t, err)

	updated, err := repo.Update(ctx, "note", nil, nil, nil, &[]int64{home.ID})
	require.NoError(t, err)
	require.Len(t, updated.Tags, 1)
	assert.Equal(t, "home", updated.Tags[0].Slug, "full replace: work is gone, home is attached")
}

func TestUpdateTagsEmptySliceClears(t *testing.T) {
	ctx := context.Background()
	db := newTestDB(t)
	repo := NewNoteRepository(db)
	tagRepo := NewTagRepository(db)

	tag, err := tagRepo.Create(ctx, "work", "Work")
	require.NoError(t, err)
	_, err = repo.CreateWithTime(ctx, "note", "Note", "body", time.Now().UTC(), []int64{tag.ID})
	require.NoError(t, err)

	updated, err := repo.Update(ctx, "note", nil, nil, nil, &[]int64{})
	require.NoError(t, err)
	assert.Empty(t, updated.Tags)
}

func TestDeleteNoteDetachesTagsViaCascade(t *testing.T) {
	ctx := context.Background()
	db := newTestDB(t)
	repo := NewNoteRepository(db)
	tagRepo := NewTagRepository(db)

	tag, err := tagRepo.Create(ctx, "work", "Work")
	require.NoError(t, err)
	_, err = repo.CreateWithTime(ctx, "note", "Note", "body", time.Now().UTC(), []int64{tag.ID})
	require.NoError(t, err)

	require.NoError(t, repo.Delete(ctx, "note"))

	// The tag itself must survive; only the junction row is gone.
	_, err = tagRepo.GetBySlug(ctx, "work")
	assert.NoError(t, err)
}

func TestDeleteTagDetachesFromNoteViaCascade(t *testing.T) {
	ctx := context.Background()
	db := newTestDB(t)
	repo := NewNoteRepository(db)
	tagRepo := NewTagRepository(db)

	tag, err := tagRepo.Create(ctx, "work", "Work")
	require.NoError(t, err)
	_, err = repo.CreateWithTime(ctx, "note", "Note", "body", time.Now().UTC(), []int64{tag.ID})
	require.NoError(t, err)

	require.NoError(t, tagRepo.Delete(ctx, "work"))

	got, err := repo.GetBySlug(ctx, "note")
	require.NoError(t, err)
	assert.Empty(t, got.Tags)
}

func TestListFilteredByTag(t *testing.T) {
	ctx := context.Background()
	db := newTestDB(t)
	repo := NewNoteRepository(db)
	tagRepo := NewTagRepository(db)

	work, err := tagRepo.Create(ctx, "work", "Work")
	require.NoError(t, err)
	home, err := tagRepo.Create(ctx, "home", "Home")
	require.NoError(t, err)

	_, err = repo.CreateWithTime(ctx, "report", "Report", "a", time.Now().UTC(), []int64{work.ID})
	require.NoError(t, err)
	_, err = repo.CreateWithTime(ctx, "chores", "Chores", "b", time.Now().UTC(), []int64{home.ID})
	require.NoError(t, err)
	_, err = repo.CreateWithTime(ctx, "both", "Both", "c", time.Now().UTC(), []int64{work.ID, home.ID})
	require.NoError(t, err)

	notes, total, err := repo.List(ctx, "", "work", false, "updated", "desc", 50, 0)
	require.NoError(t, err)
	assert.Equal(t, 2, total)
	slugs := []string{notes[0].Slug, notes[1].Slug}
	assert.ElementsMatch(t, []string{"report", "both"}, slugs)
}

func TestSearchFilteredByTag(t *testing.T) {
	ctx := context.Background()
	db := newTestDB(t)
	repo := NewNoteRepository(db)
	tagRepo := NewTagRepository(db)

	work, err := tagRepo.Create(ctx, "work", "Work")
	require.NoError(t, err)
	home, err := tagRepo.Create(ctx, "home", "Home")
	require.NoError(t, err)

	_, err = repo.CreateWithTime(ctx, "report", "Report", "quarterly revenue figures", time.Now().UTC(), []int64{work.ID})
	require.NoError(t, err)
	_, err = repo.CreateWithTime(ctx, "chores", "Chores", "quarterly cleanup list", time.Now().UTC(), []int64{home.ID})
	require.NoError(t, err)

	hits, total, err := repo.List(ctx, "quarterly", "work", false, "updated", "desc", 50, 0)
	require.NoError(t, err)
	assert.Equal(t, 1, total)
	require.Len(t, hits, 1)
	assert.Equal(t, "report", hits[0].Slug, "tag filter combines with the FTS query via AND")
}
