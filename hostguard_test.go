package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/mikaelstaldal/go-server-common/hostguard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestServerHostBoundary(t *testing.T) {
	// A valid bcrypt entry enables authentication, without needing credentials
	// for the public surface or requests rejected by the outer Host boundary.
	authFile := filepath.Join(t.TempDir(), "htpasswd")
	require.NoError(t, os.WriteFile(authFile, []byte("user:$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy\n"), 0600))
	for _, authenticated := range []bool{false, true} {
		t.Run(map[bool]string{false: "no auth", true: "auth"}[authenticated], func(t *testing.T) {
			policy, err := hostguard.New("https://notes.example/mynotes", "127.0.0.1", 8080)
			require.NoError(t, err)
			file := ""
			if authenticated {
				file = authFile
			}
			called := false
			next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { called = true; w.WriteHeader(http.StatusNoContent) })
			h, err := serverMiddleware(next, policy, "https://notes.example/mynotes", file, "MyNotes", "default-src 'self'")
			require.NoError(t, err)
			for _, method := range []string{"GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"} {
				for _, path := range []string{"/", "/api/v1/notes", "/public/notes/published", "/demo-sw.js"} {
					t.Run(method+path, func(t *testing.T) {
						called = false
						req := httptest.NewRequest(method, "http://foreign.example"+path, nil)
						req.Header.Set("Origin", "https://notes.example")
						req.Header.Set("Forwarded", "host=notes.example")
						req.Header.Set("X-Forwarded-Host", "notes.example")
						w := httptest.NewRecorder()
						h.ServeHTTP(w, req)
						assert.Equal(t, http.StatusMisdirectedRequest, w.Code)
						assert.False(t, called)
						assert.Empty(t, w.Header().Get("WWW-Authenticate"))
					})
				}
			}
			for _, path := range []string{"/", "/api/v1/notes"} {
				called = false
				req := httptest.NewRequest("GET", "http://localhost:8080"+path, nil)
				w := httptest.NewRecorder()
				h.ServeHTTP(w, req)
				if authenticated {
					assert.Equal(t, http.StatusUnauthorized, w.Code)
					assert.NotEmpty(t, w.Header().Get("WWW-Authenticate"))
					assert.False(t, called)
				} else {
					assert.Equal(t, http.StatusNoContent, w.Code)
					assert.True(t, called)
				}
			}
			for _, tc := range []struct {
				host, origin string
				want         int
			}{
				{"localhost:8080", "http://localhost:8080", 204},
				{"127.0.0.1:8080", "http://127.0.0.1:8080", 204},
				{"[::1]:8080", "http://[::1]:8080", 204},
				{"notes.example", "https://notes.example", 204},
				{"notes.example:443", "https://notes.example", 204},
				{"127.0.0.1:8080", "https://notes.example", 204},
				{"notes.example", "", 204},
				{"notes.example", "https://foreign.example", 403},
				{"notes.example:8080", "https://notes.example", 421},
				{"localhost:9999", "http://localhost:8080", 421},
			} {
				t.Run(tc.host+tc.origin, func(t *testing.T) {
					called = false
					req := httptest.NewRequest("PUT", "http://localhost/public/notes/published", nil)
					req.Host = tc.host
					if tc.origin != "" {
						req.Header.Set("Origin", tc.origin)
					}
					w := httptest.NewRecorder()
					h.ServeHTTP(w, req)
					assert.Equal(t, tc.want, w.Code)
					assert.Equal(t, tc.want == 204, called)
				})
			}
		})
	}
}

func TestRunRejectsInvalidHostConfigurationBeforeStorage(t *testing.T) {
	for _, demo := range []bool{false, true} {
		for _, tc := range []struct{ addr, publicURL string }{
			{"0.0.0.0", ""}, {"::", ""}, {"", ""},
			{"127.0.0.1", "ftp://notes.example"},
			{"127.0.0.1", "https://user:password@notes.example"},
		} {
			dir := filepath.Join(t.TempDir(), "unused")
			require.Error(t, run(tc.addr, 8080, dir, tc.publicURL, "", "MyNotes", demo))
			_, err := os.Stat(dir)
			assert.True(t, os.IsNotExist(err))
		}
	}
}

func TestServerHostConfigurations(t *testing.T) {
	for _, tc := range []struct{ addr, publicURL, host, origin string }{
		{"127.0.0.1", "", "localhost:8080", "http://localhost:8080"},
		{"::1", "", "[::1]:8080", "http://[::1]:8080"},
		{"192.0.2.1", "", "192.0.2.1:8080", "http://192.0.2.1:8080"},
		{"0.0.0.0", "https://notes.example:8443/mynotes", "notes.example:8443", "https://notes.example:8443"},
		{"::", "https://notes.example/mynotes", "127.0.0.1:8080", "http://127.0.0.1:8080"},
	} {
		t.Run(tc.addr+tc.publicURL, func(t *testing.T) {
			policy, err := hostguard.New(tc.publicURL, tc.addr, 8080)
			require.NoError(t, err)
			next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
			h, err := serverMiddleware(next, policy, tc.publicURL, "", "MyNotes", "")
			require.NoError(t, err)
			for _, method := range []string{"GET", "POST"} {
				req := httptest.NewRequest(method, "http://localhost/api/v1/notes", nil)
				req.Host = tc.host
				req.Header.Set("Origin", tc.origin)
				w := httptest.NewRecorder()
				h.ServeHTTP(w, req)
				assert.Equal(t, http.StatusNoContent, w.Code)
			}
		})
	}
}
