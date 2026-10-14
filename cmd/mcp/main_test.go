package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mikaelstaldal/mynotes/internal/api"
	"github.com/mikaelstaldal/mynotes/internal/handler"
	"github.com/mikaelstaldal/mynotes/internal/icons"
	"github.com/mikaelstaldal/mynotes/internal/model"
	"github.com/mikaelstaldal/mynotes/internal/repository"
	"github.com/mikaelstaldal/mynotes/internal/service"
	"github.com/mikaelstaldal/mynotes/internal/token"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"
)

// fixture is a real MyNotes API behind the real bearer middleware and token
// store — authorization is the server's, so the tests must not mock it.
type fixture struct {
	url      string
	store    token.Store
	secret   string
	slug     string
	content  string
	artifact *model.Artifact
	bytes    []byte
	paths    *recorder
}

// recorder keeps the path of every request the fixture answers, so the drift
// test sees what the MCP server actually requests rather than what it would
// resolve a URI to.
type recorder struct {
	mu    sync.Mutex
	paths []string
}

func (r *recorder) take() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	paths := r.paths
	r.paths = nil
	return paths
}

// newFixture serves the API. With basicAuth, a request without a bearer token
// gets 401, as from a server with Basic authentication configured; without
// it, such a request reaches the API, as from a server with none.
func newFixture(t *testing.T, basicAuth bool) *fixture {
	t.Helper()
	db, err := repository.OpenDB(t.TempDir()+"/app.sqlite", 5000)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	tags := repository.NewTagRepository(db)
	noteSvc := service.NewNoteService(repository.NewNoteRepository(db), tags)
	tagSvc := service.NewTagService(tags)
	_, err = tagSvc.Create(context.Background(), "work")
	require.NoError(t, err)
	_, err = tagSvc.Create(context.Background(), "workshop")
	require.NoError(t, err)
	content := "Some searchable Markdown"
	note, err := noteSvc.Create(context.Background(), "Reader example", &content, nil, []string{"work"})
	require.NoError(t, err)
	artifactSvc := service.NewArtifactService(repository.NewArtifactRepository(db))
	artifactBytes := []byte("\x89PNG\r\n\x1a\npayload")
	artifact, err := artifactSvc.Create(context.Background(), artifactBytes, "image/png")
	require.NoError(t, err)
	h := handler.New(noteSvc, artifactSvc, tagSvc, nil)
	generated, err := api.NewServer(h, api.WithPathPrefix("/api/v1"))
	require.NoError(t, err)
	store := token.Store{DB: db}
	_, secret, err := store.Create("Reader", time.Now().Add(time.Hour))
	require.NoError(t, err)
	mux := http.NewServeMux()
	mux.Handle("GET /api/v1/artifacts/{sha256}", handler.WithMiddleware(http.HandlerFunc(h.ServeArtifact)))
	mux.Handle("GET /api/v1/icons/lucide/{name}", handler.WithMiddleware(icons.Handler()))
	mux.HandleFunc("/api/v1/tokens", store.Management)
	mux.HandleFunc("/api/v1/tokens/", store.Management)
	token.MountDeviceGrant(mux, store.DeviceGrant("http://127.0.0.1/device-approval.html"))
	mux.Handle("/api/v1/", handler.WithMiddleware(token.ReadHead(generated)))
	var full http.Handler = mux
	if basicAuth {
		full = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusUnauthorized) })
	}
	paths := &recorder{}
	bearer := store.Bearer(full, mux)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths.mu.Lock()
		paths.paths = append(paths.paths, r.URL.EscapedPath())
		paths.mu.Unlock()
		bearer.ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	return &fixture{url: server.URL, store: store, secret: secret, slug: note.Slug, content: content, artifact: &artifact, bytes: artifactBytes, paths: paths}
}

func (f *fixture) tokenFile(t *testing.T) string {
	path := filepath.Join(t.TempDir(), "token")
	require.NoError(t, os.WriteFile(path, []byte(f.secret+"\n"), 0o600))
	return path
}

// connect configures a client from flags, exactly as the binary does, and
// connects an MCP session to it in memory.
func connect(t *testing.T, args ...string) *mcp.ClientSession {
	t.Helper()
	t.Setenv("MYNOTES_URL", "")
	t.Setenv("MYNOTES_TOKEN_FILE", "")
	c, help, err := configure(args)
	require.NoError(t, err)
	require.False(t, help)
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	ctx := context.Background()
	serverSession, err := newServer(c).Connect(ctx, serverTransport, nil)
	require.NoError(t, err)
	t.Cleanup(func() { _ = serverSession.Close() })
	session, err := mcp.NewClient(&mcp.Implementation{Name: "test"}, nil).Connect(ctx, clientTransport, nil)
	require.NoError(t, err)
	t.Cleanup(func() { _ = session.Close() })
	return session
}

func read(t *testing.T, session *mcp.ClientSession, uri string) (*mcp.ResourceContents, error) {
	t.Helper()
	result, err := session.ReadResource(context.Background(), &mcp.ReadResourceParams{URI: uri})
	if err != nil {
		return nil, err
	}
	require.Len(t, result.Contents, 1)
	return result.Contents[0], nil
}

func callText(t *testing.T, result *mcp.CallToolResult) string {
	t.Helper()
	require.Len(t, result.Content, 1)
	text, ok := result.Content[0].(*mcp.TextContent)
	require.True(t, ok)
	return text.Text
}

// samples instantiates every resource and template the server lists. A new
// one without a sample fails TestSurfaceMatchesTokenSurface.
func samples(f *fixture) map[string]string {
	return map[string]string{
		"mynotes://tags":                  "mynotes://tags",
		"mynotes://notes":                 "mynotes://notes",
		notesTemplate:                     "mynotes://notes?limit=5",
		"mynotes://notes/{slug}":          "mynotes://notes/" + f.slug,
		"mynotes://notes/{slug}/markdown": "mynotes://notes/" + f.slug + "/markdown",
		"mynotes://artifacts/{sha256}":    "mynotes://artifacts/" + f.artifact.SHA256,
	}
}

// excluded is mcp-server.md §2.3's exclusion list for MyNotes' API, verbatim.
// The unauthenticated routes it also lists (/openapi.yaml,
// /.well-known/api-catalog, /public/…) are outside openapi.yaml's paths, so
// this test cannot enumerate them.
var excluded = []string{"/icons/{set}/{name}"}

// TestSurfaceMatchesTokenSurface is the drift test (mcp-server.md §4.1):
// every resource, template and tool requests only API paths a token may read,
// and every such path is requested by one of them or excluded.
//
// Its bound: the paths a token may read are enumerated from openapi.yaml's GET
// operations, probed through the real bearer middleware. A bearer-readable
// route that openapi.yaml does not document is invisible to it.
func TestSurfaceMatchesTokenSurface(t *testing.T) {
	f := newFixture(t, true)
	raw, err := os.ReadFile("../../openapi.yaml")
	require.NoError(t, err)
	var document struct {
		Paths map[string]map[string]any `yaml:"paths"`
	}
	require.NoError(t, yaml.Unmarshal(raw, &document))
	dummy := strings.NewReplacer("{slug}", "x", "{sha256}", strings.Repeat("a", 64), "{set}", "lucide", "{name}", "heart", "{user_code}", "ABCD-EFGH")
	permitted := []string{}
	patterns := map[string]*regexp.Regexp{}
	for path, operations := range document.Paths {
		if _, ok := operations["get"]; !ok {
			continue
		}
		patterns[path] = regexp.MustCompile("^/api/v1" + regexp.MustCompile(`\\\{[a-z_0-9]+\\\}`).ReplaceAllString(regexp.QuoteMeta(path), "[^/]+") + "$")
		request, err := http.NewRequest(http.MethodGet, f.url+"/api/v1"+dummy.Replace(path), nil)
		require.NoError(t, err)
		request.Header.Set("Authorization", "Bearer "+f.secret)
		response, err := http.DefaultClient.Do(request)
		require.NoError(t, err)
		_ = response.Body.Close()
		if response.StatusCode != http.StatusForbidden {
			permitted = append(permitted, path)
		}
	}
	require.NotEmpty(t, permitted)

	session := connect(t, "-url", f.url, "-token-file", f.tokenFile(t))
	ctx := context.Background()
	listed := []string{}
	resources, err := session.ListResources(ctx, nil)
	require.NoError(t, err)
	for _, resource := range resources.Resources {
		listed = append(listed, resource.URI)
	}
	templates, err := session.ListResourceTemplates(ctx, nil)
	require.NoError(t, err)
	for _, template := range templates.ResourceTemplates {
		listed = append(listed, template.URITemplate)
	}
	// Each tool's endpoint is pinned: a resource covering the same path would
	// otherwise hide a tool that requests the wrong one.
	toolSamples := map[string]struct {
		arguments map[string]any
		endpoint  string
	}{
		"search_notes": {map[string]any{"q": "searchable"}, "/notes"},
	}
	covered := []string{}
	// cover records the API paths one read or call requested.
	cover := func(what string) []string {
		requested := f.paths.take()
		require.NotEmpty(t, requested, "%s made no request", what)
		documented := []string{}
		for _, path := range requested {
			matched := ""
			for documented, pattern := range patterns {
				if pattern.MatchString(path) {
					matched = documented
				}
			}
			require.NotEmpty(t, matched, "%s requested %s, which is not in openapi.yaml", what, path)
			covered = append(covered, matched)
			documented = append(documented, matched)
		}
		return documented
	}
	f.paths.take()
	sampleURIs := samples(f)
	for _, uri := range listed {
		sample, ok := sampleURIs[uri]
		require.True(t, ok, "no sample for %s", uri)
		_, err := read(t, session, sample)
		require.NoError(t, err, sample)
		cover(uri)
	}
	tools, err := session.ListTools(ctx, nil)
	require.NoError(t, err)
	for _, tool := range tools.Tools {
		sample, ok := toolSamples[tool.Name]
		require.True(t, ok, "no sample for tool %s", tool.Name)
		result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: tool.Name, Arguments: sample.arguments})
		require.NoError(t, err)
		require.False(t, result.IsError, tool.Name)
		assert.Equal(t, []string{sample.endpoint}, cover(tool.Name), tool.Name)
	}

	exposed := append(slices.Clone(covered), excluded...)
	slices.Sort(exposed)
	exposed = slices.Compact(exposed)
	slices.Sort(permitted)
	assert.Equal(t, permitted, exposed)
}

func TestResourcesReturnWhatTheAPIReturns(t *testing.T) {
	f := newFixture(t, true)
	session := connect(t, "-url", f.url, "-token-file", f.tokenFile(t))
	for _, tc := range []struct {
		uri, mime, contains string
	}{
		{"mynotes://tags", "application/json", `"slug":"work"`},
		{"mynotes://notes", "application/json", f.slug},
		{"mynotes://notes?tag=work&limit=1&tag=work", "application/json", f.slug},
		{"mynotes://notes?offset=0&sort=title&order=asc", "application/json", f.slug},
		{"mynotes://notes/" + f.slug, "application/json", f.content},
		{"mynotes://notes/" + f.slug + "/markdown", "text/markdown", f.content},
	} {
		contents, err := read(t, session, tc.uri)
		require.NoError(t, err, tc.uri)
		assert.Equal(t, tc.uri, contents.URI)
		assert.Equal(t, tc.mime, contents.MIMEType, tc.uri)
		assert.Contains(t, contents.Text, tc.contains, tc.uri)
		assert.Empty(t, contents.Blob, tc.uri)
	}
	contents, err := read(t, session, "mynotes://notes?tag=workshop")
	require.NoError(t, err)
	assert.NotContains(t, contents.Text, f.slug, "the tag filter is forwarded")

	contents, err = read(t, session, "mynotes://artifacts/"+f.artifact.SHA256)
	require.NoError(t, err)
	assert.Equal(t, "image/png", contents.MIMEType)
	assert.Equal(t, f.bytes, contents.Blob)
	assert.Empty(t, contents.Text)

	_, err = read(t, session, "mynotes://notes/no-such-note")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "Resource not found")
}

func TestSearchNotesTool(t *testing.T) {
	f := newFixture(t, true)
	session := connect(t, "-url", f.url, "-token-file", f.tokenFile(t))
	ctx := context.Background()
	tools, err := session.ListTools(ctx, nil)
	require.NoError(t, err)
	require.Len(t, tools.Tools, 1)
	tool := tools.Tools[0]
	require.NotNil(t, tool.Annotations)
	assert.True(t, tool.Annotations.ReadOnlyHint)
	require.NotNil(t, tool.Annotations.OpenWorldHint)
	assert.False(t, *tool.Annotations.OpenWorldHint)
	schema, err := json.Marshal(tool.InputSchema)
	require.NoError(t, err)
	var parsed struct {
		Required   []string `json:"required"`
		Properties map[string]struct {
			Type any `json:"type"`
		} `json:"properties"`
	}
	require.NoError(t, json.Unmarshal(schema, &parsed))
	assert.Equal(t, []string{"q"}, parsed.Required)
	assert.Equal(t, "array", parsed.Properties["tag"].Type)

	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "search_notes", Arguments: map[string]any{"q": "searchable", "tag": []string{"work"}}})
	require.NoError(t, err)
	assert.False(t, result.IsError)
	assert.Contains(t, callText(t, result), f.slug)
	assert.NotNil(t, result.StructuredContent)

	result, err = session.CallTool(ctx, &mcp.CallToolParams{Name: "search_notes", Arguments: map[string]any{"q": "Reader", "titlePrefix": true, "limit": 1}})
	require.NoError(t, err)
	assert.False(t, result.IsError)
	assert.Contains(t, callText(t, result), f.slug)

	result, err = session.CallTool(ctx, &mcp.CallToolParams{Name: "search_notes", Arguments: map[string]any{"q": "searchable", "tag": []string{"workshop"}}})
	require.NoError(t, err)
	assert.NotContains(t, callText(t, result), f.slug, "the tag filter is forwarded")

	// ogen rejects the parameter before the handler, with `error_message`.
	result, err = session.CallTool(ctx, &mcp.CallToolParams{Name: "search_notes", Arguments: map[string]any{"q": "x", "limit": 1000}})
	require.NoError(t, err)
	assert.True(t, result.IsError)
	assert.Contains(t, callText(t, result), "HTTP 400: ")
	assert.Contains(t, callText(t, result), "greater than 200")
	assert.NotContains(t, callText(t, result), "error_message", "the field's value, not the raw body")
	_, err = read(t, session, "mynotes://notes?limit=1000")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "greater than 200")
	assert.NotContains(t, err.Error(), "error_message")
}

func TestToolArgumentsAreValidated(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1) }))
	defer server.Close()
	session := connect(t, "-url", server.URL)
	for _, arguments := range []map[string]any{
		{},
		{"q": "x", "sort": "title"},
		{"q": "x", "tag": "work"},
	} {
		result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "search_notes", Arguments: arguments})
		require.NoError(t, err, arguments)
		assert.True(t, result.IsError, arguments)
	}
	assert.Zero(t, requests.Load(), "a refused call makes no HTTP request")
}

func TestQueryParametersAreParsedHere(t *testing.T) {
	var requests atomic.Int32
	var last atomic.Value
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		last.Store(r.URL.RawQuery)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	session := connect(t, "-url", server.URL)

	_, err := read(t, session, "mynotes://notes?offset=5&tag=b&limit=2&tag=a")
	require.NoError(t, err)
	assert.Equal(t, "limit=2&offset=5&tag=b&tag=a", last.Load())

	before := requests.Load()
	for uri, want := range map[string]struct {
		message string
		code    int64
	}{
		// Refused here with the internal-error code, so a client that shows
		// every invalid-params error as "not found" still shows the message.
		"mynotes://notes?q=text":          {"use the search_notes tool", jsonrpc.CodeInternalError},
		"mynotes://notes?limit=1&limit=2": {"only once", jsonrpc.CodeInternalError},
		// No template takes a query here, so the SDK's dispatch refuses it.
		"mynotes://tags?limit=1":       {"Resource not found", jsonrpc.CodeInvalidParams},
		"mynotes://notes/x?sort=title": {"Resource not found", jsonrpc.CodeInvalidParams},
	} {
		_, err := read(t, session, uri)
		require.Error(t, err, uri)
		assert.Contains(t, err.Error(), want.message, uri)
		var wire *jsonrpc.Error
		require.ErrorAs(t, err, &wire, uri)
		assert.Equal(t, want.code, wire.Code, uri)
	}
	assert.Equal(t, before, requests.Load(), "a refused URI makes no HTTP request")
}

func TestResponseCap(t *testing.T) {
	size := maxBody
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/v1/artifacts/"):
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(bytes.Repeat([]byte{0x89}, size))
		case strings.HasSuffix(r.URL.Path, "/download-markdown"):
			w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
			_, _ = w.Write(bytes.Repeat([]byte("m"), size))
		default:
			w.Header().Set("Content-Type", "application/json")
			body := `{"notes":[],"pad":"` + strings.Repeat("p", size-len(`{"notes":[],"pad":""}`)) + `"}`
			_, _ = w.Write([]byte(body))
		}
	}))
	defer server.Close()
	session := connect(t, "-url", server.URL)
	ctx := context.Background()
	search := func() *mcp.CallToolResult {
		result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "search_notes", Arguments: map[string]any{"q": "x"}})
		require.NoError(t, err)
		return result
	}

	contents, err := read(t, session, "mynotes://notes/x/markdown")
	require.NoError(t, err)
	assert.Len(t, contents.Text, maxBody)
	contents, err = read(t, session, "mynotes://artifacts/x")
	require.NoError(t, err)
	assert.Len(t, contents.Blob, maxBody)
	assert.False(t, search().IsError)

	size = maxBody + 1
	for _, uri := range []string{"mynotes://notes/x/markdown", "mynotes://artifacts/x"} {
		_, err := read(t, session, uri)
		require.Error(t, err, uri)
		assert.Contains(t, err.Error(), "1 MiB", uri)
	}
	result := search()
	assert.True(t, result.IsError)
	assert.Contains(t, callText(t, result), "1 MiB")
}

func TestAuthenticationErrors(t *testing.T) {
	f := newFixture(t, true)

	session := connect(t, "-url", f.url)
	_, err := read(t, session, "mynotes://tags")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "requires authentication; set MYNOTES_TOKEN_FILE")

	tokenFile := f.tokenFile(t)
	records, err := f.store.List()
	require.NoError(t, err)
	_, err = f.store.Revoke(records[0].Slug)
	require.NoError(t, err)
	session = connect(t, "-url", f.url, "-token-file", tokenFile)
	_, err = read(t, session, "mynotes://tags")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "expired or revoked; run mynotes-token login")
	assert.NotContains(t, err.Error(), f.secret)
	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "search_notes", Arguments: map[string]any{"q": "x"}})
	require.NoError(t, err)
	assert.True(t, result.IsError)
	assert.Contains(t, callText(t, result), "expired or revoked")
	assert.NotContains(t, callText(t, result), f.secret)
}

func TestUnauthenticatedAgainstOpenServer(t *testing.T) {
	f := newFixture(t, false)
	session := connect(t, "-url", f.url)
	contents, err := read(t, session, "mynotes://notes/"+f.slug)
	require.NoError(t, err)
	assert.Contains(t, contents.Text, f.content)
}

func TestServerDown(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	server.Close()
	session := connect(t, "-url", server.URL)
	_, err := read(t, session, "mynotes://tags")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "request failed")
	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "search_notes", Arguments: map[string]any{"q": "x"}})
	require.NoError(t, err)
	assert.True(t, result.IsError)
}

func TestCompletion(t *testing.T) {
	f := newFixture(t, true)
	session := connect(t, "-url", f.url, "-token-file", f.tokenFile(t))
	complete := func(uri, argument, value string) []string {
		result, err := session.Complete(context.Background(), &mcp.CompleteParams{
			Ref:      &mcp.CompleteReference{Type: "ref/resource", URI: uri},
			Argument: mcp.CompleteParamsArgument{Name: argument, Value: value},
		})
		require.NoError(t, err)
		return result.Completion.Values
	}
	assert.Equal(t, []string{"work", "workshop"}, complete(notesTemplate, "tag", "wo"))
	assert.Equal(t, []string{"workshop"}, complete(notesTemplate, "tag", "works"))
	assert.Empty(t, complete(notesTemplate, "sort", ""))
	assert.Empty(t, complete("mynotes://notes/{slug}", "slug", ""))
}

func TestCapabilities(t *testing.T) {
	session := connect(t)
	initialized := session.InitializeResult()
	assert.Equal(t, "mynotes-mcp", initialized.ServerInfo.Name)
	capabilities := initialized.Capabilities
	require.NotNil(t, capabilities.Resources)
	assert.False(t, capabilities.Resources.Subscribe)
	assert.False(t, capabilities.Resources.ListChanged)
	require.NotNil(t, capabilities.Tools)
	assert.False(t, capabilities.Tools.ListChanged)
	assert.NotNil(t, capabilities.Completions)
	// Logging is deprecated in the SDK's Go API, so check the wire form.
	wire, err := json.Marshal(capabilities)
	require.NoError(t, err)
	assert.NotContains(t, string(wire), `"logging"`)
	assert.Nil(t, capabilities.Prompts)
}

func TestStartup(t *testing.T) {
	t.Setenv("MYNOTES_URL", "")
	t.Setenv("MYNOTES_TOKEN_FILE", "")
	var stdout bytes.Buffer
	require.NoError(t, run(context.Background(), []string{"-help"}, &stdout, nil))
	assert.Contains(t, stdout.String(), "Usage: mynotes-mcp")

	empty := filepath.Join(t.TempDir(), "empty")
	require.NoError(t, os.WriteFile(empty, nil, 0o600))
	for _, args := range [][]string{
		{"-url", "http://example.com"},
		{"-url", "not a url"},
		{"-token-file", filepath.Join(t.TempDir(), "missing")},
		{"-token-file", empty},
		{"-token-file", ""},
		{"extra"},
	} {
		stdout.Reset()
		err := run(context.Background(), args, &stdout, nil)
		assert.Error(t, err, fmt.Sprint(args))
		assert.Empty(t, stdout.String(), fmt.Sprint(args))
	}

	t.Setenv("MYNOTES_TOKEN_FILE", empty)
	_, _, err := configure(nil)
	assert.Error(t, err, "the environment's token file is read too")
}

func TestServerErrors(t *testing.T) {
	const secret = "review-test-secret"
	longError := strings.Repeat("e", 5000)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/tags":
			// A server or proxy echoing the credential back.
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"` + r.Header.Get("Authorization") + `"}`))
		case "/api/v1/notes/plain":
			w.Header().Set("Content-Type", "text/plain")
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte("upstream saw " + r.Header.Get("Authorization")))
		case "/api/v1/notes/long":
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"` + longError + `"}`))
		case "/api/v1/notes/huge":
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"` + strings.Repeat("h", maxBody) + `"}`))
		case "/api/v1/notes/empty/download-markdown":
			w.Header().Set("Content-Type", "text/markdown")
		default:
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"search failed for ` + r.Header.Get("Authorization") + `"}`))
		}
	}))
	defer server.Close()
	tokenFile := filepath.Join(t.TempDir(), "token")
	require.NoError(t, os.WriteFile(tokenFile, []byte(secret), 0o600))
	session := connect(t, "-url", server.URL, "-token-file", tokenFile)

	for uri, want := range map[string]string{
		"mynotes://tags":        "HTTP 500: Bearer [token]",
		"mynotes://notes/plain": "HTTP 502: upstream saw Bearer [token]",
		"mynotes://notes/long":  "HTTP 500: " + longError,
	} {
		_, err := read(t, session, uri)
		require.Error(t, err, uri)
		assert.Contains(t, err.Error(), want, uri)
		assert.NotContains(t, err.Error(), secret, uri)
	}
	contents, err := read(t, session, "mynotes://notes/empty/markdown")
	require.NoError(t, err)
	assert.Equal(t, "text/markdown", contents.MIMEType)
	assert.Empty(t, contents.Text)
	assert.NotNil(t, contents.Blob, "an empty body arrives as an empty blob, not as neither")

	_, err = read(t, session, "mynotes://notes/huge")
	require.Error(t, err)
	assert.NotContains(t, err.Error(), "hhhh", "an error body over the cap is not shown, not even in part")

	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "search_notes", Arguments: map[string]any{"q": "x"}})
	require.NoError(t, err)
	assert.True(t, result.IsError)
	assert.Contains(t, callText(t, result), "search failed for Bearer [token]")
	assert.NotContains(t, callText(t, result), secret)
}

func TestSearchJSONIsPassedThrough(t *testing.T) {
	const body = " { \"notes\" : [], \"total\" : 0 }\n"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()
	session := connect(t, "-url", server.URL)
	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "search_notes", Arguments: map[string]any{"q": "x"}})
	require.NoError(t, err)
	assert.Equal(t, body, callText(t, result))
	assert.Equal(t, map[string]any{"notes": []any{}, "total": float64(0)}, result.StructuredContent)
}

func TestErrorField(t *testing.T) {
	for body, want := range map[string]string{
		`{"error":"primary"}`:                             "primary",
		`{"error_message":"secondary"}`:                   "secondary",
		`{"error":"primary","error_message":"secondary"}`: "primary",
		`{"error":"primary","error_message":123}`:         "primary",
		`{"error":123,"error_message":"secondary"}`:       "secondary",
		`{"error":"","error_message":"secondary"}`:        "secondary",
		`{"message":"neither"}`:                           "",
		`not json`:                                        "",
		`["error"]`:                                       "",
	} {
		assert.Equal(t, want, errorField([]byte(body)), body)
	}
}
