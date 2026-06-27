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

	"github.com/mikaelstaldal/mynotes/internal/api"
	"github.com/mikaelstaldal/mynotes/internal/model"
	"github.com/mikaelstaldal/mynotes/internal/service"
)

type Handler struct {
	notes *service.NoteService
}

func New(notes *service.NoteService) *Handler {
	return &Handler{notes: notes}
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
