// Package handler implements the generated ogen api.Handler interface. It is a
// thin adapter: translate request DTOs to service calls, map domain results
// back to API types, and let NewError turn sentinel errors into status codes.
package handler

import (
	"context"
	"errors"
	"net/http"

	"github.com/mikaelstaldal/go-web-template/internal/api"
	"github.com/mikaelstaldal/go-web-template/internal/model"
	"github.com/mikaelstaldal/go-web-template/internal/service"
)

type Handler struct {
	items *service.ItemService
}

func New(items *service.ItemService) *Handler {
	return &Handler{items: items}
}

var _ api.Handler = (*Handler)(nil)

func toAPI(it model.Item) api.Item {
	return api.Item{
		ID:        it.ID,
		Title:     it.Title,
		Content:   it.Content,
		CreatedAt: it.CreatedAt,
		UpdatedAt: it.UpdatedAt,
	}
}

func (h *Handler) ListItems(ctx context.Context, params api.ListItemsParams) (*api.ItemList, error) {
	items, err := h.items.List(ctx, params.Q.Or(""), params.Limit.Or(50), params.Offset.Or(0))
	if err != nil {
		return nil, err
	}
	out := make([]api.Item, len(items))
	for i, it := range items {
		out[i] = toAPI(it)
	}
	return &api.ItemList{Total: len(out), Items: out}, nil
}

func (h *Handler) GetItem(ctx context.Context, params api.GetItemParams) (*api.Item, error) {
	it, err := h.items.Get(ctx, params.ID)
	if err != nil {
		return nil, err
	}
	out := toAPI(it)
	return &out, nil
}

func (h *Handler) CreateItem(ctx context.Context, req *api.ItemRequest) (*api.Item, error) {
	it, err := h.items.Create(ctx, req.Title, req.Content.Or(""))
	if err != nil {
		return nil, err
	}
	out := toAPI(it)
	return &out, nil
}

func (h *Handler) UpdateItem(ctx context.Context, req *api.ItemUpdate, params api.UpdateItemParams) (*api.Item, error) {
	var title, content *string
	if v, ok := req.Title.Get(); ok {
		title = &v
	}
	if v, ok := req.Content.Get(); ok {
		content = &v
	}
	it, err := h.items.Update(ctx, params.ID, title, content)
	if err != nil {
		return nil, err
	}
	out := toAPI(it)
	return &out, nil
}

func (h *Handler) DeleteItem(ctx context.Context, params api.DeleteItemParams) error {
	return h.items.Delete(ctx, params.ID)
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
	}
	return &api.ErrorStatusCode{
		StatusCode: status,
		Response:   api.Error{Error: err.Error()},
	}
}
