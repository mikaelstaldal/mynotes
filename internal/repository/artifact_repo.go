package repository

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/mikaelstaldal/mynotes/internal/model"
)

// ArtifactRepository is the storage gateway for binary artifacts. Artifacts are
// content-addressed: the SHA-256 hex digest of the content is the primary key.
type ArtifactRepository struct {
	db *sql.DB
}

func NewArtifactRepository(db *sql.DB) *ArtifactRepository {
	return &ArtifactRepository{db: db}
}

func scanArtifact(s interface{ Scan(...any) error }) (model.Artifact, error) {
	var (
		a         model.Artifact
		createdAt string
	)
	if err := s.Scan(&a.SHA256, &a.Content, &a.ContentType, &createdAt); err != nil {
		return model.Artifact{}, err
	}
	a.CreatedAt, _ = time.Parse(rfc3339, createdAt)
	return a, nil
}

// Create stores the artifact if it does not already exist, then returns the
// stored record. Uploading the same bytes twice is idempotent.
func (r *ArtifactRepository) Create(ctx context.Context, sha256 string, content []byte, contentType string, createdAt time.Time) (model.Artifact, error) {
	ts := createdAt.UTC().Format(rfc3339)
	_, err := r.db.ExecContext(ctx,
		`INSERT OR IGNORE INTO artifacts (sha256, content, content_type, created_at) VALUES (?, ?, ?, ?)`,
		sha256, content, contentType, ts)
	if err != nil {
		return model.Artifact{}, err
	}
	return r.GetBySHA256(ctx, sha256)
}

// GetBySHA256 returns the artifact with the given hex digest, or ErrNotFound.
func (r *ArtifactRepository) GetBySHA256(ctx context.Context, sha256 string) (model.Artifact, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT sha256, content, content_type, created_at FROM artifacts WHERE sha256 = ?`, sha256)
	a, err := scanArtifact(row)
	if errors.Is(err, sql.ErrNoRows) {
		return model.Artifact{}, ErrNotFound
	}
	return a, err
}

// Delete removes the artifact with the given hex digest. Returns ErrNotFound if
// no such artifact exists.
func (r *ArtifactRepository) Delete(ctx context.Context, sha256 string) error {
	res, err := r.db.ExecContext(ctx, `DELETE FROM artifacts WHERE sha256 = ?`, sha256)
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
