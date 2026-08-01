package service

import (
	"context"
	"regexp"
	"sort"
	"strings"
	"time"

	"golang.org/x/net/html"

	"github.com/mikaelstaldal/mynotes/internal/model"
	"github.com/mikaelstaldal/mynotes/internal/repository"
	"github.com/mikaelstaldal/mynotes/internal/sanitize"
)

// maxPublishedHTMLLen bounds a published note's rendered HTML. It is well above
// what maxContentLen worth of Markdown expands to, and artifacts are referenced
// rather than inlined, so the fragment carries no image bytes.
const maxPublishedHTMLLen = 2_000_000

// publicArtifactPrefix is where the published page reaches its artifacts. It is
// relative, resolved against /public/notes/{slug}, which is what makes a stored
// snapshot deployment-independent: under a subpath deployment
// (-public-url https://example.com/notes) the browser resolves it inside the
// deployment, exactly as `artifact:` references are expanded for the app itself
// (see web/ts/util/markdown.ts). An absolute path baked in at publish time
// would break every published page if the deployment later moved.
const publicArtifactPrefix = "../artifacts/"

// artifactRefRE matches a canonical artifact reference as a *whole* attribute
// value. It is deliberately anchored and applied only to image-source
// attributes (see expandArtifactRefs): matching it against the fragment as text
// would treat a note that merely writes `artifact:<sha256>` in prose or a code
// span as using that artifact — corrupting the text, and, worse, publishing an
// artifact the page never displays.
var artifactRefRE = regexp.MustCompile(`^artifact:([0-9a-f]{64})$`)

// imageSourceAttr names the attribute that carries an image's source, for the
// two elements the render pipeline resolves artifact references on (see the
// DOMPurify hook in web/ts/util/markdown.ts). Any other element, and any other
// attribute, is left alone.
func imageSourceAttr(element string) string {
	switch element {
	case "img":
		return "src"
	case "image": // SVG
		return "href"
	}
	return ""
}

// expandArtifactRefs rewrites every `artifact:<sha256>` image source in a
// published fragment to its public artifact URL, and returns the rewritten
// fragment together with the distinct digests it rewrote (sorted, so the stored
// rows and the tests are deterministic).
//
// The returned digests are what becomes publicly readable, so this walk is a
// security boundary: an artifact reaches `published_note_artifacts` only by
// appearing where the page will actually load it from.
//
// It walks tokens rather than parsing a tree, and re-serializes only the tokens
// it changes — every other byte is passed through verbatim. That matters for
// more than fidelity: bluemonday emits a <style> element's CSS as raw text (see
// sanitize.newPublishedPolicy), and re-serializing it would escape the `>` in a
// child combinator and break the diagram it styles.
func expandArtifactRefs(fragment string) (string, []string) {
	var out strings.Builder
	out.Grow(len(fragment))
	seen := make(map[string]struct{})

	z := html.NewTokenizer(strings.NewReader(fragment))
	for {
		tt := z.Next()
		if tt == html.ErrorToken {
			// io.EOF for any well-formed byte stream; HTML tokenizing is total,
			// so there is no other outcome for bluemonday's own output.
			break
		}
		if tt != html.StartTagToken && tt != html.SelfClosingTagToken {
			out.Write(z.Raw())
			continue
		}
		// Token() consumes the tokenizer's view of the raw bytes, so keep a copy
		// to fall back on when the tag turns out not to need rewriting.
		raw := append([]byte(nil), z.Raw()...)
		t := z.Token()
		attr := imageSourceAttr(t.Data)
		rewrote := false
		for i := range t.Attr {
			if t.Attr[i].Key != attr {
				continue
			}
			m := artifactRefRE.FindStringSubmatch(t.Attr[i].Val)
			if m == nil {
				continue
			}
			seen[m[1]] = struct{}{}
			t.Attr[i].Val = publicArtifactPrefix + m[1]
			rewrote = true
		}
		if rewrote {
			out.WriteString(t.String())
		} else {
			out.Write(raw)
		}
	}

	digests := make([]string, 0, len(seen))
	for digest := range seen {
		digests = append(digests, digest)
	}
	sort.Strings(digests)
	return out.String(), digests
}

// PublishService owns the published-note lifecycle: taking the HTML the
// frontend rendered from a note, guarding it, and recording which artifacts it
// makes public. The rendering itself is the frontend's job — the shared render
// pipeline lives there (web/ts/util/markdown.ts), and re-implementing the
// Markdown dialect on the server would be a second source of truth.
type PublishService struct {
	notes     *repository.NoteRepository
	published *repository.PublishedNoteRepository
	artifacts *repository.ArtifactRepository
}

func NewPublishService(
	notes *repository.NoteRepository,
	published *repository.PublishedNoteRepository,
	artifacts *repository.ArtifactRepository,
) *PublishService {
	return &PublishService{notes: notes, published: published, artifacts: artifacts}
}

// Publish stores the given rendered HTML as the note's public snapshot and
// returns it. Re-publishing replaces the previous snapshot.
//
// The HTML arrives from an API client and is therefore untrusted, like any
// other write. Unlike note content — stored verbatim Markdown, so validated and
// rejected rather than rewritten — this is derived output, so the guard is
// sanitize-and-store: whatever the policy strips simply does not reach a reader.
func (s *PublishService) Publish(ctx context.Context, slug, html string) (model.PublishedNote, error) {
	note, err := s.notes.GetBySlug(ctx, slug)
	if err != nil {
		return model.PublishedNote{}, err
	}
	if len(html) > maxPublishedHTMLLen {
		return model.PublishedNote{}, validationError("published HTML is too large")
	}

	expanded, digests := expandArtifactRefs(sanitize.PublishedHTML(html))
	for _, digest := range digests {
		exists, err := s.artifacts.Exists(ctx, digest)
		if err != nil {
			return model.PublishedNote{}, err
		}
		if !exists {
			// Publishing a page whose images 404 is a worse outcome than
			// refusing: the reader cannot tell the difference between a missing
			// artifact and a broken deployment. Nothing has been written yet, so
			// returning here publishes nothing.
			return model.PublishedNote{}, validationError("published HTML references an unknown artifact")
		}
	}
	html = expanded

	at := time.Now().UTC()
	if err := s.published.Publish(ctx, note.ID, note.Title, html, digests, at); err != nil {
		return model.PublishedNote{}, err
	}
	return model.PublishedNote{Slug: note.Slug, Title: note.Title, HTML: html, PublishedAt: at}, nil
}

// Unpublish withdraws a note's public snapshot, returning ErrNotFound when the
// note does not exist or is not published.
func (s *PublishService) Unpublish(ctx context.Context, slug string) error {
	note, err := s.notes.GetBySlug(ctx, slug)
	if err != nil {
		return err
	}
	return s.published.Unpublish(ctx, note.ID)
}

// Get returns a note's public snapshot. This is the read behind the
// unauthenticated page, so it takes the slug straight from the URL.
func (s *PublishService) Get(ctx context.Context, slug string) (model.PublishedNote, error) {
	if !slugPattern.MatchString(slug) {
		return model.PublishedNote{}, ErrNotFound
	}
	return s.published.GetBySlug(ctx, slug)
}

// ArtifactPublished reports whether the given digest is referenced by some
// published note, and is therefore readable without authentication. A malformed
// digest is ErrNotFound-shaped (false) rather than a validation error, matching
// ArtifactService.Get.
func (s *PublishService) ArtifactPublished(ctx context.Context, sha256hex string) (bool, error) {
	if !sha256HexPattern.MatchString(sha256hex) {
		return false, nil
	}
	return s.published.ArtifactPublished(ctx, sha256hex)
}

// PublishedNoteDocument wraps a published fragment in the complete HTML document
// served at /public/notes/{slug}.
//
// The fragment is stored, and the document built here, rather than the whole
// page being stored: the styling and structure of a published page are ours to
// change, and doing so must not require re-publishing every note. The title is
// rendered twice — as <title> for the tab and share previews, and as the <h1>
// the read view shows above the content — and the stylesheet link is relative
// for the same reason the artifact prefix is (see publicArtifactPrefix).
func PublishedNoteDocument(p model.PublishedNote) string {
	title := escapeHTMLText(p.Title)
	var b strings.Builder
	b.WriteString("<!DOCTYPE html>\n<html lang=\"en\">\n<head><meta charset=\"utf-8\">")
	b.WriteString("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">")
	b.WriteString("<title>")
	b.WriteString(title)
	b.WriteString("</title><link rel=\"stylesheet\" href=\"../note.css\"></head>\n")
	b.WriteString("<body><main class=\"note-content\"><h1>")
	b.WriteString(title)
	b.WriteString("</h1>\n")
	b.WriteString(p.HTML)
	b.WriteString("\n</main></body>\n</html>\n")
	return b.String()
}

// escapeHTMLText escapes a plain string for use as HTML text or as a
// double-quoted attribute value. A note title is validated for length and
// control characters but never sanitized (it is not stored as markup), so it
// must be escaped wherever it is spliced into HTML.
func escapeHTMLText(s string) string {
	return strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&#39;",
	).Replace(s)
}
