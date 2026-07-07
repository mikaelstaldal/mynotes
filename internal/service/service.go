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
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/mikaelstaldal/mynotes/internal/htmlmd"
	"github.com/mikaelstaldal/mynotes/internal/model"
	"github.com/mikaelstaldal/mynotes/internal/repository"
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
	// ErrVersionMismatch is returned when an If-Match ETag does not match the
	// note's current version (optimistic locking failure).
	ErrVersionMismatch = errors.New("version mismatch")
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
	tags *repository.TagRepository
}

func NewNoteService(repo *repository.NoteRepository, tags *repository.TagRepository) *NoteService {
	return &NoteService{repo: repo, tags: tags}
}

// List returns a page of note summaries and the total matching count. limit and
// offset are clamped to a sane window. tagSlug, when non-empty, restricts
// results to notes carrying that tag. titlePrefix, when set, matches query as a
// case-insensitive prefix of the note title instead of a full-text search. sort
// and order select the browse ordering (see repository.browseOrderClause) and
// are normalized here so only known-safe values reach the SQL builder; they are
// ignored for the search and title-prefix branches.
func (s *NoteService) List(ctx context.Context, query, tagSlug string, titlePrefix bool, sort, order string, limit, offset int) ([]model.NoteSummary, int, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	return s.repo.List(ctx, query, tagSlug, titlePrefix, normalizeSort(sort), normalizeOrder(order), limit, offset)
}

// normalizeSort maps an untrusted sort field to a known value, defaulting to
// "updated". The OpenAPI enum already restricts the HTTP surface; this is the
// authoritative guard for direct service callers (and defense in depth).
func normalizeSort(sort string) string {
	switch sort {
	case repository.SortCreated, repository.SortTitle, repository.SortUpdated:
		return sort
	default:
		return repository.SortUpdated
	}
}

// normalizeOrder maps an untrusted order direction to "asc" or "desc",
// defaulting to "desc".
func normalizeOrder(order string) string {
	if order == repository.OrderAsc {
		return repository.OrderAsc
	}
	return repository.OrderDesc
}

// resolveTagIDs de-dupes tagSlugs, resolves them to ids in one query, and
// validates that every slug refers to an existing tag — tags must be created
// explicitly (POST /tags) before they can be attached to a note, so an
// unknown slug is a validation error, not a not-found.
func (s *NoteService) resolveTagIDs(ctx context.Context, tagSlugs []string) ([]int64, error) {
	dedup := dedupeStrings(tagSlugs)
	if len(dedup) == 0 {
		return nil, nil
	}
	found, err := s.tags.GetBySlugs(ctx, dedup)
	if err != nil {
		return nil, err
	}
	bySlug := make(map[string]model.Tag, len(found))
	for _, t := range found {
		bySlug[t.Slug] = t
	}
	ids := make([]int64, 0, len(dedup))
	for _, slug := range dedup {
		t, ok := bySlug[slug]
		if !ok {
			return nil, validationError("unknown tag: " + slug)
		}
		ids = append(ids, t.ID)
	}
	return ids, nil
}

func dedupeStrings(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// Get returns the full note addressed by slug, or ErrNotFound.
func (s *NoteService) Get(ctx context.Context, slug string) (model.Note, error) {
	return s.repo.GetBySlug(ctx, slug)
}

// Create stores a new note. content nil/absent coalesces to "" (the service
// owns the default, not the OpenAPI schema). slug nil derives a slug from the
// title and de-conflicts it with a numeric suffix; an explicit slug is used
// verbatim and a collision is ErrConflict (never suffixed). created_at and
// updated_at are set to the same instant by the repository. tagSlugs must
// name existing tags (created via POST /tags) — an unknown slug is a
// validation error.
func (s *NoteService) Create(ctx context.Context, title string, content, slug *string, tagSlugs []string) (model.Note, error) {
	return s.createNote(ctx, title, content, slug, time.Time{}, tagSlugs)
}

// createNote is the internal implementation shared by Create and the import
// paths. createdAt zero means "use the current time".
func (s *NoteService) createNote(ctx context.Context, title string, content, slug *string, createdAt time.Time, tagSlugs []string) (model.Note, error) {
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

	tagIDs, err := s.resolveTagIDs(ctx, tagSlugs)
	if err != nil {
		return model.Note{}, err
	}

	ts := createdAt
	if ts.IsZero() {
		ts = time.Now().UTC()
	}

	// Explicit slug: validate and insert as-is. A collision is a 409, never
	// resolved with a suffix.
	if slug != nil {
		if err := validateSlug(*slug); err != nil {
			return model.Note{}, err
		}
		note, err := s.repo.CreateWithTime(ctx, *slug, title, body, ts, tagIDs)
		return note, mapTagErr(err)
	}

	// Auto-generated slug: scan for a free suffix, insert, and on a racy UNIQUE
	// violation re-scan and retry, bounded by maxSlugAttempts.
	base := generateSlug(title)
	for range maxSlugAttempts {
		candidate, err := s.uniqueSlug(ctx, base)
		if err != nil {
			return model.Note{}, err
		}
		note, err := s.repo.CreateWithTime(ctx, candidate, title, body, ts, tagIDs)
		if errors.Is(err, ErrConflict) {
			continue
		}
		if err != nil {
			return model.Note{}, mapTagErr(err)
		}
		return note, nil
	}
	// Exhausted attempts: surface as a generic 500, not a 409.
	return model.Note{}, errors.New("could not allocate a unique slug")
}

// mapTagErr translates the rare repository.ErrUnknownTag race (a tag deleted
// between resolveTagIDs and the write transaction) into a validation error,
// so it surfaces as 400 rather than an unmapped 500.
func mapTagErr(err error) error {
	if errors.Is(err, repository.ErrUnknownTag) {
		return validationError("a tag was deleted before the note could be saved; please retry")
	}
	return err
}

// Update applies a partial (PATCH) update. nil fields are absent and left
// unchanged. All-fields-absent is rejected. Each present field is validated,
// then diffed against the stored note (title post-TrimSpace, content verbatim,
// tags as a resolved id set); if nothing differs no SQL UPDATE runs and the
// unchanged note is returned. Otherwise only the changed columns are written
// and updated_at is bumped. tags nil leaves the note's tags unchanged; a
// non-nil (possibly empty) slice of tag slugs replaces the full set — an
// unknown slug is a validation error. ifMatch, when non-nil, is compared
// against the stored version; a mismatch returns ErrVersionMismatch
// (optimistic locking).
func (s *NoteService) Update(ctx context.Context, slug string, title, content *string, tags *[]string, ifMatch *string) (model.Note, error) {
	if title == nil && content == nil && tags == nil {
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

	var tagIDs []int64
	if tags != nil {
		ids, err := s.resolveTagIDs(ctx, *tags)
		if err != nil {
			return model.Note{}, err
		}
		tagIDs = ids
	}

	existing, err := s.repo.GetBySlug(ctx, slug)
	if err != nil {
		return model.Note{}, err
	}

	if ifMatch != nil {
		etag := strings.Trim(*ifMatch, `"`)
		expectedVer, parseErr := strconv.Atoi(etag)
		if parseErr != nil || expectedVer != existing.Version {
			return model.Note{}, ErrVersionMismatch
		}
	}

	// Diff each present field; only the genuinely-changed columns are written.
	var changedTitle, changedContent *string
	if title != nil && *title != existing.Title {
		changedTitle = title
	}
	if content != nil && *content != existing.Content {
		changedContent = content
	}
	var changedTagIDs *[]int64
	if tags != nil && !sameTagSet(tagIDs, existing.Tags) {
		changedTagIDs = &tagIDs
	}

	// No-op: nothing differs, so issue no UPDATE and return the note untouched.
	if changedTitle == nil && changedContent == nil && changedTagIDs == nil {
		return existing, nil
	}

	note, err := s.repo.Update(ctx, slug, changedTitle, changedContent, nil, changedTagIDs)
	return note, mapTagErr(err)
}

// sameTagSet reports whether ids (already de-duped, from resolveTagIDs) names
// the same set of tags as existing, order-independent.
func sameTagSet(ids []int64, existing []model.Tag) bool {
	if len(ids) != len(existing) {
		return false
	}
	have := make(map[int64]bool, len(existing))
	for _, t := range existing {
		have[t.ID] = true
	}
	for _, id := range ids {
		if !have[id] {
			return false
		}
	}
	return true
}

// Delete removes the note addressed by slug, or returns ErrNotFound.
func (s *NoteService) Delete(ctx context.Context, slug string) error {
	return s.repo.Delete(ctx, slug)
}

// atxHeadingRe matches an ATX heading line and captures the heading text.
var atxHeadingRe = regexp.MustCompile(`^#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$`)

// ImportHTML converts an HTML document to Markdown and creates a note.
// Title priority: (1) <title> element, (2) first h1–h6 in the body,
// (3) first ATX heading in the produced Markdown, (4) empty string, which
// validateTitle rejects as "title is required" → 400 Bad Request.
func (s *NoteService) ImportHTML(ctx context.Context, htmlContent string) (model.Note, error) {
	result, err := htmlmd.Convert(htmlContent)
	if err != nil {
		return model.Note{}, validationError("invalid HTML: " + err.Error())
	}

	title := result.Title
	if title == "" {
		title = firstATXHeading(result.Content)
	}
	if runes := []rune(title); len(runes) > maxTitleLen {
		title = string(runes[:maxTitleLen-1]) + "…"
	}

	content := result.Content
	return s.Create(ctx, title, &content, nil, nil)
}

// ImportMarkdown stores Markdown content directly as a note. Title priority:
// (1) frontmatter `title` field (YAML/TOML/JSON), (2) first ATX heading in
// the content after stripping frontmatter. An empty title is a validation
// error (400 Bad Request). The frontmatter `date` field sets created_at when
// present (otherwise current time). The frontmatter `slug` field is used
// verbatim when present (otherwise derived from the title).
func (s *NoteService) ImportMarkdown(ctx context.Context, markdownContent string) (model.Note, error) {
	fm, content := parseFrontmatter(markdownContent)

	title := fm.Title
	if title == "" {
		title = firstATXHeading(content)
	}
	if runes := []rune(title); len(runes) > maxTitleLen {
		title = string(runes[:maxTitleLen-1]) + "…"
	}

	var slugPtr *string
	if fm.Slug != "" {
		slugPtr = &fm.Slug
	}

	return s.createNote(ctx, title, &content, slugPtr, fm.Date, nil)
}

// firstATXHeading scans Markdown content for the first ATX heading line,
// skipping fenced code blocks. Mirrors the TypeScript titleFromContent logic.
func firstATXHeading(content string) string {
	var fenceChar byte
	fenceLen := 0
	for line := range strings.SplitSeq(content, "\n") {
		if fenceLen == 0 {
			b := []byte(line)
			if len(b) >= 3 && (b[0] == '`' || b[0] == '~') {
				n := 0
				for n < len(b) && b[n] == b[0] {
					n++
				}
				if n >= 3 {
					fenceChar = b[0]
					fenceLen = n
					continue
				}
			}
			if m := atxHeadingRe.FindStringSubmatch(line); m != nil {
				return strings.TrimSpace(m[1])
			}
		} else {
			b := []byte(line)
			n := 0
			for n < len(b) && b[n] == fenceChar {
				n++
			}
			if n >= fenceLen && strings.TrimSpace(string(b[n:])) == "" {
				fenceLen = 0
				fenceChar = 0
			}
		}
	}
	return ""
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

// validateContent checks verbatim Markdown content: valid UTF-8, within
// maxContentLen, and structurally safe (no disallowed embedded HTML, no
// link/image destination with a disallowed scheme, no excessive nesting, no
// stray C0 control characters — see validateMarkdownStructure). Content is never
// trimmed or otherwise mutated; this only accepts or rejects.
func validateContent(content string) error {
	if !utf8.ValidString(content) {
		return validationError("content is not valid UTF-8")
	}
	if utf8.RuneCountInString(content) > maxContentLen {
		return validationError("content is too long")
	}
	return validateMarkdownStructure(content)
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
