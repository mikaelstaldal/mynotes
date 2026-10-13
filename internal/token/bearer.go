package token

import (
	"github.com/mikaelstaldal/mynotes/internal/handler"
	"net/http"
	"strings"
)

// Bearer grants whole-API reads only. Management and consent always require
// full access, even when Basic authentication is not configured.
func (s Store) Bearer(full, read http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Publishing is world-readable regardless of attached credentials.
		if strings.HasPrefix(r.URL.Path, handler.PublicPrefix) {
			full.ServeHTTP(w, r)
			return
		}
		scheme, secret, _ := strings.Cut(r.Header.Get("Authorization"), " ")
		if !strings.EqualFold(scheme, "Bearer") {
			full.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		valid, err := s.Validate(strings.TrimSpace(secret))
		if err != nil {
			writeError(w, 500, "database error")
			return
		}
		if !valid {
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeError(w, 401, "unauthorized")
			return
		}
		permitted := false
		for _, family := range []string{"notes", "tags", "artifacts", "icons"} {
			prefix := "/api/v1/" + family
			if r.URL.Path == prefix || strings.HasPrefix(r.URL.Path, prefix+"/") {
				permitted = true
			}
		}
		if r.URL.RawPath != "" || (r.Method != http.MethodGet && r.Method != http.MethodHead) || !permitted {
			writeError(w, 403, "token cannot access this resource")
			return
		}
		read.ServeHTTP(w, r)
	})
}

// ReadHead lets generated GET handlers serve corresponding HEAD requests.
// The underlying handler must keep GET side-effect free.
func ReadHead(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodHead {
			next.ServeHTTP(w, r)
			return
		}
		get := r.Clone(r.Context())
		get.Method = http.MethodGet
		next.ServeHTTP(headWriter{w}, get)
	})
}

type headWriter struct{ http.ResponseWriter }

func (w headWriter) Write(p []byte) (int, error) { return len(p), nil }
