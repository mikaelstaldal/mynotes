// Package handler implements the generated ogen api.Handler interface. It is a
// thin adapter: translate request DTOs to service calls, map domain results
// back to API types, and let NewError turn sentinel errors into status codes.
package handler

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/mikaelstaldal/go-web-template/internal/api"
	"github.com/mikaelstaldal/go-web-template/internal/model"
	"github.com/mikaelstaldal/go-web-template/internal/service"
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

// DownloadNote returns the note content as a raw text/markdown body with a
// Content-Disposition attachment header. It reuses the service get-by-slug; an
// unknown slug maps to the operation's typed 404 (*api.Error), keeping the JSON
// error shape. No new business logic lives here.
func (h *Handler) DownloadNote(ctx context.Context, params api.DownloadNoteParams) (api.DownloadNoteRes, error) {
	n, err := h.notes.Get(ctx, params.Slug)
	if err != nil {
		if errors.Is(err, service.ErrNotFound) {
			return &api.Error{Error: err.Error()}, nil
		}
		return nil, err
	}
	return &api.DownloadNoteOKHeaders{
		ContentDisposition: `attachment; filename="` + n.Slug + `.md"`,
		Response:           api.DownloadNoteOK{Data: strings.NewReader(n.Content)},
	}, nil
}

// NewError maps any error returned by a handler method to an HTTP status code.
// ogen calls this for non-nil errors that are not already an *ErrorStatusCode.
func (h *Handler) NewError(_ context.Context, err error) *api.ErrorStatusCode {
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, service.ErrNotFound):
		status = http.StatusNotFound
	case errors.Is(err, service.ErrValidation):
		status = http.StatusBadRequest
	case errors.Is(err, service.ErrConflict):
		status = http.StatusConflict
	}
	return &api.ErrorStatusCode{
		StatusCode: status,
		Response:   api.Error{Error: err.Error()},
	}
}
