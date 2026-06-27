package gdocs

import (
	"context"
	"fmt"
	"io"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/mikaelstaldal/mynotes/internal/htmlmd"
	"github.com/mikaelstaldal/mynotes/internal/model"
	"github.com/mikaelstaldal/mynotes/internal/service"
)

// Run imports all owned Google Docs into the note service, writing progress
// to w. Returns the count of successfully imported notes and any per-doc errors.
func Run(ctx context.Context, drive *Client, notes *service.NoteService, w io.Writer) (int, []error) {
	_, _ = fmt.Fprintln(w, "Listing Google Docs...")
	docs, err := drive.ListOwnedDocs(ctx)
	if err != nil {
		return 0, []error{fmt.Errorf("list docs: %w", err)}
	}
	_, _ = fmt.Fprintf(w, "Found %d document(s). Importing...\n", len(docs))

	var errs []error
	imported := 0
	for _, doc := range docs {
		note, err := importDoc(ctx, drive, notes, doc)
		if err != nil {
			_, _ = fmt.Fprintf(w, "  ✗ %s: %v\n", doc.Name, err)
			errs = append(errs, fmt.Errorf("%s: %w", doc.Name, err))
			continue
		}
		_, _ = fmt.Fprintf(w, "  ✓ %s → /notes/%s\n", doc.Name, note.Slug)
		imported++
	}
	return imported, errs
}

func importDoc(ctx context.Context, drive *Client, notes *service.NoteService, doc DriveFile) (model.Note, error) {
	content, isHTML, err := drive.ExportDoc(ctx, doc.ID)
	if err != nil {
		return model.Note{}, fmt.Errorf("export: %w", err)
	}
	if isHTML {
		result, err := htmlmd.Convert(content)
		if err != nil {
			return model.Note{}, fmt.Errorf("convert HTML to Markdown: %w", err)
		}
		content = result.Content
	}

	fm, err := marshalFrontmatter(doc.Name, doc.CreatedTime)
	if err != nil {
		return model.Note{}, fmt.Errorf("build frontmatter: %w", err)
	}

	return notes.ImportMarkdown(ctx, fm+content)
}

type docFrontmatter struct {
	Title string `yaml:"title"`
	Date  string `yaml:"date,omitempty"`
}

func marshalFrontmatter(title string, createdAt time.Time) (string, error) {
	fm := docFrontmatter{Title: title}
	if !createdAt.IsZero() {
		fm.Date = createdAt.UTC().Format(time.RFC3339)
	}
	data, err := yaml.Marshal(fm)
	if err != nil {
		return "", err
	}
	return "---\n" + string(data) + "---\n\n", nil
}
