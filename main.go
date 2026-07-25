package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
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

	if err := run(*addr, *port, *dataDir, *publicURL, *basicAuthFile, *basicAuthRealm); err != nil {
		log.Fatalf("%v", err)
	}
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

func run(addr string, port int, dataDir, publicURL, basicAuthFile, basicAuthRealm string) error {
	// --- storage -----------------------------------------------------------
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

	// --- wiring: repository → service → handler ----------------------------
	noteRepo := repository.NewNoteRepository(db)
	tagRepo := repository.NewTagRepository(db)
	noteSvc := service.NewNoteService(noteRepo, tagRepo)
	artifactRepo := repository.NewArtifactRepository(db)
	artifactSvc := service.NewArtifactService(artifactRepo)
	tagSvc := service.NewTagService(tagRepo)
	h := handler.New(noteSvc, artifactSvc, tagSvc)

	ogenServer, err := api.NewServer(h, api.WithPathPrefix("/api/v1"))
	if err != nil {
		return fmt.Errorf("create API server: %w", err)
	}

	// --- HTTP routing ------------------------------------------------------
	indexHTML, err := fs.ReadFile(web.Static, "static/index.html")
	if err != nil {
		return fmt.Errorf("read index.html: %w", err)
	}
	basePath, err := basePathFromPublicURL(publicURL)
	if err != nil {
		return err
	}
	if basePath != "/" {
		indexHTML = bytes.ReplaceAll(indexHTML,
			[]byte(`<base href="/">`),
			[]byte(`<base href="`+basePath+`">`))
	}
	importMapHash, err := commonweb.ImportMapCSPHash(web.Static)
	if err != nil {
		return fmt.Errorf("compute importmap CSP hash: %w", err)
	}
	// The render host page (see web/static/render/index.html) carries a second,
	// smaller import map. commonweb.ImportMapCSPHash only ever reads
	// static/index.html and returns a single hash, so this one is computed here.
	renderImportMapHash, err := importMapCSPHash(web.Static, "static/render/index.html")
	if err != nil {
		return fmt.Errorf("compute render importmap CSP hash: %w", err)
	}
	renderHTML, err := fs.ReadFile(web.Static, "static/render/index.html")
	if err != nil {
		return fmt.Errorf("read render/index.html: %w", err)
	}

	mux := http.NewServeMux()
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
	// The render kit's host page. Registered explicitly because the generic
	// static handler cannot serve it: http.FileServer canonicalises
	// "/render/index.html" to "/render/", which — being a directory — falls
	// through to the SPA shell, leaving the page unreachable. Its sibling assets
	// (note.css, host.js, ../vendor/*) need no such help.
	mux.Handle("GET /render/{$}", renderHandler(renderHTML))
	mux.HandleFunc("/", staticHandler(indexHTML))

	// --- middleware chain (outermost first) --------------------------------
	serverOrigin, err := csrf.ResolveServerOrigin(publicURL, addr, port)
	if err != nil {
		return err
	}
	var httpHandler http.Handler = mux
	httpHandler = csrf.Middleware(serverOrigin)(httpHandler)

	csp := "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; " +
		"frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; script-src 'self' " +
		importMapHash + " " + renderImportMapHash
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
func renderHandler(renderHTML []byte) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
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
