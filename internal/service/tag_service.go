package service

import (
	"context"

	"github.com/mikaelstaldal/mynotes/internal/model"
	"github.com/mikaelstaldal/mynotes/internal/repository"
)

// TagService is the use-case API for tags. Tags must be created explicitly
// (this is the only entry point that creates one) before they can be
// attached to a note — see NoteService.resolveTagIDs.
type TagService struct {
	repo *repository.TagRepository
}

func NewTagService(repo *repository.TagRepository) *TagService {
	return &TagService{repo: repo}
}

// List returns every tag, sorted by slug.
func (s *TagService) List(ctx context.Context) ([]model.Tag, error) {
	return s.repo.List(ctx)
}

// Create stores a new tag identified solely by its slug (which is also its
// display label). The slug is validated against the shared slug pattern and
// used verbatim; a collision with an existing tag is ErrConflict (never
// suffixed).
func (s *TagService) Create(ctx context.Context, slug string) (model.Tag, error) {
	if err := validateSlug(slug); err != nil {
		return model.Tag{}, err
	}
	return s.repo.Create(ctx, slug)
}

// Delete removes the tag, detaching it from every note that had it (via
// ON DELETE CASCADE) — no orphan-prevention, mirroring artifact deletion.
func (s *TagService) Delete(ctx context.Context, slug string) error {
	return s.repo.Delete(ctx, slug)
}
