package service

import (
	"context"
	"database/sql"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mikaelstaldal/mynotes/internal/repository"
)

// newTestTagService builds a TagService backed by a fresh in-memory SQLite DB.
func newTestTagService(t *testing.T) *TagService {
	t.Helper()
	db, err := sql.Open("sqlite", "file::memory:?cache=shared&_pragma=foreign_keys(on)")
	require.NoError(t, err)
	db.SetMaxOpenConns(1)
	require.NoError(t, repository.InitSchema(db))
	t.Cleanup(func() { _ = db.Close() })
	return NewTagService(repository.NewTagRepository(db))
}

func TestTagService_CreateAutoSlug(t *testing.T) {
	ctx := context.Background()
	svc := newTestTagService(t)

	tag, err := svc.Create(ctx, "Work", nil)
	require.NoError(t, err)
	assert.Equal(t, "work", tag.Slug)
	assert.Equal(t, "Work", tag.Name)
}

func TestTagService_CreateAutoSlugCollisionSuffixes(t *testing.T) {
	ctx := context.Background()
	svc := newTestTagService(t)

	first, err := svc.Create(ctx, "Work", nil)
	require.NoError(t, err)
	assert.Equal(t, "work", first.Slug)

	second, err := svc.Create(ctx, "Work", nil)
	require.NoError(t, err)
	assert.Equal(t, "work-2", second.Slug)
}

func TestTagService_CreateExplicitSlugUsedVerbatim(t *testing.T) {
	ctx := context.Background()
	svc := newTestTagService(t)

	tag, err := svc.Create(ctx, "Work Stuff", ptr("custom"))
	require.NoError(t, err)
	assert.Equal(t, "custom", tag.Slug)
}

func TestTagService_CreateExplicitSlugCollisionIsConflict(t *testing.T) {
	ctx := context.Background()
	svc := newTestTagService(t)

	_, err := svc.Create(ctx, "First", ptr("taken"))
	require.NoError(t, err)

	_, err = svc.Create(ctx, "Second", ptr("taken"))
	assert.ErrorIs(t, err, ErrConflict, "explicit slug collision is never silently suffixed")
}

func TestTagService_CreateInvalidExplicitSlugRejected(t *testing.T) {
	ctx := context.Background()
	svc := newTestTagService(t)
	_, err := svc.Create(ctx, "Title", ptr("Bad Slug!"))
	assert.ErrorIs(t, err, ErrValidation)
}

func TestTagService_CreateTrimsNameAndRejectsBlank(t *testing.T) {
	ctx := context.Background()
	svc := newTestTagService(t)

	tag, err := svc.Create(ctx, "  Spaced  ", nil)
	require.NoError(t, err)
	assert.Equal(t, "Spaced", tag.Name)

	_, err = svc.Create(ctx, "   ", nil)
	assert.ErrorIs(t, err, ErrValidation, "whitespace-only name rejected after trim")
}

func TestTagService_ListAndDelete(t *testing.T) {
	ctx := context.Background()
	svc := newTestTagService(t)

	tag, err := svc.Create(ctx, "Work", nil)
	require.NoError(t, err)

	tags, err := svc.List(ctx)
	require.NoError(t, err)
	require.Len(t, tags, 1)

	require.NoError(t, svc.Delete(ctx, tag.Slug))

	tags, err = svc.List(ctx)
	require.NoError(t, err)
	assert.Empty(t, tags)
}

func TestTagService_DeleteMissingIsNotFound(t *testing.T) {
	ctx := context.Background()
	svc := newTestTagService(t)
	err := svc.Delete(ctx, "does-not-exist")
	assert.ErrorIs(t, err, ErrNotFound)
}
