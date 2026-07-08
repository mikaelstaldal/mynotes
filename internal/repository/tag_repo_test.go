package repository

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTagCRUD(t *testing.T) {
	ctx := context.Background()
	repo := NewTagRepository(newTestDB(t))

	created, err := repo.Create(ctx, "work")
	require.NoError(t, err)
	assert.NotZero(t, created.ID)
	assert.Equal(t, "work", created.Slug)
	assert.False(t, created.CreatedAt.IsZero())

	got, err := repo.GetBySlug(ctx, "work")
	require.NoError(t, err)
	assert.Equal(t, created.ID, got.ID)

	require.NoError(t, repo.Delete(ctx, "work"))
	_, err = repo.GetBySlug(ctx, "work")
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestTagGetMissingReturnsNotFound(t *testing.T) {
	repo := NewTagRepository(newTestDB(t))
	_, err := repo.GetBySlug(context.Background(), "nope")
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestTagDeleteMissingReturnsNotFound(t *testing.T) {
	repo := NewTagRepository(newTestDB(t))
	err := repo.Delete(context.Background(), "nope")
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestTagCreateDuplicateSlugRejected(t *testing.T) {
	ctx := context.Background()
	repo := NewTagRepository(newTestDB(t))

	_, err := repo.Create(ctx, "dup")
	require.NoError(t, err)

	_, err = repo.Create(ctx, "dup")
	assert.ErrorIs(t, err, ErrConflict)

	got, err := repo.GetBySlug(ctx, "dup")
	require.NoError(t, err)
	assert.Equal(t, "dup", got.Slug, "original row not overwritten by the rejected insert")
}

func TestTagList(t *testing.T) {
	ctx := context.Background()
	repo := NewTagRepository(newTestDB(t))

	_, err := repo.Create(ctx, "zebra")
	require.NoError(t, err)
	_, err = repo.Create(ctx, "apple")
	require.NoError(t, err)
	_, err = repo.Create(ctx, "mango")
	require.NoError(t, err)

	tags, err := repo.List(ctx)
	require.NoError(t, err)
	require.Len(t, tags, 3)
	assert.Equal(t, []string{"apple", "mango", "zebra"},
		[]string{tags[0].Slug, tags[1].Slug, tags[2].Slug}, "sorted by slug, case-insensitive")
}

func TestTagListEmpty(t *testing.T) {
	repo := NewTagRepository(newTestDB(t))
	tags, err := repo.List(context.Background())
	require.NoError(t, err)
	assert.Empty(t, tags)
	assert.NotNil(t, tags)
}

func TestTagGetBySlugs(t *testing.T) {
	ctx := context.Background()
	repo := NewTagRepository(newTestDB(t))

	_, err := repo.Create(ctx, "a")
	require.NoError(t, err)
	_, err = repo.Create(ctx, "b")
	require.NoError(t, err)
	_, err = repo.Create(ctx, "c")
	require.NoError(t, err)

	got, err := repo.GetBySlugs(ctx, []string{"a", "c", "does-not-exist"})
	require.NoError(t, err)
	require.Len(t, got, 2, "only existing slugs are returned; unknown ones are silently omitted")
	slugs := []string{got[0].Slug, got[1].Slug}
	assert.ElementsMatch(t, []string{"a", "c"}, slugs)
}

func TestTagGetBySlugsEmptyInput(t *testing.T) {
	repo := NewTagRepository(newTestDB(t))
	got, err := repo.GetBySlugs(context.Background(), nil)
	require.NoError(t, err)
	assert.Empty(t, got)
}
