-- Generated from a freshly migrated database. See AGENTS.md.
PRAGMA user_version = 7;

CREATE TABLE artifacts (
		sha256       TEXT PRIMARY KEY,
		content      BLOB NOT NULL,
		content_type TEXT NOT NULL,
		created_at   TEXT NOT NULL
	);

CREATE TABLE note_links (
		source_note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
		target_slug    TEXT NOT NULL,
		PRIMARY KEY (source_note_id, target_slug)
	);

CREATE TABLE note_tags (
		note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
		tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
		PRIMARY KEY (note_id, tag_id)
	);

CREATE TABLE notes (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		slug       TEXT NOT NULL UNIQUE,
		title      TEXT NOT NULL,
		content    TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	, version INTEGER NOT NULL DEFAULT 1);

CREATE VIRTUAL TABLE notes_fts USING fts5(
		title,
		content,
		content='notes',
		content_rowid='id'
	);

CREATE TABLE published_note_artifacts (
		note_id INTEGER NOT NULL REFERENCES published_notes(note_id) ON DELETE CASCADE,
		sha256  TEXT NOT NULL,
		PRIMARY KEY (note_id, sha256)
	);

CREATE TABLE published_notes (
		note_id      INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
		title        TEXT NOT NULL,
		html         TEXT NOT NULL,
		published_at TEXT NOT NULL
	);

CREATE TABLE tags (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		slug       TEXT NOT NULL UNIQUE,
		created_at TEXT NOT NULL
	);

CREATE INDEX idx_note_links_target_slug ON note_links(target_slug);

CREATE INDEX idx_note_tags_tag_id ON note_tags(tag_id);

CREATE INDEX idx_notes_updated_at ON notes(updated_at DESC, id DESC);

CREATE INDEX idx_published_note_artifacts_sha256 ON published_note_artifacts(sha256);

CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes BEGIN
		INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
	END;

CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes BEGIN
		INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
	END;

CREATE TRIGGER notes_fts_update AFTER UPDATE ON notes BEGIN
		INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
		INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
	END;
