package handler

import (
	"errors"
	"log"
	"net/http"

	"github.com/mikaelstaldal/mynotes/internal/service"
)

// The unauthenticated surface. Everything under PublicPrefix is served without
// authentication (main.go excludes the prefix from the basic-auth middleware),
// so each route here is a deliberate decision about what leaves the private
// deployment:
//
//   - a published note's HTML, and nothing about notes that are not published;
//   - an artifact, and only while some published note references it;
//   - the stylesheet those pages need.
//
// Nothing here lists anything: there is no public index, so a page is reachable
// only by knowing its slug.
const (
	PublicPrefix = "/public/"

	// PublicNotePattern and friends are the ServeMux patterns main.go registers.
	// They live here so the paths the handlers assume — specifically the one
	// directory of depth that makes the pages' relative "../artifacts/…" and
	// "../note.css" references resolve — are stated next to the code that
	// depends on it.
	PublicNotePattern     = "GET /public/notes/{slug}"
	PublicArtifactPattern = "GET /public/artifacts/{sha256}"
	PublicCSSPattern      = "GET /public/note.css"

	// PublicCatchAllPattern claims the rest of the prefix. Without it an
	// unmatched path under it would fall through to the SPA shell — which the
	// auth exemption would then hand out unauthenticated. The three patterns
	// above are more specific, so they still win.
	PublicCatchAllPattern = "/public/"
)

// PublicNotePath returns where a published note is served, relative to the
// deployment root. Clients make it absolute against their own base URL.
func PublicNotePath(slug string) string { return PublicPrefix + "notes/" + slug }

// publishedNoteCSP is the response policy for a published page. It is much
// tighter than the app's own: a published page is static HTML, so it needs no
// script at all, and having no script-src (falling back to default-src 'none')
// is what makes it safe to store author CSS verbatim — see
// sanitize.newPublishedPolicy, which allows <style> and style attributes
// because Mermaid diagrams cannot be styled without them.
//
// img-src matches what the render pipeline can produce: artifacts and the
// stylesheet from this origin, inlined raster data: URLs, and https images the
// note links to. style-src needs 'unsafe-inline' for exactly that author CSS.
const publishedNoteCSP = "default-src 'none'; img-src 'self' data: https:; " +
	"style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

// ServePublishedNote is a raw http.HandlerFunc for GET /public/notes/{slug}.
// It is not an ogen operation: the response is an HTML document rather than the
// spec's JSON, and the route is deliberately outside /api/v1 so the auth
// exclusion covers a prefix that contains nothing else.
//
// A note that does not exist and a note that is not published are the same 404:
// an unauthenticated reader must not be able to probe which slugs exist.
func (h *Handler) ServePublishedNote(w http.ResponseWriter, r *http.Request) {
	p, err := h.publish.Get(r.Context(), r.PathValue("slug"))
	if errors.Is(err, service.ErrNotFound) {
		writePublicNotFound(w, "text/html; charset=utf-8", notFoundDocument)
		return
	}
	if err != nil {
		log.Printf("serve published note: %v", err)
		writePublicError(w, "text/html; charset=utf-8", errorDocument)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", publishedNoteCSP)
	// The snapshot is replaced in place on re-publish, so the URL is not
	// content-addressed and must be revalidated rather than cached.
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Last-Modified", p.PublishedAt.UTC().Format(http.TimeFormat))
	_, _ = w.Write([]byte(service.PublishedNoteDocument(p)))
}

// ServePublicArtifact is a raw http.HandlerFunc for
// GET /public/artifacts/{sha256}. It mirrors ServeArtifact but gates on
// publication first: an artifact is readable here only while some published
// note references it, which is what keeps publishing one note from exposing the
// whole artifact store. Being content-addressed, it may be cached publicly and
// forever — withdrawing it means the URL 404s, not that its bytes change.
func (h *Handler) ServePublicArtifact(w http.ResponseWriter, r *http.Request) {
	sha256hex := r.PathValue("sha256")
	published, err := h.publish.ArtifactPublished(r.Context(), sha256hex)
	if err != nil {
		log.Printf("check published artifact: %v", err)
		writePublicError(w, "application/json", `{"error":"internal server error"}`)
		return
	}
	if !published {
		writePublicNotFound(w, "application/json", `{"error":"not found"}`)
		return
	}
	a, err := h.artifacts.Get(r.Context(), sha256hex)
	if errors.Is(err, service.ErrNotFound) {
		writePublicNotFound(w, "application/json", `{"error":"not found"}`)
		return
	}
	if err != nil {
		log.Printf("serve public artifact: %v", err)
		writePublicError(w, "application/json", `{"error":"internal server error"}`)
		return
	}
	w.Header().Set("Content-Type", a.ContentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("Last-Modified", a.CreatedAt.UTC().Format(http.TimeFormat))
	// Same reasoning as ServeArtifact: SVG and MathML navigated to directly are
	// active content, and a sandboxed policy neutralises that without affecting
	// their rendering as <img> subresources.
	if a.ContentType == "image/svg+xml" || a.ContentType == "application/mathml+xml" {
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
	}
	_, _ = w.Write(a.Content)
}

// PublicNotFoundHandler answers every path under the public prefix that is not
// one of the routes above. It has no receiver so it can be registered even in
// demo mode, where there is no backend to publish to.
func PublicNotFoundHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writePublicNotFound(w, "text/html; charset=utf-8", notFoundDocument)
	})
}

func writePublicNotFound(w http.ResponseWriter, contentType, body string) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", publishedNoteCSP)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNotFound)
	_, _ = w.Write([]byte(body))
}

func writePublicError(w http.ResponseWriter, contentType, body string) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", publishedNoteCSP)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusInternalServerError)
	_, _ = w.Write([]byte(body))
}

// The public routes answer browser navigations, so their failures are pages
// rather than JSON. They are deliberately bare: a reader who followed a
// withdrawn link is not a user of this deployment and is told nothing about it.
//
// They carry their own styling inline rather than linking /public/note.css.
// These documents are served from every depth under the public prefix — the
// catch-all answers /public/x as well as /public/notes/x — so no one relative
// href is right for all of them, and an absolute one would be wrong under a
// subpath deployment. The inline <style> is covered by the route's
// style-src 'unsafe-inline'.
const publicPageStyle = `<style>body{margin:0;padding:2rem 1.25rem;` +
	`font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;` +
	`color:#1f2937;background:#fff}main{max-width:65ch;margin:0 auto}` +
	`h1{font-size:1.75rem;margin:0 0 0.5em}p{margin:0.75em 0;color:#6b7280}</style>`

const notFoundDocument = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found</title>` + publicPageStyle + `</head>
<body><main><h1>Not found</h1><p>This page is not available.</p></main></body>
</html>
`

const errorDocument = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Error</title>` + publicPageStyle + `</head>
<body><main><h1>Error</h1><p>This page could not be served.</p></main></body>
</html>
`
