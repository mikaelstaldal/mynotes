package main

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mikaelstaldal/mynotes/internal/demo"
	"github.com/mikaelstaldal/mynotes/internal/handler"
	"github.com/mikaelstaldal/mynotes/web"
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

// Publishing only works if the public prefix escapes the basic-auth middleware
// that wraps everything else — and it is only safe if nothing else does.
func TestPublicRoutesSkipAuth(t *testing.T) {
	reached := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	// Stands in for the htpasswd middleware: refuses everything it is given.
	denyAll := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
		})
	}
	guarded := exemptPrefix(handler.PublicPrefix, denyAll)(reached)

	tests := map[string]int{
		"/public/notes/a-note":     http.StatusOK,
		"/public/artifacts/abc":    http.StatusOK,
		"/public/note.css":         http.StatusOK,
		"/api/v1/notes":            http.StatusUnauthorized,
		"/api/v1/artifacts/abc":    http.StatusUnauthorized,
		"/":                        http.StatusUnauthorized,
		"/render/":                 http.StatusUnauthorized,
		"/publicity":               http.StatusUnauthorized,
		"/notes/public/still-mine": http.StatusUnauthorized,
	}
	for path, want := range tests {
		t.Run(path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			guarded.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
			assert.Equal(t, want, rec.Result().StatusCode)
		})
	}
}

// The published-page stylesheet must be the canonical note.css plus the page
// chrome, not a copy of either — a published page that drifts from the read
// view is the failure this guards against.
func TestPublicStylesheetConcatenatesBothSources(t *testing.T) {
	css, err := publicStylesheet()
	require.NoError(t, err)

	noteCSS, err := fs.ReadFile(web.Static, "static/render/note.css")
	require.NoError(t, err)
	pageCSS, err := fs.ReadFile(web.Static, "static/public/page.css")
	require.NoError(t, err)

	assert.Contains(t, string(css), string(noteCSS))
	assert.Contains(t, string(css), string(pageCSS))
	// note.css owns the colour variables the page chrome refers to, so it must
	// come first.
	assert.Less(t, strings.Index(string(css), string(noteCSS)), strings.Index(string(css), string(pageCSS)))
}

func TestPublicCSSHandler(t *testing.T) {
	rec := httptest.NewRecorder()
	publicCSSHandler([]byte(":root{}"))(rec, httptest.NewRequest(http.MethodGet, "/public/note.css", nil))

	res := rec.Result()
	defer res.Body.Close()
	assert.Equal(t, "text/css; charset=utf-8", res.Header.Get("Content-Type"))
	assert.Equal(t, "nosniff", res.Header.Get("X-Content-Type-Options"))
	// Readable by shared caches: it is served to unauthenticated readers.
	assert.Equal(t, "public, no-cache", res.Header.Get("Cache-Control"))
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
	script := serverConfig{MymailURL: `https://example.com/</script><script>alert(1)</script>`}.script()
	assert.True(t, strings.HasPrefix(script, `window.__serverConfig={"mymailUrl":`), "unexpected prefix: %s", script)
	assert.NotContains(t, script, "</script>")
	assert.NotContains(t, script, "<script>")
}

// Nothing is injected for a plain root deployment, so index.html stays byte-for-byte
// the embedded asset and needs no extra script-src hash.
func TestServerConfigScriptEmptyWhenUnconfigured(t *testing.T) {
	assert.Equal(t, "", serverConfig{}.script())
	assert.Equal(t, `window.__serverConfig={"demo":true};`, serverConfig{Demo: true}.script())
}

func TestInjectInlineScript(t *testing.T) {
	index := []byte("<html>\n<head>\n<title>x</title>\n</head>\n<body></body>\n</html>")

	assert.Equal(t, index, injectInlineScript(index, ""), "no script means no change")

	got := string(injectInlineScript(index, "window.x=1;"))
	assert.Contains(t, got, "<script>window.x=1;</script>\n</head>")
	assert.Equal(t, 1, strings.Count(got, "<script>"))
}

// The demo bundle has to be self-contained: a shell that declares demo mode
// and carries the policy the server would otherwise send as a header, the seed
// document, the worker, and a 404 fallback for deep links.
func TestWriteDemoBundle(t *testing.T) {
	out := filepath.Join(t.TempDir(), "bundle")
	require.NoError(t, writeDemoBundle(t.Context(), out, ""))

	index, err := os.ReadFile(filepath.Join(out, "index.html"))
	require.NoError(t, err)
	assert.Contains(t, string(index), `window.__serverConfig={"demo":true};`)
	assert.Contains(t, string(index), `<meta http-equiv="Content-Security-Policy"`)
	assert.Contains(t, string(index), inlineScriptCSPHash(serverConfig{Demo: true}.script()),
		"the injected script needs its own script-src hash in the meta policy")
	assert.Contains(t, string(index), `<base href="/">`)

	notFound, err := os.ReadFile(filepath.Join(out, "404.html"))
	require.NoError(t, err)
	assert.Equal(t, index, notFound, "the 404 page is the SPA shell")

	for _, name := range []string{"app.js", "app.css", "demo-sw.js", "demo-client.js",
		filepath.Join("demo", "api.js"), filepath.Join("render", "index.html"), demo.SeedFileName} {
		_, err := os.Stat(filepath.Join(out, name))
		assert.NoError(t, err, name)
	}

	seed, err := os.ReadFile(filepath.Join(out, demo.SeedFileName))
	require.NoError(t, err)
	var parsed demo.Seed
	require.NoError(t, json.Unmarshal(seed, &parsed))
	assert.NotEmpty(t, parsed.Notes)
}

// A subpath deployment is built the same way the server serves one: the public
// URL's path becomes the shell's <base href>.
func TestWriteDemoBundleHonoursPublicURL(t *testing.T) {
	out := filepath.Join(t.TempDir(), "bundle")
	require.NoError(t, writeDemoBundle(t.Context(), out, "https://example.com/notes"))

	index, err := os.ReadFile(filepath.Join(out, "index.html"))
	require.NoError(t, err)
	assert.Contains(t, string(index), `<base href="/notes/">`)
}

// The bundle is never merged into a directory that already holds something, so
// a stale file cannot linger and nothing of the user's is overwritten.
func TestWriteDemoBundleRefusesNonEmptyDir(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "keep.txt"), []byte("mine"), 0o644))
	assert.Error(t, writeDemoBundle(t.Context(), dir, ""))

	empty := filepath.Join(t.TempDir(), "empty")
	require.NoError(t, os.Mkdir(empty, 0o755))
	assert.NoError(t, writeDemoBundle(t.Context(), empty, ""), "an empty directory is fine")
}

func TestInjectMetaCSP(t *testing.T) {
	got := string(injectMetaCSP([]byte("<head>\n    <meta charset=\"UTF-8\">\n    <title>x</title>\n</head>"),
		"default-src 'self'"))
	assert.Contains(t, got, `<meta charset="UTF-8">`)
	assert.Contains(t, got, `<meta http-equiv="Content-Security-Policy" content="default-src 'self'">`)
	assert.Less(t, strings.Index(got, "Content-Security-Policy"), strings.Index(got, "<title>"),
		"the policy must precede what it governs")
}

func TestInlineScriptCSPHash(t *testing.T) {
	// sha256 of the empty string, base64-encoded.
	assert.Equal(t, "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='", inlineScriptCSPHash(""))
	assert.NotEqual(t, inlineScriptCSPHash("a"), inlineScriptCSPHash("b"))
}

// The export reads an existing database rather than creating one, so a mistyped
// -data fails loudly instead of leaving an empty directory and exiting 0.
func TestRunMarkdownExportRequiresAnExistingDatabase(t *testing.T) {
	data := t.TempDir()
	out := filepath.Join(t.TempDir(), "out")

	err := runMarkdownExport(t.Context(), out, data)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "does not create one")
	assert.NoDirExists(t, out, "nothing is written when there is no database to export")
}

// End to end against a real database: seed it, then export it as Markdown files
// named by the seeded notes' slugs.
func TestRunMarkdownExportWritesOneFilePerNote(t *testing.T) {
	data := t.TempDir()
	out := filepath.Join(t.TempDir(), "out")
	require.NoError(t, runDemo(t.Context(), data))

	require.NoError(t, runMarkdownExport(t.Context(), out, data))

	entries, err := os.ReadDir(out)
	require.NoError(t, err)
	require.NotEmpty(t, entries)
	for _, e := range entries {
		assert.Equal(t, ".md", filepath.Ext(e.Name()), e.Name())
	}

	welcome, err := os.ReadFile(filepath.Join(out, "welcome-to-mynotes.md"))
	require.NoError(t, err)
	assert.Contains(t, string(welcome), "title: Welcome to MyNotes\n",
		"the file carries the download-Markdown frontmatter")
	assert.Contains(t, string(welcome), "slug: welcome-to-mynotes\n",
		"the file name is the note's slug, the same identifier as in its URL")
}
