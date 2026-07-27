package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"runtime/debug"
	"strings"
	"syscall"
	"time"

	"github.com/mikaelstaldal/go-server-common/auth"
	"github.com/mikaelstaldal/go-server-common/csrf"
	"github.com/mikaelstaldal/go-server-common/httputil"
	commonweb "github.com/mikaelstaldal/go-server-common/web"
	"github.com/mikaelstaldal/mynotes/internal/api"
	"github.com/mikaelstaldal/mynotes/internal/demo"
	"github.com/mikaelstaldal/mynotes/internal/gdocs"
	"github.com/mikaelstaldal/mynotes/internal/handler"
	"github.com/mikaelstaldal/mynotes/internal/icons"
	"github.com/mikaelstaldal/mynotes/internal/repository"
	"github.com/mikaelstaldal/mynotes/internal/service"
	"github.com/mikaelstaldal/mynotes/web"
)

const databaseName = "mynotes.sqlite"

// maxRequestBody caps every request body. Raise it for endpoints that accept
// uploads, but keep a global ceiling to blunt memory-exhaustion attacks.
const maxRequestBody = 10 << 20 // 10 MiB

func main() {
	version := flag.Bool("version", false, "print version information and exit")
	port := flag.Int("port", 8080, "HTTP listen port")
	addr := flag.String("addr", "127.0.0.1", "bind address")
	dataDir := flag.String("data", "data", "data directory")
	publicURL := flag.String("public-url", "", "public-facing base URL for CSRF validation, e.g. https://example.com (defaults to http://<addr>:<port>)")
	basicAuthFile := flag.String("basic-auth-file", "", "enable HTTP basic auth using this htpasswd file (bcrypt only)")
	basicAuthRealm := flag.String("basic-auth-realm", "MyNotes", "realm for HTTP basic auth")
	gdocsClientID := flag.String("gdocs-client-id", "", "Google OAuth 2.0 Client ID; when set (with -gdocs-client-secret) runs a bulk Google Docs import instead of the server")
	gdocsClientSecret := flag.String("gdocs-client-secret", "", "Google OAuth 2.0 Client Secret")
	demoData := flag.Bool("demo", false, "fill the database with demo notes, artifacts, and tags, then exit")
	demoServer := flag.Bool("demo-server", false, "serve the web UI in demo mode: no database, no REST API — the browser stores everything locally (takes no -data)")
	demoBundle := flag.String("demo-bundle", "", "write a self-contained static demo bundle to this new directory and exit (takes no -data)")
	flag.Parse()

	if *version {
		printVersion()
		return
	}

	if *demoData {
		if err := runDemo(context.Background(), *dataDir); err != nil {
			log.Fatalf("%v", err)
		}
		return
	}

	// The two browser-demo modes never open a database, so a -data directory is
	// meaningless: reject it rather than silently ignoring it.
	if *demoBundle != "" || *demoServer {
		if flagWasSet("data") {
			log.Fatalf("-data cannot be combined with -demo-server or -demo-bundle: demo mode has no database")
		}
	}

	if *demoBundle != "" {
		if err := writeDemoBundle(context.Background(), *demoBundle, *publicURL); err != nil {
			log.Fatalf("%v", err)
		}
		return
	}

	if *gdocsClientID != "" && *gdocsClientSecret != "" {
		// Use -port as the OAuth callback port only when explicitly set;
		// otherwise 0 lets the OS pick a random free port.
		callbackPort := 0
		flag.Visit(func(f *flag.Flag) {
			if f.Name == "port" {
				callbackPort = *port
			}
		})
		if err := runGDocsImport(context.Background(), *gdocsClientID, *gdocsClientSecret, *dataDir, callbackPort); err != nil {
			log.Fatalf("%v", err)
		}
		return
	}

	if *port < 1 || *port > 65535 {
		log.Fatalf("invalid port: %d", *port)
	}

	if err := run(*addr, *port, *dataDir, *publicURL, *basicAuthFile, *basicAuthRealm, *demoServer); err != nil {
		log.Fatalf("%v", err)
	}
}

// flagWasSet reports whether the named flag was given on the command line, as
// opposed to holding its default value.
func flagWasSet(name string) bool {
	set := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == name {
			set = true
		}
	})
	return set
}

func runGDocsImport(ctx context.Context, clientID, clientSecret, dataDir string, callbackPort int) error {
	dbPath := filepath.Join(dataDir, databaseName)
	if err := repository.CreateDataDir(dbPath); err != nil {
		return err
	}
	db, err := repository.OpenDB(dbPath, 5000, "synchronous=NORMAL")
	if err != nil {
		return err
	}
	defer db.Close()

	noteRepo := repository.NewNoteRepository(db)
	tagRepo := repository.NewTagRepository(db)
	noteSvc := service.NewNoteService(noteRepo, tagRepo)

	cfg := gdocs.MakeConfig(clientID, clientSecret)
	tokenPath := filepath.Join(dataDir, "gdocs-token.json")
	tok, err := gdocs.Authenticate(ctx, cfg, tokenPath, callbackPort)
	if err != nil {
		return fmt.Errorf("authenticate with Google: %w", err)
	}

	drive := gdocs.NewClient(ctx, cfg, tok)
	imported, errs := gdocs.Run(ctx, drive, noteSvc, os.Stdout)

	fmt.Printf("\nImported %d note(s).", imported)
	if len(errs) > 0 {
		fmt.Printf(" %d failed:\n", len(errs))
		for _, e := range errs {
			fmt.Printf("  - %v\n", e)
		}
		return fmt.Errorf("%d import(s) failed", len(errs))
	}
	fmt.Println()
	return nil
}

// runDemo opens (creating if necessary) the database and fills it with a
// curated set of demo notes, artifacts, and tags, then returns. Like the Google
// Docs importer it is a one-shot batch mode that runs instead of the server.
func runDemo(ctx context.Context, dataDir string) error {
	dbPath := filepath.Join(dataDir, databaseName)
	if err := repository.CreateDataDir(dbPath); err != nil {
		return err
	}
	db, err := repository.OpenDB(dbPath, 5000, "synchronous=NORMAL")
	if err != nil {
		return err
	}
	defer db.Close()

	noteRepo := repository.NewNoteRepository(db)
	tagRepo := repository.NewTagRepository(db)
	artifactRepo := repository.NewArtifactRepository(db)
	noteSvc := service.NewNoteService(noteRepo, tagRepo)
	artifactSvc := service.NewArtifactService(artifactRepo)
	tagSvc := service.NewTagService(tagRepo)

	return demo.Run(ctx, noteSvc, artifactSvc, tagSvc, os.Stdout)
}

// writeDemoBundle assembles a self-contained static demo site in outDir and
// returns. The result is plain files: any web server that serves a directory
// can host it, and a service worker (web/static/demo-sw.js) stands in for the
// REST API, keeping every note, tag, and artifact in browser-local storage.
//
// outDir must not already exist, or must be an empty directory — the bundle is
// never merged into a populated directory, so a stale file from an earlier
// version cannot linger and no pre-existing content is overwritten.
//
// publicURL is honoured exactly as it is for the server: its path component
// becomes the page's <base href>, so a bundle destined for
// https://example.com/notes/ is built with -public-url https://example.com/notes.
func writeDemoBundle(ctx context.Context, outDir, publicURL string) error {
	if err := requireEmptyDir(outDir); err != nil {
		return err
	}
	basePath, err := basePathFromPublicURL(publicURL)
	if err != nil {
		return err
	}

	indexHTML, configScriptSrc, err := buildIndexHTML(basePath, serverConfig{Demo: true})
	if err != nil {
		return err
	}
	importMapHash, renderImportMapHash, err := importMapHashes()
	if err != nil {
		return err
	}
	// A static bundle has no server to set response headers, so the policy the
	// server would send travels in the page instead — the same technique the
	// render kit host page uses. frame-ancestors is omitted because browsers
	// ignore it in a meta element; a host that cares should send it as a header.
	indexHTML = injectMetaCSP(indexHTML, commonCSP(importMapHash, renderImportMapHash)+configScriptSrc)

	seed, err := demo.BuildSeedJSON(ctx)
	if err != nil {
		return fmt.Errorf("build demo seed: %w", err)
	}

	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", outDir, err)
	}
	files := 0
	err = fs.WalkDir(web.Static, "static", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(path, "static")
		rel = strings.TrimPrefix(rel, "/")
		dest := filepath.Join(outDir, filepath.FromSlash(rel))
		if d.IsDir() {
			return os.MkdirAll(dest, 0o755)
		}
		data, err := fs.ReadFile(web.Static, path)
		if err != nil {
			return err
		}
		if rel == "index.html" {
			data = indexHTML
		}
		files++
		return os.WriteFile(dest, data, 0o644)
	})
	if err != nil {
		return fmt.Errorf("write bundle: %w", err)
	}

	if err := os.WriteFile(filepath.Join(outDir, demo.SeedFileName), seed, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", demo.SeedFileName, err)
	}

	// Deep links (/notes/my-note) are client-side routes. The service worker
	// rewrites them to the shell once it is installed, but the first visit to
	// one is the host's to answer — and many static hosts serve 404.html for an
	// unknown path, so a copy of the shell under that name makes them work
	// there too.
	if err := os.WriteFile(filepath.Join(outDir, "404.html"), indexHTML, 0o644); err != nil {
		return fmt.Errorf("write 404.html: %w", err)
	}

	fmt.Printf("Wrote a static MyNotes demo (%d files) to %s\n", files+2, outDir)
	fmt.Printf("Serve that directory with any web server; it needs no backend.\n")
	if basePath == "/" {
		fmt.Printf("It is built for the origin root — to deploy it under a path, rebuild with -public-url.\n")
	} else {
		fmt.Printf("It is built for the path %s (from -public-url).\n", basePath)
	}
	fmt.Printf("A service worker is required, so serve it over HTTPS or from localhost.\n")
	return nil
}

// requireEmptyDir accepts a path that does not exist or is an empty directory,
// and rejects anything else.
func requireEmptyDir(dir string) error {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("check %s: %w", dir, err)
	}
	if len(entries) > 0 {
		return fmt.Errorf("%s already exists and is not empty; pass a new directory", dir)
	}
	return nil
}

// injectMetaCSP splices a Content-Security-Policy meta element into the page's
// <head>, immediately after the charset declaration so it precedes every script
// and stylesheet the policy governs.
func injectMetaCSP(html []byte, csp string) []byte {
	const charset = `<meta charset="UTF-8">`
	meta := charset + "\n    " + `<meta http-equiv="Content-Security-Policy" content="` + csp + `">`
	return bytes.Replace(html, []byte(charset), []byte(meta), 1)
}

func run(addr string, port int, dataDir, publicURL, basicAuthFile, basicAuthRealm string, demoMode bool) error {
	// --- storage -----------------------------------------------------------
	// Demo mode has no storage at all: the browser is the backend (see
	// web/ts/demo/), so no database is opened and no API routes are mounted.
	var h *handler.Handler
	var ogenServer http.Handler
	if !demoMode {
		dbPath := filepath.Join(dataDir, databaseName)
		if err := repository.CreateDataDir(dbPath); err != nil {
			return err
		}
		db, err := repository.OpenDB(dbPath, 5000, "synchronous=NORMAL")
		if err != nil {
			return err
		}
		defer db.Close()
		conns := runtime.GOMAXPROCS(0)
		db.SetMaxOpenConns(conns)
		db.SetMaxIdleConns(conns)

		// --- wiring: repository → service → handler ------------------------
		noteRepo := repository.NewNoteRepository(db)
		tagRepo := repository.NewTagRepository(db)
		noteSvc := service.NewNoteService(noteRepo, tagRepo)
		artifactRepo := repository.NewArtifactRepository(db)
		artifactSvc := service.NewArtifactService(artifactRepo)
		tagSvc := service.NewTagService(tagRepo)
		h = handler.New(noteSvc, artifactSvc, tagSvc)

		ogenServer, err = api.NewServer(h, api.WithPathPrefix("/api/v1"))
		if err != nil {
			return fmt.Errorf("create API server: %w", err)
		}
	}

	// --- HTTP routing ------------------------------------------------------
	basePath, err := basePathFromPublicURL(publicURL)
	if err != nil {
		return err
	}

	// MyMail integration: when this instance is deployed under a path (e.g.
	// https://example.com/mynotes), a MyMail at /mymail on the same origin is
	// assumed, and its base URL is handed to the web UI through an injected
	// inline <script>. The UI shows its "Send as email" action only when this
	// is set. Demo mode has no server to relay the message, so it is never
	// offered there.
	cfg := serverConfig{Demo: demoMode}
	if !demoMode {
		cfg.MymailURL = deriveMymailURL(publicURL)
	}

	indexHTML, configScriptSrc, err := buildIndexHTML(basePath, cfg)
	if err != nil {
		return err
	}
	if cfg.MymailURL != "" {
		log.Printf("MyMail integration enabled, using %s", cfg.MymailURL)
	}

	importMapHash, renderImportMapHash, err := importMapHashes()
	if err != nil {
		return err
	}
	renderHTML, err := fs.ReadFile(web.Static, "static/render/index.html")
	if err != nil {
		return fmt.Errorf("read render/index.html: %w", err)
	}

	cspCommon := commonCSP(importMapHash, renderImportMapHash)
	csp := cspCommon + configScriptSrc + "; frame-ancestors 'none'"
	// The render kit is an embeddable page (see web/static/render/index.html), so
	// it — and only it — may be framed by a sibling app deployed on this same
	// origin. Cross-origin framing stays blocked, and the app's own pages remain unframeable.
	renderCSP := cspCommon + "; frame-ancestors 'self'"

	mux := http.NewServeMux()
	if demoMode {
		// The demo's initial content, produced by the same seeding pipeline the
		// -demo flag runs. The service worker fetches it once, on first load.
		seed, err := demo.BuildSeedJSON(context.Background())
		if err != nil {
			return fmt.Errorf("build demo seed: %w", err)
		}
		mux.Handle("GET /"+demo.SeedFileName, seedHandler(seed))
		// Nothing here answers the REST API — the service worker does. Claiming
		// the prefix anyway means a request that escapes the worker fails as an
		// API error rather than falling through to the SPA shell, where the
		// client would try to parse a page of HTML as JSON.
		mux.HandleFunc("/api/v1/", demoAPIUnavailable)
		log.Printf("demo mode: no database; the browser stores all data locally")
	} else {
		// Artifact GET is a raw handler so it can set a dynamic Content-Type header;
		// the more-specific method+path pattern takes priority over the ogen prefix.
		// Wrapped with the same middleware as the ogen server (panic recovery, gzip)
		// so it gets consistent failure behaviour; ServeArtifact overrides the
		// no-store Cache-Control set by WithMiddleware with its own immutable policy.
		mux.Handle("GET /api/v1/artifacts/{sha256}", handler.WithMiddleware(http.HandlerFunc(h.ServeArtifact)))
		// Lucide icons embedded in note content render as
		// <img src="/api/v1/icons/lucide/{name}">. Served as a static, public,
		// immutable SVG asset (see internal/icons); like the artifact GET above, this
		// specific pattern wins over the "/api/v1/" ogen handler. The "lucide" segment
		// namespaces the set, leaving room for other icon sets in future.
		mux.Handle("GET /api/v1/icons/lucide/{name}", handler.WithMiddleware(icons.Handler()))
		mux.Handle("/api/v1/", handler.WithMiddleware(ogenServer))
	}
	// The render kit's host page. Registered explicitly because the generic
	// static handler cannot serve it: http.FileServer canonicalises
	// "/render/index.html" to "/render/", which — being a directory — falls
	// through to the SPA shell, leaving the page unreachable. Its sibling assets
	// (note.css, host.js, ../vendor/*) need no such help.
	mux.Handle("GET /render/{$}", renderHandler(renderHTML, renderCSP))
	mux.HandleFunc("/", staticHandler(indexHTML))

	// --- middleware chain (outermost first) --------------------------------
	serverOrigin, err := csrf.ResolveServerOrigin(publicURL, addr, port)
	if err != nil {
		return err
	}
	var httpHandler http.Handler = mux
	httpHandler = csrf.Middleware(serverOrigin)(httpHandler)

	// Enable HSTS when the public URL is served over HTTPS (typically behind a
	// TLS-terminating proxy). Without a public URL we assume plain HTTP.
	hsts := ""
	if strings.HasPrefix(strings.ToLower(publicURL), "https://") {
		hsts = "max-age=31536000"
	}

	httpHandler = httputil.SecurityHeaders(httputil.SecurityHeadersOptions{
		CSP:            csp,
		ReferrerPolicy: "same-origin",
		HSTS:           hsts,
	})(httpHandler)
	if basicAuthFile != "" {
		htpasswd, err := auth.LoadHtpasswd(basicAuthFile)
		if err != nil {
			return fmt.Errorf("load htpasswd: %w", err)
		}
		httpHandler = htpasswd.Middleware(basicAuthRealm)(httpHandler)
		log.Printf("basic authentication enabled")
	}
	httpHandler = http.MaxBytesHandler(httpHandler, maxRequestBody)

	// --- server with graceful shutdown -------------------------------------
	serverAddr := fmt.Sprintf("%s:%d", addr, port)
	srv := &http.Server{
		Addr:              serverAddr,
		Handler:           httpHandler,
		ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      20 * time.Second,
		IdleTimeout:       time.Minute,
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		log.Println("shutting down...")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	log.Printf("starting server on %s", serverAddr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("server: %w", err)
	}
	return nil
}

// buildIndexHTML reads the embedded SPA shell and applies the two
// deployment-time rewrites: the <base href> for a subpath deployment, and the
// injected inline <script> carrying the server configuration. It returns the
// rewritten page plus the CSP script-src addition the injected script needs
// (empty when there is nothing to inject). Shared by the server and the static
// demo bundle writer so the two can never drift.
func buildIndexHTML(basePath string, cfg serverConfig) (html []byte, configScriptSrc string, err error) {
	html, err = fs.ReadFile(web.Static, "static/index.html")
	if err != nil {
		return nil, "", fmt.Errorf("read index.html: %w", err)
	}
	if basePath != "/" {
		html = bytes.ReplaceAll(html,
			[]byte(`<base href="/">`),
			[]byte(`<base href="`+basePath+`">`))
	}
	if script := cfg.script(); script != "" {
		configScriptSrc = " " + inlineScriptCSPHash(script)
		html = injectInlineScript(html, script)
	}
	return html, configScriptSrc, nil
}

// importMapHashes returns the CSP script-src source expressions for the two
// inline import maps in the embedded assets: the SPA shell's and the render
// kit host page's.
func importMapHashes() (indexHash, renderHash string, err error) {
	indexHash, err = commonweb.ImportMapCSPHash(web.Static)
	if err != nil {
		return "", "", fmt.Errorf("compute importmap CSP hash: %w", err)
	}
	// The render host page (see web/static/render/index.html) carries a second,
	// smaller import map. commonweb.ImportMapCSPHash only ever reads
	// static/index.html and returns a single hash, so this one is computed here.
	renderHash, err = importMapCSPHash(web.Static, "static/render/index.html")
	if err != nil {
		return "", "", fmt.Errorf("compute render importmap CSP hash: %w", err)
	}
	return indexHash, renderHash, nil
}

// commonCSP is the part of the Content-Security-Policy shared by the SPA shell
// and the render kit host page. Callers append the page-specific script-src
// additions and the frame-ancestors directive.
func commonCSP(importMapHash, renderImportMapHash string) string {
	return "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; " +
		"base-uri 'self'; form-action 'self'; object-src 'none'; script-src 'self' " +
		importMapHash + " " + renderImportMapHash
}

// demoAPIUnavailable answers any REST API request that reaches the server in
// demo mode, which only happens when the browser's service worker is not
// installed or not in control.
func demoAPIUnavailable(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusServiceUnavailable)
	_, _ = w.Write([]byte(`{"error":"demo mode: the in-browser backend is not running; reload the page"}`))
}

// seedHandler serves the demo seed document. It is regenerated on every server
// start and is not content-addressed, so it is revalidated rather than cached.
func seedHandler(seed []byte) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(seed)
	}
}

// importMapCSPHash returns the CSP script-src source expression for the inline
// import map in the named embedded HTML file, e.g.
// "'sha256-2dMPOkkMmKtAjCeEV6Gzv1oxQr4LXNRZ3gftHIzHZ0Y='".
//
// This mirrors commonweb.ImportMapCSPHash, which hardcodes static/index.html and
// so cannot reach the render host page's own import map. Computing the hash from
// the embedded bytes at startup keeps it in sync as the file evolves; the same
// value is additionally baked into the page's <meta> CSP (the only policy when a
// native client serves the page from application assets), and
// web/ts/render-kit.test.mjs pins the two together.
//
// Like the upstream helper this cuts on the first occurrence of the opening tag,
// so the file must not mention it earlier (e.g. in a comment).
func importMapCSPHash(staticFS fs.FS, name string) (string, error) {
	data, err := fs.ReadFile(staticFS, name)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", name, err)
	}
	_, after, found := strings.Cut(string(data), `<script type="importmap">`)
	if !found {
		return "", fmt.Errorf("importmap script tag not found in %s", name)
	}
	content, _, found := strings.Cut(after, "</script>")
	if !found {
		return "", fmt.Errorf("importmap closing tag not found in %s", name)
	}
	sum := sha256.Sum256([]byte(content))
	return "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'", nil
}

// basePathChars restricts the base path to unreserved URL characters plus the
// path separator. The path is spliced verbatim into the <base href> attribute
// of index.html, so anything that could terminate the attribute or the tag
// (quotes, angle brackets) — or otherwise change how the browser resolves the
// base — must be rejected rather than escaped.
var basePathChars = regexp.MustCompile(`^[A-Za-z0-9._~/-]+$`)

// basePathFromPublicURL extracts the URL path component and returns it with a
// trailing slash, e.g. "https://example.com/mynotes" → "/mynotes/". Returns
// "/" when the public URL is empty or has no meaningful path component, and an
// error when the path is unparseable or contains characters that are unsafe to
// splice into index.html.
func basePathFromPublicURL(publicURL string) (string, error) {
	if publicURL == "" {
		return "/", nil
	}
	u, err := url.Parse(publicURL)
	if err != nil {
		return "", fmt.Errorf("parse public URL %q: %w", publicURL, err)
	}
	p := u.Path
	if p == "" || p == "/" {
		return "/", nil
	}
	if !basePathChars.MatchString(p) {
		return "", fmt.Errorf("public URL path %q must contain only the characters A-Z a-z 0-9 . _ ~ - /", p)
	}
	// A leading "//" would make <base href> protocol-relative, re-pointing the
	// whole UI at another host.
	if !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") {
		return "", fmt.Errorf("public URL path %q must start with a single %q", p, "/")
	}
	if !strings.HasSuffix(p, "/") {
		p += "/"
	}
	return p, nil
}

// deriveSiblingURL returns the base URL of a sibling app served from the same
// origin, derived from publicURL by replacing its path with siblingPath.
// Returns the empty string if publicURL is empty or has no path segment — a
// MyNotes deployed at the origin root leaves no room for siblings, so nothing
// is assumed about them. Mirrors the same helper in MyCal.
func deriveSiblingURL(publicURL, siblingPath string) string {
	if publicURL == "" {
		return ""
	}
	u, err := url.Parse(publicURL)
	if err != nil || strings.Trim(u.Path, "/") == "" {
		return ""
	}
	u.Path = siblingPath
	u.RawQuery = ""
	u.Fragment = ""
	return u.String()
}

// deriveMymailURL returns the MyMail base URL derived from publicURL. The web
// UI posts to it to send a note as an email; being same-origin, the request is
// covered by the CSP's default-src 'self' and by MyMail's own CSRF check.
func deriveMymailURL(publicURL string) string {
	return deriveSiblingURL(publicURL, "/mymail")
}

// serverConfig is the deployment configuration handed to the web UI through an
// injected inline <script> (see web/ts/util/serverconfig.ts). Both fields are
// omitted when unset, so a plain root deployment injects nothing at all.
type serverConfig struct {
	// MymailURL is the base URL of the sibling MyMail instance, or "" when the
	// integration is not configured.
	MymailURL string `json:"mymailUrl,omitempty"`
	// Demo marks the backend-less demo build, where a service worker emulates
	// the REST API against browser-local storage.
	Demo bool `json:"demo,omitempty"`
}

// script returns an inline JS snippet that sets window.__serverConfig, or "" when
// there is nothing to configure. The snippet is spliced into index.html
// verbatim, so the values must not be able to terminate the surrounding
// <script> element. json.Marshal emits <, > and & as Unicode escapes (HTML
// escaping is on by default), which makes that impossible — do not replace it
// with an encoder that has SetEscapeHTML(false).
func (c serverConfig) script() string {
	if c == (serverConfig{}) {
		return ""
	}
	b, err := json.Marshal(c)
	if err != nil {
		return ""
	}
	return "window.__serverConfig=" + string(b) + ";"
}

// inlineScriptCSPHash returns the CSP script-src source expression for an inline
// script, e.g. "'sha256-2dMPOkkMmKtAjCeEV6Gzv1oxQr4LXNRZ3gftHIzHZ0Y='".
func inlineScriptCSPHash(script string) string {
	sum := sha256.Sum256([]byte(script))
	return "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
}

// injectInlineScript splices script into indexHTML as an inline <script> just
// before </head>. Returns indexHTML unchanged when script is empty.
func injectInlineScript(indexHTML []byte, script string) []byte {
	if script == "" {
		return indexHTML
	}
	return bytes.Replace(indexHTML, []byte("</head>"),
		[]byte("<script>"+script+"</script>\n</head>"), 1)
}

func printVersion() {
	fmt.Println("MyNotes")
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return
	}
	settings := make(map[string]string, len(info.Settings))
	for _, s := range info.Settings {
		settings[s.Key] = s.Value
	}
	if vcs, ok := settings["vcs"]; ok {
		fmt.Printf("%s ", vcs)
	}
	modified := settings["vcs.modified"] == "true"
	if rev, ok := settings["vcs.revision"]; ok {
		if modified {
			fmt.Printf("revision: %s (dirty)\n", rev)
		} else {
			fmt.Printf("revision: %s\n", rev)
		}
	}
	if t, ok := settings["vcs.time"]; ok {
		if parsedTime, err := time.Parse(time.RFC3339, t); err == nil {
			fmt.Printf("updated at: %s\n", parsedTime.Local().Format("2006-01-02 15:04:05"))
		} else {
			fmt.Printf("updated at: %s\n", t)
		}
	}
}

// renderHandler serves the render kit's host page at /render/. The page is
// content-free — a client pushes Markdown in through its JS API — so it is a
// static, unauthenticated asset like the icon route, and carries no note data.
// renderHandler serves the render kit's host page. It overrides the two framing
// headers set by the SecurityHeaders middleware so a same-origin embedder can
// frame this page; every other response keeps DENY / frame-ancestors 'none'.
// Browsers that honour frame-ancestors ignore X-Frame-Options, which has no
// same-origin-only value beyond SAMEORIGIN; both are set so either mechanism
// permits exactly same-origin framing.
func renderHandler(renderHTML []byte, renderCSP string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Content-Security-Policy", renderCSP)
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		_, _ = w.Write(renderHTML)
	}
}

// staticHandler serves embedded static files, falling back to index.html for
// any path that does not map to a real file. The fallback lets the frontend
// own client-side routing (deep links resolve to the SPA shell).
func staticHandler(indexHTML []byte) http.HandlerFunc {
	staticFS, err := fs.Sub(web.Static, "static")
	if err != nil {
		panic(fmt.Sprintf("web: sub static: %v", err))
	}
	staticHandler, err := httputil.StaticHandler(staticFS)
	if err != nil {
		panic(fmt.Sprintf("web: static handler: %v", err))
	}
	return func(w http.ResponseWriter, r *http.Request) {
		fsPath := strings.TrimPrefix(r.URL.Path, "/")
		if fsPath != "" && fsPath != "index.html" {
			if f, err := staticFS.Open(fsPath); err == nil {
				stat, statErr := f.Stat()
				_ = f.Close()
				if statErr == nil && !stat.IsDir() {
					w.Header().Set("Cache-Control", "no-cache")
					// StaticHandler adds Cache-Control, ETag, gzip and 304 handling.
					staticHandler.ServeHTTP(w, r)
					return
				}
			}
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(indexHTML)
	}
}
