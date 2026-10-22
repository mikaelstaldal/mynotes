package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestReadCommandsAndRawOutput(t *testing.T) {
	t.Setenv("MYNOTES_TOKEN_FILE", "")
	digest := strings.Repeat("a", 64)
	for _, tc := range []struct {
		args      []string
		uri, body string
	}{
		{[]string{"notes", "list"}, "/notes?limit=50&offset=0&order=desc&sort=updated", `{"notes":[]}`},
		{[]string{"notes", "list", "-tags", "work,private", "-sort", "title", "-order", "asc", "-limit", "2", "-offset", "3"}, "/notes?limit=2&offset=3&order=asc&sort=title&tag=work&tag=private", `{"notes":[]}`},
		{[]string{"notes", "search", "-q", "hello world", "-title-prefix"}, "/notes?limit=50&offset=0&q=hello+world&titlePrefix=true", `{"notes":[]}`},
		{[]string{"notes", "search", "-q", strings.Repeat("字", 200)}, "/notes?limit=50&offset=0&q=" + strings.Repeat("%E5%AD%97", 200), `{"notes":[]}`},
		{[]string{"notes", "get", "my-note"}, "/notes/my-note", `{"title":"Note"}`},
		{[]string{"notes", "markdown", "my-note"}, "/notes/my-note/download-markdown", "---\ntitle: Note\n---\n# Note\n"},
		{[]string{"tags", "list"}, "/tags", `{"items":[]}`},
		{[]string{"artifacts", "get", digest}, "/artifacts/" + digest, "image\x00bytes"},
		{[]string{"icons", "get", "heart"}, "/icons/lucide/heart", "<svg></svg>"},
	} {
		t.Run(strings.Join(tc.args, " "), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				assert.Equal(t, http.MethodGet, r.Method)
				assert.Equal(t, "/prefix/api/v1"+tc.uri, r.URL.RequestURI())
				assert.Equal(t, "Bearer mynotes_test", r.Header.Get("Authorization"))
				_, _ = io.WriteString(w, tc.body)
			}))
			defer server.Close()
			var out bytes.Buffer
			require.NoError(t, run(append([]string{"-url", server.URL + "/prefix/", "-token-stdin"}, tc.args...), strings.NewReader("mynotes_test\n"), &out))
			assert.Equal(t, tc.body, out.String())
		})
	}
}

func TestTokenSourcesAndOverrides(t *testing.T) {
	file := t.TempDir() + "/token"
	require.NoError(t, os.WriteFile(file, []byte("from-file\n"), 0600))
	missing := t.TempDir() + "/missing"
	header := ""
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header = r.Header.Get("Authorization")
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()
	t.Setenv("MYNOTES_URL", server.URL)
	t.Setenv("MYNOTES_TOKEN_FILE", file)
	require.NoError(t, run([]string{"tags", "list"}, strings.NewReader("unused"), io.Discard))
	assert.Equal(t, "Bearer from-file", header)
	t.Setenv("MYNOTES_TOKEN_FILE", missing)
	require.NoError(t, run([]string{"-token-stdin", "tags", "list"}, strings.NewReader("from-stdin"), io.Discard))
	assert.Equal(t, "Bearer from-stdin", header)
	require.NoError(t, run([]string{"-token-file", file, "tags", "list"}, strings.NewReader("unused"), io.Discard))
	assert.Equal(t, "Bearer from-file", header)
	t.Setenv("MYNOTES_URL", "invalid")
	t.Setenv("MYNOTES_TOKEN_FILE", "")
	require.NoError(t, run([]string{"-url", server.URL, "tags", "list"}, strings.NewReader("unused"), io.Discard))
	assert.Empty(t, header)
}

func TestInvalidInputMakesNoRequests(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests++ }))
	defer server.Close()
	t.Setenv("MYNOTES_URL", server.URL)
	t.Setenv("MYNOTES_TOKEN_FILE", "")
	for _, args := range [][]string{
		{"notes"}, {"notes", "delete", "note"}, {"tokens", "list"}, {"notes", "get", "../tokens"}, {"notes", "get", "A"}, {"notes", "get", "x", "extra"},
		{"notes", "list", "-limit", "201"}, {"notes", "list", "-offset", "-1"}, {"notes", "list", "-sort", "invalid"}, {"notes", "list", "-order", "invalid"}, {"notes", "list", "-tags", "x,"},
		{"notes", "search"}, {"notes", "search", "-q", " "}, {"notes", "search", "-q", strings.Repeat("x", 201)}, {"notes", "search", "-q", "x", "extra"}, {"tags", "list", "extra"}, {"artifacts", "get", "bad"}, {"icons", "get", "../x"}, {"icons", "get", strings.Repeat("a", 65)}, {"notes", "search", "-q", strings.Repeat("字", 201)}, {"notes", "search", "-q", string([]byte{0xff})},
		{"-token-file", "", "tags", "list"}, {"-token-file", "/missing", "-token-stdin", "tags", "list"},
		{"-url", "http://example.org", "tags", "list"}, {"-url", "https://user:pass@example.org", "tags", "list"},
	} {
		var out bytes.Buffer
		require.Error(t, run(args, strings.NewReader("token"), &out), args)
		assert.Empty(t, out.String())
	}
	for _, token := range []string{"", "two tokens", "one\ntwo", "one\x00two", strings.Repeat("x", 4097)} {
		require.Error(t, run([]string{"-token-stdin", "tags", "list"}, strings.NewReader(token), io.Discard))
	}
	assert.Zero(t, requests)
}

func TestHelpWithoutConfiguration(t *testing.T) {
	t.Setenv("MYNOTES_URL", "invalid")
	t.Setenv("MYNOTES_TOKEN_FILE", "/missing")
	for _, args := range [][]string{{"help"}, {"-help"}, {"-h"}, {"notes", "-help"}, {"notes", "list", "-help"}, {"notes", "search", "-help"}, {"notes", "get", "-help"}, {"notes", "markdown", "-help"}, {"tags", "list", "-help"}, {"artifacts", "get", "-help"}, {"icons", "get", "-help"}} {
		var out bytes.Buffer
		require.NoError(t, run(args, strings.NewReader(""), &out))
		assert.Equal(t, usage, out.String())
	}
}

func TestErrorsRedirectsAndCancellation(t *testing.T) {
	t.Setenv("MYNOTES_TOKEN_FILE", "")
	followed := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { followed = true }))
	defer target.Close()
	for _, status := range []int{401, 403, 404, 500, 307} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if status == 307 {
					http.Redirect(w, r, target.URL, status)
					return
				}
				w.WriteHeader(status)
				_, _ = io.WriteString(w, `{"error":"denied"}`)
			}))
			defer server.Close()
			var out bytes.Buffer
			err := run([]string{"-url", server.URL, "-token-stdin", "tags", "list"}, strings.NewReader("secret"), &out)
			require.ErrorContains(t, err, "HTTP ")
			assert.Empty(t, out.String())
		})
	}
	assert.False(t, followed)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { cancel(); <-r.Context().Done() }))
	defer server.Close()
	require.ErrorIs(t, runContext(ctx, []string{"-url", server.URL, "tags", "list"}, strings.NewReader(""), io.Discard), context.Canceled)
}

func TestCopyResponse(t *testing.T) {
	payload := "å日本語�\t\n\x1b[2J\x1b]52;c;YQ==\x07\r\x00\x7f\u009b31m\u009dtitle\xff\x9b"
	var out bytes.Buffer
	require.NoError(t, copyResponse(&out, strings.NewReader(payload), true))
	assert.Equal(t, "å日本語�\t\n\\x1b[2J\\x1b]52;c;YQ==\\a\\r\\x00\\x7f\\u009b31m\\u009dtitle\\xff\\x9b", out.String())
	out.Reset()
	require.NoError(t, copyResponse(&out, strings.NewReader(payload), false))
	assert.Equal(t, payload, out.String())
}

func TestDownloadsPreserveRedirectedBytes(t *testing.T) {
	t.Setenv("MYNOTES_TOKEN_FILE", "")
	payload := "\x00\xff\x1b]52;c;YQ==\x07\u009b31m\r\n"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, payload)
	}))
	defer server.Close()
	for _, command := range [][]string{
		{"artifacts", "get", strings.Repeat("a", 64)},
		{"notes", "markdown", "note"},
		{"icons", "get", "heart"},
	} {
		file, err := os.CreateTemp(t.TempDir(), "download")
		require.NoError(t, err)
		require.NoError(t, run(append([]string{"-url", server.URL}, command...), strings.NewReader(""), file))
		require.NoError(t, file.Close())
		got, err := os.ReadFile(file.Name())
		require.NoError(t, err)
		assert.Equal(t, payload, string(got))
	}
}

func TestHTTPErrorEscapesControls(t *testing.T) {
	t.Setenv("MYNOTES_TOKEN_FILE", "")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, "bad å\x1b[2J\x1b]52;c;YQ==\x07\u009b31m\xff\rtext")
	}))
	defer server.Close()
	var out bytes.Buffer
	err := run([]string{"-url", server.URL, "tags", "list"}, strings.NewReader(""), &out)
	require.EqualError(t, err, "HTTP 500: bad å\\x1b[2J\\x1b]52;c;YQ==\\a\\u009b31m\\xff\\rtext")
	assert.Empty(t, out.String())
}

type failingOutput struct{ err error }

func (w failingOutput) Write([]byte) (int, error) { return 0, w.err }

type failingInput struct{ err error }

func (r failingInput) Read([]byte) (int, error) { return 0, r.err }

func TestCopyResponseErrors(t *testing.T) {
	failure := errors.New("I/O failure")
	for _, terminal := range []bool{false, true} {
		require.ErrorIs(t, copyResponse(failingOutput{failure}, strings.NewReader("small"), terminal), failure)
		require.ErrorIs(t, copyResponse(failingOutput{failure}, strings.NewReader(strings.Repeat("x", 8192)), terminal), failure)
		var out bytes.Buffer
		require.ErrorIs(t, copyResponse(&out, io.MultiReader(strings.NewReader("prefix"), failingInput{failure}), terminal), failure)
		assert.Equal(t, "prefix", out.String())
	}
}
