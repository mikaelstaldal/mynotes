// Package sanitize provides the write-time embedded-HTML validator used by the
// service layer. Note content is stored verbatim Markdown and is never mutated;
// the service pulls each embedded raw-HTML fragment out of the parsed Markdown,
// runs HTML over just that fragment, and compares the result against a canonical
// re-serialization of the original to decide whether to accept or reject the
// write. The policy is therefore configured to be strictly *removal-only*: it
// strips disallowed elements, attributes, and URL schemes but never injects or
// rewrites anything (no rel="nofollow", target="_blank", … ), so benign HTML
// re-serializes identically on both sides and only genuinely unsafe content
// trips a divergence.
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

// imgSrcPattern expresses the intended <img src> allow-list — https, relative
// URLs (no scheme), and the canonical data: raster set. The relative branch
// matches any value whose first segment contains no ':' before a '/', '?', '#',
// or end of string (i.e. no URL scheme).
//
// NOTE: UGCPolicy registers an unconditional <img src> attribute policy that is
// evaluated before this Matching regexp and short-circuits it, so this regexp
// does not by itself strip e.g. an http image source. Per-element scheme
// enforcement for embedded HTML is therefore done by the service's explicit
// scheme pass (see internal/service/markdown.go); this regexp and the data:
// custom policy below remain as the policy-level expression of the same rules.
var imgSrcPattern = regexp.MustCompile(`(?i)^(https:|data:image/(gif|png|jpeg|webp);|[^:/?#]*(?:[/?#]|$))`)

var policy = newPolicy()

// newPolicy builds the removal-only validation policy: bluemonday's broad
// safe-user-content profile (UGCPolicy) with every attribute injector turned
// off, the project URL rules added, and data: raster images permitted.
func newPolicy() *bluemonday.Policy {
	p := bluemonday.UGCPolicy()

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

	// Restrict <img src> to https/relative/canonical-data: via a Matching regexp
	// (ANDed with the global scheme policy above).
	p.AllowAttrs("src").Matching(imgSrcPattern).OnElements("img")

	return p
}

// HTML returns the policy-cleaned form of an HTML fragment. It is used only to
// decide whether a fragment is accepted: the service compares this output
// against a canonical re-serialization of the original fragment and rejects the
// write on any divergence. The result is never stored.
func HTML(s string) string {
	return policy.Sanitize(s)
}
