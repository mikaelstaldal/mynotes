package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/mikaelstaldal/mynotes/internal/api"
	"github.com/mikaelstaldal/mynotes/internal/handler"
	"github.com/mikaelstaldal/mynotes/internal/icons"
	"github.com/mikaelstaldal/mynotes/internal/repository"
	"github.com/mikaelstaldal/mynotes/internal/service"
	"github.com/mikaelstaldal/mynotes/internal/token"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestReadCLIWithActualAPIAndRevocation(t *testing.T) {
	db, err := repository.OpenDB(t.TempDir()+"/app.sqlite", 5000)
	require.NoError(t, err)
	defer db.Close()
	notes := repository.NewNoteRepository(db)
	tags := repository.NewTagRepository(db)
	noteSvc := service.NewNoteService(notes, tags)
	content := "Some searchable Markdown"
	note, err := noteSvc.Create(context.Background(), "Reader example", &content, nil, nil)
	require.NoError(t, err)
	tagSvc := service.NewTagService(tags)
	_, err = tagSvc.Create(context.Background(), "work")
	require.NoError(t, err)
	artifactSvc := service.NewArtifactService(repository.NewArtifactRepository(db))
	artifactBytes := []byte("\x89PNG\r\n\x1a\npayload")
	artifact, err := artifactSvc.Create(context.Background(), artifactBytes, "image/png")
	require.NoError(t, err)
	h := handler.New(noteSvc, artifactSvc, tagSvc, nil)
	generated, err := api.NewServer(h, api.WithPathPrefix("/api/v1"))
	require.NoError(t, err)
	store := token.Store{DB: db}
	record, secret, err := store.Create("Reader", time.Now().Add(time.Hour))
	require.NoError(t, err)
	denied := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(401) })
	mux := http.NewServeMux()
	mux.Handle("/api/v1/", handler.WithMiddleware(generated))
	mux.Handle("GET /api/v1/artifacts/{sha256}", http.HandlerFunc(h.ServeArtifact))
	mux.Handle("GET /api/v1/icons/lucide/{name}", icons.Handler())
	server := httptest.NewServer(store.Bearer(denied, mux))
	defer server.Close()
	t.Setenv("MYNOTES_URL", server.URL)
	t.Setenv("MYNOTES_TOKEN_FILE", "")
	for _, tc := range []struct {
		args     []string
		expected string
	}{
		{[]string{"notes", "search", "-q", "searchable"}, note.Slug},
		{[]string{"notes", "get", note.Slug}, content},
		{[]string{"notes", "markdown", note.Slug}, content},
		{[]string{"tags", "list"}, `"slug":"work"`},
		{[]string{"icons", "get", "heart"}, "<svg"},
		{[]string{"artifacts", "get", artifact.SHA256}, string(artifactBytes)},
	} {
		var out bytes.Buffer
		require.NoError(t, run(append([]string{"-token-stdin"}, tc.args...), strings.NewReader(secret), &out))
		if tc.args[0] == "artifacts" {
			assert.Equal(t, tc.expected, out.String())
		} else {
			assert.Contains(t, out.String(), tc.expected)
		}
	}
	_, err = store.Revoke(record.Slug)
	require.NoError(t, err)
	var out bytes.Buffer
	require.ErrorContains(t, run([]string{"-token-stdin", "notes", "list"}, strings.NewReader(secret), &out), "HTTP 401")
	assert.Empty(t, out.String())
}
