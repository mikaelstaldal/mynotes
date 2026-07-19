package repository

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/mikaelstaldal/go-server-common/sqlite"
	"github.com/mikaelstaldal/mynotes/internal/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// linkSlugs projects a []model.NoteLink to its slugs, for order-sensitive
// assertions (results are ordered by title COLLATE NOCASE).
func linkSlugs(links []model.NoteLink) []string {
	out := make([]string, len(links))
	for i, l := range links {
		out[i] = l.Slug
	}
	return out
}

func TestNoteLinksBidirectional(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	_, err := repo.Create(ctx, "alpha", "Alpha", "See [[beta]] for details.")
	require.NoError(t, err)
	_, err = repo.Create(ctx, "beta", "Beta", "Back to [[alpha|the first note]].")
	require.NoError(t, err)

	alpha, err := repo.GetBySlug(ctx, "alpha")
	require.NoError(t, err)
	require.Len(t, alpha.OutgoingLinks, 1)
	assert.Equal(t, "beta", alpha.OutgoingLinks[0].Slug)
	assert.Equal(t, "Beta", alpha.OutgoingLinks[0].Title, "outgoing carries target's current title")
	require.Len(t, alpha.IncomingLinks, 1)
	assert.Equal(t, "beta", alpha.IncomingLinks[0].Slug)
	assert.Equal(t, "Beta", alpha.IncomingLinks[0].Title)

	beta, err := repo.GetBySlug(ctx, "beta")
	require.NoError(t, err)
	assert.Equal(t, []string{"alpha"}, linkSlugs(beta.OutgoingLinks))
	assert.Equal(t, []string{"alpha"}, linkSlugs(beta.IncomingLinks))
}

func TestNoteLinksNeverNil(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	n, err := repo.Create(ctx, "lonely", "Lonely", "no links here")
	require.NoError(t, err)
	assert.NotNil(t, n.OutgoingLinks)
	assert.NotNil(t, n.IncomingLinks)
	assert.Empty(t, n.OutgoingLinks)
	assert.Empty(t, n.IncomingLinks)
}

func TestNoteLinksDanglingResolveOnTargetCreate(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	_, err := repo.Create(ctx, "source", "Source", "points to [[ghost]] which is missing")
	require.NoError(t, err)

	src, err := repo.GetBySlug(ctx, "source")
	require.NoError(t, err)
	assert.Empty(t, src.OutgoingLinks, "dangling link to non-existent note is omitted")

	// Creating the target makes the previously-dangling link resolve, with no
	// re-index of the source note.
	_, err = repo.Create(ctx, "ghost", "Ghost", "")
	require.NoError(t, err)

	src, err = repo.GetBySlug(ctx, "source")
	require.NoError(t, err)
	require.Len(t, src.OutgoingLinks, 1)
	assert.Equal(t, "ghost", src.OutgoingLinks[0].Slug)
	assert.Equal(t, "Ghost", src.OutgoingLinks[0].Title)

	ghost, err := repo.GetBySlug(ctx, "ghost")
	require.NoError(t, err)
	assert.Equal(t, []string{"source"}, linkSlugs(ghost.IncomingLinks))
}

func TestNoteLinksTagLinksNotIndexed(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	_, err := repo.Create(ctx, "note", "Note", "a [[#work]] tag link and a [[real]] note link")
	require.NoError(t, err)
	_, err = repo.Create(ctx, "real", "Real", "")
	require.NoError(t, err)

	n, err := repo.GetBySlug(ctx, "note")
	require.NoError(t, err)
	assert.Equal(t, []string{"real"}, linkSlugs(n.OutgoingLinks), "tag links are not part of the graph")
}

func TestNoteLinksReindexOnContentUpdate(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	for _, s := range []struct{ slug, title string }{{"a", "A"}, {"b", "B"}, {"c", "C"}} {
		_, err := repo.Create(ctx, s.slug, s.title, "")
		require.NoError(t, err)
	}
	_, err := repo.Create(ctx, "hub", "Hub", "links to [[a]] and [[b]]")
	require.NoError(t, err)

	hub, err := repo.GetBySlug(ctx, "hub")
	require.NoError(t, err)
	assert.Equal(t, []string{"a", "b"}, linkSlugs(hub.OutgoingLinks))

	// Content update re-indexes: drops [[b]], adds [[c]].
	_, err = repo.Update(ctx, "hub", nil, ptr("now links to [[a]] and [[c]]"), nil, nil)
	require.NoError(t, err)

	hub, err = repo.GetBySlug(ctx, "hub")
	require.NoError(t, err)
	assert.Equal(t, []string{"a", "c"}, linkSlugs(hub.OutgoingLinks))

	// b no longer has a backlink; c now does.
	b, err := repo.GetBySlug(ctx, "b")
	require.NoError(t, err)
	assert.Empty(t, b.IncomingLinks)
	c, err := repo.GetBySlug(ctx, "c")
	require.NoError(t, err)
	assert.Equal(t, []string{"hub"}, linkSlugs(c.IncomingLinks))
}

func TestNoteLinksTitleOnlyUpdateKeepsLinks(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	_, err := repo.Create(ctx, "target", "Target", "")
	require.NoError(t, err)
	_, err = repo.Create(ctx, "linker", "Linker", "see [[target]]")
	require.NoError(t, err)

	// A title-only edit of the linker must not drop its outgoing links.
	_, err = repo.Update(ctx, "linker", ptr("Linker Renamed"), nil, nil, nil)
	require.NoError(t, err)
	linker, err := repo.GetBySlug(ctx, "linker")
	require.NoError(t, err)
	assert.Equal(t, []string{"target"}, linkSlugs(linker.OutgoingLinks))

	// A title-only edit of the target updates the title seen by its linkers,
	// resolved at read time (no re-index of the linker).
	_, err = repo.Update(ctx, "target", ptr("Target Renamed"), nil, nil, nil)
	require.NoError(t, err)
	linker, err = repo.GetBySlug(ctx, "linker")
	require.NoError(t, err)
	require.Len(t, linker.OutgoingLinks, 1)
	assert.Equal(t, "Target Renamed", linker.OutgoingLinks[0].Title)
}

func TestNoteLinksDeleteCascades(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	_, err := repo.Create(ctx, "keep", "Keep", "")
	require.NoError(t, err)
	_, err = repo.Create(ctx, "gone", "Gone", "links to [[keep]]")
	require.NoError(t, err)

	keep, err := repo.GetBySlug(ctx, "keep")
	require.NoError(t, err)
	assert.Equal(t, []string{"gone"}, linkSlugs(keep.IncomingLinks))

	// Deleting the source cascades its outgoing rows away, so the backlink is gone.
	require.NoError(t, repo.Delete(ctx, "gone"))
	keep, err = repo.GetBySlug(ctx, "keep")
	require.NoError(t, err)
	assert.Empty(t, keep.IncomingLinks)

	// No orphan rows left behind.
	var count int
	require.NoError(t, repo.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM note_links`).Scan(&count))
	assert.Zero(t, count)
}

func TestNoteLinksInListSummaries(t *testing.T) {
	ctx := context.Background()
	repo := NewNoteRepository(newTestDB(t))

	_, err := repo.Create(ctx, "one", "One", "see [[two]]")
	require.NoError(t, err)
	_, err = repo.Create(ctx, "two", "Two", "see [[one]]")
	require.NoError(t, err)

	notes, _, err := repo.List(ctx, "", "", false, SortTitle, OrderAsc, 50, 0)
	require.NoError(t, err)
	require.Len(t, notes, 2)
	byslug := map[string]model.NoteSummary{}
	for _, n := range notes {
		byslug[n.Slug] = n
		// Never nil in summaries either.
		assert.NotNil(t, n.OutgoingLinks)
		assert.NotNil(t, n.IncomingLinks)
	}
	assert.Equal(t, []string{"two"}, linkSlugs(byslug["one"].OutgoingLinks))
	assert.Equal(t, []string{"two"}, linkSlugs(byslug["one"].IncomingLinks))
}

func TestBackfillNoteLinks(t *testing.T) {
	ctx := context.Background()
	db := newTestDB(t)
	repo := NewNoteRepository(db)

	// Insert notes directly (bypassing the write path that indexes links) to
	// simulate a pre-schemaV6 database.
	_, err := db.ExecContext(ctx, `INSERT INTO notes (slug, title, content, created_at, updated_at)
		VALUES ('x', 'X', 'links to [[y]]', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
		       ('y', 'Y', 'and back to [[x]]', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`)
	require.NoError(t, err)

	// No links indexed yet.
	x, err := repo.GetBySlug(ctx, "x")
	require.NoError(t, err)
	assert.Empty(t, x.OutgoingLinks)

	require.NoError(t, backfillNoteLinks(ctx, db))

	x, err = repo.GetBySlug(ctx, "x")
	require.NoError(t, err)
	assert.Equal(t, []string{"y"}, linkSlugs(x.OutgoingLinks))
	assert.Equal(t, []string{"y"}, linkSlugs(x.IncomingLinks))

	// Idempotent: re-running replaces (not duplicates) each note's rows.
	require.NoError(t, backfillNoteLinks(ctx, db))
	x, err = repo.GetBySlug(ctx, "x")
	require.NoError(t, err)
	assert.Equal(t, []string{"y"}, linkSlugs(x.OutgoingLinks))
}

// TestOpenDBBackfillsOnUpgrade exercises the one-time backfill gate in OpenDB:
// a database that predates the note_links schema (v5) is indexed exactly once on
// the upgrade that creates the table.
func TestOpenDBBackfillsOnUpgrade(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "test.sqlite")

	// Build a v5 database (no note_links yet) with notes inserted directly.
	db, err := sqlite.Open(path, 0, migrations[:linksSchemaVersion-1])
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, `INSERT INTO notes (slug, title, content, created_at, updated_at)
		VALUES ('p', 'P', 'to [[q]]', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
		       ('q', 'Q', 'plain', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`)
	require.NoError(t, err)
	require.NoError(t, db.Close())

	// OpenDB migrates to v6 and runs the backfill because prev version (5) < 6.
	db2, err := OpenDB(path, 0)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db2.Close() })

	repo := NewNoteRepository(db2)
	q, err := repo.GetBySlug(ctx, "q")
	require.NoError(t, err)
	assert.Equal(t, []string{"p"}, linkSlugs(q.IncomingLinks), "existing notes indexed on upgrade")

	// A subsequent OpenDB (already at v6) must not re-run the backfill nor
	// disturb the index.
	require.NoError(t, db2.Close())
	db3, err := OpenDB(path, 0)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db3.Close() })
	repo3 := NewNoteRepository(db3)
	q, err = repo3.GetBySlug(ctx, "q")
	require.NoError(t, err)
	assert.Equal(t, []string{"p"}, linkSlugs(q.IncomingLinks))
}
