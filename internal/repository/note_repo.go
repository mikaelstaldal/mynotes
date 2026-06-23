package repository

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/mikaelstaldal/mynotes/internal/model"
	sqlitedrv "modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

// NoteRepository is the storage gateway for notes. One repository struct per
// aggregate keeps SQL co-located with the data it touches. Notes are addressed
// by their human-readable slug; the internal integer id stays inside this
// package (slug→id resolution happens here on the mutate paths).
type NoteRepository struct {
	db *sql.DB
}

func NewNoteRepository(db *sql.DB) *NoteRepository {
	return &NoteRepository{db: db}
}

const rfc3339 = "2006-01-02T15:04:05Z07:00"

// scanNote reads all six columns (internal id + the five exposed fields) so the
// read view has the full note and the PATCH no-op diff can compare and resolve
// slug→id.
func scanNote(s interface{ Scan(...any) error }) (model.Note, error) {
	var (
		n                    model.Note
		createdAt, updatedAt string
	)
	if err := s.Scan(&n.ID, &n.Slug, &n.Title, &n.Content, &createdAt, &updatedAt); err != nil {
		return model.Note{}, err
	}
	n.CreatedAt, _ = time.Parse(rfc3339, createdAt)
	n.UpdatedAt, _ = time.Parse(rfc3339, updatedAt)
	return n, nil
}

// GetBySlug returns the full note, or ErrNotFound if no note has that slug.
func (r *NoteRepository) GetBySlug(ctx context.Context, slug string) (model.Note, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, slug, title, content, created_at, updated_at FROM notes WHERE slug = ?`, slug)
	n, err := scanNote(row)
	if errors.Is(err, sql.ErrNoRows) {
		return model.Note{}, ErrNotFound
	}
	return n, err
}

// SlugExists reports whether a note with the given slug already exists, excluding
// the row identified by excludeID. Pass excludeID = 0 to check globally (ids are
// AUTOINCREMENT and start at 1, so `id != 0` never excludes a real row); pass a
// note's own id on a rename so its current slug does not count as a conflict.
// The check is advisory/racy — the DB UNIQUE constraint is the authority.
func (r *NoteRepository) SlugExists(ctx context.Context, slug string, excludeID int64) (bool, error) {
	var exists bool
	err := r.db.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM notes WHERE slug = ? AND id != ?)`, slug, excludeID).Scan(&exists)
	return exists, err
}

// isUniqueViolation reports whether err is a SQLite UNIQUE-constraint failure.
// The notes table's only UNIQUE index is on slug, so this is always a slug
// collision; callers translate it to ErrConflict.
func isUniqueViolation(err error) bool {
	var sqErr *sqlitedrv.Error
	return errors.As(err, &sqErr) && sqErr.Code() == sqlite3.SQLITE_CONSTRAINT_UNIQUE
}

// Create inserts a row and returns the stored note. A duplicate slug surfaces as
// ErrConflict (the UNIQUE constraint is the authority on slug uniqueness).
func (r *NoteRepository) Create(ctx context.Context, slug, title, content string) (model.Note, error) {
	now := time.Now().UTC().Format(rfc3339)
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO notes (slug, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
		slug, title, content, now, now)
	if isUniqueViolation(err) {
		return model.Note{}, ErrConflict
	}
	if err != nil {
		return model.Note{}, err
	}
	return r.GetBySlug(ctx, slug)
}

// Update resolves the URL slug to its id, then applies the non-nil fields in a
// single UPDATE keyed by id. A nil field is left unchanged; a missing slug is
// ErrNotFound. A slug rename writes newSlug onto the resolved id in the *same*
// statement as the other changed columns, so a UNIQUE conflict writes nothing.
func (r *NoteRepository) Update(ctx context.Context, slug string, title, content, newSlug *string) (model.Note, error) {
	existing, err := r.GetBySlug(ctx, slug)
	if err != nil {
		return model.Note{}, err
	}

	sets := []string{"updated_at = ?"}
	args := []any{time.Now().UTC().Format(rfc3339)}
	if title != nil {
		sets = append(sets, "title = ?")
		args = append(args, *title)
	}
	if content != nil {
		sets = append(sets, "content = ?")
		args = append(args, *content)
	}
	if newSlug != nil {
		sets = append(sets, "slug = ?")
		args = append(args, *newSlug)
	}
	args = append(args, existing.ID)

	_, err = r.db.ExecContext(ctx,
		"UPDATE notes SET "+strings.Join(sets, ", ")+" WHERE id = ?", args...)
	if isUniqueViolation(err) {
		return model.Note{}, ErrConflict
	}
	if err != nil {
		return model.Note{}, err
	}

	finalSlug := slug
	if newSlug != nil {
		finalSlug = *newSlug
	}
	return r.GetBySlug(ctx, finalSlug)
}

// Delete resolves the URL slug to its id and removes that row, returning
// ErrNotFound when no note has the slug.
func (r *NoteRepository) Delete(ctx context.Context, slug string) error {
	existing, err := r.GetBySlug(ctx, slug)
	if err != nil {
		return err
	}
	_, err = r.db.ExecContext(ctx, `DELETE FROM notes WHERE id = ?`, existing.ID)
	return err
}

// List returns a page of note summaries and the total matching count. The
// effective query (after sanitizeFTSQuery) selects the branch: empty → browse
// (newest-first, no FTS reference); non-empty → search (FTS MATCH, bm25 rank).
// total is a second COUNT(*) over the same predicate, independent of
// limit/offset (best-effort, not transactionally consistent with the page).
func (r *NoteRepository) List(ctx context.Context, query string, limit, offset int) ([]model.NoteSummary, int, error) {
	if q := sanitizeFTSQuery(query); q != "" {
		return r.search(ctx, q, limit, offset)
	}
	return r.browse(ctx, limit, offset)
}

func (r *NoteRepository) browse(ctx context.Context, limit, offset int) ([]model.NoteSummary, int, error) {
	var total int
	if err := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM notes`).Scan(&total); err != nil {
		return nil, 0, err
	}

	rows, err := r.db.QueryContext(ctx, `
		SELECT slug, title, updated_at, substr(content, 1, 201)
		FROM notes
		ORDER BY updated_at DESC, id DESC
		LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	notes := make([]model.NoteSummary, 0)
	for rows.Next() {
		var (
			s         model.NoteSummary
			updatedAt string
			probe     string
		)
		if err := rows.Scan(&s.Slug, &s.Title, &updatedAt, &probe); err != nil {
			return nil, 0, err
		}
		s.UpdatedAt, _ = time.Parse(rfc3339, updatedAt)
		s.Excerpt = plainExcerpt(probe)
		notes = append(notes, s)
	}
	return notes, total, rows.Err()
}

func (r *NoteRepository) search(ctx context.Context, q string, limit, offset int) ([]model.NoteSummary, int, error) {
	var total int
	if err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH ?`, q).Scan(&total); err != nil {
		return nil, 0, err
	}

	// snippet() marks matched terms with sentinel control chars U+0002/U+0003
	// (not HTML); content is column index 1. We also pull the plain prefix to
	// fall back on for title-only matches (empty snippet) and empty content.
	// FTS5 auxiliary functions (snippet/rank) and the MATCH operator must
	// reference the FTS table by its real name, not a join alias.
	rows, err := r.db.QueryContext(ctx, `
		SELECT n.slug, n.title, n.updated_at,
		       snippet(notes_fts, 1, char(2), char(3), '…', 30),
		       substr(n.content, 1, 201)
		FROM notes n
		JOIN notes_fts ON notes_fts.rowid = n.id
		WHERE notes_fts MATCH ?
		ORDER BY notes_fts.rank, n.id DESC
		LIMIT ? OFFSET ?`, q, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	notes := make([]model.NoteSummary, 0)
	for rows.Next() {
		var (
			s         model.NoteSummary
			updatedAt string
			snip      string
			probe     string
		)
		if err := rows.Scan(&s.Slug, &s.Title, &updatedAt, &snip, &probe); err != nil {
			return nil, 0, err
		}
		s.UpdatedAt, _ = time.Parse(rfc3339, updatedAt)
		// A snippet only carries a U+0002 start sentinel when it actually
		// matched in content. Otherwise (title-only match / empty content) fall
		// back to the plain prefix.
		if strings.ContainsRune(snip, '\x02') {
			s.Excerpt = snip
		} else {
			s.Excerpt = plainExcerpt(probe)
		}
		notes = append(notes, s)
	}
	return notes, total, rows.Err()
}

// plainExcerpt turns a `substr(content, 1, 201)` probe into a display excerpt: a
// rune-accurate ~200-rune word-boundary prefix. The probe returns at most 201
// runes; exactly 201 means the content was longer, so cut back to a word
// boundary and append an ellipsis. A probe of ≤200 runes is the full content,
// shown verbatim (empty content → empty excerpt).
func plainExcerpt(probe string) string {
	runes := []rune(probe)
	if len(runes) <= 200 {
		return probe
	}
	prefix := string(runes[:200])
	if i := strings.LastIndexAny(prefix, " \t\n\r"); i > 0 {
		prefix = prefix[:i]
	}
	return strings.TrimRight(prefix, " \t\n\r") + "…"
}

// sanitizeFTSQuery turns arbitrary user input into a safe FTS5 MATCH string by
// treating every token as a literal: each token is wrapped in double quotes
// (with internal quotes doubled), so FTS5 operators like AND/OR/NEAR and
// special characters cannot break out. Returns "" when there is nothing to
// match, signalling the caller to fall back to an unfiltered browse list.
func sanitizeFTSQuery(query string) string {
	fields := strings.Fields(query)
	tokens := make([]string, 0, len(fields))
	for _, f := range fields {
		f = strings.ReplaceAll(f, `"`, `""`)
		tokens = append(tokens, `"`+f+`"`)
	}
	return strings.Join(tokens, " ")
}
