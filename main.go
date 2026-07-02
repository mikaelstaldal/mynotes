package main

import (
	"bytes"
	"context"
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
	"github.com/mikaelstaldal/mynotes/internal/gdocs"
	"github.com/mikaelstaldal/mynotes/internal/handler"
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
	flag.Parse()

	if *version {
		printVersion()
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
	if bp := basePathFromPublicURL(publicURL); bp != "/" {
		indexHTML = bytes.ReplaceAll(indexHTML,
			[]byte(`<base href="/">`),
			[]byte(`<base href="`+bp+`">`))
	}
	importMapHash, err := commonweb.ImportMapCSPHash(web.Static)
	if err != nil {
		return fmt.Errorf("compute importmap CSP hash: %w", err)
	}

	mux := http.NewServeMux()
	// Artifact GET is a raw handler so it can set a dynamic Content-Type header;
	// the more-specific method+path pattern takes priority over the ogen prefix.
	// Wrapped with the same middleware as the ogen server (panic recovery, gzip)
	// so it gets consistent failure behaviour; ServeArtifact overrides the
	// no-store Cache-Control set by WithMiddleware with its own immutable policy.
	mux.Handle("GET /api/v1/artifacts/{sha256}", handler.WithMiddleware(http.HandlerFunc(h.ServeArtifact)))
	mux.Handle("/api/v1/", handler.WithMiddleware(ogenServer))
	mux.HandleFunc("/", staticHandler(indexHTML))

	// --- middleware chain (outermost first) --------------------------------
	serverOrigin, err := csrf.ResolveServerOrigin(publicURL, addr, port)
	if err != nil {
		return err
	}
	var httpHandler http.Handler = mux
	httpHandler = csrf.Middleware(serverOrigin)(httpHandler)

	csp := "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; " +
		"frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; script-src 'self' " + importMapHash
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

// basePathFromPublicURL extracts the URL path component and returns it with a
// trailing slash, e.g. "https://example.com/mynotes" → "/mynotes/". Returns
// "/" when the public URL is empty or has no meaningful path component.
func basePathFromPublicURL(publicURL string) string {
	if publicURL == "" {
		return "/"
	}
	u, err := url.Parse(publicURL)
	if err != nil || u.Path == "" || u.Path == "/" {
		return "/"
	}
	p := u.Path
	if !strings.HasSuffix(p, "/") {
		p += "/"
	}
	return p
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
