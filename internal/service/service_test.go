package service

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mikaelstaldal/mynotes/internal/repository"

	_ "modernc.org/sqlite"
)

// newTestService builds a NoteService backed by a fresh in-memory SQLite DB with
// the full schema migrated, mirroring the repository package's test setup.
func newTestService(t *testing.T) *NoteService {
	t.Helper()
	db, err := sql.Open("sqlite", "file::memory:?cache=shared&_pragma=foreign_keys(on)")
	require.NoError(t, err)
	db.SetMaxOpenConns(1) // keep the shared in-memory DB alive for the whole test
	require.NoError(t, repository.InitSchema(db))
	t.Cleanup(func() { _ = db.Close() })
	return NewNoteService(repository.NewNoteRepository(db), repository.NewTagRepository(db))
}

// newTestServiceWithTags is like newTestService but also returns the
// TagRepository backing the same DB, for tests that need to pre-create tags
// (which happens through TagService/handler in production, not NoteService).
func newTestServiceWithTags(t *testing.T) (*NoteService, *repository.TagRepository) {
	t.Helper()
	db, err := sql.Open("sqlite", "file::memory:?cache=shared&_pragma=foreign_keys(on)")
	require.NoError(t, err)
	db.SetMaxOpenConns(1)
	require.NoError(t, repository.InitSchema(db))
	t.Cleanup(func() { _ = db.Close() })
	tagRepo := repository.NewTagRepository(db)
	return NewNoteService(repository.NewNoteRepository(db), tagRepo), tagRepo
}

func ptr(s string) *string { return &s }

// --- slug generation -------------------------------------------------------

func TestGenerateSlug(t *testing.T) {
	cases := map[string]struct{ title, want string }{
		"lowercases":            {"Hello World", "hello-world"},
		"folds accents":         {"Café Crème", "cafe-creme"},
		"folds scandinavian":    {"Åsa Ödegård", "asa-odegard"},
		"collapses punctuation": {"Hello, World!! -- Again", "hello-world-again"},
		"collapses whitespace":  {"a   \t  b", "a-b"},
		"trims separators":      {"  --Hello--  ", "hello"},
		"keeps digits":          {"Note 42 v2", "note-42-v2"},
		"drops non-ascii only":  {"日本語", fallbackSlug},
		"empty after strip":     {"!!! ??? ...", fallbackSlug},
		"empty title":           {"", fallbackSlug},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			assert.Equal(t, tc.want, generateSlug(tc.title))
		})
	}
}

func TestGenerateSlug_Truncates(t *testing.T) {
	// A long title yields a slug no longer than maxSlugLen, with no trailing hyphen.
	long := strings.Repeat("word ", 60) // ~300 chars, hyphen-separated
	got := generateSlug(long)
	assert.LessOrEqual(t, len(got), maxSlugLen)
	assert.NotEmpty(t, got)
	assert.False(t, strings.HasSuffix(got, "-"), "must not end in a hyphen after truncation")
	assert.Regexp(t, slugPattern, got, "truncated slug must still satisfy the slug pattern")
}

func TestGenerateSlug_TruncationDropsTrailingHyphen(t *testing.T) {
	// Construct a title whose 100th slug character lands on a separator, so the
	// naive truncation would leave a trailing hyphen that must be trimmed.
	title := strings.Repeat("a", maxSlugLen-1) + " bcd"
	got := generateSlug(title)
	assert.Equal(t, strings.Repeat("a", maxSlugLen-1), got)
}

// --- withSuffix ------------------------------------------------------------

func TestWithSuffix(t *testing.T) {
	assert.Equal(t, "hello-2", withSuffix("hello", 2))
	assert.Equal(t, "hello-3", withSuffix("hello", 3))

	// Base at the length limit is truncated so base+suffix fits maxSlugLen, with
	// any exposed trailing hyphen trimmed (never "foo--2").
	base := strings.Repeat("a", maxSlugLen)
	got := withSuffix(base, 12)
	assert.LessOrEqual(t, len(got), maxSlugLen)
	assert.True(t, strings.HasSuffix(got, "-12"))
	assert.NotContains(t, got, "--")
}

// --- collision resolution (auto slug) --------------------------------------

func TestCreate_AutoSlugCollisionSuffixes(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	first, err := svc.Create(ctx, "Hello World", nil, nil, nil)
	require.NoError(t, err)
	assert.Equal(t, "hello-world", first.Slug)

	second, err := svc.Create(ctx, "Hello World", nil, nil, nil)
	require.NoError(t, err)
	assert.Equal(t, "hello-world-2", second.Slug)

	third, err := svc.Create(ctx, "Hello World", nil, nil, nil)
	require.NoError(t, err)
	assert.Equal(t, "hello-world-3", third.Slug)
}

func TestCreate_EmptyTitleSlugFallbackCollides(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	// Titles that yield no slug-safe characters fall back to "note" and then
	// de-conflict like any other auto slug.
	a, err := svc.Create(ctx, "日本語", nil, nil, nil)
	require.NoError(t, err)
	assert.Equal(t, fallbackSlug, a.Slug)

	b, err := svc.Create(ctx, "！！！", nil, nil, nil)
	require.NoError(t, err)
	assert.Equal(t, fallbackSlug+"-2", b.Slug)
}

// --- explicit slug ---------------------------------------------------------

func TestCreate_ExplicitSlugUsedVerbatim(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	note, err := svc.Create(ctx, "Some Title", nil, ptr("my-custom-slug"), nil)
	require.NoError(t, err)
	assert.Equal(t, "my-custom-slug", note.Slug)
}

func TestCreate_ExplicitSlugCollisionIsConflict(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	_, err := svc.Create(ctx, "First", nil, ptr("taken"), nil)
	require.NoError(t, err)

	// An explicit slug collision is a 409 — never silently suffixed.
	_, err = svc.Create(ctx, "Second", nil, ptr("taken"), nil)
	assert.ErrorIs(t, err, ErrConflict)
}

func TestCreate_InvalidExplicitSlugRejected(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	_, err := svc.Create(ctx, "Title", nil, ptr("Bad Slug!"), nil)
	assert.ErrorIs(t, err, ErrValidation)
}

// --- validateSlug pattern --------------------------------------------------

func TestValidateSlug(t *testing.T) {
	valid := []string{"a", "abc", "a-b-c", "note-42", "a1-b2-c3", strings.Repeat("a", maxSlugLen)}
	for _, s := range valid {
		t.Run("valid/"+s, func(t *testing.T) {
			assert.NoError(t, validateSlug(s))
		})
	}

	invalid := []string{
		"",                                // empty
		"Abc",                             // uppercase
		"-abc",                            // leading hyphen
		"abc-",                            // trailing hyphen
		"a--b",                            // double hyphen
		"a_b",                             // underscore
		"a b",                             // space
		"café",                            // non-ascii
		"a.b",                             // dot
		strings.Repeat("a", maxSlugLen+1), // too long
	}
	for _, s := range invalid {
		t.Run("invalid/"+s, func(t *testing.T) {
			assert.ErrorIs(t, validateSlug(s), ErrValidation)
		})
	}
}

// --- validateTitle ---------------------------------------------------------

func TestValidateTitle(t *testing.T) {
	assert.NoError(t, validateTitle("A normal title"))
	assert.NoError(t, validateTitle(strings.Repeat("x", maxTitleLen)))

	assert.ErrorIs(t, validateTitle(""), ErrValidation, "empty title required")
	assert.ErrorIs(t, validateTitle(strings.Repeat("x", maxTitleLen+1)), ErrValidation, "too long")
	assert.ErrorIs(t, validateTitle("bad\xff utf8"), ErrValidation, "invalid utf-8")

	// Any Unicode Cc control char in a title is rejected — tab/newline/CR included
	// (a title is a single line), unlike content which permits those three, plus
	// DEL and the C1 controls.
	for _, r := range []rune{'\t', '\n', '\r', '\x00', '\x02', '\x03', '\x1f', '\x7f', '\u0080', '\u0085', '\u009f'} {
		assert.ErrorIs(t, validateTitle("a"+string(r)+"b"), ErrValidation, "control char %#x", r)
	}
}

// --- validateContent: length & UTF-8 ---------------------------------------

func TestValidateContent_Limits(t *testing.T) {
	assert.NoError(t, validateContent(""), "empty content accepted")
	assert.NoError(t, validateContent(strings.Repeat("a", maxContentLen)), "at limit accepted")

	assert.ErrorIs(t, validateContent(strings.Repeat("a", maxContentLen+1)), ErrValidation, "over limit")
	assert.ErrorIs(t, validateContent("bad\xff utf8"), ErrValidation, "invalid utf-8")
}

func TestValidateContent_LengthIsRuneCount(t *testing.T) {
	// The limit is in runes, not bytes: maxContentLen multi-byte runes (4 bytes
	// each here) is accepted even though it is far over maxContentLen bytes.
	multi := strings.Repeat("é", maxContentLen)
	assert.NoError(t, validateContent(multi))
	assert.ErrorIs(t, validateContent(multi+"é"), ErrValidation)
}

// --- Create: validation wiring ---------------------------------------------

func TestCreate_TrimsTitleAndRejectsBlank(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	note, err := svc.Create(ctx, "  Spaced Title  ", nil, nil, nil)
	require.NoError(t, err)
	assert.Equal(t, "Spaced Title", note.Title)
	assert.Equal(t, "spaced-title", note.Slug)

	_, err = svc.Create(ctx, "   ", nil, nil, nil)
	assert.ErrorIs(t, err, ErrValidation, "whitespace-only title rejected after trim")
}

func TestCreate_RejectsUnsafeContent(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	_, err := svc.Create(ctx, "Title", ptr("ok <script>alert(1)</script>"), nil, nil)
	assert.ErrorIs(t, err, ErrValidation)
}

func TestCreate_NilContentCoalescesToEmpty(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	note, err := svc.Create(ctx, "Title", nil, nil, nil)
	require.NoError(t, err)
	assert.Equal(t, "", note.Content)
}

// --- Update: validation wiring on the partial-update path ------------------

func TestUpdate_RejectsEmptyPatch(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	created, err := svc.Create(ctx, "Title", nil, nil, nil)
	require.NoError(t, err)

	_, err = svc.Update(ctx, created.Slug, nil, nil, nil, nil)
	assert.ErrorIs(t, err, ErrValidation, "all-fields-absent patch rejected")
}

func TestUpdate_ValidatesPresentFields(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	created, err := svc.Create(ctx, "Title", nil, nil, nil)
	require.NoError(t, err)

	_, err = svc.Update(ctx, created.Slug, ptr("   "), nil, nil, nil)
	assert.ErrorIs(t, err, ErrValidation, "blank title rejected on update")

	_, err = svc.Update(ctx, created.Slug, nil, ptr("<iframe></iframe>"), nil, nil)
	assert.ErrorIs(t, err, ErrValidation, "unsafe content rejected on update")
}

func TestUpdate_NoOpWhenNothingChanges(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	created, err := svc.Create(ctx, "Title", ptr("body"), nil, nil)
	require.NoError(t, err)

	// Re-supplying the existing values (title post-trim) changes nothing, so no
	// UPDATE runs and updated_at is left untouched.
	got, err := svc.Update(ctx, created.Slug, ptr("Title"), ptr("body"), nil, nil)
	require.NoError(t, err)
	assert.Equal(t, created.UpdatedAt, got.UpdatedAt, "no-op update must not bump updated_at")
}

func TestUpdate_AppliesChanges(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	created, err := svc.Create(ctx, "Title", ptr("body"), nil, nil)
	require.NoError(t, err)

	got, err := svc.Update(ctx, created.Slug, ptr("New Title"), ptr("new body"), nil, nil)
	require.NoError(t, err)
	assert.Equal(t, "New Title", got.Title)
	assert.Equal(t, "new body", got.Content)
	assert.Equal(t, created.Slug, got.Slug, "slug is unchanged after update")
}

func TestUpdate_MissingNoteIsNotFound(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	_, err := svc.Update(ctx, "does-not-exist", ptr("X"), nil, nil, nil)
	assert.ErrorIs(t, err, ErrNotFound)
}

// --- tags --------------------------------------------------------------

func TestCreate_WithKnownTagsAttachesThem(t *testing.T) {
	ctx := context.Background()
	svc, tagRepo := newTestServiceWithTags(t)

	work, err := tagRepo.Create(ctx, "work")
	require.NoError(t, err)

	note, err := svc.Create(ctx, "Title", nil, nil, []string{work.Slug})
	require.NoError(t, err)
	require.Len(t, note.Tags, 1)
	assert.Equal(t, "work", note.Tags[0].Slug)
}

func TestCreate_UnknownTagSlugIsValidationError(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	_, err := svc.Create(ctx, "Title", nil, nil, []string{"does-not-exist"})
	assert.ErrorIs(t, err, ErrValidation)
}

func TestCreate_DuplicateTagSlugsAreDeduped(t *testing.T) {
	ctx := context.Background()
	svc, tagRepo := newTestServiceWithTags(t)

	work, err := tagRepo.Create(ctx, "work")
	require.NoError(t, err)

	note, err := svc.Create(ctx, "Title", nil, nil, []string{work.Slug, work.Slug})
	require.NoError(t, err)
	assert.Len(t, note.Tags, 1, "repeated tag slugs collapse to one attachment")
}

func TestUpdate_TagsAbsentLeavesUnchanged(t *testing.T) {
	ctx := context.Background()
	svc, tagRepo := newTestServiceWithTags(t)

	work, err := tagRepo.Create(ctx, "work")
	require.NoError(t, err)
	created, err := svc.Create(ctx, "Title", nil, nil, []string{work.Slug})
	require.NoError(t, err)

	updated, err := svc.Update(ctx, created.Slug, ptr("New Title"), nil, nil, nil)
	require.NoError(t, err)
	require.Len(t, updated.Tags, 1, "tags nil means unchanged")
}

func TestUpdate_TagsEmptySliceClears(t *testing.T) {
	ctx := context.Background()
	svc, tagRepo := newTestServiceWithTags(t)

	work, err := tagRepo.Create(ctx, "work")
	require.NoError(t, err)
	created, err := svc.Create(ctx, "Title", nil, nil, []string{work.Slug})
	require.NoError(t, err)

	updated, err := svc.Update(ctx, created.Slug, nil, nil, &[]string{}, nil)
	require.NoError(t, err)
	assert.Empty(t, updated.Tags)
}

func TestUpdate_SameTagSetIsNoOp(t *testing.T) {
	ctx := context.Background()
	svc, tagRepo := newTestServiceWithTags(t)

	work, err := tagRepo.Create(ctx, "work")
	require.NoError(t, err)
	created, err := svc.Create(ctx, "Title", nil, nil, []string{work.Slug})
	require.NoError(t, err)

	updated, err := svc.Update(ctx, created.Slug, nil, nil, &[]string{work.Slug}, nil)
	require.NoError(t, err)
	assert.Equal(t, created.Version, updated.Version, "replacing with an identical tag set must not bump version")
	assert.Equal(t, created.UpdatedAt, updated.UpdatedAt)
}

func TestUpdate_TagsUnknownSlugIsValidationError(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	created, err := svc.Create(ctx, "Title", nil, nil, nil)
	require.NoError(t, err)

	_, err = svc.Update(ctx, created.Slug, nil, nil, &[]string{"does-not-exist"}, nil)
	assert.ErrorIs(t, err, ErrValidation)
}

func TestUpdate_TagsOnlyFieldIsSufficientToNotBeEmptyPatch(t *testing.T) {
	ctx := context.Background()
	svc, tagRepo := newTestServiceWithTags(t)

	work, err := tagRepo.Create(ctx, "work")
	require.NoError(t, err)
	created, err := svc.Create(ctx, "Title", nil, nil, nil)
	require.NoError(t, err)

	updated, err := svc.Update(ctx, created.Slug, nil, nil, &[]string{work.Slug}, nil)
	require.NoError(t, err)
	require.Len(t, updated.Tags, 1)
}

// TestListDeDupesTagSlugs verifies the service collapses repeated tag slugs
// before the repository's has-all-tags check, so ["work","work"] matches notes
// carrying "work" rather than demanding two distinct tags (which would match
// nothing).
func TestListDeDupesTagSlugs(t *testing.T) {
	svc, tagRepo := newTestServiceWithTags(t)
	ctx := context.Background()

	_, err := tagRepo.Create(ctx, "work")
	require.NoError(t, err)
	_, err = svc.Create(ctx, "Report", nil, nil, []string{"work"})
	require.NoError(t, err)

	notes, total, err := svc.List(ctx, "", []string{"work", "work"}, false, "updated", "desc", 50, 0)
	require.NoError(t, err)
	assert.Equal(t, 1, total)
	require.Len(t, notes, 1)
	assert.Equal(t, "Report", notes[0].Title)
}
