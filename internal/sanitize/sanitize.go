// Package sanitize provides the write-time HTML gates used by the service
// layer. It exports two, for two different jobs:
//
// HTML is the embedded-HTML *validator*. Note content is stored verbatim
// Markdown and is never mutated;
// the service pulls each embedded raw-HTML fragment out of the parsed Markdown,
// runs HTML over just that fragment, and compares the result against a canonical
// re-serialization of the original to decide whether to accept or reject the
// write. The policy is therefore configured to be strictly *removal-only*: it
// strips disallowed elements, attributes, and URL schemes but never injects or
// rewrites anything (no rel="nofollow", target="_blank", … ), so benign HTML
// re-serializes identically on both sides and only genuinely unsafe content
// trips a divergence.
//
// PublishedHTML is the published-page *sanitizer*. A published note's HTML is
// rendered output, not a source of truth, so unlike note content it is cleaned
// and stored (mutate-on-write) rather than compared and rejected. Its policy is
// the validator's plus what the render pipeline actually emits — see
// newPublishedPolicy.
//
// DOMPurify on the frontend is the authoritative render-time XSS gate; this
// package is defense-in-depth. Parity between the two is a goal, not a security
// dependency.
package sanitize

import (
	"net/url"
	"regexp"

	"github.com/microcosm-cc/bluemonday"
)

// DataImageRaster is the canonical data: image allow-list shared by every gate
// (this policy's img@src rule, the service's Markdown-native image scheme check,
// markdown-it validateLink, and DOMPurify): the four raster subtypes with a
// required trailing ';' (the subtype must be followed by a media-type parameter
// such as ";base64,"). It deliberately excludes data:image/svg+xml — SVG can
// carry script — and any non-raster or parameter-less data: URI. Applied
// case-insensitively (RFC 3986 schemes are case-insensitive).
var DataImageRaster = regexp.MustCompile(`(?i)^data:image/(gif|png|jpeg|webp);`)

// ArtifactRef is the canonical way note content references a stored artifact:
// the app-defined `artifact:` URL scheme followed by the artifact's SHA-256
// (`![alt](artifact:<sha256>)`). It is shared by every gate (this policy's
// img@src rule, the service's Markdown-native image scheme check, and the
// frontend render pipeline, which expands it to the artifact endpoint under the
// deployment's base path). Being a bare scheme plus digest, it carries no
// deployment-specific prefix and no path, query or fragment the expansion could
// be steered with.
//
// Matched strictly, and in lowercase only: the API mints artifact IDs as
// lowercase hex, so any other spelling can never resolve, and write-time
// validation rejects rather than rewrites.
var ArtifactRef = regexp.MustCompile(`^artifact:[0-9a-f]{64}$`)

// imgSrcPattern expresses the intended <img src> allow-list — https, relative
// URLs (no scheme), the canonical data: raster set, and an artifact reference.
// The relative branch matches any value whose first segment contains no ':'
// before a '/', '?', '#', or end of string (i.e. no URL scheme).
//
// NOTE: UGCPolicy registers an unconditional <img src> attribute policy that is
// evaluated before this Matching regexp and short-circuits it, so this regexp
// does not by itself strip e.g. an http image source. Per-element scheme
// enforcement for embedded HTML is therefore done by the service's explicit
// scheme pass (see internal/service/markdown.go); this regexp and the data:
// custom policy below remain as the policy-level expression of the same rules.
var imgSrcPattern = regexp.MustCompile(`(?i)^(https:|data:image/(gif|png|jpeg|webp);|(?-i:artifact:[0-9a-f]{64}$)|[^:/?#]*(?:[/?#]|$))`)

// svgFragmentHref restricts SVG href to same-document fragment references (e.g.
// "#pathId"). Used for <mpath> and <textpath> which must reference elements in
// the same SVG tree and never external resources.
var svgFragmentHref = regexp.MustCompile(`^#[\w:.\-]+$`)

// checkboxType pins an <input type> to exactly "checkbox" so only GFM task-list
// checkboxes are kept; any other input type is stripped. Case-insensitive.
var checkboxType = regexp.MustCompile(`(?i)^checkbox$`)

var policy = newPolicy()

var publishedPolicy = newPublishedPolicy()

// newPolicy builds the removal-only validation policy: bluemonday's broad
// safe-user-content profile (UGCPolicy) with every attribute injector turned
// off, the project URL rules added, and data: raster images permitted.
func newPolicy() *bluemonday.Policy {
	p := bluemonday.UGCPolicy()

	// UGCPolicy's inline-semantic set omits <kbd> (it allows the neighbouring
	// <samp>/<var>), but the project allow-list (§4.1) lists <kbd> alongside them.
	// Add it so a keyboard-key fragment round-trips unchanged instead of being
	// stripped and falsely rejected by the removal-only compare.
	p.AllowElements("kbd")

	// Removal-only: disable every attribute injector UGCPolicy enables by
	// default, so the policy strips disallowed content but never augments allowed
	// content. Any injected rel/target/crossorigin would make even safe HTML
	// differ from its canonical re-serialization and be falsely rejected.
	p.RequireNoFollowOnLinks(false)
	p.RequireNoFollowOnFullyQualifiedLinks(false)
	p.RequireNoReferrerOnLinks(false)
	p.RequireNoReferrerOnFullyQualifiedLinks(false)
	p.AddTargetBlankToFullyQualifiedLinks(false)
	p.RequireCrossOriginAnonymous(false)

	// UGCPolicy's global scheme allow-list is mailto/http/https plus relative
	// URLs, which is exactly the <a href> rule. It omits data:, so add the
	// canonical raster set with a custom policy; this keeps data:image/svg+xml and
	// non-raster data: URIs out on every element (including img).
	p.AllowURLSchemeWithCustomPolicy("data", func(u *url.URL) bool {
		return DataImageRaster.MatchString(u.String())
	})

	// The app-defined artifact scheme, restricted to the canonical
	// `artifact:<sha256>` form. Like data:, the global policy admits it on every
	// element; the per-element rules below (and the service's scheme pass) keep it
	// to images, which is where the render pipeline expands it.
	p.AllowURLSchemeWithCustomPolicy("artifact", func(u *url.URL) bool {
		return ArtifactRef.MatchString(u.String())
	})

	// Restrict <img src> to https/relative/canonical-data: via a Matching regexp
	// (ANDed with the global scheme policy above).
	p.AllowAttrs("src").Matching(imgSrcPattern).OnElements("img")

	// GFM task lists render each "[ ]"/"[x]" list marker as a disabled checkbox.
	// Allow only that exact shape — <input type="checkbox" disabled [checked]> —
	// so the rendered checkbox survives the embedded-HTML validation pass and the
	// removal-only compare stays in parity with the DOMPurify render-time gate. The
	// type value is pinned to "checkbox"; any other input (e.g. type="text") loses
	// its attributes here and so diverges from its re-serialization and is rejected.
	p.AllowAttrs("type").Matching(checkboxType).OnElements("input")
	p.AllowAttrs("checked", "disabled").OnElements("input")

	// SVG: presentation and filter elements, matching DOMPurify's svg+svgFilters
	// profiles (sans <style>, <metadata>, <use>, <animate>, <set>,
	// <foreignObject>, <script> which DOMPurify also disallows or which require
	// CSS sanitization or pose external-load / script-injection risk).
	// Element names are lowercase because golang.org/x/net/html lowercases all
	// tag names during tokenisation, so bluemonday sees them lowercased.
	//
	// AllowNoAttrs().OnElements() is used instead of AllowElements() because
	// bluemonday only emits an allowed element when either (a) it has permitted
	// attributes or (b) it is in setOfElementsAllowedWithoutAttrs. AllowElements
	// alone only does (a); AllowNoAttrs().OnElements() does both, so bare
	// elements like <defs>, <g>, <text> survive the comparison.
	p.AllowNoAttrs().OnElements(svgElements...)
	p.AllowAttrs(svgAttrs...).OnElements(svgElements...)
	// <image href>: same scheme rules as HTML <img src> (https, relative, raster data:).
	// Explicit Matching is required because bluemonday's linkable() URL validation
	// only covers a fixed set of HTML elements and does not extend to SVG elements.
	p.AllowAttrs("href").Matching(imgSrcPattern).OnElements("image")
	// <textpath href> and <mpath href> must only reference same-document elements.
	p.AllowAttrs("href").Matching(svgFragmentHref).OnElements("textpath", "mpath")

	// MathML: matching DOMPurify's mathMl profile for frontend parity. Excluded:
	// <maction> (interactive), <semantics>/<annotation>/<annotation-xml>
	// (arbitrary XML), <none> (not in DOMPurify's mathMl allow-list).
	// href is excluded (not needed for display; would require per-element URL
	// validation since bluemonday's linkable() does not cover MathML elements).
	// See the SVG comment above for why AllowNoAttrs().OnElements() is used.
	p.AllowNoAttrs().OnElements(mathMLElements...)
	p.AllowAttrs(mathMLAttrs...).OnElements(mathMLElements...)

	return p
}

// svgElements is the set of SVG presentation and filter elements accepted by the
// policy, mirroring DOMPurify's svg$1 + svgFilters profiles minus disallowed
// elements. All names are lowercase (golang.org/x/net/html lowercases tag names).
var svgElements = []string{
	// Core structure
	"svg", "g", "defs", "desc", "title", "symbol", "switch",
	// Shapes
	"circle", "ellipse", "line", "path", "polygon", "polyline", "rect",
	// Text
	"text", "tspan", "textpath", "tref",
	// Images (href handled separately below)
	"image",
	// Gradients and patterns
	"lineargradient", "radialgradient", "pattern", "stop",
	// Clipping, masking, markers
	"clippath", "mask", "marker",
	// Views
	"view",
	// Font elements (legacy SVG 1.x, harmless)
	"font", "glyph", "glyphref", "hkern", "vkern",
	"altglyph", "altglyphdef", "altglyphitem",
	// Animation (subset; <animate> and <set> are excluded per DOMPurify)
	"animatecolor", "animatemotion", "animatetransform",
	// <mpath> href handled separately below
	"mpath",
	// Filter primitives
	"filter",
	"feblend", "fecolormatrix", "fecomponenttransfer", "fecomposite",
	"feconvolvematrix", "fediffuselighting", "fedisplacementmap",
	"fedistantlight", "fedropshadow", "feflood",
	"fefunca", "fefuncb", "fefuncg", "fefuncr",
	"fegaussianblur", "feimage", "femerge", "femergenode",
	"femorphology", "feoffset", "fepointlight",
	"fespecularlighting", "fespotlight", "fetile", "feturbulence",
}

// svgAttrs is the set of SVG attributes accepted on svgElements, mirroring
// DOMPurify's svg attrs profile. Excluded: "style" (requires CSS sanitization),
// "href" (handled per-element below with scheme restriction).
// All names are lowercase (golang.org/x/net/html lowercases attribute names).
var svgAttrs = []string{
	"accent-height", "accumulate", "additive", "alignment-baseline",
	"amplitude", "ascent", "attributename", "attributetype",
	"azimuth", "basefrequency", "baseline-shift", "begin", "bias", "by",
	"class", "clip", "clippathunits", "clip-path", "clip-rule",
	"color", "color-interpolation", "color-interpolation-filters",
	"color-profile", "color-rendering",
	"cx", "cy", "d", "dx", "dy",
	"diffuseconstant", "direction", "display", "divisor", "dur",
	"edgemode", "elevation", "end", "exponent",
	"fill", "fill-opacity", "fill-rule", "filter", "filterunits",
	"flood-color", "flood-opacity",
	"font-family", "font-size", "font-size-adjust", "font-stretch",
	"font-style", "font-variant", "font-weight",
	"fx", "fy",
	"g1", "g2", "glyph-name", "glyphref",
	"gradientunits", "gradienttransform",
	"height", "id", "image-rendering",
	"in", "in2", "intercept",
	"k", "k1", "k2", "k3", "k4", "kerning",
	"keypoints", "keysplines", "keytimes",
	"lang", "lengthadjust", "letter-spacing",
	"kernelmatrix", "kernelunitlength", "lighting-color", "local",
	"marker-end", "marker-mid", "marker-start",
	"markerheight", "markerunits", "markerwidth",
	"maskcontentunits", "maskunits", "max", "mask", "mask-type",
	"media", "method", "mode", "min", "name",
	"numoctaves", "offset", "operator", "opacity", "order",
	"orient", "orientation", "origin", "overflow",
	"paint-order", "path", "pathlength",
	"patterncontentunits", "patterntransform", "patternunits",
	"points", "preservealpha", "preserveaspectratio", "primitiveunits",
	"r", "rx", "ry", "radius", "refx", "refy",
	"repeatcount", "repeatdur", "restart", "result", "rotate",
	"scale", "seed", "shape-rendering", "slope",
	"specularconstant", "specularexponent", "spreadmethod",
	"startoffset", "stddeviation", "stitchtiles",
	"stop-color", "stop-opacity",
	"stroke-dasharray", "stroke-dashoffset", "stroke-linecap",
	"stroke-linejoin", "stroke-miterlimit", "stroke-opacity",
	"stroke", "stroke-width",
	"surfacescale", "systemlanguage", "tabindex", "tablevalues",
	"targetx", "targety",
	"transform", "transform-origin",
	"text-anchor", "text-decoration", "text-rendering", "textlength",
	"type", "u1", "u2", "unicode", "values",
	"viewbox", "visibility", "version",
	"vert-adv-y", "vert-origin-x", "vert-origin-y",
	"width", "word-spacing", "wrap", "writing-mode",
	"xchannelselector", "ychannelselector",
	"x", "x1", "x2", "xmlns", "y", "y1", "y2", "z", "zoomandpan",
}

// mathMLElements mirrors DOMPurify's mathMl profile (mathMl$1 allow-list).
// Excluded: <maction> (interactive), <semantics>/<annotation>/<annotation-xml>
// (arbitrary XML per DOMPurify mathMlDisallowed), <none> (not in allow-list).
var mathMLElements = []string{
	"math", "menclose", "merror", "mfenced", "mfrac", "mglyph",
	"mi", "mlabeledtr", "mmultiscripts", "mn", "mo", "mover",
	"mpadded", "mphantom", "mroot", "mrow", "ms", "mspace",
	"msqrt", "mstyle", "msub", "msup", "msubsup", "mtable",
	"mtd", "mtext", "mtr", "munder", "munderover", "mprescripts",
}

// mathMLAttrs mirrors DOMPurify's mathMl attribute profile.
// Excluded: "href" (not needed for display; would require per-element URL
// validation since bluemonday's linkable() does not cover MathML elements).
// "id", "dir", "lang" are already globally allowed by UGCPolicy's
// AllowStandardAttributes but listing them here is harmless.
var mathMLAttrs = []string{
	"accent", "accentunder", "align", "bevelled", "close",
	"columnalign", "columnlines", "columnspacing", "columnspan",
	"denomalign", "depth", "dir", "display", "displaystyle", "encoding",
	"fence", "frame", "height", "id", "largeop", "length",
	"linethickness", "lquote", "lspace", "mathbackground", "mathcolor",
	"mathsize", "mathvariant", "maxsize", "minsize", "movablelimits",
	"notation", "numalign", "open", "rowalign", "rowlines", "rowspacing",
	"rowspan", "rspace", "rquote", "scriptlevel", "scriptminsize",
	"scriptsizemultiplier", "selection", "separator", "separators",
	"stretchy", "subscriptshift", "supscriptshift", "symmetric",
	"voffset", "width", "xmlns",
}

// newPublishedPolicy builds the policy for a published note's HTML: the
// validation policy above, widened by exactly what the frontend render pipeline
// emits but embedded Markdown HTML never contains.
//
// Unlike that policy this one is a *sanitizer* — its output is what gets stored
// and served — so it need not be removal-only, and a stripped attribute
// degrades the page rather than rejecting the publish.
//
//   - class: the rendered fragment is built on it (callouts, `language-*` code
//     fences, `.mermaid-diagram`). UGCPolicy withholds it to stop users styling
//     their own content; here the classes come from our own renderer and the
//     stylesheet that interprets them is ours too.
//   - style, both the attribute and the element: Mermaid emits an <svg> that
//     carries its diagram CSS in a <style> child and inline style attributes,
//     and web/ts/util/mermaid.ts's DOMPurify instance passes both through. Drop
//     them and every published diagram renders unstyled.
//
// bluemonday will not emit a <style> element's content unless AllowUnsafe is
// set, and it does not sanitize CSS text, so published CSS is stored verbatim.
// The compensating control is the response policy on the public route
// (handler.publishedNoteCSP): no script-src, so a published page cannot execute
// script no matter what reaches it. AllowUnsafe also ungates <script>, but only
// for a policy that *declares* it — this one does not, so a <script> element is
// still dropped along with its content, and so is any element whose content
// bluemonday skips by default.
func newPublishedPolicy() *bluemonday.Policy {
	p := newPolicy()

	p.AllowUnsafe(true)

	// Inert, and load-bearing for the published stylesheet.
	p.AllowAttrs("class").Globally()

	// Inert accessibility metadata, kept for parity with DOMPurify (which allows
	// role and every aria-*): the renderer marks decorative Lucide icons
	// aria-hidden and Mermaid labels its diagrams with role/aria-roledescription,
	// and a published page should read to a screen reader as the app's does.
	p.AllowAttrs("role", "aria-hidden", "aria-label", "aria-labelledby",
		"aria-describedby", "aria-roledescription").Globally()

	p.AllowNoAttrs().OnElements("style")
	p.AllowElementsContent("style")
	// Declaring no AllowStyles leaves bluemonday's CSS-property allowlisting
	// switched off, which is deliberate: an allowlist that Mermaid's output does
	// not fit would silently mangle diagrams, and the route's CSP is what makes
	// unlisted CSS harmless.
	p.AllowAttrs("style").Globally()

	return p
}

// HTML returns the policy-cleaned form of an HTML fragment. It is used only to
// decide whether a fragment is accepted: the service compares this output
// against a canonical re-serialization of the original fragment and rejects the
// write on any divergence. The result is never stored.
func HTML(s string) string {
	return policy.Sanitize(s)
}

// PublishedHTML returns the cleaned form of a published note's rendered HTML
// fragment. Unlike HTML this result *is* what gets stored and served, so the
// call is the write-time guard on the publish endpoint rather than a comparison
// input. See newPublishedPolicy for what it keeps and why.
func PublishedHTML(s string) string {
	return publishedPolicy.Sanitize(s)
}
