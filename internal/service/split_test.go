package service

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mikaelstaldal/mynotes/internal/repository"
)

// fence returns a triple-backtick fence line; kept as a helper so the test
// source can embed fenced code blocks without Go raw-string backtick trouble.
const fence = "```"

// contentOf fetches a note's full Markdown by slug. Split returns summaries
// (no content), so content-correctness assertions re-read the stored note.
func contentOf(t *testing.T, svc *NoteService, slug string) string {
	t.Helper()
	n, err := svc.Get(context.Background(), slug)
	require.NoError(t, err)
	return n.Content
}

func TestSplit_ShallowestLevelKeepsSubsectionsNested(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	content := "Some preamble before any heading.\n\n" +
		"## Section A\n\nText under A.\n\n" +
		"### Sub A1\n\nNested content.\n\n" +
		"## Section B\n\nText under B.\n"
	orig, err := svc.Create(ctx, "Original", ptr(content), nil, nil)
	require.NoError(t, err)

	notes, err := svc.Split(ctx, orig.Slug, nil)
	require.NoError(t, err)
	require.Len(t, notes, 2, "split at the shallowest level (##), not the ### subheading")

	assert.Equal(t, "Section A", notes[0].Title)
	assert.Equal(t, "Section B", notes[1].Title)

	// The summary carries an excerpt (first non-heading line), not full content.
	assert.Equal(t, "Text under A.", notes[0].Excerpt)

	contentA := contentOf(t, svc, notes[0].Slug)
	contentB := contentOf(t, svc, notes[1].Slug)
	// The ### subsection stays nested inside its parent (Section A).
	assert.Contains(t, contentA, "### Sub A1")
	assert.Contains(t, contentA, "Nested content.")
	assert.Contains(t, contentB, "Text under B.")

	// Preamble is discarded from every produced note.
	assert.NotContains(t, contentA, "Some preamble")
	assert.NotContains(t, contentB, "Some preamble")

	// Every new note shares the original's created_at.
	for _, n := range notes {
		assert.True(t, orig.CreatedAt.Equal(n.CreatedAt), "new note keeps the original created_at")
	}
}

func TestSplit_IgnoresHeadingsInsideCodeFences(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	content := "# First\n\ntext\n\n" +
		fence + "\n# Not a heading\n" + fence + "\n\n" +
		"# Second\n\nmore\n"
	orig, err := svc.Create(ctx, "Original", ptr(content), nil, nil)
	require.NoError(t, err)

	notes, err := svc.Split(ctx, orig.Slug, nil)
	require.NoError(t, err)
	require.Len(t, notes, 2, "the # inside the code fence is not a split boundary")

	assert.Equal(t, "First", notes[0].Title)
	assert.Equal(t, "Second", notes[1].Title)
	// The fenced pseudo-heading stays with its section content, verbatim.
	assert.Contains(t, contentOf(t, svc, notes[0].Slug), "# Not a heading")
}

func TestSplit_PreambleOnlyBeforeFirstHeadingDiscarded(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	content := "intro line one\nintro line two\n\n## Only Section\n\nbody\n"
	orig, err := svc.Create(ctx, "Original", ptr(content), nil, nil)
	require.NoError(t, err)

	notes, err := svc.Split(ctx, orig.Slug, nil)
	require.NoError(t, err)
	require.Len(t, notes, 1)
	assert.Equal(t, "Only Section", notes[0].Title)
	stored := contentOf(t, svc, notes[0].Slug)
	assert.NotContains(t, stored, "intro line")
	assert.True(t, strings.HasPrefix(stored, "## Only Section"))
}

func TestSplit_WithExistingTagAttachesToAll(t *testing.T) {
	ctx := context.Background()
	svc, tagRepo := newTestServiceWithTags(t)

	work, err := tagRepo.Create(ctx, "work")
	require.NoError(t, err)

	content := "## A\n\na\n\n## B\n\nb\n"
	orig, err := svc.Create(ctx, "Original", ptr(content), nil, nil)
	require.NoError(t, err)

	notes, err := svc.Split(ctx, orig.Slug, ptr(work.Slug))
	require.NoError(t, err)
	require.Len(t, notes, 2)
	for _, n := range notes {
		require.Len(t, n.Tags, 1)
		assert.Equal(t, "work", n.Tags[0].Slug)
	}
}

func TestSplit_UnknownTagIsValidationErrorAndCreatesNothing(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	content := "## A\n\na\n\n## B\n\nb\n"
	orig, err := svc.Create(ctx, "Original", ptr(content), nil, nil)
	require.NoError(t, err)

	_, err = svc.Split(ctx, orig.Slug, ptr("does-not-exist"))
	assert.ErrorIs(t, err, ErrValidation)

	// The tag is resolved before any note is written, so nothing was created.
	_, total, err := svc.List(ctx, "", "", false, "updated", "desc", 50, 0)
	require.NoError(t, err)
	assert.Equal(t, 1, total, "only the original note exists")
}

func TestSplit_NoHeadingsIsValidationError(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	orig, err := svc.Create(ctx, "Original", ptr("just some text, no headings\n"), nil, nil)
	require.NoError(t, err)

	_, err = svc.Split(ctx, orig.Slug, nil)
	assert.ErrorIs(t, err, ErrValidation)
}

func TestSplit_NoteNotFound(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	_, err := svc.Split(ctx, "no-such-note", nil)
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestSplit_LeavesOriginalUnchanged(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	content := "## A\n\na\n\n## B\n\nb\n"
	orig, err := svc.Create(ctx, "Original", ptr(content), nil, nil)
	require.NoError(t, err)

	_, err = svc.Split(ctx, orig.Slug, nil)
	require.NoError(t, err)

	after, err := svc.Get(ctx, orig.Slug)
	require.NoError(t, err)
	assert.Equal(t, content, after.Content, "source content is untouched")
	assert.Equal(t, orig.Version, after.Version, "source is not written to")
}

func TestSplit_PreservesBothTimestamps(t *testing.T) {
	ctx := context.Background()
	// Seed a note whose created_at and updated_at differ via the repository
	// directly — notes created through the service share the same instant, so
	// only a hand-set pair proves updated_at is carried over independently.
	db, err := sql.Open("sqlite", "file::memory:?cache=shared&_pragma=foreign_keys(on)")
	require.NoError(t, err)
	db.SetMaxOpenConns(1)
	require.NoError(t, repository.InitSchema(db))
	t.Cleanup(func() { _ = db.Close() })
	repo := repository.NewNoteRepository(db)
	svc := NewNoteService(repo, repository.NewTagRepository(db))

	created := time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	updated := time.Date(2021, 6, 7, 8, 9, 10, 0, time.UTC)
	_, err = repo.CreateWithTimes(ctx, "orig", "Original", "## A\n\na\n\n## B\n\nb", created, updated, nil)
	require.NoError(t, err)

	notes, err := svc.Split(ctx, "orig", nil)
	require.NoError(t, err)
	require.Len(t, notes, 2)
	for _, n := range notes {
		assert.True(t, created.Equal(n.CreatedAt), "new note keeps the original created_at")
		assert.True(t, updated.Equal(n.UpdatedAt), "new note keeps the original updated_at")
	}
}

func TestSplit_DuplicateHeadingTitlesGetSuffixedSlugs(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	content := "## Notes\n\nfirst\n\n## Notes\n\nsecond\n"
	orig, err := svc.Create(ctx, "Original", ptr(content), nil, nil)
	require.NoError(t, err)

	notes, err := svc.Split(ctx, orig.Slug, nil)
	require.NoError(t, err)
	require.Len(t, notes, 2)
	assert.NotEqual(t, notes[0].Slug, notes[1].Slug, "colliding slugs are de-conflicted with a suffix")
}
