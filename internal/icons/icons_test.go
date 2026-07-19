package icons

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// serve routes a GET /api/v1/icons/lucide/{name} request through the handler the
// same way the mux does, so PathValue("name") is populated.
func serve(t *testing.T, name string) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	mux.Handle("GET /api/v1/icons/lucide/{name}", Handler())
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/icons/lucide/"+name, nil))
	return rec
}

func TestEmbeddedSet(t *testing.T) {
	require.Greater(t, Count(), 1000, "expected the full Lucide set to be embedded")
	require.Contains(t, svgs, "search")
}

func TestServeKnownIcon(t *testing.T) {
	rec := serve(t, "search")
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "image/svg+xml", rec.Header().Get("Content-Type"))
	assert.Equal(t, "nosniff", rec.Header().Get("X-Content-Type-Options"))
	assert.Contains(t, rec.Header().Get("Cache-Control"), "immutable")
	assert.Contains(t, rec.Header().Get("Content-Security-Policy"), "sandbox")

	body := rec.Body.String()
	assert.True(t, strings.HasPrefix(body, "<svg"), "body should be an SVG document")
	// The served SVG must be a standalone document (keeps its xmlns) so it renders
	// via <img>, unlike the inline form used in the picker previews.
	assert.Contains(t, body, `xmlns="http://www.w3.org/2000/svg"`)
	assert.Contains(t, body, "lucide-search")
}

func TestGetInlineStripsXmlns(t *testing.T) {
	standalone, ok := Get("search")
	require.True(t, ok)
	assert.Contains(t, standalone, "xmlns", "standalone form keeps xmlns for <img> use")

	inline, ok := GetInline("search")
	require.True(t, ok)
	assert.NotContains(t, inline, "xmlns", "inline form drops the redundant xmlns")
	assert.True(t, strings.HasPrefix(inline, "<svg "), "inline form is still a well-formed <svg>")
	assert.Contains(t, inline, "lucide-search")

	_, ok = GetInline("no-such-icon")
	assert.False(t, ok)
}

func TestUnknownIconIs404(t *testing.T) {
	rec := serve(t, "no-such-icon")
	assert.Equal(t, http.StatusNotFound, rec.Code)
}
