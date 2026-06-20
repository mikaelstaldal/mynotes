package repository

import (
	"context"
	"database/sql"
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

func TestItemCRUD(t *testing.T) {
	ctx := context.Background()
	repo := NewItemRepository(newTestDB(t))

	created, err := repo.Create(ctx, "Hello", "<p>world</p>")
	require.NoError(t, err)
	assert.NotZero(t, created.ID)
	assert.Equal(t, "Hello", created.Title)
	assert.False(t, created.CreatedAt.IsZero())

	got, err := repo.GetByID(ctx, created.ID)
	require.NoError(t, err)
	assert.Equal(t, created.Title, got.Title)

	newTitle := "Updated"
	updated, err := repo.Update(ctx, created.ID, &newTitle, nil)
	require.NoError(t, err)
	assert.Equal(t, "Updated", updated.Title)
	assert.Equal(t, "<p>world</p>", updated.Content, "content left unchanged when nil")

	require.NoError(t, repo.Delete(ctx, created.ID))
	_, err = repo.GetByID(ctx, created.ID)
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestGetMissingReturnsNotFound(t *testing.T) {
	repo := NewItemRepository(newTestDB(t))
	_, err := repo.GetByID(context.Background(), 999)
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestSearchTreatsInputAsLiteral(t *testing.T) {
	ctx := context.Background()
	repo := NewItemRepository(newTestDB(t))

	_, err := repo.Create(ctx, "Quarterly report", "revenue figures")
	require.NoError(t, err)
	_, err = repo.Create(ctx, "Grocery list", "milk and eggs")
	require.NoError(t, err)

	hits, err := repo.List(ctx, "report", 50, 0)
	require.NoError(t, err)
	require.Len(t, hits, 1)
	assert.Equal(t, "Quarterly report", hits[0].Title)

	// FTS operator keywords must be matched literally, not interpreted.
	none, err := repo.List(ctx, "report OR grocery", 50, 0)
	require.NoError(t, err)
	assert.Empty(t, none)
}
