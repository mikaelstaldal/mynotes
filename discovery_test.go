package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/mikaelstaldal/go-server-common/hostguard"
	"github.com/mikaelstaldal/mynotes/internal/api"
	"github.com/mikaelstaldal/mynotes/internal/handler"
	"github.com/mikaelstaldal/mynotes/internal/repository"
	"github.com/mikaelstaldal/mynotes/internal/service"
	"github.com/mikaelstaldal/mynotes/internal/token"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"
)

func TestAPIDiscovery(t *testing.T) {
	document, err := os.ReadFile("openapi.yaml")
	require.NoError(t, err)
	var spec struct {
		OpenAPI string                    `yaml:"openapi"`
		Paths   map[string]map[string]any `yaml:"paths"`
		Servers []struct {
			URL string `yaml:"url"`
		} `yaml:"servers"`
	}
	require.NoError(t, yaml.Unmarshal(document, &spec))
	assert.Equal(t, "3.0.3", spec.OpenAPI)
	require.NotEmpty(t, spec.Servers)
	serverURL, err := url.Parse(spec.Servers[0].URL)
	require.NoError(t, err)
	assert.False(t, serverURL.IsAbs())
	assert.Equal(t, "/api/v1", serverURL.Path)
	require.Contains(t, spec.Paths, "/notes")
	require.Contains(t, spec.Paths["/notes"], "get")
	operationURL, err := url.Parse(serverURL.String() + "/notes")
	require.NoError(t, err)
	assert.Equal(t, "/api/v1/notes", operationURL.Path)
	authFile := filepath.Join(t.TempDir(), "htpasswd")
	require.NoError(t, os.WriteFile(authFile, []byte("user:$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy\n"), 0600))
	db, err := repository.OpenDB(filepath.Join(t.TempDir(), "app.sqlite"), 5000)
	require.NoError(t, err)
	defer db.Close()
	notes := repository.NewNoteRepository(db)
	tags := repository.NewTagRepository(db)
	artifacts := repository.NewArtifactRepository(db)
	apiHandler := handler.New(service.NewNoteService(notes, tags), service.NewArtifactService(artifacts), service.NewTagService(tags), service.NewPublishService(notes, repository.NewPublishedNoteRepository(db), artifacts))
	apiServer, err := api.NewServer(apiHandler, api.WithPathPrefix("/api/v1"))
	require.NoError(t, err)
	for _, demo := range []bool{false, true} {
		for _, auth := range []bool{false, true} {
			mux := http.NewServeMux()
			mountAPIDiscovery(mux, demo)
			if demo {
				mux.HandleFunc("/api/v1/", demoAPIUnavailable)
			} else {
				mux.Handle("/api/v1/", token.ReadHead(apiServer))
			}

			policy, err := hostguard.New("http://localhost:8080", "127.0.0.1", 8080)
			require.NoError(t, err)
			file := ""
			if auth {
				file = authFile
			}
			var store *token.Store
			if !demo {
				store = &token.Store{DB: db}
			}
			h, err := serverMiddleware(mux, policy, "http://localhost:8080", file, "MyNotes", "default-src 'self'", store)
			require.NoError(t, err)
			h = apiDescriptionLink(h, demo)
			for _, path := range []string{"/openapi.yaml", "/.well-known/api-catalog"} {
				for _, method := range []string{"GET", "HEAD"} {
					for _, bearer := range []bool{false, true} {
						r := httptest.NewRequest(method, "http://localhost:8080"+path, nil)
						if bearer {
							r.Header.Set("Authorization", "Bearer invalid")
						}
						w := httptest.NewRecorder()
						h.ServeHTTP(w, r)
						if demo {
							assert.Equal(t, 404, w.Code)
							continue
						}
						require.Equal(t, 200, w.Code)
						if path == "/openapi.yaml" {
							assert.Equal(t, "application/yaml", w.Header().Get("Content-Type"))
							if method == "GET" {
								assert.Equal(t, document, w.Body.Bytes())
							}
						} else {
							assert.Equal(t, `application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"`, w.Header().Get("Content-Type"))
							assert.Equal(t, `</.well-known/api-catalog>; rel="api-catalog"`, w.Header().Get("Link"))
							if method == "GET" {
								assert.JSONEq(t, `{"linkset":[{"anchor":"/api/v1/","service-desc":[{"href":"/openapi.yaml","type":"application/yaml"}]}]}`, w.Body.String())
							}
						}
						if method == "HEAD" {
							assert.Empty(t, w.Body.String())
						}
					}
				}
			}
			for _, path := range []string{operationURL.Path, "/api/v1/missing"} {
				r := httptest.NewRequest("GET", "http://localhost:8080"+path, nil)
				w := httptest.NewRecorder()
				h.ServeHTTP(w, r)
				if demo {
					assert.Empty(t, w.Header().Get("Link"))
				} else {
					assert.Equal(t, `</openapi.yaml>; rel="service-desc"`, w.Header().Get("Link"))
				}
				expected := 200
				if path == "/api/v1/missing" {
					expected = 404
				}
				if demo {
					expected = 503
				}
				if auth {
					expected = 401
				}
				assert.Equal(t, expected, w.Code)
			}
			if auth {
				for _, path := range []string{"/openapi.yaml/private", "/.well-known/api-catalog/private"} {
					w := httptest.NewRecorder()
					h.ServeHTTP(w, httptest.NewRequest("GET", "http://localhost:8080"+path, nil))
					assert.Equal(t, 401, w.Code)
				}
			}
		}
	}
}
