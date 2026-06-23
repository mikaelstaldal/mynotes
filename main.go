package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/mikaelstaldal/go-server-common/auth"
	"github.com/mikaelstaldal/go-server-common/csrf"
	"github.com/mikaelstaldal/go-server-common/httputil"
	commonweb "github.com/mikaelstaldal/go-server-common/web"
	"github.com/mikaelstaldal/mynotes/internal/api"
	"github.com/mikaelstaldal/mynotes/internal/handler"
	"github.com/mikaelstaldal/mynotes/internal/repository"
	"github.com/mikaelstaldal/mynotes/internal/service"
	"github.com/mikaelstaldal/mynotes/web"
)

const databaseName = "app.sqlite"

// maxRequestBody caps every request body. Raise it for endpoints that accept
// uploads, but keep a global ceiling to blunt memory-exhaustion attacks.
const maxRequestBody = 10 << 20 // 10 MiB

func main() {
	port := flag.Int("port", 8080, "HTTP listen port")
	addr := flag.String("addr", "127.0.0.1", "bind address")
	dataDir := flag.String("data", "data", "data directory")
	publicURL := flag.String("public-url", "", "public-facing base URL for CSRF validation, e.g. https://example.com (defaults to http://<addr>:<port>)")
	basicAuthFile := flag.String("basic-auth-file", "", "enable HTTP basic auth using this htpasswd file (bcrypt only)")
	basicAuthRealm := flag.String("basic-auth-realm", "MyNotes", "realm for HTTP basic auth")
	flag.Parse()

	if *port < 1 || *port > 65535 {
		log.Fatalf("invalid port: %d", *port)
	}

	if err := run(*addr, *port, *dataDir, *publicURL, *basicAuthFile, *basicAuthRealm); err != nil {
		log.Fatalf("%v", err)
	}
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
	noteSvc := service.NewNoteService(noteRepo)
	h := handler.New(noteSvc)

	ogenServer, err := api.NewServer(h, api.WithPathPrefix("/api/v1"))
	if err != nil {
		return fmt.Errorf("create API server: %w", err)
	}

	// --- HTTP routing ------------------------------------------------------
	indexHTML, err := fs.ReadFile(web.Static, "static/index.html")
	if err != nil {
		return fmt.Errorf("read index.html: %w", err)
	}
	importMapHash, err := commonweb.ImportMapCSPHash(web.Static)
	if err != nil {
		return fmt.Errorf("compute importmap CSP hash: %w", err)
	}

	mux := http.NewServeMux()
	mux.Handle("/api/v1/", handler.WithMiddleware(ogenServer))
	mux.HandleFunc("/", staticHandler(indexHTML))

	// --- middleware chain (outermost first) --------------------------------
	serverOrigin, err := csrf.ResolveServerOrigin(publicURL, addr, port)
	if err != nil {
		return err
	}
	var httpHandler http.Handler = mux
	httpHandler = csrf.Middleware(serverOrigin)(httpHandler)

	csp := "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
		"frame-ancestors 'none'; script-src 'self' " + importMapHash
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
