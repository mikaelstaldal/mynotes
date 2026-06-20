// Package service holds business logic. It sits between the HTTP handler and
// the repository: it validates input, sanitizes untrusted content, and
// translates storage errors into typed sentinel errors the handler can map to
// HTTP status codes.
package service

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/mikaelstaldal/go-web-template/internal/model"
	"github.com/mikaelstaldal/go-web-template/internal/repository"
	"github.com/mikaelstaldal/go-web-template/internal/sanitize"
)

const (
	maxTitleLen   = 200
	maxContentLen = 100_000
)

var (
	// ErrNotFound is returned when the target item does not exist.
	ErrNotFound = repository.ErrNotFound
	// ErrValidation wraps a human-readable validation failure.
	ErrValidation = errors.New("validation error")
)

func validationError(msg string) error {
	return errVal{msg}
}

// errVal carries a validation message while satisfying errors.Is(ErrValidation).
type errVal struct{ msg string }

func (e errVal) Error() string        { return e.msg }
func (e errVal) Is(target error) bool { return target == ErrValidation }

// ItemService is the use-case API for items.
type ItemService struct {
	repo *repository.ItemRepository
}

func NewItemService(repo *repository.ItemRepository) *ItemService {
	return &ItemService{repo: repo}
}

func (s *ItemService) List(ctx context.Context, query string, limit, offset int) ([]model.Item, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	return s.repo.List(ctx, query, limit, offset)
}

func (s *ItemService) Get(ctx context.Context, id int64) (model.Item, error) {
	return s.repo.GetByID(ctx, id)
}

func (s *ItemService) Create(ctx context.Context, title, content string) (model.Item, error) {
	title = strings.TrimSpace(title)
	if err := validateTitle(title); err != nil {
		return model.Item{}, err
	}
	content = sanitize.HTML(content)
	if utf8.RuneCountInString(content) > maxContentLen {
		return model.Item{}, validationError("content is too long")
	}
	return s.repo.Create(ctx, title, content)
}

// Update applies a partial update. nil fields are left unchanged.
func (s *ItemService) Update(ctx context.Context, id int64, title, content *string) (model.Item, error) {
	if title != nil {
		trimmed := strings.TrimSpace(*title)
		if err := validateTitle(trimmed); err != nil {
			return model.Item{}, err
		}
		title = &trimmed
	}
	if content != nil {
		clean := sanitize.HTML(*content)
		if utf8.RuneCountInString(clean) > maxContentLen {
			return model.Item{}, validationError("content is too long")
		}
		content = &clean
	}
	return s.repo.Update(ctx, id, title, content)
}

func (s *ItemService) Delete(ctx context.Context, id int64) error {
	return s.repo.Delete(ctx, id)
}

func validateTitle(title string) error {
	if title == "" {
		return validationError("title is required")
	}
	if utf8.RuneCountInString(title) > maxTitleLen {
		return validationError("title is too long")
	}
	return nil
}
