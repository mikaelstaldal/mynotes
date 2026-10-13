package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type unreadableInput struct{}

func (unreadableInput) Read([]byte) (int, error) { panic("login read credentials") }

func TestLoginCommand(t *testing.T) {
	t.Setenv("MYNOTES_USER", "must-not-prompt")
	secret := "mynotes_" + strings.Repeat("a", 43)
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		require.NoError(t, r.ParseForm())
		assert.Empty(t, r.Header.Get("Authorization"))
		switch r.URL.Path {
		case "/prefix/api/v1/oauth/device_authorization":
			assert.Equal(t, "mynotes-token", r.PostForm.Get("client_id"))
			assert.Empty(t, r.PostForm.Get("scope"))
			assert.Equal(t, "30d", r.PostForm.Get("lifetime"))
			_ = json.NewEncoder(w).Encode(map[string]any{"device_code": "device", "user_code": "BCDF-GHJK", "verification_uri": "https://example.org/approve", "expires_in": 10, "interval": 1})
		case "/prefix/api/v1/oauth/token":
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": secret, "token_type": "Bearer", "expires_in": 100, "slug": "reader"})
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()
	var stdout, stderr bytes.Buffer
	file := filepath.Join(t.TempDir(), "token")
	args := []string{"-url", server.URL + "/prefix", "login", "-name", "Reader", "-out", file}
	require.NoError(t, run(args, unreadableInput{}, &stdout, &stderr))
	assert.Empty(t, stdout.String())
	assert.Contains(t, stderr.String(), "User code: BCDF-GHJK")
	assert.Contains(t, stderr.String(), "Approve this request on the page above.")
	assert.Contains(t, stderr.String(), "Token slug: reader")
	content, err := os.ReadFile(file)
	require.NoError(t, err)
	assert.Equal(t, secret+"\n", string(content))
	info, err := os.Stat(file)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0600), info.Mode().Perm())
	assert.Equal(t, 2, requests)
}
func TestLoginRejectsCredentials(t *testing.T) {
	for _, args := range [][]string{{"-user", "alice", "login", "-name", "Reader"}, {"-credentials-stdin", "login", "-name", "Reader"}, {"-credentials-file", "not-a-file", "login", "-name", "Reader"}} {
		err := run(args, unreadableInput{}, new(bytes.Buffer), new(bytes.Buffer))
		require.Error(t, err)
		assert.Contains(t, err.Error(), "does not accept credentials")
	}
}

func TestLoginOutputFailureBeforeAuthorization(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"error":"access_denied"}`))
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "token")
	require.NoError(t, os.WriteFile(path, []byte("keep"), 0600))
	args := []string{"-url", server.URL, "login", "-name", "Reader", "-out", path}
	err := run(args, unreadableInput{}, new(bytes.Buffer), new(bytes.Buffer))
	require.Error(t, err)
	assert.Zero(t, requests)
	content, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Equal(t, "keep", string(content))
	require.NoError(t, os.Remove(path))
	err = run(args, unreadableInput{}, new(bytes.Buffer), new(bytes.Buffer))
	require.Error(t, err)
	assert.Equal(t, 1, requests)
	_, err = os.Stat(path)
	assert.True(t, os.IsNotExist(err))
}

func TestLoginRejectsInvalidNamesBeforeAuthorization(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests++; w.WriteHeader(500) }))
	defer server.Close()
	for _, name := range []string{"Bad\u202ename", string([]byte{0xff})} {
		err := run([]string{"-url", server.URL, "login", "-name", name}, unreadableInput{}, new(bytes.Buffer), new(bytes.Buffer))
		require.Error(t, err)
	}
	assert.Zero(t, requests)
}

func TestLoginCancellationCleansReservedOutput(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"device_code": "device", "user_code": "BCDF-GHJK", "verification_uri": "https://example.org/approve", "expires_in": 10, "interval": 1})
	}))
	defer server.Close()
	// Cancel after the displayed URL, while the client is waiting to poll.
	writer := cancelWriter{cancel: cancel}
	path := filepath.Join(t.TempDir(), "token")
	err := loginContext(ctx, []string{"-name", "Reader", "-out", path}, server.URL, new(bytes.Buffer), writer)
	require.ErrorIs(t, err, context.Canceled)
	_, err = os.Stat(path)
	assert.True(t, os.IsNotExist(err))
}

type cancelWriter struct{ cancel context.CancelFunc }

func (w cancelWriter) Write(p []byte) (int, error) { w.cancel(); return len(p), nil }

func TestLoginLostResponseGuidanceAndOutputCleanup(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	polls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "device_authorization") {
			_ = json.NewEncoder(w).Encode(map[string]any{"device_code": "device", "user_code": "BCDF-GHJK", "verification_uri": "https://example.org/approve", "expires_in": 10, "interval": 1})
			return
		}
		polls++
		if polls == 1 {
			conn, _, err := w.(http.Hijacker).Hijack()
			require.NoError(t, err)
			_ = conn.Close()
			return
		}
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"error":"invalid_grant"}`))
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "token")
	var stdout, stderr bytes.Buffer
	err := loginContext(ctx, []string{"-name", "Reader", "-out", path}, server.URL, &stdout, &stderr)
	require.ErrorContains(t, err, "check the server's API token list and revoke any unused token")
	assert.Equal(t, 2, polls)
	assert.Empty(t, stdout.String())
	_, err = os.Stat(path)
	assert.True(t, os.IsNotExist(err))
}
