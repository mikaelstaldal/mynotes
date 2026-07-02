package repository

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/mikaelstaldal/mynotes/internal/model"
	sqlitedrv "modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

var (
	mdImageRE       = regexp.MustCompile(`!\[[^\]]*\]\([^)]*\)`)
	mdLinkRE        = regexp.MustCompile(`\[([^\]]*)\]\([^)]*\)`)
	mdCodeRE        = regexp.MustCompile("`+([^`]*)`+")
	mdStrikeRE      = regexp.MustCompile(`~~([^~]*)~~`)
	mdOrderedListRE = regexp.MustCompile(`^\d+\.\s+`)
	mdHRuleRE       = regexp.MustCompile(`^[-*_]{3,}\s*$`)
	// mdHTMLTagRE matches a line starting with a raw HTML/SVG/MathML tag
	// (opening, closing, or self-closing).
	mdHTMLTagRE = regexp.MustCompile(`^<(/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(/?)>`)
	// voidHTMLTags never require a matching closing tag.
	voidHTMLTags = map[string]bool{
		"area": true, "base": true, "br": true, "col": true, "embed": true,
		"hr": true, "img": true, "input": true, "link": true, "meta": true,
		"param": true, "source": true, "track": true, "wbr": true,
	}
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
	if err := s.Scan(&n.ID, &n.Slug, &n.Title, &n.Content, &createdAt, &updatedAt, &n.Version); err != nil {
		return model.Note{}, err
	}
	n.CreatedAt, _ = time.Parse(rfc3339, createdAt)
	n.UpdatedAt, _ = time.Parse(rfc3339, updatedAt)
	return n, nil
}

// GetBySlug returns the full note, or ErrNotFound if no note has that slug.
func (r *NoteRepository) GetBySlug(ctx context.Context, slug string) (model.Note, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, slug, title, content, created_at, updated_at, version FROM notes WHERE slug = ?`, slug)
	n, err := scanNote(row)
	if errors.Is(err, sql.ErrNoRows) {
		return model.Note{}, ErrNotFound
	}
	if err != nil {
		return model.Note{}, err
	}
	byID, err := tagsForNoteIDs(ctx, r.db, []int64{n.ID})
	if err != nil {
		return model.Note{}, err
	}
	n.Tags = byID[n.ID]
	if n.Tags == nil {
		n.Tags = []model.Tag{}
	}
	return n, nil
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

// isForeignKeyViolation reports whether err is a SQLite FOREIGN KEY-constraint
// failure. note_tags' only foreign keys are note_id/tag_id, so this means a
// write referenced a tag id that no longer exists; callers translate it to
// ErrUnknownTag.
func isForeignKeyViolation(err error) bool {
	var sqErr *sqlitedrv.Error
	return errors.As(err, &sqErr) && sqErr.Code() == sqlite3.SQLITE_CONSTRAINT_FOREIGNKEY
}

// queryer is satisfied by both *sql.DB and *sql.Tx, letting read helpers run
// either standalone or inside a write transaction without a bespoke
// transaction-abstraction type.
type queryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// tagsForNoteIDs returns tags for each given note id, batched into a single
// query so a page of notes costs one extra query total, never one per row.
// An id with no tags has no entry in the returned map.
func tagsForNoteIDs(ctx context.Context, q queryer, ids []int64) (map[int64][]model.Tag, error) {
	if len(ids) == 0 {
		return map[int64][]model.Tag{}, nil
	}
	placeholders := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		args[i] = id
	}
	rows, err := q.QueryContext(ctx, `
		SELECT nt.note_id, t.id, t.slug, t.name, t.created_at
		FROM note_tags nt
		JOIN tags t ON t.id = nt.tag_id
		WHERE nt.note_id IN (`+strings.Join(placeholders, ",")+`)
		ORDER BY nt.note_id, t.name COLLATE NOCASE`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make(map[int64][]model.Tag)
	for rows.Next() {
		var (
			noteID    int64
			t         model.Tag
			createdAt string
		)
		if err := rows.Scan(&noteID, &t.ID, &t.Slug, &t.Name, &createdAt); err != nil {
			return nil, err
		}
		t.CreatedAt, _ = time.Parse(rfc3339, createdAt)
		out[noteID] = append(out[noteID], t)
	}
	return out, rows.Err()
}

// setNoteTags fully replaces a note's tag set (delete-then-insert), keyed by
// tag id. Must be called inside a write transaction alongside the note write
// it belongs to, so the two stay consistent. A tag id that no longer exists
// (e.g. deleted by a concurrent request) surfaces as ErrUnknownTag.
func setNoteTags(ctx context.Context, tx *sql.Tx, noteID int64, tagIDs []int64) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM note_tags WHERE note_id = ?`, noteID); err != nil {
		return err
	}
	for _, tagID := range tagIDs {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)`, noteID, tagID); err != nil {
			if isForeignKeyViolation(err) {
				return ErrUnknownTag
			}
			return err
		}
	}
	return nil
}

// Create inserts a row with created_at/updated_at set to now and no tags, and
// returns the stored note. A duplicate slug surfaces as ErrConflict.
func (r *NoteRepository) Create(ctx context.Context, slug, title, content string) (model.Note, error) {
	return r.CreateWithTime(ctx, slug, title, content, time.Now().UTC(), nil)
}

// CreateWithTime is like Create but uses createdAt for both created_at and
// updated_at (allowing import paths to preserve original authorship dates)
// and attaches tagIDs (nil/empty means no tags). The note insert and the tag
// attachment run in a single transaction so the two never diverge.
func (r *NoteRepository) CreateWithTime(ctx context.Context, slug, title, content string, createdAt time.Time, tagIDs []int64) (model.Note, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return model.Note{}, err
	}
	defer func() { _ = tx.Rollback() }() // no-op once Commit succeeds

	ts := createdAt.UTC().Format(rfc3339)
	res, err := tx.ExecContext(ctx, `
		INSERT INTO notes (slug, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
		slug, title, content, ts, ts)
	if isUniqueViolation(err) {
		return model.Note{}, ErrConflict
	}
	if err != nil {
		return model.Note{}, err
	}

	if len(tagIDs) > 0 {
		id, err := res.LastInsertId()
		if err != nil {
			return model.Note{}, err
		}
		if err := setNoteTags(ctx, tx, id, tagIDs); err != nil {
			return model.Note{}, err
		}
	}

	if err := tx.Commit(); err != nil {
		return model.Note{}, err
	}
	return r.GetBySlug(ctx, slug)
}

// Update resolves the URL slug to its id, then applies the non-nil fields in a
// single UPDATE keyed by id. A nil field is left unchanged; a missing slug is
// ErrNotFound. A slug rename writes newSlug onto the resolved id in the *same*
// statement as the other changed columns, so a UNIQUE conflict writes nothing.
// tagIDs nil leaves the note's tags unchanged; a non-nil (possibly empty)
// slice replaces the full tag set. Both the note write and the tag write run
// in one transaction.
func (r *NoteRepository) Update(ctx context.Context, slug string, title, content, newSlug *string, tagIDs *[]int64) (model.Note, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return model.Note{}, err
	}
	defer func() { _ = tx.Rollback() }() // no-op once Commit succeeds

	var existingID int64
	if err := tx.QueryRowContext(ctx, `SELECT id FROM notes WHERE slug = ?`, slug).Scan(&existingID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return model.Note{}, ErrNotFound
		}
		return model.Note{}, err
	}

	sets := []string{"updated_at = ?", "version = version + 1"}
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
	args = append(args, existingID)

	_, err = tx.ExecContext(ctx,
		"UPDATE notes SET "+strings.Join(sets, ", ")+" WHERE id = ?", args...)
	if isUniqueViolation(err) {
		return model.Note{}, ErrConflict
	}
	if err != nil {
		return model.Note{}, err
	}

	if tagIDs != nil {
		if err := setNoteTags(ctx, tx, existingID, *tagIDs); err != nil {
			return model.Note{}, err
		}
	}

	if err := tx.Commit(); err != nil {
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
// List returns a page of note summaries and the total matching count. tagSlug,
// when non-empty, restricts results to notes carrying that tag (combined with
// the FTS filter via AND when both are present).
func (r *NoteRepository) List(ctx context.Context, query, tagSlug string, limit, offset int) ([]model.NoteSummary, int, error) {
	if q := sanitizeFTSQuery(query); q != "" {
		return r.search(ctx, q, tagSlug, limit, offset)
	}
	return r.browse(ctx, tagSlug, limit, offset)
}

// attachTags batches a single tagsForNoteIDs lookup for the whole page (never
// one query per row) and assigns each summary's Tags, defaulting to an empty
// (non-nil) slice.
func attachTags(ctx context.Context, db *sql.DB, notes []model.NoteSummary, ids []int64) error {
	byID, err := tagsForNoteIDs(ctx, db, ids)
	if err != nil {
		return err
	}
	for i, id := range ids {
		notes[i].Tags = byID[id]
		if notes[i].Tags == nil {
			notes[i].Tags = []model.Tag{}
		}
	}
	return nil
}

func (r *NoteRepository) browse(ctx context.Context, tagSlug string, limit, offset int) ([]model.NoteSummary, int, error) {
	var total int
	var countQuery, listQuery string
	var countArgs, listArgs []any

	if tagSlug == "" {
		countQuery = `SELECT COUNT(*) FROM notes`
		listQuery = `
			SELECT id, slug, title, created_at, updated_at, substr(content, 1, 501), version
			FROM notes
			ORDER BY updated_at DESC, id DESC
			LIMIT ? OFFSET ?`
		listArgs = []any{limit, offset}
	} else {
		countQuery = `
			SELECT COUNT(*) FROM notes n
			JOIN note_tags nt ON nt.note_id = n.id
			JOIN tags t ON t.id = nt.tag_id
			WHERE t.slug = ?`
		countArgs = []any{tagSlug}
		listQuery = `
			SELECT n.id, n.slug, n.title, n.created_at, n.updated_at, substr(n.content, 1, 501), n.version
			FROM notes n
			JOIN note_tags nt ON nt.note_id = n.id
			JOIN tags t ON t.id = nt.tag_id
			WHERE t.slug = ?
			ORDER BY n.updated_at DESC, n.id DESC
			LIMIT ? OFFSET ?`
		listArgs = []any{tagSlug, limit, offset}
	}

	if err := r.db.QueryRowContext(ctx, countQuery, countArgs...).Scan(&total); err != nil {
		return nil, 0, err
	}

	rows, err := r.db.QueryContext(ctx, listQuery, listArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	notes := make([]model.NoteSummary, 0)
	ids := make([]int64, 0)
	for rows.Next() {
		var (
			id                   int64
			s                    model.NoteSummary
			createdAt, updatedAt string
			probe                string
		)
		if err := rows.Scan(&id, &s.Slug, &s.Title, &createdAt, &updatedAt, &probe, &s.Version); err != nil {
			return nil, 0, err
		}
		s.CreatedAt, _ = time.Parse(rfc3339, createdAt)
		s.UpdatedAt, _ = time.Parse(rfc3339, updatedAt)
		s.Excerpt = plainExcerpt(probe)
		notes = append(notes, s)
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if err := attachTags(ctx, r.db, notes, ids); err != nil {
		return nil, 0, err
	}
	return notes, total, nil
}

func (r *NoteRepository) search(ctx context.Context, q, tagSlug string, limit, offset int) ([]model.NoteSummary, int, error) {
	var total int
	var countQuery, listQuery string
	var countArgs, listArgs []any

	if tagSlug == "" {
		countQuery = `SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH ?`
		countArgs = []any{q}
		// snippet() marks matched terms with sentinel control chars U+0002/U+0003
		// (not HTML); content is column index 1. We also pull the plain prefix to
		// fall back on for title-only matches (empty snippet) and empty content.
		// FTS5 auxiliary functions (snippet/rank) and the MATCH operator must
		// reference the FTS table by its real name, not a join alias.
		listQuery = `
			SELECT n.id, n.slug, n.title, n.created_at, n.updated_at,
			       snippet(notes_fts, 1, char(2), char(3), '…', 30),
			       substr(n.content, 1, 201),
			       n.version
			FROM notes n
			JOIN notes_fts ON notes_fts.rowid = n.id
			WHERE notes_fts MATCH ?
			ORDER BY notes_fts.rank, n.id DESC
			LIMIT ? OFFSET ?`
		listArgs = []any{q, limit, offset}
	} else {
		countQuery = `
			SELECT COUNT(*) FROM notes_fts
			JOIN notes n ON n.id = notes_fts.rowid
			JOIN note_tags nt ON nt.note_id = n.id
			JOIN tags t ON t.id = nt.tag_id
			WHERE notes_fts MATCH ? AND t.slug = ?`
		countArgs = []any{q, tagSlug}
		listQuery = `
			SELECT n.id, n.slug, n.title, n.created_at, n.updated_at,
			       snippet(notes_fts, 1, char(2), char(3), '…', 30),
			       substr(n.content, 1, 201),
			       n.version
			FROM notes n
			JOIN notes_fts ON notes_fts.rowid = n.id
			JOIN note_tags nt ON nt.note_id = n.id
			JOIN tags t ON t.id = nt.tag_id
			WHERE notes_fts MATCH ? AND t.slug = ?
			ORDER BY notes_fts.rank, n.id DESC
			LIMIT ? OFFSET ?`
		listArgs = []any{q, tagSlug, limit, offset}
	}

	if err := r.db.QueryRowContext(ctx, countQuery, countArgs...).Scan(&total); err != nil {
		return nil, 0, err
	}

	rows, err := r.db.QueryContext(ctx, listQuery, listArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	notes := make([]model.NoteSummary, 0)
	ids := make([]int64, 0)
	for rows.Next() {
		var (
			id                   int64
			s                    model.NoteSummary
			createdAt, updatedAt string
			snip                 string
			probe                string
		)
		if err := rows.Scan(&id, &s.Slug, &s.Title, &createdAt, &updatedAt, &snip, &probe, &s.Version); err != nil {
			return nil, 0, err
		}
		s.CreatedAt, _ = time.Parse(rfc3339, createdAt)
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
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if err := attachTags(ctx, r.db, notes, ids); err != nil {
		return nil, 0, err
	}
	return notes, total, nil
}

// plainExcerpt finds the first non-heading, non-blank line in the Markdown
// probe, ignoring raw HTML blocks (including SVG and MathML), strips inline
// Markdown syntax, and truncates at ~120 runes.
func plainExcerpt(probe string) string {
	lines := strings.Split(probe, "\n")
	for i := 0; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		if line == "" || strings.HasPrefix(line, "#") || mdHRuleRE.MatchString(line) {
			continue
		}
		if m := mdHTMLTagRE.FindStringSubmatch(line); m != nil {
			closing, tag, selfClosing := m[1] == "/", strings.ToLower(m[2]), m[3] == "/"
			if !closing && !selfClosing && !voidHTMLTags[tag] {
				closeTag := "</" + tag
				if !strings.Contains(strings.ToLower(line), closeTag) {
					for i++; i < len(lines) && !strings.Contains(strings.ToLower(lines[i]), closeTag); i++ {
					}
				}
			}
			continue
		}
		// Strip blockquote markers
		for strings.HasPrefix(line, ">") {
			line = strings.TrimSpace(line[1:])
		}
		// Strip unordered list markers
		if len(line) >= 2 && (line[0] == '-' || line[0] == '*' || line[0] == '+') && line[1] == ' ' {
			line = strings.TrimSpace(line[2:])
		}
		// Strip ordered list markers
		if m := mdOrderedListRE.FindStringIndex(line); m != nil {
			line = line[m[1]:]
		}
		// Remove images, convert links to their text
		line = mdImageRE.ReplaceAllString(line, "")
		line = mdLinkRE.ReplaceAllString(line, "$1")
		// Remove inline code backticks (keep content)
		line = mdCodeRE.ReplaceAllString(line, "$1")
		// Remove strikethrough
		line = mdStrikeRE.ReplaceAllString(line, "$1")
		// Remove bold/italic markers (order: *** → ** → *)
		line = strings.ReplaceAll(line, "***", "")
		line = strings.ReplaceAll(line, "**", "")
		line = strings.ReplaceAll(line, "__", "")
		line = strings.ReplaceAll(line, "*", "")
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		runes := []rune(line)
		if len(runes) > 120 {
			return string(runes[:120]) + "…"
		}
		return line
	}
	return ""
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
