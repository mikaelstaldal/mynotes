package mdexport

import (
	"bytes"
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mikaelstaldal/mynotes/internal/repository"
	"github.com/mikaelstaldal/mynotes/internal/service"

	_ "modernc.org/sqlite"
)

// newTestDB builds a fresh in-memory SQLite DB with the full schema migrated,
// mirroring the importer's test setup, and the NoteService over it. The DB
// handle is returned so a test can write a row the service would never accept.
func newTestDB(t *testing.T, name string) (*service.NoteService, *sql.DB) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+name+"?mode=memory&cache=shared&_pragma=foreign_keys(on)")
	require.NoError(t, err)
	db.SetMaxOpenConns(1) // keep the shared in-memory DB alive for the whole test
	require.NoError(t, repository.InitSchema(db))
	t.Cleanup(func() { _ = db.Close() })
	return service.NewNoteService(repository.NewNoteRepository(db), repository.NewTagRepository(db)), db
}

// newTestService is newTestDB when the test does not need the DB handle. The
// database is named after the test, so tests never share one.
func newTestService(t *testing.T) *service.NoteService {
	t.Helper()
	svc, _ := newTestDB(t, t.Name())
	return svc
}

// createNote stores a note with the given title and content, failing the test on
// any error.
func createNote(t *testing.T, svc *service.NoteService, title, content string) {
	t.Helper()
	_, err := svc.Create(context.Background(), title, &content, nil, nil)
	require.NoError(t, err)
}

// dirEntries lists the file names in dir, sorted.
func dirEntries(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	require.NoError(t, err)
	names := make([]string, len(entries))
	for i, e := range entries {
		names[i] = e.Name()
	}
	sort.Strings(names)
	return names
}

// readFile returns the contents of dir/name.
func readFile(t *testing.T, dir, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, name))
	require.NoError(t, err)
	return string(data)
}

func TestRunExportsEveryNote(t *testing.T) {
	ctx := context.Background()
	dir := filepath.Join(t.TempDir(), "out") // does not exist yet
	svc := newTestService(t)

	createNote(t, svc, "Shopping list", "Milk and eggs.\n")
	createNote(t, svc, "Project Ideas", "# Ideas\n\nSomething clever.\n")

	var out bytes.Buffer
	exported, errs := Run(ctx, dir, svc, &out)
	require.Empty(t, errs)
	assert.Equal(t, 2, exported)

	assert.Equal(t, []string{"project-ideas.md", "shopping-list.md"}, dirEntries(t, dir),
		"the target directory is created and holds one .md file per note, named by slug")

	// Progress output names every note and the file it landed in.
	assert.Contains(t, out.String(), "Found 2 note(s). Exporting to "+dir+"...")
	assert.Contains(t, out.String(), "✓ /notes/shopping-list → shopping-list.md")
	assert.Contains(t, out.String(), "✓ /notes/project-ideas → project-ideas.md")
}

// The file name is the same identifier that addresses the note in its URL, not a
// rendering of its title.
func TestRunNamesFilesBySlugNotTitle(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	svc := newTestService(t)

	createNote(t, svc, "Café möte 日本語", "Body.\n")

	exported, errs := Run(ctx, dir, svc, &bytes.Buffer{})
	require.Empty(t, errs)
	assert.Equal(t, 1, exported)
	assert.Equal(t, []string{"cafe-mote.md"}, dirEntries(t, dir))
}

// The file body is exactly what the download-Markdown endpoint serves, because
// both go through service.MarkdownWithFrontmatter.
func TestRunWritesDownloadMarkdownVerbatim(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	svc := newTestService(t)

	note, err := svc.ImportMarkdown(ctx, "---\ntitle: Tagged\ntags: [work, urgent]\n---\nBody text.\n")
	require.NoError(t, err)

	_, errs := Run(ctx, dir, svc, &bytes.Buffer{})
	require.Empty(t, errs)

	stored, err := svc.Get(ctx, note.Slug)
	require.NoError(t, err)
	assert.Equal(t, service.MarkdownWithFrontmatter(stored), readFile(t, dir, "tagged.md"),
		"the exported file is byte-for-byte what GET /notes/{slug}/download-markdown returns")

	written := readFile(t, dir, "tagged.md")
	assert.True(t, strings.HasPrefix(written, "---\n"), "starts with a YAML frontmatter block")
	assert.Contains(t, written, "title: Tagged\n")
	assert.Contains(t, written, "dialect: mynotes\n")
	assert.Contains(t, written, "- work\n", "tags carry over")
}

// An exported tree re-imports: the round-trip the frontmatter exists for. The
// importer reads the slug from the frontmatter, not from the file name.
func TestRunRoundTripsThroughImport(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	source := newTestService(t)

	original, err := source.ImportMarkdown(ctx,
		"---\ntitle: Round Trip\nslug: round-trip\ndate: 2024-03-01T10:00:00Z\ntags: [work]\n---\nThe body.\n")
	require.NoError(t, err)

	_, errs := Run(ctx, dir, source, &bytes.Buffer{})
	require.Empty(t, errs)

	// Import the exported file into a second, empty database.
	target, _ := newTestDB(t, t.Name()+"-target")
	data, err := os.ReadFile(filepath.Join(dir, "round-trip.md"))
	require.NoError(t, err)
	reimported, err := target.ImportMarkdown(ctx, string(data))
	require.NoError(t, err)

	assert.Equal(t, original.Title, reimported.Title)
	assert.Equal(t, original.Slug, reimported.Slug)
	assert.Equal(t, original.CreatedAt.UTC(), reimported.CreatedAt.UTC())
	require.Len(t, reimported.Tags, 1)
	assert.Equal(t, "work", reimported.Tags[0].Slug)
	assert.Equal(t, original.Content, reimported.Content)
}

// An empty database exports nothing and is not an error — the directory is still
// created.
func TestRunEmptyDatabase(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "out")
	var out bytes.Buffer

	exported, errs := Run(context.Background(), dir, newTestService(t), &out)
	require.Empty(t, errs)
	assert.Equal(t, 0, exported)
	assert.Empty(t, dirEntries(t, dir))
	assert.Contains(t, out.String(), "Found 0 note(s).")
}

// A target path that exists as a regular file cannot be made into a directory:
// nothing is exported and the failure is the single reported error.
func TestRunTargetIsAFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "notafolder")
	require.NoError(t, os.WriteFile(path, []byte("x"), 0o644))

	exported, errs := Run(context.Background(), path, newTestService(t), &bytes.Buffer{})
	assert.Equal(t, 0, exported)
	require.Len(t, errs, 1)
	assert.Contains(t, errs[0].Error(), "export directory")
}

// Re-running the export over the same directory refreshes the files rather than
// accumulating duplicates.
func TestRunOverwritesOnRerun(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	svc := newTestService(t)

	note, err := svc.Create(ctx, "Notes", ptr("Version one.\n"), nil, nil)
	require.NoError(t, err)

	_, errs := Run(ctx, dir, svc, &bytes.Buffer{})
	require.Empty(t, errs)

	_, err = svc.Update(ctx, note.Slug, nil, ptr("Version two.\n"), nil, nil)
	require.NoError(t, err)

	exported, errs := Run(ctx, dir, svc, &bytes.Buffer{})
	require.Empty(t, errs)
	assert.Equal(t, 1, exported)
	assert.Equal(t, []string{"notes.md"}, dirEntries(t, dir), "no second file accumulates")
	assert.Contains(t, readFile(t, dir, "notes.md"), "Version two.")
}

func ptr(s string) *string { return &s }

// More notes than one page: every note is exported, none twice.
func TestRunPagesThroughAllNotes(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	svc := newTestService(t)

	const count = pageSize + 5
	for i := range count {
		createNote(t, svc, "Note "+strconv.Itoa(i), "Body.\n")
	}

	exported, errs := Run(ctx, dir, svc, &bytes.Buffer{})
	require.Empty(t, errs)
	assert.Equal(t, count, exported)
	assert.Len(t, dirEntries(t, dir), count)
}

// A slug that is not a bare name never becomes a path. The service cannot create
// one, so the row is written straight to SQLite — the shape a malformed value
// would have if it ever reached the database. The bad note costs one error line
// and the rest of the run still exports.
func TestRunRejectsASlugThatIsNotABareName(t *testing.T) {
	ctx := context.Background()
	parent := t.TempDir()
	dir := filepath.Join(parent, "out")
	svc, db := newTestDB(t, t.Name())

	createNote(t, svc, "Good", "Fine.\n")
	_, err := db.ExecContext(ctx,
		`INSERT INTO notes (slug, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
		"../escaped", "Bad", "Nope.\n", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z")
	require.NoError(t, err)

	var out bytes.Buffer
	exported, errs := Run(ctx, dir, svc, &out)

	assert.Equal(t, 1, exported, "the well-formed note still exports")
	require.Len(t, errs, 1)
	assert.Contains(t, errs[0].Error(), "unusable slug")
	assert.Contains(t, out.String(), "✗ ../escaped:")

	assert.Equal(t, []string{"good.md"}, dirEntries(t, dir))
	assert.NoFileExists(t, filepath.Join(parent, "escaped.md"),
		"nothing is written outside the export directory")
}

func TestFileNameFor(t *testing.T) {
	tests := []struct {
		name    string
		slug    string
		want    string
		wantErr bool
	}{
		{name: "slug used as the file name", slug: "shopping-list", want: "shopping-list.md"},
		{name: "digits and hyphens", slug: "q3-2024-roadmap", want: "q3-2024-roadmap.md"},
		{name: "windows device name is prefixed", slug: "con", want: "_con.md"},
		{name: "another device name", slug: "lpt1", want: "_lpt1.md"},
		{name: "a device name with more to it is left alone", slug: "context", want: "context.md"},
		{name: "a device name as one segment is left alone", slug: "con-notes", want: "con-notes.md"},
		{name: "empty slug rejected", slug: "", wantErr: true},
		{name: "uppercase rejected", slug: "Notes", wantErr: true},
		{name: "dot rejected", slug: "notes.md", wantErr: true},
		{name: "separator rejected", slug: "a/b", wantErr: true},
		{name: "parent reference rejected", slug: "..", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := fileNameFor(tt.slug)
			if tt.wantErr {
				assert.Error(t, err)
				assert.Empty(t, got)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tt.want, got)
		})
	}
}

// Whatever the slug, the export either refuses it or produces a single path
// element: it can only ever write inside the directory it was given.
func TestFileNameForNeverEscapesTheDirectory(t *testing.T) {
	slugs := []string{
		"..", ".", "../../etc/passwd", `..\..\windows`, "/absolute/path", "....",
		"a/../b", string(rune(0)) + "/", "  ..  ", "-.-", "con", "nul", "notes",
	}
	for _, slug := range slugs {
		name, err := fileNameFor(slug)
		if err != nil {
			assert.Empty(t, name, "%q", slug)
			continue
		}
		assert.Equal(t, name, filepath.Base(name), "%q yields a bare file name", slug)
		assert.NotContains(t, name, "/", "%q", slug)
		assert.NotContains(t, name, `\`, "%q", slug)
	}
}

// Every DOS device name is a valid slug, so the guard is reachable for each — a
// miss would export a file Windows cannot open.
func TestWindowsReservedCoversEveryDeviceName(t *testing.T) {
	for slug := range windowsReserved {
		require.True(t, slugPattern.MatchString(slug),
			"%q must be a valid slug, or the guard is unreachable", slug)
		name, err := fileNameFor(slug)
		require.NoError(t, err)
		assert.Equal(t, "_"+slug+".md", name)
	}
}
