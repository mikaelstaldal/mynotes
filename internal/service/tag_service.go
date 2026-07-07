package service

import (
	"context"
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/mikaelstaldal/mynotes/internal/model"
	"github.com/mikaelstaldal/mynotes/internal/repository"
)

// maxTagNameLen bounds a tag's display name, mirroring the note-title cap.
const maxTagNameLen = 100

// TagService is the use-case API for tags. Tags must be created explicitly
// (this is the only entry point that creates one) before they can be
// attached to a note — see NoteService.resolveTagIDs.
type TagService struct {
	repo *repository.TagRepository
}

func NewTagService(repo *repository.TagRepository) *TagService {
	return &TagService{repo: repo}
}

// List returns every tag, sorted by name.
func (s *TagService) List(ctx context.Context) ([]model.Tag, error) {
	return s.repo.List(ctx)
}

// Create stores a new tag. slug nil derives a slug from name (reusing the
// same generateSlug/withSuffix machinery as note slugs) and de-conflicts it
// with a numeric suffix; an explicit slug is used verbatim and a collision is
// ErrConflict (never suffixed) — this mirrors NoteService.createNote exactly.
func (s *TagService) Create(ctx context.Context, name string, slug *string) (model.Tag, error) {
	name = strings.TrimSpace(name)
	if err := validateTagName(name); err != nil {
		return model.Tag{}, err
	}

	if slug != nil {
		if err := validateSlug(*slug); err != nil {
			return model.Tag{}, err
		}
		return s.repo.Create(ctx, *slug, name)
	}

	base := generateSlug(name)
	for range maxSlugAttempts {
		candidate, err := s.uniqueTagSlug(ctx, base)
		if err != nil {
			return model.Tag{}, err
		}
		tag, err := s.repo.Create(ctx, candidate, name)
		if errors.Is(err, ErrConflict) {
			continue
		}
		if err != nil {
			return model.Tag{}, err
		}
		return tag, nil
	}
	return model.Tag{}, errors.New("could not allocate a unique tag slug")
}

// uniqueTagSlug mirrors NoteService.uniqueSlug: an advisory existence check
// (the DB UNIQUE constraint is authoritative) with a numeric-suffix retry.
func (s *TagService) uniqueTagSlug(ctx context.Context, base string) (string, error) {
	candidate := base
	for n := 2; ; n++ {
		exists, err := s.repo.SlugExists(ctx, candidate)
		if err != nil {
			return "", err
		}
		if !exists {
			return candidate, nil
		}
		candidate = withSuffix(base, n)
	}
}

// Delete removes the tag, detaching it from every note that had it (via
// ON DELETE CASCADE) — no orphan-prevention, mirroring artifact deletion.
func (s *TagService) Delete(ctx context.Context, slug string) error {
	return s.repo.Delete(ctx, slug)
}

// validateTagName mirrors validateTitle: non-empty (post-trim), valid UTF-8,
// no Unicode Cc control characters, bounded length.
func validateTagName(name string) error {
	if name == "" {
		return validationError("name is required")
	}
	if !utf8.ValidString(name) {
		return validationError("name is not valid UTF-8")
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return validationError("name must not contain control characters")
		}
	}
	if utf8.RuneCountInString(name) > maxTagNameLen {
		return validationError("name is too long")
	}
	return nil
}
