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

func TestTagService_CreateUsesSlugVerbatim(t *testing.T) {
	ctx := context.Background()
	svc := newTestTagService(t)

	tag, err := svc.Create(ctx, "work")
	require.NoError(t, err)
	assert.Equal(t, "work", tag.Slug)
}

func TestTagService_CreateSlugCollisionIsConflict(t *testing.T) {
	ctx := context.Background()
	svc := newTestTagService(t)

	_, err := svc.Create(ctx, "taken")
	require.NoError(t, err)

	_, err = svc.Create(ctx, "taken")
	assert.ErrorIs(t, err, ErrConflict, "a slug collision is never silently suffixed")
}

func TestTagService_CreateInvalidSlugRejected(t *testing.T) {
	ctx := context.Background()
	svc := newTestTagService(t)

	// Anything not matching the slug pattern (lowercase alphanumerics separated
	// by single hyphens) is rejected: uppercase, spaces, punctuation, empty,
	// leading/trailing/double hyphens.
	for _, bad := range []string{"Bad Slug!", "UPPER", "", "-leading", "trailing-", "a--b"} {
		_, err := svc.Create(ctx, bad)
		assert.ErrorIs(t, err, ErrValidation, "slug %q", bad)
	}
}

func TestTagService_ListAndDelete(t *testing.T) {
	ctx := context.Background()
	svc := newTestTagService(t)

	tag, err := svc.Create(ctx, "work")
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
