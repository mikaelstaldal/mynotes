package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mikaelstaldal/go-server-common/hostguard"
	"github.com/mikaelstaldal/mynotes/internal/api"
	"github.com/mikaelstaldal/mynotes/internal/handler"
	"github.com/mikaelstaldal/mynotes/internal/icons"
	"github.com/mikaelstaldal/mynotes/internal/repository"
	"github.com/mikaelstaldal/mynotes/internal/service"
	"github.com/mikaelstaldal/mynotes/internal/token"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWholeAPITokenAccess(t *testing.T) {
	db, err := repository.OpenDB(filepath.Join(t.TempDir(), "app.sqlite"), 5000)
	require.NoError(t, err)
	defer db.Close()
	notes := repository.NewNoteRepository(db)
	tags := repository.NewTagRepository(db)
	artifacts := repository.NewArtifactRepository(db)
	noteSvc := service.NewNoteService(notes, tags)
	h := handler.New(noteSvc, service.NewArtifactService(artifacts), service.NewTagService(tags), service.NewPublishService(notes, repository.NewPublishedNoteRepository(db), artifacts))
	server, err := api.NewServer(h, api.WithPathPrefix("/api/v1"))
	require.NoError(t, err)
	mux := http.NewServeMux()
	mux.Handle("/api/v1/", handler.WithMiddleware(token.ReadHead(server)))
	mux.Handle("GET /api/v1/artifacts/{sha256}", http.HandlerFunc(h.ServeArtifact))
	mux.Handle("GET /api/v1/icons/lucide/{name}", icons.Handler())
	store := &token.Store{DB: db}
	mux.HandleFunc("/api/v1/tokens", store.Management)
	mux.HandleFunc("/api/v1/tokens/", store.Management)
	token.MountDeviceGrant(mux, store.DeviceGrant("http://localhost:8080/device-approval.html"))
	policy, err := hostguard.New("http://localhost:8080", "127.0.0.1", 8080)
	require.NoError(t, err)
	file := filepath.Join(t.TempDir(), "htpasswd")
	require.NoError(t, os.WriteFile(file, []byte("alice:$2y$05$YjuAjU9iJvJ8KhdNm5UFSurCx2d/Y4BqmPeg/3t1ybsqlysbbwtQ6\n"), 0600))
	httpHandler, err := serverMiddleware(mux, policy, "http://localhost:8080", file, "MyNotes", "default-src 'self'; frame-ancestors 'none'", store)
	require.NoError(t, err)
	testServer := httptest.NewServer(httpHandler)
	defer testServer.Close()
	send := func(method, path, body, credentials string) *httptest.ResponseRecorder {
		r, err := http.NewRequest(method, testServer.URL+path, strings.NewReader(body))
		require.NoError(t, err)
		r.Host = "localhost:8080"
		r.Header.Set("Content-Type", "application/json")
		if credentials == "basic" {
			r.SetBasicAuth("alice", "s3cret")
		} else if credentials != "" {
			r.Header.Set("Authorization", "Bearer "+credentials)
		}
		response, err := testServer.Client().Do(r)
		require.NoError(t, err)
		defer response.Body.Close()
		data, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		w := httptest.NewRecorder()
		for key, values := range response.Header {
			w.Header()[key] = values
		}
		w.Code = response.StatusCode
		w.Body = bytes.NewBuffer(data)
		return w
	}
	require.Equal(t, 401, send("GET", "/api/v1/notes", "", "").Code)
	// Seed via full-access API to exercise unchanged create, tags, artifacts and search.
	w := send("POST", "/api/v1/notes", `{"title":"Secret","content":"Find this text"}`, "basic")
	require.Equal(t, 201, w.Code, w.Body.String())
	var note struct {
		Slug string `json:"slug"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &note))
	w = send("POST", "/api/v1/tags", `{"slug":"private"}`, "basic")
	require.Equal(t, 201, w.Code, w.Body.String())
	r := httptest.NewRequest("POST", "http://localhost:8080/api/v1/artifacts", strings.NewReader("\x89PNG\r\n\x1a\nhello"))
	r.SetBasicAuth("alice", "s3cret")
	r.Header.Set("Content-Type", "image/png")
	w = httptest.NewRecorder()
	httpHandler.ServeHTTP(w, r)
	require.Equal(t, 201, w.Code, w.Body.String())
	var artifact struct {
		SHA256 string `json:"sha256"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &artifact))
	mux.Handle("GET /public/notes/{slug}", http.HandlerFunc(h.ServePublishedNote))
	_, err = db.Exec(`INSERT INTO published_notes(note_id,title,html,published_at) SELECT id,title,'<p>Public content</p>','2026-10-13T00:00:00Z' FROM notes WHERE slug=?`, note.Slug)
	require.NoError(t, err)
	record, secret, err := store.Create("reader", time.Now().Add(time.Hour))
	require.NoError(t, err)
	for _, credentials := range []string{"", secret, "invalid"} {
		w = send("GET", "/public/notes/"+note.Slug, "", credentials)
		assert.Equal(t, 200, w.Code, w.Body.String())
		assert.Contains(t, w.Body.String(), "Public content")
	}
	reads := []string{"/api/v1/notes", "/api/v1/notes?q=Find", "/api/v1/notes/" + note.Slug, "/api/v1/notes/" + note.Slug + "/download-markdown", "/api/v1/tags", "/api/v1/artifacts/" + artifact.SHA256, "/api/v1/icons/lucide/heart"}
	for _, path := range reads {
		for _, method := range []string{"GET", "HEAD"} {
			w = send(method, path, "", secret)
			assert.Equal(t, 200, w.Code, path+": "+w.Body.String())
			assert.NotEmpty(t, w.Header().Get("Content-Security-Policy"))
			if method == "HEAD" {
				assert.Empty(t, w.Body.String())
			}
		}
	}
	for _, path := range reads {
		for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", "OPTIONS"} {
			assert.Equal(t, 403, send(method, path, `{}`, secret).Code, path)
		}
	}
	for _, path := range []string{"/api/v1/tokens", "/api/v1/tokens/" + record.Slug, "/api/v1/oauth/device/BCDF-GHJK", "/api/v1/oauth/device_authorization", "/api/v1/oauth/token", "/device-approval.html", "/"} {
		for _, method := range []string{"GET", "HEAD", "POST", "DELETE"} {
			assert.Equal(t, 403, send(method, path, `{}`, secret).Code, path)
		}
	}
	for _, credentials := range []string{"invalid", secret[:50] + "!"} {
		assert.Equal(t, 401, send("GET", "/api/v1/notes", "", credentials).Code)
	}
	_, err = store.Revoke(record.Slug)
	require.NoError(t, err)
	assert.Equal(t, 401, send("GET", "/api/v1/notes", "", secret).Code)
}
