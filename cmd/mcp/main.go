// Command mcp is a stdio Model Context Protocol server for the MyNotes API.
//
// It is an HTTP client of a running MyNotes server, like mynotes-cli, and
// exposes exactly the bearer-protected API routes an API token can reach. The
// contract is ../mysuite/spec/mcp-server.md; read it before changing what is
// exposed or how.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"runtime/debug"
	"slices"
	"strings"
	"syscall"
	"unicode"
	"unicode/utf8"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/mikaelstaldal/mynotes/internal/clihttp"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const usage = `Usage: mynotes-mcp [flags]

A Model Context Protocol server on stdin/stdout, for an MCP client to start as a
subprocess. It reads the MyNotes API over HTTP, exposing what an API token can reach.

Flags:
  -help             Print help and exit successfully
  -url URL          Server base URL, including optional path (default MYNOTES_URL or http://127.0.0.1:8080)
  -token-file PATH  Read API token from a file (default MYNOTES_TOKEN_FILE)

Without -token-file or MYNOTES_TOKEN_FILE, no Authorization header is sent.
HTTP is allowed only for literal loopback addresses; remote servers require HTTPS.
Redirects and environment HTTP proxies are disabled.

Resources:
  mynotes://tags                          all tags
  mynotes://notes{?tag*,sort,order,limit,offset}
                                          browse notes
  mynotes://notes/{slug}                  one note, as JSON
  mynotes://notes/{slug}/markdown         one note, as Markdown
  mynotes://artifacts/{sha256}            an image or other embedded artifact

Tools:
  search_notes                            full-text or title-prefix search
`

// maxBody is the cap on every response body read, resource or tool
// (mcp-server.md §2.4). A body over it is refused, never truncated.
const maxBody = 1 << 20

const notesTemplate = "mynotes://notes{?tag*,sort,order,limit,offset}"

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer cancel()
	if err := run(ctx, os.Args[1:], os.Stdout, &mcp.StdioTransport{}); err != nil {
		fmt.Fprintln(os.Stderr, "mynotes-mcp:", err)
		os.Exit(1)
	}
}

// run parses the flags and serves MCP on transport until the client
// disconnects. stdout receives only -help output; the transport owns the
// process's real stdout.
func run(ctx context.Context, args []string, stdout io.Writer, transport mcp.Transport) error {
	c, help, err := configure(args)
	if help {
		_, err := io.WriteString(stdout, usage)
		return err
	}
	if err != nil {
		return err
	}
	return newServer(c).Run(ctx, transport)
}

// configure reads the flags and the token file, failing only on bad
// configuration. An unreachable server is reported per request instead.
func configure(args []string) (*client, bool, error) {
	flags := flag.NewFlagSet("mynotes-mcp", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	base := flags.String("url", clihttp.URLDefault(), "server base URL")
	tokenFile := flags.String("token-file", os.Getenv("MYNOTES_TOKEN_FILE"), "token file")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil, true, nil
		}
		return nil, false, fmt.Errorf("%w\n%s", err, usage)
	}
	if flags.NArg() != 0 {
		return nil, false, fmt.Errorf("unexpected argument %q\n%s", flags.Arg(0), usage)
	}
	endpoint, err := clihttp.ParseBaseURL(*base)
	if err != nil {
		return nil, false, err
	}
	tokenFileProvided := false
	flags.Visit(func(f *flag.Flag) {
		if f.Name == "token-file" {
			tokenFileProvided = true
		}
	})
	if tokenFileProvided && *tokenFile == "" {
		return nil, false, errors.New("-token-file must specify a nonempty path")
	}
	token := ""
	if *tokenFile != "" {
		if token, err = readToken(*tokenFile); err != nil {
			return nil, false, err
		}
	}
	return &client{base: endpoint, token: token, http: clihttp.NewClient()}, false, nil
}

// readToken applies mynotes-cli's token-file rules.
func readToken(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("read token: %w", err)
	}
	defer func() { _ = file.Close() }()
	tokenBytes, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil {
		return "", fmt.Errorf("read token: %w", err)
	}
	if len(tokenBytes) > 4096 {
		return "", errors.New("token input is too large")
	}
	token := strings.TrimSpace(string(tokenBytes))
	if token == "" || strings.IndexFunc(token, func(c rune) bool { return unicode.IsSpace(c) || unicode.IsControl(c) }) >= 0 {
		return "", errors.New("token input must contain one token")
	}
	return token, nil
}

func version() string {
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, setting := range info.Settings {
			if setting.Key == "vcs.revision" {
				return setting.Value
			}
		}
	}
	return "devel"
}

func newServer(c *client) *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: "mynotes-mcp", Version: version()}, &mcp.ServerOptions{
		Instructions: "Read-only access to a MyNotes server. Browse with the mynotes:// resources; " +
			"use the search_notes tool for full-text or title-prefix search.",
		// No subscriptions, no list_changed, no logging (mcp-server.md §2.2).
		Capabilities:      &mcp.ServerCapabilities{Resources: &mcp.ResourceCapabilities{}, Tools: &mcp.ToolCapabilities{}},
		CompletionHandler: c.complete,
	})
	server.AddResource(&mcp.Resource{URI: "mynotes://tags", Name: "tags", MIMEType: "application/json",
		Description: "All tags, with note counts."}, c.read)
	server.AddResource(&mcp.Resource{URI: "mynotes://notes", Name: "notes", MIMEType: "application/json",
		Description: "The first page of notes, most recently updated first."}, c.read)
	server.AddResourceTemplate(&mcp.ResourceTemplate{URITemplate: notesTemplate, Name: "notes-page", MIMEType: "application/json",
		Description: "A page of notes. tag repeats and filters to notes carrying every tag; sort is updated, created or title; " +
			"order is asc or desc; limit is 1-200 (default 50)."}, c.read)
	server.AddResourceTemplate(&mcp.ResourceTemplate{URITemplate: "mynotes://notes/{slug}", Name: "note", MIMEType: "application/json",
		Description: "One note, with its Markdown content and tags."}, c.read)
	server.AddResourceTemplate(&mcp.ResourceTemplate{URITemplate: "mynotes://notes/{slug}/markdown", Name: "note-markdown", MIMEType: "text/markdown",
		Description: "One note as a Markdown document."}, c.read)
	server.AddResourceTemplate(&mcp.ResourceTemplate{URITemplate: "mynotes://artifacts/{sha256}", Name: "artifact",
		Description: "An artifact embedded in a note, such as an image, by its SHA-256."}, c.read)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "search_notes",
		InputSchema: searchNotesSchema(),
		Description: "Search notes. Full-text over title and content, ordered by relevance; with titlePrefix, q matches the start of the title instead, ordered by title.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: new(false)},
	}, c.searchNotes)
	return server
}

// client is an HTTP client of one MyNotes server.
type client struct {
	base  *url.URL
	token string
	http  *http.Client
}

// apiError is a non-2xx response.
type apiError struct {
	status  int
	message string
}

func (e *apiError) Error() string { return e.message }

// get reads one API resource, refusing a body over maxBody.
func (c *client) get(ctx context.Context, resource string, query url.Values) (contentType string, body []byte, err error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, clihttp.APIURL(c.base, resource, query), nil)
	if err != nil {
		return "", nil, err
	}
	if c.token != "" {
		request.Header.Set("Authorization", "Bearer "+c.token)
	}
	request.Header.Set("Accept", "*/*")
	response, err := c.http.Do(request)
	if err != nil {
		return "", nil, errors.New(c.redact("request failed: " + err.Error()))
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", nil, c.statusError(response)
	}
	body, err = io.ReadAll(io.LimitReader(response.Body, maxBody+1))
	if err != nil {
		return "", nil, fmt.Errorf("read response: %w", err)
	}
	if len(body) > maxBody {
		return "", nil, fmt.Errorf("response exceeds the %d-byte (1 MiB) limit", maxBody)
	}
	// A server or proxy echoing the Authorization header must not put the
	// secret in front of the client (mcp-server.md §2.1). Error text is
	// redacted, but a successful body is refused whole: its bytes are passed
	// through unchanged or not at all.
	if c.containsToken(body) {
		return "", nil, errors.New("the response contains the API token, so it is not passed on")
	}
	return response.Header.Get("Content-Type"), body, nil
}

func (c *client) statusError(response *http.Response) error {
	switch {
	case response.StatusCode == http.StatusUnauthorized && c.token != "":
		return &apiError{response.StatusCode, "the API token is expired or revoked; run mynotes-token login"}
	case response.StatusCode == http.StatusUnauthorized:
		return &apiError{response.StatusCode, "the server requires authentication; set MYNOTES_TOKEN_FILE or pass -token-file"}
	case response.StatusCode == http.StatusForbidden:
		return &apiError{response.StatusCode, "outside this token's scope"}
	}
	// The error body is held to the same cap as any other: its error field is
	// carried whole or not at all, never cut short. The API's own errors use
	// `error`; ogen's request-decoding errors (a bad query parameter) use
	// `error_message`.
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxBody+1))
	message := fmt.Sprintf("HTTP %d", response.StatusCode)
	switch detail := errorField(raw); {
	case err != nil || len(raw) > maxBody:
	case detail != "":
		message += ": " + detail
	case len(raw) <= 1024 && utf8.Valid(raw) && strings.TrimSpace(string(raw)) != "":
		// Not the API's error shape, perhaps a proxy's; short enough to show whole.
		message += ": " + strings.TrimSpace(string(raw))
	}
	return &apiError{response.StatusCode, c.redact(message)}
}

// errorField returns the first of `error` and `error_message` that is a
// nonempty string. Each is decoded on its own, so a field of another type
// cannot hide the other.
func errorField(raw []byte) string {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return ""
	}
	for _, name := range []string{"error", "error_message"} {
		var value string
		if json.Unmarshal(fields[name], &value) == nil && value != "" {
			return value
		}
	}
	return ""
}

// containsToken reports whether body carries the token, either as its bytes
// or, in JSON, as a string that decodes to it: `\u0072…` is the same secret to
// anything that parses the body, including this server's own decoding.
func (c *client) containsToken(body []byte) bool {
	if c.token == "" {
		return false
	}
	if bytes.Contains(body, []byte(c.token)) {
		return true
	}
	var value any
	if json.Unmarshal(body, &value) != nil {
		return false
	}
	var walk func(any) bool
	walk = func(v any) bool {
		switch v := v.(type) {
		case string:
			return strings.Contains(v, c.token)
		case []any:
			return slices.ContainsFunc(v, walk)
		case map[string]any:
			for key, field := range v {
				if strings.Contains(key, c.token) || walk(field) {
					return true
				}
			}
		}
		return false
	}
	return walk(value)
}

// redact removes the token from text that came from elsewhere — a server or
// proxy echoing the Authorization header must not put it in front of the
// client (mcp-server.md §2.1).
func (c *client) redact(text string) string {
	if c.token == "" {
		return text
	}
	return strings.ReplaceAll(text, c.token, "[token]")
}

// refuse rejects a resource URI this server will not forward. It uses the
// internal-error code, not invalid params: go-sdk v1.8.0 gives "Resource not
// found" the invalid-params code, and a client that shows every -32602 as not
// found would hide the message, which is what tells a model to use the search
// tool (mcp-server.md §2.5).
func refuse(format string, args ...any) error {
	return &jsonrpc.Error{Code: jsonrpc.CodeInternalError, Message: fmt.Sprintf(format, args...)}
}

// target is the API request a resource URI names.
type target struct {
	resource string
	query    url.Values
	blob     bool // always a blob, whatever the response (mcp-server.md §2.4)
}

// resolve maps a resource URI to its API request. The SDK has already chosen
// this server by matching a template, but its matcher neither extracts
// reordered or repeated query parameters nor rejects unknown ones, so the URI
// is parsed here (mcp-server.md §3).
func resolve(raw string) (target, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "mynotes" || u.Opaque != "" || u.User != nil || u.Fragment != "" {
		return target{}, refuse("invalid resource URI %q", raw)
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return target{}, refuse("invalid query in %q", raw)
	}
	var segments []string
	if path := strings.TrimPrefix(u.EscapedPath(), "/"); path != "" {
		for _, escaped := range strings.Split(path, "/") {
			segment, err := url.PathUnescape(escaped)
			if err != nil || segment == "" {
				return target{}, refuse("invalid resource URI %q", raw)
			}
			segments = append(segments, segment)
		}
	}
	noQuery := func(t target) (target, error) {
		if u.RawQuery != "" || u.ForceQuery {
			return target{}, refuse("%q takes no query parameters", raw)
		}
		return t, nil
	}
	switch {
	case u.Host == "tags" && len(segments) == 0:
		return noQuery(target{resource: "/tags"})
	case u.Host == "notes" && len(segments) == 0:
		for key, values := range query {
			switch key {
			case "tag":
			case "sort", "order", "limit", "offset":
				if len(values) != 1 {
					return target{}, refuse("%s may appear only once", key)
				}
			default:
				return target{}, refuse("unknown query parameter %q; use the search_notes tool to search", key)
			}
		}
		return target{resource: "/notes", query: query}, nil
	case u.Host == "notes" && len(segments) == 1:
		return noQuery(target{resource: "/notes/" + url.PathEscape(segments[0])})
	case u.Host == "notes" && len(segments) == 2 && segments[1] == "markdown":
		return noQuery(target{resource: "/notes/" + url.PathEscape(segments[0]) + "/download-markdown"})
	case u.Host == "artifacts" && len(segments) == 1:
		return noQuery(target{resource: "/artifacts/" + url.PathEscape(segments[0]), blob: true})
	}
	return target{}, mcp.ResourceNotFoundError(raw)
}

func (c *client) read(ctx context.Context, request *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
	uri := request.Params.URI
	t, err := resolve(uri)
	if err != nil {
		return nil, err
	}
	contentType, body, err := c.get(ctx, t.resource, t.query)
	if err != nil {
		if apiErr, ok := errors.AsType[*apiError](err); ok && apiErr.status == http.StatusNotFound {
			return nil, mcp.ResourceNotFoundError(uri)
		}
		return nil, &jsonrpc.Error{Code: jsonrpc.CodeInternalError, Message: err.Error()}
	}
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		mediaType = "application/octet-stream"
	}
	contents := &mcp.ResourceContents{URI: uri, MIMEType: mediaType}
	textual := strings.HasPrefix(mediaType, "text/") || mediaType == "application/json"
	// go-sdk v1.8.0 drops an empty text field from the wire but keeps an empty,
	// non-nil blob, so an empty body is always an empty blob (mcp-server.md §2.4).
	if !t.blob && textual && utf8.Valid(body) && len(body) > 0 {
		contents.Text = string(body)
	} else {
		contents.Blob = append([]byte{}, body...)
	}
	return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{contents}}, nil
}

type searchNotesInput struct {
	Q           string   `json:"q" jsonschema:"search text, 1-200 characters"`
	TitlePrefix bool     `json:"titlePrefix,omitempty" jsonschema:"match q as a case-insensitive prefix of the title instead of full-text search"`
	Tag         []string `json:"tag,omitempty" jsonschema:"tag slugs; a note must carry every one"`
	Limit       *int     `json:"limit,omitempty" jsonschema:"page size, 1-200, default 50"`
	Offset      *int     `json:"offset,omitempty" jsonschema:"number of results to skip"`
}

// searchNotesSchema is the inferred schema with tag typed as an array: the
// inference allows null for any slice, and the contract types list arguments
// as JSON arrays (mcp-server.md §2.3). Unknown arguments stay refused.
func searchNotesSchema() *jsonschema.Schema {
	schema, err := jsonschema.For[searchNotesInput](nil)
	if err != nil {
		panic(err)
	}
	schema.Properties["tag"].Types = nil
	schema.Properties["tag"].Type = "array"
	return schema
}

func (c *client) searchNotes(ctx context.Context, _ *mcp.CallToolRequest, in searchNotesInput) (*mcp.CallToolResult, any, error) {
	query := url.Values{"q": {in.Q}}
	if in.TitlePrefix {
		query.Set("titlePrefix", "true")
	}
	for _, tag := range in.Tag {
		query.Add("tag", tag)
	}
	if in.Limit != nil {
		query.Set("limit", fmt.Sprint(*in.Limit))
	}
	if in.Offset != nil {
		query.Set("offset", fmt.Sprint(*in.Offset))
	}
	_, body, err := c.get(ctx, "/notes", query)
	if err != nil {
		return nil, nil, err
	}
	// The text block is the server's bytes; left unset, the SDK would fill it
	// by re-marshalling the structured output.
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(body)}}}, json.RawMessage(body), nil
}

// complete offers tag slugs for the notes template's tag argument, and nothing
// for any other argument (mcp-server.md §2.6).
func (c *client) complete(ctx context.Context, request *mcp.CompleteRequest) (*mcp.CompleteResult, error) {
	result := &mcp.CompleteResult{Completion: mcp.CompletionResultDetails{Values: []string{}}}
	ref := request.Params.Ref
	if ref == nil || ref.Type != "ref/resource" || ref.URI != notesTemplate || request.Params.Argument.Name != "tag" {
		return result, nil
	}
	_, body, err := c.get(ctx, "/tags", nil)
	if err != nil {
		return nil, &jsonrpc.Error{Code: jsonrpc.CodeInternalError, Message: err.Error()}
	}
	var list struct {
		Tags []struct {
			Slug string `json:"slug"`
		} `json:"tags"`
	}
	if err := json.Unmarshal(body, &list); err != nil {
		return nil, &jsonrpc.Error{Code: jsonrpc.CodeInternalError, Message: "invalid tag list from server"}
	}
	for _, tag := range list.Tags {
		if strings.HasPrefix(tag.Slug, request.Params.Argument.Value) {
			result.Completion.Values = append(result.Completion.Values, tag.Slug)
		}
	}
	slices.Sort(result.Completion.Values)
	// The protocol caps a completion at 100 values.
	if len(result.Completion.Values) > 100 {
		result.Completion.Total = len(result.Completion.Values)
		result.Completion.HasMore = true
		result.Completion.Values = result.Completion.Values[:100]
	}
	return result, nil
}
