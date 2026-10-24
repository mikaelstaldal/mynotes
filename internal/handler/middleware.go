package handler

import (
	"net/http"

	"github.com/mikaelstaldal/go-server-common/httputil"
	"github.com/mikaelstaldal/go-server-common/recovery"
)

// WithMiddleware wraps the API handler with the cross-cutting concerns every
// JSON endpoint needs: panic recovery, gzip compression, and a no-store cache
// policy (API responses must never be cached by intermediaries).
func WithMiddleware(h http.Handler) http.Handler {
	return recovery.Middleware(httputil.Gzip(noStore(h)))
}

func noStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

// PublicMiddleware shares a fail-fast limit across all public routes, bounding
// resources retained by slow readers. Construct it once per server.
func PublicMiddleware() func(http.Handler) http.Handler {
	slots := make(chan struct{}, 16)
	return func(next http.Handler) http.Handler {
		return recovery.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			select {
			case slots <- struct{}{}:
				defer func() { <-slots }()
				next.ServeHTTP(w, r)
			default:
				w.Header().Set("Cache-Control", "no-store")
				w.Header().Set("Retry-After", "1")
				http.Error(w, "public server busy", http.StatusServiceUnavailable)
			}
		}))
	}
}
