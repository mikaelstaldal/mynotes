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
	schemaV2,
	schemaV3,
	schemaV4,
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

var schemaV4 = []string{
	`CREATE TABLE IF NOT EXISTS tags (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		slug       TEXT NOT NULL UNIQUE,
		name       TEXT NOT NULL,
		created_at TEXT NOT NULL
	)`,

	`CREATE TABLE IF NOT EXISTS note_tags (
		note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
		tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
		PRIMARY KEY (note_id, tag_id)
	)`,

	// The composite PK (note_id, tag_id) already indexes the "tags of note N"
	// direction (note_id is the leading column). "notes with tag N" needs its
	// own index since tag_id is not a PK prefix.
	`CREATE INDEX IF NOT EXISTS idx_note_tags_tag_id ON note_tags(tag_id)`,
}

var schemaV3 = []string{
	`ALTER TABLE notes ADD COLUMN version INTEGER NOT NULL DEFAULT 1`,
}

var schemaV2 = []string{
	`CREATE TABLE IF NOT EXISTS artifacts (
		sha256       TEXT PRIMARY KEY,
		content      BLOB NOT NULL,
		content_type TEXT NOT NULL,
		created_at   TEXT NOT NULL
	)`,
}

var schemaV1 = []string{
	`CREATE TABLE IF NOT EXISTS notes (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		slug       TEXT NOT NULL UNIQUE,
		title      TEXT NOT NULL,
		content    TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,

	// Composite index carries the id tie-break so the browse ordering
	// (updated_at DESC, id DESC) is served without a sort step.
	`CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at DESC, id DESC)`,

	// Full-text index kept in sync with `notes` via triggers. content='notes'
	// makes it an external-content table (no duplicated row storage).
	`CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
		title,
		content,
		content='notes',
		content_rowid='id'
	)`,

	`CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
		INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
	END`,

	// External-content tables require the 'delete' bookkeeping command on
	// delete/update; a plain DELETE/INSERT mirror corrupts the index.
	`CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
		INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
	END`,

	// Unscoped (AFTER UPDATE ON notes), per ARCHITECTURE.md.
	`CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN
		INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
		INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
	END`,
}
