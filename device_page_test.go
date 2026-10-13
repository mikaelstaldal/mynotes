package main

import (
	"context"
	"github.com/mikaelstaldal/go-server-common/hostguard"
	"github.com/mikaelstaldal/mynotes/internal/token"
	"github.com/mikaelstaldal/mynotes/web"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestDevicePageCSPAndDeployment(t *testing.T) {
	shell, _, err := importMapHashes()
	require.NoError(t, err)
	approval, err := importMapCSPHash(web.Static, "static/device-approval.html")
	require.NoError(t, err)
	assert.Equal(t, shell, approval)
	page, err := fs.ReadFile(web.Static, "static/device-approval.html")
	require.NoError(t, err)
	assert.Contains(t, string(page), `<base href="/">`)
	assert.Contains(t, string(page), `src="device-approval.js"`)
	assert.NotContains(t, string(page), `src="app.js"`)
	assert.Equal(t, "https://example.org/suite/mynotes/device-approval.html", token.DeviceVerificationURI("https://example.org/suite/mynotes/", "127.0.0.1", 8080))
	assert.Equal(t, "http://127.0.0.1:8080/device-approval.html", token.DeviceVerificationURI("", "127.0.0.1", 8080))
}

func TestDemoBundleOmitsDevicePage(t *testing.T) {
	dir := t.TempDir() + "/demo"
	require.NoError(t, writeDemoBundle(context.Background(), dir, ""))
	for _, name := range []string{"device-approval.html", "device-approval.js"} {
		_, err := os.Stat(filepath.Join(dir, name))
		assert.True(t, os.IsNotExist(err))
	}
}

func TestHEADShellKeepsNativeContentLength(t *testing.T) {
	policy, err := hostguard.New("http://localhost:8080", "127.0.0.1", 8080)
	require.NoError(t, err)
	h, err := serverMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("shell")) }), policy, "http://localhost:8080", "", "", "default-src 'self'")
	require.NoError(t, err)
	server := httptest.NewServer(h)
	defer server.Close()
	for _, method := range []string{"GET", "HEAD"} {
		r, err := http.NewRequest(method, server.URL+"/", nil)
		require.NoError(t, err)
		r.Host = "localhost:8080"
		response, err := server.Client().Do(r)
		require.NoError(t, err)
		body, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		require.NoError(t, response.Body.Close())
		assert.Equal(t, "5", response.Header.Get("Content-Length"))
		if method == "HEAD" {
			assert.Empty(t, body)
		}
	}
}
