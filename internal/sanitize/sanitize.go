// Package sanitize provides HTML sanitization for user-supplied rich-text
// content. Apply HTML on every write path (create and update alike) — an
// import or API client is never a trusted source.
package sanitize

import "github.com/microcosm-cc/bluemonday"

var policy = newPolicy()

func newPolicy() *bluemonday.Policy {
	p := bluemonday.NewPolicy()

	p.AllowElements(
		"b", "i", "u", "em", "strong",
		"p", "br", "hr",
		"ul", "ol", "li",
		"h1", "h2", "h3", "h4", "h5", "h6",
		"blockquote", "code", "pre",
		"sub", "sup",
		"div", "span",
		"table", "thead", "tbody", "tr", "th", "td",
	)

	p.AllowAttrs("href", "title").OnElements("a")
	p.AllowStandardURLs()
	p.AllowURLSchemes("http", "https", "mailto")
	p.RequireParseableURLs(true)

	p.AddTargetBlankToFullyQualifiedLinks(true)
	p.RequireNoReferrerOnLinks(true)

	return p
}

// HTML sanitizes an HTML string, keeping only allowed tags and attributes.
// Dangerous tags (<script>, <iframe>, <style>, …), event-handler attributes,
// and disallowed URL schemes (e.g. javascript:) are removed.
func HTML(s string) string {
	return policy.Sanitize(s)
}
