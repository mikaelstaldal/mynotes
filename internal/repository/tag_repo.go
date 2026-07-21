package repository

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/mikaelstaldal/mynotes/internal/model"
)

// TagRepository is the storage gateway for tags. Tags are addressed by their
// human-readable slug; the internal integer id stays inside this package.
type TagRepository struct {
	db *sql.DB
}

func NewTagRepository(db *sql.DB) *TagRepository {
	return &TagRepository{db: db}
}

func scanTag(s interface{ Scan(...any) error }) (model.Tag, error) {
	var (
		t         model.Tag
		createdAt string
	)
	if err := s.Scan(&t.ID, &t.Slug, &createdAt); err != nil {
		return model.Tag{}, err
	}
	t.CreatedAt, _ = time.Parse(rfc3339, createdAt)
	return t, nil
}

// ListWithCounts returns every tag sorted by slug (case-insensitive), each
// paired with the number of notes carrying it (0 for an unused tag). A LEFT
// JOIN keeps tags with no notes in the result. The dataset is expected to stay
// small for a single-user tool, so this has no paging.
func (r *TagRepository) ListWithCounts(ctx context.Context) ([]model.TagSummary, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT t.slug, COUNT(nt.note_id)
		   FROM tags t
		   LEFT JOIN note_tags nt ON nt.tag_id = t.id
		  GROUP BY t.id, t.slug
		  ORDER BY t.slug COLLATE NOCASE`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	tags := make([]model.TagSummary, 0)
	for rows.Next() {
		var ts model.TagSummary
		if err := rows.Scan(&ts.Slug, &ts.NoteCount); err != nil {
			return nil, err
		}
		tags = append(tags, ts)
	}
	return tags, rows.Err()
}

// GetBySlug returns the tag with the given slug, or ErrNotFound.
func (r *TagRepository) GetBySlug(ctx context.Context, slug string) (model.Tag, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT id, slug, created_at FROM tags WHERE slug = ?`, slug)
	t, err := scanTag(row)
	if errors.Is(err, sql.ErrNoRows) {
		return model.Tag{}, ErrNotFound
	}
	return t, err
}

// GetBySlugs returns the subset of the given slugs that exist as tags, in one
// query. Callers diff the result against the input slugs to find any unknown
// ones.
func (r *TagRepository) GetBySlugs(ctx context.Context, slugs []string) ([]model.Tag, error) {
	if len(slugs) == 0 {
		return nil, nil
	}
	placeholders := make([]string, len(slugs))
	args := make([]any, len(slugs))
	for i, s := range slugs {
		placeholders[i] = "?"
		args[i] = s
	}
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, slug, created_at FROM tags WHERE slug IN (`+strings.Join(placeholders, ",")+`)`,
		args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	tags := make([]model.Tag, 0, len(slugs))
	for rows.Next() {
		t, err := scanTag(rows)
		if err != nil {
			return nil, err
		}
		tags = append(tags, t)
	}
	return tags, rows.Err()
}

// Create inserts a tag with created_at set to now and returns the stored
// record. A duplicate slug surfaces as ErrConflict.
func (r *TagRepository) Create(ctx context.Context, slug string) (model.Tag, error) {
	ts := time.Now().UTC().Format(rfc3339)
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO tags (slug, created_at) VALUES (?, ?)`, slug, ts)
	if isUniqueViolation(err) {
		return model.Tag{}, ErrConflict
	}
	if err != nil {
		return model.Tag{}, err
	}
	return r.GetBySlug(ctx, slug)
}

// Delete removes the tag with the given slug, returning ErrNotFound if none
// exists. ON DELETE CASCADE on note_tags detaches it from every note that had
// it — no orphan-prevention, mirroring ArtifactRepository.Delete's policy.
func (r *TagRepository) Delete(ctx context.Context, slug string) error {
	res, err := r.db.ExecContext(ctx, `DELETE FROM tags WHERE slug = ?`, slug)
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
