// Package mdexport bulk-exports every note as a Markdown file in a directory.
// It is the inverse of internal/mdimport: a one-shot batch mode that reads
// through the same NoteService the REST API uses and serialises each note with
// service.MarkdownWithFrontmatter — the very function behind the "download
// Markdown" endpoint — so an exported tree re-imports with -import-md-dir and
// the two formats cannot drift apart.
//
// A note is written as <slug>.md, so the file name is the same identifier that
// addresses the note at /notes/<slug>. A slug is ASCII lowercase alphanumerics
// and interior hyphens, at most 100 characters, and unique across the database,
// which is to say it is already a legal, non-colliding file name everywhere: the
// export needs no sanitising, truncation, or de-duplication of its own.
package mdexport

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"

	"github.com/mikaelstaldal/mynotes/internal/repository"
	"github.com/mikaelstaldal/mynotes/internal/service"
)

// markdownExt is the extension every exported file gets, matching what the
// importer looks for.
const markdownExt = ".md"

// pageSize is the note-list page size. service.List clamps a limit above 200
// back to 50, so this is the largest page that is actually honoured.
const pageSize = 200

// slugPattern restates the constraint service.validateSlug enforces on every
// write path. It is checked again here rather than assumed, because this is the
// one place a database value becomes a path, and a file name should not depend
// on an invariant maintained in another package.
var slugPattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// windowsReserved are the DOS device names that Windows still refuses as a file
// name, with or without an extension — "con.md" is as unusable as "con". Each is
// a valid slug (a note titled "Con" auto-slugs to con), so this is reachable, not
// theoretical; a slug matching one is prefixed with an underscore. The prefix
// cannot collide with another note's file, since "_con" is not itself a slug any
// note can hold.
var windowsReserved = map[string]bool{
	"con": true, "prn": true, "aux": true, "nul": true,
	"com1": true, "com2": true, "com3": true, "com4": true, "com5": true,
	"com6": true, "com7": true, "com8": true, "com9": true,
	"lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true,
	"lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true,
}

// Run writes every note in the database to dir as <slug>.md, creating dir (and
// any missing parent) if it does not exist, and writing progress to w. Returns
// the number of files written and any per-note errors — one failure never aborts
// the rest of the run.
//
// A file already in dir under a note's name is overwritten: the command is a
// repeatable dump of the database, not an incremental sync. Nothing else in dir
// is touched, and notes deleted since the last run leave their file behind.
func Run(ctx context.Context, dir string, notes *service.NoteService, w io.Writer) (exported int, errs []error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return 0, []error{fmt.Errorf("export directory %s: %w", dir, err)}
	}

	_, _ = fmt.Fprintf(w, "Listing notes...\n")
	slugs, err := listAll(ctx, notes)
	if err != nil {
		return 0, []error{err}
	}
	_, _ = fmt.Fprintf(w, "Found %d note(s). Exporting to %s...\n", len(slugs), dir)

	for _, slug := range slugs {
		name, err := fileNameFor(slug)
		if err == nil {
			err = exportNote(ctx, notes, slug, filepath.Join(dir, name))
		}
		if err != nil {
			_, _ = fmt.Fprintf(w, "  ✗ %s: %v\n", slug, err)
			errs = append(errs, fmt.Errorf("%s: %w", slug, err))
			continue
		}
		_, _ = fmt.Fprintf(w, "  ✓ /notes/%s → %s\n", slug, name)
		exported++
	}
	return exported, errs
}

// listAll pages through the whole note list in a stable order (oldest first,
// with the repository's id tiebreak) so a run over an unchanged database exports
// in the same order every time. Only the slug is kept: it is both the name of
// the file and the key the note is re-read by, and holding whole
// model.NoteSummary values — each carrying an excerpt, its tags, and both link
// lists — would scale the peak footprint with the size of the database rather
// than with its note count.
func listAll(ctx context.Context, notes *service.NoteService) ([]string, error) {
	var all []string
	for offset := 0; ; offset += pageSize {
		page, total, err := notes.List(ctx, "", nil, false, repository.SortCreated, repository.OrderAsc, pageSize, offset)
		if err != nil {
			return nil, fmt.Errorf("list notes: %w", err)
		}
		for _, n := range page {
			all = append(all, n.Slug)
		}
		// An empty page is the authoritative stop: total could disagree with what
		// the pages actually yield if the database changes under a long run.
		if len(page) == 0 || len(all) >= total {
			return all, nil
		}
	}
}

// exportNote reads one note in full and writes it to path as frontmatter plus
// body, using the same serialisation as the download-Markdown endpoint.
func exportNote(ctx context.Context, notes *service.NoteService, slug, path string) error {
	note, err := notes.Get(ctx, slug)
	if err != nil {
		return err
	}
	return os.WriteFile(path, []byte(service.MarkdownWithFrontmatter(note)), 0o644)
}

// fileNameFor returns the file name a note is exported under: its slug plus the
// Markdown extension, with an underscore ahead of the DOS device names Windows
// refuses.
//
// A slug that is not a bare name is rejected rather than joined into a path, so
// a malformed value reaching the database — past validateSlug, past the OpenAPI
// pattern — costs that one note an error line instead of letting the export
// write outside the directory it was given.
func fileNameFor(slug string) (string, error) {
	if !slugPattern.MatchString(slug) {
		return "", fmt.Errorf("unusable slug %q: not a bare lowercase-alphanumeric name", slug)
	}
	if windowsReserved[slug] {
		return "_" + slug + markdownExt, nil
	}
	return slug + markdownExt, nil
}
