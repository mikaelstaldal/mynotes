// Package handler implements the generated ogen api.Handler interface. It is a
// thin adapter: translate request DTOs to service calls, map domain results
// back to API types, and let NewError turn sentinel errors into status codes.
package handler

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"

	"github.com/mikaelstaldal/mynotes/internal/api"
	"github.com/mikaelstaldal/mynotes/internal/model"
	"github.com/mikaelstaldal/mynotes/internal/service"
)

type Handler struct {
	notes     *service.NoteService
	artifacts *service.ArtifactService
	tags      *service.TagService
}

func New(notes *service.NoteService, artifacts *service.ArtifactService, tags *service.TagService) *Handler {
	return &Handler{notes: notes, artifacts: artifacts, tags: tags}
}

var _ api.Handler = (*Handler)(nil)

func toAPITag(t model.Tag) api.Tag {
	return api.Tag{Slug: t.Slug}
}

func toAPITags(tags []model.Tag) []api.Tag {
	out := make([]api.Tag, len(tags))
	for i, t := range tags {
		out[i] = toAPITag(t)
	}
	return out
}

func toAPINoteLink(l model.NoteLink) api.NoteLink {
	return api.NoteLink{Slug: l.Slug, Title: l.Title}
}

func toAPINoteLinks(links []model.NoteLink) []api.NoteLink {
	out := make([]api.NoteLink, len(links))
	for i, l := range links {
		out[i] = toAPINoteLink(l)
	}
	return out
}

func toAPI(n model.Note) api.Note {
	return api.Note{
		Slug:          n.Slug,
		Title:         n.Title,
		Content:       n.Content,
		CreatedAt:     n.CreatedAt,
		UpdatedAt:     n.UpdatedAt,
		Version:       n.Version,
		Tags:          toAPITags(n.Tags),
		IncomingLinks: toAPINoteLinks(n.IncomingLinks),
		OutgoingLinks: toAPINoteLinks(n.OutgoingLinks),
	}
}

func toAPISummary(n model.NoteSummary) api.NoteSummary {
	return api.NoteSummary{
		Slug:          n.Slug,
		Title:         n.Title,
		Excerpt:       n.Excerpt,
		CreatedAt:     n.CreatedAt,
		UpdatedAt:     n.UpdatedAt,
		Version:       n.Version,
		Tags:          toAPITags(n.Tags),
		IncomingLinks: toAPINoteLinks(n.IncomingLinks),
		OutgoingLinks: toAPINoteLinks(n.OutgoingLinks),
	}
}

func formatETag(version int) string { return fmt.Sprintf(`"%d"`, version) }

// optPtr converts an ogen OptString to a *string: nil when absent (leave
// unchanged), a pointer to the value when present.
func optPtr(o api.OptString) *string {
	if v, ok := o.Get(); ok {
		return &v
	}
	return nil
}

func (h *Handler) ListNotes(ctx context.Context, params api.ListNotesParams) (*api.NoteList, error) {
	notes, total, err := h.notes.List(ctx, params.Q.Or(""), params.Tag, params.TitlePrefix.Or(false),
		string(params.Sort.Or(api.ListNotesSortUpdated)), string(params.Order.Or(api.ListNotesOrderDesc)),
		params.Limit.Or(50), params.Offset.Or(0))
	if err != nil {
		return nil, err
	}
	out := make([]api.NoteSummary, len(notes))
	for i, n := range notes {
		out[i] = toAPISummary(n)
	}
	return &api.NoteList{Total: total, Notes: out}, nil
}

func (h *Handler) GetNote(ctx context.Context, params api.GetNoteParams) (*api.NoteHeaders, error) {
	n, err := h.notes.Get(ctx, params.Slug)
	if err != nil {
		return nil, err
	}
	return &api.NoteHeaders{Etag: formatETag(n.Version), Response: toAPI(n)}, nil
}

func (h *Handler) CreateNote(ctx context.Context, req *api.CreateNoteRequest) (*api.Note, error) {
	n, err := h.notes.Create(ctx, req.Title, optPtr(req.Content), optPtr(req.Slug), req.Tags)
	if err != nil {
		return nil, err
	}
	out := toAPI(n)
	return &out, nil
}

// optTagsPtr converts ogen's bare []string tags field to a *[]string: nil
// when the JSON key was absent (leave unchanged), a pointer to the slice
// (possibly empty) when present — see UpdateNoteRequest.Decode, which only
// assigns Tags when the "tags" key appears in the request body.
func optTagsPtr(tags []string) *[]string {
	if tags == nil {
		return nil
	}
	return &tags
}

func (h *Handler) UpdateNote(ctx context.Context, req *api.UpdateNoteRequest, params api.UpdateNoteParams) (api.UpdateNoteRes, error) {
	var ifMatch *string
	if v, ok := params.IfMatch.Get(); ok {
		ifMatch = &v
	}
	n, err := h.notes.Update(ctx, params.Slug, optPtr(req.Title), optPtr(req.Content), optTagsPtr(req.Tags), ifMatch)
	if errors.Is(err, service.ErrVersionMismatch) {
		return &api.Error{Error: err.Error()}, nil
	}
	if err != nil {
		return nil, err
	}
	return &api.NoteHeaders{Etag: formatETag(n.Version), Response: toAPI(n)}, nil
}

func (h *Handler) DeleteNote(ctx context.Context, params api.DeleteNoteParams) error {
	return h.notes.Delete(ctx, params.Slug)
}

func (h *Handler) SplitNote(ctx context.Context, req api.OptSplitNoteRequest, params api.SplitNoteParams) (*api.SplitNoteResponse, error) {
	var tag *string
	if r, ok := req.Get(); ok {
		tag = optPtr(r.Tag)
	}
	notes, err := h.notes.Split(ctx, params.Slug, tag)
	if err != nil {
		return nil, err
	}
	out := make([]api.NoteSummary, len(notes))
	for i, n := range notes {
		out[i] = toAPISummary(n)
	}
	return &api.SplitNoteResponse{Notes: out}, nil
}

func (h *Handler) ListTags(ctx context.Context) (*api.TagList, error) {
	tags, err := h.tags.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]api.TagSummary, len(tags))
	for i, t := range tags {
		out[i] = api.TagSummary{Slug: t.Slug, NoteCount: t.NoteCount}
	}
	return &api.TagList{Tags: out}, nil
}

func (h *Handler) CreateTag(ctx context.Context, req *api.CreateTagRequest) (*api.Tag, error) {
	t, err := h.tags.Create(ctx, req.Slug)
	if err != nil {
		return nil, err
	}
	out := toAPITag(t)
	return &out, nil
}

func (h *Handler) DeleteTag(ctx context.Context, params api.DeleteTagParams) error {
	return h.tags.Delete(ctx, params.Slug)
}

func (h *Handler) ImportNote(ctx context.Context, req api.ImportNoteReq) (*api.Note, error) {
	var n model.Note
	var err error
	switch r := req.(type) {
	case *api.ImportNoteReqTextHTML:
		data, readErr := io.ReadAll(r.Data)
		if readErr != nil {
			return nil, readErr
		}
		n, err = h.notes.ImportHTML(ctx, string(data))
	case *api.ImportNoteReqTextMarkdown:
		data, readErr := io.ReadAll(r.Data)
		if readErr != nil {
			return nil, readErr
		}
		n, err = h.notes.ImportMarkdown(ctx, string(data))
	}
	if err != nil {
		return nil, err
	}
	out := toAPI(n)
	return &out, nil
}

// DownloadNoteMarkdown returns the note as a text/markdown body with a
// Content-Disposition attachment header. The body is a YAML frontmatter block
// (title, slug, date) prepended to the verbatim Markdown content, round-trip
// compatible with the Markdown import feature. An unknown slug maps to the
// operation's typed 404 (*api.Error), keeping the JSON error shape.
func (h *Handler) DownloadNoteMarkdown(ctx context.Context, params api.DownloadNoteMarkdownParams) (api.DownloadNoteMarkdownRes, error) {
	n, err := h.notes.Get(ctx, params.Slug)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			return &api.Error{Error: err.Error()}, nil
		}
		return nil, err
	}
	return &api.DownloadNoteMarkdownOKHeaders{
		ContentDisposition: `attachment; filename="` + n.Slug + `.md"`,
		Response:           api.DownloadNoteMarkdownOK{Data: strings.NewReader(service.MarkdownWithFrontmatter(n))},
	}, nil
}

func toAPIArtifact(a model.Artifact) api.Artifact {
	return api.Artifact{
		SHA256:      a.SHA256,
		ContentType: a.ContentType,
		CreatedAt:   a.CreatedAt,
	}
}

func (h *Handler) CreateArtifact(ctx context.Context, req api.CreateArtifactReq) (*api.Artifact, error) {
	var content []byte
	var contentType string
	var readErr error
	switch r := req.(type) {
	case *api.CreateArtifactReqImagePNG:
		contentType = "image/png"
		content, readErr = io.ReadAll(r.Data)
	case *api.CreateArtifactReqImageJpeg:
		contentType = "image/jpeg"
		content, readErr = io.ReadAll(r.Data)
	case *api.CreateArtifactReqImageGIF:
		contentType = "image/gif"
		content, readErr = io.ReadAll(r.Data)
	case *api.CreateArtifactReqImageWEBP:
		contentType = "image/webp"
		content, readErr = io.ReadAll(r.Data)
	case *api.CreateArtifactReqImageSvgXML:
		contentType = "image/svg+xml"
		content, readErr = io.ReadAll(r.Data)
	case *api.CreateArtifactReqApplicationMathmlXML:
		contentType = "application/mathml+xml"
		content, readErr = io.ReadAll(r.Data)
	}
	if readErr != nil {
		return nil, readErr
	}
	a, err := h.artifacts.Create(ctx, content, contentType)
	if err != nil {
		return nil, err
	}
	out := toAPIArtifact(a)
	return &out, nil
}

func (h *Handler) DeleteArtifact(ctx context.Context, params api.DeleteArtifactParams) error {
	return h.artifacts.Delete(ctx, params.SHA256)
}

// GetArtifact is overridden by ServeArtifact and never used
func (h *Handler) GetArtifact(ctx context.Context, params api.GetArtifactParams) (api.GetArtifactRes, error) {
	return nil, fmt.Errorf("not used")
}

// GetIcon is declared in the spec for clients (e.g. the Android app) but
// served by the raw icons.Handler mounted directly on the mux, so this ogen stub
// is never used.
func (h *Handler) GetIcon(ctx context.Context, params api.GetIconParams) (api.GetIconRes, error) {
	return nil, fmt.Errorf("not used")
}

// ServeArtifact is a raw http.HandlerFunc for GET /api/v1/artifacts/{sha256}.
// It is registered directly on the mux (not through ogen) so it can set a
// dynamic Content-Type response header matching the stored artifact MIME type.
func (h *Handler) ServeArtifact(w http.ResponseWriter, r *http.Request) {
	sha256hex := r.PathValue("sha256")
	a, err := h.artifacts.Get(r.Context(), sha256hex)
	if errors.Is(err, service.ErrNotFound) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"not found"}`))
		return
	}
	if err != nil {
		log.Printf("serve artifact: %v", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"internal server error"}`))
		return
	}
	w.Header().Set("Content-Type", a.ContentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("Last-Modified", a.CreatedAt.UTC().Format(http.TimeFormat))
	// SVG and MathML are active content: if navigated to directly on the app
	// origin they could execute scripts. A sandboxed CSP prevents that without
	// breaking <img src> rendering (response headers are not applied in image
	// subresource contexts).
	if a.ContentType == "image/svg+xml" || a.ContentType == "application/mathml+xml" {
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
	}
	_, _ = w.Write(a.Content)
}

// NewError maps any error returned by a handler method to an HTTP status code.
// ogen calls this for non-nil errors that are not already an *ErrorStatusCode.
func (h *Handler) NewError(_ context.Context, err error) *api.ErrorStatusCode {
	switch {
	case errors.Is(err, service.ErrNotFound):
		return &api.ErrorStatusCode{StatusCode: http.StatusNotFound, Response: api.Error{Error: err.Error()}}
	case errors.Is(err, service.ErrValidation):
		return &api.ErrorStatusCode{StatusCode: http.StatusBadRequest, Response: api.Error{Error: err.Error()}}
	case errors.Is(err, service.ErrConflict):
		return &api.ErrorStatusCode{StatusCode: http.StatusConflict, Response: api.Error{Error: err.Error()}}
	case errors.Is(err, service.ErrVersionMismatch):
		return &api.ErrorStatusCode{StatusCode: http.StatusPreconditionFailed, Response: api.Error{Error: err.Error()}}
	default:
		log.Printf("internal error: %v", err)
		return &api.ErrorStatusCode{StatusCode: http.StatusInternalServerError, Response: api.Error{Error: "internal server error"}}
	}
}
