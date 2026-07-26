package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBasePathFromPublicURL(t *testing.T) {
	tests := []struct {
		name      string
		publicURL string
		want      string
	}{
		{"empty", "", "/"},
		{"no path", "https://example.com", "/"},
		{"root path", "https://example.com/", "/"},
		{"subpath", "https://example.com/mynotes", "/mynotes/"},
		{"subpath with trailing slash", "https://example.com/mynotes/", "/mynotes/"},
		{"nested subpath", "https://example.com/apps/my-notes_v2.1~x", "/apps/my-notes_v2.1~x/"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := basePathFromPublicURL(tt.publicURL)
			require.NoError(t, err)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestBasePathFromPublicURLRejectsUnsafePath(t *testing.T) {
	tests := []struct {
		name      string
		publicURL string
	}{
		{"attribute break out", `https://example.com/a"><script>alert(1)</script>`},
		{"percent-encoded quote", "https://example.com/a%22%3E%3Cscript%3E"},
		{"angle bracket", "https://example.com/a<b"},
		{"space", "https://example.com/a%20b"},
		{"protocol relative", "https://example.com//evil.example/"},
		{"unparseable", "https://example.com/%zz"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := basePathFromPublicURL(tt.publicURL)
			assert.Error(t, err)
		})
	}
}

// The render kit is the one page a same-origin sibling app may frame,
// so it overrides the framing headers the SecurityHeaders middleware sets for every other response.
func TestRenderHandlerAllowsSameOriginFraming(t *testing.T) {
	const renderCSP = "default-src 'self'; frame-ancestors 'self'"
	rec := httptest.NewRecorder()
	renderHandler([]byte("<html></html>"), renderCSP)(rec, httptest.NewRequest(http.MethodGet, "/render/", nil))

	res := rec.Result()
	defer res.Body.Close()
	assert.Equal(t, renderCSP, res.Header.Get("Content-Security-Policy"))
	assert.Equal(t, "SAMEORIGIN", res.Header.Get("X-Frame-Options"))
	assert.Contains(t, res.Header.Get("Content-Type"), "text/html")
}
