package handler_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mikaelstaldal/go-web-template/internal/api"
	"github.com/mikaelstaldal/go-web-template/internal/handler"
	"github.com/mikaelstaldal/go-web-template/internal/repository"
	"github.com/mikaelstaldal/go-web-template/internal/service"
)

// newServer wires the full handler → service → repository stack against an
// in-memory database, mirroring the production wiring in main.go.
func newServer(t *testing.T) *httptest.Server {
	t.Helper()
	db, err := sql.Open("sqlite", "file::memory:?cache=shared&_pragma=foreign_keys(on)")
	require.NoError(t, err)
	db.SetMaxOpenConns(1)
	require.NoError(t, repository.InitSchema(db))

	h := handler.New(service.NewItemService(repository.NewItemRepository(db)))
	ogenServer, err := api.NewServer(h, api.WithPathPrefix("/api/v1"))
	require.NoError(t, err)

	srv := httptest.NewServer(ogenServer)
	t.Cleanup(func() {
		srv.Close()
		_ = db.Close()
	})
	return srv
}

func TestCreateAndGetItem(t *testing.T) {
	srv := newServer(t)

	res, err := http.Post(srv.URL+"/api/v1/items", "application/json",
		strings.NewReader(`{"title":"Buy milk","content":"<b>2%</b><script>alert(1)</script>"}`))
	require.NoError(t, err)
	defer res.Body.Close()
	require.Equal(t, http.StatusCreated, res.StatusCode)

	var created api.Item
	require.NoError(t, json.NewDecoder(res.Body).Decode(&created))
	assert.Equal(t, "Buy milk", created.Title)
	assert.Equal(t, "<b>2%</b>", created.Content, "script tag should be sanitized out")

	res2, err := http.Get(srv.URL + "/api/v1/items")
	require.NoError(t, err)
	defer res2.Body.Close()
	require.Equal(t, http.StatusOK, res2.StatusCode)

	var list api.ItemList
	require.NoError(t, json.NewDecoder(res2.Body).Decode(&list))
	assert.Equal(t, 1, list.Total)
}

func TestCreateValidationError(t *testing.T) {
	srv := newServer(t)
	res, err := http.Post(srv.URL+"/api/v1/items", "application/json",
		strings.NewReader(`{"title":"   "}`))
	require.NoError(t, err)
	defer res.Body.Close()
	assert.Equal(t, http.StatusBadRequest, res.StatusCode)
}

func TestGetMissingReturns404(t *testing.T) {
	srv := newServer(t)
	res, err := http.Get(srv.URL + "/api/v1/items/424242")
	require.NoError(t, err)
	defer res.Body.Close()
	assert.Equal(t, http.StatusNotFound, res.StatusCode)
}

func TestDeleteItem(t *testing.T) {
	srv := newServer(t)

	post, err := http.Post(srv.URL+"/api/v1/items", "application/json",
		strings.NewReader(`{"title":"temp"}`))
	require.NoError(t, err)
	defer post.Body.Close()
	var item api.Item
	require.NoError(t, json.NewDecoder(post.Body).Decode(&item))

	req, err := http.NewRequestWithContext(context.Background(), http.MethodDelete,
		srv.URL+"/api/v1/items/"+strconv.FormatInt(item.ID, 10), nil)
	require.NoError(t, err)
	del, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer del.Body.Close()
	assert.Equal(t, http.StatusNoContent, del.StatusCode)
}
