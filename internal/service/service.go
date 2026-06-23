// Package service holds business logic. It sits between the HTTP handler and
// the repository: it validates input, derives and de-conflicts slugs, and
// translates storage errors into typed sentinel errors the handler can map to
// HTTP status codes.
//
// Note content is stored verbatim Markdown — the service never mutates it. The
// authoritative embedded-HTML gate is the render-time DOMPurify pass on the
// frontend; this layer only validates structure (UTF-8, length).
package service

import (
	"context"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/mikaelstaldal/go-web-template/internal/model"
	"github.com/mikaelstaldal/go-web-template/internal/repository"
	"golang.org/x/text/unicode/norm"
)

const (
	maxTitleLen   = 200
	maxContentLen = 1_000_000
	maxSlugLen    = 100

	// maxSlugAttempts bounds the auto-slug insert retry loop. The service's
	// existence check is advisory/racy, so a concurrent writer can take the slug
	// between the scan and the insert; on a UNIQUE violation we re-scan and retry,
	// giving up (500) after this many attempts.
	maxSlugAttempts = 5

	// fallbackSlug is used when a title yields no slug-safe characters.
	fallbackSlug = "note"
)

var (
	// ErrNotFound is returned when the target note does not exist.
	ErrNotFound = repository.ErrNotFound
	// ErrConflict is returned when an explicit slug (on create or rename) is
	// already taken. Auto-generated slugs are de-conflicted with a suffix instead.
	ErrConflict = repository.ErrConflict
	// ErrValidation wraps a human-readable validation failure.
	ErrValidation = errors.New("validation error")
)

// slugPattern mirrors the OpenAPI slug constraint: lowercase alphanumerics in
// hyphen-separated groups, no leading/trailing/double hyphen.
var slugPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

func validationError(msg string) error {
	return errVal{msg}
}

// errVal carries a validation message while satisfying errors.Is(ErrValidation).
type errVal struct{ msg string }

func (e errVal) Error() string        { return e.msg }
func (e errVal) Is(target error) bool { return target == ErrValidation }

// NoteService is the use-case API for notes.
type NoteService struct {
	repo *repository.NoteRepository
}

func NewNoteService(repo *repository.NoteRepository) *NoteService {
	return &NoteService{repo: repo}
}

// List returns a page of note summaries and the total matching count. limit and
// offset are clamped to a sane window.
func (s *NoteService) List(ctx context.Context, query string, limit, offset int) ([]model.NoteSummary, int, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	return s.repo.List(ctx, query, limit, offset)
}

// Get returns the full note addressed by slug, or ErrNotFound.
func (s *NoteService) Get(ctx context.Context, slug string) (model.Note, error) {
	return s.repo.GetBySlug(ctx, slug)
}

// Create stores a new note. content nil/absent coalesces to "" (the service
// owns the default, not the OpenAPI schema). slug nil derives a slug from the
// title and de-conflicts it with a numeric suffix; an explicit slug is used
// verbatim and a collision is ErrConflict (never suffixed). created_at and
// updated_at are set to the same instant by the repository.
func (s *NoteService) Create(ctx context.Context, title string, content, slug *string) (model.Note, error) {
	title = strings.TrimSpace(title)
	if err := validateTitle(title); err != nil {
		return model.Note{}, err
	}

	body := ""
	if content != nil {
		body = *content
	}
	if err := validateContent(body); err != nil {
		return model.Note{}, err
	}

	// Explicit slug: validate and insert as-is. A collision is a 409, never
	// resolved with a suffix.
	if slug != nil {
		if err := validateSlug(*slug); err != nil {
			return model.Note{}, err
		}
		return s.repo.Create(ctx, *slug, title, body)
	}

	// Auto-generated slug: scan for a free suffix, insert, and on a racy UNIQUE
	// violation re-scan and retry, bounded by maxSlugAttempts.
	base := generateSlug(title)
	for range maxSlugAttempts {
		candidate, err := s.uniqueSlug(ctx, base)
		if err != nil {
			return model.Note{}, err
		}
		note, err := s.repo.Create(ctx, candidate, title, body)
		if errors.Is(err, ErrConflict) {
			continue
		}
		if err != nil {
			return model.Note{}, err
		}
		return note, nil
	}
	// Exhausted attempts: surface as a generic 500, not a 409.
	return model.Note{}, errors.New("could not allocate a unique slug")
}

// Update applies a partial (PATCH) update. nil fields are absent and left
// unchanged. All-fields-absent is rejected. Each present field is validated,
// then diffed against the stored note (title post-TrimSpace, content verbatim,
// slug against its own current value); if nothing differs no SQL UPDATE runs and
// the unchanged note is returned. Otherwise only the changed columns are written
// and updated_at is bumped. A slug rename onto a taken slug is ErrConflict.
func (s *NoteService) Update(ctx context.Context, slug string, title, content, newSlug *string) (model.Note, error) {
	if title == nil && content == nil && newSlug == nil {
		return model.Note{}, validationError("no fields to update")
	}

	if title != nil {
		trimmed := strings.TrimSpace(*title)
		if err := validateTitle(trimmed); err != nil {
			return model.Note{}, err
		}
		title = &trimmed
	}
	if content != nil {
		if err := validateContent(*content); err != nil {
			return model.Note{}, err
		}
	}
	if newSlug != nil {
		if err := validateSlug(*newSlug); err != nil {
			return model.Note{}, err
		}
	}

	existing, err := s.repo.GetBySlug(ctx, slug)
	if err != nil {
		return model.Note{}, err
	}

	// Diff each present field; only the genuinely-changed columns are written.
	var changedTitle, changedContent, changedSlug *string
	if title != nil && *title != existing.Title {
		changedTitle = title
	}
	if content != nil && *content != existing.Content {
		changedContent = content
	}
	if newSlug != nil && *newSlug != existing.Slug {
		changedSlug = newSlug
	}

	// No-op: nothing differs, so issue no UPDATE and return the note untouched.
	if changedTitle == nil && changedContent == nil && changedSlug == nil {
		return existing, nil
	}

	return s.repo.Update(ctx, slug, changedTitle, changedContent, changedSlug)
}

// Delete removes the note addressed by slug, or returns ErrNotFound.
func (s *NoteService) Delete(ctx context.Context, slug string) error {
	return s.repo.Delete(ctx, slug)
}

// uniqueSlug returns base if free, otherwise base-2, base-3, … picking the first
// slug not already present. The check is advisory (the DB UNIQUE constraint is
// authoritative); the caller retries on a racy collision.
func (s *NoteService) uniqueSlug(ctx context.Context, base string) (string, error) {
	candidate := base
	for n := 2; ; n++ {
		exists, err := s.repo.SlugExists(ctx, candidate, 0)
		if err != nil {
			return "", err
		}
		if !exists {
			return candidate, nil
		}
		candidate = withSuffix(base, n)
	}
}

// withSuffix appends "-n" to base, first truncating base so base+suffix fits in
// maxSlugLen and re-trimming any trailing hyphen so the result is never "foo--2".
func withSuffix(base string, n int) string {
	suffix := "-" + strconv.Itoa(n)
	if maxBase := maxSlugLen - len(suffix); len(base) > maxBase {
		base = strings.TrimRight(base[:maxBase], "-")
	}
	return base + suffix
}

// generateSlug derives a slug from a title: lowercase, fold accents (NFKD then
// drop combining marks), drop remaining non-ASCII, collapse runs of other
// characters to a single hyphen, trim, and truncate to maxSlugLen (re-trimming a
// trailing hyphen). An empty result falls back to "note".
func generateSlug(title string) string {
	decomposed := norm.NFKD.String(strings.ToLower(title))

	var b strings.Builder
	dash := false // collapse consecutive separators into a single hyphen
	for _, r := range decomposed {
		switch {
		case unicode.Is(unicode.Mn, r):
			// Combining mark from NFKD decomposition (the accent) — drop it.
		case r >= 'a' && r <= 'z' || r >= '0' && r <= '9':
			b.WriteRune(r)
			dash = false
		case r > unicode.MaxASCII:
			// Remaining non-ASCII letters/symbols are dropped, not separated.
		default:
			// Any other ASCII (space, punctuation) becomes a separator.
			if !dash && b.Len() > 0 {
				b.WriteByte('-')
				dash = true
			}
		}
	}

	slug := strings.TrimRight(b.String(), "-")
	if len(slug) > maxSlugLen {
		slug = strings.TrimRight(slug[:maxSlugLen], "-")
	}
	if slug == "" {
		return fallbackSlug
	}
	return slug
}

// validateTitle assumes a pre-trimmed title. It rejects an empty (i.e.
// whitespace-only) title, invalid UTF-8, any C0 control char (tab/newline/CR
// included), and titles past maxTitleLen.
func validateTitle(title string) error {
	if title == "" {
		return validationError("title is required")
	}
	if !utf8.ValidString(title) {
		return validationError("title is not valid UTF-8")
	}
	for _, r := range title {
		if r < 0x20 {
			return validationError("title must not contain control characters")
		}
	}
	if utf8.RuneCountInString(title) > maxTitleLen {
		return validationError("title is too long")
	}
	return nil
}

// validateContent checks verbatim Markdown content: valid UTF-8 and within
// maxContentLen. Content is never trimmed or otherwise mutated.
func validateContent(content string) error {
	if !utf8.ValidString(content) {
		return validationError("content is not valid UTF-8")
	}
	if utf8.RuneCountInString(content) > maxContentLen {
		return validationError("content is too long")
	}
	return nil
}

// validateSlug checks an explicit (client-supplied) slug against the OpenAPI
// pattern and length.
func validateSlug(slug string) error {
	if utf8.RuneCountInString(slug) > maxSlugLen {
		return validationError("slug is too long")
	}
	if !slugPattern.MatchString(slug) {
		return validationError("slug must be lowercase alphanumerics separated by single hyphens")
	}
	return nil
}
