// Package icons serves the vendored Lucide icon set as SVG images. Each icon is
// referenced from note content as a Markdown image
// (![name](<base>/api/v1/icons/lucide/name)), so the editor's icon picker inserts
// a short link instead of a full inline SVG.
//
// The icon geometry is embedded only once, in the frontend bundle
// web/static/vendor/lucide-<version>.js (LUCIDE_ICON_NODES, name → [ [tag, attrs], … ]),
// which the picker and the reusable <Icon> component import directly. This
// package reads that same embedded copy (via web.Static) and reconstructs each
// icon's standalone <svg> document at init — so the server never embeds a second
// copy of the ~1700-icon set, and the served icons can never drift from the
// picker previews. Both are generated from lucide-static by
// web/ts/vendor/gen-lucide.mjs; regenerate via web/ts/vendor/rebuild.sh.
package icons

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"strings"

	"github.com/mikaelstaldal/mynotes/web"
)

// xmlnsAttr is the default SVG namespace declaration the built icons carry. It
// is required for the standalone document served over HTTP (loaded via <img>),
// but redundant — and discouraged — when the <svg> is embedded inline in HTML,
// where it already sits in the SVG namespace. GetInline strips exactly this.
const xmlnsAttr = ` xmlns="http://www.w3.org/2000/svg"`

// stroke is the mid-grey baked into the server-served SVGs; it must match STROKE
// in web/ts/vendor/gen-lucide.mjs. An <img>-loaded SVG is an isolated document,
// so it cannot follow the app's theme via currentColor the way the inline picker
// previews (rendered from the same geometry) do.
const stroke = "#6b7280"

// nodesMarker is the exact prefix gen-lucide.mjs writes the icon geometry under,
// on its own line: `export const LUCIDE_ICON_NODES = {…};`.
const nodesMarker = "export const LUCIDE_ICON_NODES = "

// svgs maps a canonical kebab-case icon name to its standalone SVG document,
// reconstructed at init from the single embedded copy of the geometry.
var svgs = mustBuild()

func mustBuild() map[string]string {
	// The bundle filename carries the lucide-static version (lucide-<ver>.js),
	// so match it by glob rather than pinning a version the maintainer would have
	// to update here on every bump (see web/ts/vendor/rebuild.sh).
	matches, err := fs.Glob(web.Static, "static/vendor/lucide-*.js")
	if err != nil {
		panic("icons: glob lucide bundle: " + err.Error())
	}
	if len(matches) != 1 {
		panic(fmt.Sprintf("icons: expected exactly one static/vendor/lucide-*.js, found %d", len(matches)))
	}
	raw, err := web.Static.ReadFile(matches[0])
	if err != nil {
		panic("icons: read " + matches[0] + ": " + err.Error())
	}
	nodes, err := parseNodes(raw)
	if err != nil {
		panic("icons: " + err.Error())
	}
	m := make(map[string]string, len(nodes))
	for name, children := range nodes {
		m[name] = svgString(name, children)
	}
	return m
}

// parseNodes extracts and decodes the LUCIDE_ICON_NODES object from the vendored
// lucide.js module. The generator writes it as a single line of compact JSON, so
// a prefix match on that line yields the object verbatim.
func parseNodes(js []byte) (map[string][]iconChild, error) {
	for line := range strings.SplitSeq(string(js), "\n") {
		if !strings.HasPrefix(line, nodesMarker) {
			continue
		}
		obj := strings.TrimSuffix(strings.TrimPrefix(line, nodesMarker), ";")
		var m map[string][]iconChild
		if err := json.Unmarshal([]byte(obj), &m); err != nil {
			return nil, fmt.Errorf("parse LUCIDE_ICON_NODES: %w", err)
		}
		return m, nil
	}
	return nil, fmt.Errorf("LUCIDE_ICON_NODES not found in lucide.js")
}

// iconChild is one child element of an icon — a tag plus its attributes in source
// order. Mirrors Lucide's [tag, attrs] IconNode child shape.
type iconChild struct {
	tag   string
	attrs []attr
}

type attr struct{ key, val string }

// UnmarshalJSON decodes a ["tag", {attrs}] pair, preserving the attribute order
// as written so the reconstructed SVG is deterministic.
func (c *iconChild) UnmarshalJSON(b []byte) error {
	var raw []json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	if len(raw) != 2 {
		return fmt.Errorf("icon child: expected [tag, attrs], got %d elements", len(raw))
	}
	if err := json.Unmarshal(raw[0], &c.tag); err != nil {
		return err
	}
	c.attrs = nil
	dec := json.NewDecoder(bytes.NewReader(raw[1]))
	if tok, err := dec.Token(); err != nil {
		return err
	} else if tok != json.Delim('{') {
		return fmt.Errorf("icon child attrs: expected object, got %v", tok)
	}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return err
		}
		var val string
		if err := dec.Decode(&val); err != nil {
			return err
		}
		c.attrs = append(c.attrs, attr{key: keyTok.(string), val: val})
	}
	return nil
}

// escapeAttr escapes an attribute value for the SVG document; mirrors escapeAttr
// in web/ts/vendor/gen-lucide.mjs (& first, then < > ").
func escapeAttr(v string) string {
	v = strings.ReplaceAll(v, "&", "&amp;")
	v = strings.ReplaceAll(v, "<", "&lt;")
	v = strings.ReplaceAll(v, ">", "&gt;")
	v = strings.ReplaceAll(v, `"`, "&quot;")
	return v
}

// svgString serializes one icon's children into a standalone <svg> document. Its
// output must stay in step with the inline form the frontend renders from the
// same geometry (web/ts/util/markdown.ts, web/ts/components/Icon.tsx).
func svgString(name string, children []iconChild) string {
	var b strings.Builder
	b.WriteString(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" `)
	b.WriteString(`viewBox="0 0 24 24" fill="none" stroke="`)
	b.WriteString(stroke)
	b.WriteString(`" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" `)
	b.WriteString(`class="lucide lucide-`)
	b.WriteString(name)
	b.WriteString(`">`)
	for _, ch := range children {
		b.WriteByte('<')
		b.WriteString(ch.tag)
		for _, a := range ch.attrs {
			b.WriteByte(' ')
			b.WriteString(a.key)
			b.WriteString(`="`)
			b.WriteString(escapeAttr(a.val))
			b.WriteByte('"')
		}
		b.WriteString("/>")
	}
	b.WriteString("</svg>")
	return b.String()
}

// Count reports how many icons are available (used in tests).
func Count() int { return len(svgs) }

// Get returns the standalone SVG document for the named icon (with its xmlns
// declaration, as served over HTTP), or ok=false when the name is unknown.
func Get(name string) (svg string, ok bool) {
	svg, ok = svgs[name]
	return svg, ok
}

// GetInline is like Get but with the redundant xmlns declaration removed,
// and the gray stroke replaced with "currentColor", for embedding the <svg> inline in HTML.
// Used by the HTML export to inline icon references, so a downloaded document renders without a live server.
func GetInline(name string) (svg string, ok bool) {
	svg, ok = svgs[name]
	if !ok {
		return "", false
	}
	return strings.Replace(strings.Replace(svg, xmlnsAttr, "", 1), stroke, "currentColor", 1), true
}

// Handler serves a Lucide icon as image/svg+xml at GET /api/v1/icons/lucide/{name}. Unknown
// names return 404. The SVG is a static, public, immutable asset, so it is
// cached aggressively; it is served under a locked-down sandbox CSP (mirroring
// artifact SVGs) so that navigating to it directly can never execute script —
// which does not affect <img> rendering, where response headers are ignored.
func Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		svg, ok := svgs[r.PathValue("name")]
		if !ok {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"not found"}`))
			return
		}
		w.Header().Set("Content-Type", "image/svg+xml")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
		_, _ = w.Write([]byte(svg))
	})
}
