package mdimport

import (
	"bytes"
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mikaelstaldal/mynotes/internal/repository"
	"github.com/mikaelstaldal/mynotes/internal/service"

	_ "modernc.org/sqlite"
)

// newTestService builds a NoteService backed by a fresh in-memory SQLite DB with
// the full schema migrated, mirroring the service package's test setup.
func newTestService(t *testing.T) *service.NoteService {
	t.Helper()
	db, err := sql.Open("sqlite", "file::memory:?cache=shared&_pragma=foreign_keys(on)")
	require.NoError(t, err)
	db.SetMaxOpenConns(1) // keep the shared in-memory DB alive for the whole test
	require.NoError(t, repository.InitSchema(db))
	t.Cleanup(func() { _ = db.Close() })
	return service.NewNoteService(repository.NewNoteRepository(db), repository.NewTagRepository(db))
}

// writeFile creates dir/name (including any parent directories) with content.
func writeFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(content), 0o644))
	return path
}

func TestRunImportsMarkdownFiles(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	svc := newTestService(t)

	writeFile(t, dir, "heading.md", "# From The Heading\n\nBody text.\n")
	writeFile(t, dir, "Named By File.md", "Just a body, no heading.\n")
	writeFile(t, dir, "front.md", "---\ntitle: From Frontmatter\nslug: fm-slug\ntags: [imported]\n---\n\n# Ignored Heading\n")

	var out bytes.Buffer
	imported, skipped, errs := Run(ctx, dir, svc, &out)
	require.Empty(t, errs)
	assert.Equal(t, 3, imported)
	assert.Equal(t, 0, skipped)

	// Progress output names every file and the slug it landed on.
	assert.Contains(t, out.String(), "Found 3 file(s). Importing...")
	assert.Contains(t, out.String(), "✓ heading.md → /notes/from-the-heading")

	notes, total, err := svc.List(ctx, "", nil, false, "", "", 100, 0)
	require.NoError(t, err)
	require.Equal(t, 3, total)

	titles := make(map[string]string, len(notes)) // title → slug
	for _, n := range notes {
		titles[n.Title] = n.Slug
	}
	assert.Equal(t, "from-the-heading", titles["From The Heading"], "leading ATX heading wins over the filename")
	assert.Equal(t, "named-by-file", titles["Named By File"], "filename is the fallback title")
	assert.Equal(t, "fm-slug", titles["From Frontmatter"], "frontmatter title and slug win")

	// Frontmatter is consumed, not stored, and the body is stored verbatim.
	note, err := svc.Get(ctx, "from-the-heading")
	require.NoError(t, err)
	assert.Equal(t, "# From The Heading\n\nBody text.\n", note.Content)

	tagged, err := svc.Get(ctx, "fm-slug")
	require.NoError(t, err)
	require.Len(t, tagged.Tags, 1)
	assert.Equal(t, "imported", tagged.Tags[0].Slug, "frontmatter tags are created on the fly")
}

func TestRunIsRecursiveAndSkipsNonMarkdown(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	svc := newTestService(t)

	writeFile(t, dir, "top.md", "# Top\n")
	writeFile(t, dir, "sub/nested.md", "# Nested\n")
	writeFile(t, dir, "sub/deeper/deep.MD", "# Deep\n")
	writeFile(t, dir, "notes.txt", "# Not Markdown\n")
	writeFile(t, dir, "sub/image.png", "\x89PNG not markdown")

	var out bytes.Buffer
	imported, skipped, errs := Run(ctx, dir, svc, &out)
	require.Empty(t, errs)
	assert.Equal(t, 3, imported, "only .md files, at any depth")
	assert.Equal(t, 0, skipped)
	assert.Contains(t, out.String(), filepath.Join("sub", "nested.md"), "nested files are named relative to the import root")
	assert.NotContains(t, out.String(), "notes.txt")

	_, total, err := svc.List(ctx, "", nil, false, "", "", 100, 0)
	require.NoError(t, err)
	assert.Equal(t, 3, total)
}

// Pointing the flag at a symlinked directory — a link into a synced folder, say
// — imports its contents rather than silently finding nothing.
func TestRunFollowsSymlinkedRoot(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs privileges on Windows")
	}
	ctx := context.Background()
	tmp := t.TempDir()
	svc := newTestService(t)

	real := filepath.Join(tmp, "real")
	writeFile(t, real, "note.md", "# Linked\n")
	writeFile(t, real, "sub/nested.md", "# Nested\n")
	link := filepath.Join(tmp, "link")
	require.NoError(t, os.Symlink(real, link))

	var out bytes.Buffer
	imported, skipped, errs := Run(ctx, link, svc, &out)
	require.Empty(t, errs)
	assert.Equal(t, 2, imported)
	assert.Equal(t, 0, skipped)
	assert.Contains(t, out.String(), "✓ note.md → /notes/linked", "names stay relative to the import root")
}

// Symlinks inside the tree are still skipped, so an import cannot be lured out
// of the directory it was pointed at.
func TestRunSkipsSymlinksInsideTree(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs privileges on Windows")
	}
	ctx := context.Background()
	tmp := t.TempDir()
	svc := newTestService(t)

	outside := filepath.Join(tmp, "outside")
	writeFile(t, outside, "secret.md", "# Secret\n")
	dir := filepath.Join(tmp, "import")
	writeFile(t, dir, "own.md", "# Own\n")
	require.NoError(t, os.Symlink(outside, filepath.Join(dir, "escape")))
	require.NoError(t, os.Symlink(filepath.Join(outside, "secret.md"), filepath.Join(dir, "secret-link.md")))

	imported, _, errs := Run(ctx, dir, svc, &bytes.Buffer{})
	require.Empty(t, errs)
	assert.Equal(t, 1, imported, "only the directory's own file")

	_, err := svc.Get(ctx, "secret")
	assert.Error(t, err)
}

func TestRunSkipsHiddenEntries(t *testing.T) {
	ctx := context.Background()
	tmp := t.TempDir()
	svc := newTestService(t)

	// The import root is itself hidden, which must not skip everything.
	dir := filepath.Join(tmp, ".notes")
	writeFile(t, dir, "kept.md", "# Kept\n")
	writeFile(t, dir, ".hidden.md", "# Hidden File\n")
	writeFile(t, dir, ".trash/deleted.md", "# Deleted Note\n")
	writeFile(t, dir, ".git/objects/blob.md", "# Not A Note\n")

	imported, _, errs := Run(ctx, dir, svc, &bytes.Buffer{})
	require.Empty(t, errs)
	assert.Equal(t, 1, imported, "only the visible file in a hidden root")

	_, total, err := svc.List(ctx, "", nil, false, "", "", 100, 0)
	require.NoError(t, err)
	assert.Equal(t, 1, total)
}

func TestRunSkipsEmptyFiles(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	svc := newTestService(t)

	writeFile(t, dir, "empty.md", "")
	writeFile(t, dir, "blank.md", "   \n\t\n")
	writeFile(t, dir, "real.md", "# Real\n")

	var out bytes.Buffer
	imported, skipped, errs := Run(ctx, dir, svc, &out)
	require.Empty(t, errs, "an empty file is skipped, not an error")
	assert.Equal(t, 1, imported)
	assert.Equal(t, 2, skipped)
	assert.Contains(t, out.String(), "⊘ empty.md: skipped, no content")
}

func TestRunDeconflictsDuplicateTitles(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	svc := newTestService(t)

	writeFile(t, dir, "a.md", "# Same Title\n\nFirst.\n")
	writeFile(t, dir, "b.md", "# Same Title\n\nSecond.\n")
	writeFile(t, dir, "sub/a.md", "# Same Title\n\nThird.\n")

	imported, skipped, errs := Run(ctx, dir, svc, &bytes.Buffer{})
	require.Empty(t, errs)
	assert.Equal(t, 3, imported)
	assert.Equal(t, 0, skipped)

	notes, total, err := svc.List(ctx, "", nil, false, "", "", 100, 0)
	require.NoError(t, err)
	require.Equal(t, 3, total)

	slugs := make(map[string]bool, len(notes))
	for _, n := range notes {
		assert.Equal(t, "Same Title", n.Title)
		assert.False(t, slugs[n.Slug], "slug %s used twice", n.Slug)
		slugs[n.Slug] = true
	}
	assert.True(t, slugs["same-title"], "first note keeps the bare slug, got %v", slugs)
}

// A conflicting explicit slug is a per-file error; the rest of the run continues.
func TestRunReportsConflictingExplicitSlug(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	svc := newTestService(t)

	writeFile(t, dir, "a.md", "---\ntitle: First\nslug: taken\n---\n\nOne.\n")
	writeFile(t, dir, "b.md", "---\ntitle: Second\nslug: taken\n---\n\nTwo.\n")
	writeFile(t, dir, "c.md", "# Third\n")

	var out bytes.Buffer
	imported, skipped, errs := Run(ctx, dir, svc, &out)
	assert.Equal(t, 2, imported)
	assert.Equal(t, 0, skipped)
	require.Len(t, errs, 1)
	assert.Contains(t, errs[0].Error(), "b.md")
	assert.Contains(t, out.String(), "✗ b.md")
}

func TestRunRejectsMissingAndNonDirectoryPaths(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	imported, skipped, errs := Run(ctx, filepath.Join(t.TempDir(), "nope"), svc, &bytes.Buffer{})
	assert.Zero(t, imported)
	assert.Zero(t, skipped)
	require.Len(t, errs, 1)
	assert.Contains(t, errs[0].Error(), "import directory")

	dir := t.TempDir()
	file := writeFile(t, dir, "notes.md", "# A Note\n")
	imported, skipped, errs = Run(ctx, file, svc, &bytes.Buffer{})
	assert.Zero(t, imported)
	assert.Zero(t, skipped)
	require.Len(t, errs, 1)
	assert.Contains(t, errs[0].Error(), "not a directory")
}

func TestRunReportsUnreadableFile(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("chmod-based unreadability needs POSIX permissions and a non-root user")
	}
	ctx := context.Background()
	dir := t.TempDir()
	svc := newTestService(t)

	writeFile(t, dir, "ok.md", "# Fine\n")
	secret := writeFile(t, dir, "secret.md", "# Secret\n")
	require.NoError(t, os.Chmod(secret, 0o000))
	t.Cleanup(func() { _ = os.Chmod(secret, 0o644) })

	var out bytes.Buffer
	imported, _, errs := Run(ctx, dir, svc, &out)
	assert.Equal(t, 1, imported, "the readable file still imports")
	require.Len(t, errs, 1)
	assert.Contains(t, errs[0].Error(), "secret.md")
	assert.Contains(t, out.String(), "✗ secret.md")
}

// An unreadable subdirectory is reported once and the rest of the tree imports.
func TestRunReportsUnreadableDirectory(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("chmod-based unreadability needs POSIX permissions and a non-root user")
	}
	ctx := context.Background()
	dir := t.TempDir()
	svc := newTestService(t)

	writeFile(t, dir, "ok.md", "# Fine\n")
	writeFile(t, dir, "locked/hidden.md", "# Hidden\n")
	locked := filepath.Join(dir, "locked")
	require.NoError(t, os.Chmod(locked, 0o000))
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })

	imported, _, errs := Run(ctx, dir, svc, &bytes.Buffer{})
	assert.Equal(t, 1, imported)
	require.Len(t, errs, 1)
	assert.Contains(t, errs[0].Error(), "locked")
}

func TestRunRejectsOversizedAndInvalidContent(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	svc := newTestService(t)

	writeFile(t, dir, "huge.md", "# Huge\n\n"+strings.Repeat("x", maxFileSize))
	writeFile(t, dir, "invalid.md", "# Bad\n\n\xff\xfe not utf-8\n")
	writeFile(t, dir, "ok.md", "# Fine\n")

	var out bytes.Buffer
	imported, _, errs := Run(ctx, dir, svc, &out)
	assert.Equal(t, 1, imported)
	require.Len(t, errs, 2)
	assert.Contains(t, out.String(), "✗ huge.md: too large")
	assert.Contains(t, out.String(), "✗ invalid.md")
}

func TestRunEmptyDirectory(t *testing.T) {
	var out bytes.Buffer
	imported, skipped, errs := Run(context.Background(), t.TempDir(), newTestService(t), &out)
	assert.Empty(t, errs)
	assert.Zero(t, imported)
	assert.Zero(t, skipped)
	assert.Contains(t, out.String(), "Found 0 file(s)")
}

// The file's own frontmatter date wins; a file without one gets the file's
// modification time, so imported notes keep a meaningful chronology.
func TestRunCreatedAtFromFrontmatterElseModTime(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	svc := newTestService(t)

	writeFile(t, dir, "dated.md", "---\ntitle: Dated\ndate: 2021-03-04T05:06:07Z\n---\n\nBody.\n")
	modTime := time.Date(2019, 8, 7, 6, 5, 4, 0, time.UTC)
	undated := writeFile(t, dir, "undated.md", "# Undated\n")
	require.NoError(t, os.Chtimes(undated, modTime, modTime))

	imported, _, errs := Run(ctx, dir, svc, &bytes.Buffer{})
	require.Empty(t, errs)
	require.Equal(t, 2, imported)

	dated, err := svc.Get(ctx, "dated")
	require.NoError(t, err)
	assert.Equal(t, time.Date(2021, 3, 4, 5, 6, 7, 0, time.UTC), dated.CreatedAt.UTC())

	fromFile, err := svc.Get(ctx, "undated")
	require.NoError(t, err)
	assert.Equal(t, modTime, fromFile.CreatedAt.UTC())
}

func TestRunStripsBOM(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	svc := newTestService(t)

	writeFile(t, dir, "bom.md", "\uFEFF---\ntitle: With BOM\n---\n\nBody.\n")

	imported, _, errs := Run(ctx, dir, svc, &bytes.Buffer{})
	require.Empty(t, errs)
	require.Equal(t, 1, imported)

	note, err := svc.Get(ctx, "with-bom")
	require.NoError(t, err)
	assert.Equal(t, "With BOM", note.Title, "the BOM does not defeat frontmatter detection")
	assert.Equal(t, "\nBody.\n", note.Content, "only the frontmatter block and its terminating newline are consumed")
}

func TestTitleFromPath(t *testing.T) {
	assert.Equal(t, "Shopping list", titleFromPath(filepath.Join("a", "b", "Shopping list.md")))
	assert.Equal(t, "note", titleFromPath("note.MD"))
	assert.Equal(t, "archive.tar", titleFromPath("archive.tar.md"))
}
