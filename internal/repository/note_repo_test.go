package repository

import (
	"context"
	"database/sql"
	"strings"
	"testing"

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
	updated, err := repo.Update(ctx, "hello", ptr("Updated"), nil, nil)
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

	n2, err := repo.Update(ctx, "v-note", ptr("V2"), nil, nil)
	require.NoError(t, err)
	assert.Equal(t, 2, n2.Version)

	n3, err := repo.Update(ctx, "v-note", nil, ptr("new content"), nil)
	require.NoError(t, err)
	assert.Equal(t, 3, n3.Version)
}

func TestListIncludesVersion(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	_, err := repo.Create(ctx, "note-a", "A", "body")
	require.NoError(t, err)

	notes, _, err := repo.List(ctx, "", 50, 0)
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
	_, err := repo.Update(context.Background(), "nope", ptr("x"), nil, nil)
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
	renamed, err := repo.Update(ctx, "old-slug", nil, nil, ptr("new-slug"))
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
	_, err = repo.Update(ctx, "second", ptr("Changed"), nil, ptr("first"))
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

	notes, total, err := repo.List(ctx, "", 50, 0)
	require.NoError(t, err)
	assert.Equal(t, 3, total)
	require.Len(t, notes, 3)
	assert.Equal(t, []string{"third", "second", "first"},
		[]string{notes[0].Slug, notes[1].Slug, notes[2].Slug}, "newest id first")

	// total is independent of limit/offset.
	page, total, err := repo.List(ctx, "", 1, 1)
	require.NoError(t, err)
	assert.Equal(t, 3, total)
	require.Len(t, page, 1)
	assert.Equal(t, "second", page[0].Slug, "offset into the id-DESC order")
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
	notes, _, err := repo.List(ctx, "", 50, 0)
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

func TestSearchMatchesAndSnippet(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	_, err := repo.Create(ctx, "quarterly-report", "Quarterly report", "revenue figures here")
	require.NoError(t, err)
	_, err = repo.Create(ctx, "grocery-list", "Grocery list", "milk and eggs")
	require.NoError(t, err)

	hits, total, err := repo.List(ctx, "revenue", 50, 0)
	require.NoError(t, err)
	assert.Equal(t, 1, total)
	require.Len(t, hits, 1)
	assert.Equal(t, "quarterly-report", hits[0].Slug)
	// Content match -> snippet carries the U+0002/U+0003 sentinels (raw, not HTML).
	assert.Contains(t, hits[0].Excerpt, "\x02", "start sentinel present")
	assert.Contains(t, hits[0].Excerpt, "\x03", "end sentinel present")
	assert.NotContains(t, hits[0].Excerpt, "<")
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

	hits, total, err := repo.List(ctx, "apple", 50, 0)
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

	_, err = repo.Update(ctx, "note", ptr("Zeppelin"), nil, nil)
	require.NoError(t, err)

	// The AFTER UPDATE trigger must reindex the title column too: the old title
	// is gone from the index and the new one is searchable.
	gone, _, err := repo.List(ctx, "Aardvark", 50, 0)
	require.NoError(t, err)
	assert.Empty(t, gone, "old title no longer indexed")

	found, _, err := repo.List(ctx, "Zeppelin", 50, 0)
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

	hits, _, err := repo.List(ctx, "Pineapple", 50, 0)
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

	hits, _, err := repo.List(ctx, "widgets", 50, 0)
	require.NoError(t, err)
	require.Len(t, hits, 1)
	// Title-only match: no content sentinel, so excerpt falls back to the prefix.
	assert.NotContains(t, hits[0].Excerpt, "\x02")
	assert.Equal(t, "no match in body", hits[0].Excerpt)
}

func TestSearchTreatsInputAsLiteral(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	_, err := repo.Create(ctx, "report", "Quarterly report", "revenue figures")
	require.NoError(t, err)
	_, err = repo.Create(ctx, "grocery", "Grocery list", "milk and eggs")
	require.NoError(t, err)

	hits, _, err := repo.List(ctx, "report", 50, 0)
	require.NoError(t, err)
	require.Len(t, hits, 1)
	assert.Equal(t, "Quarterly report", hits[0].Title)

	// FTS operator keywords must be matched literally, not interpreted.
	none, total, err := repo.List(ctx, "report OR grocery", 50, 0)
	require.NoError(t, err)
	assert.Empty(t, none)
	assert.Equal(t, 0, total)
}

func TestSearchTriggerSyncOnUpdate(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	_, err := repo.Create(ctx, "note", "Title", "original text")
	require.NoError(t, err)

	_, err = repo.Update(ctx, "note", nil, ptr("replacement prose"), nil)
	require.NoError(t, err)

	// The FTS index must reflect the new content (AFTER UPDATE trigger).
	gone, _, err := repo.List(ctx, "original", 50, 0)
	require.NoError(t, err)
	assert.Empty(t, gone, "old content no longer indexed")

	found, _, err := repo.List(ctx, "replacement", 50, 0)
	require.NoError(t, err)
	require.Len(t, found, 1)
	assert.Equal(t, "note", found[0].Slug)
}
