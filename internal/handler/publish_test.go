package handler_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/mikaelstaldal/mynotes/internal/api"
)

// A one-pixel GIF, the smallest thing that passes the artifact content check.
var testGIF = []byte("GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!" +
	"\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;")

// uploadArtifact POSTs an artifact and returns its hex digest, asserting 201.
func uploadArtifact(t *testing.T, srv *httptest.Server, content []byte, contentType string) string {
	t.Helper()
	res, err := http.Post(srv.URL+"/api/v1/artifacts", contentType, bytes.NewReader(content))
	require.NoError(t, err)
	defer res.Body.Close()
	require.Equal(t, http.StatusCreated, res.StatusCode)
	var created api.Artifact
	require.NoError(t, json.NewDecoder(res.Body).Decode(&created))
	return created.SHA256
}

// publishNote PUTs a rendered fragment as a note's public page.
func publishNote(t *testing.T, srv *httptest.Server, slug, html string) *http.Response {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPut,
		srv.URL+"/api/v1/notes/"+slug+"/publish", strings.NewReader(html))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "text/html")
	res, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	return res
}

func unpublishNote(t *testing.T, srv *httptest.Server, slug string) *http.Response {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodDelete,
		srv.URL+"/api/v1/notes/"+slug+"/publish", nil)
	require.NoError(t, err)
	res, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	return res
}

// getBody GETs a URL and returns its status and body.
func getBody(t *testing.T, url string) (*http.Response, string) {
	t.Helper()
	res, err := http.Get(url) //nolint:noctx // test helper
	require.NoError(t, err)
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	require.NoError(t, err)
	return res, string(body)
}

// --- publishing and serving ---

func TestPublishAndServeNote(t *testing.T) {
	srv := newServer(t)
	note := createNote(t, srv, `{"title":"Public Note","content":"hello"}`)

	res := publishNote(t, srv, note.Slug, `<p>hello <em>world</em></p>`)
	defer res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)
	var published api.PublishedNote
	require.NoError(t, json.NewDecoder(res.Body).Decode(&published))
	assert.Equal(t, "/public/notes/"+note.Slug, published.URL)
	assert.False(t, published.PublishedAt.IsZero())

	page, body := getBody(t, srv.URL+published.URL)
	assert.Equal(t, http.StatusOK, page.StatusCode)
	assert.Equal(t, "text/html; charset=utf-8", page.Header.Get("Content-Type"))
	// The title appears twice: as the tab title and as the page's heading.
	assert.Contains(t, body, "<title>Public Note</title>")
	assert.Contains(t, body, "<h1>Public Note</h1>")
	assert.Contains(t, body, "<p>hello <em>world</em></p>")
	assert.Contains(t, body, `<link rel="stylesheet" href="../note.css">`)
}

// A wikilink between two published notes must reach the other note's public
// page. The clients do the rewriting, so this pins the other half: the server
// stores the relative href rather than stripping it, and it resolves to the
// sibling page.
func TestPublishedNoteLinksToItsSibling(t *testing.T) {
	srv := newServer(t)
	first := createNote(t, srv, `{"title":"First","content":"x","slug":"first-note"}`)
	createNote(t, srv, `{"title":"Second","content":"y","slug":"second-note"}`)

	res := publishNote(t, srv, first.Slug, `<p>see <a href="./second-note">Second</a></p>`)
	res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)

	page, body := getBody(t, srv.URL+"/public/notes/"+first.Slug)
	require.Equal(t, http.StatusOK, page.StatusCode)
	assert.Contains(t, body, `<a href="./second-note">Second</a>`)

	// The link 404s while the target is unpublished, and works once it is —
	// without re-publishing the note that links to it.
	target, _ := getBody(t, srv.URL+"/public/notes/second-note")
	assert.Equal(t, http.StatusNotFound, target.StatusCode)

	published := publishNote(t, srv, "second-note", `<p>second</p>`)
	published.Body.Close()
	target, _ = getBody(t, srv.URL+"/public/notes/second-note")
	assert.Equal(t, http.StatusOK, target.StatusCode)
}

// A published page carries no script of its own, and its policy must make it
// impossible for it to acquire any — that is what lets the write guard store
// author CSS verbatim (see sanitize.newPublishedPolicy).
func TestPublishedPageIsScriptFree(t *testing.T) {
	srv := newServer(t)
	note := createNote(t, srv, `{"title":"CSP","content":"x"}`)
	res := publishNote(t, srv, note.Slug, `<p>x</p>`)
	res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)

	page, _ := getBody(t, srv.URL+"/public/notes/"+note.Slug)
	csp := page.Header.Get("Content-Security-Policy")
	assert.Contains(t, csp, "default-src 'none'")
	assert.NotContains(t, csp, "script-src")
	assert.Contains(t, csp, "frame-ancestors 'none'")
	assert.Equal(t, "nosniff", page.Header.Get("X-Content-Type-Options"))
}

func TestPublishSanitizesFragment(t *testing.T) {
	srv := newServer(t)
	note := createNote(t, srv, `{"title":"Hostile","content":"x"}`)

	res := publishNote(t, srv, note.Slug,
		`<p onclick="steal()">keep</p><script>alert(1)</script><iframe src="https://evil.example/"></iframe>`)
	res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)

	_, body := getBody(t, srv.URL+"/public/notes/"+note.Slug)
	assert.Contains(t, body, "<p>keep</p>")
	assert.NotContains(t, body, "alert(1)")
	assert.NotContains(t, body, "onclick")
	assert.NotContains(t, body, "evil.example")
}

// The note title is validated but never sanitized (it is not stored as markup),
// so the document builder is the only thing standing between a title and the
// HTML it is spliced into.
func TestPublishedTitleIsEscaped(t *testing.T) {
	srv := newServer(t)
	note := createNote(t, srv, `{"title":"a <b> & \"c\"","content":"x"}`)
	res := publishNote(t, srv, note.Slug, `<p>x</p>`)
	res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)

	_, body := getBody(t, srv.URL+"/public/notes/"+note.Slug)
	assert.NotContains(t, body, "<b>")
	assert.Contains(t, body, "a &lt;b&gt; &amp; &quot;c&quot;")
}

// A published page is a snapshot: editing the note must not change what a
// reader sees until the note is published again.
func TestPublishedPageIsASnapshot(t *testing.T) {
	srv := newServer(t)
	note := createNote(t, srv, `{"title":"Before","content":"x"}`)
	res := publishNote(t, srv, note.Slug, `<p>before</p>`)
	res.Body.Close()

	patched := patchNote(t, srv, note.Slug, `{"title":"After","content":"y"}`)
	patched.Body.Close()
	require.Equal(t, http.StatusOK, patched.StatusCode)

	_, body := getBody(t, srv.URL+"/public/notes/"+note.Slug)
	assert.Contains(t, body, "<p>before</p>")
	assert.Contains(t, body, "<title>Before</title>")

	res = publishNote(t, srv, note.Slug, `<p>after</p>`)
	res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)

	_, body = getBody(t, srv.URL+"/public/notes/"+note.Slug)
	assert.Contains(t, body, "<p>after</p>")
	assert.Contains(t, body, "<title>After</title>")
}

// --- publish state on the note itself ---

func TestPublishedAtSurfacesOnNoteAndList(t *testing.T) {
	srv := newServer(t)
	note := createNote(t, srv, `{"title":"State","content":"x"}`)

	res, _ := getBody(t, srv.URL+"/api/v1/notes/"+note.Slug)
	require.Equal(t, http.StatusOK, res.StatusCode)

	fetched := getNote(t, srv, note.Slug)
	assert.False(t, fetched.PublishedAt.IsSet(), "a fresh note is not published")

	published := publishNote(t, srv, note.Slug, `<p>x</p>`)
	published.Body.Close()

	fetched = getNote(t, srv, note.Slug)
	assert.True(t, fetched.PublishedAt.IsSet(), "publish state must reach the note")

	// And the list projection, which is what the note rows render their badge from.
	listed := listNotes(t, srv)
	require.Len(t, listed.Notes, 1)
	assert.True(t, listed.Notes[0].PublishedAt.IsSet())

	unpub := unpublishNote(t, srv, note.Slug)
	unpub.Body.Close()
	require.Equal(t, http.StatusNoContent, unpub.StatusCode)

	fetched = getNote(t, srv, note.Slug)
	assert.False(t, fetched.PublishedAt.IsSet())
}

func getNote(t *testing.T, srv *httptest.Server, slug string) api.Note {
	t.Helper()
	res, err := http.Get(srv.URL + "/api/v1/notes/" + slug) //nolint:noctx // test helper
	require.NoError(t, err)
	defer res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)
	var n api.Note
	require.NoError(t, json.NewDecoder(res.Body).Decode(&n))
	return n
}

func listNotes(t *testing.T, srv *httptest.Server) api.NoteList {
	t.Helper()
	res, err := http.Get(srv.URL + "/api/v1/notes") //nolint:noctx // test helper
	require.NoError(t, err)
	defer res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)
	var l api.NoteList
	require.NoError(t, json.NewDecoder(res.Body).Decode(&l))
	return l
}

// --- withdrawal ---

func TestUnpublishWithdrawsThePage(t *testing.T) {
	srv := newServer(t)
	note := createNote(t, srv, `{"title":"Temporary","content":"x"}`)
	res := publishNote(t, srv, note.Slug, `<p>x</p>`)
	res.Body.Close()

	unpub := unpublishNote(t, srv, note.Slug)
	unpub.Body.Close()
	require.Equal(t, http.StatusNoContent, unpub.StatusCode)

	page, _ := getBody(t, srv.URL+"/public/notes/"+note.Slug)
	assert.Equal(t, http.StatusNotFound, page.StatusCode)

	// Unpublishing twice is a 404, not a silent success.
	again := unpublishNote(t, srv, note.Slug)
	again.Body.Close()
	assert.Equal(t, http.StatusNotFound, again.StatusCode)
}

// Deleting a note must withdraw its public page — the schema's ON DELETE
// CASCADE is what enforces this, so it is worth pinning from the outside.
func TestDeletingANoteUnpublishesIt(t *testing.T) {
	srv := newServer(t)
	note := createNote(t, srv, `{"title":"Doomed","content":"x"}`)
	digest := uploadArtifact(t, srv, testGIF, "image/gif")
	res := publishNote(t, srv, note.Slug, `<p><img src="artifact:`+digest+`" alt=""></p>`)
	res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)

	req, err := http.NewRequestWithContext(context.Background(), http.MethodDelete,
		srv.URL+"/api/v1/notes/"+note.Slug, nil)
	require.NoError(t, err)
	del, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	del.Body.Close()
	require.Equal(t, http.StatusNoContent, del.StatusCode)

	page, _ := getBody(t, srv.URL+"/public/notes/"+note.Slug)
	assert.Equal(t, http.StatusNotFound, page.StatusCode)
	art, _ := getBody(t, srv.URL+"/public/artifacts/"+digest)
	assert.Equal(t, http.StatusNotFound, art.StatusCode, "the artifact goes with the page")
}

// An unpublished note and a note that does not exist must be indistinguishable
// to an unauthenticated reader, who must not be able to enumerate slugs.
func TestUnpublishedAndMissingNotesLookAlike(t *testing.T) {
	srv := newServer(t)
	createNote(t, srv, `{"title":"Private","content":"x","slug":"private"}`)

	unpublished, unpublishedBody := getBody(t, srv.URL+"/public/notes/private")
	missing, missingBody := getBody(t, srv.URL+"/public/notes/no-such-note")
	assert.Equal(t, http.StatusNotFound, unpublished.StatusCode)
	assert.Equal(t, http.StatusNotFound, missing.StatusCode)
	assert.Equal(t, missingBody, unpublishedBody)
}

// --- artifacts ---

func TestPublicArtifactOnlyServesPublishedDigests(t *testing.T) {
	srv := newServer(t)
	referenced := uploadArtifact(t, srv, testGIF, "image/gif")
	// A second artifact, uploaded but never referenced by a published note.
	other := append(append([]byte{}, testGIF...), 0x00)
	unreferenced := uploadArtifact(t, srv, other, "image/gif")
	require.NotEqual(t, referenced, unreferenced)

	note := createNote(t, srv, `{"title":"With image","content":"x"}`)
	res := publishNote(t, srv, note.Slug, `<p><img src="artifact:`+referenced+`" alt=""></p>`)
	res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)

	// The stored fragment references the public path, not the API path — a
	// reader has no credentials for the latter — and carries no inlined data.
	_, body := getBody(t, srv.URL+"/public/notes/"+note.Slug)
	assert.Contains(t, body, `src="../artifacts/`+referenced+`"`)
	assert.NotContains(t, body, "/api/v1/artifacts/")
	assert.NotContains(t, body, "data:image/")

	served, servedBody := getBody(t, srv.URL+"/public/artifacts/"+referenced)
	assert.Equal(t, http.StatusOK, served.StatusCode)
	assert.Equal(t, "image/gif", served.Header.Get("Content-Type"))
	assert.Equal(t, "public, max-age=31536000, immutable", served.Header.Get("Cache-Control"))
	assert.Equal(t, string(testGIF), servedBody)

	// This is the whole point of the join table: publishing one note must not
	// hand out the rest of the artifact store.
	withheld, _ := getBody(t, srv.URL+"/public/artifacts/"+unreferenced)
	assert.Equal(t, http.StatusNotFound, withheld.StatusCode)
}

// Re-publishing a note that no longer uses an image must withdraw that image.
func TestRepublishNarrowsTheArtifactSet(t *testing.T) {
	srv := newServer(t)
	digest := uploadArtifact(t, srv, testGIF, "image/gif")
	note := createNote(t, srv, `{"title":"Shrinking","content":"x"}`)

	res := publishNote(t, srv, note.Slug, `<p><img src="artifact:`+digest+`" alt=""></p>`)
	res.Body.Close()
	served, _ := getBody(t, srv.URL+"/public/artifacts/"+digest)
	require.Equal(t, http.StatusOK, served.StatusCode)

	res = publishNote(t, srv, note.Slug, `<p>no image any more</p>`)
	res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)

	withdrawn, _ := getBody(t, srv.URL+"/public/artifacts/"+digest)
	assert.Equal(t, http.StatusNotFound, withdrawn.StatusCode)
}

// An artifact stays public while any *other* published note still uses it.
func TestArtifactStaysPublicWhileAnotherNoteUsesIt(t *testing.T) {
	srv := newServer(t)
	digest := uploadArtifact(t, srv, testGIF, "image/gif")
	first := createNote(t, srv, `{"title":"First","content":"x"}`)
	second := createNote(t, srv, `{"title":"Second","content":"x"}`)
	fragment := `<p><img src="artifact:` + digest + `" alt=""></p>`

	for _, slug := range []string{first.Slug, second.Slug} {
		res := publishNote(t, srv, slug, fragment)
		res.Body.Close()
		require.Equal(t, http.StatusOK, res.StatusCode)
	}

	unpub := unpublishNote(t, srv, first.Slug)
	unpub.Body.Close()

	served, _ := getBody(t, srv.URL+"/public/artifacts/"+digest)
	assert.Equal(t, http.StatusOK, served.StatusCode)
}

// Mentioning a digest is not using it. A note that documents the
// `artifact:<sha256>` syntax, or quotes a digest in prose, displays no image —
// and must not hand that artifact out to unauthenticated readers.
func TestMentioningADigestDoesNotPublishTheArtifact(t *testing.T) {
	srv := newServer(t)
	digest := uploadArtifact(t, srv, testGIF, "image/gif")
	note := createNote(t, srv, `{"title":"Docs","content":"x"}`)

	res := publishNote(t, srv, note.Slug,
		`<p>Embed one with <code>![alt](artifact:`+digest+`)</code>.</p>`)
	res.Body.Close()
	require.Equal(t, http.StatusOK, res.StatusCode)

	withheld, _ := getBody(t, srv.URL+"/public/artifacts/"+digest)
	assert.Equal(t, http.StatusNotFound, withheld.StatusCode)

	// …and the quoted text is published as written, not rewritten into a URL.
	_, body := getBody(t, srv.URL+"/public/notes/"+note.Slug)
	assert.Contains(t, body, "artifact:"+digest)
	assert.NotContains(t, body, "../artifacts/")
}

func TestPublishRejectsUnknownArtifact(t *testing.T) {
	srv := newServer(t)
	note := createNote(t, srv, `{"title":"Dangling","content":"x"}`)
	sum := sha256.Sum256([]byte("never uploaded"))
	digest := hex.EncodeToString(sum[:])

	res := publishNote(t, srv, note.Slug, `<p><img src="artifact:`+digest+`" alt=""></p>`)
	defer res.Body.Close()
	assert.Equal(t, http.StatusBadRequest, res.StatusCode)

	page, _ := getBody(t, srv.URL+"/public/notes/"+note.Slug)
	assert.Equal(t, http.StatusNotFound, page.StatusCode, "a rejected publish must publish nothing")
}

// --- the rest of the prefix ---

// Everything under the public prefix is exempt from authentication, so nothing
// under it may fall through to the SPA shell.
func TestPublicPrefixCatchAll(t *testing.T) {
	srv := newServer(t)
	for _, path := range []string{"/public/", "/public/notes", "/public/whatever", "/public/artifacts/x"} {
		res, _ := getBody(t, srv.URL+path)
		assert.Equal(t, http.StatusNotFound, res.StatusCode, path)
	}
}

func TestPublishUnknownNote(t *testing.T) {
	srv := newServer(t)
	res := publishNote(t, srv, "no-such-note", `<p>x</p>`)
	defer res.Body.Close()
	assert.Equal(t, http.StatusNotFound, res.StatusCode)
}
