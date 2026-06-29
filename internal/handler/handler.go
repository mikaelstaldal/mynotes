// Package handler implements the generated ogen api.Handler interface. It is a
// thin adapter: translate request DTOs to service calls, map domain results
// back to API types, and let NewError turn sentinel errors into status codes.
package handler

import (
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/mikaelstaldal/mynotes/internal/api"
	"github.com/mikaelstaldal/mynotes/internal/model"
	"github.com/mikaelstaldal/mynotes/internal/service"
)

type Handler struct {
	notes     *service.NoteService
	artifacts *service.ArtifactService
}

func New(notes *service.NoteService, artifacts *service.ArtifactService) *Handler {
	return &Handler{notes: notes, artifacts: artifacts}
}

var _ api.Handler = (*Handler)(nil)

func toAPI(n model.Note) api.Note {
	return api.Note{
		Slug:      n.Slug,
		Title:     n.Title,
		Content:   n.Content,
		CreatedAt: n.CreatedAt,
		UpdatedAt: n.UpdatedAt,
	}
}

func toAPISummary(n model.NoteSummary) api.NoteSummary {
	return api.NoteSummary{
		Slug:      n.Slug,
		Title:     n.Title,
		CreatedAt: n.CreatedAt,
		UpdatedAt: n.UpdatedAt,
		Excerpt:   n.Excerpt,
	}
}

// optPtr converts an ogen OptString to a *string: nil when absent (leave
// unchanged), a pointer to the value when present.
func optPtr(o api.OptString) *string {
	if v, ok := o.Get(); ok {
		return &v
	}
	return nil
}

func (h *Handler) ListNotes(ctx context.Context, params api.ListNotesParams) (*api.NoteList, error) {
	notes, total, err := h.notes.List(ctx, params.Q.Or(""), params.Limit.Or(50), params.Offset.Or(0))
	if err != nil {
		return nil, err
	}
	out := make([]api.NoteSummary, len(notes))
	for i, n := range notes {
		out[i] = toAPISummary(n)
	}
	return &api.NoteList{Total: total, Notes: out}, nil
}

func (h *Handler) GetNote(ctx context.Context, params api.GetNoteParams) (*api.Note, error) {
	n, err := h.notes.Get(ctx, params.Slug)
	if err != nil {
		return nil, err
	}
	out := toAPI(n)
	return &out, nil
}

func (h *Handler) CreateNote(ctx context.Context, req *api.CreateNoteRequest) (*api.Note, error) {
	n, err := h.notes.Create(ctx, req.Title, optPtr(req.Content), optPtr(req.Slug))
	if err != nil {
		return nil, err
	}
	out := toAPI(n)
	return &out, nil
}

func (h *Handler) UpdateNote(ctx context.Context, req *api.UpdateNoteRequest, params api.UpdateNoteParams) (*api.Note, error) {
	n, err := h.notes.Update(ctx, params.Slug, optPtr(req.Title), optPtr(req.Content), optPtr(req.Slug))
	if err != nil {
		return nil, err
	}
	out := toAPI(n)
	return &out, nil
}

func (h *Handler) DeleteNote(ctx context.Context, params api.DeleteNoteParams) error {
	return h.notes.Delete(ctx, params.Slug)
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

// DownloadNoteMarkdown returns the note content as a raw text/markdown body with a
// Content-Disposition attachment header. An unknown slug maps to the operation's
// typed 404 (*api.Error), keeping the JSON error shape.
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
		Response:           api.DownloadNoteMarkdownOK{Data: strings.NewReader(n.Content)},
	}, nil
}

// DownloadNoteHtml converts the note content from Markdown to HTML on the server
// and returns a complete HTML document with a Content-Disposition attachment header.
// An unknown slug maps to the operation's typed 404 (*api.Error).
func (h *Handler) DownloadNoteHtml(ctx context.Context, params api.DownloadNoteHtmlParams) (api.DownloadNoteHtmlRes, error) {
	n, err := h.notes.Get(ctx, params.Slug)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			return &api.Error{Error: err.Error()}, nil
		}
		return nil, err
	}
	htmlDoc, err := service.RenderToHTML(n.Title, n.Content)
	if err != nil {
		return nil, err
	}
	return &api.DownloadNoteHtmlOKHeaders{
		ContentDisposition:    `attachment; filename="` + n.Slug + `.html"`,
		XContentTypeOptions:   "nosniff",
		ContentSecurityPolicy: "sandbox",
		Response:              api.DownloadNoteHtmlOK{Data: strings.NewReader(htmlDoc)},
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
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("Last-Modified", a.CreatedAt.UTC().Format(time.RFC1123))
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
	default:
		log.Printf("internal error: %v", err)
		return &api.ErrorStatusCode{StatusCode: http.StatusInternalServerError, Response: api.Error{Error: "internal server error"}}
	}
}
