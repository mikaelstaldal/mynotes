// Package mdimport bulk-imports a directory tree of Markdown files as notes.
// It is the filesystem counterpart to internal/gdocs: a one-shot batch mode
// that writes through the same NoteService the REST API uses, so imported
// content passes exactly the same validation as a note created interactively.
package mdimport

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/mikaelstaldal/mynotes/internal/model"
	"github.com/mikaelstaldal/mynotes/internal/service"
)

// maxFileSize caps a single Markdown file, mirroring the Google Docs importer's
// export ceiling. A larger file is reported as an error rather than read into
// memory (the service's own content limit is an order of magnitude smaller).
const maxFileSize = 10 << 20 // 10 MiB

// markdownExt is the only extension imported; every other file is skipped
// silently, so a directory holding images or PDFs alongside its notes needs no
// pre-filtering.
const markdownExt = ".md"

// Run imports every Markdown file under dir, recursively, into the note
// service, writing progress to w. Returns the number of notes created, the
// number of files skipped for having no content, and any per-file errors — one
// bad file never aborts the rest of the run.
//
// A dir that does not exist, or is not a directory, imports nothing and is
// reported as the single error.
func Run(ctx context.Context, dir string, notes *service.NoteService, w io.Writer) (imported, skipped int, errs []error) {
	info, err := os.Stat(dir)
	if err != nil {
		return 0, 0, []error{fmt.Errorf("import directory %s: %w", dir, err)}
	}
	if !info.IsDir() {
		return 0, 0, []error{fmt.Errorf("import directory %s: not a directory", dir)}
	}
	// WalkDir lstats its root, so a symlinked import directory would be handed to
	// the callback as an irregular entry and the walk would end having found
	// nothing. Resolve it — pointing the flag at a symlink into a synced folder is
	// an ordinary thing to do, and importing nothing while exiting 0 would be a
	// silent no-op. Only the root is resolved: symlinks *inside* the tree stay
	// skipped, so the walk still cannot leave it.
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return 0, 0, []error{fmt.Errorf("import directory %s: %w", dir, err)}
	}

	_, _ = fmt.Fprintf(w, "Scanning %s for %s files...\n", dir, markdownExt)
	files, walkErrs := findMarkdownFiles(root)
	errs = append(errs, walkErrs...)
	_, _ = fmt.Fprintf(w, "Found %d file(s). Importing...\n", len(files))

	for _, path := range files {
		name := displayName(root, path)
		note, empty, err := importFile(ctx, notes, path)
		switch {
		case err != nil:
			_, _ = fmt.Fprintf(w, "  ✗ %s: %v\n", name, err)
			errs = append(errs, fmt.Errorf("%s: %w", name, err))
		case empty:
			_, _ = fmt.Fprintf(w, "  ⊘ %s: skipped, no content\n", name)
			skipped++
		default:
			_, _ = fmt.Fprintf(w, "  ✓ %s → /notes/%s\n", name, note.Slug)
			imported++
		}
	}
	return imported, skipped, errs
}

// findMarkdownFiles returns every regular Markdown file under root, in the
// lexical order WalkDir visits them, so a run over an unchanged directory
// imports in a stable order. A directory that cannot be read is reported and
// skipped; the rest of the tree still imports. Symlinks are irregular entries
// and therefore skipped, so the walk cannot leave root.
//
// Hidden entries — a leading dot — are skipped, directories and their contents
// with them: an Obsidian vault keeps deleted notes as Markdown under .trash,
// and .git holds no notes at all. The root itself is never skipped, so
// importing ~/.notes works.
func findMarkdownFiles(root string) ([]string, []error) {
	var files []string
	var errs []error
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", path, err))
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if path != root && strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		if !strings.EqualFold(filepath.Ext(d.Name()), markdownExt) {
			return nil
		}
		files = append(files, path)
		return nil
	})
	if err != nil {
		errs = append(errs, fmt.Errorf("%s: %w", root, err))
	}
	return files, errs
}

// importFile reads one Markdown file and creates a note from it. The second
// result reports a file with nothing but whitespace in it, which is skipped
// rather than turned into an empty note.
//
// The file's own frontmatter (title, slug, date, tags) is authoritative — the
// content reaches the service verbatim, never rewritten. Where a Drive export
// carries no frontmatter and the Google Docs importer therefore synthesises one
// from the document's name and creation time, here the filesystem supplies the
// same two fields as fallbacks: the filename without its extension as the
// title (used only when neither frontmatter nor a leading heading names the
// note) and the modification time as created_at (used only when frontmatter
// carries no date).
func importFile(ctx context.Context, notes *service.NoteService, path string) (model.Note, bool, error) {
	info, err := os.Stat(path)
	if err != nil {
		return model.Note{}, false, err
	}
	if info.Size() > maxFileSize {
		return model.Note{}, false, fmt.Errorf("too large: %d bytes (limit %d)", info.Size(), maxFileSize)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return model.Note{}, false, err
	}

	// A leading BOM would defeat frontmatter detection and survive into the
	// rendered note as an invisible character.
	content := strings.TrimPrefix(string(data), "\uFEFF")
	if strings.TrimSpace(content) == "" {
		return model.Note{}, true, nil
	}

	note, err := notes.ImportMarkdownWithDefaults(ctx, content, titleFromPath(path), info.ModTime())
	if err != nil {
		return model.Note{}, false, err
	}
	return note, false, nil
}

// titleFromPath derives a fallback note title from a file path: the base name
// without its extension, e.g. /notes/sub/Shopping list.md → "Shopping list".
func titleFromPath(path string) string {
	base := filepath.Base(path)
	return strings.TrimSuffix(base, filepath.Ext(base))
}

// displayName renders path for progress output relative to the import root, so
// nested files read as sub/note.md rather than as an absolute path.
func displayName(root, path string) string {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return path
	}
	return rel
}
