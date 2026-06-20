package repository

import (
	"database/sql"

	"github.com/mikaelstaldal/go-server-common/sqlite"
)

// migrations lists schema versions in order. Index 0 is the migration that
// brings a fresh database (user_version 0) up to version 1, and so on. To
// evolve the schema, append a new []string; never edit an existing entry,
// because deployed databases have already applied it.
var migrations = [][]string{
	schemaV1,
}

// OpenDB opens (creating if absent) the SQLite database at path, applies the
// requested PRAGMAs, and runs any outstanding schema migrations. extraPragmas
// are passed verbatim as `_pragma=` query values (e.g. "synchronous=NORMAL").
func OpenDB(path string, busyTimeout int, extraPragmas ...string) (*sql.DB, error) {
	return sqlite.Open(path, busyTimeout, migrations, extraPragmas...)
}

// InitSchema brings the database up to the latest schema version, applying any
// migrations the database has not yet seen. It is idempotent and safe to run on
// every startup.
func InitSchema(db *sql.DB) error {
	return sqlite.Migrate(db, migrations)
}

// CreateDataDir ensures the directory holding the database file exists.
func CreateDataDir(dbPath string) error {
	return sqlite.CreateDataDir(dbPath)
}

var schemaV1 = []string{
	`CREATE TABLE IF NOT EXISTS items (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		title      TEXT NOT NULL,
		content    TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,

	`CREATE INDEX IF NOT EXISTS idx_items_created_at ON items(created_at DESC)`,

	// Full-text index kept in sync with `items` via triggers. content='items'
	// makes it an external-content table (no duplicated row storage).
	`CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
		title,
		content,
		content='items',
		content_rowid='id'
	)`,

	`CREATE TRIGGER IF NOT EXISTS items_fts_insert AFTER INSERT ON items BEGIN
		INSERT INTO items_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
	END`,

	`CREATE TRIGGER IF NOT EXISTS items_fts_delete AFTER DELETE ON items BEGIN
		INSERT INTO items_fts(items_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
	END`,

	`CREATE TRIGGER IF NOT EXISTS items_fts_update AFTER UPDATE OF title, content ON items BEGIN
		INSERT INTO items_fts(items_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
		INSERT INTO items_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
	END`,
}
