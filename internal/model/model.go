// Package model holds the shared domain types. They are independent of both
// the HTTP/OpenAPI layer and the storage layer so the service layer has a
// stable vocabulary to work with.
package model

import "time"

// Note is the single domain entity. Content is verbatim Markdown source. ID is
// the internal SQLite primary key; the API addresses notes by Slug and never
// exposes ID.
type Note struct {
	ID        int64
	Slug      string
	Title     string
	Content   string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// NoteSummary is the list/search projection of a note: the addressable Slug, the
// display Title and UpdatedAt, plus a repository-built Excerpt (a plain prefix
// when browsing, an FTS snippet when searching). Excerpt is "" when empty, never
// absent.
type NoteSummary struct {
	Slug      string
	Title     string
	UpdatedAt time.Time
	Excerpt   string
}
