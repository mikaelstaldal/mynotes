package repository

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/mikaelstaldal/go-server-common/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestSchemaSnapshot keeps the human-readable schema reference in spec/ tied
// to the result of applying every migration to a fresh database. Set
// UPDATE_SCHEMA_SNAPSHOT=1 to rewrite the snapshot after appending a migration.
func TestSchemaSnapshot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "schema.sqlite")
	db, err := OpenDB(path, 0)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	rows, err := db.Query(`SELECT sql
		FROM sqlite_schema
		WHERE sql IS NOT NULL
		  AND name NOT LIKE 'sqlite_%'
		  AND (type != 'table' OR NOT EXISTS (
		    SELECT 1
		    FROM sqlite_schema AS virtual_table
		    WHERE virtual_table.type = 'table'
		      AND virtual_table.sql LIKE 'CREATE VIRTUAL TABLE%'
		      AND sqlite_schema.name GLOB virtual_table.name || '_*'
		  ))
		ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'index' THEN 2 WHEN 'trigger' THEN 3 ELSE 4 END,
		         name`)
	require.NoError(t, err)
	defer rows.Close()

	var statements []string
	for rows.Next() {
		var statement string
		require.NoError(t, rows.Scan(&statement))
		statements = append(statements, strings.TrimSpace(statement)+";")
	}
	require.NoError(t, rows.Err())

	version, err := sqlite.UserVersion(db)
	require.NoError(t, err)
	actual := fmt.Sprintf("-- Generated from a freshly migrated database. See AGENTS.md.\nPRAGMA user_version = %d;\n\n%s\n", version, strings.Join(statements, "\n\n"))
	snapshotPath := filepath.Join("..", "..", "spec", "schema.sql")
	if os.Getenv("UPDATE_SCHEMA_SNAPSHOT") == "1" {
		require.NoError(t, os.WriteFile(snapshotPath, []byte(actual), 0o644))
		t.Log("schema snapshot rewritten")
	}

	expected, err := os.ReadFile(snapshotPath)
	require.NoError(t, err,
		"schema snapshot is missing; run UPDATE_SCHEMA_SNAPSHOT=1 go test ./internal/repository -run TestSchemaSnapshot")
	assert.Equal(t, string(expected), actual,
		"schema snapshot is stale; run UPDATE_SCHEMA_SNAPSHOT=1 go test ./internal/repository -run TestSchemaSnapshot")
}

// A database written by a newer build must be refused rather than operated on
// with a schema this binary does not know, and the refusal must name the file
// and tell the operator what to do about it.
func TestOpenDBRefusesNewerSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.sqlite")

	db, err := sqlite.Open(path, 0, migrations)
	require.NoError(t, err)
	_, err = db.Exec(fmt.Sprintf("PRAGMA user_version = %d", len(migrations)+1))
	require.NoError(t, err)
	require.NoError(t, db.Close())

	reopened, err := OpenDB(path, 0)
	if reopened != nil {
		_ = reopened.Close()
	}
	require.Error(t, err)
	assert.ErrorIs(t, err, sqlite.ErrSchemaTooNew)
	assert.Contains(t, err.Error(), path)
	assert.Contains(t, err.Error(), "newer version of MyNotes")
}

// The ordinary case still works: OpenDB on a database at the current version
// leaves it there.
func TestOpenDBMigratesToCurrentVersion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.sqlite")

	db, err := OpenDB(path, 0)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	version, err := sqlite.UserVersion(db)
	require.NoError(t, err)
	assert.Equal(t, len(migrations), version)
}

// Concurrent upgrade converges: several processes opening the same pre-v6
// database at once all start, and all see one correct link index. That is new —
// under the old non-strict Migrate the losers died on a CREATE TABLE that
// already existed — so this pins that concurrent startup works at all.
//
// It does NOT pin the once-only claim, and must not be read as doing so: it
// passes against the unfixed backfill too, because setNoteLinks deletes before
// it inserts, so a second pass over unchanged content converges on the same
// rows rather than duplicating them. Measured, not assumed — the fix was
// reverted and this test stayed green.
//
// TestBackfillNoteLinksSkipsAPopulatedIndex is the one that holds the claim.
func TestOpenDBConcurrentUpgradeConverges(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "test.sqlite")

	stale, err := sqlite.Open(path, 0, migrations[:linksSchemaVersion-1])
	require.NoError(t, err)
	_, err = stale.ExecContext(ctx, `INSERT INTO notes (slug, title, content, created_at, updated_at)
		VALUES ('p', 'P', 'to [[q]]', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
		       ('q', 'Q', 'plain', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`)
	require.NoError(t, err)
	require.NoError(t, stale.Close())

	const openers = 4
	dbs := make([]*sql.DB, openers)
	errs := make([]error, openers)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := range openers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			dbs[i], errs[i] = OpenDB(path, 5000, "synchronous=NORMAL")
		}()
	}
	close(start)
	wg.Wait()

	for i, err := range errs {
		require.NoError(t, err, "opener %d", i)
		t.Cleanup(func() { _ = dbs[i].Close() })
	}

	// One wikilink in the corpus, one row in the index — the shape a correct
	// pass produces. A redundant pass would also produce it, which is this
	// test's limit rather than its point.
	var links int
	require.NoError(t, dbs[0].QueryRowContext(ctx,
		`SELECT count(*) FROM note_links`).Scan(&links))
	assert.Equal(t, 1, links, "the corpus's one wikilink is indexed")

	q, err := NewNoteRepository(dbs[0]).GetBySlug(ctx, "q")
	require.NoError(t, err)
	assert.Equal(t, []string{"p"}, linkSlugs(q.IncomingLinks))
}

// The claim, tested where the concurrency test cannot reach: once note_links
// holds anything, a second backfill pass must leave it alone. This is what
// stops the loser of a concurrent upgrade rewriting the index underneath the
// winner — the case that matters is an edit the winner has already served, and
// a pass that skips cannot undo one. The sentinel row stands in for that edit:
// q has no wikilinks, so a pass that does not skip deletes it.
func TestBackfillNoteLinksSkipsAPopulatedIndex(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "test.sqlite")

	db, err := OpenDB(path, 0)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	_, err = db.ExecContext(ctx, `INSERT INTO notes (slug, title, content, created_at, updated_at)
		VALUES ('p', 'P', 'to [[q]]', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
		       ('q', 'Q', 'plain', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`)
	require.NoError(t, err)

	var qID int64
	require.NoError(t, db.QueryRowContext(ctx, `SELECT id FROM notes WHERE slug = 'q'`).Scan(&qID))
	_, err = db.ExecContext(ctx,
		`INSERT INTO note_links (source_note_id, target_slug) VALUES (?, 'sentinel')`, qID)
	require.NoError(t, err)

	require.NoError(t, backfillNoteLinks(ctx, db))

	var sentinels int
	require.NoError(t, db.QueryRowContext(ctx,
		`SELECT count(*) FROM note_links WHERE target_slug = 'sentinel'`).Scan(&sentinels))
	assert.Equal(t, 1, sentinels, "a populated index is claimed, so the pass must not rewrite it")
}
