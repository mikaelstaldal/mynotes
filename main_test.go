package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
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

func TestDeriveMymailURL(t *testing.T) {
	tests := []struct {
		name      string
		publicURL string
		want      string
	}{
		{"empty", "", ""},
		{"origin root leaves no room for siblings", "https://example.com", ""},
		{"explicit root path", "https://example.com/", ""},
		{"path replaced", "https://example.com/mynotes", "https://example.com/mymail"},
		{"trailing slash", "https://example.com/mynotes/", "https://example.com/mymail"},
		{"port preserved", "http://localhost:8089/notes", "http://localhost:8089/mymail"},
		{"query and fragment dropped", "https://example.com/mynotes?a=b#c", "https://example.com/mymail"},
		{"unparseable", "://nope", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, deriveMymailURL(tt.publicURL))
		})
	}
}

// The config script is spliced into index.html verbatim, so a URL must never be
// able to break out of the surrounding <script> element.
func TestServerConfigScriptEscapesMarkup(t *testing.T) {
	script := serverConfigScript(`https://example.com/</script><script>alert(1)</script>`)
	assert.True(t, strings.HasPrefix(script, "window.__serverConfig={mymailUrl:"), "unexpected prefix: %s", script)
	assert.NotContains(t, script, "</script>")
	assert.NotContains(t, script, "<script>")
}

func TestInjectInlineScript(t *testing.T) {
	index := []byte("<html>\n<head>\n<title>x</title>\n</head>\n<body></body>\n</html>")

	assert.Equal(t, index, injectInlineScript(index, ""), "no script means no change")

	got := string(injectInlineScript(index, "window.x=1;"))
	assert.Contains(t, got, "<script>window.x=1;</script>\n</head>")
	assert.Equal(t, 1, strings.Count(got, "<script>"))
}

func TestInlineScriptCSPHash(t *testing.T) {
	// sha256 of the empty string, base64-encoded.
	assert.Equal(t, "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='", inlineScriptCSPHash(""))
	assert.NotEqual(t, inlineScriptCSPHash("a"), inlineScriptCSPHash("b"))
}
