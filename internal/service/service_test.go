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
	return NewNoteService(repository.NewNoteRepository(db))
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

	first, err := svc.Create(ctx, "Hello World", nil, nil)
	require.NoError(t, err)
	assert.Equal(t, "hello-world", first.Slug)

	second, err := svc.Create(ctx, "Hello World", nil, nil)
	require.NoError(t, err)
	assert.Equal(t, "hello-world-2", second.Slug)

	third, err := svc.Create(ctx, "Hello World", nil, nil)
	require.NoError(t, err)
	assert.Equal(t, "hello-world-3", third.Slug)
}

func TestCreate_EmptyTitleSlugFallbackCollides(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	// Titles that yield no slug-safe characters fall back to "note" and then
	// de-conflict like any other auto slug.
	a, err := svc.Create(ctx, "日本語", nil, nil)
	require.NoError(t, err)
	assert.Equal(t, fallbackSlug, a.Slug)

	b, err := svc.Create(ctx, "！！！", nil, nil)
	require.NoError(t, err)
	assert.Equal(t, fallbackSlug+"-2", b.Slug)
}

// --- explicit slug ---------------------------------------------------------

func TestCreate_ExplicitSlugUsedVerbatim(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	note, err := svc.Create(ctx, "Some Title", nil, ptr("my-custom-slug"))
	require.NoError(t, err)
	assert.Equal(t, "my-custom-slug", note.Slug)
}

func TestCreate_ExplicitSlugCollisionIsConflict(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	_, err := svc.Create(ctx, "First", nil, ptr("taken"))
	require.NoError(t, err)

	// An explicit slug collision is a 409 — never silently suffixed.
	_, err = svc.Create(ctx, "Second", nil, ptr("taken"))
	assert.ErrorIs(t, err, ErrConflict)
}

func TestCreate_InvalidExplicitSlugRejected(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	_, err := svc.Create(ctx, "Title", nil, ptr("Bad Slug!"))
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

	// Any C0 control char in a title is rejected — tab/newline/CR included (a title
	// is a single line), unlike content which permits those three.
	for _, r := range []rune{'\t', '\n', '\r', '\x00', '\x02', '\x03', '\x1f'} {
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

	note, err := svc.Create(ctx, "  Spaced Title  ", nil, nil)
	require.NoError(t, err)
	assert.Equal(t, "Spaced Title", note.Title)
	assert.Equal(t, "spaced-title", note.Slug)

	_, err = svc.Create(ctx, "   ", nil, nil)
	assert.ErrorIs(t, err, ErrValidation, "whitespace-only title rejected after trim")
}

func TestCreate_RejectsUnsafeContent(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	_, err := svc.Create(ctx, "Title", ptr("ok <script>alert(1)</script>"), nil)
	assert.ErrorIs(t, err, ErrValidation)
}

func TestCreate_NilContentCoalescesToEmpty(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	note, err := svc.Create(ctx, "Title", nil, nil)
	require.NoError(t, err)
	assert.Equal(t, "", note.Content)
}

// --- Update: validation wiring on the partial-update path ------------------

func TestUpdate_RejectsEmptyPatch(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	created, err := svc.Create(ctx, "Title", nil, nil)
	require.NoError(t, err)

	_, err = svc.Update(ctx, created.Slug, nil, nil, nil, nil)
	assert.ErrorIs(t, err, ErrValidation, "all-fields-absent patch rejected")
}

func TestUpdate_ValidatesPresentFields(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	created, err := svc.Create(ctx, "Title", nil, nil)
	require.NoError(t, err)

	_, err = svc.Update(ctx, created.Slug, ptr("   "), nil, nil, nil)
	assert.ErrorIs(t, err, ErrValidation, "blank title rejected on update")

	_, err = svc.Update(ctx, created.Slug, nil, ptr("<iframe></iframe>"), nil, nil)
	assert.ErrorIs(t, err, ErrValidation, "unsafe content rejected on update")

	_, err = svc.Update(ctx, created.Slug, nil, nil, ptr("Bad Slug"), nil)
	assert.ErrorIs(t, err, ErrValidation, "invalid slug rejected on update")
}

func TestUpdate_NoOpWhenNothingChanges(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	created, err := svc.Create(ctx, "Title", ptr("body"), nil)
	require.NoError(t, err)

	// Re-supplying the existing values (title post-trim) changes nothing, so no
	// UPDATE runs and updated_at is left untouched.
	got, err := svc.Update(ctx, created.Slug, ptr("Title"), ptr("body"), ptr(created.Slug), nil)
	require.NoError(t, err)
	assert.Equal(t, created.UpdatedAt, got.UpdatedAt, "no-op update must not bump updated_at")
}

func TestUpdate_AppliesChanges(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	created, err := svc.Create(ctx, "Title", ptr("body"), nil)
	require.NoError(t, err)

	got, err := svc.Update(ctx, created.Slug, ptr("New Title"), ptr("new body"), ptr("new-slug"), nil)
	require.NoError(t, err)
	assert.Equal(t, "New Title", got.Title)
	assert.Equal(t, "new body", got.Content)
	assert.Equal(t, "new-slug", got.Slug)
}

func TestUpdate_RenameOntoTakenSlugIsConflict(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	_, err := svc.Create(ctx, "First", nil, ptr("first"))
	require.NoError(t, err)
	second, err := svc.Create(ctx, "Second", nil, ptr("second"))
	require.NoError(t, err)

	_, err = svc.Update(ctx, second.Slug, nil, nil, ptr("first"), nil)
	assert.ErrorIs(t, err, ErrConflict)
}

func TestUpdate_MissingNoteIsNotFound(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	_, err := svc.Update(ctx, "does-not-exist", ptr("X"), nil, nil, nil)
	assert.ErrorIs(t, err, ErrNotFound)
}
