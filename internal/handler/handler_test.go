package handler_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mikaelstaldal/mynotes/internal/api"
	"github.com/mikaelstaldal/mynotes/internal/handler"
	"github.com/mikaelstaldal/mynotes/internal/repository"
	"github.com/mikaelstaldal/mynotes/internal/service"
)

// newServer wires the full handler → service → repository stack against an
// in-memory database, mirroring the production wiring in main.go.
func newServer(t *testing.T) *httptest.Server {
	t.Helper()
	db, err := sql.Open("sqlite", "file::memory:?cache=shared&_pragma=foreign_keys(on)")
	require.NoError(t, err)
	db.SetMaxOpenConns(1)
	require.NoError(t, repository.InitSchema(db))

	h := handler.New(service.NewNoteService(repository.NewNoteRepository(db)))
	ogenServer, err := api.NewServer(h, api.WithPathPrefix("/api/v1"))
	require.NoError(t, err)

	srv := httptest.NewServer(ogenServer)
	t.Cleanup(func() {
		srv.Close()
		_ = db.Close()
	})
	return srv
}

// createNote POSTs a note and returns the decoded response, asserting 201.
func createNote(t *testing.T, srv *httptest.Server, body string) api.Note {
	t.Helper()
	res, err := http.Post(srv.URL+"/api/v1/notes", "application/json", strings.NewReader(body))
	require.NoError(t, err)
	defer res.Body.Close()
	require.Equal(t, http.StatusCreated, res.StatusCode)
	var created api.Note
	require.NoError(t, json.NewDecoder(res.Body).Decode(&created))
	return created
}

func TestCreateAndGetNote(t *testing.T) {
	srv := newServer(t)

	created := createNote(t, srv, `{"title":"Buy milk","content":"# Shopping\n\nmilk"}`)
	assert.Equal(t, "Buy milk", created.Title)
	assert.Equal(t, "buy-milk", created.Slug, "slug should be derived from the title")
	assert.Equal(t, "# Shopping\n\nmilk", created.Content, "content is stored verbatim")

	res, err := http.Get(srv.URL + "/api/v1/notes/" + created.Slug)
	require.NoError(t, err)
	defer res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)

	var got api.Note
	require.NoError(t, json.NewDecoder(res.Body).Decode(&got))
	assert.Equal(t, created.Slug, got.Slug)
	assert.Equal(t, created.Content, got.Content)
}

func TestCreateValidationError(t *testing.T) {
	srv := newServer(t)
	res, err := http.Post(srv.URL+"/api/v1/notes", "application/json",
		strings.NewReader(`{"title":"   "}`))
	require.NoError(t, err)
	defer res.Body.Close()
	assert.Equal(t, http.StatusBadRequest, res.StatusCode)
}

func TestCreateExplicitSlugConflict(t *testing.T) {
	srv := newServer(t)
	createNote(t, srv, `{"title":"First","slug":"shared"}`)

	res, err := http.Post(srv.URL+"/api/v1/notes", "application/json",
		strings.NewReader(`{"title":"Second","slug":"shared"}`))
	require.NoError(t, err)
	defer res.Body.Close()
	assert.Equal(t, http.StatusConflict, res.StatusCode)
}

func TestGetMissingReturns404(t *testing.T) {
	srv := newServer(t)
	res, err := http.Get(srv.URL + "/api/v1/notes/does-not-exist")
	require.NoError(t, err)
	defer res.Body.Close()
	assert.Equal(t, http.StatusNotFound, res.StatusCode)
}

func TestUpdateNote(t *testing.T) {
	srv := newServer(t)
	created := createNote(t, srv, `{"title":"Draft","content":"old"}`)

	req, err := http.NewRequestWithContext(context.Background(), http.MethodPatch,
		srv.URL+"/api/v1/notes/"+created.Slug, strings.NewReader(`{"content":"new"}`))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)

	var updated api.Note
	require.NoError(t, json.NewDecoder(res.Body).Decode(&updated))
	assert.Equal(t, "new", updated.Content)
	assert.Equal(t, "Draft", updated.Title, "title left unchanged when absent")
}

func TestDeleteNote(t *testing.T) {
	srv := newServer(t)
	created := createNote(t, srv, `{"title":"temp"}`)

	// First delete removes the row → 204.
	req, err := http.NewRequestWithContext(context.Background(), http.MethodDelete,
		srv.URL+"/api/v1/notes/"+created.Slug, nil)
	require.NoError(t, err)
	del, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer del.Body.Close()
	assert.Equal(t, http.StatusNoContent, del.StatusCode)
}

func TestDeleteUnknownReturns404(t *testing.T) {
	srv := newServer(t)
	// DELETE is not idempotent here: an unknown slug is a 404, not a 204.
	req, err := http.NewRequestWithContext(context.Background(), http.MethodDelete,
		srv.URL+"/api/v1/notes/never-existed", nil)
	require.NoError(t, err)
	res, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer res.Body.Close()
	assert.Equal(t, http.StatusNotFound, res.StatusCode)
}

func TestDownloadNote(t *testing.T) {
	srv := newServer(t)
	created := createNote(t, srv, `{"title":"Notes","content":"# Heading\n\nbody"}`)

	res, err := http.Get(srv.URL + "/api/v1/notes/" + created.Slug + "/download")
	require.NoError(t, err)
	defer res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)

	assert.Equal(t, "text/markdown", res.Header.Get("Content-Type"))
	assert.Equal(t, `attachment; filename="`+created.Slug+`.md"`,
		res.Header.Get("Content-Disposition"))

	body, err := io.ReadAll(res.Body)
	require.NoError(t, err)
	assert.Equal(t, "# Heading\n\nbody", string(body), "raw verbatim Markdown body")
}

func TestDownloadUnknownReturns404(t *testing.T) {
	srv := newServer(t)
	res, err := http.Get(srv.URL + "/api/v1/notes/missing/download")
	require.NoError(t, err)
	defer res.Body.Close()
	require.Equal(t, http.StatusNotFound, res.StatusCode)
	assert.Contains(t, res.Header.Get("Content-Type"), "application/json",
		"download errors keep the JSON error shape")

	var body api.Error
	require.NoError(t, json.NewDecoder(res.Body).Decode(&body))
	assert.NotEmpty(t, body.Error)
}

func TestDownloadEmptyContentNote(t *testing.T) {
	srv := newServer(t)
	// content is absent → service coalesces it to "". The download is still a
	// well-formed 200 with the attachment header and an empty raw body.
	created := createNote(t, srv, `{"title":"Empty"}`)
	require.Empty(t, created.Content)

	res, err := http.Get(srv.URL + "/api/v1/notes/" + created.Slug + "/download")
	require.NoError(t, err)
	defer res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)

	assert.Equal(t, "text/markdown", res.Header.Get("Content-Type"))
	assert.Equal(t, `attachment; filename="`+created.Slug+`.md"`,
		res.Header.Get("Content-Disposition"))

	body, err := io.ReadAll(res.Body)
	require.NoError(t, err)
	assert.Empty(t, body, "empty-content note downloads as an empty body")
}

func TestListReturnsSummaries(t *testing.T) {
	srv := newServer(t)
	createNote(t, srv, `{"title":"First","content":"alpha body"}`)
	createNote(t, srv, `{"title":"Second","content":"beta body"}`)

	res, err := http.Get(srv.URL + "/api/v1/notes")
	require.NoError(t, err)
	defer res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)

	var list api.NoteList
	require.NoError(t, json.NewDecoder(res.Body).Decode(&list))
	assert.Equal(t, 2, list.Total)
	require.Len(t, list.Notes, 2)
	// Ordered newest-first: the second note created sorts ahead of the first.
	assert.Equal(t, "second", list.Notes[0].Slug)
	assert.Equal(t, "Second", list.Notes[0].Title)
	assert.Equal(t, "beta body", list.Notes[0].Excerpt, "short content is the verbatim excerpt")
	assert.Equal(t, "first", list.Notes[1].Slug)
}

func TestListPastTheEndOffset(t *testing.T) {
	srv := newServer(t)
	createNote(t, srv, `{"title":"one"}`)
	createNote(t, srv, `{"title":"two"}`)

	res, err := http.Get(srv.URL + "/api/v1/notes?offset=10")
	require.NoError(t, err)
	defer res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)

	var list api.NoteList
	require.NoError(t, json.NewDecoder(res.Body).Decode(&list))
	assert.Equal(t, 2, list.Total, "total reflects all matching notes, not the page")
	assert.Empty(t, list.Notes, "a past-the-end page is an empty array, not null")
	assert.NotNil(t, list.Notes)
}

// importHTML posts HTML to the import endpoint and returns the response.
func importHTML(t *testing.T, srv *httptest.Server, htmlBody string) *http.Response {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost,
		srv.URL+"/api/v1/import-html", strings.NewReader(htmlBody))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "text/html")
	res, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	return res
}

func TestImportHtmlTitleFromTitleElement(t *testing.T) {
	srv := newServer(t)
	htmlDoc := `<html><head><title>My Imported Note</title></head><body><h1>Heading</h1><p>Content here.</p></body></html>`
	res := importHTML(t, srv, htmlDoc)
	defer res.Body.Close()
	require.Equal(t, http.StatusCreated, res.StatusCode)
	var note api.Note
	require.NoError(t, json.NewDecoder(res.Body).Decode(&note))
	assert.Equal(t, "My Imported Note", note.Title)
	assert.Contains(t, note.Content, "# Heading")
	assert.Contains(t, note.Content, "Content here.")
}

func TestImportHtmlTitleFromFirstHeading(t *testing.T) {
	srv := newServer(t)
	htmlDoc := `<body><h2>Article Title</h2><p>Body text.</p></body>`
	res := importHTML(t, srv, htmlDoc)
	defer res.Body.Close()
	require.Equal(t, http.StatusCreated, res.StatusCode)
	var note api.Note
	require.NoError(t, json.NewDecoder(res.Body).Decode(&note))
	assert.Equal(t, "Article Title", note.Title)
}

func TestImportHtmlNoTitleRejected(t *testing.T) {
	srv := newServer(t)
	// No <title>, no headings — empty title fails service validateTitle.
	htmlDoc := `<body><p>Just a paragraph with no title or heading.</p></body>`
	res := importHTML(t, srv, htmlDoc)
	defer res.Body.Close()
	assert.Equal(t, http.StatusBadRequest, res.StatusCode)
	var errBody struct {
		Error string `json:"error"`
	}
	require.NoError(t, json.NewDecoder(res.Body).Decode(&errBody))
	assert.NotEmpty(t, errBody.Error)
}

func TestImportHtmlDisallowedSchemeRejected(t *testing.T) {
	// A link with javascript: scheme is converted and then rejected by the
	// Markdown structure validator.
	srv := newServer(t)
	htmlDoc := `<body><h1>Title</h1><a href="javascript:alert(1)">bad</a></body>`
	res := importHTML(t, srv, htmlDoc)
	defer res.Body.Close()
	assert.Equal(t, http.StatusBadRequest, res.StatusCode)
}

func TestImportHtmlWrongContentTypeRejected(t *testing.T) {
	srv := newServer(t)
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost,
		srv.URL+"/api/v1/import-html", strings.NewReader("<p>text</p>"))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer res.Body.Close()
	// ogen returns 415 Unsupported Media Type for an unexpected Content-Type.
	assert.Equal(t, http.StatusUnsupportedMediaType, res.StatusCode)
}

func TestImportHtmlScriptStripped(t *testing.T) {
	srv := newServer(t)
	htmlDoc := `<body><h1>Safe Note</h1><script>alert("xss")</script><p>Content.</p></body>`
	res := importHTML(t, srv, htmlDoc)
	defer res.Body.Close()
	require.Equal(t, http.StatusCreated, res.StatusCode)
	var note api.Note
	require.NoError(t, json.NewDecoder(res.Body).Decode(&note))
	assert.NotContains(t, note.Content, "script")
	assert.NotContains(t, note.Content, "alert")
	assert.Contains(t, note.Content, "Content.")
}

func TestImportHtmlSlugNotReserved(t *testing.T) {
	// With the endpoint at /import-html (outside /notes/), notes with slug
	// "import-html" are fully reachable via GET/PATCH/DELETE /notes/import-html.
	srv := newServer(t)
	created := createNote(t, srv, `{"title":"Import HTML","slug":"import-html"}`)
	assert.Equal(t, "import-html", created.Slug)

	res, err := http.Get(srv.URL + "/api/v1/notes/import-html")
	require.NoError(t, err)
	defer res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)
	var fetched api.Note
	require.NoError(t, json.NewDecoder(res.Body).Decode(&fetched))
	assert.Equal(t, "Import HTML", fetched.Title)
}
