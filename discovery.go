package main

import (
	"bytes"
	_ "embed"
	"net/http"
	"strings"
	"time"
)

//go:embed openapi.yaml
var openAPIDocument []byte

const apiCatalog = `{"linkset":[{"anchor":"/api/v1/","service-desc":[{"href":"/openapi.yaml","type":"application/yaml"}]}]}`

func mountAPIDiscovery(mux *http.ServeMux, demoMode bool) {
	for _, path := range []string{"/openapi.yaml", "/.well-known/api-catalog"} {
		if demoMode {
			mux.HandleFunc(path, http.NotFound)
			continue
		}
		mux.HandleFunc("GET "+path, func(w http.ResponseWriter, r *http.Request) {
			content := openAPIDocument
			if r.URL.Path == "/openapi.yaml" {
				w.Header().Set("Content-Type", "application/yaml")
			} else {
				w.Header().Set("Content-Type", `application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"`)
				w.Header().Set("Link", `</.well-known/api-catalog>; rel="api-catalog"`)
				content = []byte(apiCatalog)
			}
			http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(content))
		})
	}
}

// Discovery bypasses both credential gates, but keeps Host, CSRF and body limits.
func publicAPIDiscovery(full, public http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if (r.Method == http.MethodGet || r.Method == http.MethodHead) &&
			(r.URL.Path == "/openapi.yaml" || r.URL.Path == "/.well-known/api-catalog") {
			public.ServeHTTP(w, r)
			return
		}
		full.ServeHTTP(w, r)
	})
}

// Wrap the complete boundary so even authentication and Host errors advertise it.
func apiDescriptionLink(next http.Handler, demoMode bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !demoMode && strings.HasPrefix(r.URL.Path, "/api/v1/") {
			w.Header().Add("Link", `</openapi.yaml>; rel="service-desc"`)
		}
		next.ServeHTTP(w, r)
	})
}
