package repository

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/mikaelstaldal/mynotes/internal/model"
)

// PublishedNoteRepository is the storage gateway for published notes: the
// rendered HTML snapshot of a note and the set of artifacts that snapshot
// references. Rows are keyed by the internal note id (which stays inside this
// package) and cascade away when the note is deleted, so deleting a note
// unpublishes it without any service-layer bookkeeping.
type PublishedNoteRepository struct {
	db *sql.DB
}

func NewPublishedNoteRepository(db *sql.DB) *PublishedNoteRepository {
	return &PublishedNoteRepository{db: db}
}

// Publish stores (or replaces) a note's published snapshot together with the
// digests of the artifacts its HTML references. Both writes run in one
// transaction so the artifact allow-list can never disagree with the HTML that
// needs it. digests must already be validated; they are stored verbatim.
func (r *PublishedNoteRepository) Publish(ctx context.Context, noteID int64, title, html string, digests []string, at time.Time) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }() // no-op once Commit succeeds

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO published_notes (note_id, title, html, published_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(note_id) DO UPDATE SET title = excluded.title, html = excluded.html,
			published_at = excluded.published_at`,
		noteID, title, html, at.UTC().Format(rfc3339)); err != nil {
		return err
	}

	// Full replace, like setNoteTags/setNoteLinks: an artifact dropped from the
	// note since the previous publish must lose its public exposure.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM published_note_artifacts WHERE note_id = ?`, noteID); err != nil {
		return err
	}
	for _, digest := range digests {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO published_note_artifacts (note_id, sha256) VALUES (?, ?)`,
			noteID, digest); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Unpublish removes a note's published snapshot, returning ErrNotFound when the
// note was not published. The artifact rows go with it via ON DELETE CASCADE.
func (r *PublishedNoteRepository) Unpublish(ctx context.Context, noteID int64) error {
	res, err := r.db.ExecContext(ctx, `DELETE FROM published_notes WHERE note_id = ?`, noteID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// GetBySlug returns the published snapshot addressed by the note's slug, or
// ErrNotFound when no note has that slug or the note is not published. This is
// the read behind the unauthenticated public page, so it deliberately cannot
// distinguish the two cases.
func (r *PublishedNoteRepository) GetBySlug(ctx context.Context, slug string) (model.PublishedNote, error) {
	var (
		p           model.PublishedNote
		publishedAt string
	)
	err := r.db.QueryRowContext(ctx, `
		SELECT n.slug, p.title, p.html, p.published_at
		FROM published_notes p
		JOIN notes n ON n.id = p.note_id
		WHERE n.slug = ?`, slug).Scan(&p.Slug, &p.Title, &p.HTML, &publishedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return model.PublishedNote{}, ErrNotFound
	}
	if err != nil {
		return model.PublishedNote{}, err
	}
	p.PublishedAt, _ = time.Parse(rfc3339, publishedAt)
	return p, nil
}

// ArtifactPublished reports whether any currently published note references the
// given artifact digest. It is the gate on the unauthenticated artifact route:
// an artifact no published note uses stays as private as the rest of the store.
func (r *PublishedNoteRepository) ArtifactPublished(ctx context.Context, sha256hex string) (bool, error) {
	var exists bool
	err := r.db.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM published_note_artifacts WHERE sha256 = ?)`, sha256hex).Scan(&exists)
	return exists, err
}

// publishedForNoteIDs returns the publication time of each given note id that is
// currently published, batched into a single query so a page of notes costs one
// extra query total, never one per row. An unpublished id has no map entry.
// Shared by NoteRepository's read paths (see attachPublished).
func publishedForNoteIDs(ctx context.Context, q queryer, ids []int64) (map[int64]time.Time, error) {
	if len(ids) == 0 {
		return map[int64]time.Time{}, nil
	}
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	rows, err := q.QueryContext(ctx, `
		SELECT note_id, published_at FROM published_notes
		WHERE note_id IN (`+sqlPlaceholders(len(ids))+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make(map[int64]time.Time)
	for rows.Next() {
		var (
			noteID      int64
			publishedAt string
		)
		if err := rows.Scan(&noteID, &publishedAt); err != nil {
			return nil, err
		}
		t, _ := time.Parse(rfc3339, publishedAt)
		out[noteID] = t
	}
	return out, rows.Err()
}

// attachPublished batches one publishedForNoteIDs lookup for the whole page —
// never one query per row — and assigns each summary's PublishedAt, leaving it
// nil for an unpublished note. ids is aligned with notes (same order).
func attachPublished(ctx context.Context, db *sql.DB, notes []model.NoteSummary, ids []int64) error {
	byID, err := publishedForNoteIDs(ctx, db, ids)
	if err != nil {
		return err
	}
	for i, id := range ids {
		if at, ok := byID[id]; ok {
			notes[i].PublishedAt = &at
		}
	}
	return nil
}
