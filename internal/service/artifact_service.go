package service

import (
	"context"
	"crypto/sha256"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/mikaelstaldal/mynotes/internal/model"
	"github.com/mikaelstaldal/mynotes/internal/repository"
)

var sha256HexPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ArtifactService manages binary artifacts. Content is stored verbatim and
// never mutated; the SHA-256 digest is computed here and used as the key.
type ArtifactService struct {
	repo *repository.ArtifactRepository
}

func NewArtifactService(repo *repository.ArtifactRepository) *ArtifactService {
	return &ArtifactService{repo: repo}
}

// Create computes the SHA-256 of content, stores the artifact (idempotent on
// repeated uploads of the same bytes), and returns the stored record.
func (s *ArtifactService) Create(ctx context.Context, content []byte, contentType string) (model.Artifact, error) {
	if len(content) == 0 {
		return model.Artifact{}, validationError("artifact content must not be empty")
	}
	if contentType == "" || !strings.Contains(contentType, "/") {
		return model.Artifact{}, validationError("invalid content type")
	}
	digest := sha256.Sum256(content)
	hex := fmt.Sprintf("%x", digest)
	return s.repo.Create(ctx, hex, content, contentType, time.Now().UTC())
}

// Get returns the artifact identified by its hex SHA-256 digest.
func (s *ArtifactService) Get(ctx context.Context, sha256hex string) (model.Artifact, error) {
	if !sha256HexPattern.MatchString(sha256hex) {
		return model.Artifact{}, ErrNotFound
	}
	return s.repo.GetBySHA256(ctx, sha256hex)
}

// Delete removes the artifact identified by its hex SHA-256 digest.
func (s *ArtifactService) Delete(ctx context.Context, sha256hex string) error {
	if !sha256HexPattern.MatchString(sha256hex) {
		return ErrNotFound
	}
	return s.repo.Delete(ctx, sha256hex)
}
